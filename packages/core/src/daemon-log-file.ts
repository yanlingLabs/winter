import { closeSync, existsSync, mkdirSync, openSync, renameSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { format as formatArg } from "node:util";

/**
 * 2026-09-17 (field report, 0.114.x): the release app launches `winter-core` with stdout and stderr
 * on `/dev/null`, so every daemon line — the resolved runtime, each spawn's options, every typed
 * refusal, the child's relayed stderr — was discarded, and three incidents in one night each needed
 * a reproduction instead of a grep. The daemon now TEES both streams into
 * `<WINTER_HOME>/logs/daemon.log` itself (the directory already exists; `winter-dir.ts` creates it),
 * whoever launched it and however its stdio is wired.
 *
 *  - APPEND-only; rotation by size: past `maxBytes` the file is renamed to `daemon.log.1` (one previous
 *    generation kept, overwritten) and a fresh file opened. Rotation is checked before each write.
 *  - Tee, never redirect: the process streams keep working exactly as before (the dev daemon's
 *    terminal, a test's captured stdout).
 *  - Nothing is filtered here. The existing logging discipline (`projector/hooks.ts`'s allowlist,
 *    `describeError` = code/name only, locators never material) is what keeps secrets out of these
 *    lines; this sink only copies what would already have gone to a terminal.
 *  - Best-effort: a sink that cannot open or write never throws into the daemon — it disables itself
 *    and says so once on the original stream.
 */
export const DAEMON_LOG_FILE = "daemon.log";
export const DAEMON_LOG_MAX_BYTES = 8 * 1024 * 1024;

export interface DaemonLogFileHandle {
  readonly path: string;
  /** Uninstall the tee and close the file (tests; the daemon itself just exits). */
  close(): void;
}

export function daemonLogPathFor(home: string): string {
  return join(home, "logs", DAEMON_LOG_FILE);
}

export function installDaemonLogFile(home: string, opts: { maxBytes?: number; now?: () => Date } = {}): DaemonLogFileHandle {
  const path = daemonLogPathFor(home);
  const maxBytes = opts.maxBytes ?? DAEMON_LOG_MAX_BYTES;
  const now = opts.now ?? (() => new Date());
  let fd: number | undefined;
  let disabled = false;
  let bytes = 0;

  const open = (): void => {
    mkdirSync(join(home, "logs"), { recursive: true });
    fd = openSync(path, "a");
    bytes = existsSync(path) ? statSync(path).size : 0;
  };
  const rotate = (): void => {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
    try { renameSync(path, `${path}.1`); } catch { /* nothing to rotate */ }
    open();
  };
  const sink = (chunk: string | Uint8Array): void => {
    if (disabled) return;
    try {
      if (fd === undefined) open();
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      const line = text.endsWith("\n") ? text : `${text}\n`;
      const stamped = `${now().toISOString()} ${line}`;
      if (bytes + stamped.length > maxBytes) rotate();
      writeSync(fd!, stamped);
      bytes += stamped.length;
    } catch {
      disabled = true;
    }
  };

  // Bun's `console.*` writes to the file descriptor directly — it never passes through
  // `process.stdout.write` — so the console methods are wrapped too. Under a Node-style console
  // (which DOES call the stream) the reentrancy flag keeps a line from landing twice.
  let inConsole = false;
  const wrapConsole = (): (() => void) => {
    const names = ["log", "info", "warn", "error", "debug"] as const;
    const originals = Object.fromEntries(names.map((n) => [n, console[n].bind(console)])) as Record<(typeof names)[number], (...a: unknown[]) => void>;
    for (const n of names) {
      console[n] = ((...args: unknown[]) => {
        inConsole = true;
        try {
          sink(args.map((a) => (typeof a === "string" ? a : formatArg(a))).join(" "));
          originals[n](...args);
        } finally { inConsole = false; }
      }) as typeof console.log;
    }
    return () => { for (const n of names) console[n] = originals[n] as typeof console.log; };
  };

  const wrap = <T extends NodeJS.WriteStream>(stream: T): (() => void) => {
    const original = stream.write.bind(stream);
    // `write` has two overloads; one shim covers both — the sink sees the chunk, the original sees every argument.
    const shim = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      if (!inConsole) sink(chunk);
      return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as T["write"];
    stream.write = shim;
    return () => { stream.write = original as T["write"]; };
  };

  try { open(); } catch (err) {
    disabled = true;
    process.stderr.write(`daemon log: could not open ${path} (${err instanceof Error ? err.name : "unknown"}) — logging to the terminal only\n`);
  }
  const restoreOut = wrap(process.stdout);
  const restoreErr = wrap(process.stderr);
  const restoreConsole = wrapConsole();
  return {
    path,
    close() {
      restoreConsole(); restoreOut(); restoreErr();
      if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } fd = undefined; }
    },
  };
}
