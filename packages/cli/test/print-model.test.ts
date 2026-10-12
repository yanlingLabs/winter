import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings } from "@yanlinglabs/winter-core";
import { METHODS } from "@yanlinglabs/winter-protocol";
import { WinterClient } from "../src/client";
import { PRINT_USAGE, checkPrintModelOffline, createPrintSession, parsePrintArgs, type PrintModel } from "../src/print-model";

// `winter -p --model <providerId>/<modelId>`: a one-shot model choice for the session `-p` creates.
// The pure pieces (argv parse, offline tag check) are table-tested; the daemon-facing step
// (`sync.config` list check, then `session.create`) runs against a recorded-calls fake client, the same
// double shape as cli-verb-gates.test.ts; and the bad-flag exits are proven through the real entry point
// (no daemon, no auto-launch: the flag is refused before anything connects).

const TERRA = "codex-oauth/gpt-5.6-terra";
const row = (id: string) => ({ id, providerId: id.slice(0, id.indexOf("/")), displayName: id, efforts: [] as string[] });

describe("parsePrintArgs", () => {
  test("no --model: the prompt is the first argument, exactly as -p has always read it", () => {
    expect(parsePrintArgs(["hello"])).toEqual({ kind: "ok", prompt: "hello", model: undefined });
    expect(parsePrintArgs(["hello", "--auto", "--trust"])).toEqual({ kind: "ok", prompt: "hello", model: undefined });
    expect(parsePrintArgs([])).toEqual({ kind: "ok", prompt: undefined, model: undefined });
  });

  test("--model <tag> after the prompt, before it, and as --model=<tag>", () => {
    expect(parsePrintArgs(["hello", "--model", TERRA])).toEqual({ kind: "ok", prompt: "hello", model: TERRA });
    expect(parsePrintArgs(["--model", TERRA, "hello"])).toEqual({ kind: "ok", prompt: "hello", model: TERRA });
    expect(parsePrintArgs(["hello", `--model=${TERRA}`])).toEqual({ kind: "ok", prompt: "hello", model: TERRA });
    expect(parsePrintArgs(["hello", "--plan", "--model", TERRA])).toEqual({ kind: "ok", prompt: "hello", model: TERRA });
  });

  test("a prompt that merely contains the word --model is still just the prompt", () => {
    expect(parsePrintArgs(["explain the --model flag"])).toEqual({ kind: "ok", prompt: "explain the --model flag", model: undefined });
  });

  test("--model with nothing after it is a usage error that shows the usage line", () => {
    for (const args of [["hello", "--model"], ["hello", "--model", ""], ["hello", "--model="], ["hello", "--model", "--auto"]]) {
      const r = parsePrintArgs(args);
      expect(r.kind).toBe("usageError");
      if (r.kind !== "usageError") continue;
      expect(r.message).toContain(PRINT_USAGE);
      expect(r.message).toContain("--model needs a model tag");
    }
  });

  test("--model given twice is a usage error, never last-one-wins", () => {
    const r = parsePrintArgs(["hello", "--model", TERRA, "--model=anthropic/claude-opus-5"]);
    expect(r).toMatchObject({ kind: "usageError" });
    expect(r.kind === "usageError" && r.message).toContain("only once");
  });

  test("the usage line names the flag", () => {
    expect(PRINT_USAGE).toContain("[--model <providerId>/<modelId>]");
  });
});

describe("checkPrintModelOffline — the checks that need no daemon", () => {
  test("a catalog tag passes and is a catalog row", () => {
    expect(checkPrintModelOffline(TERRA)).toEqual({ ok: true, model: { tag: TERRA, catalogRow: true } });
  });

  test("a facing name within a chosen provider resolves to its row, as the daemon does", () => {
    expect(checkPrintModelOffline("codex-oauth/terra")).toEqual({ ok: true, model: { tag: TERRA, catalogRow: true } });
  });

  test("a bare (unqualified) id is refused, naming the tag and pointing at `winter model`", () => {
    const r = checkPrintModelOffline("gpt-5.6-terra");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('--model "gpt-5.6-terra"');
    expect(r.message).toContain("provider-qualified tag");
    expect(r.message).toContain("<providerId>/<modelId>");
    expect(r.message).toContain("`winter model`");
    expect(r.message).not.toContain("\n");
  });

  test("an unknown provider is refused by name", () => {
    const r = checkPrintModelOffline("nosuch/gpt-5.6-terra");
    expect(r).toEqual({ ok: false, message: expect.stringContaining('--model "nosuch/gpt-5.6-terra": unknown provider "nosuch"') });
  });

  test("an unknown model under a real provider is refused, naming the model and the provider", () => {
    const r = checkPrintModelOffline("codex-oauth/totally-made-up-model-xyz");
    expect(r).toEqual({ ok: false, message: expect.stringContaining(`--model "codex-oauth/totally-made-up-model-xyz": unknown model 'totally-made-up-model-xyz' for provider codex-oauth`) });
  });

  test("the unstated sentinel and a winter-test double are shaped like tags but never a user's choice", () => {
    for (const tag of ["unstated/unstated", "winter-test/echo"]) {
      const r = checkPrintModelOffline(tag);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.message).toContain("provider-qualified tag");
    }
  });

  test("whitespace and a malformed tag are refused as not tag-shaped", () => {
    for (const tag of [" codex-oauth/gpt-5.6-terra", "codex-oauth/", "/gpt-5.6-terra", "codex-oauth gpt-5.6-terra"]) {
      const r = checkPrintModelOffline(tag);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.message).toContain(`--model "${tag}"`);
    }
  });

  // The daemon lets an unlisted model through for a provider with the user's own endpoint; `sync.config`
  // cannot list it, so it is accepted here too but flagged as not-a-catalog-row (the list is not asked).
  test("a provider's own endpoint (settings.providers.<id>.baseUrl) admits an unlisted model, exactly as the daemon does", () => {
    const settings = { providers: { openai: { baseUrl: "https://my-llm.example.com/v1" } } } as unknown as Settings;
    expect(checkPrintModelOffline("openai/my-custom-llm", settings)).toEqual({ ok: true, model: { tag: "openai/my-custom-llm", catalogRow: false } });
    expect(checkPrintModelOffline("openai/my-custom-llm").ok).toBe(false);
  });
});

// A recorded-calls fake: only what createPrintSession touches.
function makeClient(opts: { models?: unknown; syncConfigError?: Error } = {}) {
  const requests: Array<{ method: string; params: unknown }> = [];
  const creates: Array<{ scope: string; opts: Record<string, unknown> | undefined }> = [];
  const client = {
    request: async (method: string, params?: unknown) => {
      requests.push({ method, params });
      if (opts.syncConfigError) throw opts.syncConfigError;
      return { models: opts.models ?? [] };
    },
    createSession: async (scope: string, o?: Record<string, unknown>) => {
      creates.push({ scope, opts: o });
      return { sessionId: "s_new", trusted: true };
    },
  } as unknown as Pick<WinterClient, "request" | "createSession">;
  return { client, requests, creates };
}

const terra: PrintModel = { tag: TERRA, catalogRow: true };

describe("createPrintSession — the sync.config list check, then session.create", () => {
  test("a listed tag passes through to session.create as `model`", async () => {
    const { client, requests, creates } = makeClient({ models: [row("codex-oauth/gpt-5.6-sol"), row(TERRA)] });
    const r = await createPrintSession(client, { cwd: "/work", approvalPolicy: "auto", model: terra });
    expect(r).toEqual({ ok: true, sessionId: "s_new", trusted: true });
    expect(requests).toEqual([{ method: METHODS.syncConfig, params: {} }]);
    expect(creates).toEqual([{ scope: "global", opts: { cwd: "/work", approvalPolicy: "auto", model: TERRA } }]);
  });

  test("a tag the daemon does not list is refused typed — nothing is created", async () => {
    const { client, creates } = makeClient({ models: [row("codex-oauth/gpt-5.6-sol")] });
    const r = await createPrintSession(client, { cwd: "/work", approvalPolicy: "ask", model: terra });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain(`--model "${TERRA}"`);
    expect(r.message).toContain("not in this daemon's model list");
    expect(r.message).toContain("provider codex-oauth");
    expect(r.message).toContain("`winter model`");
    expect(r.message).not.toContain("\n");
    expect(creates).toEqual([]);
  });

  test("a daemon that offers no models at all says so, and creates nothing", async () => {
    const { client, creates } = makeClient({ models: [] });
    const r = await createPrintSession(client, { cwd: "/work", approvalPolicy: "ask", model: terra });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain("offers no models yet");
    expect(!r.ok && r.message).toContain("winter credentials set codex-oauth");
    expect(creates).toEqual([]);
  });

  test("an unreadable model list is a refusal, never a guess — nothing is created", async () => {
    for (const make of [() => makeClient({ syncConfigError: new Error("request timed out: sync.config") }), () => makeClient({ models: "nonsense" })]) {
      const { client, creates } = make();
      const r = await createPrintSession(client, { cwd: "/work", approvalPolicy: "ask", model: terra });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.message).toContain("could not read this daemon's model list");
      expect(creates).toEqual([]);
    }
  });

  test("an unlisted pass-through model (the provider's own endpoint) is not looked up, and goes to session.create", async () => {
    const { client, requests, creates } = makeClient({ models: [] });
    const byo: PrintModel = { tag: "openai/my-custom-llm", catalogRow: false };
    const r = await createPrintSession(client, { cwd: "/work", approvalPolicy: "ask", model: byo });
    expect(r.ok).toBe(true);
    expect(requests).toEqual([]);
    expect(creates[0]?.opts).toEqual({ cwd: "/work", approvalPolicy: "ask", model: "openai/my-custom-llm" });
  });

  test("without --model it is the plain create -p always made: no sync.config call, no `model` key", async () => {
    const { client, requests, creates } = makeClient();
    const r = await createPrintSession(client, { cwd: "/work", approvalPolicy: "plan" });
    expect(r).toEqual({ ok: true, sessionId: "s_new", trusted: true });
    expect(requests).toEqual([]);
    expect(creates).toEqual([{ scope: "global", opts: { cwd: "/work", approvalPolicy: "plan" } }]);
    expect(Object.keys(creates[0]!.opts!)).not.toContain("model");
  });
});

describe("WinterClient.createSession — the model rides session.create", () => {
  // The client's constructor needs a socket; the method only needs `request` and the prototype's `validated`.
  const clientRecording = (): { client: WinterClient; sent: Array<{ method: string; params: Record<string, unknown> }> } => {
    const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
    const client = Object.create(WinterClient.prototype) as WinterClient;
    (client as unknown as { request: unknown }).request = async (method: string, params: Record<string, unknown>) => {
      sent.push({ method, params });
      return { sessionId: "s_1", trusted: false };
    };
    return { client, sent };
  };

  test("`model` is sent when given and absent when not", async () => {
    const { client, sent } = clientRecording();
    await client.createSession("global", { cwd: "/work", approvalPolicy: "ask", model: TERRA });
    await client.createSession("global", { cwd: "/work", approvalPolicy: "ask" });
    expect(sent[0]).toEqual({ method: METHODS.sessionCreate, params: { scope: "global", cwd: "/work", approvalPolicy: "ask", model: TERRA } });
    expect(sent[1]).toEqual({ method: METHODS.sessionCreate, params: { scope: "global", cwd: "/work", approvalPolicy: "ask" } });
  });
});

// The real entry point. A bad `--model` is refused BEFORE `connect()` -- which would launch Winter.app on a
// down daemon -- so these need no daemon: WINTER_HOME is a fresh temp dir with no socket, and
// WINTER_NO_AUTOLAUNCH is set as a belt (a regression that connected would fail with a different message).
describe("winter -p --model — refusals through the real entry point", () => {
  const cliDir = join(import.meta.dir, "..");
  const home = mkdtempSync(join(tmpdir(), "winter-print-model-"));

  const runMain = async (...args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    const proc = Bun.spawn(["bun", "src/main.ts", ...args], {
      cwd: cliDir,
      env: { ...process.env, WINTER_HOME: home, WINTER_NO_AUTOLAUNCH: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, rawStderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    // The test preload's keychain-service override makes core print one `[keychain] ...` notice at import; it is not the CLI's output.
    const stderr = rawStderr.split("\n").filter((line) => !line.startsWith("[keychain] ")).join("\n");
    return { stdout, stderr, exitCode: await proc.exited };
  };

  test("`--model` with no tag: the usage line, exit 1", async () => {
    const r = await runMain("-p", "hello", "--model");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe(`${PRINT_USAGE} — --model needs a model tag. Run \`winter model\` to list the models you can use.\n`);
    expect(r.stdout).toBe("");
  }, 30_000);

  test("a bare id: refused naming the tag, exit 1, nothing connected", async () => {
    const r = await runMain("-p", "hello", "--model", "gpt-5.6-terra");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe('--model "gpt-5.6-terra" is not a provider-qualified tag — use "<providerId>/<modelId>". Run `winter model` to list the models you can use.\n');
    expect(r.stdout).toBe("");
  }, 30_000);

  test("an unknown model under a real provider: refused, exit 1", async () => {
    const r = await runMain("-p", "--model", "codex-oauth/totally-made-up-model-xyz", "hello");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe("--model \"codex-oauth/totally-made-up-model-xyz\": unknown model 'totally-made-up-model-xyz' for provider codex-oauth. Run `winter model` to list the models you can use.\n");
  }, 30_000);

  test("`--model <tag>` with no prompt: the usage line, exit 1 (the tag is never taken for the prompt)", async () => {
    const r = await runMain("-p", "--model", TERRA);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe(`${PRINT_USAGE}\n`);
  }, 30_000);
});
