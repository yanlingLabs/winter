// Boots a production-shaped daemon (temp home, file secret store, no provider) and prints which host-env modules were loaded. Run by host-env-lazy.test.ts.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const loaded: string[] = [];
Bun.plugin({
  name: "host-env-load-recorder",
  setup(build) {
    build.onLoad({ filter: /[\\/]cowork[\\/]host-env[\\/][^\\/]+\.ts$/ }, args => { loaded.push(args.path); return { contents: readFileSync(args.path, "utf8"), loader: "ts" }; });
  },
});
const home = mkdtempSync(join(tmpdir(), "winter-hostenv-probe-"));
const { startDaemon } = await import("../../../src/daemon");
const { FileSecretStore } = await import("../../../src/auth/secret-store");
const daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "secrets")), agentProvider: null });
const built = daemon.coworkNative?.built;
await daemon.stop();
console.log(JSON.stringify({ loaded, built }));
