/// <reference lib="dom" />
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
// from the daemon but its op arguments.
import type {
  RtCheck, RtClassify, RtCondition, RtFindQuery, RtFound, RtId, RtNode, RtPoint, RtSnapshot,
} from "./protocol";

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
  const prune = (): void => { for (const [k, r] of refs) if (r.deref() === undefined) refs.delete(k); };

  // ── the quiet-DOM watcher ───────────────────────────────────────────────────────────────────────
  let lastMutation = performance.now() - 1e6;
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

  // ── secrets ─────────────────────────────────────────────────────────────────────────────────────
  const REDACTED = "<redacted>";
  const TOKEN_PATTERNS: RegExp[] = [
    /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?/g,   // a JWT
    /\bsk-[A-Za-z0-9_-]{16,}/g,                                       // API secret keys
    /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/g,            // GitHub tokens
    /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,                                // Slack tokens
    /\bAKIA[0-9A-Z]{16}\b/g,                                          // AWS access key ids
    /\b[0-9a-fA-F]{32,}\b/g,                                          // a long hex run
  ];
  const B64_RUN = /[A-Za-z0-9+/_=-]{32,}/g;
  const tokenish = (run: string): boolean => {
    // A base64-looking run reads as a secret only when it mixes classes and is not a path or a word chain.
    if (!/[0-9]/.test(run) || !/[A-Z]/.test(run) || !/[a-z]/.test(run)) return false;
    if ((run.match(/\//g) ?? []).length > 2) return false;
    if ((run.match(/-/g) ?? []).length > 3 && !/[0-9]{3,}/.test(run)) return false;
    return true;
  };
  const redactText = (s: string): string => {
    let out = s;
    for (const p of TOKEN_PATTERNS) out = out.replace(p, REDACTED);
    out = out.replace(B64_RUN, (m) => (tokenish(m) ? REDACTED : m));
    return out;
  };
  const looksSecret = (s: string): boolean => redactText(s) !== s;

  const SECURE_AUTOCOMPLETE = new Set(["current-password", "new-password", "one-time-code", "cc-number", "cc-csc", "cc-exp", "cc-exp-month", "cc-exp-year"]);
  const PAYMENT_HOSTS = [
    "stripe.com", "stripe.network", "braintreegateway.com", "braintree-api.com", "adyen.com", "adyenpayments.com", "checkout.com",
    "paypal.com", "paypalobjects.com", "squareup.com", "squarecdn.com", "recurly.com", "chargebee.com", "klarna.com", "spreedly.com",
    "authorize.net", "worldpay.com", "globalpay.com", "pay.google.com", "payments.amazon.com", "afterpay.com", "affirm.com",
  ];
  const inPaymentFrame = ((): boolean => {
    if (window.top === window) return false;
    const host = location.hostname.toLowerCase();
    return PAYMENT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  })();

  const TEXT_INPUT_TYPES = new Set(["", "text", "search", "email", "url", "tel", "number", "password", "date", "datetime-local", "month", "week", "time"]);
  const isTextEntry = (el: Element): boolean => {
    if (el instanceof HTMLTextAreaElement) return true;
    if (el instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(el.type.toLowerCase());
    return (el as HTMLElement).isContentEditable === true;
  };
  const isSecure = (el: Element): boolean => {
    if (el instanceof HTMLInputElement && el.type.toLowerCase() === "password") return true;
    const ac = (el.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/);
    if (ac.some((t) => SECURE_AUTOCOMPLETE.has(t))) return true;
    return inPaymentFrame && isTextEntry(el);
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

  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "TITLE", "SVG", "PATH", "BR", "HR", "WBR"]);
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
  const cap = (s: string, n = 200): string => (s.length <= n ? s : `${s.slice(0, n)}…`);

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
  const NAME_FROM_CONTENT = new Set(["button", "link", "heading", "tab", "option", "menuitem", "menuitemcheckbox", "menuitemradio", "treeitem", "cell", "columnheader", "rowheader", "switch"]);
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
  const textOf = (n: Node, budget = 400): string => {
    let out = "";
    const walk = (x: Node): void => {
      if (out.length > budget) return;
      if (x.nodeType === Node.TEXT_NODE) { out += x.textContent ?? ""; return; }
      if (!(x instanceof Element)) { for (const c of composedChildren(x)) walk(c); return; }
      if (SKIP.has(x.tagName.toUpperCase())) return;
      if (x.getAttribute("aria-hidden") === "true") return;
      if (x instanceof HTMLImageElement) { out += ` ${x.alt} `; return; }
      if (x instanceof HTMLInputElement && x.type.toLowerCase() !== "hidden" && !isSecure(x)) { out += ` ${x.value} `; return; }
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
        const s = collapse([...labels].map((l) => textOf(l)).join(" "));
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
      const aria = el.getAttribute("aria-checked");
      const checked = el instanceof HTMLInputElement ? el.checked : aria === "true";
      if (el instanceof HTMLInputElement && el.indeterminate) out.push("mixed");
      else if (aria === "mixed") out.push("mixed");
      else out.push(checked ? "checked" : "unchecked");
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
  interface WalkCtx { emitted: number; visited: number; maxNodes: number; unread: number; active: Element | null }
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
    if (v.value !== undefined && (v.value !== name || v.secure === true)) node.value = cap(v.value);
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
      // A name read from the content is not read again as text — unless (a table cell) it holds controls.
      if (role !== undefined && NAME_FROM_CONTENT.has(role)) {
        const cellLike = role === "cell" || role === "columnheader" || role === "rowheader";
        if (!cellLike || child.querySelector(INTERACTIVE_SELECTOR) === null) continue;
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

  const snapshot = (arg: { within?: RtId; maxNodes?: number } | null): RtSnapshot => {
    prune();
    const ctx: WalkCtx = { emitted: 0, visited: 0, maxNodes: Math.min(10_000, Math.max(50, arg?.maxNodes ?? 4_000)), unread: 0, active: deepActive() };
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
        out.push({ id: n.id, role: n.role, ...(n.name === undefined ? {} : { name: n.name }), ...(n.value === undefined ? {} : { value: n.value }), ...(n.states === undefined ? {} : { states: n.states }) });
      }
      for (const c of n.children ?? []) visit(c);
    };
    for (const r of snap.roots) visit(r);
    return out;
  };

  // ── readable text ───────────────────────────────────────────────────────────────────────────────
  const BOILERPLATE = new Set(["NAV", "HEADER", "FOOTER", "ASIDE"]);
  const readable = (markdown: boolean): string => {
    const main = document.querySelector("main, [role=main], article") ?? document.body;
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
        if (label.length > 0) { line += ` [${label}](${(n as HTMLAnchorElement).href}) `; return; }
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
  const deepFromPoint = (x: number, y: number): Element | null => {
    let hit = document.elementFromPoint(x, y);
    while (hit !== null && hit.shadowRoot !== null) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (inner === null || inner === hit) break;
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
  const point = (arg: { id: RtId; scroll?: boolean }): RtPoint => {
    const el = elementOf(arg.id);
    if (el === undefined) return { ok: false, reason: "gone" };
    if (isDisabled(el)) return { ok: false, reason: "disabled" };
    const st = styleOf(el);
    if (hidden(el, st)) return { ok: false, reason: "hidden" };
    let r = visibleRect(el);
    if (r === undefined) return { ok: false, reason: "hidden" };
    if (!inViewport(r) && arg.scroll !== false) {
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
      r = visibleRect(el);
      if (r === undefined) return { ok: false, reason: "hidden" };
    }
    if (!inViewport(r)) return { ok: false, reason: "offscreen" };
    const left = Math.max(r.left, 0), right = Math.min(r.right, innerWidth), top = Math.max(r.top, 0), bottom = Math.min(r.bottom, innerHeight);
    const x = (left + right) / 2, y = (top + bottom) / 2;
    const hit = deepFromPoint(x, y);
    if (hit === null) return { ok: true, x, y };
    if (composedContains(el, hit)) return { ok: true, x, y };
    // A label that clicks through to its control, or a control inside the element's own label.
    if (hit instanceof HTMLLabelElement && hit.control === el) return { ok: true, x, y };
    if (el instanceof HTMLLabelElement && el.control !== null && composedContains(el.control, hit)) return { ok: true, x, y };
    const by = coverOf(hit);
    const byRole = roleOf(by);
    const name = nameOf(by, byRole);
    return { ok: false, reason: "covered", by: { id: idOf(by), role: byRole === undefined ? by.tagName.toLowerCase() : roleWord(byRole, by), ...(name === undefined ? {} : { name: cap(name, 80) }) } };
  };
  const classify = (arg: { id?: RtId } | null): RtClassify => {
    let el: Element | null | undefined;
    if (arg?.id !== undefined) {
      el = elementOf(arg.id);
      if (el === undefined) return { kind: "unknown" };
    } else el = deepActive();
    if (el === null || el === undefined) return { kind: "unknown" };
    if (el instanceof HTMLIFrameElement || el.tagName === "FRAME") return { kind: "frame", id: idOf(el) };
    if (el === document.body || el === document.documentElement) return { kind: "ok", editable: false };
    if (isSecure(el)) return { kind: "secure", id: idOf(el) };
    const role = roleOf(el);
    const name = nameOf(el, role);
    return { kind: "ok", editable: isTextEntry(el), id: idOf(el), ...(role === undefined ? {} : { role: roleWord(role, el) }), ...(name === undefined ? {} : { name: cap(name, 80) }) };
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
  const setValue = (arg: { id: RtId; value: string }): { ok: true; shown: string } | { ok: false; reason: string } => {
    const el = elementOf(arg.id);
    if (el === undefined) return { ok: false, reason: "gone" };
    if (isSecure(el)) return { ok: false, reason: "secure_field" };
    if (isDisabled(el)) return { ok: false, reason: "disabled" };
    if (el instanceof HTMLSelectElement) {
      const want = arg.value.trim().toLowerCase();
      const opt = [...el.options].find((o) => collapse(o.label || o.text).toLowerCase() === want) ?? [...el.options].find((o) => o.value.toLowerCase() === want)
        ?? [...el.options].find((o) => collapse(o.label || o.text).toLowerCase().includes(want));
      if (opt === undefined) return { ok: false, reason: `no option "${cap(arg.value, 60)}" — the options are: ${[...el.options].slice(0, 20).map((o) => `"${cap(collapse(o.label || o.text), 40)}"`).join(", ")}` };
      el.value = opt.value;
      fire(el, "input"); fire(el, "change");
      return { ok: true, shown: collapse(opt.label || opt.text) };
    }
    if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) return { ok: false, reason: "a check box or radio button takes click(), not setValue()" };
    if (el instanceof HTMLInputElement && el.type === "file") return { ok: false, reason: "a file input takes upload(ref, paths)" };
    const set = nativeSetter(el);
    if (set !== undefined) {
      (el as HTMLElement).focus?.({ preventScroll: true });
      set(arg.value);
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
    const el = elementOf(arg.id);
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
  const readValue = (arg: { id: RtId }): string | null => {
    const el = elementOf(arg.id);
    if (el === undefined || isSecure(el)) return null;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value;
    if ((el as HTMLElement).isContentEditable === true) return (el as HTMLElement).innerText ?? el.textContent;
    return null;
  };
  const fileInput = (arg: { id: RtId }): { ok: true; multiple: boolean } | { ok: false; reason: string } => {
    const el = elementOf(arg.id);
    if (el === undefined) return { ok: false, reason: "gone" };
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
    if (met && c.ids !== undefined && c.ids.some((id) => elementOf(id) === undefined)) met = false;
    if (met && c.goneIds !== undefined && c.goneIds.some((id) => elementOf(id) !== undefined)) met = false;
    const seenText = collapse(vt()).slice(0, 300);
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
  const frameOffset = (arg: { id: RtId }): { x: number; y: number } | null => {
    const el = elementOf(arg.id);
    if (el === undefined) return null;
    const r = el.getBoundingClientRect();
    const st = styleOf(el);
    const px = (v: string | undefined): number => { const n = parseFloat(v ?? "0"); return Number.isFinite(n) ? n : 0; };
    return { x: r.left + px(st?.borderLeftWidth) + px(st?.paddingLeft), y: r.top + px(st?.borderTopWidth) + px(st?.paddingTop) };
  };

  // ── the entry ───────────────────────────────────────────────────────────────────────────────────
  const call = (op: string, arg: unknown, self: unknown): unknown => {
    const a = (arg ?? null) as Any | null;
    switch (op) {
      case "hello": return { id: RUNTIME_ID, url: location.href, title: document.title, readyState: document.readyState };
      case "snapshot": return snapshot(a as { within?: RtId; maxNodes?: number } | null);
      case "find": return find((a ?? {}) as RtFindQuery);
      case "text": return readable(a?.markdown === true);
      case "owner": return self instanceof Node ? idOf(self) : null;
      case "frameOffset": return frameOffset(a as { id: RtId });
      case "point": return point(a as { id: RtId; scroll?: boolean });
      case "classify": return classify(a as { id?: RtId } | null);
      case "focus": return focus(a as { id: RtId });
      case "setValue": return setValue(a as { id: RtId; value: string });
      case "select": return select(a as { id: RtId; text: string; before?: string; after?: string; caret?: "start" | "end" });
      case "readValue": return readValue(a as { id: RtId });
      case "fileInput": return fileInput(a as { id: RtId });
      case "element": return elementOf((a as { id: RtId }).id) ?? null;
      case "pasteEvent": return pasteEvent(a as { html?: string; text: string });
      case "quiet": return { sinceMutationMs: Math.max(0, Math.round(performance.now() - lastMutation)), url: location.href, title: document.title, readyState: document.readyState };
      case "waitChange": return waitChange(a as { maxMs: number });
      case "check": return check((a ?? {}) as RtCondition);
      case "alive": return ((a as { ids: RtId[] }).ids ?? []).filter((id) => elementOf(id) !== undefined);
      default: throw new Error(`unknown op ${op}`);
    }
  };

  Object.defineProperty(G, "__winterRuntime", { value: Object.freeze({ id: RUNTIME_ID, call }), enumerable: false, configurable: false, writable: false });
})();
