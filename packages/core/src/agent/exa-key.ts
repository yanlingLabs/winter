/** Keychain secret name for the Exa API key — ONE exported const shared by the daemon wiring, `winter
 *  login --exa-key` (cli/src/main.ts), the `exa` credential row (`runtime-sdk/credentials.ts`) and the
 *  `Options.web.search.authRef` locator the Winter child resolves (over `credential_resolve`) for its own
 *  `WebSearch` keyed tier and its `Search` built-in (`runtime-sdk/mode-options.ts`), so none of them can
 *  ever drift on the literal. (It lived beside the daemon's own `Search` until that tool moved into the
 *  agent SDK, 2026-10-01.) */
export const EXA_API_KEY_SECRET = "exa-api-key";
