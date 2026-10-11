import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { HostCodeOutputTransportFactory } from "./host-code-broker";

export const HOST_OUTPUT_PROTOCOL_VERSION = 1;
export const HOST_OUTPUT_IMPLEMENTATION_ID = "winter-host-output/v1";
export const HOST_OUTPUT_BUNDLE_SUBPATH = "native/host-output";
const ARTIFACT = "winter-host-output.node";
const TEAM = "37N77U9RSZ";
const SHA = /^[a-f0-9]{64}$/;
const pinnedMappings: number[] = []; // /dev/fd load names must not be reused.
let bundled: HostCodeOutputTransportFactory | undefined;

export class HostOutputUnavailable extends Error {
  constructor(readonly reason: string) { super(`Host output unavailable: ${reason}`);this.name="HostOutputUnavailable"; }
}
interface Manifest {
  schema: 1;protocolVersion: 1;implementationId: typeof HOST_OUTPUT_IMPLEMENTATION_ID;
  sourceSha256: string;artifactSha256: string;artifact: typeof ARTIFACT;
  platform: "darwin";architecture: "arm64";minimumMacOS: "26.0";
}
interface Addon { protocolVersion: number;implementationId: string;sourceSha256: string;createOutputTransport: HostCodeOutputTransportFactory }
function manifest(bytes: Buffer): Manifest {
  if(bytes.length>4096)throw new HostOutputUnavailable("manifest-size");
  const value=JSON.parse(bytes.toString()) as Partial<Manifest> | null;
  if(!value || value.schema!==1 || value.protocolVersion!==1 || value.implementationId!==HOST_OUTPUT_IMPLEMENTATION_ID ||
      value.artifact!==ARTIFACT || value.platform!=="darwin" || value.architecture!=="arm64" || value.minimumMacOS!=="26.0" ||
      typeof value.sourceSha256!=="string" || !SHA.test(value.sourceSha256) || typeof value.artifactSha256!=="string" || !SHA.test(value.artifactSha256))
    throw new HostOutputUnavailable("manifest-identity");
  return value as Manifest;
}
function ordinary(path: string, directory: boolean): Stats {
  const stat=lstatSync(path);
  if(stat.isSymbolicLink() || (directory ? !stat.isDirectory():!stat.isFile()) || (stat.mode&0o022)!==0 ||
      (!directory && stat.nlink!==1) || ![0,process.getuid?.()].includes(stat.uid))throw new HostOutputUnavailable("artifact-protection");
  return stat;
}
function unchanged(before: Stats,after: Stats): boolean {
  return before.dev===after.dev && before.ino===after.ino && before.mode===after.mode &&
    before.uid===after.uid && before.gid===after.gid && before.nlink===after.nlink &&
    before.size===after.size && before.mtimeMs===after.mtimeMs && before.ctimeMs===after.ctimeMs;
}
function descriptorBytes(fd: number,limit: number): {stat: Stats;bytes: Buffer} {
  const stat=fstatSync(fd);
  if(!stat.isFile() || stat.nlink!==1 || stat.size<1 || stat.size>limit || (stat.mode&0o022)!==0 ||
      ![0,process.getuid?.()].includes(stat.uid))throw new HostOutputUnavailable("artifact-protection");
  const bytes=Buffer.alloc(stat.size);let read=0;
  while(read<bytes.length){const count=readSync(fd,bytes,read,bytes.length-read,read);if(count===0)throw new HostOutputUnavailable("artifact-truncated");read+=count;}
  if(!unchanged(stat,fstatSync(fd)))throw new HostOutputUnavailable("artifact-changed");
  return {stat,bytes};
}
function nativeAddon(fd: number): Addon {
  const module={exports:{}} as NodeJS.Module;
  process.dlopen(module,`/dev/fd/${fd}`);
  return module.exports as Addon;
}
type SignatureVerifier=(app: string,core: string,addon: string)=>boolean;
const signatures: SignatureVerifier=(app,core,addon)=>{
  const team=`anchor apple generic and certificate leaf[subject.OU] = "${TEAM}"`;
  const verify=(path: string,requirement: string)=>spawnSync("/usr/bin/codesign",["--verify","--strict","-R",requirement,path],{stdio:"ignore",timeout:5000}).status===0;
  const flags=spawnSync("/usr/bin/codesign",["-dv",core],{encoding:"utf8",timeout:5000});
  const entitlements=spawnSync("/usr/bin/codesign",["-d","--entitlements",":-",core],{encoding:"utf8",timeout:5000});
  const entitlementText=entitlements.stdout??"";
  if(flags.status!==0 || !/flags=0x[0-9a-f]+\([^\n]*runtime/.test(flags.stderr??"") || entitlements.status!==0 ||
      /<key>com\.apple\.security\.cs\.disable-library-validation<\/key>\s*<true\s*\/>/.test(entitlementText) ||
      /<key>com\.apple\.security\.get-task-allow<\/key>\s*<true\s*\/>/.test(entitlementText))return false;
  // The enclosing app seal authenticates the manifest. Core/library validation
  // keeps unsigned foreign code out; the descriptor-bound load closes path swap.
  return verify(core,team) && verify(addon,`(${team}) and identifier "com.winter.host-output"`) &&
    verify(app,`(${team}) and (identifier "com.winter.app" or identifier "com.winter.app.dev")`);
};
function load(corePath: string,verify: SignatureVerifier,loadAddon: (fd:number)=>Addon,retainMapping: boolean): HostCodeOutputTransportFactory {
  const core=realpathSync(corePath),resources=dirname(core),contents=dirname(resources),app=dirname(contents);
  if(basename(core)!=="winter-core" || basename(resources)!=="Resources" || basename(contents)!=="Contents" || !app.endsWith(".app"))throw new HostOutputUnavailable("bundle-layout");
  const root=join(resources,HOST_OUTPUT_BUNDLE_SUBPATH),path=join(root,ARTIFACT),record=join(root,"manifest.json");
  const entries=[...[app,contents,resources,join(resources,"native"),root].map(path=>({path,directory:true})),
    ...[core,path,record].map(path=>({path,directory:false}))].map(entry=>({...entry,stat:ordinary(entry.path,entry.directory)}));
  if(realpathSync(path)!==path || realpathSync(record)!==record)throw new HostOutputUnavailable("artifact-alias");
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  let recordFd: number | undefined;
  let mapped=false;
  try {
    recordFd=openSync(record,constants.O_RDONLY|constants.O_NOFOLLOW);
    const image=descriptorBytes(fd,5*1024*1024),recordImage=descriptorBytes(recordFd,4096);
    const pinned=manifest(recordImage.bytes);
    if(createHash("sha256").update(image.bytes).digest("hex")!==pinned.artifactSha256)throw new HostOutputUnavailable("artifact-digest");
    // Pin both files before codesign. The final app seal check must authenticate
    // the same manifest/image identities; no post-seal path read selects code.
    if(!verify(app,core,path))throw new HostOutputUnavailable("signature");
    for(const entry of entries)if(!unchanged(entry.stat,ordinary(entry.path,entry.directory)))throw new HostOutputUnavailable("artifact-changed");
    const checkedImage=descriptorBytes(fd,5*1024*1024),checkedRecord=descriptorBytes(recordFd,4096);
    if(!unchanged(image.stat,checkedImage.stat) || !unchanged(recordImage.stat,checkedRecord.stat) ||
        !image.bytes.equals(checkedImage.bytes) || !recordImage.bytes.equals(checkedRecord.bytes) ||
        !unchanged(ordinary(path,false),image.stat) || !unchanged(ordinary(record,false),recordImage.stat))
      throw new HostOutputUnavailable("artifact-changed");
    // At most one production mapping; this bound also contains fixture callers.
    if(retainMapping && pinnedMappings.length>=8)throw new HostOutputUnavailable("mapping-limit");
    mapped=true;
    const addon=loadAddon(fd);
    if(addon.protocolVersion!==1 || addon.implementationId!==pinned.implementationId || addon.sourceSha256!==pinned.sourceSha256 || typeof addon.createOutputTransport!=="function")throw new HostOutputUnavailable("addon-identity");
    return async()=>addon.createOutputTransport();
  } finally {
    if(recordFd!==undefined)closeSync(recordFd);
    // Darwin dlopen caches names. Preserve this verified /dev/fd name for the
    // process lifetime, even on a failed initialization after mapping began.
    if(mapped && retainMapping)pinnedMappings.push(fd);else closeSync(fd);
  }
}
/** Production has exactly one location, authenticated by the app resource seal.
 * No settings, WINTER_HOME, environment or runtime frame can select a library. */
export function loadBundledHostOutputFactory(): HostCodeOutputTransportFactory | undefined {
  if(bundled)return bundled;
  if(process.platform!=="darwin" || process.arch!=="arm64" || basename(process.execPath)!=="winter-core" || basename(dirname(process.execPath))!=="Resources")return undefined;
  try { return bundled=load(process.execPath,signatures,nativeAddon,true); }
  catch { return undefined; } // HostCodeExecutionService enforces required floors.
}
/** Explicit host-only fixture DI. Never connected to settings/RPC/production
 * resolution. Unsigned disposable app trees may supply their verification seam. */
export function loadFixtureHostOutputFactory(input: { corePath: string;verifySignature: SignatureVerifier;loadAddon?: (fd:number)=>Addon }): HostCodeOutputTransportFactory {
  return load(input.corePath,input.verifySignature,input.loadAddon??nativeAddon,input.loadAddon===undefined);
}
