// Winter for Chrome — the overlay on a tab Winter is driving: a glow around the page, Winter's cursor where it acts,
// and a Stop button. Injected on demand with `chrome.scripting.executeScript({ world: "ISOLATED" })` — the extension's
// own content-script world, never the page's main world — and removed when the engine says the tab is no longer
// driven. No declared content scripts.
//
// `drawOverlay` is SERIALIZED by Chrome (its source text is what runs), so it must use nothing outside its own body.
// Everything it draws sits in a CLOSED shadow root under one `<winter-agent-overlay>` element, so the page can neither
// reach the button nor see the cursor move (a page's MutationObserver on the document never sees shadow-root changes:
// the only mutations it can observe are that element's arrival and departure). Styles go through a constructed
// stylesheet, which a page's CSP does not block. The element passes pointer events through, except the Stop button,
// whose click counts only when the user made it (`isTrusted`).

export const OVERLAY_TAG = "winter-agent-overlay";

export interface OverlayArgs {
  active: boolean;
  cursor?: { x: number; y: number; kind: string };
  stopLabel?: string;
}

export function drawOverlay(a: OverlayArgs): void {
  const TAG = "winter-agent-overlay";
  const KEY = "__winterAgentOverlay";
  const w = window as unknown as Record<string, { host: HTMLElement; cursor: HTMLElement; button: HTMLButtonElement } | undefined>;
  const existing = w[KEY];
  if (!a.active) {
    if (existing !== undefined) existing.host.remove();
    w[KEY] = undefined;
    return;
  }
  let st = existing;
  if (st === undefined || !st.host.isConnected) {
    const host = document.createElement(TAG);
    host.style.setProperty("all", "initial");
    host.style.setProperty("position", "fixed");
    host.style.setProperty("inset", "0");
    host.style.setProperty("z-index", "2147483647");
    host.style.setProperty("pointer-events", "none");
    host.style.setProperty("display", "block");
    const root = host.attachShadow({ mode: "closed" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
      .glow { position: fixed; inset: 0; pointer-events: none; border-radius: 2px;
        box-shadow: inset 0 0 0 3px rgba(96, 148, 255, 0.95), inset 0 0 28px 8px rgba(96, 148, 255, 0.35);
        animation: winter-pulse 2.4s ease-in-out infinite; }
      @keyframes winter-pulse { 50% { box-shadow: inset 0 0 0 3px rgba(96, 148, 255, 0.7), inset 0 0 40px 12px rgba(96, 148, 255, 0.22); } }
      .cursor { position: fixed; left: 0; top: 0; width: 18px; height: 18px; margin: -9px 0 0 -9px; border-radius: 50%;
        pointer-events: none; display: none; background: rgba(96, 148, 255, 0.35); border: 2px solid rgba(96, 148, 255, 0.95);
        box-shadow: 0 0 10px rgba(96, 148, 255, 0.6); transition: transform 120ms ease-out; }
      .cursor[data-kind="press"] { background: rgba(96, 148, 255, 0.7); }
      .cursor[data-kind="type"] { border-radius: 3px; width: 4px; margin-left: -2px; }
      .cursor[data-kind="scroll"] { border-style: dashed; }
      button { position: fixed; right: 16px; bottom: 16px; pointer-events: auto; cursor: pointer;
        font: 600 13px/1 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; color: #fff;
        background: rgba(30, 40, 60, 0.92); border: 1px solid rgba(96, 148, 255, 0.9); border-radius: 999px;
        padding: 9px 14px; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3); }
      button:hover { background: rgba(50, 64, 92, 0.95); }
    `);
    root.adoptedStyleSheets = [sheet];
    const glow = document.createElement("div");
    glow.className = "glow";
    const cursor = document.createElement("div");
    cursor.className = "cursor";
    const button = document.createElement("button");
    button.type = "button";
    button.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!e.isTrusted) return;
      button.disabled = true;
      button.textContent = "Stopping…";
      void chrome.runtime.sendMessage({ type: "winter.stop" }).catch(() => undefined);
    }, true);
    root.append(glow, cursor, button);
    (document.documentElement ?? document.body).appendChild(host);
    st = { host, cursor, button };
    w[KEY] = st;
  }
  st.button.textContent = a.stopLabel ?? "Stop Winter";
  st.button.disabled = false;
  if (a.cursor !== undefined && Number.isFinite(a.cursor.x) && Number.isFinite(a.cursor.y)) {
    st.cursor.style.display = "block";
    st.cursor.style.transform = `translate(${Math.round(a.cursor.x)}px, ${Math.round(a.cursor.y)}px)`;
    st.cursor.dataset.kind = a.cursor.kind;
  }
}

declare const chrome: { runtime: { sendMessage(message: unknown): Promise<unknown> } };
