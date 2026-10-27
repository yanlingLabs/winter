// Winter for Chrome — the service worker. It binds the real `chrome.*` to the extension's pieces: the controller (the
// daemon's requests and the browser's events), the native port to `winter-browser-host`, and the toolbar status.
// Next version: a second client, opensky, with its own controller and its own native host — the port to it opened only while
// the user's switch for it in the popup is on (off by default; installing opensky's host grants nothing).
import type { ChromeApi, ChromePort, MessageSender } from "./chrome-api";
import { HostConnection } from "./connection";
import { ExtensionController, OPENSKY_CLIENT } from "./controller";
import { SECOND_CLIENT_FEATURES } from "./protocol";
import { ClientLink, StatusBoard, statusSentence } from "./status";

/** The native-messaging host this build talks to: `com.winter.browser` (store) or `com.winter.browser.dev` (dev). Set by
 *  scripts/build.ts. */
declare const __WINTER_HOST_NAME__: string;
/** opensky's host: `com.opensky.browser` (store) or `com.opensky.browser.dev` (dev). Set by scripts/build.ts. */
declare const __OPENSKY_HOST_NAME__: string;
/** storage.local: true only after the user turned opensky on in the popup. */
export const OPENSKY_CONSENT_KEY = "openskyConsent";
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
    onUpdated: chrome.tabs.onUpdated,
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
let openskyConnection: HostConnection | undefined;
// Each controller refuses, and leaves out of what it lists, the tabs the other one holds.
const controller: ExtensionController = new ExtensionController(api, {
  notify: (method, params) => connection?.notify(method, params),
  onDriven: (count) => status.setDriven(count),
  onWaiting: (count) => status.setWaiting(count),
  onNeeds: (needs) => status.setNeeds(needs.length),
  foreignTab: (tabId) => opensky.heldTab(tabId),
  foreignGroup: (groupId) => opensky.ownsGroup(groupId),
  log,
});
const opensky: ExtensionController = new ExtensionController(api, {
  client: OPENSKY_CLIENT,
  notify: (method, params) => openskyConnection?.notify(method, params),
  onDriven: (count) => status.setDriven(count, OPENSKY_CLIENT.name),
  foreignTab: (tabId) => controller.heldTab(tabId),
  foreignGroup: (groupId) => controller.ownsGroup(groupId),
  log: (line) => log(`opensky: ${line}`),
});
connection = new HostConnection(api, controller, status, { hostName: __WINTER_HOST_NAME__, log });
const openskyLink = new ClientLink(OPENSKY_CLIENT.name);
openskyConnection = new HostConnection(api, opensky, openskyLink, {
  hostName: __OPENSKY_HOST_NAME__, instanceKey: "openskyInstanceId", peer: OPENSKY_CLIENT.name, features: SECOND_CLIENT_FEATURES,
  log: (line) => log(`opensky: ${line}`),
});

/** The stored consent, as last read or set (what the popup's switch shows). */
let openskyConsent = false;
/** opensky's controller failed to start (its record may not be loaded, leftover debuggers not detached): its port is
 *  never opened in this worker, whatever the switch says. */
let openskyBroken = false;

async function openskyAllowed(): Promise<boolean> {
  try { openskyConsent = (await api.storage.local.get([OPENSKY_CONSENT_KEY]))[OPENSKY_CONSENT_KEY] === true; } catch { openskyConsent = false; }
  return openskyConsent;
}

void openskyAllowed(); // the popup's switch shows the stored consent from the worker's first moment

// Both controllers start (each one's listeners, its record of its tabs, and the debuggers a previous worker left attached
// for it detached). Winter's port opens once Winter has started and opensky's RECORD is loaded (so Winter can tell
// opensky's tabs from the user's; tabs opensky is still detaching count as opensky's) — never waiting on opensky's
// detaching. Every change to opensky's port — the start-up connect and each flip of the switch — runs in one chain
// that begins only after BOTH have fully started, in order, so a switch turned off can never lose to a connect already
// on its way, and opensky never connects before either record is loaded.
const winterStarted = controller.start();
const openskyStarted = opensky.start();
let openskyQueue: Promise<void> = Promise.allSettled([winterStarted, openskyStarted]).then(([, o]) => {
  if (o.status === "rejected") openskyBroken = true;
});
function openskyStep(step: () => Promise<void>): Promise<void> {
  const next = openskyQueue.then(step);
  openskyQueue = next.catch((err: unknown) => log(`opensky: ${err instanceof Error ? err.message : String(err)}`));
  return next;
}

/** The popup's switch for opensky: on opens its port, off closes it and gives its tabs back to the user. */
function setOpensky(allowed: boolean): Promise<void> {
  return openskyStep(async () => {
    await api.storage.local.set({ [OPENSKY_CONSENT_KEY]: allowed });
    openskyConsent = allowed;
    if (allowed) {
      if (openskyBroken) throw new Error("opensky could not start in this browser — reload the extension");
      opensky.reopen();
      openskyConnection?.start();
    } else {
      await openskyConnection?.stop();
      await opensky.disown();
      openskyLink.clear();
    }
  });
}

/** A message from this extension's own popup (not a content script in a tab, whose sender has a tab). */
const fromPopup = (sender: MessageSender): boolean =>
  sender.tab === undefined && typeof sender.url === "string" && sender.url.startsWith(`chrome-extension://${api.runtimeId}/popup.html`);

// Listeners are registered synchronously at the top level (an MV3 worker woken by an event must find them).
// The worker must also START with the browser — an MV3 worker runs only for an event it listens to, so without these a
// browser restart would leave Winter for Chrome asleep (and Winter unable to reach it) until some tab closed. They also
// tell the controller WHY it started: after a browser start the agent-tab record is stale and is cleared; after an
// update of the extension it still describes open tabs and is kept.
chrome.runtime.onStartup.addListener(() => { controller.noteLaunch("startup"); opensky.noteLaunch("startup"); });
chrome.runtime.onInstalled.addListener((details: { reason?: string }) => {
  const kind = details.reason === "update" ? "update" : details.reason === "chrome_update" ? "startup" : "install";
  controller.noteLaunch(kind);
  opensky.noteLaunch(kind);
});
api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (typeof message !== "object" || message === null || sender.id !== api.runtimeId) return undefined;
  // A wake watcher in a tab's top frame (the extension's own isolated world): an event to relay, or its heartbeat.
  if (controller.watchMessage(message, sender, sendResponse)) return undefined;
  const m = message as { type?: unknown; tabId?: unknown; done?: unknown };
  if (m.type === "winter.status") {
    const s = status.get();
    const o = openskyLink.get();
    sendResponse({
      state: s.state, sentence: statusSentence(s), waiting: controller.waitingTabs(), driven: status.drivenTabs(), drivers: status.drivers(),
      needs: controller.neededPermissions(), ...(s.state === "connected" ? { backend: s.backend } : {}),
      opensky: { allowed: openskyConsent, state: o?.state ?? (openskyConsent ? "connecting" : "off"), sentence: openskyConsent && o === undefined ? "Connecting to opensky…" : openskyLink.sentence() },
    });
  } else if (m.type === "winter.userDone" && typeof m.tabId === "number" && typeof m.done === "boolean") {
    // The popup's Done / Stop waiting for a tab Winter handed to the user.
    sendResponse({ ok: controller.userDone(m.tabId, m.done) });
  } else if (m.type === "winter.stopDriven") {
    // The popup's Stop, while a hand-off keeps the button a popup: every client's driven tabs.
    const winter = controller.stopDriven();
    const other = opensky.stopDriven();
    sendResponse({ ok: winter || other });
  } else if (m.type === "winter.setOpensky" && typeof (m as { allowed?: unknown }).allowed === "boolean" && fromPopup(sender)) {
    // The user's own switch in the popup — the only door that turns opensky on.
    void setOpensky((m as { allowed: boolean }).allowed).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }
  return undefined;
});

// opensky's record failing to load (its start rejecting) must not keep Winter from connecting.
const openskyRecord = Promise.race([opensky.recordLoaded(), openskyStarted]);
void Promise.allSettled([winterStarted, openskyRecord]).then(([w]) => {
  if (w.status === "rejected") log(`could not start: ${w.reason instanceof Error ? w.reason.message : String(w.reason)}`);
  connection?.start();
});
void openskyStarted.then(
  () => openskyStep(async () => { if (await openskyAllowed()) openskyConnection?.start(); }),
  (err: unknown) => log(`opensky: could not start: ${err instanceof Error ? err.message : String(err)}`),
);
