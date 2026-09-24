// WS-21 (R.1): REAL run homes for a test's session driver, recorded.
//
// On a build whose linked router applies run homes, a driver table without run-home deps refuses
// (`run_home_required`, session-driver's guard) — and a hand-built `RunHome` object is refused by the
// router itself (`run_home_foreign`: it points a child only at a folder `buildRunHome` built). So a test
// that wants to observe run homes wires the router's own `buildRunHome` through the daemon's own
// `runHomeInputFor`, exactly as `daemon.ts` does, and records what went through:
//   - `facts`: what the driver asked for (mode, dispatchChild, leg, cwd, workdirLess);
//   - `inputs`: the `RunHomeInput` each build received;
//   - `built`: the run homes themselves (untouched — the router checks their identity);
//   - `disposed()`: the run ids whose folder is gone (a run home is disposed by removing its folder).
import { existsSync } from "node:fs";
import { buildRunHome, type RunHome, type RunHomeInput } from "@yanlinglabs/winter-runtime-sdk";
import { runHomeInputFor, type RunHomeSessionFacts } from "../../src/runtime-sdk/run-home-input";
import type { WinterLegDeps } from "../../src/runtime-sdk/session-driver";
import type { Settings } from "../../src/settings";

export interface RecordedRunHomes {
  deps: NonNullable<WinterLegDeps["runHome"]>;
  facts: RunHomeSessionFacts[];
  inputs: RunHomeInput[];
  built: RunHome[];
  /** The run ids whose run folder no longer exists, in build order. */
  disposed(): string[];
}

export function recordedRunHomes(
  home: string,
  opts: {
    isTrusted?: (dir: string) => boolean;
    settings?: () => Settings | null | undefined;
    reservedMcpServerNames?: readonly string[];
    /** Wraps the real builder (e.g. to fail once). */
    build?: (input: RunHomeInput, real: (input: RunHomeInput) => Promise<RunHome>) => Promise<RunHome>;
  } = {},
): RecordedRunHomes {
  const facts: RunHomeSessionFacts[] = [];
  const inputs: RunHomeInput[] = [];
  const built: RunHome[] = [];
  const deps: NonNullable<WinterLegDeps["runHome"]> = {
    inputFor: (f) => {
      facts.push(f);
      return runHomeInputFor({
        home,
        trust: { isTrusted: opts.isTrusted ?? (() => false) },
        settings: opts.settings ?? (() => undefined),
        reservedMcpServerNames: opts.reservedMcpServerNames ?? [],
        gitRootFor: () => null,
      }, f);
    },
    build: async (input) => {
      inputs.push(input);
      const runHome = await (opts.build === undefined ? buildRunHome(input) : opts.build(input, buildRunHome));
      built.push(runHome);
      return runHome;
    },
  };
  return { deps, facts, inputs, built, disposed: () => built.filter((r) => !existsSync(r.dir)).map((r) => r.runId) };
}
