import { strict as assert } from "node:assert";
import { createNativeHostOutputTransportFactory } from "./output-transport";

// Only a fixture addon compiled with WINTER_OUTPUT_FIXTURE_TERMINAL_FAILURE.
// No runtime switch exists in the production adapter.
const path=process.argv[2];
assert(path?.startsWith("/"), "absolute fixture addon path required");
const transport=await createNativeHostOutputTransportFactory(path)();
transport.closeWriters();
const watchdog=setTimeout(()=>{throw new Error("terminal enqueue failure left start() pending")},2000);
try {
  await assert.rejects(transport.start(()=>assert.fail("unexpected stdout"),()=>assert.fail("unexpected stderr")),/disposed/);
  assert.equal(transport.statistics().sharedReaders,0);
  console.log(JSON.stringify({terminalEnqueueFailureRejects:true,nativeReadersReleased:true,realVM:false}));
} finally { clearTimeout(watchdog);transport.dispose(); }
