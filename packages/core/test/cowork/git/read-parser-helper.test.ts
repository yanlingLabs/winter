import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { ConfinedGitReadParser, gitReadParserProfile, type GitReadParserConfiguration } from "../../../src/cowork/git/read-parser-helper";
import { DEFAULT_GIT_READ_LIMITS } from "../../../src/cowork/git/read-types";

import { buildGitReadParserFixture, parserFixtureCommand } from "./read-parser-fixture";
const command = (args: string[], cwd?: string) => parserFixtureCommand(root, args, cwd);
const enabled = process.platform === "darwin" && !!process.env.WINTER_GIT_READ_NODE_FIXTURE;
let root: string, config: GitReadParserConfiguration, parser: ConfinedGitReadParser;
const fixture = test.skipIf(!enabled);
const pkt = (text: string) => Buffer.from((Buffer.byteLength(text) + 4).toString(16).padStart(4, "0") + text);
const advertisement = Buffer.concat([pkt("# service=git-upload-pack\n"), Buffer.from("0000"), pkt(`${"1".repeat(40)} HEAD\0multi_ack\n`), Buffer.from("0000")]);
beforeAll(async () => {
  if (!enabled) return;
  root = mkdtempSync(join(tmpdir(), "winter-git-parser-helper-"));
  ({ config, parser } = await buildGitReadParserFixture(root));
}, 20_000);
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });
fixture("actual signed jitless helper validates exact parser and reports bounded measured RSS", async () => {
  await parser.validate("advertisement", advertisement, { ...DEFAULT_GIT_READ_LIMITS });
  await parser.validate("request", Buffer.concat([pkt(`want ${"1".repeat(40)}\n`), Buffer.from("0000"), pkt("done\n")]), { ...DEFAULT_GIT_READ_LIMITS });
  expect(parser.measurements.peakObservedRssBytes).toBeGreaterThan(0); expect(parser.measurements.peakObservedRssBytes).toBeLessThan(268_435_456);
});
fixture("real malformed packet and pack checksum/decompression/object budgets fail inside confined helper", async () => {
  await expect(parser.validate("advertisement", Buffer.from("ffffbad"), { ...DEFAULT_GIT_READ_LIMITS })).rejects.toMatchObject({ code: "invalid_response" });
  const header = Buffer.alloc(12); header.write("PACK"); header.writeUInt32BE(2, 4); header.writeUInt32BE(1, 8);
  const object = Buffer.concat([header, Buffer.from([0x31]), deflateSync(Buffer.from("x"))]); const pack = Buffer.concat([object, createHash("sha1").update(object).digest()]);
  await parser.validate("response", Buffer.concat([pkt("NAK\n"), pack]), { ...DEFAULT_GIT_READ_LIMITS });
  pack[pack.length - 1]! ^= 1;
  await expect(parser.validate("response", Buffer.concat([pkt("NAK\n"), pack]), { ...DEFAULT_GIT_READ_LIMITS })).rejects.toMatchObject({ code: "invalid_response" });
});
fixture("native helper refuses unsandboxed and weaker-network launches before runtime/input", async () => {
  expect((await command([config.launcher, config.node, config.payload], config.cwd)).code).toBe(77);
  const weaker = gitReadParserProfile(config.launcher, config.node, config.payload).replace("(deny network*)", "(allow network*)");
  const weak = await command(["/usr/bin/sandbox-exec", "-p", weaker, config.launcher, config.node, config.payload], config.cwd); expect(weak.code).toBe(77);
});
fixture("wall timeout and reactive RSS stop owned helper, with no capacity released before exit", async () => {
  const timed = await ConfinedGitReadParser.admit({ ...config, wallMs: 1, concurrent: 1 });
  await expect(timed.validate("advertisement", advertisement, { ...DEFAULT_GIT_READ_LIMITS })).rejects.toMatchObject({ code: "budget_exceeded" });
  expect(timed.measurements.uncertainStops).toBe(0);
  const measured = await ConfinedGitReadParser.admit({ ...config, rssBytes: 1_024, sampleMs: 1 });
  await expect(measured.validate("advertisement", advertisement, { ...DEFAULT_GIT_READ_LIMITS })).rejects.toMatchObject({ code: "budget_exceeded" });
  expect(measured.measurements.memoryStops).toBeGreaterThan(0); expect(measured.measurements.peakObservedRssBytes).toBeGreaterThan(1_024); expect(measured.measurements.uncertainStops).toBe(0);
});
fixture("wrong executable requirement and altered payload refuse admission without parsing", async () => {
  await expect(ConfinedGitReadParser.admit({ ...config, nodeRequirement: 'identifier "wrong"' })).rejects.toMatchObject({ code: "integration_unavailable" });
  await expect(ConfinedGitReadParser.admit({ ...config, payloadSha256: "0".repeat(64) })).rejects.toMatchObject({ code: "integration_unavailable" });
});

fixture("hard CPU limit and single parser admission hold capacity through owned termination", async () => {
  const payload = join(root, "cpu-fixture.cjs");
  writeFileSync(payload, 'process.stdout.write("WGH1\\n");process.stdin.once("data",()=>{while(true){}});process.stdin.resume();', { mode: 0o600 });
  const cpu = await ConfinedGitReadParser.admit({ ...config, payload, payloadSha256: createHash("sha256").update(readFileSync(payload)).digest("hex"), concurrent: 1, wallMs: 10_000 });
  const active = cpu.validate("advertisement", advertisement, { ...DEFAULT_GIT_READ_LIMITS });
  await expect(cpu.validate("advertisement", advertisement, { ...DEFAULT_GIT_READ_LIMITS })).rejects.toMatchObject({ code: "busy" });
  await expect(active).rejects.toMatchObject({ code: "budget_exceeded" });
  expect(cpu.measurements.wallStops).toBe(0); expect(cpu.measurements.memoryStops).toBe(0); expect(cpu.measurements.uncertainStops).toBe(0);
}, 12_000);
fixture("confined runtime actually denies sibling fixture secrets, writes, fork and network with no inherited credential env", async () => {
  const payload = join(root, "denials-fixture.cjs"), secret = join(root, "private-fixture-secret"), write = join(root, "forbidden-write");
  writeFileSync(secret, "fixture-not-a-real-secret", { mode: 0o600 });
  const source = `const fs=require("node:fs"), net=require("node:net"), cp=require("node:child_process"), crypto=require("node:crypto");
process.stdout.write("WGH1\\n");let input=[];process.stdin.on("data",d=>input.push(d));process.stdin.on("end",()=>{
let okay=!process.env.WINTER_GIT_PARSER_FAKE_SECRET && process.env.NODE_OPTIONS==="";
try{fs.readFileSync(${JSON.stringify(secret)});okay=false;}catch(e){okay=okay&&["EPERM","EACCES"].includes(e.code);}
try{fs.writeFileSync(${JSON.stringify(write)},"bad");okay=false;}catch(e){okay=okay&&["EPERM","EACCES"].includes(e.code);}
const child=cp.spawnSync("/usr/bin/true");okay=okay&&!!child.error&&["EPERM","EACCES"].includes(child.error.code);
const socket=net.createConnection({host:"127.0.0.1",port:9});socket.on("connect",()=>process.exit(78));socket.on("error",e=>{okay=okay&&["EPERM","EACCES"].includes(e.code);const bytes=Buffer.concat(input).subarray(20);let receipt=Buffer.alloc(40);receipt.write("WGR1");receipt.writeUInt32BE(okay?0:2,4);crypto.createHash("sha256").update(bytes).digest().copy(receipt,8);process.stdout.write(receipt);});});`;
  writeFileSync(payload, source, { mode: 0o600 });
  const denied = await ConfinedGitReadParser.admit({ ...config, payload, payloadSha256: createHash("sha256").update(readFileSync(payload)).digest("hex") });
  const before = process.env.WINTER_GIT_PARSER_FAKE_SECRET; process.env.WINTER_GIT_PARSER_FAKE_SECRET = "fixture-sentinel";
  try { await denied.validate("advertisement", advertisement, { ...DEFAULT_GIT_READ_LIMITS }); } finally { if (before === undefined) delete process.env.WINTER_GIT_PARSER_FAKE_SECRET; else process.env.WINTER_GIT_PARSER_FAKE_SECRET = before; }
  expect(await Bun.file(write).exists()).toBe(false);
});
fixture("unsigned-executable-memory exception fails actual helper admission", async () => {
  const node = join(root, "weaker-node"), entitlements = join(root, "weaker-entitlements.plist"); copyFileSync(config.node, node); chmodSync(node, 0o700);
  writeFileSync(entitlements, '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/></dict></plist>');
  expect((await command(["/usr/bin/codesign", "--force", "--sign", "-", "--options", "runtime", "--identifier", "com.winter.core.test-weaker-node", "--entitlements", entitlements, node])).code).toBe(0);
  await expect(ConfinedGitReadParser.admit({ ...config, node, nodeRequirement: 'identifier "com.winter.core.test-weaker-node"' })).rejects.toMatchObject({ code: "integration_unavailable" });
});
