import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WINTER_BRAND } from "@yanlinglabs/winter-agent-sdk";
import { CanonicalHostCodeAuthority, type CanonicalHostCodePolicy } from "../../src/runtime-sdk/host-code-authority";
import { SessionStore } from "../../src/sessions/store";
import { TrustStore } from "../../src/agent/trust";
import { updateSdkSettings } from "../../src/sdk-files";
import { sdkSettingsPath } from "../../src/agent/paths";
import { authorityFileRevision, authorityRevision, advanceAuthorityRevision } from "../../src/authority-revision";
import { SettingsWatcher } from "../../src/settings-watcher";

const roots: string[] = [], stores: SessionStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function home() { const root = realpathSync(mkdtempSync(join(tmpdir(), "winter-host-authority-epochs-"))); roots.push(root); return root; }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; }
async function revokeAndRestore(getEpoch: () => unknown, change: () => void) {
  const started = deferred(), finish = deferred();
  const getPolicy = (): CanonicalHostCodePolicy => ({ config: { permissionMode: "default" }, sessionRoot: "/fixture", home: "/fixture", trustedWorkspace: true, brand: WINTER_BRAND, authorityRevision: getEpoch() });
  const authority = new CanonicalHostCodeAuthority({ getPolicy, adapter: { settingsSeed: () => ({}), create: ({ getCurrentSnapshot }) => ({
    clearReceipts() {}, recordPromptResult() {},
    async evaluate(request) { const snapshot = getCurrentSnapshot(request); started.resolve(); await finish.promise; return { status: "allow", policyRevision: snapshot.policyRevision }; },
  }) } });
  const before = authority.policyRevision();
  const pending = authority.authorize({ callId: "call", threadId: "main", name: "Bash", input: { command: "echo fixture" }, scope: { generationId: "generation", sessionId: "backend", toolUseId: "call" } }, "/fixture", new AbortController().signal);
  await started.promise; change(); finish.resolve();
  expect(await pending).toBe(false);
  expect(authority.policyRevision()).not.toBe(before);
}
test("real SessionStore policy revoke and restore invalidates an in-flight decision", async () => {
  const store = new SessionStore(home()); stores.push(store);
  const session = store.createSession("global", { approvalPolicy: "ask" });
  await revokeAndRestore(() => store.hostAuthorityRevision(session), () => { store.setApprovalPolicy(session, "plan"); store.setApprovalPolicy(session, "ask"); });
  expect(store.meta(session).approvalPolicy).toBe("ask");
});
test("real SDK permission writes revoke and restore before any authority read", async () => {
  const root = home(), path = sdkSettingsPath(root);
  updateSdkSettings(root, () => ({ permissions: { allow: ["Bash(echo *)"] } }));
  await revokeAndRestore(() => authorityFileRevision(path), () => {
    updateSdkSettings(root, () => ({ permissions: { allow: [] } }));
    updateSdkSettings(root, () => ({ permissions: { allow: ["Bash(echo *)"] } }));
  });
});
test("real TrustStore revoke and restore keeps a monotonic authority epoch", async () => {
  const root = home(), project = join(root, "project"); mkdirSync(project);
  const trust = new TrustStore(join(root, "trust.json")); trust.trust(project);
  await revokeAndRestore(() => trust.authorityRevision(), () => { trust.remove(project); trust.trust(project); });
  expect(trust.isTrusted(project)).toBe(true);
});
test("settings events invalidate authority before a debounce collapses a restored value", async () => {
  const root = home(); let fire!: () => void, applies = 0;
  const watcher = new SettingsWatcher({ path: join(root, "settings.json"), load: () => ({ allowed: true }), apply: () => { applies++; }, debounceMs: 5,
    onChangeObserved: () => advanceAuthorityRevision(root), watch: (_path, callback) => { fire = callback; return { close() {} }; } });
  watcher.start({ allowed: true });
  try {
    await revokeAndRestore(() => authorityRevision(root), () => { fire(); fire(); });
    expect(applies).toBe(0);
    await Bun.sleep(20); expect(applies).toBe(1);
  } finally { watcher.stop(); }
});
