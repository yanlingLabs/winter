// Fix wave 2 (CLI): the SAME contract core's e2e proofs use, re-exported — never a second copy of
// the env logic. Since Phase 8b every `session.create` spawns a `winter` child (P8b-2: no binary ⇒
// a typed refusal, never a fallback), so a CLI test that creates a session needs the built binary:
// `WINTER_RUNTIME_EXECUTABLE` unset ⇒ SKIP (a local run without a build); `WINTER_RUNTIME_REQUIRE_BINARY=1`
// (CI) ⇒ a missing binary FAILS at import, so CI can never go green by skipping the proof.
import { test } from "bun:test";
import { winterExecutableForTests } from "../../../core/test/helpers/winter-binary";

export { describeWithWinterBinary, winterExecutableForTests } from "../../../core/test/helpers/winter-binary";

/** `test` when the binary is available, `test.skip` when it is not (and a throw under
 *  `WINTER_RUNTIME_REQUIRE_BINARY=1`, at import). For files that mix session-creating tests with
 *  ones a bare daemon can serve, so the latter keep running without a build. */
export const WINTER_BIN = winterExecutableForTests();
export const testWithWinterBinary: typeof test = WINTER_BIN ? test : (test.skip as unknown as typeof test);
