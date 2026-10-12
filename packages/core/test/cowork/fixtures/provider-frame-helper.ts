/** Test-only packet helper. Parses guest bytes outside the fixture credential host.
 * No native authentication/sandbox claim; production native helper integration remains gated. */
const waiting = new Set<string>();
const MAX_REQUEST = 2 * 1024 * 1024 + 4096;
self.onmessage = event => {
  const value = event.data as { id: string; frame?: Uint8Array; response?: unknown };
  if (value.frame) {
    if (waiting.size >= 2 || !(value.frame instanceof Uint8Array) || value.frame.byteLength < 5 || value.frame.byteLength > MAX_REQUEST + 4) { postMessage({ id: value.id, error: "limit" }); return; }
    const buffer = Buffer.from(value.frame); if (buffer.readUInt32BE() !== buffer.length - 4) { postMessage({ id: value.id, error: "frame" }); return; }
    try { const request = JSON.parse(buffer.subarray(4).toString("utf8")) as unknown; waiting.add(value.id); postMessage({ id: value.id, request }); }
    catch { postMessage({ id: value.id, error: "frame" }); }
  } else if (waiting.delete(value.id)) {
    const body = Buffer.from(JSON.stringify(value.response));
    if (body.length > 256 * 1024 + 4096) { postMessage({ id: value.id, error: "limit" }); return; }
    const frame = Buffer.allocUnsafe(body.length + 4); frame.writeUInt32BE(body.length); body.copy(frame, 4); postMessage({ id: value.id, frame });
  }
};
export {};
