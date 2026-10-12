// Actual SDK startup probe, confined posture only. No OS adapter or local execution fallback.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const checkout = process.argv[2]; if (!checkout) throw new Error("explicit candidate SDK checkout required");
const { runEmbeddedSession } = await import(join(checkout, "packages/runtime/src/embedded.ts"));
const { RUNTIME_EXECUTION_POSTURE_CAPABILITIES } = await import(join(checkout, "packages/runtime/src/guest/execution-posture.ts"));
const root = mkdtempSync(join(tmpdir(), "winter-guest-posture-")), home = join(root, "home"), cwd = join(root, "source"), store = join(root, "durable");
mkdirSync(home); mkdirSync(cwd);
try {
  let out = "", err = "";
  const code = await runEmbeddedSession({ argv: ["--run", "--config-json", JSON.stringify({ executionPosture: "confined-guest", sessionId: "backend-stable", cwd, winterHome: home, storeHome: store, persistSession: true, model: "winter-test/echo" })],
    env: { HOME: home, WINTER_HOME: home, WINTER_KEYCHAIN_SERVICE: "com.winter.core.test-isolated", WINTER_DISABLE_GIT_INSTRUCTIONS: "1" },
    input: (async function* () { yield '{"type":"user","text":"must never run"}\n'; })(), write: (chunk: string) => { out += chunk; }, writeErr: (chunk: string) => { err += chunk; },
  });
  if (RUNTIME_EXECUTION_POSTURE_CAPABILITIES.supportsConfinedGuestExecution !== false || code !== 1 || out !== "" || !err.includes("confined guest execution requires") || existsSync(store)) throw new Error("actual confined startup gate did not refuse before initialization/store creation");
  process.stdout.write("actual SDK confined startup refused before init and durable store creation\n");
} finally { rmSync(root, { recursive: true, force: true }); }
