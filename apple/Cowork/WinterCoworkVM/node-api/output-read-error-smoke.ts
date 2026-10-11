import { strict as assert } from "node:assert";
import { writeSync } from "node:fs";
import { createNativeHostOutputTransportFactory } from "./output-transport";
const transport=await createNativeHostOutputTransportFactory(process.argv[2]!)();
writeSync(transport.stdoutFd,Buffer.from("stdout"));
writeSync(transport.stderrFd,Buffer.from("stderr"));
transport.closeWriters();
try {
  await assert.rejects(transport.start(()=>assert.fail("read error delivered stdout"),()=>assert.fail("read error delivered stderr")),/read failed/);
  const stats=transport.statistics();assert.equal(stats.readCalls,1,"first error must close all read admission");
  assert.equal(stats.readError,5,"capture EIO before close changes errno");assert.equal(stats.sharedReaders,0);
  console.log(JSON.stringify({readErrorStopsAllReads:true,originalErrnoPreserved:true,realVM:false}));
} finally { transport.dispose(); }
