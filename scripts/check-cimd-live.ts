// WS-25 (MCP OAuth, security review M4): is the Client ID Metadata Document an authorization server fetches
// for Winter the one this repository says it is?
//
//   bun run scripts/check-cimd-live.ts
//
// The agent SDK's `WINTER_MCP_CLIENT_METADATA_URL` names https://yanlinglabs.com/winter/oauth-client.json as
// Winter's OAuth client_id; an authorization server that supports CIMD reads the redirect URIs Winter may use
// from THAT document. It is served by the Cloudflare Worker in `infra/winter-oauth-client/`, from the committed
// `src/oauth-client.json`. A drift between the two -- a stale deploy, a hand edit on the zone, a hijacked route
// -- would change where an authorization server lets Winter's sign-ins land, so this compares them: the live
// document must DEEP-EQUAL the committed one, and its `client_id` must be the URL it is served from (the CIMD
// rule an authorization server checks too).
//
// It touches the network, so ordinary CI never runs it: `.github/workflows/cimd-live.yml` runs it on a
// schedule and on demand. The comparison itself is pure (`cimdProblems`) and tested offline
// (`check-cimd-live.test.ts`).
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const CIMD_URL = "https://yanlinglabs.com/winter/oauth-client.json";
export const CIMD_SOURCE = join(import.meta.dir, "..", "infra", "winter-oauth-client", "src", "oauth-client.json");

/** Everything wrong with `live` against `committed` (empty = they agree). Never throws. */
export function cimdProblems(live: unknown, committed: unknown, url: string = CIMD_URL): string[] {
  const problems: string[] = [];
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObject(committed)) return ["the committed document is not a JSON object"];
  if (committed.client_id !== url) problems.push(`the committed document's client_id is ${JSON.stringify(committed.client_id)}, not ${url}`);
  if (!isObject(live)) return [...problems, "the live document is not a JSON object"];
  if (live.client_id !== url) problems.push(`the live document's client_id is ${JSON.stringify(live.client_id)}, not ${url}`);
  if (!Bun.deepEquals(live, committed, true)) {
    const keys = [...new Set([...Object.keys(live), ...Object.keys(committed)])].sort();
    const differing = keys.filter((k) => !Bun.deepEquals(live[k], committed[k], true));
    problems.push(`the live document differs from the committed one${differing.length > 0 ? ` at: ${differing.join(", ")}` : ""}`);
  }
  return problems;
}

async function main(): Promise<number> {
  const committed: unknown = JSON.parse(readFileSync(CIMD_SOURCE, "utf8"));
  let response: Response;
  try {
    // No redirects: the document must be served AT its client_id.
    response = await fetch(CIMD_URL, { redirect: "error", signal: AbortSignal.timeout(15_000), headers: { accept: "application/json" } });
  } catch (err) {
    console.error(`check-cimd-live: fetching ${CIMD_URL} failed (${err instanceof Error ? err.message : String(err)})`);
    return 1;
  }
  if (response.status !== 200) {
    console.error(`check-cimd-live: ${CIMD_URL} answered HTTP ${response.status}`);
    return 1;
  }
  const type = response.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) {
    console.error(`check-cimd-live: ${CIMD_URL} is served as ${JSON.stringify(type)}, not application/json`);
    return 1;
  }
  let live: unknown;
  try {
    live = JSON.parse(await response.text());
  } catch {
    console.error(`check-cimd-live: ${CIMD_URL} is not valid JSON`);
    return 1;
  }
  const problems = cimdProblems(live, committed);
  for (const p of problems) console.error(`check-cimd-live: ${p}`);
  if (problems.length > 0) return 1;
  console.log(`check-cimd-live: OK — ${CIMD_URL} matches infra/winter-oauth-client/src/oauth-client.json`);
  return 0;
}

if (import.meta.main) process.exit(await main());
