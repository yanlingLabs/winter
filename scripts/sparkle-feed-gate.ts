/**
 * Sparkle local-feed gate rig. Builds Release vCURRENT and a patched vNEXT, signs the
 * update zip with an EPHEMERAL test key (never the production key), writes a local
 * appcast, serves it on localhost:8377, and prints the manual verification steps.
 *
 * Produces test bundles under out/sparkle-gate/ — quit any real Winter.app first.
 *
 * Adaptation note (T6): the design brief pinned Sparkle 2.6.0, but Package.resolved (SPM)
 * resolved to 2.9.4 by the time this ran — the CLI dist MUST match the framework the app
 * links, or sign_update's signature format can mismatch what SUUpdater verifies. Using
 * 2.9.4's dist here.
 *
 * Adaptation note (T6): in the 2.9.4 dist, `generate_keys -f <file>` IMPORTS an existing
 * private key file INTO the Keychain — it does not generate a fresh file-only key (verified
 * via --help). There is no Keychain-free keygen path in this tool; the brief's own fallback
 * note anticipated this. So: generate under an isolated --account (never the production
 * account/default), export the private key material to a file with -x for sign_update, then
 * delete the Keychain item when done so the rig leaves zero residue (truly ephemeral).
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { FORMAT, ROOT, readCanonical } from "./version-lib";

const SPARKLE_VERSION = "2.9.4"; // matches apple/Winter/Package.resolved, not project.yml's "from: 2.6.0" floor
const TOOLS = join(ROOT, ".tools", "sparkle");
const OUT = join(ROOT, "out", "sparkle-gate");
const PORT = 8377;
// Isolated Keychain account for the ephemeral test key — never the production signing
// account (sub-project D generates that one separately, un-prefixed, for real releases).
const TEST_KEY_ACCOUNT = "winter-sparkle-gate-test";
const sh = (cmd: string, cwd = ROOT) => execSync(cmd, { cwd, stdio: "pipe" }).toString();

// 1. Sparkle CLI tools (generate_keys / sign_update) from the official dist archive.
if (!existsSync(join(TOOLS, "bin", "sign_update"))) {
  mkdirSync(TOOLS, { recursive: true });
  const url = `https://github.com/sparkle-project/Sparkle/releases/download/${SPARKLE_VERSION}/Sparkle-${SPARKLE_VERSION}.tar.xz`;
  sh(`curl -sL "${url}" -o "${TOOLS}/sparkle.tar.xz" && tar -xf "${TOOLS}/sparkle.tar.xz" -C "${TOOLS}"`);
}

// 2. Reset Sparkle's per-app schedule state (LIVE-GATE FINDING 2026-07-14): Sparkle schedules
// checks ~24h from SULastCheckTime, so a prior gate run's state silently suppresses the fresh
// launch's automatic check — the hands-off flow then never fires and the gate false-fails.
// Delete the schedule + any skipped-version marker; deliberately KEEP SUAutomaticallyUpdate
// (the automatic-download consent) so the silent path stays enabled.
sh(`defaults delete com.winter.app SULastCheckTime 2>/dev/null || true`);
sh(`defaults delete com.winter.app SUSkippedVersion 2>/dev/null || true`);

// 3. Ephemeral test keypair (isolated Keychain account; NOT the production key/account).
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const keyFile = join(OUT, "test-eddsa.key");
sh(`"${TOOLS}/bin/generate_keys" --account ${TEST_KEY_ACCOUNT}`);
const testPub = sh(`"${TOOLS}/bin/generate_keys" --account ${TEST_KEY_ACCOUNT} -p`).trim();
sh(`"${TOOLS}/bin/generate_keys" --account ${TEST_KEY_ACCOUNT} -x "${keyFile}"`);

// 3. Build Release once.
const vCur = readCanonical();
const m = vCur.match(FORMAT)!;
const vNext = `${m[1]}.${m[2]}.${String(Number(m[3]) + 1).padStart(3, "0")}`;
sh(`xcodegen generate`, join(ROOT, "apple", "Winter"));
sh(
  `xcodebuild -project Winter.xcodeproj -scheme Winter -destination 'platform=macOS' -configuration Release -derivedDataPath "${OUT}/dd" build`,
  join(ROOT, "apple", "Winter"),
);
const builtApp = join(OUT, "dd", "Build", "Products", "Release", "Winter.app");

// 4. vCurrent and vNext test bundles: point at the local feed, bake the TEST public key,
//    bump vNext, then ad-hoc re-sign (plist edits invalidate the signature).
const patch = (app: string, version: string) => {
  const plist = join(app, "Contents", "Info.plist");
  const pb = (c: string) => sh(`/usr/libexec/PlistBuddy -c '${c}' "${plist}"`);
  pb(`Set :SUFeedURL http://localhost:${PORT}/appcast.xml`);
  pb(`Set :SUPublicEDKey ${testPub}`);
  pb(`Set :CFBundleShortVersionString ${version}`);
  pb(`Set :CFBundleVersion ${version}`);
  sh(`codesign --force --deep --sign - "${app}"`);
};
const v1App = join(OUT, "v1", "Winter.app");
const v2App = join(OUT, "v2", "Winter.app");
cpSync(builtApp, v1App, { recursive: true });
cpSync(builtApp, v2App, { recursive: true });
patch(v1App, vCur);
patch(v2App, vNext);

// 5. Zip vNext + EdDSA-sign it with the test key.
const zipName = `Winter-${vNext}.zip`;
sh(`ditto -c -k --sequesterRsrc --keepParent "${v2App}" "${join(OUT, zipName)}"`);
const sig = sh(`"${TOOLS}/bin/sign_update" -f "${keyFile}" "${join(OUT, zipName)}"`).trim();
// sign_update prints: sparkle:edSignature="..." length="..."

// 5b. Ephemeral means ephemeral: delete the test key from the Keychain now that it's been
// used to sign. The exported file under out/ (gitignored) is all that remains, and that's
// wiped by the next run's rmSync(OUT) too — nothing about this key persists.
// execSync throws synchronously on a nonzero exit (e.g. item already gone) — best-effort.
try {
  sh(`security delete-generic-password -a "${TEST_KEY_ACCOUNT}" -s "https://sparkle-project.org"`);
} catch {
  // already absent — fine, nothing to clean up.
}

// 6. Local appcast advertising vNext.
writeFileSync(
  join(OUT, "appcast.xml"),
  `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>Winter (local gate)</title>
    <item>
      <title>${vNext}</title>
      <sparkle:version>${vNext}</sparkle:version>
      <sparkle:shortVersionString>${vNext}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>26.0</sparkle:minimumSystemVersion>
      <enclosure url="http://localhost:${PORT}/${zipName}" ${sig} type="application/octet-stream"/>
    </item>
  </channel>
</rss>
`,
);

// 7. Serve + print the gate.
Bun.serve({
  port: PORT,
  fetch(req) {
    const path = new URL(req.url).pathname.slice(1) || "appcast.xml";
    const file = Bun.file(join(OUT, path));
    return file.size ? new Response(file) : new Response("not found", { status: 404 });
  },
});
console.log(`
Sparkle gate rig ready — serving http://localhost:${PORT}/appcast.xml
  vCurrent ${vCur}: ${v1App}
  vNext    ${vNext}: advertised via the local appcast

MANUAL GATE (also in docs/superpowers/notes/2026-07-15-sparkle-live-gate.md):
 1. QUIT any real Winter.app (this rig must not fight it).
 2. open "${v1App}" — menu bar appears; silent update check+download begins.
 3. Make the daemon BUSY (winter CLI: a long-running prompt) before the download settles.
 4. Watch the menu: "Update ready (${vNext}) — Restart Now" appears; app does NOT relaunch.
    *** THIS IS THE WITNESS-FIRES PROOF *** — it's the real Sparkle runtime invoking our
    shouldPostponeRelaunchForUpdate delegate hook (T4's postpone witness was silently never
    called until a review probe-compile caught it, a46a485; this step is the only
    real-runtime confirmation Sparkle actually calls it, not just that it compiles).
 5. Let the turn finish → within ~30s Winter relaunches itself as ${vNext}.
 6. Verify: menu-bar version, and \`winter\` handshake serverVersion == ${vNext} (daemon moved too).
 7. Re-run once using the Restart Now override while busy (explicit intent wins).
Ctrl-C to stop serving.
`);
