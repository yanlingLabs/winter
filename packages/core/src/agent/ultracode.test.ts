import { expect, test } from "bun:test";
import { makeUltracodeHarness } from "./ultracode.testkit";

test("/ultracode <task> pins the Workflow tool and injects the authorization reminder", async () => {
  const h = await makeUltracodeHarness({ workflowsEnabled: true, keywordTrigger: true });
  await h.sendHuman("/ultracode refactor the whole auth module across 20 files");
  expect(h.lastVisibleTools()).toContain("Workflow"); // pinned despite being deferred
  expect(h.lastInstructions()).toMatch(/opted into workflow orchestration/i);
});

test("keywordTrigger:false makes /ultracode inert (no pin, no reminder)", async () => {
  const h = await makeUltracodeHarness({ workflowsEnabled: true, keywordTrigger: false });
  await h.sendHuman("/ultracode do a big thing");
  expect(h.lastVisibleTools()).not.toContain("Workflow");
  expect(h.lastInstructions()).not.toMatch(/opted into workflow orchestration/i);
});

test("workflows.enabled:false makes /ultracode inert (no pin, no reminder)", async () => {
  const h = await makeUltracodeHarness({ workflowsEnabled: false, keywordTrigger: true });
  await h.sendHuman("/ultracode do a big thing");
  expect(h.lastVisibleTools()).not.toContain("Workflow");
  expect(h.lastInstructions()).not.toMatch(/opted into workflow orchestration/i);
});

test("a non-human origin (routine/-p) never triggers /ultracode", async () => {
  const h = await makeUltracodeHarness({ workflowsEnabled: true, keywordTrigger: true });
  await h.sendNonHuman("/ultracode do a big thing"); // clientName marks a one-shot/routine
  expect(h.lastVisibleTools()).not.toContain("Workflow");
});

test("a non-human origin via the routine runner's own clientName never triggers /ultracode", async () => {
  const h = await makeUltracodeHarness({ workflowsEnabled: true, keywordTrigger: true });
  await h.sendNonHuman("/ultracode do a big thing", "routine");
  expect(h.lastVisibleTools()).not.toContain("Workflow");
  expect(h.lastInstructions()).not.toMatch(/opted into workflow orchestration/i);
});

test("a dispatch-child session's origin never triggers /ultracode (tool already hidden by B3's own gating, AND no reminder)", async () => {
  const h = await makeUltracodeHarness({ workflowsEnabled: true, keywordTrigger: true, origin: "dispatch-child", mode: "code" });
  await h.sendHuman("/ultracode do a big thing");
  expect(h.lastVisibleTools()).not.toContain("Workflow");
  expect(h.lastInstructions()).not.toMatch(/opted into workflow orchestration/i);
});

// CM-T2b: a chat session's own allowTools (CHAT_ALLOW_TOOLS) already keeps Workflow out of the
// PROVIDER-visible tool list unconditionally (engine.ts's allowTools filter applies regardless of
// this gate) — lastVisibleTools() below is a sanity check on that pre-existing invariant, not the
// regression this test guards. The real leak was the gate itself: isChatOrCowork(meta) must be true
// for a chat session so ultracodeGateOpen stays false and ULTRACODE_REMINDER ("...USE the Workflow
// tool...") is never injected into instructions telling the model to use a tool absent from its list.
test("/ultracode <task> is inert in a chat session (no pin, no reminder)", async () => {
  const h = await makeUltracodeHarness({ workflowsEnabled: true, keywordTrigger: true, mode: "chat" });
  await h.sendHuman("/ultracode do a big thing");
  expect(h.lastVisibleTools()).not.toContain("Workflow");
  expect(h.lastInstructions()).not.toMatch(/opted into workflow orchestration/i);
});

test("the session-wide auto-orchestrate toggle persists the reminder across turns until turned off", async () => {
  const h = await makeUltracodeHarness({ workflowsEnabled: true, keywordTrigger: true });
  await h.sendHuman("/ultracode"); // bare — flips the toggle on
  await h.sendHuman("do something substantial, no trigger text this time");
  expect(h.lastVisibleTools()).toContain("Workflow");
  expect(h.lastInstructions()).toMatch(/opted into workflow orchestration/i);
  await h.sendHuman("/ultracode"); // bare again — flips the toggle back off
  await h.sendHuman("a perfectly normal message");
  expect(h.lastVisibleTools()).not.toContain("Workflow");
  expect(h.lastInstructions()).not.toMatch(/opted into workflow orchestration/i);
});
