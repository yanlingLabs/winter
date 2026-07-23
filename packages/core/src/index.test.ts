import { expect, test } from "bun:test";
import * as core from "./index";

// Task A-main (workflows runtime re-plumb, C1 fix): `runWorkflowSubprocess` must be reachable via a
// STATIC import of the `@norma/core` barrel — that's what makes `bun build --compile` bundle
// subprocess-entry.ts (+ worker-harness.ts) into the compiled binary, so `norma-core __workflow-worker`
// has everything it needs in-image with no `new Worker(url)` / runtime file resolution. This test just
// asserts the export exists and is the right shape; the compiled-binary round-trip is A-verify's job.
test("runWorkflowSubprocess is exported from the @norma/core barrel", () => {
  expect(typeof core.runWorkflowSubprocess).toBe("function");
});
