// ComputerV2 Phase 2 — who may talk to the daemon through `winter-browser-host`: the Winter for Chrome extension ids
// per profile, the native-messaging host names, and the host's own code identities. Defined once per language and kept
// equal by a repo test: here, the host's ExtensionIds.swift / HostIdentity.swift, Winter.app's manifest writer, and the
// id derived from the dev build's manifest `key` (extensions/winter-for-chrome/keys/dev.pub).
import { createHash } from "node:crypto";
import { WINTER_TEAM_ID } from "../../../auth/app-token-acl";
import type { WinterProfile } from "../../../profile";

/**
 * The extension ids each profile accepts.
 *  - dist: the Chrome Web Store and Edge Add-ons listings (publisher yanlingLabs). Their ids are assigned at the first
 *    upload, so until then dist has none and the user's browsers stay "not connected".
 *  - dev: the unpacked dev build, whose id is fixed by its manifest `key`.
 */
export const EXTENSION_IDS: Readonly<Record<WinterProfile, readonly string[]>> = {
  dist: [],
  dev: ["jikdcokcpbacalfeipkognejnlnobbbf"],
};

/** The native-messaging host name the extension connects to (`chrome.runtime.connectNative`). */
export const NATIVE_HOST_NAME: Readonly<Record<WinterProfile, string>> = {
  dist: "com.winter.browser",
  dev: "com.winter.browser.dev",
};

/** `winter-browser-host`'s codesign identifier (its stated designated requirement names it). */
export const BROWSER_HOST_IDENTIFIER: Readonly<Record<WinterProfile, string>> = {
  dist: "com.winter.browserhost",
  dev: "com.winter.browserhost.dev",
};

/** The host's executable name inside the helper bundle's `Contents/MacOS`. */
export const BROWSER_HOST_EXECUTABLE = "winter-browser-host";

/** The host's stated designated requirement: identifier + Winter's team under Apple's anchor (the helper's shape). */
export function browserHostRequirementFor(profile: WinterProfile, teamId: string = WINTER_TEAM_ID): string {
  return `identifier "${BROWSER_HOST_IDENTIFIER[profile]}" and anchor apple generic and certificate leaf[subject.OU] = "${teamId}"`;
}

const EXTENSION_ID = /^[a-p]{32}$/;

/** Chrome's id for an extension whose manifest `key` is `keyBase64` (a DER SubjectPublicKeyInfo): the first 128 bits
 *  of its SHA-256, each hex digit mapped 0-f → a-p. */
export function extensionIdFromKey(keyBase64: string): string {
  const der = Buffer.from(keyBase64, "base64");
  const hex = createHash("sha256").update(der).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode("a".charCodeAt(0) + Number.parseInt(c, 16))).join("");
}

/** The id in a `chrome-extension://<id>/` origin, or undefined when it is not exactly that shape. */
export function extensionIdFromOrigin(origin: string): string | undefined {
  const m = /^chrome-extension:\/\/([a-p]{32})\/$/.exec(origin);
  return m?.[1];
}

export function isExtensionId(id: string): boolean {
  return EXTENSION_ID.test(id);
}

/** `chrome-extension://<id>/` for each id (a host manifest's `allowed_origins`). */
export function allowedOrigins(ids: readonly string[]): string[] {
  return ids.map((id) => `chrome-extension://${id}/`);
}
