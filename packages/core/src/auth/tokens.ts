import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Role } from "@yanlinglabs/winter-protocol";
import type { SecretStore } from "./secret-store";

// Remote Gateway SP1 Task 1: `remote` is the least-privileged phone-gateway principal — its token
// is minted/persisted through this SAME table-driven loop as harness/admin (Keychain in
// production via KeychainSecretStore, a 0600 file under the test WINTER_HOME via FileSecretStore),
// so a local gateway process can read `remote-token` back out exactly the way the harness reads
// `harness-token` today. No separate issuance path — deliberately.
export const TOKEN_NAMES = { harness: "harness-token", admin: "admin-token", remote: "remote-token" } as const;

export class TokenAuthority {
  constructor(private readonly store: SecretStore) {}

  async ensureTokens(): Promise<{ harness: string; admin: string; remote: string }> {
    return (await this.ensureTokensReporting()).tokens;
  }

  /** `ensureTokens`, also naming the items it had to MINT this call (WS-25 §7 B: a freshly minted item
   *  carries only the creator's access list, so the app-token ACL migration must run again for it). */
  async ensureTokensReporting(): Promise<{ tokens: { harness: string; admin: string; remote: string }; minted: string[] }> {
    const out: Record<string, string> = {};
    const minted: string[] = [];
    for (const [role, name] of Object.entries(TOKEN_NAMES)) {
      let v = await this.store.get(name);
      if (!v) {
        v = randomBytes(32).toString("hex");
        await this.store.set(name, v);
        minted.push(name);
      }
      out[role] = v;
    }
    return { tokens: out as { harness: string; admin: string; remote: string }, minted };
  }

  async verify(role: Role, token: string): Promise<boolean> {
    const name = (TOKEN_NAMES as Record<string, string | undefined>)[role];
    if (!name) return false; // plugin tokens arrive in Phase 4
    const expected = await this.store.get(name);
    if (!expected) return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(token);
    // length guard needed before timingSafeEqual; safe because all tokens are fixed-length (64 hex chars)
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
