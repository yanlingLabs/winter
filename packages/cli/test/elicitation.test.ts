// WS-27: URL-mode elicitation on the terminal — the -p decline, the TUI's open/decline flow, the checks.
import { describe, expect, test } from "bun:test";
import { METHODS } from "@yanlinglabs/winter-protocol";
import { answerElicitation, declineElicitationHeadless, elicitationAnswerNote, elicitationUrlToOpen, openInBrowser, type ElicitationDoors } from "../src/elicitation";
import { applyEvent, isStalled, type WatchdogState } from "../src/watchdog";

const CODE = "OTC-cli-NOTPRINTED";
const URL_OK = `https://linear.app/oauth?code=${CODE}`;

describe("winter -p declines a card at once", () => {
  test("one line naming the server and host, and elicitation.respond decline — never the url", async () => {
    const lines: string[] = [];
    const sent: [string, unknown][] = [];
    declineElicitationHeadless({ elicitationId: "el_1", serverName: "linear", host: "linear.app" }, "s1", {
      emitLine: (l) => lines.push(l),
      request: async (m, p) => { sent.push([m, p]); return { ok: true, alreadyResolved: false }; },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("linear");
    expect(lines[0]).toContain("linear.app");
    expect(sent).toEqual([[METHODS.elicitationRespond, { sessionId: "s1", elicitationId: "el_1", action: "decline" }]]);
    // A failed send never throws out of the event handler.
    declineElicitationHeadless({ elicitationId: "el_2", serverName: "x", host: "x.example" }, "s1", {
      emitLine: () => {}, request: async () => { throw new Error("socket closed"); },
    });
    await Bun.sleep(1);
  });
});

describe("elicitationUrlToOpen", () => {
  test("https to the card's own host only", () => {
    expect(elicitationUrlToOpen(URL_OK, "linear.app")).toBe(URL_OK);
    expect(elicitationUrlToOpen("https://LINEAR.app/x", "linear.app")).toBe("https://linear.app/x");
    expect(elicitationUrlToOpen("https://linear.app:8443/x", "linear.app:8443")).toBe("https://linear.app:8443/x");
    for (const bad of ["https://evil.example/", "https://linear.app.evil.example/", "http://linear.app/", "javascript:alert(1)",
      "https://u:p@linear.app/", "https://linear.app:8443/", "not a url", "", undefined, 42]) {
      expect(elicitationUrlToOpen(bad, "linear.app")).toBeUndefined();
    }
  });
});

describe("the TUI's answer flow", () => {
  function doors(over: Partial<ElicitationDoors> = {}) {
    const steps: string[] = [];
    const d: ElicitationDoors = {
      fetchUrl: async () => { steps.push("fetch"); return URL_OK; },
      respond: async (accept) => { steps.push(`respond ${accept}`); return false; },
      open: async (url) => { steps.push(`open ${new URL(url).host}`); return true; },
      ...over,
    };
    return { d, steps };
  }

  test("open: fetch, check, open, then accept", async () => {
    const { d, steps } = doors();
    expect(await answerElicitation(true, "linear.app", d)).toBe("opened");
    expect(steps).toEqual(["fetch", "open linear.app", "respond true"]);
  });

  test("decline never fetches or opens", async () => {
    const { d, steps } = doors({ fetchUrl: async () => { throw new Error("must not fetch"); }, open: async () => { throw new Error("must not open"); } });
    expect(await answerElicitation(false, "linear.app", d)).toBe("declined");
    expect(steps).toEqual(["respond false"]);
  });

  test("a failed fetch or alreadyResolved is no longer active; a mismatched host or a failed open is never accepted", async () => {
    expect(await answerElicitation(true, "linear.app", doors({ fetchUrl: async () => { throw new Error("elicitation_not_active"); } }).d)).toBe("inactive");
    expect(await answerElicitation(false, "linear.app", doors({ respond: async () => true }).d)).toBe("inactive");
    const elsewhere = doors({ fetchUrl: async () => "https://evil.example/?x=1" });
    expect(await answerElicitation(true, "linear.app", elsewhere.d)).toBe("mismatch");
    expect(elsewhere.steps).toEqual([]);
    const stuck = doors({ open: async () => false });
    expect(await answerElicitation(true, "linear.app", stuck.d)).toBe("open-failed");
    expect(stuck.steps).toEqual(["fetch"]);
  });

  test("every note names the host, never the url", () => {
    for (const a of ["opened", "declined", "inactive", "mismatch", "open-failed", "send-failed"] as const) {
      const note = elicitationAnswerNote(a, "linear.app");
      if (note !== undefined) { expect(note).toContain("linear.app"); expect(note).not.toContain(CODE); }
    }
    expect(elicitationAnswerNote("inactive", "linear.app")).toBe("link request (linear.app) is no longer active");
  });

  test("the browser is opened with /usr/bin/open as an argv array — no shell", async () => {
    const calls: string[][] = [];
    expect(await openInBrowser(URL_OK, (argv) => { calls.push(argv); return { exited: Promise.resolve(0) }; })).toBe(true);
    expect(calls).toEqual([["/usr/bin/open", URL_OK]]);
    expect(await openInBrowser(URL_OK, () => ({ exited: Promise.resolve(1) }))).toBe(false);
    expect(await openInBrowser(URL_OK, () => { throw new Error("spawn failed"); })).toBe(false);
  });
});

describe("the stall watchdog", () => {
  test("a link card waiting on a human is not a stall", () => {
    const s: WatchdogState = { turnRunning: false, toolsInFlight: 0, approvalsPending: 0, lastEventAt: 0 };
    applyEvent(s, { type: "turn_started" }, 0);
    applyEvent(s, { type: "elicitation_requested" }, 0);
    expect(isStalled(s, 1_000_000, 1000)).toBe(false);
    applyEvent(s, { type: "elicitation_resolved" }, 0);
    expect(isStalled(s, 1_000_000, 1000)).toBe(true);
  });
});
