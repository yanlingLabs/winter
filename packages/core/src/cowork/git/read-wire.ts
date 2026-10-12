import { checkPackBudget } from "./pack-budget";
import { GitReadError, type GitReadLimits } from "./read-types";

const fail = (): never => { throw new GitReadError("invalid_response"); };
/** v0/v1 pkt-lines only. Protocol v2, partial/shallow clones and LFS are not admitted. */
function packet(data: Buffer, offset: number): { body: Buffer; next: number; flush: boolean } {
  if (offset + 4 > data.length) fail();
  const head = data.subarray(offset, offset + 4).toString("ascii");
  if (!/^[0-9a-fA-F]{4}$/.test(head)) fail();
  const length = parseInt(head, 16);
  if (length === 0) return { body: Buffer.alloc(0), next: offset + 4, flush: true };
  if (length < 4 || length > 65_520 || offset + length > data.length) fail();
  return { body: data.subarray(offset + 4, offset + length), next: offset + length, flush: false };
}
function ascii(data: Buffer): string {
  if (data.some(byte => byte > 126 || (byte < 32 && byte !== 0 && byte !== 10))) fail();
  return data.toString("ascii");
}
export function validateUploadPackRequest(body: Uint8Array): void {
  try {
    const data = Buffer.from(body), caps = /^(multi_ack|multi_ack_detailed|side-band|side-band-64k|ofs-delta|thin-pack|deepen-since|deepen-not|no-progress|include-tag|no-done|agent=[A-Za-z0-9._/-]{1,128})$/;
    let offset = 0, wants = 0, phase: "wants" | "haves" | "done" = "wants";
    while (offset < data.length) {
      const p = packet(data, offset); offset = p.next;
      if (p.flush) { if (!wants || phase === "done") fail(); phase = "haves"; continue; }
      const line = ascii(p.body).replace(/\n$/, "");
      if (phase === "wants") {
        const match = /^want ([0-9a-f]{40})(?: (.+))?$/.exec(line);
        if (!match || (wants > 0 && match[2]) || (match[2] && !match[2].split(" ").every(value => caps.test(value)))) fail();
        wants++;
      } else if (phase === "haves" && /^have [0-9a-f]{40}$/.test(line)) { /* bounded negotiation */ }
      else if (phase === "haves" && line === "done") phase = "done";
      else fail();
    }
    if (!wants || phase === "wants") fail();
  } catch { throw new GitReadError("invalid_request"); }
}
function validRef(value: string): boolean {
  if (value === "HEAD" || value === "capabilities^{}") return true;
  const ref = value.endsWith("^{}") ? value.slice(0, -3) : value;
  return ref.startsWith("refs/") && !/[~^:?*\[\\]/.test(ref) && !ref.includes("..") && !ref.includes("@{")
    && !ref.split("/").some(part => !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"));
}
export function validateReadAdvertisement(body: Uint8Array): void {
  const data = Buffer.from(body); let offset = 0, count = 0;
  const service = packet(data, offset); offset = service.next;
  if (ascii(service.body) !== "# service=git-upload-pack\n") fail();
  const delimiter = packet(data, offset); offset = delimiter.next; if (!delimiter.flush) fail();
  while (offset < data.length) {
    const p = packet(data, offset); offset = p.next;
    if (p.flush) { if (offset !== data.length) fail(); return; }
    const line = ascii(p.body).replace(/\n$/, ""), nul = line.indexOf("\0");
    if (nul >= 0 && count > 0) fail();
    const ref = nul < 0 ? line : line.slice(0, nul);
    const match = /^([0-9a-f]{40}) ([!-~]+)$/.exec(ref);
    if (!match || !validRef(match[2]!)) fail();
    if (nul >= 0 && !/^[!-~ ]+$/.test(line.slice(nul + 1))) fail();
    count++;
  }
  fail();
}
export async function validateUploadPackResponse(body: Uint8Array, limits: GitReadLimits, signal?: AbortSignal): Promise<void> {
  const data = Buffer.from(body), fragments: Buffer[] = []; let offset = 0, pack = false, terminated = false, sideband = false, acknowledgments = 0;
  while (offset < data.length) {
    if (data.subarray(offset, offset + 4).toString() === "PACK") {
      if (fragments.length || terminated || sideband) fail(); fragments.push(data.subarray(offset)); offset = data.length; pack = true; break;
    }
    const p = packet(data, offset); offset = p.next;
    if (p.flush) { if (offset !== data.length) fail(); terminated = true; continue; }
    if (terminated) fail();
    if (p.body[0] === 1) { sideband = true; fragments.push(p.body.subarray(1)); pack = true; }
    else if (p.body[0] === 2) { sideband = true; /* progress bounded by total response budget */ }
    else if (p.body[0] === 3) fail();
    else if (pack || !/^(NAK\n|ACK [0-9a-f]{40}( (continue|common|ready))?\n)$/.test(ascii(p.body))) fail();
    else acknowledgments++;
  }
  if (sideband && !terminated) fail();
  if (!pack) { if (!acknowledgments) fail(); return; } // Negotiation response, before final done.
  try { await checkPackBudget(Buffer.concat(fragments), { objects: limits.objects, expandedObjectBytes: limits.expandedObjectBytes }, signal); }
  catch (error) {
    const code = (error as { code?: string }).code;
    throw new GitReadError(code === "cancelled" ? "cancelled" : code === "object_budget" ? "budget_exceeded" : "invalid_response");
  }
}
