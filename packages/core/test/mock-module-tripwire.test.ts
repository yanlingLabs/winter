// m6's own test: `checkMockModuleLeaks` is the testable core of `installMockModuleTripwire` (see
// that file's header for why the REAL `afterAll` path cannot be driven from inside a normal test —
// bun runs `afterAll` in FIFO registration order and a preload-installed one fires once for the
// WHOLE process, not once per file, so there is no way to "catch" a real tripwire throw without
// either crashing this very file or racing bun's own scheduler). Every assertion below drives the
// exported logic directly instead.
import { describe, expect, mock, test } from "bun:test";
import { checkMockModuleLeaks, installMockModuleTripwire, _uninstallForTests } from "./mock-module-tripwire";

// Fictional, unresolvable-as-a-real-file specifiers — `mock.module` accepts any string id (measured
// separately), and nothing in this codebase ever imports these, so leaving them "mocked" for the
// rest of this `bun test` process (which — measured — `mock.restore()` cannot undo) is inert.
const FAKE_ID_A = "winter-test-fixture/tripwire-fake-a";
const FAKE_ID_B = "winter-test-fixture/tripwire-fake-b";

describe("checkMockModuleLeaks", () => {
  test("a module mocked once (never revisited) is reported as leaked", () => {
    const realMockModule = mock.module;
    installMockModuleTripwire();
    try {
      const seen = new Set<string>(); // nothing pre-existing
      // installMockModuleTripwire wrapped mock.module — this call is what the tripwire counts.
      mock.module(FAKE_ID_A, () => ({}));
      expect(checkMockModuleLeaks(seen)).toEqual([FAKE_ID_A]);
      // The check clears what it judged — a second call reports nothing left to judge.
      expect(checkMockModuleLeaks(seen)).toEqual([]);
    } finally {
      _uninstallForTests(realMockModule);
    }
  });

  test("a module mocked and then re-mocked (the codebase's own restore idiom) is NOT leaked", () => {
    const realMockModule = mock.module;
    installMockModuleTripwire();
    try {
      const seen = new Set<string>();
      mock.module(FAKE_ID_A, () => ({ fake: true }));
      mock.module(FAKE_ID_A, () => ({ restored: true })); // the "re-mock to real" cleanup idiom
      expect(checkMockModuleLeaks(seen)).toEqual([]);
    } finally {
      _uninstallForTests(realMockModule);
    }
  });

  test("an id already present at install time is never blamed on this file, however many times it is later touched", () => {
    const realMockModule = mock.module;
    installMockModuleTripwire();
    try {
      const seen = new Set<string>([FAKE_ID_B]); // simulates: another file already mocked this id
      mock.module(FAKE_ID_B, () => ({}));         // odd — would leak if not pre-seeded
      expect(checkMockModuleLeaks(seen)).toEqual([]);
    } finally {
      _uninstallForTests(realMockModule);
    }
  });

  test("two DIFFERENT leaked ids are both reported", () => {
    const realMockModule = mock.module;
    installMockModuleTripwire();
    try {
      const seen = new Set<string>();
      mock.module(FAKE_ID_A, () => ({}));
      mock.module(FAKE_ID_B, () => ({}));
      expect(checkMockModuleLeaks(seen).sort()).toEqual([FAKE_ID_A, FAKE_ID_B].sort());
    } finally {
      _uninstallForTests(realMockModule);
    }
  });

  test("no mock.module calls at all: nothing to report", () => {
    const realMockModule = mock.module;
    installMockModuleTripwire();
    try {
      expect(checkMockModuleLeaks(new Set())).toEqual([]);
    } finally {
      _uninstallForTests(realMockModule);
    }
  });
});

describe("installMockModuleTripwire wrapping", () => {
  test("wraps mock.module transparently — a real mock still takes effect", async () => {
    const realMockModule = mock.module;
    installMockModuleTripwire();
    try {
      await mock.module(FAKE_ID_A, () => ({ marker: "tripwire-still-calls-through" }));
      const imported = (await import(FAKE_ID_A)) as { marker: string };
      expect(imported.marker).toBe("tripwire-still-calls-through");
      // Clean up the id this test actually mocked, so it never reaches a later file's judgment.
      checkMockModuleLeaks(new Set());
    } finally {
      _uninstallForTests(realMockModule);
    }
  });

  test("installing twice in the same process does not double-wrap mock.module", () => {
    const realMockModule = mock.module;
    installMockModuleTripwire();
    const wrappedOnce = mock.module;
    installMockModuleTripwire();
    try {
      expect(mock.module).toBe(wrappedOnce); // still the SAME wrapper, not wrapped-of-a-wrapper
    } finally {
      _uninstallForTests(realMockModule);
    }
  });
});
