// ComputerV2 Phase 2 — the PAGE RUNTIME: installed by the browser engine once per document per frame, in an isolated
// world named "winter" (`Page.createIsolatedWorld`), never in the page's own world — the page can neither see it nor
// reach it. Bundled by `scripts/build-page-runtime.ts` (target browser, IIFE, no minify) into the committed
// `bundle.generated.ts`; the engine evaluates that string, so dev and the compiled daemon run the same bytes.
//
// What it does: builds the frame's tree (roles, names, values, states — Phase 1's role words), keeps the element ids
// (a WeakRef map, per document), finds elements, reads the page's text, watches the DOM for quiet, checks waits,
// and — before any pointer or keyboard input the engine sends over CDP — checks the target: hit test, visibility,
// scroll into view once, and the SECURE-FIELD floor (password, one-time-code and payment fields; fails closed).
// What it never does: start I/O (no fetch, no postMessage to the page, no storage, no cookies), or take anything
// from the daemon but its op arguments. The one call into the page's own code it makes, besides input events, is
// WebMCP's `executeTool` (`webmcp.ts`), and only for the model's `tab.callTool()`.
import type {
  RtCheck, RtCheckFacts, RtClassify, RtComboOptions, RtCondition, RtFindQuery, RtFound, RtHit, RtId, RtInspect, RtLink, RtNode, RtPoint, RtSnapshot, RtWatchLocate,
} from "./protocol";
import { looksLikeUrl, looksSecret, REDACTED, redactText, redactUrl, redactUrlAttribute } from "./redact";
import { classifyTarget, cssSelectorRefusal, isPaymentHost, isSecureField, isTextEntry as isTextEntryFacts, nativePicker, pickerValueHint, sliceUnits, TEXT_INPUT_TYPES, type ElementFacts } from "./rules";
import { listSiteTools, modelContextOf, SiteToolCalls, type SiteToolOwner } from "./webmcp";
import { WAKE_OVERLAY_TAG, WATCH_LOCATOR_ATTRS, wakeWatcher, type WatchLocator, type WatchSpec } from "./watch";
import { ambiguousOptionSentence, capValue, checkedStateOf, matchOption, NAME_FROM_CONTENT_ROLES, noOptionSentence, VALUE_CAP, WHOLE_VALUE_CAP, type CheckFacts, type OptionFacts } from "./widgets";

type Any = Record<string, unknown>;

(() => {
  const G = globalThis as unknown as Any;
  if (G.__winterRuntime !== undefined) return;

  // ── identity ────────────────────────────────────────────────────────────────────────────────────
  const rnd = new Uint32Array(2);
  crypto.getRandomValues(rnd);
  const RUNTIME_ID = `rt${rnd[0]!.toString(36)}${rnd[1]!.toString(36)}`;
  let nextId = 1;
  const ids = new WeakMap<Node, RtId>();
  const refs = new Map<RtId, WeakRef<Node>>();
  const idOf = (n: Node): RtId => {
    let i = ids.get(n);
    if (i === undefined) { i = nextId++; ids.set(n, i); refs.set(i, new WeakRef(n)); }
    return i;
  };
  const nodeOf = (id: unknown): Node | undefined => {
    if (typeof id !== "number") return undefined;
    const n = refs.get(id)?.deref();
    return n !== undefined && n.isConnected ? n : undefined;
  };
  const elementOf = (id: unknown): Element | undefined => {
    const n = nodeOf(id);
    return n instanceof Element ? n : undefined;
  };
  /** A text leaf's ref names text, not a field: the form control it labels (a `<label>` it sits in), if any. */
  const textLeaf = (id: unknown): { ok: false; reason: "text"; control?: RtId } | undefined => {
    const n = nodeOf(id);
    if (!(n instanceof Text)) return undefined;
    const label = n.parentElement?.closest("label");
    const control = label instanceof HTMLLabelElement ? label.control : null;
    return { ok: false, reason: "text", ...(control === null ? {} : { control: idOf(control) }) };
  };
  const prune = (): void => { for (const [k, r] of refs) if (r.deref() === undefined) refs.delete(k); };

  // ── the quiet-DOM watcher ───────────────────────────────────────────────────────────────────────
  // Installed into a page that may still be changing: quiet only after a real quiet stretch.
  let lastMutation = performance.now();
  const waiters = new Set<() => void>();
  const observed = new WeakSet<Node>();
  const observer = new MutationObserver(() => {
    lastMutation = performance.now();
    for (const w of [...waiters]) w();
  });
  const observe = (root: Node): void => {
    if (observed.has(root)) return;
    observed.add(root);
    try { observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true }); } catch { /* a detached root */ }
  };
  observe(document);

  // ── secrets and the floors (`rules.ts`, `redact.ts`) ───────────────────────────────────────────
  const inPaymentFrame = window.top !== window && isPaymentHost(location.hostname);
  /** The facts the rules read off an element. */
  const factsOf = (el: Element): ElementFacts => ({
    tag: el.tagName.toUpperCase(),
    ...(el instanceof HTMLInputElement ? { type: el.type.toLowerCase() } : {}),
    autocomplete: el.getAttribute("autocomplete") ?? "",
    contentEditable: (el as HTMLElement).isContentEditable === true,
  });
  const isTextEntry = (el: Element): boolean => isTextEntryFacts(factsOf(el));
  const isSecure = (el: Element): boolean => isSecureField(factsOf(el), inPaymentFrame);

  // ── check boxes: a native control, or one a page draws its own box over ─────────────────────────
  const isNativeCheck = (el: Element | null | undefined): el is HTMLInputElement =>
    el instanceof HTMLInputElement && (el.type.toLowerCase() === "checkbox" || el.type.toLowerCase() === "radio");
  /** The native check box or radio that carries `el`'s state: itself, the control its label names, or the one native
   *  control it wraps (a Material-style check box draws its box over a visually hidden native input). */
  const nativeCheckOf = (el: Element): HTMLInputElement | undefined => {
    if (isNativeCheck(el)) return el;
    if (el instanceof HTMLLabelElement) return isNativeCheck(el.control) ? el.control : undefined;
    const inner = el.querySelectorAll("input[type=checkbox], input[type=radio]");
    const only = inner.length === 1 ? inner[0] : undefined;
    return isNativeCheck(only) ? only : undefined;
  };
  const checkFactsOf = (el: Element): CheckFacts => {
    const n = nativeCheckOf(el);
    return { ariaChecked: el.getAttribute("aria-checked"), ...(n === undefined ? {} : { native: { checked: n.checked, indeterminate: n.indeterminate }, nativeIsSelf: n === el }) };
  };

  // ── the composed tree ───────────────────────────────────────────────────────────────────────────
  const composedChildren = (n: Node): Node[] => {
    if (n instanceof HTMLSlotElement) {
      const assigned = n.assignedNodes({ flatten: true });
      return assigned.length > 0 ? assigned : [...n.childNodes];
    }
    if (n instanceof Element && n.shadowRoot !== null) {
      observe(n.shadowRoot);
      return [...n.shadowRoot.childNodes];
    }
    return [...n.childNodes];
  };
  const deepActive = (): Element | null => {
    let a: Element | null = document.activeElement;
    while (a !== null && a.shadowRoot !== null && a.shadowRoot.activeElement !== null) a = a.shadowRoot.activeElement;
    return a;
  };
  const composedContains = (outer: Node, inner: Node | null): boolean => {
    for (let n: Node | null = inner; n !== null; n = n.parentNode ?? (n instanceof ShadowRoot ? n.host : null)) {
      if (n === outer) return true;
    }
    return false;
  };

  // Never part of the page as a reader sees it: scripts and styles — and Winter for Chrome's own overlay (the glow,
  // the agent cursor, the Stop button it injects into a driven tab).
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "TITLE", "SVG", "PATH", "BR", "HR", "WBR", "WINTER-AGENT-OVERLAY", WAKE_OVERLAY_TAG.toUpperCase()]);
  const styleOf = (el: Element): CSSStyleDeclaration | undefined => { try { return getComputedStyle(el); } catch { return undefined; } };
  /** Hidden from a reader: not rendered, hidden by ARIA, or a hidden input. `contents` boxes are walked through. */
  const hidden = (el: Element, st: CSSStyleDeclaration | undefined): boolean => {
    if (el.getAttribute("aria-hidden") === "true") return true;
    if (el instanceof HTMLInputElement && el.type.toLowerCase() === "hidden") return true;
    if ((el as HTMLElement).hidden === true) return true;
    if (st === undefined) return false;
    if (st.display === "none") return true;
    if (st.visibility === "hidden" || st.visibility === "collapse") return true;
    return false;
  };
  const isBlock = (st: CSSStyleDeclaration | undefined): boolean => {
    const d = st?.display ?? "inline";
    return !d.startsWith("inline") && d !== "contents";
  };

  const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();
  // Never between the halves of a surrogate pair (`sliceUnits`).
  const cap = (s: string, n = 200): string => (s.length <= n ? s : `${sliceUnits(s, n)}…`);

  // ── roles ───────────────────────────────────────────────────────────────────────────────────────
  const ROLE_WORDS: Record<string, string> = {
    button: "button", link: "link", textbox: "text field", searchbox: "search field", checkbox: "check box", radio: "radio button",
    switch: "switch", combobox: "combo box", listbox: "list box", option: "option", menuitem: "menu item", menuitemcheckbox: "menu item",
    menuitemradio: "menu item", menu: "menu", menubar: "menu bar", tab: "tab", tablist: "tab group", tabpanel: "tab panel", slider: "slider",
    spinbutton: "spin button", heading: "heading", img: "image", image: "image", list: "list", table: "table", grid: "grid", treegrid: "grid",
    row: "row", cell: "cell", gridcell: "cell", columnheader: "column header", rowheader: "row header", dialog: "dialog", alertdialog: "dialog",
    alert: "alert", progressbar: "progress indicator", main: "main", navigation: "navigation", banner: "banner", contentinfo: "content info",
    complementary: "complementary", region: "region", form: "form", search: "search", tree: "tree", treeitem: "tree item", toolbar: "toolbar",
    group: "group", status: "status", log: "log", article: "article", figure: "figure", math: "math", note: "note", feed: "feed",
  };
  const INTERACTIVE = new Set(["button", "link", "textbox", "searchbox", "checkbox", "radio", "switch", "combobox", "listbox", "option", "menuitem",
    "menuitemcheckbox", "menuitemradio", "tab", "slider", "spinbutton", "treeitem"]);
  /** Roles whose name is their content: their subtree is not read again as text. */
  const NAME_FROM_CONTENT = NAME_FROM_CONTENT_ROLES;
  const LANDMARK = new Set(["main", "navigation", "banner", "contentinfo", "complementary", "region", "form", "search"]);
  const CONTAINERS = new Set(["list", "table", "grid", "treegrid", "row", "dialog", "alertdialog", "alert", "menu", "menubar", "tablist", "tabpanel",
    "tree", "toolbar", "group", "listbox", "status", "log", "article", "figure", "feed"]);

  const insideLandmarkSection = (el: Element): boolean => {
    for (let p = el.parentElement; p !== null; p = p.parentElement) {
      if (["ARTICLE", "ASIDE", "MAIN", "NAV", "SECTION"].includes(p.tagName)) return true;
    }
    return false;
  };
  const implicitRole = (el: Element): string | undefined => {
    const tag = el.tagName;
    switch (tag) {
      case "A": case "AREA": return el.hasAttribute("href") ? "link" : undefined;
      case "BUTTON": return "button";
      case "SUMMARY": return "button";
      case "SELECT": return (el as HTMLSelectElement).multiple || (el as HTMLSelectElement).size > 1 ? "listbox" : "combobox";
      case "TEXTAREA": return "textbox";
      case "INPUT": {
        const t = (el as HTMLInputElement).type.toLowerCase();
        if (t === "button" || t === "submit" || t === "reset" || t === "image") return "button";
        if (t === "checkbox") return "checkbox";
        if (t === "radio") return "radio";
        if (t === "range") return "slider";
        if (t === "number") return "spinbutton";
        if (t === "search") return "searchbox";
        if (t === "file") return "button";
        if (t === "color") return "button";
        return "textbox";
      }
      case "H1": case "H2": case "H3": case "H4": case "H5": case "H6": return "heading";
      case "IMG": return (el.getAttribute("alt") ?? "").trim().length > 0 ? "img" : undefined;
      case "UL": case "OL": case "MENU": return "list";
      case "TABLE": return "table";
      case "TR": return "row";
      case "TD": return "cell";
      case "TH": return "columnheader";
      case "DIALOG": return "dialog";
      case "MAIN": return "main";
      case "NAV": return "navigation";
      case "ASIDE": return "complementary";
      case "HEADER": return insideLandmarkSection(el) ? undefined : "banner";
      case "FOOTER": return insideLandmarkSection(el) ? undefined : "contentinfo";
      case "FORM": return "form";
      case "SEARCH": return "search";
      case "SECTION": return el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby") ? "region" : undefined;
      case "FIELDSET": return "group";
      case "PROGRESS": return "progressbar";
      case "OPTION": return "option";
      case "ARTICLE": return "article";
      case "FIGURE": return "figure";
      default: return undefined;
    }
  };
  const roleOf = (el: Element): string | undefined => {
    const explicit = (el.getAttribute("role") ?? "").trim().toLowerCase().split(/\s+/)[0];
    if (explicit !== undefined && explicit.length > 0 && explicit !== "none" && explicit !== "presentation" && ROLE_WORDS[explicit] !== undefined) return explicit;
    if ((el as HTMLElement).isContentEditable === true && (el.parentElement === null || (el.parentElement as HTMLElement).isContentEditable !== true)) return "textbox";
    return implicitRole(el);
  };
  const roleWord = (role: string, el: Element): string => {
    if (role === "textbox" && (el instanceof HTMLTextAreaElement || el.getAttribute("aria-multiline") === "true" || (el as HTMLElement).isContentEditable === true)) return "text area";
    if (role === "combobox" && el instanceof HTMLSelectElement) return "pop up button";
    if (role === "button" && el.tagName === "SUMMARY") return "disclosure button";
    if (role === "button" && el instanceof HTMLInputElement && el.type.toLowerCase() === "file") return "file input";
    return ROLE_WORDS[role] ?? role;
  };

  // ── names, values, states ───────────────────────────────────────────────────────────────────────
  /** The text a reader hears for `n` (a name from content, a label). `exclude`: the control a label names — its own
   *  value is never part of its name. Embedded text fields contribute their value; check boxes and buttons nothing. */
  const textOf = (n: Node, budget = 400, exclude?: Element): string => {
    let out = "";
    const walk = (x: Node): void => {
      if (out.length > budget) return;
      if (x.nodeType === Node.TEXT_NODE) { out += x.textContent ?? ""; return; }
      if (!(x instanceof Element)) { for (const c of composedChildren(x)) walk(c); return; }
      if (x === exclude) return;
      if (SKIP.has(x.tagName.toUpperCase())) return;
      if (x.getAttribute("aria-hidden") === "true") return;
      if (x instanceof HTMLImageElement) { out += ` ${x.alt} `; return; }
      if (x instanceof HTMLSelectElement) return;
      if (x instanceof HTMLInputElement) {
        if (TEXT_INPUT_TYPES.has(x.type.toLowerCase()) && !isSecure(x) && !looksSecret(x.value)) out += ` ${x.value} `;
        return;
      }
      for (const c of composedChildren(x)) walk(c);
      const st = styleOf(x);
      if (isBlock(st)) out += " ";
    };
    walk(n);
    return collapse(out);
  };
  const byIds = (el: Element, attr: string): string | undefined => {
    const v = el.getAttribute(attr);
    if (v === null) return undefined;
    const root = el.getRootNode() as Document | ShadowRoot;
    const parts = v.split(/\s+/).map((id) => (root as Document).getElementById?.(id) ?? document.getElementById(id)).filter((x): x is HTMLElement => x !== null);
    const s = collapse(parts.map((p) => textOf(p)).join(" "));
    return s.length > 0 ? s : undefined;
  };
  const nameOf = (el: Element, role: string | undefined): string | undefined => {
    const labelled = byIds(el, "aria-labelledby");
    if (labelled !== undefined) return labelled;
    const aria = collapse(el.getAttribute("aria-label") ?? "");
    if (aria.length > 0) return aria;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      const labels = (el as HTMLInputElement).labels;
      if (labels !== null && labels.length > 0) {
        const s = collapse([...labels].map((l) => textOf(l, 400, el)).join(" "));
        if (s.length > 0) return s;
      }
      if (el instanceof HTMLInputElement) {
        const t = el.type.toLowerCase();
        if (t === "button" || t === "submit" || t === "reset") return collapse(el.value) || (t === "submit" ? "Submit" : t === "reset" ? "Reset" : undefined);
        if (t === "image") return collapse(el.alt) || undefined;
      }
      const ph = collapse(el.getAttribute("placeholder") ?? "");
      if (ph.length > 0) return ph;
    }
    if (el instanceof HTMLImageElement) return collapse(el.alt) || undefined;
    if (el instanceof HTMLIFrameElement) return collapse(el.title) || undefined;
    if (el.tagName === "FIELDSET") { const lg = el.querySelector("legend"); if (lg !== null) return textOf(lg) || undefined; }
    if (el.tagName === "TABLE") { const c = (el as HTMLTableElement).caption; if (c !== null) return textOf(c) || undefined; }
    if (el.tagName === "DIALOG" || role === "dialog" || role === "alertdialog") {
      const h = el.querySelector("h1, h2, h3, h4, h5, h6, [role=heading]");
      if (h !== null) return textOf(h) || undefined;
    }
    if (role !== undefined && NAME_FROM_CONTENT.has(role)) {
      const t = textOf(el);
      if (t.length > 0) return t;
    }
    const title = collapse(el.getAttribute("title") ?? "");
    return title.length > 0 ? title : undefined;
  };
  const valueOf = (el: Element, role: string): { value?: string; secure?: true; showEmpty?: true } => {
    if (role === "checkbox" || role === "radio" || role === "switch") return {};
    if (isSecure(el) && isTextEntry(el)) return { value: REDACTED, secure: true };
    let raw: string | undefined;
    let showEmpty = false;
    if (el instanceof HTMLInputElement) {
      const t = el.type.toLowerCase();
      if (t === "button" || t === "submit" || t === "reset" || t === "image" || t === "color") return {};
      if (t === "file") return el.files !== null && el.files.length > 0 ? { value: [...el.files].map((f) => f.name).join(", ") } : {};
      raw = el.value; showEmpty = TEXT_INPUT_TYPES.has(t);
    } else if (el instanceof HTMLTextAreaElement) { raw = el.value; showEmpty = true; }
    else if (el instanceof HTMLSelectElement) {
      raw = [...el.selectedOptions].map((o) => collapse(o.label || o.text)).join(", ");
    } else if ((el as HTMLElement).isContentEditable === true && role === "textbox") {
      raw = collapse((el as HTMLElement).innerText ?? el.textContent ?? ""); showEmpty = true;
    } else if (role === "slider" || role === "spinbutton" || role === "progressbar") {
      raw = el.getAttribute("aria-valuetext") ?? el.getAttribute("aria-valuenow") ?? undefined;
      if (el instanceof HTMLProgressElement) raw = String(el.value);
    } else if (role === "combobox" || role === "textbox" || role === "searchbox") {
      raw = el.getAttribute("aria-valuetext") ?? el.getAttribute("aria-valuenow") ?? undefined;
      // A combo box built from an element (an ARIA select): what it shows is its value — the chosen option's text.
      if (raw === undefined && role === "combobox") { const shown = textOf(el, 400); if (shown.length > 0) raw = shown; }
    }
    if (raw === undefined) return {};
    if (looksSecret(raw)) return { value: REDACTED };
    return { value: raw, ...(showEmpty ? { showEmpty: true as const } : {}) };
  };
  const statesOf = (el: Element, role: string, active: Element | null): string[] => {
    const out: string[] = [];
    const disabled = (el as HTMLButtonElement).disabled === true || el.getAttribute("aria-disabled") === "true"
      || (el.closest("fieldset:disabled") !== null && el.tagName !== "LEGEND");
    if (disabled) out.push("disabled");
    if (el === active) out.push("focused");
    if (role === "checkbox" || role === "radio" || role === "switch" || role === "menuitemcheckbox" || role === "menuitemradio") {
      // Its own aria-checked, else the native control it is or wraps (`widgets.ts`).
      out.push(checkedStateOf(checkFactsOf(el)));
    }
    if (el.getAttribute("aria-selected") === "true" || (el instanceof HTMLOptionElement && el.selected)) out.push("selected");
    const expanded = el.getAttribute("aria-expanded");
    if (expanded === "true") out.push("expanded");
    else if (expanded === "false") out.push("collapsed");
    else if (el.tagName === "SUMMARY" && el.parentElement instanceof HTMLDetailsElement) out.push(el.parentElement.open ? "expanded" : "collapsed");
    if (el.getAttribute("aria-pressed") === "true") out.push("pressed");
    if ((el as HTMLInputElement).required === true || el.getAttribute("aria-required") === "true") out.push("required");
    if ((el as HTMLInputElement).readOnly === true || el.getAttribute("aria-readonly") === "true") out.push("read-only");
    return out;
  };
  const hostOf = (href: string): string | undefined => {
    try {
      const u = new URL(href, location.href);
      if (u.protocol === "about:") return href.startsWith("about:srcdoc") ? "about:srcdoc" : "about:blank";
      if (u.protocol === "javascript:") return "javascript";
      if (u.protocol === "mailto:" || u.protocol === "tel:") return u.protocol.slice(0, -1);
      return u.host || undefined;
    } catch { return undefined; }
  };
  const offscreen = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    return r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth;
  };

  // ── the tree ────────────────────────────────────────────────────────────────────────────────────
  /** `valueCap`: values are cut at this many characters (`valueLength` says so). */
  interface WalkCtx { emitted: number; visited: number; maxNodes: number; unread: number; active: Element | null; valueCap: number }
  const MAX_VISITED = 40_000;

  /** One element as a node, or undefined when it is not one a reader needs (its children are still walked). */
  const nodeFor = (el: Element, role: string | undefined, ctx: WalkCtx): RtNode | undefined => {
    if (el instanceof HTMLIFrameElement || el.tagName === "FRAME") {
      const src = (el as HTMLIFrameElement).src || (el.hasAttribute("srcdoc") ? "about:srcdoc" : "about:blank");
      const name = nameOf(el, "iframe");
      const origin = el.hasAttribute("srcdoc") ? "about:srcdoc" : hostOf(src);
      return { id: idOf(el), role: "iframe", ...(name === undefined ? {} : { name: cap(name) }), frame: true, ...(origin === undefined ? {} : { origin }) };
    }
    if (role === undefined) return undefined;
    const interesting = INTERACTIVE.has(role) || role === "heading" || LANDMARK.has(role) || CONTAINERS.has(role) || role === "img" || role === "progressbar";
    if (!interesting) return undefined;
    const rawName = nameOf(el, role);
    const name = rawName === undefined ? undefined : redactText(rawName);
    const node: RtNode = { id: idOf(el), role: roleWord(role, el) };
    if (name !== undefined) node.name = cap(name);
    const v = valueOf(el, role);
    if (v.value !== undefined && (v.value !== name || v.secure === true)) {
      const c = capValue(v.value, ctx.valueCap);
      node.value = c.value;
      if (c.length !== undefined) node.valueLength = c.length;
    }
    if (v.secure === true) node.secure = true;
    if (v.showEmpty === true && v.value === "") node.showEmptyValue = true;
    const states = statesOf(el, role, ctx.active);
    if (states.length > 0) node.states = states;
    if (role === "heading") {
      const m = /^H([1-6])$/.exec(el.tagName);
      const lvl = Number(el.getAttribute("aria-level") ?? (m?.[1] ?? "2"));
      if (Number.isFinite(lvl)) node.level = lvl;
    }
    if (role === "link") {
      const h = hostOf((el as HTMLAnchorElement).href ?? el.getAttribute("href") ?? "");
      if (h !== undefined) node.href = h;
    }
    if (role === "list" || role === "listbox") {
      const items = [...el.children].filter((c) => c.tagName === "LI" || c.getAttribute("role") === "listitem" || c.getAttribute("role") === "option" || c.tagName === "OPTION").length;
      if (items > 0) node.items = items;
    }
    if (offscreen(el)) node.off = true;
    return node;
  };

  /** A run of text between the nodes a walk emits; its first text node names it (a paragraph keeps its ref). */
  interface Run { parts: string[]; first?: Node }
  const newRun = (): Run => ({ parts: [] });
  const INTERACTIVE_SELECTOR = "a[href], button, input, select, textarea, [role], [tabindex], [contenteditable]";

  /** Walk `parent`'s composed children into `out`, gathering text runs between the nodes it emits. */
  const walkInto = (parent: Node, out: RtNode[], ctx: WalkCtx, run: Run): void => {
    for (const child of composedChildren(parent)) {
      if (ctx.visited++ > MAX_VISITED || ctx.emitted >= ctx.maxNodes) { ctx.unread++; continue; }
      if (child.nodeType === Node.TEXT_NODE) {
        const t = child.textContent ?? "";
        if (t.trim().length > 0) { run.parts.push(t); run.first ??= child; }
        continue;
      }
      if (!(child instanceof Element)) continue;
      if (SKIP.has(child.tagName.toUpperCase())) continue;
      const st = styleOf(child);
      if (hidden(child, st)) continue;
      const role = roleOf(child);
      const node = nodeFor(child, role, ctx);
      const block = isBlock(st);
      if (node === undefined) {
        if (child instanceof HTMLLabelElement) { // a label names its control; its own text is not read again
          const control = child.control;
          if (control !== null && !child.contains(control)) continue;
        }
        if (block) flush(out, run, ctx);
        walkInto(child, out, ctx, run);
        if (block) flush(out, run, ctx);
        continue;
      }
      flush(out, run, ctx);
      ctx.emitted++;
      out.push(node);
      if (node.frame === true || child instanceof HTMLSelectElement || child instanceof HTMLTextAreaElement || child instanceof HTMLInputElement) continue;
      if (role === "textbox" && (child as HTMLElement).isContentEditable === true) continue;
      // A combo box whose value is what it shows: that text is its value, not read again (one with a field inside is walked).
      if (role === "combobox" && node.value !== undefined && child.querySelector("input, textarea, [contenteditable]") === null) continue;
      // A name read from the content is not read again as text — unless (a table cell, or a check box or radio whose
      // text holds a link: "I agree to the Terms") it holds controls.
      if (role !== undefined && NAME_FROM_CONTENT.has(role)) {
        const holdsControls = role === "cell" || role === "columnheader" || role === "rowheader" || role === "checkbox" || role === "radio";
        if (!holdsControls || child.querySelector(INTERACTIVE_SELECTOR) === null) continue;
      }
      const kids: RtNode[] = [];
      const inner = newRun();
      walkInto(child, kids, ctx, inner);
      flush(kids, inner, ctx);
      if (kids.length > 0) node.children = kids;
    }
  };
  /** A text run as one `text` leaf (at most 200 characters, secrets redacted). Its id names the run's first text
   *  node, so the same paragraph keeps its ref while that node lives. */
  const flush = (out: RtNode[], run: Run, ctx: WalkCtx): void => {
    if (run.parts.length === 0) return;
    const text = collapse(run.parts.join(" "));
    const first = run.first;
    run.parts.length = 0;
    delete run.first;
    if (text.length === 0 || first === undefined) return;
    ctx.emitted++;
    out.push({ id: idOf(first), role: "text", name: cap(redactText(text)) });
  };

  const snapshot = (arg: { within?: RtId; maxNodes?: number; valueCap?: number } | null): RtSnapshot => {
    prune();
    // A read within one element shows its fields' values whole, up to 8,000 characters (the helper's rule).
    const valueCap = Math.min(WHOLE_VALUE_CAP, Math.max(VALUE_CAP, arg?.valueCap ?? (arg?.within === undefined ? VALUE_CAP : WHOLE_VALUE_CAP)));
    const ctx: WalkCtx = { emitted: 0, visited: 0, maxNodes: Math.min(10_000, Math.max(50, arg?.maxNodes ?? 4_000)), unread: 0, active: deepActive(), valueCap };
    const roots: RtNode[] = [];
    if (arg?.within !== undefined) {
      const el = elementOf(arg.within);
      if (el === undefined) throw new Error(`stale:${arg.within}`);
      const role = roleOf(el);
      const node = nodeFor(el, role, ctx) ?? { id: idOf(el), role: "group" };
      const kids: RtNode[] = [];
      const run = newRun();
      walkInto(el, kids, ctx, run);
      flush(kids, run, ctx);
      if (kids.length > 0) node.children = kids;
      roots.push(node);
    } else if (document.body !== null || document.documentElement !== null) {
      const run = newRun();
      walkInto(document.body ?? document.documentElement, roots, ctx, run);
      flush(roots, run, ctx);
    }
    const out: RtSnapshot = { url: location.href, title: document.title, roots };
    const a = ctx.active;
    if (a !== null && a !== document.body && a !== document.documentElement) {
      if (a instanceof HTMLIFrameElement || a.tagName === "FRAME") out.focusedFrame = idOf(a);
      else out.focused = idOf(a);
    }
    if (ctx.unread > 0) out.unread = ctx.unread;
    return out;
  };

  // ── find ────────────────────────────────────────────────────────────────────────────────────────
  const find = (q: RtFindQuery): RtFound[] => {
    if (q.css !== undefined || q.testId !== undefined || q.placeholder !== undefined || q.label !== undefined) return findDom(q);
    const snap = snapshot({ maxNodes: 10_000 });
    const lc = (s: string | undefined): string => (s ?? "").toLowerCase();
    const want = { text: lc(q.text), role: lc(q.role), name: lc(q.name) };
    const out: RtFound[] = [];
    const visit = (n: RtNode): void => {
      if (out.length >= 50) return;
      let ok = true;
      if (want.role.length > 0 && lc(n.role) !== want.role && !lc(n.role).includes(want.role)) ok = false;
      if (ok && want.name.length > 0 && !lc(n.name).includes(want.name)) ok = false;
      if (ok && want.text.length > 0) {
        const hay = `${lc(n.name)} ${n.secure === true ? "" : lc(n.value)}`;
        if (!hay.includes(want.text)) ok = false;
      }
      if (ok && (want.text.length > 0 || want.role.length > 0 || want.name.length > 0)) {
        out.push({ id: n.id, role: n.role, ...(n.name === undefined ? {} : { name: n.name }), ...(n.value === undefined ? {} : { value: n.value }),
          ...(n.valueLength === undefined ? {} : { valueLength: n.valueLength }), ...(n.states === undefined ? {} : { states: n.states }) });
      }
      for (const c of n.children ?? []) visit(c);
    };
    for (const r of snap.roots) visit(r);
    return out;
  };

  /** Every element matching `selector` in the document and in its open shadow roots (at most `max`). */
  const deepQuery = (selector: string, max = 2_000): Element[] => {
    const out: Element[] = [];
    const seen = new Set<Element>();
    const roots: Array<Document | ShadowRoot> = [document];
    for (let i = 0; i < roots.length && out.length < max; i++) {
      const root = roots[i]!;
      for (const el of root.querySelectorAll(selector)) {
        if (!seen.has(el)) { seen.add(el); out.push(el); }
        if (out.length >= max) break;
      }
      for (const el of root.querySelectorAll("*")) if (el.shadowRoot !== null && el.shadowRoot.mode === "open") roots.push(el.shadowRoot);
    }
    return out;
  };
  const matches = (hay: string | undefined, want: string, exact: boolean): boolean =>
    hay !== undefined && (exact ? collapse(hay) === want : collapse(hay).toLowerCase().includes(want.toLowerCase()));
  const TEST_ID = "[data-testid], [data-test-id], [data-test], [data-cy]";
  const FIELD = "input, textarea, select, [contenteditable], [role=textbox], [role=searchbox], [role=combobox], [role=spinbutton], [role=slider], [role=checkbox], [role=radio], [role=switch], [role=listbox]";
  /** Phase 3's DOM search: css, testId, placeholder or label — then role, name and text narrow it, as for state(). */
  const findDom = (q: RtFindQuery): RtFound[] => {
    const exact = q.exact === true;
    // The engine refuses a selector outside the safe subset; checked here again (a value test reads hidden values).
    if (q.css !== undefined) {
      const why = cssSelectorRefusal(q.css);
      if (why !== undefined) throw new Error(`css: ${why}`);
    }
    let selector = q.css ?? (q.testId !== undefined ? TEST_ID : q.placeholder !== undefined ? "[placeholder]" : FIELD);
    if (q.css !== undefined && (q.testId !== undefined || q.placeholder !== undefined)) selector = q.css;
    let candidates: Element[];
    try { candidates = deepQuery(selector); } catch { throw new Error(`css: "${sliceUnits(String(q.css), 80)}" is not a valid selector`); }
    const active = deepActive();
    const out: RtFound[] = [];
    for (const el of candidates) {
      if (out.length >= 50) break;
      if (isOverlay(el)) continue;
      const st = styleOf(el);
      if (hidden(el, st)) continue;
      if (q.testId !== undefined) {
        const tid = el.getAttribute("data-testid") ?? el.getAttribute("data-test-id") ?? el.getAttribute("data-test") ?? el.getAttribute("data-cy");
        if (tid === null || (exact ? tid !== q.testId : tid.toLowerCase() !== q.testId.toLowerCase())) continue;
      }
      if (q.placeholder !== undefined && !matches(el.getAttribute("placeholder") ?? undefined, q.placeholder, exact)) continue;
      const role = roleOf(el) ?? "generic";
      const name = nameOf(el, role);
      if (q.label !== undefined && !matches(name, q.label, exact)) continue;
      if (q.role !== undefined && q.role.length > 0 && !role.toLowerCase().includes(q.role.toLowerCase()) && !roleWord(role, el).toLowerCase().includes(q.role.toLowerCase())) continue;
      if (q.name !== undefined && q.name.length > 0 && !matches(name, q.name, exact)) continue;
      const v = valueOf(el, role);
      if (q.text !== undefined && q.text.length > 0) {
        const hay = `${name ?? ""} ${v.secure === true ? "" : v.value ?? ""} ${textOf(el, 400)}`;
        if (!matches(hay, q.text, exact)) continue;
      }
      const states = statesOf(el, role, active);
      const cv = v.value === undefined ? undefined : capValue(v.value, VALUE_CAP);
      out.push({ id: idOf(el), role: roleWord(role, el), ...(name === undefined ? {} : { name: cap(redactText(name)) }), ...(cv === undefined ? {} : { value: cv.value }),
        ...(cv?.length === undefined ? {} : { valueLength: cv.length }), ...(states.length === 0 ? {} : { states }) });
    }
    return out;
  };

  // ── Phase 3: one element, the markup, the assets, links and check boxes ────────────────────────
  const DROP_ATTRS = new Set(["nonce", "integrity"]);
  const SECRET_META = /csrf|xsrf|token|nonce|secret|api[-_]?key/i;
  /** An attribute's value as the model may read it. */
  const attrValue = (el: Element, name: string, value: string): string | undefined => {
    const lname = name.toLowerCase();
    if (DROP_ATTRS.has(lname)) return undefined;
    if (lname === "value" && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
      if ((el instanceof HTMLInputElement && el.type.toLowerCase() === "hidden") || isSecure(el)) return REDACTED;
    }
    if (lname === "content" && el.tagName === "META" && SECRET_META.test(`${el.getAttribute("name") ?? ""} ${el.getAttribute("property") ?? ""} ${el.getAttribute("http-equiv") ?? ""}`)) return REDACTED;
    const asUrl = redactUrlAttribute(lname, value);
    if (asUrl !== undefined) return cap(asUrl, 500);
    if (looksSecret(value)) return REDACTED;
    return cap(redactText(value), 500);
  };
  const inspectEl = (el: Element): RtInspect => {
    const role = roleOf(el) ?? "generic";
    const name = nameOf(el, role);
    const v = valueOf(el, role);
    const attributes: Record<string, string> = {};
    let n = 0;
    for (const a of el.attributes) {
      if (n >= 40) break;
      const shown = attrValue(el, a.name, a.value);
      if (shown === undefined) continue;
      attributes[a.name] = shown;
      n++;
    }
    const r = el.getBoundingClientRect();
    const st = styleOf(el);
    const states = statesOf(el, role, deepActive());
    const text = role === "textbox" || isSecure(el) ? undefined : collapse((el as HTMLElement).innerText ?? el.textContent ?? "");
    return {
      id: idOf(el), tag: el.tagName.toLowerCase(), role: roleWord(role, el),
      ...(name === undefined ? {} : { name: cap(redactText(name)) }),
      ...(text === undefined || text.length === 0 ? {} : { text: cap(redactText(text), 2_000) }),
      ...(v.value === undefined ? {} : { value: v.value }),
      attributes, box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      visible: !hidden(el, st) && r.width > 0 && r.height > 0, enabled: !isDisabled(el),
      ...(states.length === 0 ? {} : { states }),
    };
  };
  const inspect = (arg: { id?: RtId; x?: number; y?: number }): RtInspect | { frame: RtId } | null => {
    if (arg.id !== undefined) {
      const el = elementOf(arg.id);
      if (el === undefined) throw new Error(`stale:${arg.id}`);
      return inspectEl(el);
    }
    if (typeof arg.x !== "number" || typeof arg.y !== "number") return null;
    const hit = deepFromPoint(arg.x, arg.y);
    if (hit === null) return null;
    if (hit instanceof HTMLIFrameElement || hit.tagName === "FRAME") return { frame: idOf(hit) };
    return inspectEl(hit);
  };

  const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
  const escText = (t: string): string => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const escAttr = (t: string): string => t.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const html = (arg: { id?: RtId; maxChars: number }): { html: string; cut: boolean } => {
    const max = Math.max(1_000, Math.min(500_000, arg.maxChars));
    const root = arg.id === undefined ? document.documentElement : elementOf(arg.id);
    if (root === undefined || root === null) throw new Error(`stale:${arg.id}`);
    let out = "";
    let cut = false;
    const put = (s: string): void => {
      if (cut) return;
      if (out.length + s.length > max) { out += sliceUnits(s, max - out.length); cut = true; return; }
      out += s;
    };
    const ser = (node: Node): void => {
      if (cut) return;
      if (node.nodeType === Node.TEXT_NODE) { put(escText(redactText(node.textContent ?? ""))); return; }
      if (!(node instanceof Element)) { for (const c of node.childNodes) ser(c); return; }
      const el = node;
      if (isOverlay(el)) return;
      const tag = el.tagName.toLowerCase();
      let open = `<${tag}`;
      for (const a of el.attributes) {
        const shown = attrValue(el, a.name, a.value);
        if (shown !== undefined) open += ` ${a.name}="${escAttr(shown)}"`;
      }
      // A field's live value (what the user or Winter typed), with the secure-field floor.
      if ((el instanceof HTMLInputElement && !["checkbox", "radio", "file", "button", "submit", "reset", "image"].includes(el.type.toLowerCase())) && !el.hasAttribute("value")) {
        const live = el.type.toLowerCase() === "hidden" || isSecure(el) ? REDACTED : looksSecret(el.value) ? REDACTED : looksLikeUrl(el.value) ? redactUrl(el.value.trim()) : el.value;
        if (live.length > 0) open += ` value="${escAttr(live)}"`;
      }
      put(`${open}>`);
      if (VOID_TAGS.has(tag)) return;
      if (tag === "script") { put(`/* ${(el.textContent ?? "").length} chars */</script>`); return; }
      if (el instanceof HTMLTextAreaElement) { put(`${escText(isSecure(el) ? REDACTED : looksSecret(el.value) ? REDACTED : el.value)}</textarea>`); return; }
      if (el.shadowRoot !== null && el.shadowRoot.mode === "open") {
        put(`<template shadowrootmode="open">`);
        for (const c of el.shadowRoot.childNodes) ser(c);
        put("</template>");
      }
      const kids = el instanceof HTMLTemplateElement ? el.content.childNodes : el.childNodes;
      for (const c of kids) ser(c);
      put(`</${tag}>`);
    };
    if (arg.id === undefined) put("<!doctype html>\n");
    ser(root);
    return { html: out, cut };
  };

  const assetUrl = (raw: string | null | undefined): string | undefined => {
    if (raw === null || raw === undefined || raw.length === 0) return undefined;
    if (raw.startsWith("data:")) {
      const m = /^data:([^;,]*)/.exec(raw);
      return `data:${m?.[1] || "text/plain"} (${raw.length} bytes)`;
    }
    try {
      const u = new URL(raw, location.href);
      return u.protocol === "http:" || u.protocol === "https:" ? u.href : undefined;
    } catch { return undefined; }
  };
  const assets = (arg: { kinds: string[]; max: number }): Array<{ kind: string; url: string }> => {
    const want = new Set(arg.kinds);
    const max = Math.max(1, Math.min(1_000, arg.max));
    const out: Array<{ kind: string; url: string }> = [];
    const seen = new Set<string>();
    const add = (kind: string, raw: string | null | undefined): void => {
      if (!want.has(kind) || out.length >= max) return;
      const url = assetUrl(raw);
      if (url === undefined || seen.has(url)) return;
      seen.add(url);
      out.push({ kind, url });
    };
    for (const img of deepQuery("img")) add("image", (img as HTMLImageElement).currentSrc || (img as HTMLImageElement).src);
    for (const v of deepQuery("video")) { add("media", (v as HTMLVideoElement).currentSrc || (v as HTMLVideoElement).src); add("image", (v as HTMLVideoElement).poster); }
    for (const a of deepQuery("audio")) add("media", (a as HTMLAudioElement).currentSrc || (a as HTMLAudioElement).src);
    for (const s of deepQuery("video source[src], audio source[src]")) add("media", (s as HTMLSourceElement).src);
    for (const l of deepQuery("link[href]")) {
      const rel = (l.getAttribute("rel") ?? "").toLowerCase();
      const href = (l as HTMLLinkElement).href;
      if (/\bstylesheet\b/.test(rel)) add("stylesheet", href);
      else if (/\bicon\b/.test(rel)) add("image", href);
      else if (/\bpreload\b/.test(rel) && l.getAttribute("as") === "font") add("font", href);
    }
    for (const sc of deepQuery("script[src]")) add("script", (sc as HTMLScriptElement).src);
    if (want.has("image")) {
      let n = 0;
      for (const el of deepQuery("*", 3_000)) {
        if (out.length >= max || n++ > 3_000) break;
        const bg = styleOf(el)?.backgroundImage ?? "";
        for (const m of bg.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) add("image", m[1]);
      }
    }
    return out.map((x) => ({ kind: x.kind, url: x.url.startsWith("data:") ? x.url : redactUrlText(x.url) }));
  };
  /** A URL's credential-looking query values, as the page runtime can tell (the engine redacts again). */
  const redactUrlText = (u: string): string => redactText(u);

  const linkOf = (arg: { id: RtId }): RtLink => {
    const el = elementOf(arg.id);
    if (el === undefined) throw new Error(`stale:${arg.id}`);
    const a = el.closest("a[href], area[href]") as HTMLAnchorElement | null;
    if (a !== null) return { kind: "link", url: a.href, ...(a.hasAttribute("download") ? { download: a.getAttribute("download") ?? "" } : {}) };
    if (el instanceof HTMLImageElement) return { kind: "media", url: el.currentSrc || el.src };
    if (el instanceof HTMLMediaElement) return { kind: "media", url: el.currentSrc || el.src };
    if (el instanceof HTMLSourceElement && el.src.length > 0) return { kind: "media", url: el.src };
    return { kind: "other" };
  };
  /** A checkable element's kind and state — a role, a native control, or a label or role-less wrapper of one. */
  const checkOf = (el: Element): (RtCheckFacts & { control?: Element }) | undefined => {
    const role = roleOf(el);
    const native = nativeCheckOf(el);
    const roleCheck = role === "checkbox" || role === "radio" || role === "switch" || role === "menuitemcheckbox" || role === "menuitemradio";
    if (!roleCheck && native === undefined) return undefined;
    const kind = role === "radio" || role === "menuitemradio" || (!roleCheck && native?.type.toLowerCase() === "radio") ? "radio" : "checkbox";
    const checked = checkedStateOf(checkFactsOf(el)) === "checked";
    // A wrapper with no role of its own (nor a label, which forwards a press) is pressed at the control it holds.
    const control = !roleCheck && native !== undefined && native !== el && !(el instanceof HTMLLabelElement) ? native : undefined;
    return { kind, checked, ...(control === undefined ? {} : { control }) };
  };
  const checkState = (arg: { id: RtId }): { checkable: boolean; checked?: boolean; control?: RtId; kind?: "checkbox" | "radio" } => {
    const el = elementOf(arg.id);
    if (el === undefined) throw new Error(`stale:${arg.id}`);
    const c = checkOf(el);
    if (c === undefined) return { checkable: false };
    return { checkable: true, checked: c.checked, kind: c.kind, ...(c.control === undefined ? {} : { control: idOf(c.control) }) };
  };

  // ── readable text ───────────────────────────────────────────────────────────────────────────────
  const BOILERPLATE = new Set(["NAV", "HEADER", "FOOTER", "ASIDE"]);
  const readable = (markdown: boolean, within?: RtId): string => {
    const scoped = within === undefined ? undefined : elementOf(within);
    if (within !== undefined && scoped === undefined) throw new Error(`stale:${within}`);
    const main = scoped ?? document.querySelector("main, [role=main], article") ?? document.body;
    if (main === null) return "";
    const lines: string[] = [];
    let line = "";
    const brk = (): void => { const t = collapse(line); if (t.length > 0) lines.push(t); line = ""; };
    let budget = 400_000;
    const walk = (n: Node, depth: number): void => {
      if (budget <= 0) return;
      if (n.nodeType === Node.TEXT_NODE) { const t = n.textContent ?? ""; budget -= t.length; line += t; return; }
      if (!(n instanceof Element)) { for (const c of composedChildren(n)) walk(c, depth); return; }
      const tag = n.tagName.toUpperCase();
      if (SKIP.has(tag)) return;
      if (main === document.body && BOILERPLATE.has(tag) && depth > 0) return;
      const st = styleOf(n);
      if (hidden(n, st)) return;
      if (n instanceof HTMLInputElement || n instanceof HTMLTextAreaElement || n instanceof HTMLSelectElement) return;
      if (n instanceof HTMLImageElement) { if (n.alt.trim().length > 0) line += markdown ? ` ![${collapse(n.alt)}]` : ` ${collapse(n.alt)} `; return; }
      const block = isBlock(st);
      if (block) brk();
      const h = /^H([1-6])$/.exec(tag);
      if (markdown && h !== null) line += `${"#".repeat(Number(h[1]))} `;
      if (markdown && tag === "LI") line += "- ";
      if (markdown && tag === "PRE") { brk(); lines.push("```"); lines.push((n.textContent ?? "").replace(/\n+$/, "")); lines.push("```"); return; }
      if (markdown && tag === "A" && (n as HTMLAnchorElement).href) {
        const label = textOf(n);
        if (label.length > 0) { line += ` [${label}](${redactUrl((n as HTMLAnchorElement).href)}) `; return; }
      }
      if (markdown && (tag === "STRONG" || tag === "B")) { line += " **"; for (const c of composedChildren(n)) walk(c, depth + 1); line += "** "; return; }
      if (markdown && tag === "CODE") { line += " `"; for (const c of composedChildren(n)) walk(c, depth + 1); line += "` "; return; }
      for (const c of composedChildren(n)) walk(c, depth + 1);
      if (block) brk();
    };
    walk(main, 0);
    brk();
    return redactText(lines.join("\n"));
  };

  // ── acting ──────────────────────────────────────────────────────────────────────────────────────
  const inViewport = (r: DOMRect): boolean => r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  const visibleRect = (el: Element): DOMRect | undefined => {
    for (const r of el.getClientRects()) if (r.width > 0 && r.height > 0) return r;
    return undefined;
  };
  /** Winter for Chrome's own overlay (and anything in it) is never what a point hits, nor what covers an element. */
  const isOverlay = (el: Element): boolean => {
    for (let n: Node | null = el; n !== null; n = n.parentNode ?? (n instanceof ShadowRoot ? n.host : null)) {
      if (n instanceof Element && (n.tagName === "WINTER-AGENT-OVERLAY" || n.tagName === WAKE_OVERLAY_TAG.toUpperCase())) return true;
    }
    return false;
  };
  const deepFromPoint = (x: number, y: number): Element | null => {
    let hit: Element | null = document.elementsFromPoint(x, y).find((e) => !isOverlay(e)) ?? null;
    while (hit !== null && hit.shadowRoot !== null) {
      const inner: Element | undefined = hit.shadowRoot.elementsFromPoint(x, y).find((e) => !isOverlay(e));
      if (inner === undefined || inner === hit) break;
      hit = inner;
    }
    return hit;
  };
  /** The meaningful thing covering a point: the nearest dialog or fixed overlay above the hit, else the hit. */
  const coverOf = (hit: Element): Element => {
    for (let p: Element | null = hit; p !== null; p = p.parentElement) {
      const role = roleOf(p);
      if (role === "dialog" || role === "alertdialog") return p;
      const pos = styleOf(p)?.position;
      if (pos === "fixed" || pos === "sticky") return p;
    }
    return hit;
  };
  const isDisabled = (el: Element): boolean => (el as HTMLButtonElement).disabled === true || el.getAttribute("aria-disabled") === "true";
  /** The next painted frame (two, so a scroll has reached the compositor that hit-tests input) — bounded, since a
   *  background tab may not paint at all. */
  const nextFrame = (): Promise<void> => new Promise((resolve) => {
    let done = false;
    const finish = (): void => { if (!done) { done = true; resolve(); } };
    setTimeout(finish, 120);
    try { requestAnimationFrame(() => requestAnimationFrame(finish)); } catch { finish(); }
  });
  /** The native window pressing `el` would open (`rules.ts`): its own, or — through a label, which forwards a press to its
   *  control — its control's; an <option> belongs to its <select>. */
  const pickerFor = (el: Element): { what: string; control: Element } | undefined => {
    const own = nativePicker(factsOf(el));
    if (own !== undefined) return { what: own, control: el };
    const select = el.closest("select");
    if (select !== null) return { what: nativePicker(factsOf(select))!, control: select };
    const label = el instanceof HTMLLabelElement ? el : el.closest("label");
    const control = label instanceof HTMLLabelElement ? label.control : null;
    const via = control === null ? undefined : nativePicker(factsOf(control));
    return via === undefined || control === null ? undefined : { what: via, control };
  };
  /** A right-click: the browser's own context menu would open as a native window on the user's screen. Unless the page
   *  shows a menu of its own (it prevents the default), the next contextmenu event in this frame is prevented — a
   *  one-shot listener on the window, after the page's own. */
  const guardMenu = (): void => {
    const onMenu = (e: Event): void => { if (!e.defaultPrevented) e.preventDefault(); };
    addEventListener("contextmenu", onMenu, { once: true });
    setTimeout(() => removeEventListener("contextmenu", onMenu), 3_000);
  };
  /** A visible label of a native control (the first one drawn). */
  const labelFor = (el: HTMLInputElement): HTMLLabelElement | undefined => {
    for (const l of el.labels ?? []) if (visibleRect(l) !== undefined && !hidden(l, styleOf(l))) return l;
    return undefined;
  };
  const tiny = (r: DOMRect): boolean => r.width < 4 || r.height < 4;
  /** Could pressing `el` make the page open a file chooser (a button whose handler clicks a hidden file input)? A
   *  button-like element (a button, a link, a role=button) with a file input in its form, or — outside a form — within
   *  its nearest four ancestors. The engine waits for a chooser only after such a press. */
  const mayOpenChooser = (el: Element): boolean => {
    const role = roleOf(el);
    if (role !== "button" && role !== "link" && role !== "menuitem") return false;
    const FILE = "input[type=file]";
    const form = el.closest("form");
    if (form !== null) return form.querySelector(FILE) !== null;
    let p: Element | null = el.parentElement;
    for (let i = 0; i < 4 && p !== null; i++, p = p.parentElement) if (p.querySelector(FILE) !== null) return true;
    return false;
  };
  /** Does a press at `el`'s centre reach it (or its own label)? */
  const pressable = (el: Element): boolean => {
    const r = visibleRect(el);
    if (r === undefined || !inViewport(r)) return true; // scrolled to and hit-tested by the ordinary path
    const hit = deepFromPoint((Math.max(r.left, 0) + Math.min(r.right, innerWidth)) / 2, (Math.max(r.top, 0) + Math.min(r.bottom, innerHeight)) / 2);
    return hit === null || composedContains(el, hit) || (hit instanceof HTMLLabelElement && hit.control === el);
  };
  const point = async (arg: { id: RtId; scroll?: boolean; settle?: boolean; guardMenu?: boolean }): Promise<RtPoint> => {
    // In a child frame just brought into view, the frame paints before its point is measured and hit-tested.
    if (arg.settle === true) await nextFrame();
    // A text leaf's ref is its run's first text node: it is pressed where that text is drawn, through its element.
    const node = nodeOf(arg.id);
    const el = node instanceof Element ? node : node instanceof Text ? node.parentElement ?? undefined : undefined;
    if (el === undefined || node === undefined) return { ok: false, reason: "gone" };
    const rectOf = (): DOMRect | undefined => {
      if (!(node instanceof Text)) return visibleRect(el);
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const t of range.getClientRects()) if (t.width > 0 && t.height > 0) return t;
      return undefined;
    };
    if (isDisabled(el)) return { ok: false, reason: "disabled" };
    // A native check box or radio a page draws its own box over (zero-size, clipped, or under the box): its label takes
    // the press for it — pressing a label presses its control.
    if (node === el && isNativeCheck(el)) {
      const via = labelFor(el);
      if (via !== undefined && (visibleRect(el) === undefined || tiny(visibleRect(el)!) || !pressable(el))) {
        const p = await point({ ...arg, id: idOf(via) });
        if (!p.ok) return p;
        const c = checkOf(el);
        return c === undefined ? p : { ...p, check: { kind: c.kind, checked: c.checked } };
      }
    }
    const st = styleOf(el);
    if (hidden(el, st)) return { ok: false, reason: "hidden" };
    let r = rectOf();
    if (r === undefined) return { ok: false, reason: "hidden" };
    if (!inViewport(r) && arg.scroll !== false) {
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
      await nextFrame();
      if (!node.isConnected) return { ok: false, reason: "gone" };
      r = rectOf();
      if (r === undefined) return { ok: false, reason: "hidden" };
    }
    if (!inViewport(r)) return { ok: false, reason: "offscreen" };
    const left = Math.max(r.left, 0), right = Math.min(r.right, innerWidth), top = Math.max(r.top, 0), bottom = Math.min(r.bottom, innerHeight);
    const x = (left + right) / 2, y = (top + bottom) / 2;
    // A <select>, a date/time/color or file input (or a label for one) opens a native window when pressed: the engine
    // refuses pointer input on it.
    const picker = pickerFor(el)?.what;
    // A check box's state before the press: the engine checks the press took (a page can take it elsewhere).
    const chk = node === el ? checkOf(el) : undefined;
    const chooser = mayOpenChooser(el);
    const okAt = (): RtPoint => {
      if (arg.guardMenu === true) guardMenu();
      return { ok: true, x, y, ...(picker === undefined ? {} : { picker }), ...(chk === undefined ? {} : { check: { kind: chk.kind, checked: chk.checked } }), ...(chooser ? { chooser: true as const } : {}) };
    };
    const hit = deepFromPoint(x, y);
    if (hit === null) return okAt();
    if (composedContains(el, hit)) return okAt();
    // A label that clicks through to its control, or a control inside the element's own label.
    if (hit instanceof HTMLLabelElement && hit.control === el) return okAt();
    if (el instanceof HTMLLabelElement && el.control !== null && composedContains(el.control, hit)) return okAt();
    const by = coverOf(hit);
    const byRole = roleOf(by);
    const name = nameOf(by, byRole);
    return { ok: false, reason: "covered", by: { id: idOf(by), role: byRole === undefined ? by.tagName.toLowerCase() : roleWord(byRole, by), ...(name === undefined ? {} : { name: cap(name, 80) }) } };
  };
  const classify = (arg: { id?: RtId } | null): RtClassify => {
    let el: Element | null | undefined;
    if (arg?.id !== undefined) el = elementOf(arg.id);
    else el = deepActive();
    // The decision is the rules' (`classifyTarget`): no element is `unknown` — fail closed.
    const c = classifyTarget(el === null || el === undefined ? null : factsOf(el), { inPaymentFrame, isBody: el === document.body || el === document.documentElement });
    if (el === null || el === undefined || c.kind === "unknown") return { kind: "unknown" };
    switch (c.kind) {
      case "frame": return { kind: "frame", id: idOf(el) };
      case "secure": return { kind: "secure", id: idOf(el) };
      case "picker": return { kind: "picker", id: idOf(el), what: c.what };
      default: {
        if (el === document.body || el === document.documentElement) return { kind: "ok", editable: false };
        const role = roleOf(el);
        const name = nameOf(el, role);
        return { kind: "ok", editable: c.editable, id: idOf(el), ...(role === undefined ? {} : { role: roleWord(role, el) }), ...(name === undefined ? {} : { name: cap(redactText(name), 80) }) };
      }
    }
  };
  /** What a pixel point hits in this frame: a native picker control, or the iframe element to descend into. */
  const hitAt = (arg: { x: number; y: number; guardMenu?: boolean }): RtHit => {
    if (arg.guardMenu === true) guardMenu();
    const hit = deepFromPoint(arg.x, arg.y);
    if (hit === null) return {};
    if (hit instanceof HTMLIFrameElement || hit.tagName === "FRAME") return { frame: idOf(hit) };
    // The control itself, or a label that forwards the press to one.
    const p = pickerFor(hit);
    return p === undefined ? {} : { picker: p.what, id: idOf(p.control) };
  };
  const focus = (arg: { id: RtId }): RtClassify => {
    const el = elementOf(arg.id);
    if (el === undefined) return { kind: "unknown" };
    if (isSecure(el)) return { kind: "secure", id: arg.id };
    (el as HTMLElement).focus?.({ preventScroll: false });
    const now = deepActive();
    // The focus must be where it was asked to go (or inside it, for a composite control): else nothing is typed.
    if (now === null || !(now === el || composedContains(el, now))) {
      if (el instanceof HTMLIFrameElement && now === el) return { kind: "frame", id: arg.id };
      return { kind: "unknown" };
    }
    return classify(null);
  };
  const nativeSetter = (el: Element): ((v: string) => void) | undefined => {
    const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : undefined;
    const set = proto === undefined ? undefined : Object.getOwnPropertyDescriptor(proto, "value")?.set;
    return set === undefined ? undefined : (v: string) => set.call(el, v);
  };
  const fire = (el: Element, type: string): void => { el.dispatchEvent(new Event(type, { bubbles: true, composed: true })); };
  const setValue = (arg: { id: RtId; value: string }): { ok: true; shown: string } | { ok: false; reason: string; control?: RtId } => {
    const el = elementOf(arg.id);
    if (el === undefined) return textLeaf(arg.id) ?? { ok: false, reason: "gone" };
    if (isSecure(el)) return { ok: false, reason: "secure_field" };
    if (isDisabled(el)) return { ok: false, reason: "disabled" };
    if (el instanceof HTMLSelectElement) {
      // An option by its visible text, else its value, else the text containing it. A multiple select takes one
      // option per line and selects exactly those.
      const wants = el.multiple ? arg.value.split("\n").map((w) => w.trim()).filter((w) => w.length > 0) : [arg.value];
      const chosen: HTMLOptionElement[] = [];
      const facts: Array<OptionFacts & { el: HTMLOptionElement }> = [...el.options].map((o) => ({ el: o, text: collapse(o.label || o.text), value: o.value, disabled: o.disabled }));
      for (const raw of wants) {
        const m = matchOption(facts, raw);
        if ("none" in m) return { ok: false, reason: noOptionSentence(raw, facts) };
        if ("ambiguous" in m) return { ok: false, reason: ambiguousOptionSentence(raw, m.ambiguous) };
        const opt = m.option;
        if (opt.disabled === true) return { ok: false, reason: `the option "${cap(opt.text, 60)}" is disabled` };
        chosen.push(opt.el);
      }
      if (el.multiple) { for (const o of el.options) o.selected = chosen.includes(o); } else el.value = chosen[0]!.value;
      fire(el, "input"); fire(el, "change");
      return { ok: true, shown: chosen.map((o) => collapse(o.label || o.text)).join(", ") };
    }
    if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) return { ok: false, reason: "a check box or radio button takes click(), not setValue()" };
    if (el instanceof HTMLInputElement && el.type === "file") return { ok: false, reason: "a file input takes upload(ref, paths)" };
    // A combo box that pops up a list (an ARIA select): the engine opens it and presses the option (`comboOptions`).
    if (isListCombo(el)) return { ok: false, reason: "combobox" };
    const set = nativeSetter(el);
    if (set !== undefined) {
      (el as HTMLElement).focus?.({ preventScroll: true });
      set(arg.value);
      // A date/time/color input drops a value it can't read (sets ""): say the shape it takes.
      if (el instanceof HTMLInputElement) {
        const hint = pickerValueHint(el.type);
        if (hint !== undefined && el.value.toLowerCase() !== arg.value.trim().toLowerCase()) {
          return { ok: false, reason: `that ${el.type} field takes a value like ${hint}` };
        }
      }
      fire(el, "input"); fire(el, "change");
      return { ok: true, shown: (el as HTMLInputElement).value };
    }
    if ((el as HTMLElement).isContentEditable === true) {
      (el as HTMLElement).focus();
      const sel = getSelection();
      if (sel !== null) { const r = document.createRange(); r.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(r); }
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      const done = document.execCommand("insertText", false, arg.value);
      if (!done) { el.textContent = arg.value; fire(el, "input"); }
      return { ok: true, shown: collapse((el as HTMLElement).innerText ?? "") };
    }
    return { ok: false, reason: "that element takes no value — click it, or type into a text field" };
  };
  const select = (arg: { id: RtId; text: string; before?: string; after?: string; caret?: "start" | "end" }): { ok: true } | { ok: false; reason: string } => {
    // A text leaf's text is selected in the element that holds it.
    const node = nodeOf(arg.id);
    const el = node instanceof Element ? node : node instanceof Text ? node.parentElement ?? undefined : undefined;
    if (el === undefined) return { ok: false, reason: "gone" };
    if (isSecure(el)) return { ok: false, reason: "secure_field" };
    const locate = (hay: string): number => {
      let from = 0;
      for (;;) {
        const i = hay.indexOf(arg.text, from);
        if (i < 0) return -1;
        const okBefore = arg.before === undefined || hay.slice(0, i).endsWith(arg.before);
        const okAfter = arg.after === undefined || hay.slice(i + arg.text.length).startsWith(arg.after);
        if (okBefore && okAfter) return i;
        from = i + 1;
      }
    };
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const i = locate(el.value);
      if (i < 0) return { ok: false, reason: "that text is not in the field" };
      el.focus();
      const start = arg.caret === "end" ? i + arg.text.length : i;
      const end = arg.caret === undefined ? i + arg.text.length : start;
      el.setSelectionRange(start, end);
      return { ok: true };
    }
    // Text in an editor or on the page: walk its text nodes for the occurrence.
    const texts: Text[] = [];
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n !== null; n = tw.nextNode()) texts.push(n as Text);
    const whole = texts.map((t) => t.data).join("");
    const i = locate(whole);
    if (i < 0) return { ok: false, reason: "that text is not in the element" };
    const at = (offset: number): [Text, number] | undefined => {
      let acc = 0;
      for (const t of texts) { if (offset <= acc + t.data.length) return [t, offset - acc]; acc += t.data.length; }
      return undefined;
    };
    const s = at(arg.caret === "end" ? i + arg.text.length : i);
    const e = at(arg.caret === undefined ? i + arg.text.length : arg.caret === "end" ? i + arg.text.length : i);
    if (s === undefined || e === undefined) return { ok: false, reason: "that text is not in the element" };
    (el as HTMLElement).focus?.();
    const range = document.createRange();
    range.setStart(s[0], s[1]); range.setEnd(e[0], e[1]);
    const sel = getSelection();
    sel?.removeAllRanges(); sel?.addRange(range);
    return { ok: true };
  };
  // ── combo boxes that pop up a list (ARIA selects) ───────────────────────────────────────────────
  /** A combo box built from an element, not a field: its list pops up on a press (`aria-haspopup` listbox — the
   *  combo box's default — or a menu). */
  const isListCombo = (el: Element): boolean => {
    if (roleOf(el) !== "combobox" || el instanceof HTMLSelectElement || isTextEntry(el)) return false;
    const popup = (el.getAttribute("aria-haspopup") ?? "listbox").trim().toLowerCase();
    return popup === "listbox" || popup === "true" || popup === "menu" || popup === "";
  };
  const OPTION_SELECTOR = "[role=option], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], option";
  const shownBox = (el: Element): boolean => visibleRect(el) !== undefined && !hidden(el, styleOf(el));
  /** The open list of a combo box: the element its `aria-controls`/`aria-owns` names, else the shown list box that
   *  names the combo box, else — while it says it is expanded — the one shown list box on the page (a list drawn in an
   *  overlay at the end of the document). */
  const popupOf = (el: Element): Element | undefined => {
    const root = el.getRootNode() as Document | ShadowRoot;
    for (const attr of ["aria-controls", "aria-owns"]) {
      for (const ref of (el.getAttribute(attr) ?? "").split(/\s+/).filter((x) => x.length > 0)) {
        const p = (root as Document).getElementById?.(ref) ?? document.getElementById(ref);
        if (p !== null && shownBox(p) && p.querySelector(OPTION_SELECTOR) !== null) return p;
      }
    }
    const boxes = deepQuery("[role=listbox], [role=menu]", 50).filter((b) => b !== el && shownBox(b) && b.querySelector(OPTION_SELECTOR) !== null);
    const id = el.id;
    const named = id.length === 0 ? undefined : boxes.find((b) => (b.getAttribute("aria-labelledby") ?? "").split(/\s+/).includes(id));
    if (named !== undefined) return named;
    return el.getAttribute("aria-expanded") === "true" && boxes.length === 1 ? boxes[0] : undefined;
  };
  const comboOptions = (arg: { id: RtId }): RtComboOptions => {
    const el = elementOf(arg.id);
    if (el === undefined) throw new Error(`stale:${arg.id}`);
    if (!isListCombo(el)) return { combo: false };
    const shown = valueOf(el, "combobox").value;
    const popup = popupOf(el);
    const options: Array<{ id: RtId; text: string; selected?: true; disabled?: true }> = [];
    if (popup !== undefined) {
      for (const o of popup.querySelectorAll(OPTION_SELECTOR)) {
        if (options.length >= 200) break;
        if (!shownBox(o)) continue;
        const text = cap(redactText(textOf(o) || collapse(o.getAttribute("aria-label") ?? "")), 200);
        if (text.length === 0) continue;
        const selected = o.getAttribute("aria-selected") === "true" || o.getAttribute("aria-checked") === "true";
        options.push({ id: idOf(o), text, ...(selected ? { selected: true as const } : {}), ...(isDisabled(o) ? { disabled: true as const } : {}) });
      }
    }
    return { combo: true, open: options.length > 0, ...(shown === undefined ? {} : { value: cap(shown, 200) }), options };
  };
  /** Where the keyboard focus is now, and a focused field's selection (what a key just did). */
  const focusInfo = (): { id?: RtId; role?: string; name?: string; selection?: { start: number; end: number; length: number } } => {
    const a = deepActive();
    if (a === null || a === document.body || a === document.documentElement) return {};
    const role = roleOf(a);
    const name = nameOf(a, role);
    let selection: { start: number; end: number; length: number } | undefined;
    if (!isSecure(a) && (a instanceof HTMLTextAreaElement || (a instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(a.type.toLowerCase())))) {
      try { if (a.selectionStart !== null && a.selectionEnd !== null) selection = { start: a.selectionStart, end: a.selectionEnd, length: a.value.length }; } catch { /* a type with no selection */ }
    }
    return { id: idOf(a), ...(role === undefined ? {} : { role: roleWord(role, a) }), ...(name === undefined ? {} : { name: cap(redactText(name), 80) }), ...(selection === undefined ? {} : { selection }) };
  };

  const readValue = (arg: { id: RtId }): string | null => {
    const el = elementOf(arg.id);
    if (el === undefined || isSecure(el)) return null;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value;
    if ((el as HTMLElement).isContentEditable === true) return (el as HTMLElement).innerText ?? el.textContent;
    return null;
  };
  const fileInput = (arg: { id: RtId }): { ok: true; multiple: boolean } | { ok: false; reason: string; control?: RtId } => {
    const el = elementOf(arg.id);
    if (el === undefined) return textLeaf(arg.id) ?? { ok: false, reason: "gone" };
    if (!(el instanceof HTMLInputElement) || el.type.toLowerCase() !== "file") return { ok: false, reason: "not a file input" };
    if (el.disabled) return { ok: false, reason: "disabled" };
    return { ok: true, multiple: el.multiple };
  };
  const pasteEvent = (arg: { html?: string; text: string }): { handled: boolean } => {
    const target = deepActive();
    if (target === null || isSecure(target)) return { handled: false };
    const dt = new DataTransfer();
    dt.setData("text/plain", arg.text);
    if (arg.html !== undefined) dt.setData("text/html", arg.html);
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true, composed: true });
    const notCancelled = target.dispatchEvent(ev);
    return { handled: !notCancelled };
  };

  // ── waits ───────────────────────────────────────────────────────────────────────────────────────
  const visibleText = (): string => {
    const body = document.body;
    if (body === null) return "";
    let t = body.innerText ?? "";
    // Open shadow roots' text is not in innerText: add it.
    const extra: string[] = [];
    const walk = (n: Node): void => {
      for (const c of n instanceof Element && n.shadowRoot !== null ? [...n.shadowRoot.childNodes] : []) extra.push((c as HTMLElement).innerText ?? c.textContent ?? "");
      for (const c of n.childNodes) if (c instanceof Element) walk(c);
    };
    if (body.querySelector("*") !== null && t.length < 2_000_000) walk(body);
    if (extra.length > 0) t += `\n${extra.join("\n")}`;
    return t;
  };
  const check = (c: RtCondition): RtCheck => {
    let met = true;
    let text: string | undefined;
    const vt = (): string => (text ??= visibleText());
    if (c.text !== undefined && !vt().includes(c.text)) met = false;
    if (met && c.goneText !== undefined && vt().includes(c.goneText)) met = false;
    if (met && c.title !== undefined && !document.title.includes(c.title)) met = false;
    if (met && c.url !== undefined && !location.href.includes(c.url)) met = false;
    if (met && c.ids !== undefined && c.ids.some((id) => nodeOf(id) === undefined)) met = false;
    if (met && c.goneIds !== undefined && c.goneIds.some((id) => nodeOf(id) !== undefined)) met = false;
    const seenText = sliceUnits(collapse(vt()), 300);
    return { met, seen: redactText(`title "${cap(document.title, 80)}" · ${seenText}`) };
  };
  const waitChange = (arg: { maxMs: number }): Promise<boolean> => new Promise((resolve) => {
    const max = Math.max(0, Math.min(1_000, arg.maxMs));
    let done = false;
    const finish = (changed: boolean): void => { if (done) return; done = true; waiters.delete(onChange); clearTimeout(timer); resolve(changed); };
    const onChange = (): void => finish(true);
    const timer = setTimeout(() => finish(false), max);
    waiters.add(onChange);
  });

  // ── frames ──────────────────────────────────────────────────────────────────────────────────────
  /** An iframe element's content-box origin in this frame's viewport. With `scroll`, the point `inner` (CSS px in the
   *  frame's own viewport) is brought into this frame's view first, so a click there lands in the frame. */
  const frameOffset = async (arg: { id: RtId; scroll?: boolean; inner?: { x: number; y: number } }): Promise<{ x: number; y: number } | null> => {
    const el = elementOf(arg.id);
    if (el === undefined) return null;
    const st = styleOf(el);
    const px = (v: string | undefined): number => { const n = parseFloat(v ?? "0"); return Number.isFinite(n) ? n : 0; };
    const origin = (): { x: number; y: number } => {
      const r = el.getBoundingClientRect();
      return { x: r.left + px(st?.borderLeftWidth) + px(st?.paddingLeft), y: r.top + px(st?.borderTopWidth) + px(st?.paddingTop) };
    };
    const target = (): { x: number; y: number } => {
      const o = origin();
      const r = el.getBoundingClientRect();
      return { x: o.x + (arg.inner?.x ?? r.width / 2), y: o.y + (arg.inner?.y ?? r.height / 2) };
    };
    const visible = (t: { x: number; y: number }): boolean => t.x >= 0 && t.y >= 0 && t.x < innerWidth && t.y < innerHeight;
    if (arg.scroll === true && !visible(target())) {
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
      const t = target();
      if (!visible(t)) window.scrollBy({ left: t.x - innerWidth / 2, top: t.y - innerHeight / 2, behavior: "instant" as ScrollBehavior });
      await nextFrame();
    }
    return origin();
  };

  // ── WebMCP: the page's own agent tools (Phase 4) ────────────────────────────────────────────────
  // Read through THIS world's `document.modelContext` (the page cannot replace it here); only the tools this frame's
  // own window registered, from its own origin. A call runs the page's own callback, in the page's world.
  const siteCalls = new SiteToolCalls();
  const siteOwner = (): SiteToolOwner => ({ window, origin: location.origin });

  // ── wake triggers (`watch.ts`) ──────────────────────────────────────────────────────────────────────
  // The daemon reads the element HERE (its role and name, redacted as in state(); the secure-field floor), then arms
  // the shared watcher in this world — or hands its locator to Winter for Chrome, which arms the same watcher in its
  // own isolated world with no debugger.
  const elementFor = (id: unknown): Element | undefined => {
    const node = nodeOf(id);
    return node instanceof Element ? node : node instanceof Text ? node.parentElement ?? undefined : undefined;
  };
  const locatorOf = (el: Element): WatchLocator => {
    const path: Array<[string, number, number]> = [];
    let cur: Element = el;
    for (let depth = 0; depth < 512; depth++) {
      const parent: Node | null = cur.parentNode;
      const siblings = parent instanceof Element || parent instanceof Document || parent instanceof DocumentFragment ? [...parent.children] : [cur];
      const tag = cur.tagName;
      path.unshift([tag, siblings.filter((s) => s.tagName === tag).indexOf(cur), parent instanceof ShadowRoot ? 1 : 0]);
      if (parent instanceof ShadowRoot) cur = parent.host;
      else if (parent instanceof Element) cur = parent;
      else break;
    }
    const attrs: Record<string, string> = {};
    for (const k of WATCH_LOCATOR_ATTRS) {
      const v = el.getAttribute(k);
      if (v !== null && v.length <= 500) attrs[k] = v;
    }
    return { doc: performance.timeOrigin, path, tag: el.tagName, attrs };
  };
  const watchLocate = (arg: { id: RtId }): RtWatchLocate => {
    const el = elementFor(arg.id);
    if (el === undefined) return { ok: false, reason: "gone" };
    if (inPaymentFrame || isSecure(el)) return { ok: false, reason: "secure" };
    const role = roleOf(el);
    const name = nameOf(el, role);
    return {
      ok: true, element: { role: role === undefined ? el.tagName.toLowerCase() : roleWord(role, el), name: name === undefined ? "" : cap(redactText(name), 120) },
      locator: locatorOf(el), top: window.top === window,
    };
  };

  // ── the entry ───────────────────────────────────────────────────────────────────────────────────
  const call = (op: string, arg: unknown, self: unknown): unknown => {
    const a = (arg ?? null) as Any | null;
    switch (op) {
      case "hello": return { id: RUNTIME_ID, url: location.href, title: document.title, readyState: document.readyState };
      case "snapshot": return snapshot(a as { within?: RtId; maxNodes?: number; valueCap?: number } | null);
      case "find": return find((a ?? {}) as RtFindQuery);
      case "text": return readable(a?.markdown === true, typeof a?.within === "number" ? a.within : undefined);
      case "owner": return self instanceof Node ? idOf(self) : null;
      case "frameOffset": return frameOffset(a as { id: RtId; scroll?: boolean; inner?: { x: number; y: number } });
      case "point": return point(a as { id: RtId; scroll?: boolean; settle?: boolean; guardMenu?: boolean });
      case "classify": return classify(a as { id?: RtId } | null);
      case "focus": return focus(a as { id: RtId });
      case "setValue": return setValue(a as { id: RtId; value: string });
      case "select": return select(a as { id: RtId; text: string; before?: string; after?: string; caret?: "start" | "end" });
      case "readValue": return readValue(a as { id: RtId });
      case "fileInput": return fileInput(a as { id: RtId });
      case "element": return elementOf((a as { id: RtId }).id) ?? null;
      case "pasteEvent": return pasteEvent(a as { html?: string; text: string });
      case "quiet": return { sinceMutationMs: Math.max(0, Math.round(performance.now() - lastMutation)), url: location.href, title: document.title, readyState: document.readyState };
      case "hitAt": return hitAt(a as { x: number; y: number; guardMenu?: boolean });
      case "waitChange": return waitChange(a as { maxMs: number });
      case "check": return check((a ?? {}) as RtCondition);
      case "alive": return ((a as { ids: RtId[] }).ids ?? []).filter((id) => nodeOf(id) !== undefined);
      case "inspect": return inspect((a ?? {}) as { id?: RtId; x?: number; y?: number });
      case "html": return html(a as { id?: RtId; maxChars: number });
      case "assets": return assets(a as { kinds: string[]; max: number });
      case "linkOf": return linkOf(a as { id: RtId });
      case "checkState": return checkState(a as { id: RtId });
      case "comboOptions": return comboOptions(a as { id: RtId });
      case "focusInfo": return focusInfo();
      case "siteTools": return listSiteTools(modelContextOf(document), siteOwner(), { describe: a?.describe === true });
      case "callSiteTool": return siteCalls.call(modelContextOf(document), siteOwner(), a as { name: string; input: unknown; callId: string });
      case "cancelSiteTool": return siteCalls.cancel(a?.callId);
      case "watchLocate": return watchLocate(a as { id: RtId });
      case "watchArm": {
        const w = a as { spec: WatchSpec; id?: RtId };
        const el = w.id === undefined ? undefined : elementFor(w.id);
        if (el !== undefined && (inPaymentFrame || isSecure(el))) throw new Error("secure_field");
        return wakeWatcher({ op: "arm", sink: "queue", spec: w.spec, ...(el === undefined ? {} : { element: el }) });
      }
      case "watchWait": return wakeWatcher({
        op: "wait", ack: Number(a?.ack ?? 0), maxMs: Number(a?.maxMs ?? 0), ...(typeof a?.world === "string" ? { world: a.world } : {}),
        ...(Array.isArray(a?.live) ? { live: (a.live as unknown[]).filter((x): x is string => typeof x === "string") } : {}),
      });
      case "watchDisarm": return wakeWatcher({ op: "disarm", watchId: String(a?.watchId ?? "") });
      default: throw new Error(`unknown op ${op}`);
    }
  };

  Object.defineProperty(G, "__winterRuntime", { value: Object.freeze({ id: RUNTIME_ID, call }), enumerable: false, configurable: false, writable: false });
})();
