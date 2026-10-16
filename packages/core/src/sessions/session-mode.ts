// The session-mode boundary: which stored/wire modes may reach a runtime child.
//
// The protocol RECOGNISES four modes (`SESSION_MODES`, `packages/protocol/src/events.ts`); the daemon can
// RUN three. `cowork` is named so a client can send it, a stored row can carry it and a replayed log can
// say it — and so every door answers it with a typed refusal instead of a schema error or, worse, a
// default. Nothing creates or runs a Cowork session yet (docs/cowork-status.md): the execution topology,
// prompt, tool surface and permission contract are open product items, so there is deliberately NO
// Cowork prompt, tool allowlist, run home or runtime row anywhere below this boundary.
//
// FAIL CLOSED BY CONSTRUCTION. Everything that builds an `Options`, a prompt, a tool list, a run home or a
// hook — the runtime-sdk, the tool registry, the projector, the capability tables — is typed with
// `RunnableSessionMode`, which cannot hold `"cowork"`. A raw `string | undefined` mode column becomes one
// only through a door that refuses cowork FIRST (`session-driver.ts`'s `modeOf`, `handoff.ts`), so there is
// no `mode === "chat" ? chat : code` ternary anywhere that a cowork row can reach and silently become Code.
// The compile-time pin below makes adding a mode to the protocol a type error here until it is classified.
import type { SessionMode as WireSessionMode } from "@yanlinglabs/winter-protocol";

/** The modes a runtime child can be started for today. The one definition every runtime-facing
 *  `SessionMode` alias (`runtime-sdk/create.ts`, `agent/tools/registry.ts`, `projector/types.ts`) is
 *  built from. */
export type RunnableSessionMode = "code" | "dispatch" | "chat";

/** `RunnableSessionMode`, as a runtime list (for tests and tables that must cover every runnable mode). */
export const RUNNABLE_SESSION_MODES: readonly RunnableSessionMode[] = ["code", "dispatch", "chat"];

/** Every mode the protocol recognises but this daemon cannot run. A table keyed by it is the place to
 *  decide something for a mode that exists only as a name. */
export const UNRUNNABLE_SESSION_MODES = ["cowork"] as const;
export type UnrunnableSessionMode = (typeof UNRUNNABLE_SESSION_MODES)[number];

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
/** COMPILE-TIME PIN: the protocol's mode list is exactly the runnable modes plus the unrunnable ones. A new
 *  protocol mode that is in neither fails `tsc` HERE, before it can reach a `modeOf` that would map it to
 *  Code. */
export const SESSION_MODES_CLASSIFIED: Equal<WireSessionMode, RunnableSessionMode | UnrunnableSessionMode> = true;

/** True only for the stored/wire value `"cowork"`. Absent (`undefined`/`null`) is Code by the store-wide
 *  convention and is NOT cowork. */
export function isCoworkSessionMode(mode: string | null | undefined): mode is "cowork" {
  return mode === "cowork";
}

/** The refusal's human text — one string for the RPC door, the driver and the switch door. The machine
 *  half is always `{ code: "unsupported_topology" }`, the code the Cowork workspace doors already answer
 *  while the host integration gates are closed. */
export const COWORK_SESSION_UNSUPPORTED_MESSAGE = "Cowork unavailable";
export const COWORK_SESSION_UNSUPPORTED_CODE = "unsupported_topology";
