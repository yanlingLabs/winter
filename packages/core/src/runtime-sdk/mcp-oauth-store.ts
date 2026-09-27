import { createKeychainMcpOAuthStore, type McpOAuthStore } from "@yanlinglabs/winter-agent-runtime/mcp-auth";

// WS-25: the daemon's ONE MCP OAuth token/registration store per keychain service. `refreshMcpOAuthToken`'s
// single-flight is keyed on the store OBJECT, so every caller (the refresh handler, credential_resolve, the
// status probe, the login/logout RPCs) must share this instance -- never construct a second one.
const stores = new Map<string, McpOAuthStore>();

export function daemonMcpOAuthStore(keychainService: string): McpOAuthStore {
  let store = stores.get(keychainService);
  if (store === undefined) {
    store = createKeychainMcpOAuthStore(keychainService);
    stores.set(keychainService, store);
  }
  return store;
}
