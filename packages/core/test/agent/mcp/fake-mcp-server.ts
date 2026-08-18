// Minimal MCP stdio server for tests: initialize / notifications/initialized / tools/list (echo) / tools/call (echoes msg).
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (line) handle(JSON.parse(line));
  }
});
function send(o: unknown) { process.stdout.write(JSON.stringify(o) + "\n"); }

// Resources fixture (NORMA_FAKE_RESOURCES=1 opts a fake server instance in — off by default so
// every pre-existing test, which never sets it, sees byte-identical `capabilities`/behavior):
// one text resource, one image (a real 1x1 PNG) resource, plus an unknown-uri error path.
const TEXT_URI = "fake://greeting";
const IMAGE_URI = "fake://pixel";
const TINY_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function handle(msg: any) {
  // NORMA_FAKE_STDERR=1 makes the fake server chatty on stderr so the client's stderr->log
  // routing can be asserted. Off by default — pre-existing tests see a silent server.
  if (process.env.NORMA_FAKE_STDERR === "1") process.stderr.write("fake server noise\n");
  if (msg.method === "initialize") {
    if (process.env.NORMA_FAKE_NULL === "1") process.stdout.write("null\n");
    const capabilities: Record<string, unknown> = { tools: {} };
    if (process.env.NORMA_FAKE_RESOURCES === "1") capabilities.resources = {};
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities, serverInfo: { name: "fake", version: "1" } } });
  }
  else if (msg.method === "notifications/initialized") { /* notification, no reply */ }
  else if (msg.method === "tools/list") {
    const echoTool = { name: "echo", description: "Echo the msg back", inputSchema: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] } };
    // NORMA_FAKE_PAGES=1 splits the listing across two pages so the client's nextCursor loop is
    // exercised. Off by default — every pre-existing test sees a single unpaginated page.
    if (process.env.NORMA_FAKE_PAGES === "1") {
      if (msg.params?.cursor === undefined) {
        send({ jsonrpc: "2.0", id: msg.id, result: { tools: [echoTool], nextCursor: "p2" } });
      } else {
        const page2 = { name: "page2tool", description: "Second page", inputSchema: { type: "object" } };
        send({ jsonrpc: "2.0", id: msg.id, result: { tools: [page2] } });
      }
      return;
    }
    // NORMA_FAKE_IMAGE=1 exposes a tool whose result carries a non-text content block, so the
    // manager's attach path can be asserted. Off by default.
    if (process.env.NORMA_FAKE_IMAGE === "1") {
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "shot", description: "Returns a PNG", inputSchema: { type: "object" } }] } });
      return;
    }
    const tools = process.env.NORMA_FAKE_DUP === "1" ? [echoTool, echoTool] : [echoTool];
    send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
  }
  else if (msg.method === "tools/call") {
    if (msg.params?.name === "shot") {
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [
        { type: "text", text: "here is the shot" },
        { type: "image", data: TINY_PNG_B64, mimeType: "image/png" },
      ] } });
      return;
    }
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `echo: ${msg.params?.arguments?.msg ?? ""}` }] } });
  }
  else if (msg.method === "resources/list" && process.env.NORMA_FAKE_RESOURCES === "1") {
    send({ jsonrpc: "2.0", id: msg.id, result: { resources: [
      { uri: TEXT_URI, name: "greeting", description: "A greeting text resource", mimeType: "text/plain" },
      { uri: IMAGE_URI, name: "pixel", description: "A tiny PNG", mimeType: "image/png" },
    ] } });
  }
  else if (msg.method === "resources/read" && process.env.NORMA_FAKE_RESOURCES === "1") {
    const uri = msg.params?.uri;
    if (uri === TEXT_URI) send({ jsonrpc: "2.0", id: msg.id, result: { contents: [{ uri, mimeType: "text/plain", text: "hello from fake resource" }] } });
    else if (uri === IMAGE_URI) send({ jsonrpc: "2.0", id: msg.id, result: { contents: [{ uri, mimeType: "image/png", blob: TINY_PNG_B64 }] } });
    else send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `resource not found: ${uri}` } });
  }
  else if (typeof msg.id === "number") send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
}
