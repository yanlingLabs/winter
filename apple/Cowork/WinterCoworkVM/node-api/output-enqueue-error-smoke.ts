import { strict as assert } from "node:assert";
import { writeSync } from "node:fs";
import { createNativeHostOutputTransportFactory } from "./output-transport";
const transport=await createNativeHostOutputTransportFactory(process.argv[2]!)();
writeSync(transport.stderrFd,Buffer.from("queued-stderr"));
const done=transport.start(()=>assert.fail("enqueue failure delivered stdout"),()=>{});
function until(predicate:()=>boolean) { const end=Date.now()+2000;while(!predicate() && Date.now()<end){};assert(predicate()); }
// JS stays on its stack: the stderr callback remains queued while stdout fails.
until(()=>transport.statistics().pendingBytes>0);
writeSync(transport.stdoutFd,Buffer.from("trigger"));
until(()=>transport.statistics().readError!==0);
const reads=transport.statistics().readCalls;
writeSync(transport.stdoutFd,Buffer.from("must-not-be-read"));
const end=Date.now()+20;while(Date.now()<end)assert.equal(transport.statistics().readCalls,reads);
transport.closeWriters();
try { await assert.rejects(done,/read failed/);assert.equal(transport.statistics().readError,12);
  console.log(JSON.stringify({enqueueErrorStopsReadsWhilePeerCallbackQueued:true,realVM:false}));
} finally { transport.dispose(); }
