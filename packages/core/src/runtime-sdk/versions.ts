import { SDK_VERSION } from "@yanlinglabs/winter-agent-sdk";

/** The exact peer versions this daemon was written against (P8b-3). The ^ ranges in package.json
 *  are what INSTALLS; these are what the tests PROVE installed. Bump together with the pins. */
export const REQUIRED_WINTER_AGENT_SDK = "0.0.4";
export const REQUIRED_WINTER_RUNTIME_SDK = "0.0.2";

/** Host-declared peer versions (router 0.0.2 consults these FIRST — the only answer that works
 *  inside a compiled $bunfs binary, where createRequire cannot resolve a manifest). P8b-4. */
export const NORMA_PEER_VERSIONS: { winterAgentSdk: string } = { winterAgentSdk: SDK_VERSION };
