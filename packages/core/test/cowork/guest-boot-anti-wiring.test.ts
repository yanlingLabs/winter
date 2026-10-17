import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

// N2 slice S5 (guest boot, bootstrap and relay) is source only. The guest programs, the in-guest bootstrap and the artifact
// scripts are reached by nothing that ships: not the daemon, not the app project, not the release scripts, not the main CI.
const root = join(import.meta.dir, "..", "..", "..", "..");
const NEEDLES = ["WinterCoworkGuest", "winter-guest-relay", "guest_bootstrap", "cowork-guest-artifact", "supervisor-base.json"];

function files(directory: string, pattern: RegExp): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && pattern.test(entry.name))
    .map(entry => join(entry.parentPath, entry.name));
}

test("anti-wiring: nothing that ships references the guest boot sources or the artifact scripts", () => {
  const packages = join(root, "packages");
  const sources = readdirSync(packages, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(packages, entry.name, "src")))
    .flatMap(entry => files(join(packages, entry.name, "src"), /\.(ts|tsx|js|mjs|cjs|json)$/));
  expect(sources.length).toBeGreaterThan(100);
  const shipping = [
    ...sources,
    ...files(join(root, "apple", "Winter"), /\.(swift|yml|plist|entitlements|sh)$/),
    ...files(join(root, "scripts"), /^(release|release-lib|embed-[a-z-]+|build-[a-z-]+)\.(ts|sh)$/),
    join(root, ".github", "workflows", "ci.yml"),
  ].filter(file => existsSync(file));
  for (const file of shipping) {
    const text = readFileSync(file, "utf8");
    for (const needle of NEEDLES) expect(`${file.slice(root.length)}:${needle}:${text.includes(needle)}`).toBe(`${file.slice(root.length)}:${needle}:false`);
  }
});

test("the guest sources and scripts exist where the artifact build expects them", () => {
  for (const path of ["apple/Cowork/WinterCoworkGuest/init/init_linux.c", "apple/Cowork/WinterCoworkGuest/relay/relay.c",
    "apple/Cowork/WinterCoworkGuest/bootstrap/guest_bootstrap.py", "apple/Cowork/WinterCoworkGuest/vectors/mux-frames.json",
    "scripts/cowork-guest-artifact/pins.json", "scripts/cowork-guest-artifact/kernel/pins.json"])
    expect(`${path}:${existsSync(join(root, path))}`).toBe(`${path}:true`);
});

test("the guest has no network bring-up: no socket, interface, address or vsock code in its C sources", () => {
  const sources = files(join(root, "apple", "Cowork", "WinterCoworkGuest", "init"), /\.(c|h)$/).concat(files(join(root, "apple", "Cowork", "WinterCoworkGuest", "relay"), /\.(c|h)$/));
  expect(sources.map(file => basename(file)).sort()).toContain("init_linux.c");
  for (const file of sources) {
    const text = readFileSync(file, "utf8");
    for (const needle of ["AF_INET", "AF_VSOCK", "AF_NETLINK", "SOCK_STREAM", "socket(", "SIOCSIF", "SIOCGIF", "dhcp", "netlink", "<netinet", "<linux/if", "<net/if", "IFF_UP"])
      expect(`${basename(file)}:${needle}:${text.includes(needle)}`).toBe(`${basename(file)}:${needle}:false`);
  }
});
