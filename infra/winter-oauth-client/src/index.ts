// Winter's OAuth Client ID Metadata Document for MCP sign-in (WS-25). The agent SDK's
// `WINTER_MCP_CLIENT_METADATA_URL` names https://yanlinglabs.com/winter/oauth-client.json and an
// authorization server that supports CIMD fetches this document to learn Winter's redirect URIs.
// The redirect is the PORTLESS loopback `http://127.0.0.1/callback`: Winter binds an ephemeral port
// per sign-in, and RFC 8252 §7.3 requires an authorization server to accept any port on a loopback IP.
// Public data only; no secrets.
import document from "./oauth-client.json";

const PATH = "/winter/oauth-client.json";
const body = JSON.stringify(document, null, 2) + "\n";

export default {
  fetch(request: Request): Response {
    const url = new URL(request.url);
    if (url.pathname !== PATH) return new Response("Not found\n", { status: 404 });
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed\n", { status: 405, headers: { allow: "GET, HEAD" } });
    }
    return new Response(request.method === "HEAD" ? null : body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=3600",
        "x-content-type-options": "nosniff",
      },
    });
  },
};
