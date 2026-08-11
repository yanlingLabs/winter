import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub, type HubClient } from "../../src/sessions/hub";

/**
 * b2-agent-browser T4 — `SessionHub.attachedHarnesses`, the PRODUCTION half of the browser tool's
 * availability gate.
 *
 * The tool's own tests fake this dep, which is right for testing the tool but leaves the projection
 * itself — and daemon.ts's `harnesses: (sid) => hub.attachedHarnesses(sid)` wiring — covered by
 * nothing. That is the "green for the wrong reason" shape this repo has recorded repeatedly: a bug
 * here (wrong session, a role dropped, a live `HubClient` escaping) would ship with every browser row
 * green. So the projection is asserted directly, against a REAL hub with REAL attachments.
 */
function client(clientName: string, role?: string | null): HubClient {
  return { clientName, role, deliver: () => true };
}

describe("SessionHub.attachedHarnesses", () => {
  test("reports name AND role per attachment, is per-session, and follows detach", () => {
    const store = new SessionStore(mkdtempSync(join(tmpdir(), "norma-test-harnesses-")));
    const hub = new SessionHub(store);
    const a = store.createSession("global", {});
    const b = store.createSession("global", {});

    expect(hub.attachedHarnesses(a)).toEqual([]);
    // A session nothing ever touched must answer empty, not throw — the browser tool calls this
    // before it calls anything else.
    expect(hub.attachedHarnesses("never-seen")).toEqual([]);

    const orb = client("orb", "harness");
    const phone = client("iphone-gateway", "remote");
    const cli = client("cli-chat", "harness");
    hub.attach(orb, a, 0);
    hub.attach(phone, a, 0);
    hub.attach(cli, b, 0);

    // Per-session, and the ROLE survives the projection — the browser tool's `canHostPanel` checks
    // role before name, so a dropped role would silently make the phone look drivable.
    expect([...hub.attachedHarnesses(a)].sort((x, y) => x.clientName.localeCompare(y.clientName)))
      .toEqual([{ clientName: "iphone-gateway", role: "remote" }, { clientName: "orb", role: "harness" }]);
    expect(hub.attachedHarnesses(b)).toEqual([{ clientName: "cli-chat", role: "harness" }]);
    expect(hub.attachedHarnesses(a)).toHaveLength(hub.attachedCount(a));

    // No `HubClient` escapes: the accessor is a read projection, not a handle on the fan-out.
    for (const h of hub.attachedHarnesses(a)) {
      expect((h as { deliver?: unknown }).deliver).toBeUndefined();
    }

    hub.detach(phone);
    expect(hub.attachedHarnesses(a)).toEqual([{ clientName: "orb", role: "harness" }]);
    hub.detach(orb);
    expect(hub.attachedHarnesses(a)).toEqual([]);
  });

  test("a role-less client reports undefined rather than being dropped from the list", () => {
    const store = new SessionStore(mkdtempSync(join(tmpdir(), "norma-test-harnesses-")));
    const hub = new SessionHub(store);
    const s = store.createSession("global", {});
    hub.attach(client("norma-probe"), s, 0);
    expect(hub.attachedHarnesses(s)).toEqual([{ clientName: "norma-probe", role: undefined }]);
  });
});
