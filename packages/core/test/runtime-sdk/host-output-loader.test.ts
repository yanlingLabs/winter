import { afterEach,expect,test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync,copyFileSync,linkSync,mkdtempSync,mkdirSync,readFileSync,realpathSync,rmSync,symlinkSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_OUTPUT_IMPLEMENTATION_ID,HostOutputUnavailable,loadBundledHostOutputFactory,loadFixtureHostOutputFactory,createFixtureLazyHostOutputFactory } from "../../src/runtime-sdk/host-output-loader";
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
  const factory=await loadFixtureHostOutputFactory({corePath:f.core,verifySignature:(_app,_core,addon)=>{verified=true;expect(addon).toBe(f.addon);return true},loadAddon:fd=>{loaded=true;expect(verified).toBe(true);expect(readFileSync(fd).toString()).toBe("fixture-addon");return f.native}});
  // Positional hashing leaves the verified descriptor ready for native loading.
  expect(loaded).toBe(true);expect((await factory()).stdoutFd).toBe(3);
});
test("signature and digest rejection occur before loading any native code",async()=>{
  const f=fixture();let loaded=false;
  const invoke=(verify:boolean)=>loadFixtureHostOutputFactory({corePath:f.core,verifySignature:()=>verify,loadAddon:()=>{loaded=true;return f.native}});
  await expect(invoke(false)).rejects.toThrow("signature");writeFileSync(f.addon,"changed-code");await expect(invoke(true)).rejects.toThrow("artifact-digest");expect(loaded).toBe(false);
});
test("manifest paths versions and loaded ABI cannot nominate other implementations",async()=>{
  for(const update of [{artifact:"../other.node"},{protocolVersion:2},{platform:"linux"},{sourceSha256:"bad"}]){
    const f=fixture();writeFileSync(f.record,JSON.stringify({...f.manifest,...update}));await expect(loadFixtureHostOutputFactory({corePath:f.core,verifySignature:()=>true,loadAddon:()=>f.native})).rejects.toThrow("manifest-identity");
  }
  const f=fixture();await expect(loadFixtureHostOutputFactory({corePath:f.core,verifySignature:()=>true,loadAddon:()=>({...f.native,protocolVersion:2})})).rejects.toThrow("addon-identity");
});
test("symlinks hardlinks and writable directory sources fail closed",async()=>{
  for(const kind of ["symlink","hardlink","writable"]){
    const f=fixture();
    if(kind==="writable")chmodSync(join(f.root,"Fixture.app/Contents/Resources/native"),0o777);
    else{const source=join(f.root,"outside.node");copyFileSync(f.addon,source);rmSync(f.addon);if(kind==="symlink")symlinkSync(source,f.addon);else linkSync(source,f.addon)}
    await expect(loadFixtureHostOutputFactory({corePath:f.core,verifySignature:()=>true,loadAddon:()=>f.native})).rejects.toThrow(HostOutputUnavailable);
  }
});
test("path replacement after verification cannot replace descriptor-bound image",async()=>{
  const f=fixture();
  await loadFixtureHostOutputFactory({corePath:f.core,verifySignature:()=>true,loadAddon:fd=>{rmSync(f.addon);writeFileSync(f.addon,"attacker replacement");expect(readFileSync(`/dev/fd/${fd}`).toString()).toBe("fixture-addon");return f.native}});
});
test("manifest and addon swaps during seal verification cannot select unsealed code",async()=>{
  for(const inPlace of [false,true]){
    const f=fixture();let loaded=false;
    await expect(loadFixtureHostOutputFactory({corePath:f.core,verifySignature:async()=>{
      if(!inPlace){rmSync(f.addon);rmSync(f.record)}
      writeFileSync(f.addon,"attacker replacement");
      writeFileSync(f.record,JSON.stringify({...f.manifest,artifactSha256:createHash("sha256").update("attacker replacement").digest("hex")}));
      return true;
    },loadAddon:()=>{loaded=true;return f.native}})).rejects.toThrow("artifact-changed");
    expect(loaded).toBe(false);
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
test("lazy construction does no loader work before first output use",async()=>{
  const f=fixture();rmSync(f.core);let verifications=0,mappings=0;
  const create=createFixtureLazyHostOutputFactory({corePath:f.core,verifySignature:()=>{verifications++;return true},loadAddon:()=>{mappings++;return f.native}});
  // Missing core would have been permanently refused if any eager work ran.
  await new Promise<void>(resolve=>setImmediate(resolve));
  expect(verifications).toBe(0);expect(mappings).toBe(0);
  writeFileSync(f.core,"fixture-core");
  expect((await create()).stdoutFd).toBe(3);expect(verifications).toBe(1);
});
test("first output calls share responsive async verification and cache success",async()=>{
  const f=fixture(),entered=deferred<void>(),gate=deferred<boolean>();
  let verifications=0,mappings=0,allocations=0;
  const create=createFixtureLazyHostOutputFactory({corePath:f.core,verifySignature:async()=>{verifications++;entered.resolve();return gate.promise},loadAddon:()=>{mappings++;return{...f.native,createOutputTransport:async()=>{allocations++;return f.native.createOutputTransport()}}}});
  const callers=Array.from({length:12},()=>create());
  await entered.promise;
  let ticked=false;await new Promise<void>(resolve=>setTimeout(()=>{ticked=true;resolve()},0));
  expect(ticked).toBe(true);expect(verifications).toBe(1);expect(mappings).toBe(0);expect(allocations).toBe(0);
  gate.resolve(true);await Promise.all(callers);
  expect(mappings).toBe(1);expect(allocations).toBe(12);
  writeFileSync(f.addon,"later path bytes are not the authenticated mapping");
  await create();expect(verifications).toBe(1);expect(mappings).toBe(1);expect(allocations).toBe(13);
});
test("deterministic digest and ABI refusal stay cached despite later path repair",async()=>{
  for(const kind of ["digest","abi"]){
    const f=fixture();let maps=0,checks=0;const logs:string[]=[];
    if(kind==="digest")writeFileSync(f.addon,"unsealed bytes");
    const create=createFixtureLazyHostOutputFactory({corePath:f.core,verifySignature:()=>{checks++;return true},loadAddon:()=>{maps++;return{...f.native,protocolVersion:2}},log:line=>logs.push(line)});
    await expect(create()).rejects.toThrow(kind==="digest"?"artifact-digest":"addon-identity");
    writeFileSync(f.addon,"fixture-addon");
    await expect(create()).rejects.toThrow(kind==="digest"?"artifact-digest":"addon-identity");
    expect(checks).toBe(kind==="digest"?0:1);expect(maps).toBe(kind==="digest"?0:1);expect(logs.length).toBe(1);
  }
});
test("transient cooldown caps work, shares callers, and permits recovery after prolonged failures",async()=>{
  const f=fixture();let clock=0,checks=0;const logs:string[]=[];
  const create=createFixtureLazyHostOutputFactory({corePath:f.core,now:()=>clock,log:line=>logs.push(line),verifySignature:()=>{
    checks++;if(checks<=7)throw new HostOutputUnavailable("codesign-timeout",true);return true;
  },loadAddon:()=>f.native});
  const cooldowns=[1000,2000,4000,8000,16000,30000,30000];
  for(const cooldown of cooldowns){
    const failures=await Promise.allSettled([create(),create(),create()]);
    expect(failures.every(result=>result.status==="rejected")).toBe(true);
    const prior=checks;
    clock+=cooldown-1;await expect(create()).rejects.toThrow("codesign-timeout");expect(checks).toBe(prior);
    clock++;
  }
  expect(checks).toBe(7);expect((await create()).stdoutFd).toBe(3);expect(checks).toBe(8);
  expect(logs.length).toBe(1);expect(logs[0]).toContain("codesign-timeout");
});
test("real unsigned fixture codesign fails asynchronously and remains retryable",async()=>{
  const f=fixture();let mapped=false;const logs:string[]=[];
  const create=createFixtureLazyHostOutputFactory({corePath:f.core,loadAddon:()=>{mapped=true;return f.native},log:line=>logs.push(line),now:()=>0});
  let ticked=false;const tick=new Promise<void>(resolve=>setTimeout(()=>{ticked=true;resolve()},0));
  const result=await create().then(()=>null,error=>error);
  await tick;
  expect(ticked).toBe(true);expect(result).toBeInstanceOf(HostOutputUnavailable);
  expect(result.reason).toBe("codesign-exit");expect(result.retryable).toBe(true);
  expect(mapped).toBe(false);await expect(create()).rejects.toThrow("codesign-exit");expect(logs.length).toBe(1);
});
test("successful mapping remains cached when a later transport allocation fails",async()=>{
  const f=fixture();let checks=0,allocations=0;
  const create=createFixtureLazyHostOutputFactory({corePath:f.core,verifySignature:()=>{checks++;return true},loadAddon:()=>({...f.native,createOutputTransport:async()=>{
    if(++allocations===1)throw new Error("fixture allocation unavailable");return f.native.createOutputTransport();
  }})});
  await expect(create()).rejects.toThrow("fixture allocation unavailable");
  expect((await create()).stdoutFd).toBe(3);expect(checks).toBe(1);expect(allocations).toBe(2);
});
test("hardening refusals are permanent and unclassified errors log only sanitized reasons",async()=>{
  for(const hardening of [false,true]){
    const f=fixture();let checks=0,clock=0;const logs:string[]=[];
    const create=createFixtureLazyHostOutputFactory({corePath:f.core,now:()=>clock,log:line=>logs.push(line),verifySignature:()=>{
      checks++;if(hardening)throw new HostOutputUnavailable("core-hardening");throw new Error("fixture-private-detail-must-not-appear");
    },loadAddon:()=>f.native});
    await expect(create()).rejects.toThrow(hardening?"core-hardening":"loader-transient");
    clock=30_000;await expect(create()).rejects.toThrow(hardening?"core-hardening":"loader-transient");
    expect(checks).toBe(hardening?1:2);expect(logs.length).toBe(1);
    expect(logs[0]).not.toContain("fixture-private-detail");
  }
});
