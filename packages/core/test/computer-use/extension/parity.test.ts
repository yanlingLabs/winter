// Winter for Chrome's facts, defined once per language and held together here: the two protocol numbers (daemon, host,
// extension, PROTOCOL.md), the extension-id allowlists (daemon, host, Winter.app's manifest writer, and the id the dev
// key derives), the native-host names, the host's codesign identities, and the browsers' manifest directories.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WINTER_TEAM_ID } from "../../../src/auth/app-token-acl";
import { BROWSER_HOST_IDENTIFIER, EXTENSION_IDS, extensionIdFromKey, NATIVE_HOST_NAME } from "../../../src/computer-use/browser/extension/extension-ids";
import { BROWSER_FAMILIES } from "../../../src/computer-use/browser/families";
import { NATIVE_MESSAGING_BROWSER_DIRS } from "../../../src/computer-use/browser/extension/manifest";
import { BROWSER_HOST_PROTOCOL, EXTENSION_PROTOCOL } from "../../../src/computer-use/browser/extension/protocol";

const REPO = join(import.meta.dir, "..", "..", "..", "..", "..");
const read = (...p: string[]) => readFileSync(join(REPO, ...p), "utf8");
const HOST = ["apple", "ComputerUse", "WinterBrowserHost"];
const hostSwift = (file: string) => read(...HOST, "Sources", "WinterBrowserHostCore", file);
const EXT = ["extensions", "winter-for-chrome"];

/** `static let <name> = <int>` in a Swift file. */
const swiftInt = (src: string, name: string): number => Number(new RegExp(`static let ${name} = (\\d+)`).exec(src)?.[1] ?? Number.NaN);
/** `static let <name>: [String] = [ "...", ... ]` in a Swift file. */
const swiftStrings = (src: string, name: string): string[] => {
  const body = new RegExp(`static let ${name}: \\[String\\] = \\[([\\s\\S]*?)\\]`).exec(src)?.[1];
  if (body === undefined) throw new Error(`no ${name} list`);
  return [...body.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
};
const swiftString = (src: string, name: string): string | undefined => new RegExp(`static let ${name} = "([^"]*)"`).exec(src)?.[1];

describe("the protocol numbers", () => {
  test("daemon, host, extension and PROTOCOL.md agree", async () => {
    const spec = read(...HOST, "PROTOCOL.md");
    const specHost = Number(/^\*\*Browser-host protocol: (\d+)\*\*$/m.exec(spec)?.[1]);
    const specExt = Number(/^\*\*Extension protocol: (\d+)\*\*$/m.exec(spec)?.[1]);
    const swift = hostSwift("HostProtocol.swift");
    const ext = await import(join(REPO, ...EXT, "src", "protocol.ts")) as { BROWSER_HOST_PROTOCOL: number; EXTENSION_PROTOCOL: number };
    expect({ spec: specHost, swift: swiftInt(swift, "browserHost"), extension: ext.BROWSER_HOST_PROTOCOL }).toEqual({ spec: BROWSER_HOST_PROTOCOL, swift: BROWSER_HOST_PROTOCOL, extension: BROWSER_HOST_PROTOCOL });
    expect({ spec: specExt, swift: swiftInt(swift, "extensionProtocol"), extension: ext.EXTENSION_PROTOCOL }).toEqual({ spec: EXTENSION_PROTOCOL, swift: EXTENSION_PROTOCOL, extension: EXTENSION_PROTOCOL });
  });
});

describe("the extension ids", () => {
  test("the dev id is the one the dev build's manifest key derives — in the daemon, the host and nowhere else different", () => {
    const key = read(...EXT, "keys", "dev.pub").trim();
    const derived = extensionIdFromKey(key);
    expect(EXTENSION_IDS.dev).toEqual([derived]);
    expect(swiftStrings(hostSwift("ExtensionIds.swift"), "dev")).toEqual([derived]);
  });

  test("dist: the store ids, the same in the daemon, the host and Winter.app's manifest writer (none before the first upload)", () => {
    const app = read("apple", "Winter", "Sources", "BrowserExtension", "BrowserHostManifest.swift");
    expect(swiftStrings(hostSwift("ExtensionIds.swift"), "dist")).toEqual([...EXTENSION_IDS.dist]);
    expect(swiftStrings(app, "storeExtensionIds")).toEqual([...EXTENSION_IDS.dist]);
    for (const id of [...EXTENSION_IDS.dist, ...EXTENSION_IDS.dev]) expect(id).toMatch(/^[a-p]{32}$/);
  });

  test("the dev key is a public key only", () => {
    const key = read(...EXT, "keys", "dev.pub");
    expect(key).not.toContain("PRIVATE");
    expect(Buffer.from(key.trim(), "base64").length).toBeLessThan(600); // a 2048-bit SubjectPublicKeyInfo is 294 bytes
  });
});

describe("names and identities", () => {
  test("the native-host names: daemon, host, extension builds and Winter.app's writer", async () => {
    const identity = hostSwift("HostIdentity.swift");
    const ext = await import(join(REPO, ...EXT, "src", "manifest.ts")) as { HOST_NAME: { dev: string; store: string } };
    expect(swiftString(identity, "distNativeHostName")).toBe(NATIVE_HOST_NAME.dist);
    expect(swiftString(identity, "devNativeHostName")).toBe(NATIVE_HOST_NAME.dev);
    expect(ext.HOST_NAME).toEqual({ store: NATIVE_HOST_NAME.dist, dev: NATIVE_HOST_NAME.dev });
    expect(swiftString(read("apple", "Winter", "Sources", "BrowserExtension", "BrowserHostManifest.swift"), "hostName")).toBe(NATIVE_HOST_NAME.dist);
  });

  test("the host's codesign identities and the daemon identities it accepts", async () => {
    const identity = hostSwift("HostIdentity.swift");
    const lib = await import(join(REPO, "scripts", "computer-helper-lib.ts")) as { BROWSER_HOST: Record<string, { identifier: string }>; DAEMON_IDENTIFIER: { dist: string; dev: string } };
    expect(swiftString(identity, "distHostIdentifier")).toBe(BROWSER_HOST_IDENTIFIER.dist);
    expect(swiftString(identity, "devHostIdentifier")).toBe(BROWSER_HOST_IDENTIFIER.dev);
    expect(lib.BROWSER_HOST.dist!.identifier).toBe(BROWSER_HOST_IDENTIFIER.dist);
    expect(lib.BROWSER_HOST.dev!.identifier).toBe(BROWSER_HOST_IDENTIFIER.dev);
    expect(swiftString(identity, "testHostIdentifier")).toBe(lib.BROWSER_HOST.test!.identifier);
    expect(swiftString(identity, "distDaemonIdentifier")).toBe(lib.DAEMON_IDENTIFIER.dist);
    expect(swiftString(identity, "devDaemonIdentifier")).toBe(lib.DAEMON_IDENTIFIER.dev);
    expect(swiftString(identity, "teamID")).toBe(WINTER_TEAM_ID);
  });

  test("the browsers' manifest directories: the daemon-side writer and Winter.app's", () => {
    const app = read("apple", "Winter", "Sources", "BrowserExtension", "BrowserHostManifest.swift");
    expect(swiftStrings(app, "browserDirectories")).toEqual([...NATIVE_MESSAGING_BROWSER_DIRS]);
  });

  test("PROTOCOL.md names every browser family's bundle ids", () => {
    const spec = read(...HOST, "PROTOCOL.md");
    for (const bundleId of BROWSER_FAMILIES.flatMap((f) => f.bundleIds)) {
      const short = bundleId.replace(/^(com\.google\.Chrome|com\.microsoft\.edgemac)(\..+)$/, "$2");
      expect({ bundleId, named: spec.includes(`\`${bundleId}\``) || spec.includes(`\`${short}\``) }).toEqual({ bundleId, named: true });
    }
  });
});
