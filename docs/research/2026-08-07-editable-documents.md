# Editable Word, PowerPoint and code — for both the user and the agent

**Date:** 2026-08-07 · **Status:** research, no code written · **Follows** [`2026-08-07-embedded-surfaces.md`](./2026-08-07-embedded-surfaces.md), whose Chromium question is now decided: **Chromium**.

**Question:** make Word documents, PowerPoint decks and a code editor *interactive* — the user edits them, and the agent can modify and work with them.

**Short answer:** the code editor is a few weeks and you are already most of the way there. Word and PowerPoint are a different order of problem, and the difficulty is not the editor — it is **OOXML round-trip fidelity**.

---

## 1. The code editor: easy, and largely already built

**Use [Monaco](https://github.com/microsoft/monaco-editor)** — the editor out of VS Code — in the Chromium panel. With Chromium decided this is close to free.

Then **[`monaco-languageclient`](https://github.com/TypeFox/monaco-languageclient)** (v10.7.0, Feb 2026) connects Monaco to real language servers over JSON-RPC.

**Why this is mostly done already.** Norma has:

- `packages/core/src/lsp/manager.ts` + `client.ts` — a working **LSP manager** that already starts and speaks to language servers, with per-language routing (`languageForPath`)
- the `lsp` tool, and auto-diagnostics-after-edit
- file read/edit tools the agent already uses
- a daemon that already speaks **JSON-RPC over a socket**, which is exactly the transport `monaco-languageclient` expects

So the pieces line up almost suspiciously well: Monaco in the panel, `monaco-languageclient` in the web view, the existing `LspManager` in the daemon as the server side.

**Agent editing needs nothing new.** The agent already edits files on disk with tools it has. Monaco reloads. There is no second document model, no sync protocol, no conflict resolution — the file *is* the shared state.

**Effort:** days for a working editor, a few weeks for a good one (tabs, diff view, find/replace, editor↔agent selection sharing). The work is UI, not capability.

---

## 2. Word and PowerPoint: the hard one, and why

### The trap: this is two problems, not one

| | |
| --- | --- |
| **The editing surface** | A UI a human can type into. Solvable — several off-the-shelf options below. |
| **The document model** | A representation the *agent* can reason about and mutate, that serialises back to `.docx`/`.pptx` **without destroying formatting**. |

The second is where projects die. A `.docx` is a zip of XML with an enormous feature surface — styles, numbering, section breaks, headers, footnotes, tracked changes, embedded objects. Naive *parse → edit → serialise* silently destroys things the user cares about. `.pptx` is worse: layouts, masters, placeholder inheritance, animations.

**The rule that follows:** the human's editor and the agent's mutation path should be **the same engine**. Two engines over one file means two OOXML interpretations, and they *will* diverge. This single constraint eliminates most naive designs.

### The realistic options

#### A. ONLYOFFICE — and the important distinction between its TWO products

An earlier draft of this note pointed at **Document Server** and called it disqualifyingly heavy. That was aiming at the wrong product.

**ONLYOFFICE Docs (Document Server)** is a *server* for multi-user concurrent editing. Its official minimum for Community in Docker is **single-core 2 GHz, 4 GB RAM, 40 GB disk, 4 GB swap**. The 4 GB is real and official — but note the **40 GB of disk**, which gives the game away: this is sized for a document store serving many editors, not for one person opening a file. Bundling it in a desktop app would be pointing a server at an audience of one.

**ONLYOFFICE Desktop Editors** is the product that actually fits. It is:

- **a native desktop app with no server at all** — works fully offline
- **already built on the Chromium Embedded Framework**, which lines up exactly with the Chromium decision
- **free and open source under AGPL v3**
- split into [`desktop-sdk`](https://github.com/ONLYOFFICE/DesktopEditors) (the core) and **`sdkjs`** — a JavaScript SDK carrying the client-side APIs for every component, i.e. the surface an agent would drive

Same OOXML-native editing core, same fidelity, **without the five-service stack**. This is the ONLYOFFICE option worth evaluating.

#### B. Collabora Online — friendliest licence, lightest, weaker OOXML

- **MPL 2.0** — file-level copyleft. You bundle and link freely and publish changes to *their* files only. **Norma stays Apache-2.0.**
- **Single container, runs in ~1 GB RAM.** Dramatically lighter than ONLYOFFICE.
- Built on LibreOffice, so **ODF-native**; Microsoft formats are handled "well but not perfectly". For a product whose whole point is editing `.docx`/`.pptx`, that gap is the risk.
- Automation via LibreOffice's **UNO API**, which is mature and very capable.

#### C. ZetaOffice / ZetaJS — architecturally the best fit, but beta

- LibreOffice compiled to **WASM**, running *in the browser* — **no server at all**. With Chromium decided this is the most elegant shape by far: the office suite lives in the same web view as everything else.
- **ZetaJS** wraps it so JavaScript can drive LibreOffice's UNO APIs — meaning the agent gets full programmatic control through the same engine the user is editing in. Exactly the one-engine rule, with no IPC.
- **Status: open beta** (announced Nov 2024, still beta at the time of writing). WASM LibreOffice is also large and slow to start.
- **Verdict:** highest ceiling, real risk. Worth a spike, not a commitment.

#### D. Build our own, from the STANDARD — the option that keeps Apache-2.0

This is more viable than "roll your own" usually is, because of one fact: **OOXML is a published open standard — ECMA-376 / ISO/IEC 29500.** Implementing a documented format from its spec carries **no** licence contamination. File formats are not copyrightable; expression is.

**The legal line, stated once.** You do not need ONLYOFFICE's source for any of this, and you should not read it. Reading AGPL code and then writing your own creates derivative-work risk; the standard mitigation is a clean room (one team reads and writes a functional spec, a *different* team implements from it), which a small team cannot actually run — the firewall is the entire mechanism. Note also that using an **AI as the intermediary** to "translate" AGPL code is contested and untested in court, and may not satisfy the clean-room standard at all. Implement from ECMA-376; use their *product* as a UX reference, which is observation of behaviour, not copying of expression. (Not legal advice.)

**And most of it is already built, permissively.** Libraries that already do the hard part:

| Library | Licence | Notes |
| --- | --- | --- |
| [`pterror/ooxml`](https://github.com/pterror/ooxml) | **MIT/Apache-2.0** | Rust; typed structs generated from the ECMA-376 RELAX NG schemas, and **preserves unknown elements and attributes through round-trip** — exactly the property that makes fidelity possible |
| [`office_oxide`](https://github.com/yfedoseev/office_oxide) | **MIT/Apache-2.0** | DOCX/XLSX/PPTX + legacy; **JS/TS and WASM bindings**, so it fits both the Bun daemon and the Chromium panel |
| [`ooxmlsdk`](https://github.com/KaiserY/ooxmlsdk) | Rust | Modelled on the .NET Open XML SDK |
| [`pptx-viewer`](https://github.com/ChristopherVR/pptx-viewer/) | **Apache-2.0** | TypeScript, 18,800+ tests |

**The one thing not to build: the WYSIWYG layout engine.** A human-editable Word view means line breaking, pagination, float positioning, table cell algorithms, font fallback and decades of Word compatibility quirks. LibreOffice is ~10M lines and 30 years old. That is not a "lessons learnt" project. It is also precisely where ONLYOFFICE's value lives — which is why *using* their engine and *rebuilding* it are so far apart in cost.

**So split the problem by who is editing:**

| | Approach |
| --- | --- |
| **Agent edits** | **Surgical OOXML** via `office_oxide` / `pterror/ooxml` — touch only what changes, everything unknown round-trips verbatim. Fidelity comes free from *not re-rendering*. |
| **Faithful preview** | Render in Chromium via a converter (LibreOffice headless is MPL-2.0 and would only be *invoked*, never linked) or a permissive renderer. Read-only, accurate. |
| **Human edits** | A simplified content editor for text-level changes, or **"Open in Word/Pages"** — the user already owns an app that does this perfectly. |

The insight underneath: **most agent edits are content-level** — change this paragraph, add a slide, update that table. None of that needs a layout engine; it needs surgical XML editing plus a faithful preview. That dodges the entire hard problem **and keeps Norma Apache-2.0**.

#### E. Drive Microsoft Office if installed

AppleScript or Office add-ins against a real Office install. Perfect fidelity by definition, zero bundle cost — **but only for users who own Office**, and the automation surface is awkward. A plausible *supplementary* path, not a foundation.

---

## 3. DECIDED: LibreOffice via LibreOfficeKit

**User rule (2026-08-07):** full Word, Excel and PowerPoint — editable by the user *and* by the agent, **including layout**, not just content. Norma must stay **Apache-2.0**. The upstream project must be modifiable. Microsoft's proprietary extras are explicitly out of scope.

Those constraints admit exactly one family. **LibreOffice, embedded through [LibreOfficeKit](https://docs.libreoffice.org/libreofficekit.html).**

### Why the licence works, precisely

**MPL-2.0 is FILE-LEVEL copyleft.** MPL files may be combined with your own code in separate files, and your files keep whatever licence you choose. So:

- **Norma stays Apache-2.0.**
- You publish modifications to **LibreOffice's own files** only — which is exactly the "allowed to modify it to fit my needs" requirement, satisfied rather than merely tolerated.
- Bonus: LibreOffice already contains Apache-2.0 code inherited from OpenOffice, and Apache-2.0 is explicitly compatible with MPL-2.0.

This is the decisive difference from ONLYOFFICE, whose AGPL would pull the shipped app to AGPL. Same capability class, opposite licence outcome.

### Why LibreOfficeKit is the right seam

LOKit is the documented bridge between LibreOffice and an embedding application:

- usable as a **static library** — no server and no separate process required
- **tiled rendering** into 32-bit BGRA bitmap buffers, with callbacks for tile invalidation (`LOK_CALLBACK_INVALIDATE_TILES`), cursor position and text selection — i.e. the host draws the document, into a Chromium canvas or a native view
- **`postUnoCommand()`** dispatches any UNO command, with parameters
- explicitly intended to let applications drive LibreOffice "from different applications or **web browsers**"

Collabora Online is itself built on LOKit — so this is using the engine beneath their product rather than their product.

### Layout-level agent control, which was the actual requirement

UNO exposes the document model, not just its text:

| | What the agent can manipulate |
| --- | --- |
| **Word** | Paragraph and page styles, section breaks, text frames, anchoring, tables, columns, margins — `com.sun.star.text.*` |
| **PowerPoint** | Shape position/size/rotation, slide layouts, masters, placeholders, z-order — `com.sun.star.drawing.*` / `com.sun.star.presentation.*` |
| **Excel** | Cells, ranges, formulas, charts — `com.sun.star.sheet.*`. The easy one, as expected: a spreadsheet has a clean addressable model. |

**And crucially: one engine.** The user edits through LOKit's tiles and input events; the agent edits through UNO commands into the *same* loaded document. No second model, no divergence — the constraint §2 identified as the thing that kills naive designs is satisfied structurally.

### Fidelity: what "ODF-native" actually costs, and why the carve-out matters

This is the real price of choosing LibreOffice, so it is worth stating mechanically rather than as a vague "handles MS formats well but not perfectly".

The Document Foundation's own framing: *an office suite implements a document through an internal, in-memory representation; loading is a mapping INTO it and saving is a mapping OUT of it, and fidelity is greatest when the internal model is congruent with the format.*

| | Internal model | Opening `.docx` | Saving `.docx` |
| --- | --- | --- | --- |
| **LibreOffice** | Shaped like **ODF** | OOXML → ODF-shaped model — **lossy** | ODF-shaped model → OOXML — **lossy again** |
| **ONLYOFFICE** | Shaped like **OOXML** | Near-identity | Near-identity |

**LibreOffice pays two translations per Microsoft-format round-trip; ONLYOFFICE pays roughly none** — and pays them on ODF instead, symmetrically. Losses show up in list/numbering continuation, section properties, style inheritance, shape anchoring, content controls and compatibility flags. Rarely catastrophic; real and cumulative.

**Three things soften it here:**

1. **The carve-out helps.** Microsoft's proprietary extras are excluded by the rule, and that is where the worst gaps concentrate.
2. **The OOXML filters have had 15+ years of investment**, much of it from Collabora, precisely because their customers live in `.docx`.
3. **The cost scales with boundary crossings.** Created in Norma, edited in Norma, exported once → barely affected. Cycling Word → Norma → Word repeatedly → drift accumulates. Which pattern real users have is worth knowing before optimising for it.

**Source caveat:** this is a partisan topic. ONLYOFFICE publishes about LibreOffice's OOXML weakness; TDF publishes about OOXML suites handling ODF badly. Both are correct about the other. The neutral statement is only the mapping principle: *whichever format is not your internal model costs you fidelity.*

**Name the trade honestly:** ONLYOFFICE has better `.docx`/`.pptx` fidelity, and the Apache-2.0 rule gives that up. A deliberate and defensible choice — but this is the bill, and it is better named now than discovered in a numbering bug six months in.

### Three ways to ship it

| | Trade-off |
| --- | --- |
| **LOKit embedded directly** | Most control, no server, engine inside the app. **Biggest integration cost** — the editing UI is built on tiles plus callbacks. What Collabora's own mobile apps do. |
| **Collabora Online bundled** | A good editing UI already exists. Costs a local server process. Still MPL-2.0. |
| **ZetaOffice (WASM)** | No server, lives in the Chromium panel, ZetaJS drives UNO. Still beta. |

### The risk to retire first

**Building LibreOffice for macOS arm64 as an embeddable library.** It is an enormous codebase with its own build system (`gbuild`), and published LOKit binaries skew towards mobile targets. This is the single most likely thing to consume weeks unexpectedly, and it gates everything else — so it should be spike #1, before any UI work.

---

## 4. The licence table, for the record

Norma is **Apache-2.0** (`packages/*/package.json`), public at `github.com/yanlingLabs/norma`. An earlier draft of this note assumed proprietary and called AGPL a blocker — wrong, but the licence still decides the engine, just differently.

| Engine | Licence | Effect on Norma |
| --- | --- | --- |
| ONLYOFFICE (Docs or Desktop Editors) | **AGPL v3** | The **shipped app becomes AGPL v3.** Repo may stay Apache-2.0; the distribution carries AGPL obligations including the network clause. **Ruled out by the Apache-2.0 rule.** |
| **LibreOffice / LibreOfficeKit** | **MPL 2.0** | **Norma stays Apache-2.0.** Publish changes to their files only — which is also the permission to modify. **Chosen.** |
| Collabora Online | **MPL 2.0** | Same; a packaging of the above. |
| ZetaOffice / ZetaJS | **MPL 2.0** | Same; a WASM packaging of the above. |

Apache-2.0 is one-way compatible with AGPL v3 — Apache code can be pulled into an AGPL work, and the combination is then AGPL. That is the mechanism that rules ONLYOFFICE out under the stated rule, not any technical shortcoming: its OOXML fidelity is the best of the open options.

---

## 5. Order of work

1. **Spike the LOKit build for macOS arm64 first.** It is the riskiest unknown and it gates everything else. Do not design UI against an engine you have not yet built.
2. **Ship the code editor in parallel or first** (§1) — Monaco + `monaco-languageclient` over the existing `LspManager`. It is nearly free, and it builds the panel/tab shell the office surfaces will live in.
3. **Then choose the delivery shape** — LOKit embedded, Collabora Online bundled, or ZetaOffice — from what the spike teaches. All three are MPL-2.0, so this stays a technical choice rather than a licensing one.
4. **Design the agent's UNO path alongside the editing UI, not after it.** Both drive the same loaded document; that is the property that makes this work, and it is easy to lose by building the UI first and bolting automation on.

**One thing to settle early:** whether "the agent modifies the document" means *while the user has it open* — live, needing UNO commands into the live document and a coherent story for concurrent edits — or *only when closed*, which is far simpler. With LOKit both are possible; the first is meaningfully more work and is a legitimate v2.

---

## Sources

- ONLYOFFICE vs Collabora, deployment and format handling — https://selfhosting.sh/compare/collabora-vs-onlyoffice/
- ONLYOFFICE DocumentServer — https://github.com/onlyoffice/documentserver
- ONLYOFFICE Automation API — https://api.onlyoffice.com/docs/docs-api/usage-api/automation-api/
- ONLYOFFICE API 9.4 — https://www.onlyoffice.com/blog/2026/05/onlyoffice-api-9-4
- ONLYOFFICE licence and trademark policy — https://www.onlyoffice.com/blog/2026/05/onlyoffice-license-and-trademark-policy
- ONLYOFFICE Community licensing FAQ (AGPL v3) — https://helpcenter.onlyoffice.com/docs/faq/docs-community.aspx
- Collabora vs ONLYOFFICE (Collabora's own comparison) — https://www.collaboraonline.com/comparing-collabora-with-onlyoffice/
- ZetaOffice announcement — https://blog.allotropia.de/2024/11/08/announcing-zetaoffice-a-new-libreoffice-technology-product-for-web-mobile-desktop/
- ZetaJS — https://github.com/allotropia/zetajs
- Monaco editor — https://github.com/microsoft/monaco-editor
- monaco-languageclient — https://github.com/TypeFox/monaco-languageclient

## Local facts this rests on

- `packages/core/src/lsp/manager.ts`, `client.ts` — an existing LSP manager with per-language routing
- `packages/core/src/agent/tools/lsp.ts` — the `lsp` tool already registered
- The daemon already speaks JSON-RPC over a Unix socket — the transport `monaco-languageclient` expects
- Norma is proprietary and distributed as a signed app — which is what makes AGPL a blocker rather than a detail
