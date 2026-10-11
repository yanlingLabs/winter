import { createNativeHostOutputTransportFactory } from "./output-transport";
import { writeSync } from "node:fs";
const create=createNativeHostOutputTransportFactory(process.argv[2]!);
const held=[];
for(let i=0;i<32;i++) {
  const transport=await create();held.push(transport);
  // Both EOF and data callbacks may still be queued when the JS environment
  // exits. The outer harness owns no child/VM; originals intentionally stay
  // open and transport.dispose is deliberately never called.
  void transport.start(()=>{},()=>{}).catch(()=>{});
  writeSync(transport.stdoutFd,Buffer.from("queued"));
}
// Remain on JS's stack: callbacks cannot drain while we wait for native reads.
const deadline=Date.now()+2000;
while(held.some(t=>t.statistics().pendingBytes===0) && Date.now()<deadline){}
if(held.some(t=>t.statistics().pendingBytes===0))throw new Error("no queued teardown events");
console.log(JSON.stringify({exitWithoutDispose:true,queuedNativeEvents:true,transports:held.length,realVM:false}));
process.exit(0);
