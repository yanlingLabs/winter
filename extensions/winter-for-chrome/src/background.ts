// Winter for Chrome — the service worker. It binds the real `chrome.*` to the extension's pieces: the controller (the
// daemon's requests and the browser's events), the native port to `winter-browser-host`, and the toolbar status.
import type { ChromeApi, ChromePort } from "./chrome-api";
import { HostConnection } from "./connection";
import { ExtensionController } from "./controller";
import { StatusBoard, statusSentence } from "./status";

/** The native-messaging host this build talks to: `com.winter.browser` (store) or `com.winter.browser.dev` (dev). Set by
 *  scripts/build.ts. */
declare const __WINTER_HOST_NAME__: string;
// The real extension API, typed only as far as `ChromeApi` needs.
declare const chrome: any;

const api: ChromeApi = {
  runtimeId: chrome.runtime.id as string,
  extensionVersion: chrome.runtime.getManifest().version as string,
  lastError: () => chrome.runtime.lastError?.message as string | undefined,
  tabs: {
    get: (tabId) => chrome.tabs.get(tabId),
    query: (q) => chrome.tabs.query(q),
    create: (p) => chrome.tabs.create(p),
    remove: (tabId) => chrome.tabs.remove(tabId),
    discard: (tabId) => chrome.tabs.discard(tabId),
    group: (p) => chrome.tabs.group(p),
    ungroup: (tabIds) => chrome.tabs.ungroup(tabIds),
    // The one property `tabs.update` is ever given here (it can't activate or move anything with only this).
    setMuted: async (tabId, muted) => { await chrome.tabs.update(tabId, { muted }); },
    // The sign-in hand-off's one door (the only activation anywhere in Winter for Chrome; `tabs.present` alone).
    bringForward: async (tabId, windowId) => {
      await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(windowId, { focused: true });
    },
    onRemoved: chrome.tabs.onRemoved,
    onActivated: chrome.tabs.onActivated,
  },
  tabGroups: {
    get: (groupId) => chrome.tabGroups.get(groupId),
    update: (groupId, p) => chrome.tabGroups.update(groupId, p),
    query: (q) => chrome.tabGroups.query(q),
    onRemoved: chrome.tabGroups.onRemoved,
  },
  windows: {
    getLastFocused: (q) => chrome.windows.getLastFocused(q),
    getAll: (q) => chrome.windows.getAll(q),
  },
  debugger: {
    attach: (target, version) => chrome.debugger.attach(target, version),
    detach: (target) => chrome.debugger.detach(target),
    sendCommand: (target, method, params) => chrome.debugger.sendCommand(target, method, params),
    onEvent: chrome.debugger.onEvent,
    onDetach: chrome.debugger.onDetach,
  },
  scripting: {
    executeScript: (i) => chrome.scripting.executeScript(i),
  },
  storage: {
    local: { get: (keys) => chrome.storage.local.get(keys), set: (items) => chrome.storage.local.set(items) },
    session: { get: (keys) => chrome.storage.session.get(keys), set: (items) => chrome.storage.session.set(items) },
  },
  action: {
    setBadgeText: (p) => chrome.action.setBadgeText(p),
    setBadgeBackgroundColor: (p) => chrome.action.setBadgeBackgroundColor(p),
    setTitle: (p) => chrome.action.setTitle(p),
    setPopup: (p) => chrome.action.setPopup(p),
    onClicked: chrome.action.onClicked,
  },
  runtime: {
    connectNative: (application) => chrome.runtime.connectNative(application) as ChromePort,
    onMessage: chrome.runtime.onMessage,
  },
  permissions: {
    contains: (p) => chrome.permissions.contains(p),
    onAdded: chrome.permissions.onAdded,
    onRemoved: chrome.permissions.onRemoved,
  },
  // Read when needed: each API exists only while its optional permission is granted. History and bookmarks are bound
  // to their read-only members alone.
  optional: () => ({
    ...(chrome.history === undefined ? {} : { history: { search: (q: unknown) => chrome.history.search(q) } }),
    ...(chrome.bookmarks === undefined ? {} : {
      bookmarks: {
        search: (q: string) => chrome.bookmarks.search(q),
        getRecent: (n: number) => chrome.bookmarks.getRecent(n),
        get: (id: string) => chrome.bookmarks.get(id),
      },
    }),
    ...(chrome.downloads === undefined ? {} : {
      downloads: {
        search: (q: unknown) => chrome.downloads.search(q),
        erase: (q: unknown) => chrome.downloads.erase(q),
        cancel: (id: number) => chrome.downloads.cancel(id),
        onCreated: chrome.downloads.onCreated,
        onDeterminingFilename: chrome.downloads.onDeterminingFilename,
        onChanged: chrome.downloads.onChanged,
      },
    }),
  }),
  randomUUID: () => crypto.randomUUID(),
};

const log = (line: string): void => console.log(`[winter] ${line}`);
const status = new StatusBoard(api);
let connection: HostConnection | undefined;
const controller = new ExtensionController(api, {
  notify: (method, params) => connection?.notify(method, params),
  onDriven: (count) => status.setDriven(count),
  onWaiting: (count) => status.setWaiting(count),
  onNeeds: (needs) => status.setNeeds(needs.length),
  log,
});
connection = new HostConnection(api, controller, status, { hostName: __WINTER_HOST_NAME__, log });

// Listeners are registered synchronously at the top level (an MV3 worker woken by an event must find them).
// The worker must also START with the browser — an MV3 worker runs only for an event it listens to, so without these a
// browser restart would leave Winter for Chrome asleep (and Winter unable to reach it) until some tab closed. They also
// tell the controller WHY it started: after a browser start the agent-tab record is stale and is cleared; after an
// update of the extension it still describes open tabs and is kept.
chrome.runtime.onStartup.addListener(() => controller.noteLaunch("startup"));
chrome.runtime.onInstalled.addListener((details: { reason?: string }) => {
  controller.noteLaunch(details.reason === "update" ? "update" : details.reason === "chrome_update" ? "startup" : "install");
});
api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (typeof message !== "object" || message === null || sender.id !== api.runtimeId) return undefined;
  const m = message as { type?: unknown; tabId?: unknown; done?: unknown };
  if (m.type === "winter.status") {
    const s = status.get();
    sendResponse({ state: s.state, sentence: statusSentence(s), waiting: controller.waitingTabs(), driven: status.drivenTabs(), needs: controller.neededPermissions(), ...(s.state === "connected" ? { backend: s.backend } : {}) });
  } else if (m.type === "winter.userDone" && typeof m.tabId === "number" && typeof m.done === "boolean") {
    // The popup's Done / Stop waiting for a tab Winter handed to the user.
    sendResponse({ ok: controller.userDone(m.tabId, m.done) });
  } else if (m.type === "winter.stopDriven") {
    // The popup's Stop, while a hand-off keeps the button a popup.
    sendResponse({ ok: controller.stopDriven() });
  }
  return undefined;
});

void controller.start().then(() => connection?.start(), (err: unknown) => {
  log(`could not start: ${err instanceof Error ? err.message : String(err)}`);
  connection?.start();
});
