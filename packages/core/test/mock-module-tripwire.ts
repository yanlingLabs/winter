// m6 (Winter Phase 8c whole-branch review): "any `mock.module` left registered after a test file
// fails the file." `bun:test` gives no introspection for "what is currently mocked" and — measured
// directly against this Bun build — `mock.restore()` does NOT undo `mock.module()` at all (it only
// restores `mock(fn)`/`spyOn` doubles); the ONLY way this codebase has to un-mock a module is to
// call `mock.module(id, factory)` again with a factory that reproduces the real export shape
// (`official-session.test.ts`/`official-options.test.ts` already do exactly this, in their own
// `afterAll`/`afterEach`). So "left registered" cannot mean "the factory differs from the real
// module" — that is unobservable from here — it means "mocked once and never touched again", which
// is precisely the shape a forgotten cleanup takes and precisely what the codebase's own working
// examples do NOT do (they always call `mock.module` a second time for the same id).
//
// ORDERING, AND WHY THIS IS A PER-FILE OPT-IN RATHER THAN A BLANKET `bunfig.toml` PRELOAD HOOK.
// `bun test` runs every discovered file's hooks in ONE process; `afterAll` fires in REGISTRATION
// order (measured: a plain script proves FIFO, not LIFO); and a hook registered from `test.preload`
// runs exactly ONCE for the ENTIRE run, not once per file (also measured) — so a preload-installed
// `afterAll` cannot both isolate "which file leaked" and run AFTER that file's own restoring
// `afterAll`. `installMockModuleTripwire()` is therefore called BY the file, and it must be the
// LAST lifecycle hook that file registers — after any `afterAll`/`afterEach` that re-mocks a module
// back to its real shape — so this guard's own `afterAll` (registered last) sees the file's truly
// final state.
//
// A KNOWN LIMIT, NOT A GUARANTEE: this is a PARITY check (odd count = leaked), not a content check.
// `mock.module(A, f1); mock.module(A, f2);` with no third, restoring call reads as CLEAN — two
// calls, even — even though the module is left mocked as `f2` forever. Bun gives no way to ask "is
// A currently mocked, and to what" from outside the module being mocked, so this cannot tell "the
// second call was a genuine restore" from "the second call was just another fake" any more finely
// than counting. It catches the shape a FORGOTTEN cleanup actually takes (one call, never revisited)
// — which is the whole failure mode this guard exists for — not every way a file could still leave
// a mock behind on purpose or by a subtler mistake.
//
// WHY THIS FILE LIVES AT `test/`, NOT `test/helpers/`: `test/helpers/*` is another lane's owned
// path this phase; this is a suite-wide concern with no home there, so it sits beside
// `test/preload.ts` instead (the OTHER file this whole suite's `bunfig.toml` already treats as
// global) — a deliberate placement, not an oversight.
import { afterAll, mock } from "bun:test";

/**
 * Wraps `bun:test`'s `mock.module` ONCE per process (idempotent — a second file importing this
 * module must not double-wrap) to count calls per module id. `installMockModuleTripwire()` snapshots
 * which ids already existed at install time (another file's leftovers, if any slipped through) and
 * only ever judges ids that change AFTER that snapshot — so one file's tripwire can never blame
 * another file's id.
 */
const mockedIdCounts = new Map<string, number>();
let installed = false;

function wrapMockModuleOnce(): void {
  if (installed) return;
  installed = true;
  const real = mock.module.bind(mock);
  mock.module = ((id: string, factory: () => unknown) => {
    mockedIdCounts.set(id, (mockedIdCounts.get(id) ?? 0) + 1);
    return real(id, factory);
  }) as typeof mock.module;
}

/** The check `installMockModuleTripwire`'s `afterAll` runs — split out so this file's own test can
 *  drive it directly, without depending on bun's actual `afterAll` scheduling (which this file's own
 *  header explains cannot be relied on for cross-file isolation anyway). Clears every id it judges,
 *  win or lose, so a later call — same file's afterEach, or the next file's tripwire — starts clean. */
export function checkMockModuleLeaks(seenAtInstall: ReadonlySet<string>): string[] {
  const leaked = [...mockedIdCounts.entries()].filter(([id, count]) => !seenAtInstall.has(id) && count % 2 !== 0).map(([id]) => id);
  for (const id of mockedIdCounts.keys()) if (!seenAtInstall.has(id)) mockedIdCounts.delete(id);
  return leaked;
}

/**
 * Call this ONCE, at the TOP of a test file — BEFORE its first `mock.module` call, so every call the
 * file makes is counted. It does two things, in an order chosen to solve both halves of this file's
 * own ordering problem at once:
 *
 *  1. Wraps `mock.module` SYNCHRONOUSLY, right now — so a `mock.module` call the very next line of
 *     the file makes is already counted.
 *  2. Defers its OWN `afterAll` registration to a MICROTASK (`queueMicrotask`) rather than
 *     registering it synchronously here. A file's top-level module code — every `mock.module` call
 *     and every `afterAll`/`afterEach` it registers, however far below this line they are — all run
 *     SYNCHRONOUSLY to completion before any microtask gets a turn; bun's own `afterAll` ordering is
 *     FIFO by REGISTRATION time, so a registration that lands after the whole synchronous module body
 *     has finished is registered LAST regardless of how early in the file this function was called.
 *     That is what makes this guard's check see the file's truly final state — including a
 *     `mock.module(id, realFactory)` restore in a LATER `afterAll` — without asking the caller to
 *     place two separate calls in two separate places.
 */
export function installMockModuleTripwire(): void {
  wrapMockModuleOnce();
  const seenAtInstall = new Set(mockedIdCounts.keys());
  queueMicrotask(() => {
    afterAll(() => {
      const leaked = checkMockModuleLeaks(seenAtInstall);
      if (leaked.length > 0) {
        throw new Error(
          `mock.module tripwire: ${leaked.join(", ")} still mocked at the end of this file (mocked an odd ` +
            `number of times — mock.module was never called again for the same id). mock.restore() does ` +
            `NOT undo mock.module (measured) — call mock.module(id, realFactory) again in an afterAll/afterEach.`,
        );
      }
    });
  });
}

/** This file's own test only: undoes the process-wide wrap so a test can install its own without
 *  interference from whatever ran earlier in this same `bun test` process. */
export function _uninstallForTests(realMockModule: typeof mock.module): void {
  mock.module = realMockModule;
  installed = false;
  mockedIdCounts.clear();
}
