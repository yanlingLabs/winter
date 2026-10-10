// Winter for Chrome — the toolbar popup: one sentence saying whether Winter can use this browser.
declare const chrome: any;

const line = document.getElementById("status");
const backend = document.getElementById("backend");

chrome.runtime.sendMessage({ type: "winter.status" }).then(
  (r: { state?: string; sentence?: string; backend?: { id: string; name: string } } | undefined) => {
    if (line !== null) line.textContent = r?.sentence ?? "Winter for Chrome is starting…";
    if (backend !== null && r?.backend !== undefined) backend.textContent = `Winter calls this browser "${r.backend.id}".`;
    document.body.dataset.state = r?.state ?? "connecting";
  },
  () => { if (line !== null) line.textContent = "Winter for Chrome is starting…"; },
);
