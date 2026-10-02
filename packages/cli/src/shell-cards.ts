// The plain shell's (`winter -p`, the legacy chat loop) cards, ONE AT A TIME.
//
// Since agent SDK 0.0.40 a session can hold several open cards at once (two subagents running side by side,
// a `Computer` and a `Browser` call in their own lanes). The shell has one stdin, so it shows one card: an
// approval's `[y/N]` prompt is printed only when that approval is the one being answered, and a question's
// or plan's read loop starts only when the card before it is done -- never two stdin readers at once, and a
// typed answer always goes to the card whose prompt is on screen. A card resolved elsewhere (another
// window, a broker timeout) leaves the queue; if it was the one on screen, the next card takes its place --
// an approval at once; a question or plan once its pending line is read (its `run` is handed a signal that
// aborts, and stops asking and answering), with a note telling the user to press Enter.
//
// Pure of process state: `main.ts` hands it the writer, the RPC and the raw key listener's suspend/resume.

export interface ShellCardDeps {
  /** Writes to the terminal (the caller's tracked `emit`). */
  emit(text: string): void;
  /** Answers an approval (`approval.respond`). */
  respond(callId: string, approved: boolean): Promise<unknown>;
  /** The raw key listener yields stdin to the cooked approval reader while an approval is on screen. */
  suspendKeys(): void;
  resumeKeys(): void;
  /** A failed answer RPC (never thrown: the shell keeps running). */
  onError?(err: unknown): void;
  /** Dims a line (ANSI), e.g. the "answered elsewhere" note. */
  dim?(text: string): string;
}

type Card =
  | { kind: "approval"; callId: string; prompt: string }
  | { kind: "interactive"; callId: string; run: (signal: AbortSignal) => Promise<void>; abort: AbortController };

export class ShellCardQueue {
  private readonly waiting: Card[] = [];
  private active: Card | undefined;
  /** The active approval's answer is being sent: a second line must not answer it again. */
  private answering = false;

  constructor(private readonly deps: ShellCardDeps) {}

  /** An approval card: its prompt is printed when it reaches the front. A card already held is ignored. */
  raiseApproval(callId: string, prompt: string): void {
    if (this.holds(callId)) return;
    this.waiting.push({ kind: "approval", callId, prompt });
    this.pump();
  }

  /** A question or plan card: `run` (its own prompts and read loop) starts when it reaches the front. Its
   *  signal aborts when the card is resolved elsewhere while on screen: `run` must check it after each line it
   *  reads, stop asking, and send no answer. */
  raiseInteractive(callId: string, run: (signal: AbortSignal) => Promise<void>): void {
    if (this.holds(callId)) return;
    this.waiting.push({ kind: "interactive", callId, run, abort: new AbortController() });
    this.pump();
  }

  /** The card was resolved (here or elsewhere): a waiting one is dropped; the one on screen gives way. */
  resolved(callId: string): void {
    const at = this.waiting.findIndex((c) => c.callId === callId);
    if (at !== -1) {
      this.waiting.splice(at, 1);
      return;
    }
    const active = this.active;
    if (active === undefined || active.callId !== callId) return;
    if (active.kind === "approval" && !this.answering) {
      this.deps.emit(`\n${this.dimmed("(answered elsewhere)")}\n`);
      this.finish(active);
      return;
    }
    // A question or plan on screen: its read loop is waiting for a line. It stops at that line (the signal)
    // and the next card takes its place -- the user is told to press Enter.
    if (active.kind === "interactive" && !active.abort.signal.aborted) {
      active.abort.abort();
      this.deps.emit(`\n${this.dimmed("(answered elsewhere — press Enter to continue)")}\n`);
    }
  }

  /** Whether a typed line answers the approval on screen (checked synchronously by the stdin reader). */
  get awaitingApproval(): boolean {
    return this.active?.kind === "approval" && !this.answering;
  }

  /** The callIds held (on screen first, then waiting) -- for tests and diagnostics. */
  get held(): string[] {
    return [...(this.active !== undefined ? [this.active.callId] : []), ...this.waiting.map((c) => c.callId)];
  }

  /** Answer the approval on screen with a typed line ("y" allows; anything else denies). */
  async answerApproval(line: string): Promise<boolean> {
    const active = this.active;
    if (active?.kind !== "approval" || this.answering) return false;
    this.answering = true;
    try {
      await this.deps.respond(active.callId, line.trim().toLowerCase() === "y");
    } catch (err) {
      this.deps.onError?.(err);
    } finally {
      this.answering = false;
      this.finish(active);
    }
    return true;
  }

  private holds(callId: string): boolean {
    return this.active?.callId === callId || this.waiting.some((c) => c.callId === callId);
  }

  private pump(): void {
    if (this.active !== undefined) return;
    const next = this.waiting.shift();
    if (next === undefined) return;
    this.active = next;
    if (next.kind === "approval") {
      this.deps.suspendKeys();
      this.deps.emit(next.prompt);
      return;
    }
    void next.run(next.abort.signal).catch((err: unknown) => this.deps.onError?.(err)).finally(() => this.finish(next));
  }

  private finish(card: Card): void {
    if (this.active !== card) return;
    this.active = undefined;
    if (card.kind === "approval") this.deps.resumeKeys();
    this.pump();
  }

  private dimmed(text: string): string {
    return this.deps.dim !== undefined ? this.deps.dim(text) : text;
  }
}
