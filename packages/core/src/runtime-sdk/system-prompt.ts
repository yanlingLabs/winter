// P8b Task 17 Step 0(a) — Winter's OWN system prompt on the Winter leg, composed from the SAME
// sources `engine.ts`'s `turn()` composes it from today (the persona per mode, the `_assistant`
// memory bucket for chat/dispatch, the project MEMDIR for code, the workspace block, the trusted
// project instructions, the output style for a main conversation) — so a chat session on the Winter
// leg speaks as Winter, not as Winter's coding agent (Task 16 review M3).
//
// The mapping below is `engine.ts` `turn()`'s `assembler.assemble({...})` call, argument by argument
// (`test/runtime-sdk/system-prompt.test.ts` pins it BYTE-FOR-BYTE against a real engine turn per
// mode). What is deliberately NOT ported: `buildInstructionsFull`'s three appendices — the
// engine-registry "Deferred tools" index (Winter defers and searches its own tools), the code-mode
// plan-mode paragraph (Winter's `plan` permission mode carries its own), and the `/ultracode`
// reminder (the Workflow tool is a Task 17 capability carry) — all three are engine mechanics, not
// Winter's voice.
//
// `Options.outputStyle` stays UNSET on purpose: the assembler already folds the resolved style into
// the base slot (`ContextAssembler.assemble`'s style gate), exactly as the engine ships it, so an
// unset style is byte-identical to today and a set one is applied ONCE, by Winter, never a second
// time by Winter's own style loader.
import type { ContextAssembler } from "../agent/context";
import { chatSystemPrompt } from "../agent/chat-prompt";
import { dispatchSystemPrompt } from "../agent/dispatch-prompt";
import type { Mode as SessionMode } from "../agent/tools/registry";
import { clientEffortEligible, isClientEffort } from "../settings";

export interface WinterSystemPromptInput {
  mode: SessionMode;
  /** `SessionMeta.origin`; `"dispatch-child"` skips the output style (styles are main-conversation only). */
  origin?: string;
  /** `engine.ts` `primaryDir(sessionId)`: the live `cwd` column, else the first `dirs` row.
   *  `undefined` is a workdir-less session. */
  primary: string | undefined;
  /** `engine.ts` `turn()`'s `cwd`: `primary ?? sessionTmpDir(sessionId)`. */
  cwd: string;
  /** `EngineConfig.outDirOf(sessionId)` — the session's $OUTDIR (absent ⇒ no workspace block). */
  outDir?: string;
  /** `engine.ts` `additionalWorkDirs`: the `dirs` row minus the primary. */
  extraDirs?: string[];
  /** The session's stored effort; `ultra` on a code session adds the delegation paragraph. */
  effort?: string;
  /**
   * Is an Exa API key stored? (2026-09-18, the web-tools ruling.)
   *
   * Chat's and dispatch's base prompts NAME their search tool, and which one the session actually has
   * depends on this: the daemon's `Search` with a key, the runtime's own `WebSearch` without. The same
   * value drives `disallowedToolsFor` and the `research` capability build, so the prompt and the tool
   * list can never disagree. ABSENT reads as PRESENT, as it does at every other door.
   */
  exaKeyPresent?: boolean;
}

export function winterSystemPromptFor(assembler: Pick<ContextAssembler, "assemble">, input: WinterSystemPromptInput): string {
  const isDispatch = input.mode === "dispatch";
  const isChat = input.mode === "chat";
  // Spread rather than passed as `{ exaKeyPresent: input.exaKeyPresent }`: an EXPLICIT `undefined` and an
  // absent key read the same in the builders (both mean "present"), but keeping the key off the object
  // when the caller did not answer is the shape every other optional input in this file already takes.
  const webOpts = input.exaKeyPresent === undefined ? {} : { exaKeyPresent: input.exaKeyPresent };
  return assembler.assemble({
    cwd: input.cwd,
    // The engine's per-session `loadedSkills` set is empty at a session's first turn; on the Winter
    // leg the `Skill` tool is Winter's own, so nothing ever fills it host-side.
    loadedSkills: [],
    basePromptOverride: isDispatch ? dispatchSystemPrompt(webOpts) : isChat ? chatSystemPrompt(webOpts) : undefined,
    // Dreaming (Phase 7b) + Chat Slice A: dispatch AND chat read the shared `_assistant` bucket.
    memoryBucket: isDispatch || isChat ? "assistant" : "project",
    skipOutputStyle: input.origin === "dispatch-child",
    // `resolveSel(meta).ultra`, verbatim.
    ultraDelegation: isClientEffort(input.effort) && clientEffortEligible(input.mode),
    // chat's and dispatch's derived toolsets never list `Skill` (engine.ts: `registry.namesForMode`
    // — nothing declares `modes` including "Skill" for either); code never excludes it.
    skillToolOffered: !(isDispatch || isChat),
    // B1 (2026-09-22): NO daemon-side skill listing, in any mode, on either leg. The engine listed
    // this store because its own `Skill` tool loaded from it; a runtime child loads only what its
    // Options carry (`SkillStore.childSkillSurface` → `Options.plugins`/`skills` on the Winter leg;
    // the router's own plugin on the official leg) and announces exactly that set itself — claude's
    // `skill_listing` attachment, which the agent SDK mirrors. Two listings would disagree, and did:
    // the dist prompt named skills whose invocation answered "unknown skill … Available: (none)".
    skillListing: false,
    ...(input.outDir === undefined ? {} : { outDir: input.outDir }),
    workdirLess: input.primary === undefined,
    extraDirs: input.primary === undefined ? [] : (input.extraDirs ?? []),
  });
}
