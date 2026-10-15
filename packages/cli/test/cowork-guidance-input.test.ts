import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
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

const EMPTY = /^Shared guidance input is empty; pass --allow-empty to clear the guidance deliberately$/;
const NOT_REGULAR = "--content-file must name a regular file";
// The real CLI in a child with an empty private home and autolaunch off: every use here refuses before any connection.
function cli(home: string, args: string[], stdin: Uint8Array | "ignore") {
  return Bun.spawnSync({ cmd: [process.execPath, join(import.meta.dir, "../src/main.ts"), "workspace", ...args], stdin, stdout: "pipe", stderr: "pipe", timeout: 20_000,
    env: { ...process.env, WINTER_HOME: home, WINTER_NO_AUTOLAUNCH: "1", WINTER_LOGIN_SHELL_PATH: "off" } });
}
function home(): string { const directory = mkdtempSync(join(tmpdir(), "cowork-cli-guidance-home-")); directories.push(directory); return directory; }

test("file input resolves relative paths before canonical RPC and never rewrites content into argv", async () => {
  const content = "private shared guidance\n🐈\n", selected = file(content);
  const args = [...metadata, "--content-file", relative(process.cwd(), selected)], before = [...args];
  const result = await invoke(args); expect(result.connects).toBe(1); expect(result.route).toEqual(expected(content));
  expect(result.calls).toEqual([{ method: "workspace.instructions.update", params: expected(content).params }]);
  expect(args).toEqual(before); expect(args.join(" ")).not.toContain(content); expect(result.route).not.toHaveProperty("contentInput");
});

test("stdin preserves split UTF8/BOM bytes and immutable replay fields", async () => {
  const content = "\uFEFFshared 猫 🐈\n", bytes = Buffer.from(content), args = [...metadata, "--stdin"];
  expect((await invoke(args, stream(bytes, 1))).route).toEqual(expected(content));
  expect(await resolveCoworkArgs("workspace", [...metadata, "--content-file", file(content)])).toEqual(expected(content));
});

test("CRLF, lone CR and missing final newline reach the RPC byte-exact from stdin and files", async () => {
  const content = "line one\r\nline two\r\n\r\nlone\rcarriage\r\ntail", bytes = Buffer.from(content);
  for (const route of [(await invoke([...metadata, "--stdin"], stream(bytes, 1))).route, await resolveCoworkArgs("workspace", [...metadata, "--content-file", file(bytes)])] as CoworkCliRoute[]) {
    const sent = (route.params as { content: string }).content;
    expect(sent).toBe(content); expect(Buffer.from(sent).equals(bytes)).toBe(true);
  }
});

test("zero-byte stdin and files refuse unless --allow-empty; the inline empty clear and whitespace stay valid", async () => {
  const zero = () => stream(Buffer.alloc(0)), stdin = [...metadata, "--stdin"], disk = (path: string) => [...metadata, "--content-file", path];
  await expect(resolveCoworkArgs("workspace", stdin, { stdin: zero() })).rejects.toThrow(EMPTY);
  await expect(resolveCoworkArgs("workspace", disk(file("")))).rejects.toThrow(EMPTY);
  // Flag order is irrelevant and the allowance does not leak into the replay fields.
  expect((await invoke([...stdin, "--allow-empty"], zero())).route).toEqual(expected(""));
  expect((await invoke(["--allow-empty", ...stdin], zero())).route).toEqual(expected(""));
  expect(await resolveCoworkArgs("workspace", [...disk(file("")), "--allow-empty"])).toEqual(expected(""));
  expect((await invoke([...stdin, "--allow-empty"], stream(Buffer.from("kept\n")))).route).toEqual(expected("kept\n"));
  expect(await resolveCoworkArgs("workspace", [...metadata, "--content", ""])).toEqual(expected(""));
  expect((await invoke(stdin, stream(Buffer.from("\n")))).route).toEqual(expected("\n"));
});

test("an interactive stdin gets one content-free hint, only after validation and only for stdin", async () => {
  const hints: string[] = [], hint = (line: string) => { hints.push(line); }, secret = Buffer.from("PRIVATE-TTY-CONTENT");
  await resolveCoworkArgs("workspace", [...metadata, "--stdin"], { stdin: stream(secret), terminal: true, hint });
  expect(hints).toEqual(["Reading shared guidance from stdin; end with Ctrl-D."]);
  hints.length = 0;
  await resolveCoworkArgs("workspace", [...metadata, "--stdin"], { stdin: stream(secret), terminal: false, hint });
  await resolveCoworkArgs("workspace", [...metadata, "--stdin"], { stdin: stream(secret), hint }); // an injected stream is never a terminal
  await resolveCoworkArgs("workspace", [...metadata, "--content-file", file(secret)], { terminal: true, hint });
  await expect(resolveCoworkArgs("workspace", [...metadata.filter(value => value !== "stable-request"), "--stdin"], { stdin: stream(secret), terminal: true, hint })).rejects.toThrow();
  expect(hints).toEqual([]);
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
    [...metadata, "--allow-empty"], [...metadata, "--content", "PRIVATE-ARG-CONTENT", "--allow-empty"], ["list", "--allow-empty"],
    [...metadata, "--stdin", "--allow-empty", "--allow-empty"], [...metadata, "--stdin", "--allow-empty=true"],
    [...metadata.filter(value => value !== "stable-request"), "--stdin", "--allow-empty"],
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
  for (const [surface, args] of [["workspace", ["instructions", "get", "workspace", "--stdin"]], ["project", [...metadata, "--stdin"]], ["project", [...metadata, "--stdin", "--allow-empty"]],
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
  // An unreadable path reports its errno code and nothing else: never the path, never content.
  for (const [path, code] of [[join(directory, "missing"), "ENOENT"], [`${file("content")}/child`, "ENOTDIR"]] as const) {
    let error: unknown; try { await resolveCoworkArgs("workspace", [...metadata, `--content-file=${path}`]); } catch (value) { error = value; }
    expect(error).toBeInstanceOf(Error); expect((error as Error).message).toBe(`Could not read shared guidance content file (${code})`);
  }
  const broken: AsyncIterable<Uint8Array> = { async *[Symbol.asyncIterator]() { throw new Error("PRIVATE-STREAM-CONTENT"); } };
  await expect(resolveCoworkArgs("workspace", [...metadata, "--stdin"], { stdin: broken })).rejects.toThrow(/^Could not read shared guidance from stdin$/);
  const strings = Readable.from(["already decoded"]);
  await expect(resolveCoworkArgs("workspace", [...metadata, "--stdin"], { stdin: strings })).rejects.toThrow("raw bytes");
});

test("symlinks resolve like paths: a link to a regular file reads, a link to a directory or a device refuses", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cowork-cli-links-")); directories.push(directory); mkdirSync(join(directory, "folder"));
  const target = join(directory, "real.txt"), content = "linked guidance\r\n"; writeFileSync(target, content);
  symlinkSync(target, join(directory, "to-file")); symlinkSync(join(directory, "folder"), join(directory, "to-folder")); symlinkSync("/dev/zero", join(directory, "to-device"));
  expect(await resolveCoworkArgs("workspace", [...metadata, "--content-file", join(directory, "to-file")])).toEqual(expected(content));
  for (const path of [join(directory, "to-folder"), join(directory, "to-device")])
    await expect(resolveCoworkArgs("workspace", [...metadata, "--content-file", path])).rejects.toThrow(NOT_REGULAR);
});

test("a device node refuses instead of reading an endless stream", async () => {
  await expect(resolveCoworkArgs("workspace", [...metadata, "--content-file", "/dev/zero"])).rejects.toThrow(NOT_REGULAR);
});

test("the real CLI refuses a FIFO promptly instead of blocking on a writer", () => {
  const directory = home(), fifo = join(directory, "guidance.fifo"), made = Bun.spawnSync(["mkfifo", fifo]); expect(made.exitCode).toBe(0);
  const started = Date.now(), run = cli(directory, [...metadata, "--content-file", fifo], "ignore");
  expect(run.exitedDueToTimeout).toBe(false); expect(run.exitCode).toBe(1); expect(Date.now() - started).toBeLessThan(15_000);
  expect(run.stderr.toString()).toContain(NOT_REGULAR); expect(run.stdout.byteLength).toBe(0);
}, 30_000);

test("the real CLI refuses invalid, empty or conflicting stdin before connecting, writing or echoing input", () => {
  const directory = home(), marker = "PRIVATE-STDIN-MARKER";
  const cases: [string[], Uint8Array, string][] = [
    [["--stdin"], Buffer.concat([Buffer.from(marker), Buffer.from([0xff])]), "Shared guidance input is not valid UTF-8"],
    [["--stdin"], Buffer.from(`${marker}\0`), "Shared guidance input contains NUL bytes"],
    [["--stdin"], Buffer.alloc(0), "Shared guidance input is empty"],
    [["--stdin", "--content", "x"], Buffer.from(marker), "Choose exactly one of --content, --stdin or --content-file"],
    [["--stdin", "--allow-empty=true"], Buffer.from(marker), "--allow-empty does not accept a value"],
  ];
  for (const [flags, stdin, message] of cases) {
    const run = cli(directory, [...metadata, ...flags], stdin);
    expect(run.exitCode).toBe(1);
    expect(run.stderr.toString()).toContain(message); expect(run.stdout.byteLength).toBe(0);
    expect(run.stdout.toString() + run.stderr.toString()).not.toContain(marker);
    expect(readdirSync(directory)).toEqual([]);
  }
}, 30_000); // five real CLI cold starts; the 5 s default is too tight on hosted runners

test("bounded stdin captures reused chunk buffers instead of retaining producer-owned views", async () => {
  const shared = Buffer.from("first");
  const input: AsyncIterable<Uint8Array> = { async *[Symbol.asyncIterator]() { yield shared; shared.fill(90); yield shared; } };
  expect(await resolveCoworkArgs("workspace", [...metadata, "--stdin"], { stdin: input })).toEqual(expected("firstZZZZZ"));
});

test("production resolver consumes actual subprocess stdin before any client or test host exists", () => {
  const content = Buffer.from("private pipe guidance\n猫\n");
  const source = `import { resolveCoworkArgs } from ${JSON.stringify(join(import.meta.dir, "../src/cowork-cli.ts"))};
    try {
      const result = await resolveCoworkArgs('workspace', ${JSON.stringify([...metadata, "--stdin"])});
      console.log(JSON.stringify({ method: result.method, revision: result.params.expectedInstructionRevision,
        digest: result.params.expectedDigest, requestId: result.params.requestId,
        bytes: Buffer.byteLength(result.params.content, 'utf8') }));
    } catch (error) { console.error(error.message); process.exitCode = 1; }`;
  const run = (stdin: Uint8Array) => Bun.spawnSync({ cmd: [process.execPath, "--no-env-file", "--eval", source], stdin,
    stdout: "pipe", stderr: "pipe", env: { ...process.env, WINTER_LOGIN_SHELL_PATH: "off" } });
  const valid = run(content); expect(valid.exitCode).toBe(0); expect(valid.stderr.byteLength).toBe(0);
  expect(JSON.parse(valid.stdout.toString())).toEqual({ method: "workspace.instructions.update", revision: 2, digest: "a".repeat(64), requestId: "stable-request", bytes: content.length });
  expect(valid.stdout.toString()).not.toContain("private pipe guidance");
  const invalid = run(Buffer.from([255])); expect(invalid.exitCode).toBe(1); expect(invalid.stdout.byteLength).toBe(0);
  expect(invalid.stderr.toString().trim()).toBe("Shared guidance input is not valid UTF-8");
});
