import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Readable } from "node:stream";
import { COWORK_INSTRUCTION_MAX_BYTES, type CoworkMethod, type CoworkParams, type CoworkResult } from "@yanlinglabs/winter-protocol";
import { parseCoworkArgs, resolveCoworkArgs, runCoworkRoute, type CoworkCliRoute } from "../src/cowork-cli";
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const metadata = ["instructions", "update", "workspace", "--instruction-revision", "2", "--digest", "a".repeat(64), "--request-id", "stable-request"];
const expected = (content: string) => ({ method: "workspace.instructions.update" as const, params: { workspaceId: "workspace", expectedInstructionRevision: 2, expectedDigest: "a".repeat(64), requestId: "stable-request", content }, json: false });
function file(bytes: Uint8Array | string): string {
  const directory = mkdtempSync(join(tmpdir(), "cowork-cli-guidance-")); directories.push(directory);
  const path = join(directory, "guidance.txt"); writeFileSync(path, bytes); return path;
}
function stream(bytes: Uint8Array, slice = bytes.length || 1): AsyncIterable<Uint8Array> {
  return Readable.from((function* () { for (let at = 0; at < bytes.length; at += slice) yield bytes.subarray(at, at + slice); })());
}
async function invoke(args: string[], stdin?: AsyncIterable<Uint8Array>) {
  let connects = 0; const calls: { method: string; params: unknown }[] = [];
  const route = await resolveCoworkArgs("workspace", args, { stdin });
  if ("help" in route) return { connects, calls, route };
  connects++;
  await runCoworkRoute({ async cowork<M extends CoworkMethod>(method: M, params: CoworkParams<M>): Promise<CoworkResult<M>> {
    calls.push({ method, params }); return {} as CoworkResult<M>;
  } }, route);
  return { connects, calls, route };
}

test("file input resolves relative paths before canonical RPC and never rewrites content into argv", async () => {
  const content = "private shared guidance\n🐈\n", selected = file(content);
  const args = [...metadata, "--content-file", relative(process.cwd(), selected)], before = [...args];
  const result = await invoke(args); expect(result.connects).toBe(1); expect(result.route).toEqual(expected(content));
  expect(result.calls).toEqual([{ method: "workspace.instructions.update", params: expected(content).params }]);
  expect(args).toEqual(before); expect(args.join(" ")).not.toContain(content); expect(result.route).not.toHaveProperty("contentInput");
});

test("stdin preserves split UTF8/BOM bytes, EOF-empty guidance and immutable replay fields", async () => {
  const content = "\uFEFFshared 猫 🐈\n", bytes = Buffer.from(content), args = [...metadata, "--stdin"];
  expect((await invoke(args, stream(bytes, 1))).route).toEqual(expected(content));
  expect((await invoke(args, stream(Buffer.alloc(0)))).route).toEqual(expected(""));
  expect(await resolveCoworkArgs("workspace", [...metadata, "--content-file", file(content)])).toEqual(expected(content));
});

test("metadata, exclusive options and extras refuse before any stdin read or connection", async () => {
  let reads = 0, connects = 0;
  const stdin: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]() { reads++; throw new Error("must not read input"); } };
  const invalid = [
    [...metadata, "--stdin", "--content", "PRIVATE-ARG-CONTENT"], [...metadata, "--stdin", "--content-file", "/missing"],
    [...metadata, "--content-file", "/missing", "--content", "PRIVATE-ARG-CONTENT"], [...metadata, "--stdin", "--stdin"],
    [...metadata, "--stdin=true"], [...metadata, "--content-file"], [...metadata, "--stdin", "unexpected"],
    [...metadata, "--stdin", "--unknown", "value"],
    [...metadata.filter(value => value !== "stable-request"), "--stdin"],
    [...metadata.map(value => value === "2" ? "0" : value), "--stdin"],
    [...metadata.map(value => value === "a".repeat(64) ? "bad-digest" : value), "--stdin"],
  ];
  for (const args of invalid) {
    let error: unknown;
    try { const route = await resolveCoworkArgs("workspace", args, { stdin }); if (!("help" in route)) connects++; }
    catch (value) { error = value; }
    expect(error).toBeInstanceOf(Error); expect(String(error)).not.toContain("PRIVATE-ARG-CONTENT");
  }
  expect(reads).toBe(0); expect(connects).toBe(0);
});

test("only instructions update accepts input modes; normal argv/help parsing remains unchanged", async () => {
  for (const [surface, args] of [["workspace", ["instructions", "get", "workspace", "--stdin"]], ["project", [...metadata, "--stdin"]],
    ["workspace", ["update", "workspace", "--content-file", "/missing"]]] as const) {
    await expect(resolveCoworkArgs(surface, [...args])).rejects.toThrow("only supported");
  }
  for (const args of [[], ["list", "--json"], ["--help"], ["-h"], ["help"], [...metadata, "--content", "legacy text"], [...metadata, "--content=--stdin"]]) {
    expect(await resolveCoworkArgs("workspace", args)).toEqual(parseCoworkArgs("workspace", args));
  }
});

test("malformed UTF8, NUL and byte overflow from file/stdin refuse without content diagnostics", async () => {
  const inputs = [Buffer.from([0xc0, 0xaf]), Buffer.from("SECRET\0BODY"), Buffer.alloc(COWORK_INSTRUCTION_MAX_BYTES + 1, 65)];
  for (const bytes of inputs) {
    for (const pending of [resolveCoworkArgs("workspace", [...metadata, "--stdin"], { stdin: stream(bytes, 3) }),
      resolveCoworkArgs("workspace", [...metadata, "--content-file", file(bytes)])]) {
      let error: unknown; try { await pending; } catch (value) { error = value; }
      expect(error).toBeInstanceOf(Error); expect(String(error)).not.toContain("SECRET"); expect(String(error)).not.toContain("BODY");
    }
  }
  const maximum = Buffer.alloc(COWORK_INSTRUCTION_MAX_BYTES, 65);
  expect((await resolveCoworkArgs("workspace", [...metadata, "--stdin"], { stdin: stream(maximum, 17) }) as CoworkCliRoute).params).toMatchObject({ content: maximum.toString() });
  expect((await resolveCoworkArgs("workspace", [...metadata, "--content-file", file(maximum)]) as CoworkCliRoute).params).toMatchObject({ content: maximum.toString() });
});

test("file path and stdin failures stay closed before RPC, with no underlying private text", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cowork-cli-errors-")); directories.push(directory); mkdirSync(join(directory, "not-file"));
  for (const path of ["", join(directory, "missing"), join(directory, "not-file"), `${file("content")}/`, "bad\0path"])
    await expect(resolveCoworkArgs("workspace", [...metadata, `--content-file=${path}`])).rejects.toThrow();
  const broken: AsyncIterable<Uint8Array> = { async *[Symbol.asyncIterator]() { throw new Error("PRIVATE-STREAM-CONTENT"); } };
  await expect(resolveCoworkArgs("workspace", [...metadata, "--stdin"], { stdin: broken })).rejects.toThrow(/^Could not read shared guidance from stdin$/);
  const strings = Readable.from(["already decoded"]);
  await expect(resolveCoworkArgs("workspace", [...metadata, "--stdin"], { stdin: strings })).rejects.toThrow("raw bytes");
});

test("bounded stdin captures reused chunk buffers instead of retaining producer-owned views", async () => {
  const shared = Buffer.from("first");
  const input: AsyncIterable<Uint8Array> = { async *[Symbol.asyncIterator]() { yield shared; shared.fill(90); yield shared; } };
  expect(await resolveCoworkArgs("workspace", [...metadata, "--stdin"], { stdin: input })).toEqual(expected("firstZZZZZ"));
});

test("production resolver consumes actual subprocess stdin before any client or test host exists", () => {
  const content = Buffer.from("private pipe guidance\n猫\n");
  const source = `import { resolveCoworkArgs } from './src/cowork-cli.ts';
    try {
      const result = await resolveCoworkArgs('workspace', ${JSON.stringify([...metadata, "--stdin"])});
      console.log(JSON.stringify({ method: result.method, revision: result.params.expectedInstructionRevision,
        digest: result.params.expectedDigest, requestId: result.params.requestId,
        bytes: Buffer.byteLength(result.params.content, 'utf8') }));
    } catch (error) { console.error(error.message); process.exitCode = 1; }`;
  const run = (stdin: Uint8Array) => Bun.spawnSync({ cmd: [process.execPath, "--no-env-file", "--eval", source], cwd: process.cwd(), stdin,
    stdout: "pipe", stderr: "pipe", env: { WINTER_LOGIN_SHELL_PATH: "off" } });
  const valid = run(content); expect(valid.exitCode).toBe(0); expect(valid.stderr.byteLength).toBe(0);
  expect(JSON.parse(valid.stdout.toString())).toEqual({ method: "workspace.instructions.update", revision: 2, digest: "a".repeat(64), requestId: "stable-request", bytes: content.length });
  expect(valid.stdout.toString()).not.toContain("private pipe guidance");
  const invalid = run(Buffer.from([255])); expect(invalid.exitCode).toBe(1); expect(invalid.stdout.byteLength).toBe(0);
  expect(invalid.stderr.toString().trim()).toBe("Shared guidance input is not valid UTF-8");
});
