// Winter for Chrome — the toolbar popup: one sentence saying whether Winter can use this browser; the switches for the
// optional permissions (history, bookmarks, a file a page makes); and — while Winter has handed the tab in front to the
// user (a sign-in) — Done / Stop waiting for it, with Stop for the tabs Winter is still driving (the button is the popup
// then, not Stop).
declare const chrome: any;

const line = document.getElementById("status");
const backend = document.getElementById("backend");
const waiting = document.getElementById("waiting");
const doneButton = document.getElementById("done");
const stopButton = document.getElementById("stop");
const driving = document.getElementById("driving");
const drivingLine = document.getElementById("driving-line");
const stopAllButton = document.getElementById("stop-all");

async function frontTabId(): Promise<number | undefined> {
  // This window's tabs, and the one in front (read only: nothing here moves anything).
  const tabs = (await chrome.tabs.query({ currentWindow: true })) as Array<{ id?: number; active?: boolean }>;
  return tabs.find((t) => t.active === true)?.id;
}

function answer(tabId: number, isDone: boolean): void {
  void chrome.runtime.sendMessage({ type: "winter.userDone", tabId, done: isDone }).finally(() => window.close());
}

/** The optional permissions' switches: each asks the browser on the user's own click (a request needs it), or gives
 *  the permission back. One Winter asked for and lacks is highlighted. */
async function permissionSwitches(needed: string[]): Promise<void> {
  for (const box of Array.from(document.querySelectorAll<HTMLInputElement>("input[data-permission]"))) {
    const name = box.dataset.permission ?? "";
    box.checked = (await chrome.permissions.contains({ permissions: [name] })) === true;
    if (needed.includes(name) && !box.checked) box.parentElement?.classList.add("needed");
    box.addEventListener("change", () => {
      const ask = box.checked ? chrome.permissions.request({ permissions: [name] }) : chrome.permissions.remove({ permissions: [name] });
      void ask.then((ok: boolean) => {
        if (!ok) box.checked = !box.checked;
        if (box.checked) box.parentElement?.classList.remove("needed");
      }, () => { box.checked = !box.checked; });
    });
  }
}

chrome.runtime.sendMessage({ type: "winter.status" }).then(
  async (r: { state?: string; sentence?: string; backend?: { id: string; name: string }; waiting?: number[]; driven?: number; needs?: string[] } | undefined) => {
    void permissionSwitches(r?.needs ?? []);
    if (line !== null) line.textContent = r?.sentence ?? "Winter for Chrome is starting…";
    if (backend !== null && r?.backend !== undefined) backend.textContent = `Winter calls this browser "${r.backend.id}".`;
    document.body.dataset.state = r?.state ?? "connecting";
    const front = (r?.waiting ?? []).length > 0 ? await frontTabId() : undefined;
    if (front !== undefined && (r?.waiting ?? []).includes(front) && waiting !== null) {
      waiting.hidden = false;
      doneButton?.addEventListener("click", () => answer(front, true));
      stopButton?.addEventListener("click", () => answer(front, false));
    }
    const driven = r?.driven ?? 0;
    if (driven > 0 && driving !== null) {
      driving.hidden = false;
      if (drivingLine !== null) drivingLine.textContent = `Winter is also working in ${driven === 1 ? "a tab" : `${driven} tabs`} of this browser.`;
      stopAllButton?.addEventListener("click", () => { void chrome.runtime.sendMessage({ type: "winter.stopDriven" }).finally(() => window.close()); });
    }
  },
  () => { if (line !== null) line.textContent = "Winter for Chrome is starting…"; },
);
