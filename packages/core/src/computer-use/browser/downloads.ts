// ComputerV2 Phase 3 — `download(ref | { url })`: catching the file a page offers, with no save dialog and nothing in
// the user's Downloads folder, into a private staging directory (`download-paths.ts` then places it).
//
// Two capture paths:
//  - FETCH (a user's browser, over the extension's debugger): while armed, the tab's Document and Other responses pause
//    at the Response stage. A redirect or an ordinary page goes on (`Fetch.continueRequest`); the first download — a
//    `Content-Disposition: attachment`, a Document that is not HTML, or on the URL route any 2xx — is read through
//    `Fetch.takeResponseBodyAsStream` + `IO.read` into the staging file, and then failed `Aborted`, so the browser saves
//    nothing and shows nothing and the page stays. The arm is taken off (`Fetch.disable` in every session it was put
//    in) whatever happens — a forgotten arm would hold every later page of the user's tab.
//  - NATIVE (the built-in browser's own download handler, or the extension's optional `downloads` permission for a file
//    the page makes itself): the backend saves into the staging directory (or its own downloads folder) and reports
//    progress through `onDownload`.
import { closeSync, constants, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { AutomationFailure } from "../errors";
import type { TabDriver } from "./tab-driver";
import { TransportError, type CdpEvent, type CdpTransport, type TransportDownload } from "./transport";

export const DOWNLOAD_START_DEFAULT_MS = 60_000;
export const DOWNLOAD_TOTAL_MAX_MS = 10 * 60_000;
const IO_CHUNK = 1024 * 1024;

export interface CapturedFile {
  stagedPath: string;
  name: string;
  bytes: number;
  mime: string;
  /** The native route's backend id for the item (`releaseDownload`). */
  nativeId?: string;
  /** The native route: the file the backend reported (outside the staging dir for the extension's route). */
  reportedPath?: string;
  /** The native route: the address the browser says the file came from, after its redirects — the engine holds it to
   *  the dangerous-domain floor before the file is placed (the Fetch route checks every address before reading). */
  url?: string;
}

/** What a capture saw while it waited, for the sentence when nothing came. */
export interface CaptureSighting { pages: number; pageDownload?: string }

const header = (headers: unknown, name: string): string | undefined => {
  if (!Array.isArray(headers)) return undefined;
  for (const h of headers) {
    if (h !== null && typeof h === "object" && String((h as { name?: unknown }).name).toLowerCase() === name) {
      const v = (h as { value?: unknown }).value;
      return typeof v === "string" ? v : undefined;
    }
  }
  return undefined;
};

/** A `Content-Disposition` header's file name (`filename*=UTF-8''…` first, then `filename="…"`), if any. */
export function dispositionName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const star = /filename\*\s*=\s*([^;]+)/i.exec(value);
  if (star !== null) {
    const v = star[1]!.trim().replace(/^"|"$/g, "");
    const m = /^[^']*'[^']*'(.*)$/.exec(v);
    try { return decodeURIComponent(m !== null ? m[1]! : v); } catch { /* fall through */ }
  }
  const plain = /filename\s*=\s*("((?:[^"\\]|\\.)*)"|[^;]+)/i.exec(value);
  if (plain !== null) return (plain[2] !== undefined ? plain[2].replace(/\\(.)/g, "$1") : plain[1]!).trim();
  return undefined;
}

/** A URL's last path segment, decoded — the name a browser would suggest without a header. */
export function urlName(url: string): string | undefined {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter((s) => s !== "").at(-1);
    return last === undefined ? undefined : decodeURIComponent(last);
  } catch { return undefined; }
}

const mimeOf = (contentType: string | undefined): string => (contentType ?? "").split(";")[0]!.trim().toLowerCase() || "application/octet-stream";
const HTML_MIME = new Set(["text/html", "application/xhtml+xml"]);

/**
 * The Fetch capture on one tab driver. A response is the file when it is an ATTACHMENT (from any frame), or the tab's
 * own TOP-LEVEL document that says a non-HTML type — a frame's document is the page's own and is left alone, and a
 * document that names no type is left to the browser. `anyResponse`: the URL route (a temporary tab Winter navigates
 * itself) — its top-level document is the file whatever its type. `checkUrl`: the dangerous-domain floor, held to each
 * redirect of the tab's top-level document as it is paused (before the browser follows it) and to the file's own
 * address before a byte is read; the request waits paused meanwhile (a card may be up), and the wait's clock with it.
 * Chromium pauses every hop of a redirect chain under its OWN request id (measured), so a hop is checked where it is
 * seen; a frame's redirects are not (they are the page's own loads), only a frame attachment's final address.
 */
export class FetchCapture {
  private readonly armed = new Set<string>();
  private off?: () => void;
  private done = false;
  private resolveFn?: (f: CapturedFile) => void;
  private rejectFn?: (e: Error) => void;
  private readonly result: Promise<CapturedFile>;
  readonly sighting: CaptureSighting = { pages: 0 };
  private capturing = false;
  /** Set when the capture started reading (the "start" the start deadline waits for). */
  started = false;
  /** When the last bytes arrived (each `IO.read`): a slow file is alive while they keep coming. */
  lastProgress = 0;
  /** The floor is being asked about an address (a card may be up): the wait's clock stops. */
  private checking = 0;

  constructor(
    private readonly driver: TabDriver,
    private readonly o: { anyResponse: boolean; stagingDir: string; maxBytes: number; now?: () => number; checkUrl?: (url: string) => Promise<void> },
  ) {
    this.result = new Promise<CapturedFile>((resolve, reject) => { this.resolveFn = resolve; this.rejectFn = reject; });
    this.result.catch(() => undefined);
  }

  /** Turn interception on in the tab's own session and every child session the driver has attached. */
  async arm(): Promise<void> {
    const listener = (e: CdpEvent): void => {
      if (e.method === "Fetch.requestPaused") void this.onPaused(e);
      else if (e.method === "Page.downloadWillBegin" && this.sighting.pageDownload === undefined) {
        const n = (e.params as { suggestedFilename?: unknown }).suggestedFilename;
        this.sighting.pageDownload = typeof n === "string" && n.length > 0 ? n : "a file";
      } else if (e.method === "Target.attachedToTarget" && !this.done) {
        // A frame that moved into its own process mid-arm needs the arm too.
        const child = (e.params as { sessionId?: unknown }).sessionId;
        if (typeof child === "string") void this.enableIn(child);
      }
    };
    this.driver.listeners.add(listener);
    this.off = () => { this.driver.listeners.delete(listener); };
    this.driver.capturing++;
    await this.enableIn(undefined);
    for (const s of this.driver.childSessions()) await this.enableIn(s);
  }

  private async enableIn(session: string | undefined): Promise<void> {
    const key = session ?? "";
    if (this.armed.has(key)) return;
    this.armed.add(key);
    try {
      await this.driver.send("Fetch.enable", {
        patterns: [{ urlPattern: "*", requestStage: "Response", resourceType: "Document" }, { urlPattern: "*", requestStage: "Response", resourceType: "Other" }],
      }, session);
    } catch (err) {
      if (session === undefined) { this.armed.delete(key); throw err; }
      // A child that went away meanwhile: nothing to intercept there.
    }
  }

  private async onPaused(e: CdpEvent): Promise<void> {
    const p = e.params as Record<string, unknown>;
    const session = e.cdpSessionId;
    const requestId = typeof p.requestId === "string" ? p.requestId : undefined;
    if (requestId === undefined) return;
    const go = async (): Promise<void> => { try { await this.driver.send("Fetch.continueRequest", { requestId }, session); } catch { /* the request went away */ } };
    const status = typeof p.responseStatusCode === "number" ? p.responseStatusCode : undefined;
    const url = String((p.request as { url?: unknown } | undefined)?.url ?? "");
    if (this.done || this.capturing || status === undefined || p.responseErrorReason !== undefined) { await go(); return; }
    const abort = async (): Promise<void> => { try { await this.driver.send("Fetch.failRequest", { requestId, errorReason: "Aborted" }, session); } catch { /* already gone */ } };
    const topDocument = p.resourceType === "Document" && session === undefined
      && typeof p.frameId === "string" && p.frameId.length > 0 && p.frameId === this.driver.mainFrameId;
    /** The floor on one address; false (the capture failed, the request stopped) when it refuses or the run ended. */
    const floorAllows = async (u: string): Promise<boolean> => {
      if (this.o.checkUrl === undefined) return true;
      this.checking++;
      try {
        await this.o.checkUrl(u);
      } catch (err) {
        this.fail(err instanceof Error ? err : new Error(String(err)));
        await abort();
        return false;
      } finally {
        this.checking--;
      }
      if (this.done) { await abort(); return false; } // cancelled while the floor asked
      return true;
    };
    if (status >= 300 && status < 400) {
      // A redirect of the tab's own document: this hop's address is held to the floor before the browser follows it.
      if (topDocument && !(await floorAllows(url))) return;
      await go();
      return;
    }
    const headers = p.responseHeaders;
    const disposition = header(headers, "content-disposition");
    const contentType = header(headers, "content-type");
    const mime = mimeOf(contentType);
    const ok = status >= 200 && status < 300;
    const attachment = disposition !== undefined && /^\s*attachment/i.test(disposition);
    const isDownload = ok && (attachment || (topDocument && (this.o.anyResponse || (contentType !== undefined && !HTML_MIME.has(mime)))));
    if (!isDownload) {
      if (topDocument) this.sighting.pages++;
      await go();
      return;
    }
    this.capturing = true;
    if (!(await floorAllows(url))) return;
    this.started = true;
    this.lastProgress = (this.o.now ?? Date.now)();
    const name = dispositionName(disposition) ?? urlName(url) ?? "download";
    const length = Number(header(headers, "content-length"));
    try {
      if (Number.isFinite(length) && length > this.o.maxBytes) throw tooLarge(this.o.maxBytes);
      const file = await this.read(requestId, session, name, mime);
      this.finish(file);
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error(String(err)));
    } finally {
      // The browser saves nothing and shows nothing; the page stays where it was.
      await abort();
    }
  }

  private async read(requestId: string, session: string | undefined, name: string, mime: string): Promise<CapturedFile> {
    const r = await this.driver.send<{ stream?: unknown }>("Fetch.takeResponseBodyAsStream", { requestId }, session);
    const handle = typeof r.stream === "string" ? r.stream : undefined;
    if (handle === undefined) throw new Error("the browser gave no stream for the download");
    const stagedPath = join(this.o.stagingDir, "file");
    const fd = openSync(stagedPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let bytes = 0;
    try {
      for (;;) {
        if (this.done) throw new AutomationFailure("Cancelled", "the download was cancelled");
        const chunk = await this.driver.send<{ data?: unknown; base64Encoded?: unknown; eof?: unknown }>("IO.read", { handle, size: IO_CHUNK }, session);
        this.lastProgress = (this.o.now ?? Date.now)();
        const data = typeof chunk.data === "string" ? chunk.data : "";
        const buf = chunk.base64Encoded === true ? Buffer.from(data, "base64") : Buffer.from(data, "utf8");
        bytes += buf.length;
        if (bytes > this.o.maxBytes) throw tooLarge(this.o.maxBytes);
        let off = 0;
        while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
        if (chunk.eof === true) break;
        if (buf.length === 0 && data === "") throw new Error("the browser's stream stopped before the end of the file");
      }
    } finally {
      closeSync(fd);
      try { await this.driver.send("IO.close", { handle }, session); } catch { /* best effort */ }
    }
    return { stagedPath, name, bytes, mime };
  }

  private finish(f: CapturedFile): void { if (!this.done) { this.done = true; this.resolveFn?.(f); } }
  fail(e: Error): void { if (!this.done) { this.done = true; this.rejectFn?.(e); } }

  get file(): Promise<CapturedFile> { return this.result; }
  progressAt(): number { return this.lastProgress; }
  held(): boolean { return this.checking > 0; }

  /** Take the arm off everywhere it was put (always — in a `finally`). */
  async disarm(): Promise<void> {
    this.done = true;
    this.off?.();
    this.off = undefined;
    if (this.driver.capturing > 0) this.driver.capturing--;
    for (const key of [...this.armed]) {
      this.armed.delete(key);
      try { await this.driver.send("Fetch.disable", {}, key === "" ? undefined : key); } catch { /* the session went away */ }
    }
  }
}

/** The native route: the backend's own handler saves for an armed tab and reports through `onDownload`. */
export class NativeCapture {
  private off?: () => void;
  private done = false;
  private resolveFn?: (f: CapturedFile) => void;
  private rejectFn?: (e: Error) => void;
  private readonly result: Promise<CapturedFile>;
  started = false;
  /** Bytes still arriving keep a slow download alive. */
  lastProgress = 0;
  private ids = new Set<string>();
  /** The address the browser last named for the download (its final one once it is done). */
  private url?: string;

  constructor(
    private readonly transport: CdpTransport,
    private readonly tabKey: string,
    private readonly o: { dir: string; subdir: string; until: number; maxBytes: number; now: () => number },
  ) {
    this.result = new Promise<CapturedFile>((resolve, reject) => { this.resolveFn = resolve; this.rejectFn = reject; });
    this.result.catch(() => undefined);
  }

  async arm(): Promise<void> {
    const t = this.transport;
    if (t.armDownloads === undefined || t.onDownload === undefined) throw new Error("this browser can't save downloads for Winter");
    this.lastProgress = this.o.now();
    this.off = t.onDownload((tabKey, d) => { if (tabKey === this.tabKey) this.onDownload(d); });
    try {
      await t.armDownloads(this.tabKey, { dir: this.o.dir, subdir: this.o.subdir, until: this.o.until, maxBytes: this.o.maxBytes });
    } catch (err) {
      this.off();
      this.off = undefined;
      throw err;
    }
  }

  private onDownload(d: TransportDownload): void {
    if (this.done || d.state === "refused") return;
    if (this.ids.size > 0 && !this.ids.has(d.id)) return; // one download per capture: the first
    this.ids.add(d.id);
    this.started = true;
    this.lastProgress = this.o.now();
    if (typeof d.url === "string" && d.url.length > 0) this.url = d.url;
    switch (d.state) {
      case "started": case "progress":
        if (d.bytes > this.o.maxBytes || (d.totalBytes !== undefined && d.totalBytes > this.o.maxBytes)) this.fail(tooLarge(this.o.maxBytes));
        return;
      case "failed":
        this.fail(new Error(`the download of "${d.name}" failed${d.error === undefined ? "" : ` (${d.error.slice(0, 200)})`}`));
        return;
      case "done":
        if (d.path === undefined) { this.fail(new Error("the browser finished the download but said nowhere where it saved it")); return; }
        if (d.bytes > this.o.maxBytes) { this.fail(tooLarge(this.o.maxBytes)); return; }
        this.done = true;
        this.resolveFn?.({ stagedPath: d.path, reportedPath: d.path, name: d.name, bytes: d.bytes, mime: mimeOf(d.mime), nativeId: d.id, ...(this.url === undefined ? {} : { url: this.url }) });
        return;
      default:
        return;
    }
  }

  fail(e: Error): void { if (!this.done) { this.done = true; this.rejectFn?.(e); } }
  get file(): Promise<CapturedFile> { return this.result; }
  progressAt(): number { return this.lastProgress; }
  held(): boolean { return false; }
  get id(): string | undefined { return [...this.ids][0]; }

  async disarm(): Promise<void> {
    this.done = true;
    this.off?.();
    this.off = undefined;
    try { await this.transport.armDownloads?.(this.tabKey, null); } catch { /* the tab or the link went away */ }
  }
}

function tooLarge(max: number): AutomationFailure {
  return new AutomationFailure("NotAllowed", `the file is larger than ${Math.round(max / (1024 * 1024))} MiB — Winter doesn't save it`);
}

/** A `data:` URL's bytes, decoded by the daemon (no browser), with its MIME type. */
export function decodeDataUrl(url: string, maxBytes: number): { bytes: Buffer; mime: string } {
  const m = /^data:([^,]*?),(.*)$/is.exec(url);
  if (m === null) throw new AutomationFailure("NotAllowed", "that data: link is malformed");
  const meta = m[1]!;
  const base64 = /;base64$/i.test(meta);
  const mime = mimeOf(meta.replace(/;base64$/i, "").split(";")[0]);
  const body = m[2]!;
  // Before decoding: base64 is 4 characters per 3 bytes; percent-encoding at most 3 characters per byte.
  if (base64 ? Math.floor((body.length * 3) / 4) > maxBytes + 3 : body.length > maxBytes * 3) throw tooLarge(maxBytes);
  let bytes: Buffer;
  try { bytes = base64 ? Buffer.from(body, "base64") : Buffer.from(decodeURIComponent(body), "utf8"); } catch {
    throw new AutomationFailure("NotAllowed", "that data: link is malformed");
  }
  if (bytes.length > maxBytes) throw tooLarge(maxBytes);
  return { bytes, mime: mime === "application/octet-stream" && meta === "" ? "text/plain" : mime };
}

/** A capture's wait: until the file is in, the start deadline passes with nothing started, the total cap, or a cancel. */
export async function waitForCapture(
  capture: { file: Promise<CapturedFile>; started: boolean; fail(e: Error): void; progressAt?(): number; held?(): boolean },
  o: { startMs: number; totalMs: number; signal: AbortSignal; now: () => number; nothing: () => string },
): Promise<CapturedFile> {
  let t0 = o.now();
  let last = t0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const onAbort = (): void => capture.fail(new AutomationFailure("Cancelled", "the run was cancelled"));
  o.signal.addEventListener("abort", onAbort);
  if (o.signal.aborted) onAbort();
  try {
    timer = setInterval(() => {
      const now = o.now();
      // The floor is asking about the file's address (a card may be up): the clock stops while it does.
      if (capture.held?.() === true) t0 += now - last;
      last = now;
      if (capture.held?.() === true) return;
      if (!capture.started && now - t0 >= o.startMs) capture.fail(new AutomationFailure("WaitTimeout", o.nothing()));
      else if (now - t0 >= o.totalMs) capture.fail(new AutomationFailure("WaitTimeout", `the download did not finish within ${Math.round(o.totalMs / 1000)} s`));
      // Stalled: started, but no bytes for as long as a start may take (the progress of the capture that started).
      else if (capture.started && capture.progressAt !== undefined && now - capture.progressAt() >= o.startMs) capture.fail(new AutomationFailure("WaitTimeout", "the download stalled — no bytes arrived for a while"));
    }, 50);
    return await capture.file;
  } finally {
    if (timer !== undefined) clearInterval(timer);
    o.signal.removeEventListener("abort", onAbort);
  }
}

/** A transport error from a native arm, as the model reads it. */
export function nativeArmFailure(err: unknown, browserName: string): Error {
  if (err instanceof TransportError && err.code === "not_allowed") {
    return new AutomationFailure("NotAllowed", `this file is made by the page itself — to save it from ${browserName}, ask the user to allow downloads in Winter for Chrome's menu (its toolbar button)`);
  }
  return err instanceof Error ? err : new Error(String(err));
}
