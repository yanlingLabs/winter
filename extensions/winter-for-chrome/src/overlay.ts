// Winter for Chrome — the overlay on a tab Winter is driving: a glow around the page, Winter's cursor where it acts,
// and a small "Winter is working" pill. It is an INDICATOR only: nothing in it takes a pointer event, so every click
// Winter's engine sends through `Input.*` reaches the page element underneath, and the page cannot use it either. Stop
// is the extension's toolbar button (a click there while a tab is driven stops Winter), never something in the page,
// where a page could hide or imitate it.
//
// Injected on demand with `chrome.scripting.executeScript({ world: "ISOLATED" })` — the extension's own content-script
// world, never the page's main world — and removed when the engine says the tab is no longer driven. No declared
// content scripts. `drawOverlay` is SERIALIZED by Chrome (its source text is what runs), so it must use nothing outside
// its own body. Everything it draws sits in a CLOSED shadow root under one `<winter-agent-overlay>` element (a page's
// MutationObserver on the document never sees shadow-root changes: only that element's arrival and departure); its own
// styles are set `!important`, so a page's CSS cannot hide or move it; inner styles go through a constructed stylesheet,
// which a page's CSP does not block. Winter's engine leaves the element out of its tree walk and hit tests.

export const OVERLAY_TAG = "winter-agent-overlay";

export interface OverlayArgs {
  active: boolean;
  cursor?: { x: number; y: number; kind: string };
  label?: string;
}

export function drawOverlay(a: OverlayArgs): void {
  const TAG = "winter-agent-overlay";
  const KEY = "__winterAgentOverlay";
  const w = window as unknown as Record<string, { host: HTMLElement; cursor: HTMLElement; pill: HTMLElement } | undefined>;
  const existing = w[KEY];
  if (!a.active) {
    if (existing !== undefined) existing.host.remove();
    w[KEY] = undefined;
    return;
  }
  let st = existing;
  if (st === undefined || !st.host.isConnected) {
    const host = document.createElement(TAG);
    const hostStyle: [string, string][] = [
      ["all", "initial"], ["position", "fixed"], ["inset", "0"], ["width", "100vw"], ["height", "100vh"], ["z-index", "2147483647"],
      ["pointer-events", "none"], ["display", "block"], ["visibility", "visible"], ["opacity", "1"], ["transform", "none"], ["filter", "none"],
      ["clip-path", "none"], ["margin", "0"], ["border", "0"], ["padding", "0"],
    ];
    for (const [k, v] of hostStyle) host.style.setProperty(k, v, "important");
    const root = host.attachShadow({ mode: "closed" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
      :host, * { pointer-events: none !important; }
      .glow { position: fixed; inset: 0; border-radius: 2px;
        box-shadow: inset 0 0 0 3px rgba(96, 148, 255, 0.95), inset 0 0 28px 8px rgba(96, 148, 255, 0.35);
        animation: winter-pulse 2.4s ease-in-out infinite; }
      @keyframes winter-pulse { 50% { box-shadow: inset 0 0 0 3px rgba(96, 148, 255, 0.7), inset 0 0 40px 12px rgba(96, 148, 255, 0.22); } }
      .cursor { position: fixed; left: 0; top: 0; width: 18px; height: 18px; margin: -9px 0 0 -9px; border-radius: 50%;
        display: none; background: rgba(96, 148, 255, 0.35); border: 2px solid rgba(96, 148, 255, 0.95);
        box-shadow: 0 0 10px rgba(96, 148, 255, 0.6); transition: transform 120ms ease-out; }
      .cursor[data-kind="press"] { background: rgba(96, 148, 255, 0.7); }
      .cursor[data-kind="type"] { border-radius: 3px; width: 4px; margin-left: -2px; }
      .cursor[data-kind="scroll"] { border-style: dashed; }
      .pill { position: fixed; right: 16px; bottom: 16px; user-select: none;
        font: 600 12px/1 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; color: #fff;
        background: rgba(30, 40, 60, 0.88); border: 1px solid rgba(96, 148, 255, 0.9); border-radius: 999px;
        padding: 7px 12px; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3); }
    `);
    root.adoptedStyleSheets = [sheet];
    const glow = document.createElement("div");
    glow.className = "glow";
    const cursor = document.createElement("div");
    cursor.className = "cursor";
    const pill = document.createElement("div");
    pill.className = "pill";
    root.append(glow, cursor, pill);
    (document.documentElement ?? document.body).appendChild(host);
    st = { host, cursor, pill };
    w[KEY] = st;
  }
  st.pill.textContent = a.label ?? "Winter is working — stop it from the toolbar";
  if (a.cursor !== undefined && Number.isFinite(a.cursor.x) && Number.isFinite(a.cursor.y)) {
    st.cursor.style.display = "block";
    st.cursor.style.transform = `translate(${Math.round(a.cursor.x)}px, ${Math.round(a.cursor.y)}px)`;
    st.cursor.dataset.kind = a.cursor.kind;
  }
}
