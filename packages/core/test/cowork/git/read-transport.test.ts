import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { CoworkGitHubReadTransport, type GitReadHttp } from "../../../src/cowork/git/read-transport";
import { DEFAULT_GIT_READ_LIMITS, type GitReadCaller, type GitReadGrant, type GitReadRequest } from "../../../src/cowork/git/read-types";
import { validateUploadPackRequest, validateUploadPackResponse } from "../../../src/cowork/git/read-wire";
import { resolveGitExecutable } from "../../../src/cowork/git/executor";
import { FileSecretStore } from "../../../src/auth/secret-store";
const sentinel = "FIXTURE_GITHUB_SECRET_never_guest_7ca81f";
const caller: GitReadCaller = { workspaceId: "workspace", incarnationId: "boot", leaseEpoch: 1 };
const request: GitReadRequest = { sourceId: "source", sourceRevision: 1, grantRevision: 1, operation: "advertise" };
const grant: GitReadGrant = { ...caller, ...request, repositoryId: "123", authorityRef: "connection", authorityRevision: 1, owner: "fixture-owner", name: "fixture-repo", credentialRef: "fixture-slot", readable: true, revoked: false, configRevision: 1, scopeDigest: "host" };
const pkt = (data: string | Buffer) => { const bytes = Buffer.from(data); return Buffer.concat([Buffer.from((bytes.length + 4).toString(16).padStart(4, "0")), bytes]); };
const advertisement = Buffer.concat([pkt("# service=git-upload-pack\n"), Buffer.from("0000"), pkt(`${"1".repeat(40)} HEAD\0multi_ack side-band-64k\n`), Buffer.from("0000")]);
const response = (bytes: BodyInit | Uint8Array = advertisement, operation = "advertisement") => new Response(bytes instanceof Uint8Array ? new Uint8Array(bytes) : bytes, { headers: { "content-type": `application/x-git-upload-pack-${operation}` } });
const roots: string[] = [], stops: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const stop of stops.splice(0)) await stop(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function temp() { const root = mkdtempSync(join(tmpdir(), "winter-git-read-")); roots.push(root); return root; }
function transport(http: GitReadHttp = async () => response(), limits = {}, resolve = () => ({ ...grant })) { return new CoworkGitHubReadTransport({ authorize: resolve }, { get: async name => name === "fixture-slot" ? sentinel : null }, http, limits, { isolatedFixture: true }); }

test("production read entry refuses before credential/packet/network work until sandboxed parser admission exists", async () => {
  let touched = false;
  const t = new CoworkGitHubReadTransport({ authorize: () => { touched = true; return grant; } }, { get: async () => { touched = true; return sentinel; } }, async () => { touched = true; return response(); });
  expect(t.availability()).toEqual({ available: false, reason: "integration_unavailable" });
  await expect(t.read(caller, request)).rejects.toMatchObject({ code: "integration_unavailable" }); expect(touched).toBe(false);
});
test("only canonical host metadata determines destination/auth; guest URLs/headers are never forwarded", async () => {
  let calls = 0;
  const t = transport(async (url, init) => {
    calls++; expect(url).toBe("https://github.com/fixture-owner/fixture-repo.git/info/refs?service=git-upload-pack"); expect(init.redirect).toBe("manual"); expect(init.credentials).toBe("omit");
    expect(new Headers(init.headers).get("authorization")).toBe(`Basic ${Buffer.from(`x-access-token:${sentinel}`).toString("base64")}`); expect(new Headers(init.headers).has("git-protocol")).toBe(false); return response();
  });
  const output = await t.read(caller, { ...request, url: "https://evil.invalid", headers: { authorization: "evil" } } as GitReadRequest);
  expect(output.body).toEqual(advertisement); expect(Buffer.from(output.body).includes(Buffer.from(sentinel))).toBe(false); expect(calls).toBe(1);
  for (const name of ["../evil", "repo/elsewhere", "https://evil", ".", "..", "a?query"]) await expect(transport(undefined, {}, () => ({ ...grant, name })).read(caller, request)).rejects.toMatchObject({ code: "authority_denied" });
});
test("redirects/status/type/encoding, credential reflection and credential-bearing exceptions fail safely", async () => {
  for (const res of [new Response("", { status: 302, headers: { location: "https://evil.invalid" } }), new Response(sentinel, { status: 401 }), new Response(advertisement), new Response(advertisement, { headers: { "content-type": "application/x-git-upload-pack-advertisement", "content-encoding": "gzip" } })]) await expect(transport(async () => res).read(caller, request)).rejects.toMatchObject({ code: "upstream_failed" });
  await expect(transport(async () => response(pkt(`ERR ${sentinel}\n`))).read(caller, request)).rejects.toMatchObject({ code: "invalid_response" });
  try { await transport(async () => { throw new Error(`Authorization ${sentinel}`); }).read(caller, request); } catch (error) { expect(String(error)).toBe("GitReadError: upstream_failed"); }
});
test("body/packet/object expansion bounds reject before guest delivery", async () => {
  await expect(transport(async () => response(Buffer.alloc(300)), { advertisementBytes: 100 }).read(caller, request)).rejects.toMatchObject({ code: "budget_exceeded" });
  await expect(transport(async () => new Response("", { headers: { "content-type": "application/x-git-upload-pack-advertisement", "content-length": "100000000" } })).read(caller, request)).rejects.toMatchObject({ code: "budget_exceeded" });
  for (const bytes of [Buffer.from("ffffbad"), advertisement.subarray(0, advertisement.length - 1), Buffer.concat([pkt("# service=git-upload-pack\n"), Buffer.from("0000"), pkt(`${"1".repeat(40)} refs/heads/../evil\n`), Buffer.from("0000")]), Buffer.concat([advertisement, Buffer.from("0000")])]) await expect(transport(async () => response(bytes)).read(caller, request)).rejects.toMatchObject({ code: "invalid_response" });
  for (const line of ["command=fetch\n", "want url:https://evil\n", `want ${"1".repeat(40)} filter=blob:none\n`, `want ${"1".repeat(40)}\nshallow ${"1".repeat(40)}\n`]) expect(() => validateUploadPackRequest(Buffer.concat([pkt(line), Buffer.from("0000"), pkt("done\n")]))).toThrow();
  const header = Buffer.alloc(12); header.write("PACK"); header.writeUInt32BE(2, 4); header.writeUInt32BE(1, 8);
  const object = Buffer.concat([header, Buffer.from([0x31]), deflateSync(Buffer.from("x"))]); const pack = Buffer.concat([object, createHash("sha1").update(object).digest()]);
  await validateUploadPackResponse(Buffer.concat([pkt("NAK\n"), pack]), { ...DEFAULT_GIT_READ_LIMITS });
  await expect(validateUploadPackResponse(Buffer.concat([pkt("NAK\n"), pkt(Buffer.concat([Buffer.from([1]), pack]))]), { ...DEFAULT_GIT_READ_LIMITS })).rejects.toMatchObject({ code: "invalid_response" });
  await expect(validateUploadPackResponse(Buffer.concat([pkt(Buffer.from([2, 97])), Buffer.from("0000")]), { ...DEFAULT_GIT_READ_LIMITS })).rejects.toMatchObject({ code: "invalid_response" });
  const corrupt = Buffer.from(pack); corrupt[corrupt.length - 1]! ^= 1; await expect(validateUploadPackResponse(Buffer.concat([pkt("NAK\n"), corrupt]), { ...DEFAULT_GIT_READ_LIMITS })).rejects.toMatchObject({ code: "invalid_response" });
  const bomb = Buffer.from(pack); bomb.writeUInt32BE(100001, 8); await expect(validateUploadPackResponse(Buffer.concat([pkt("NAK\n"), bomb]), { ...DEFAULT_GIT_READ_LIMITS })).rejects.toMatchObject({ code: "budget_exceeded" });
});
test("mid-stream revoke closes the admitted read without delivering partial bytes", async () => {
  let cancelled = false, started!: () => void; const entered = new Promise<void>(resolve => { started = resolve; });
  const t = transport(async () => response(new ReadableStream({ start(controller) { controller.enqueue(advertisement.subarray(0, 10)); started(); }, cancel() { cancelled = true; } })));
  const reading = t.read(caller, request); await entered; t.revoke(caller.workspaceId, request.sourceId); await expect(reading).rejects.toMatchObject({ code: "authority_denied" }); await Bun.sleep(1); expect(cancelled).toBe(true);
});
test("stalled revision change, cancellation, duration and concurrent admission are bounded", async () => {
  let revision = 1, started!: () => void; const entered = new Promise<void>(resolve => { started = resolve; });
  const t = transport(async () => { started(); return response(new ReadableStream({})); }, { recheckMs: 5, durationMs: 100, concurrent: 1 }, () => ({ ...grant, authorityRevision: revision }));
  const reading = t.read(caller, request); await entered; await expect(t.read(caller, request)).rejects.toMatchObject({ code: "busy" }); revision++; await expect(reading).rejects.toMatchObject({ code: "authority_denied" });
  const abort = new AbortController(); const waiting = transport(async () => new Promise<Response>(() => {})).read(caller, request, abort.signal); abort.abort(); await expect(waiting).rejects.toMatchObject({ code: "cancelled" });
  await expect(transport(async () => new Promise<Response>(() => {}), { durationMs: 10 }).read(caller, request)).rejects.toMatchObject({ code: "budget_exceeded" });
});
function gitEnv(home: string): Record<string, string> { return { PATH: "/usr/bin:/bin", HOME: home, XDG_CONFIG_HOME: home, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_LFS_SKIP_SMUDGE: "1" }; }
async function git(cwd: string, home: string, args: string[], input?: Uint8Array): Promise<Buffer> {
  const child = Bun.spawn([resolveGitExecutable(), "-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", "-c", "protocol.version=0", "-c", "http.followRedirects=false", "-c", "core.fsmonitor=false", "-c", "protocol.allow=never", "-c", "protocol.http.allow=always", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd, env: gitEnv(home), stdin: input ?? "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]); if (code) throw new Error(`fixture git failed (${code}): ${stderr}`); return Buffer.from(stdout);
}
test("real Git clone + incremental fetch through private fake upstream keep credentials/helpers out of guest", async () => {
  const root = temp(), home = join(root, "home"), upstream = join(root, "upstream"), guest = join(root, "guest"); mkdirSync(home); mkdirSync(upstream);
  await git(upstream, home, ["init", "--initial-branch=main"]); writeFileSync(join(upstream, "hello.txt"), "first\n"); await git(upstream, home, ["add", "."]); await git(upstream, home, ["commit", "-m", "first"]);
  const secretStore = new FileSecretStore(join(root, "host-secrets")); await secretStore.set("fixture-slot", sentinel); let privateCalls = 0, gatewayCalls = 0;
  const fake = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (req.headers.get("authorization") !== `Basic ${Buffer.from(`x-access-token:${sentinel}`).toString("base64")}`) return new Response("no", { status: 401 }); privateCalls++; const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/fixture-owner/fixture-repo.git/info/refs" && url.search === "?service=git-upload-pack") return response(Buffer.concat([pkt("# service=git-upload-pack\n"), Buffer.from("0000"), await git(upstream, home, ["upload-pack", "--stateless-rpc", "--advertise-refs", upstream])]));
    if (req.method === "POST" && url.pathname === "/fixture-owner/fixture-repo.git/git-upload-pack") return response(await git(upstream, home, ["upload-pack", "--stateless-rpc", upstream], new Uint8Array(await req.arrayBuffer())), "result");
    return new Response("unsupported", { status: 404 });
  } }); stops.push(() => { fake.stop(true); });
  const t = new CoworkGitHubReadTransport({ authorize: () => ({ ...grant }) }, secretStore, async (url, init) => {
    expect(url.startsWith("https://github.com/fixture-owner/fixture-repo.git/")).toBe(true); const target = new URL(url); const res = await fetch(`http://127.0.0.1:${fake.port}${target.pathname}${target.search}`, init); return new Response(res.body, { status: res.status, headers: res.headers });
  }, {}, { isolatedFixture: true });
  const gateway = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const url = new URL(req.url); let operation: GitReadRequest["operation"];
    if (req.method === "GET" && url.pathname === "/source.git/info/refs" && url.search === "?service=git-upload-pack") operation = "advertise";
    else if (req.method === "POST" && url.pathname === "/source.git/git-upload-pack" && !url.search) operation = "upload-pack"; else return new Response("refused", { status: 403 }); gatewayCalls++;
    try { const result = await t.read(caller, { ...request, operation, ...(operation === "upload-pack" ? { body: new Uint8Array(await req.arrayBuffer()) } : {}) }, req.signal); return new Response(new Uint8Array(result.body), { headers: { "content-type": result.contentType, "cache-control": "no-store" } }); }
    catch (error) { return new Response(String(error), { status: 403 }); }
  } }); stops.push(() => { gateway.stop(true); });
  writeFileSync(join(home, ".gitconfig"), `[credential]\n helper = !touch ${join(root, "helper-ran")}\n[url "https://evil.invalid/"]\n insteadOf = http://127.0.0.1\n`);
  await git(root, home, ["clone", "--no-recurse-submodules", `http://127.0.0.1:${gateway.port}/source.git`, guest]); expect(readFileSync(join(guest, "hello.txt"), "utf8")).toBe("first\n");
  writeFileSync(join(upstream, "hello.txt"), "second\n"); await git(upstream, home, ["add", "."]); await git(upstream, home, ["commit", "-m", "second"]); await git(guest, home, ["fetch", "--no-recurse-submodules", "origin"]);
  expect((await git(guest, home, ["show", "origin/main:hello.txt"])).toString()).toBe("second\n"); await git(guest, home, ["fsck", "--strict"]);
  const config = readFileSync(join(guest, ".git/config"), "utf8"); expect(config).not.toContain(sentinel); expect(config).not.toContain("credential"); expect(config).not.toContain("fixture-slot"); expect(await Bun.file(join(root, "helper-ran")).exists()).toBe(false); expect(privateCalls).toBeGreaterThanOrEqual(4); expect(gatewayCalls).toBe(privateCalls);
  expect((await fetch(`http://127.0.0.1:${gateway.port}/source.git/info/refs?service=git-receive-pack`)).status).toBe(403);
}, 15_000);

test("Buffer input is an owned snapshot; caller mutation during secret lookup cannot alter validated POST", async () => {
  const original = Buffer.concat([pkt(`want ${"1".repeat(40)}\n`), Buffer.from("0000"), pkt("done\n")]);
  const expected = Uint8Array.from(original); let posted: Uint8Array | undefined;
  const t = new CoworkGitHubReadTransport({ authorize: () => ({ ...grant }) }, { get: async () => { original.fill(0x58); return sentinel; } }, async (_url, init) => {
    posted = init.body as Uint8Array; return response(pkt("NAK\n"), "result");
  }, {}, { isolatedFixture: true });
  await t.read(caller, { ...request, operation: "upload-pack", body: original });
  expect(posted).toEqual(expected); expect(original).not.toEqual(Buffer.from(expected));
});
