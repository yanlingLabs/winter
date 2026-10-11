import { strict as assert } from "node:assert";
import { mkdtempSync, existsSync, rmSync, readFileSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeHostOutputTransportFactory } from "./output-transport";

// Fixture-only children, no daemon, real home, provider, VM, public socket or
// global service. The addon is compiled by the protected-package build recipe;
// this test never compiles or loads C from a model-writable runtime path.
const build = process.env.WINTER_COWORK_NATIVE_TEST_BUILD ?? readFileSync(join(import.meta.dir,"out/latest-build.txt"),"utf8").trim();
const create = createNativeHostOutputTransportFactory(join(build,"winter-cowork-native.node"));
const fixture = mkdtempSync(join(tmpdir(),"winter-native-output-"));
const children: ReturnType<typeof Bun.spawn>[] = [];
const fixtureFds: number[] = [];
const transports: Awaited<ReturnType<typeof create>>[] = [];
try {
  const pressure = await create(); transports.push(pressure);
  assert(pressure.statistics().flagsVerified); pressure.pause();
  const child=Bun.spawn(["/bin/sh","-c",'dd if=/dev/zero bs=65536 count=160 2>/dev/null; printf done > "$1/done"',"winter-output-fixture",fixture],{stdin:"ignore",stdout:pressure.stdoutFd,stderr:pressure.stderrFd});children.push(child);
  pressure.closeWriters();pressure.closeWriters();
  let total=0,maxChunk=0;
  const done=pressure.start(chunk=>{total+=chunk.length;maxChunk=Math.max(maxChunk,chunk.length)},()=>{});
  await Bun.sleep(100);
  assert.equal(pressure.statistics().readCalls,0,"pause before start must prevent native reads");
  assert(!existsSync(join(fixture,"done")),"paused native transport must backpressure the child kernel pipe");
  pressure.resume(); await done;assert.equal(await child.exited,0);assert.equal(total,10*1024*1024);
  assert(maxChunk<=65536);assert(pressure.statistics().peakPendingBytes<=2*65536);assert(existsSync(join(fixture,"done")));
  pressure.dispose();pressure.dispose();

  const midstream=await create();transports.push(midstream);
  const midChild=Bun.spawn(["/bin/sh","-c",'dd if=/dev/zero bs=65536 count=16 2>/dev/null'],{stdin:"ignore",stdout:midstream.stdoutFd,stderr:midstream.stderrFd});children.push(midChild);midstream.closeWriters();
  let callbacks=0,first!:()=>void;const firstChunk=new Promise<void>(resolve=>{first=resolve});
  const midDone=midstream.start(()=>{callbacks++;midstream.pause();first()},()=>{});
  await firstChunk;const calls=midstream.statistics().readCalls;await Bun.sleep(50);
  assert.equal(midstream.statistics().readCalls,calls,"pause inside callback must prevent further native reads");
  midstream.dispose();await assert.rejects(midDone,/disposed/);midChild.kill();await midChild.exited;assert.equal(callbacks,1);

  const pending=[];
  for(let i=0;i<12;i++){
    const t=await create();transports.push(t);
    const c=Bun.spawn(["/bin/sh","-c",'printf stdout; printf stderr >&2'],{stdin:"ignore",stdout:t.stdoutFd,stderr:t.stderrFd});children.push(c);t.closeWriters();
    let out="",err="";pending.push(t.start(chunk=>{out+=chunk.toString()},chunk=>{err+=chunk.toString()}).then(async()=>{assert.equal(await c.exited,0);assert.equal(out,"stdout");assert.equal(err,"stderr");t.dispose()}));
  }
  await Promise.all(pending);
  const broken=await create();transports.push(broken);const failing=Bun.spawn(["/bin/sh","-c","printf trigger"],{stdin:"ignore",stdout:broken.stdoutFd,stderr:broken.stderrFd});children.push(failing);broken.closeWriters();
  await assert.rejects(broken.start(()=>{throw new Error("fixture callback failure")},()=>{}),/fixture callback failure/);await failing.exited;broken.dispose();
  const disposed=await create();transports.push(disposed);disposed.pause();
  const abandoned=Bun.spawn(["/bin/sh","-c","printf abandoned; sleep 1"],{stdin:"ignore",stdout:disposed.stdoutFd,stderr:disposed.stderrFd});children.push(abandoned);disposed.closeWriters();let afterDispose=0;
  const cancelled=disposed.start(()=>{afterDispose++},()=>{afterDispose++});disposed.dispose();await assert.rejects(cancelled,/disposed/);abandoned.kill();await abandoned.exited;assert.equal(afterDispose,0);
  const eof=await create();transports.push(eof);let firstEOF!:()=>void;const stdoutDone=new Promise<void>(resolve=>{firstEOF=resolve});
  const eofChild=Bun.spawn(["/bin/sh","-c","printf early; exec 1>&-; sleep 0.2; printf late >&2"],{stdin:"ignore",stdout:eof.stdoutFd,stderr:eof.stderrFd});children.push(eofChild);eof.closeWriters();
  let eofResolved=false,late="";const bothEOF=eof.start(()=>{firstEOF()},chunk=>{late+=chunk.toString()}).then(()=>{eofResolved=true});
  await stdoutDone;assert.equal(eofResolved,false,"stdout alone must not finish transport");await bothEOF;await eofChild.exited;assert.equal(late,"late");eof.dispose();
  for(let i=0;i<140;i++)fixtureFds.push(openSync("/dev/null","r"));
  const inherited=await create(); assert(inherited.stdoutFd>127 && inherited.stderrFd>127);transports.push(inherited);let descriptorReport="";
  const fdChild=Bun.spawn(["/usr/bin/python3","-c",`import os,fcntl,json; found=[]
for name in os.listdir("/dev/fd"):
 fd=int(name)
 if fd<3: continue
 try: fcntl.fcntl(fd,fcntl.F_GETFD);found.append(fd)
 except OSError: pass
print(json.dumps(found))`],{stdin:"ignore",stdout:inherited.stdoutFd,stderr:inherited.stderrFd});children.push(fdChild);inherited.closeWriters();
  await inherited.start(chunk=>{descriptorReport+=chunk.toString()},()=>{});assert.equal(await fdChild.exited,0);assert.deepEqual(JSON.parse(descriptorReport),[]);inherited.dispose();
  const inspect=await create();transports.push(inspect);const active=inspect.statistics().sharedReaders;assert.equal(active,1);inspect.dispose();
  console.log(JSON.stringify({nativeOutputTransport:true,pressureBytes:total,pauseStopsNativeReads:true,exactStdoutStderr:true,maxChunkBytes:maxChunk,sharedReadiness:true,concurrentStreams:12,callbackFailureVisible:true,noChunksAfterDispose:true,pauseInsideCallback:true,bothEOFRequired:true,extraInheritedDescriptors:false,descriptorEnumeration:"/dev/fd",highFixtureDescriptors:140,realVM:false}));
} finally {
  for(const child of children)if(child.exitCode===null){try{child.kill()}catch{};await child.exited}
  for(const transport of transports)transport.dispose();
  for(const fd of fixtureFds)closeSync(fd);
  rmSync(fixture,{recursive:true,force:true});
}
