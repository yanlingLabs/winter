import { createKeychainMcpOAuthStore, type McpOAuthStore } from "@yanlinglabs/winter-agent-runtime/mcp-auth";
import { MIGRATION_SHADOW_SUFFIX } from "../auth/secret-store";

// WS-25: the daemon's ONE MCP OAuth token/registration store per keychain service. `refreshMcpOAuthToken`'s
// single-flight is keyed on the store OBJECT, so every caller (the refresh handler, credential_resolve, the
// status probe, the login/logout RPCs) must share this instance -- never construct a second one.
const stores = new Map<string, McpOAuthStore>();

export function daemonMcpOAuthStore(keychainService: string): McpOAuthStore {
  let store = stores.get(keychainService);
  if (store === undefined) {
    store = withShadowRemoval(createKeychainMcpOAuthStore(keychainService));
    stores.set(keychainService, store);
  }
  return store;
}

/** WS-27: a removed sign-in item takes its migration shadow (`<account>.migrating`, `auth/credential-acl.ts`)
 *  with it, so the next boot's shadow recovery can never bring the removed sign-in back. */
export function withShadowRemoval(base: McpOAuthStore): McpOAuthStore {
  return {
    read: (account) => base.read(account),
    write: (account, value) => base.write(account, value),
    async remove(account) {
      await base.remove(account);
      if (account.endsWith(MIGRATION_SHADOW_SUFFIX)) return;
      try { await base.remove(`${account}${MIGRATION_SHADOW_SUFFIX}`); } catch { /* none, or not ours */ }
    },
  };
}
