import { afterEach,expect,test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync,copyFileSync,linkSync,mkdtempSync,mkdirSync,readFileSync,realpathSync,rmSync,symlinkSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_OUTPUT_IMPLEMENTATION_ID,HostOutputUnavailable,loadBundledHostOutputFactory,loadFixtureHostOutputFactory } from "../../src/runtime-sdk/host-output-loader";
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true})});
function fixture(){
  const root=realpathSync(mkdtempSync(join(tmpdir(),"winter-output-loader-")));roots.push(root);
  const app=join(root,"Fixture.app"),resources=join(app,"Contents/Resources"),dir=join(resources,"native/host-output");mkdirSync(dir,{recursive:true,mode:0o700});
  const core=join(resources,"winter-core"),addon=join(dir,"winter-host-output.node"),record=join(dir,"manifest.json");writeFileSync(core,"fixture-core");writeFileSync(addon,"fixture-addon");
  const sourceSha256="a".repeat(64);
  const manifest={schema:1,protocolVersion:1,implementationId:HOST_OUTPUT_IMPLEMENTATION_ID,artifact:"winter-host-output.node",platform:"darwin",architecture:"arm64",minimumMacOS:"26.0",sourceSha256,artifactSha256:createHash("sha256").update(readFileSync(addon)).digest("hex")};writeFileSync(record,JSON.stringify(manifest));
  const native={protocolVersion:1,implementationId:HOST_OUTPUT_IMPLEMENTATION_ID,sourceSha256,createOutputTransport:async()=>({stdoutFd:3,stderrFd:4,closeWriters(){},pause(){},resume(){},start:async()=>{},dispose(){}})};
  return{root,core,addon,record,manifest,native};
}
test("source Bun cannot resolve arbitrary runtime environment output paths",()=>{
  const before=process.env.WINTER_HOST_OUTPUT_PATH;process.env.WINTER_HOST_OUTPUT_PATH="/untrusted/addon.node";
  try{expect(loadBundledHostOutputFactory()).toBeUndefined()}finally{if(before===undefined)delete process.env.WINTER_HOST_OUTPUT_PATH;else process.env.WINTER_HOST_OUTPUT_PATH=before}
});
test("fixture DI uses exact bundled path and descriptor bytes before returning capability",async()=>{
  const f=fixture();let verified=false,loaded=false;
  const factory=loadFixtureHostOutputFactory({corePath:f.core,verifySignature:(_app,_core,addon)=>{verified=true;expect(addon).toBe(f.addon);return true},loadAddon:fd=>{loaded=true;expect(verified).toBe(true);expect(readFileSync(fd).toString()).toBe("fixture-addon");return f.native}});
  // Positional hashing leaves the verified descriptor ready for native loading.
  expect(loaded).toBe(true);expect((await factory()).stdoutFd).toBe(3);
});
test("signature and digest rejection occur before loading any native code",()=>{
  const f=fixture();let loaded=false;
  const invoke=(verify:boolean)=>loadFixtureHostOutputFactory({corePath:f.core,verifySignature:()=>verify,loadAddon:()=>{loaded=true;return f.native}});
  expect(()=>invoke(false)).toThrow("signature");writeFileSync(f.addon,"changed-code");expect(()=>invoke(true)).toThrow("artifact-digest");expect(loaded).toBe(false);
});
test("manifest paths versions and loaded ABI cannot nominate other implementations",()=>{
  for(const update of [{artifact:"../other.node"},{protocolVersion:2},{platform:"linux"},{sourceSha256:"bad"}]){
    const f=fixture();writeFileSync(f.record,JSON.stringify({...f.manifest,...update}));expect(()=>loadFixtureHostOutputFactory({corePath:f.core,verifySignature:()=>true,loadAddon:()=>f.native})).toThrow("manifest-identity");
  }
  const f=fixture();expect(()=>loadFixtureHostOutputFactory({corePath:f.core,verifySignature:()=>true,loadAddon:()=>({...f.native,protocolVersion:2})})).toThrow("addon-identity");
});
test("symlinks hardlinks and writable directory sources fail closed",()=>{
  for(const kind of ["symlink","hardlink","writable"]){
    const f=fixture();
    if(kind==="writable")chmodSync(join(f.root,"Fixture.app/Contents/Resources/native"),0o777);
    else{const source=join(f.root,"outside.node");copyFileSync(f.addon,source);rmSync(f.addon);if(kind==="symlink")symlinkSync(source,f.addon);else linkSync(source,f.addon)}
    expect(()=>loadFixtureHostOutputFactory({corePath:f.core,verifySignature:()=>true,loadAddon:()=>f.native})).toThrow(HostOutputUnavailable);
  }
});
test("path replacement after verification cannot replace descriptor-bound image",()=>{
  const f=fixture();
  loadFixtureHostOutputFactory({corePath:f.core,verifySignature:()=>true,loadAddon:fd=>{rmSync(f.addon);writeFileSync(f.addon,"attacker replacement");expect(readFileSync(`/dev/fd/${fd}`).toString()).toBe("fixture-addon");return f.native}});
});
test("manifest and addon swaps during seal verification cannot select unsealed code",()=>{
  for(const inPlace of [false,true]){
    const f=fixture();let loaded=false;
    expect(()=>loadFixtureHostOutputFactory({corePath:f.core,verifySignature:()=>{
      if(!inPlace){rmSync(f.addon);rmSync(f.record)}
      writeFileSync(f.addon,"attacker replacement");
      writeFileSync(f.record,JSON.stringify({...f.manifest,artifactSha256:createHash("sha256").update("attacker replacement").digest("hex")}));
      return true;
    },loadAddon:()=>{loaded=true;return f.native}})).toThrow("artifact-changed");
    expect(loaded).toBe(false);
  }
});
