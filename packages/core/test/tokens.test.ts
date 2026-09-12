import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSecretStore } from "../src/auth/secret-store";
import { TokenAuthority } from "../src/auth/tokens";

function makeAuthority(): TokenAuthority {
  return new TokenAuthority(new FileSecretStore(mkdtempSync(join(tmpdir(), "winter-secrets-"))));
}

describe("TokenAuthority", () => {
  test("ensureTokens mints harness+admin tokens once and is idempotent", async () => {
    const auth = makeAuthority();
    const first = await auth.ensureTokens();
    const second = await auth.ensureTokens();
    expect(first.harness).toBe(second.harness);
    expect(first.admin).toBe(second.admin);
    expect(first.harness).not.toBe(first.admin);
    expect(first.harness.length).toBeGreaterThanOrEqual(64); // 32 random bytes hex
  });

  test("verify accepts the right token for the right role only", async () => {
    const auth = makeAuthority();
    const t = await auth.ensureTokens();
    expect(await auth.verify("harness", t.harness)).toBe(true);
    expect(await auth.verify("admin", t.admin)).toBe(true);
    expect(await auth.verify("admin", t.harness)).toBe(false);
    expect(await auth.verify("harness", "wrong")).toBe(false);
    expect(await auth.verify("plugin", t.harness)).toBe(false); // no plugin tokens in Phase 0
  });

  test("FileSecretStore writes 0600 files in a 0700 dir", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "winter-secrets-")), "inner");
    const store = new FileSecretStore(dir);
    await store.set("probe", "v");
    const { statSync } = await import("node:fs");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "probe")).mode & 0o777).toBe(0o600);
  });

  test("two authorities mint distinct tokens", async () => {
    const a = await makeAuthority().ensureTokens();
    const b = await makeAuthority().ensureTokens();
    expect(a.harness).not.toBe(b.harness);
  });
});
