import { describe, expect, test } from "bun:test";
import { renderPlist, LAUNCHD_LABEL, migrateFromLaunchdAgent, launchdLabel } from "../src/launchd";

describe("renderPlist", () => {
  test("contains label, program arguments, keepalive, and log paths", () => {
    const xml = renderPlist({
      binaryPath: "/usr/local/bin/norma",
      normaHome: "/Users/me/.norma",
    });
    expect(xml).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(xml).toContain("<string>/usr/local/bin/norma</string>");
    expect(xml).toContain("<string>daemon</string>");
    expect(xml).toContain("<string>run</string>");
    expect(xml).toContain("<key>KeepAlive</key>");
    expect(xml).toContain("<string>/Users/me/.norma/logs/core.out.log</string>");
    expect(xml).toContain("<string>/Users/me/.norma/logs/core.err.log</string>");
    expect(xml).not.toContain("~"); // launchd does not expand tildes
    expect(xml).toContain("<key>NORMA_HOME</key>");
    expect(xml).toContain("<string>/Users/me/.norma</string>");
  });

  test("xml-escapes special characters in paths", () => {
    const xml = renderPlist({ binaryPath: "/a&b/norma", normaHome: "/home/x<y>/.norma" });
    expect(xml).toContain("/a&amp;b/norma");
    expect(xml).toContain("/home/x&lt;y&gt;/.norma");
    expect(xml).not.toMatch(/<string>[^<]*&(?!amp;|lt;|gt;)/);
  });
});

describe("migrateFromLaunchdAgent", () => {
  const fakePath = "/fake/Library/LaunchAgents/com.norma.core.plist";

  test("unloads an existing com.norma.core plist: bootout(label) then remove(path)", async () => {
    let bootoutLabel: string | undefined;
    let removedPath: string | undefined;

    await migrateFromLaunchdAgent({
      plistPath: fakePath,
      exists: (p) => p === fakePath,
      bootout: async (label) => { bootoutLabel = label; },
      remove: (p) => { removedPath = p; },
    });

    expect(bootoutLabel).toBe(LAUNCHD_LABEL);
    expect(removedPath).toBe(fakePath);
  });

  test("keeps the historical literal label regardless of NORMA_PROFILE", async () => {
    const prev = process.env.NORMA_PROFILE;
    process.env.NORMA_PROFILE = "dev";
    let bootoutLabel: string | undefined;
    try {
      await migrateFromLaunchdAgent({
        plistPath: fakePath,
        exists: (p) => p === fakePath,
        bootout: async (label) => { bootoutLabel = label; },
        remove: () => {},
      });
    } finally {
      if (prev === undefined) delete process.env.NORMA_PROFILE; else process.env.NORMA_PROFILE = prev;
    }
    expect(bootoutLabel).toBe("com.norma.core");
  });

  test("no-ops when the plist is absent: no bootout, no remove call, never throws", async () => {
    let bootoutCalled = false;
    let removeCalled = false;

    await expect(migrateFromLaunchdAgent({
      plistPath: fakePath,
      exists: () => false,
      bootout: async () => { bootoutCalled = true; },
      remove: () => { removeCalled = true; },
    })).resolves.toBeUndefined();

    expect(bootoutCalled).toBe(false);
    expect(removeCalled).toBe(false);
  });

  test("never throws even when bootout or remove fail", async () => {
    await expect(migrateFromLaunchdAgent({
      plistPath: fakePath,
      exists: () => true,
      bootout: async () => { throw new Error("launchctl bootout failed"); },
      remove: () => { throw new Error("unlink failed"); },
    })).resolves.toBeUndefined();
  });
});

describe("launchd profile label", () => {
  test("label derives from profile, dist literal unchanged", () => {
    expect(launchdLabel("dist")).toBe("com.norma.core");
    expect(launchdLabel("dev")).toBe("com.norma.core.dev");
  });

  test("renderPlist embeds the profile label", () => {
    const dev = renderPlist({ binaryPath: "/x/norma-core", normaHome: "/tmp/h", profile: "dev" });
    expect(dev).toContain("<string>com.norma.core.dev</string>");
    const dist = renderPlist({ binaryPath: "/x/norma-core", normaHome: "/tmp/h", profile: "dist" });
    expect(dist).toContain("<string>com.norma.core</string>");
    expect(dist).not.toContain("com.norma.core.dev");
  });

  // DD branch review (I3): NORMA_PROFILE must ride along in the plist's own EnvironmentVariables
  // for a dev-profile install (otherwise a launchd-installed dev daemon resolves
  // `keychainService()` to the dist Keychain literal despite living in ~/.norma-dev — silent
  // credential cross-contamination), and the dist plist must stay byte-identical to before this
  // fix (no new key at all, not even an empty one).
  test("dev plist carries NORMA_PROFILE=dev; dist plist never mentions NORMA_PROFILE", () => {
    const dev = renderPlist({ binaryPath: "/x/norma-core", normaHome: "/tmp/h", profile: "dev" });
    expect(dev).toContain("<key>NORMA_PROFILE</key><string>dev</string>");

    const dist = renderPlist({ binaryPath: "/x/norma-core", normaHome: "/tmp/h", profile: "dist" });
    expect(dist).not.toContain("NORMA_PROFILE");
  });

  // Byte-identity proof: the dist plist output must be EXACTLY what renderPlist produced before
  // this fix, character for character — not just "doesn't contain NORMA_PROFILE". Passes
  // `profile: "dist"` explicitly (rather than relying on ambient `NORMA_PROFILE` env resolution)
  // so this assertion can never flake against another test's env mutation.
  test("dist plist is byte-identical to the pre-fix output", () => {
    const xml = renderPlist({ binaryPath: "/usr/local/bin/norma", normaHome: "/Users/me/.norma", profile: "dist" });
    expect(xml).toBe(
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.norma.core</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/norma</string>
    <string>daemon</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>NORMA_HOME</key><string>/Users/me/.norma</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/me/.norma/logs/core.out.log</string>
  <key>StandardErrorPath</key><string>/Users/me/.norma/logs/core.err.log</string>
</dict>
</plist>
`
    );
  });
});
