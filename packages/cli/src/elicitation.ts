import { METHODS } from "@yanlinglabs/winter-protocol";

// WS-27: an MCP server's URL-mode elicitation ("open this link") on the terminal. The card carries the
// link's host only — the url may carry a one-time code, so it is fetched (`elicitation.url`) only when
// the user chooses to open it, checked here, opened with `/usr/bin/open`, and never printed or logged.

/** The link a card may open, or `undefined`: https only, no credentials before the host, and the host
 *  (with its port, if any) exactly the one the card showed. */
export function elicitationUrlToOpen(raw: unknown, host: string): string | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return undefined; }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") return undefined;
  if (parsed.host.toLowerCase() !== host.toLowerCase()) return undefined;
  return parsed.href;
}

/** The one line `winter -p` (and the plain, non-TUI shell) prints when it declines a card (it never opens links). Host only. */
export function elicitationDeclinedLine(serverName: string, host: string): string {
  return `link request from ${serverName} (${host}) declined — this shell never opens links (use the Winter app or the interactive winter)`;
}

/** `winter -p`'s whole handling of a card: print the one line, answer `decline` at once. `request`
 *  is the connection's JSON-RPC door; its failure is swallowed (the card's own timeout still ends it). */
export function declineElicitationHeadless(
  e: { elicitationId: string; serverName: string; host: string },
  sessionId: string,
  doors: { emitLine(line: string): void; request(method: string, params: unknown): Promise<unknown> },
): void {
  doors.emitLine(elicitationDeclinedLine(e.serverName, e.host));
  void doors.request(METHODS.elicitationRespond, { sessionId, elicitationId: e.elicitationId, action: "decline" }).catch(() => {});
}

export interface HeadlessCardEvent { type: string; seq: number; threadId?: string; elicitationId?: string; serverName?: string; host?: string }

/** Which cards `winter -p` (and the plain shell) may decline: only those raised during a turn THIS
 *  shell started — never one it merely sees (a card the user may be answering on the Mac, in a turn the
 *  Mac started, must not be declined by `winter resume <id> "text"` attaching to the same session).
 *  A turn is this shell's when its main `turn_started` follows this shell's own `user_message` (its
 *  seq, from `session.send`); it stays so until that turn's `turn_completed`. Events that arrive while
 *  the send is still in flight are held and judged once its seq is known. Pure: `observe` returns the
 *  cards to decline now. */
export class HeadlessElicitationGate {
  private ownSince: number | undefined;
  private ownTurnActive = false;
  private sending = false;
  private held: HeadlessCardEvent[] = [];

  /** Call just before `session.send`. */
  beginSend(): void { this.sending = true; }

  /** `session.send` answered with the seq of this shell's own `user_message`. */
  sent(seq: number): HeadlessCardEvent[] {
    this.sending = false;
    this.ownSince = seq;
    this.ownTurnActive = false;
    const held = this.held;
    this.held = [];
    return held.flatMap((e) => this.observe(e));
  }

  observe(e: HeadlessCardEvent): HeadlessCardEvent[] {
    const onMain = e.threadId === undefined || e.threadId === "main";
    if (!onMain || (e.type !== "turn_started" && e.type !== "turn_completed" && e.type !== "elicitation_requested")) return [];
    if (this.sending) { this.held.push(e); return []; }
    if (e.type === "turn_started") {
      if (this.ownSince !== undefined && e.seq > this.ownSince) this.ownTurnActive = true;
      return [];
    }
    if (e.type === "turn_completed") {
      if (this.ownTurnActive) { this.ownTurnActive = false; this.ownSince = undefined; }
      return [];
    }
    return this.ownTurnActive ? [e] : [];
  }
}

/** Opens a link in the browser: `/usr/bin/open <url>` as an argv array — never a shell. */
export async function openInBrowser(
  url: string,
  spawn: (argv: string[]) => { exited: Promise<number> } = (argv) => Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" }),
): Promise<boolean> {
  try {
    return (await spawn(["/usr/bin/open", url]).exited) === 0;
  } catch {
    return false;
  }
}

export interface ElicitationDoors {
  /** `elicitation.url` — rejects once the card is no longer active. */
  fetchUrl(): Promise<unknown>;
  /** `elicitation.respond` — resolves `alreadyResolved`. */
  respond(accept: boolean): Promise<boolean>;
  open(url: string): Promise<boolean>;
}

/** What answering a card did — the TUI turns each into a note (host only, never the url). */
export type ElicitationAnswer = "opened" | "declined" | "inactive" | "mismatch" | "open-failed" | "send-failed";

/** Open: fetch the url, check it against the card's host, open it, and only then accept — a link
 *  that would not open is never reported as accepted. Decline: only tells the daemon. */
export async function answerElicitation(accept: boolean, host: string, doors: ElicitationDoors): Promise<ElicitationAnswer> {
  if (accept) {
    let raw: unknown;
    try { raw = await doors.fetchUrl(); } catch { return "inactive"; }
    const url = elicitationUrlToOpen(raw, host);
    if (url === undefined) return "mismatch";
    if (!(await doors.open(url))) return "open-failed";
  }
  try {
    const alreadyResolved = await doors.respond(accept);
    if (alreadyResolved) return "inactive";
  } catch {
    return "send-failed";
  }
  return accept ? "opened" : "declined";
}

/** The note each outcome leaves in the transcript. */
export function elicitationAnswerNote(answer: ElicitationAnswer, host: string): string | undefined {
  switch (answer) {
    case "opened": return undefined; // the daemon's elicitation_resolved note says it
    case "declined": return undefined;
    case "inactive": return `link request (${host}) is no longer active`;
    case "mismatch": return `link request (${host}): the link did not match ${host} — not opened`;
    case "open-failed": return `link request (${host}): couldn't open the browser — try again`;
    case "send-failed": return `link request (${host}): couldn't send the answer — try again`;
  }
}
