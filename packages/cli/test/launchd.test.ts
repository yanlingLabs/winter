import { describe, expect, test } from "bun:test";
import { renderPlist, LAUNCHD_LABEL, migrateFromLaunchdAgent, launchdLabel } from "../src/launchd";

describe("renderPlist", () => {
  test("contains label, program arguments, keepalive, and log paths", () => {
    const xml = renderPlist({
      binaryPath: "/usr/local/bin/winter",
      winterHome: "/Users/me/.winter",
    });
    expect(xml).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(xml).toContain("<string>/usr/local/bin/winter</string>");
    expect(xml).toContain("<string>daemon</string>");
    expect(xml).toContain("<string>run</string>");
    expect(xml).toContain("<key>KeepAlive</key>");
    expect(xml).toContain("<string>/Users/me/.winter/logs/core.out.log</string>");
    expect(xml).toContain("<string>/Users/me/.winter/logs/core.err.log</string>");
    expect(xml).not.toContain("~"); // launchd does not expand tildes
    expect(xml).toContain("<key>WINTER_HOME</key>");
    expect(xml).toContain("<string>/Users/me/.winter</string>");
  });

  test("xml-escapes special characters in paths", () => {
    const xml = renderPlist({ binaryPath: "/a&b/winter", winterHome: "/home/x<y>/.winter" });
    expect(xml).toContain("/a&amp;b/winter");
    expect(xml).toContain("/home/x&lt;y&gt;/.winter");
    expect(xml).not.toMatch(/<string>[^<]*&(?!amp;|lt;|gt;)/);
  });
});

describe("migrateFromLaunchdAgent", () => {
  const fakePath = "/fake/Library/LaunchAgents/com.winter.core.plist";

  test("unloads an existing com.winter.core plist: bootout(label) then remove(path)", async () => {
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

  test("keeps the historical literal label regardless of WINTER_PROFILE", async () => {
    const prev = process.env.WINTER_PROFILE;
    process.env.WINTER_PROFILE = "dev";
    let bootoutLabel: string | undefined;
    try {
      await migrateFromLaunchdAgent({
        plistPath: fakePath,
        exists: (p) => p === fakePath,
        bootout: async (label) => { bootoutLabel = label; },
        remove: () => {},
      });
    } finally {
      if (prev === undefined) delete process.env.WINTER_PROFILE; else process.env.WINTER_PROFILE = prev;
    }
    expect(bootoutLabel).toBe("com.winter.core");
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
    expect(launchdLabel("dist")).toBe("com.winter.core");
    expect(launchdLabel("dev")).toBe("com.winter.core.dev");
  });

  test("renderPlist embeds the profile label", () => {
    const dev = renderPlist({ binaryPath: "/x/winter-core", winterHome: "/tmp/h", profile: "dev" });
    expect(dev).toContain("<string>com.winter.core.dev</string>");
    const dist = renderPlist({ binaryPath: "/x/winter-core", winterHome: "/tmp/h", profile: "dist" });
    expect(dist).toContain("<string>com.winter.core</string>");
    expect(dist).not.toContain("com.winter.core.dev");
  });

  // DD branch review (I3): WINTER_PROFILE must ride along in the plist's own EnvironmentVariables
  // for a dev-profile install (otherwise a launchd-installed dev daemon resolves
  // `keychainService()` to the dist Keychain literal despite living in ~/.winter-dev — silent
  // credential cross-contamination), and the dist plist must stay byte-identical to before this
  // fix (no new key at all, not even an empty one).
  test("dev plist carries WINTER_PROFILE=dev; dist plist never mentions WINTER_PROFILE", () => {
    const dev = renderPlist({ binaryPath: "/x/winter-core", winterHome: "/tmp/h", profile: "dev" });
    expect(dev).toContain("<key>WINTER_PROFILE</key><string>dev</string>");

    const dist = renderPlist({ binaryPath: "/x/winter-core", winterHome: "/tmp/h", profile: "dist" });
    expect(dist).not.toContain("WINTER_PROFILE");
  });

  // Byte-identity proof: the dist plist output must be EXACTLY what renderPlist produced before
  // this fix, character for character — not just "doesn't contain WINTER_PROFILE". Passes
  // `profile: "dist"` explicitly (rather than relying on ambient `WINTER_PROFILE` env resolution)
  // so this assertion can never flake against another test's env mutation.
  test("dist plist is byte-identical to the pre-fix output", () => {
    const xml = renderPlist({ binaryPath: "/usr/local/bin/winter", winterHome: "/Users/me/.winter", profile: "dist" });
    expect(xml).toBe(
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.winter.core</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/winter</string>
    <string>daemon</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>WINTER_HOME</key><string>/Users/me/.winter</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/me/.winter/logs/core.out.log</string>
  <key>StandardErrorPath</key><string>/Users/me/.winter/logs/core.err.log</string>
</dict>
</plist>
`
    );
  });
});
