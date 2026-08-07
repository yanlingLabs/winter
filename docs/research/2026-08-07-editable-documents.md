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

#### D. Roll your own (ProseMirror/TipTap + `mammoth.js` + `docx.js`)

Total control of the UX, and **you own OOXML fidelity forever**. Viable for a constrained subset ("Norma writes simple documents"); not viable for "open the deck my colleague sent me and edit it". For PowerPoint specifically, do not.

#### E. Drive Microsoft Office if installed

AppleScript or Office add-ins against a real Office install. Perfect fidelity by definition, zero bundle cost — **but only for users who own Office**, and the automation surface is awkward. A plausible *supplementary* path, not a foundation.

---

## 3. What this means in practice

**The order of difficulty is not what it looks like from outside.** Rendering these formats is nearly free (QuickLook, per the previous note). Editing them faithfully is one of the genuinely hard problems in desktop software, and it is hard in a way that does not yield to effort — it yields to *choosing someone else's engine*.

**Recommended shape:**

1. **Ship the code editor first.** Monaco + `monaco-languageclient` over the existing `LspManager`. Highest value per unit of work by a wide margin, and it proves the panel/tab shell that everything else will sit in.
2. **Spike ZetaOffice/ZetaJS** before committing to anything heavier. If WASM LibreOffice is usable, it is the cleanest possible answer for a Chromium-based app — no server, no IPC, agent and user on one engine. A spike is days; the answer is worth knowing before spending weeks elsewhere.
3. **If the spike fails, the choice is a LICENCE decision, not a technical one** — see §4.
4. **Do not build your own OOXML editor.** For Word maybe, for PowerPoint no.
5. **Decide the agent's mutation path at the same time as the editor** — not after. Picking an editor and *then* asking "how does the agent edit this?" is how you end up with two engines and silent divergence.

---

## 4. The licence question — Norma is Apache-2.0, and that is the whole decision

Norma is **Apache-2.0** (`packages/*/package.json`) and public at `github.com/yanlingLabs/norma`. An earlier draft assumed proprietary and called AGPL a blocker. **Wrong** — but the licence still decides this, just differently.

Apache-2.0 is **one-way compatible** with AGPL v3: Apache code can be combined into an AGPL work, and the **combined work is then AGPL v3**.

| Engine | Licence | Effect on Norma |
| --- | --- | --- |
| ONLYOFFICE (Docs or Desktop Editors) | **AGPL v3** | The **shipped app becomes AGPL v3.** The repo can stay Apache-2.0, but what you distribute carries AGPL obligations, including the network clause. |
| Collabora Online | **MPL 2.0** | **Norma stays Apache-2.0.** Publish changes to Collabora's own files only. |
| LibreOffice / ZetaOffice | **MPL 2.0** | Same — Norma stays Apache-2.0. |

**This is a values decision, not a legal obstacle.** Going AGPL is entirely legitimate for a free, open project, and buys the best OOXML fidelity available. What it costs:

- **Permissive forking goes away.** Apache-2.0 lets anyone build proprietary products on Norma; AGPL does not. If that permission is deliberate, AGPL removes it.
- **The network clause** reaches anyone who runs Norma as a service.
- **Some organisations ban AGPL outright**, which narrows who can adopt it at work.

**So the fork in the road:**

- **Best `.docx`/`.pptx` fidelity matters most, and AGPL is acceptable** → ONLYOFFICE **Desktop Editors** (no server, already CEF-based, `sdkjs` for agent control).
- **Staying Apache-2.0 matters most** → **Collabora** or **ZetaOffice** (both MPL 2.0), accepting somewhat weaker OOXML fidelity.

That is the actual decision. Everything else follows from it.

---

## 5. One thing to settle early

**One thing to settle early:** whether "the agent modifies the document" means *while the user has it open* (live co-editing, needs the editor's automation API and an operational-transform story) or *when it is closed* (much easier — mutate the file, reopen). Those are very different projects, and the second is a legitimate v1.

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
