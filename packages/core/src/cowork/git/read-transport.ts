import { Agent, request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import type { SecretStore } from "../../auth/secret-store";
import { validateGitHubReadRepository } from "./read-authority";
import type { GitReadParser } from "./read-parser-helper";
import { validateReadAdvertisement, validateUploadPackRequest, validateUploadPackResponse } from "./read-wire";
import { DEFAULT_GIT_READ_LIMITS, GitReadError, type GitReadAuthority, type GitReadCaller, type GitReadGrant, type GitReadLimits, type GitReadRequest, type GitReadResponse } from "./read-types";

/** HTTP is injectable only by the host composition (local fixture upstream in tests).
 * A guest cannot choose a URL, headers, helper, credential ref, protocol version or redirect policy. */
export type GitReadHttp = (url: string, init: RequestInit) => Promise<Response>;
/** Dedicated HTTPS agent bypasses environment/global proxy helpers and enforces TLS validation. */
export const directGitHubReadHttp: GitReadHttp = (url, init) => new Promise((resolve, reject) => {
  const agent = new Agent({ keepAlive: false, maxSockets: 1 });
  const request = httpsRequest(url, { method: init.method, headers: Object.fromEntries(new Headers(init.headers)),
    signal: init.signal ?? undefined, agent, rejectUnauthorized: true }, response => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    response.once("close", () => agent.destroy());
    try {
      const status = response.statusCode ?? 502;
      resolve(new Response([204, 205, 304].includes(status) ? null : Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>, { status, headers }));
    } catch { response.destroy(); agent.destroy(); reject(new GitReadError("upstream_failed")); }
  });
  request.once("error", () => { agent.destroy(); reject(new GitReadError("upstream_failed")); });
  if (init.body instanceof Uint8Array) request.end(init.body); else request.end();
});
export class CoworkGitHubReadTransport {
  private readonly limits: GitReadLimits;
  private readonly active = new Set<{ caller: GitReadCaller; sourceId: string; abort: () => void }>();
  constructor(private readonly authority: GitReadAuthority, private readonly secrets: Pick<SecretStore, "get">,
    private readonly http: GitReadHttp = directGitHubReadHttp, limits: Partial<GitReadLimits> = {},
    private readonly activation?: { isolatedFixture: true; parser?: GitReadParser }) {
    this.limits = { ...DEFAULT_GIT_READ_LIMITS, ...limits };
    if (!Object.values(this.limits).every(n => Number.isSafeInteger(n) && n > 0)
      || this.limits.requestBytes > 1_048_576 || this.limits.responseBytes > 67_108_864
      || this.limits.advertisementBytes > this.limits.responseBytes || this.limits.concurrent > 16
      || this.limits.durationMs > 120_000 || this.limits.recheckMs > 1_000) throw new GitReadError("invalid_request");
  }
  /** Production needs packet/pack parsing in an admitted sandboxed helper, not the credential daemon. */
  availability(): { available: false; reason: "integration_unavailable" } { return { available: false, reason: "integration_unavailable" }; }
  /** Host grant/source/worker revocation closes all matching pending reads immediately. */
  revoke(workspaceId: string, sourceId?: string): void {
    for (const call of this.active) if (call.caller.workspaceId === workspaceId && (!sourceId || call.sourceId === sourceId)) call.abort();
  }
  async read(callerInput: Readonly<GitReadCaller>, requestInput: Readonly<GitReadRequest>, signal?: AbortSignal): Promise<GitReadResponse> {
    if (this.activation?.isolatedFixture !== true) throw new GitReadError("integration_unavailable");
    // Reject before copying so an oversized request cannot allocate another oversized buffer.
    if (requestInput.body !== undefined && !(requestInput.body instanceof Uint8Array)) throw new GitReadError("invalid_request");
    if (requestInput.body && requestInput.body.length > this.limits.requestBytes) throw new GitReadError("budget_exceeded");
    const caller = { ...callerInput }, request = { ...requestInput, body: requestInput.body === undefined ? undefined : Uint8Array.from(requestInput.body) };
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(request.sourceId) || !Number.isSafeInteger(request.sourceRevision) || request.sourceRevision < 1
      || !Number.isSafeInteger(request.grantRevision) || request.grantRevision < 1
      || !["advertise", "upload-pack"].includes(request.operation) || (request.operation === "advertise" && request.body !== undefined)
      || (request.operation === "upload-pack" && (!(request.body instanceof Uint8Array) || !request.body.length))) throw new GitReadError("invalid_request");
    if (request.body && request.body.length > this.limits.requestBytes) throw new GitReadError("budget_exceeded");

    if (this.active.size >= this.limits.concurrent) throw new GitReadError("busy");
    const controller = new AbortController(); let failure: GitReadError | undefined;
    const stop = (code: GitReadError["code"]) => { failure ??= new GitReadError(code); controller.abort(); };
    const call = { caller, sourceId: request.sourceId, abort: () => stop("authority_denied") };
    this.active.add(call);
    const cancel = () => stop("cancelled"); signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    const timer = setTimeout(() => stop("budget_exceeded"), this.limits.durationMs);
    let grant: GitReadGrant | undefined;
    const recheck = () => {
      if (failure) throw failure;
      let fresh: GitReadGrant;
      try { fresh = this.authority.authorize(caller, request); } catch { throw new GitReadError("authority_denied"); }
      validateGitHubReadRepository(fresh);
      if (fresh.workspaceId !== caller.workspaceId || fresh.incarnationId !== caller.incarnationId || fresh.leaseEpoch !== caller.leaseEpoch
        || fresh.sourceId !== request.sourceId || fresh.sourceRevision !== request.sourceRevision || fresh.grantRevision !== request.grantRevision
        || (grant && JSON.stringify(fresh) !== JSON.stringify(grant))) throw new GitReadError("authority_denied");
      if (failure) throw failure;
      return fresh;
    };
    const checkTimer = setInterval(() => {
      if (!grant || failure) return;
      try { recheck(); } catch { stop("authority_denied"); }
    }, this.limits.recheckMs);
    // Bound all waits even if an injected port ignores cancellation.
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(failure ?? new GitReadError("cancelled")), { once: true });
      if (controller.signal.aborted) reject(failure);
    });
    void aborted.catch(() => {}); // A synchronous first authorization refusal may precede any raced await.
    const bounded = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, aborted]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, upstream: Response | undefined;
    try {
      grant = recheck();
      if (request.body) {
        if (this.activation.parser) await bounded(this.activation.parser.validate("request", request.body, this.limits, controller.signal));
        else validateUploadPackRequest(request.body);
        recheck();
      }
      const token = await bounded(this.secrets.get(grant.credentialRef));
      if (!token || !/^[!-~]{1,4096}$/.test(token)) throw new GitReadError("authority_denied");
      recheck();
      const advertise = request.operation === "advertise", contentType = `application/x-git-upload-pack-${advertise ? "advertisement" : "result"}`;
      const url = `https://github.com/${grant.owner}/${grant.name}.git/${advertise ? "info/refs?service=git-upload-pack" : "git-upload-pack"}`;
      const auth = Buffer.from(`x-access-token:${token}`).toString("base64");
      const response = upstream = await bounded(this.http(url, { method: advertise ? "GET" : "POST", redirect: "manual", credentials: "omit", signal: controller.signal,
        headers: { authorization: `Basic ${auth}`, accept: contentType, "accept-encoding": "identity", "user-agent": "Winter-Cowork-Git/1", ...(advertise ? {} : { "content-type": "application/x-git-upload-pack-request" }) },
        ...(advertise ? {} : { body: request.body! as BodyInit }) }));
      if (response.status !== 200 || response.redirected || (response.url && response.url !== url)
        || response.headers.get("content-type")?.split(";")[0]?.trim() !== contentType
        || ![null, "identity"].includes(response.headers.get("content-encoding"))) throw new GitReadError("upstream_failed");
      const budget = advertise ? this.limits.advertisementBytes : this.limits.responseBytes, declared = response.headers.get("content-length");
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > budget)) throw new GitReadError("budget_exceeded");
      if (!response.body) throw new GitReadError("invalid_response");
      reader = response.body.getReader(); let total = 0; const bytes = Buffer.allocUnsafe(budget);
      while (true) {
        const part = await bounded(reader.read()); if (part.done) break;
        total += part.value.byteLength; if (total > budget) throw new GitReadError("budget_exceeded");
        bytes.set(part.value, total - part.value.byteLength); recheck();
      }
      const resultBytes = bytes.subarray(0, total);
      // A credential-bearing upstream error must never become guest bytes or logs.
      if (resultBytes.includes(Buffer.from(token)) || resultBytes.includes(Buffer.from(auth))) throw new GitReadError("invalid_response");
      if (this.activation.parser) await bounded(this.activation.parser.validate(advertise ? "advertisement" : "response", resultBytes, this.limits, controller.signal));
      else if (advertise) validateReadAdvertisement(resultBytes); else await bounded(validateUploadPackResponse(resultBytes, this.limits, controller.signal));
      recheck();
      return { contentType, body: Buffer.from(resultBytes) };
    } catch (error) { throw failure ?? (error instanceof GitReadError ? error : new GitReadError("upstream_failed")); }
    finally {
      controller.abort(); void (reader ? reader.cancel() : upstream?.body?.cancel())?.catch(() => {});
      clearTimeout(timer); clearInterval(checkTimer); signal?.removeEventListener("abort", cancel); this.active.delete(call);
    }
  }
}
