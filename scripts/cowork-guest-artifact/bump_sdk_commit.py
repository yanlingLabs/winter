"""Move the image's agent-SDK pin as ONE reviewed change: four constants, edited together or not at all.

    python3 -I -S -B bump_sdk_commit.py NEW_COMMIT --supervisor-sha256 SHA256_OF_linux-supervisor.py_AT_NEW_COMMIT

  pins.json            sdkCommit, sdkPin.mainAt, sdkPin.supervisorSha256, runtimeArtifacts.launcher.sourceSha256, runtimeArtifacts.ownerLibrary.sourceSha256
  sdk-supervisor-cli.json   sdkCommit, supervisorSha256 (the argument forms are re-derived by test_image.py when WINTER_SDK_CHECKOUT is set)
  README.md            the short commit named as the current SDK main
  the one-run workflow env AGENT_SDK_HEAD
With --sdk-checkout the three source digests are read from that clone at NEW_COMMIT (`git show`); without it all three must be given. `sdk_derived_problems` is the check that nothing derived from the SDK commit is left stale
(the package lock is NOT SDK-derived: it comes only from the Debian snapshot pins).

Nothing else moves: `expectedArtifact` stays what it was and is therefore STALE after the bump (the supervisor and the owner library change the cpio). The next image build stops at
image.py exit 3 (UNPINNED) with the digests that differ; the workflow tolerates exit 3, uploads the kernel, initramfs, receipts and digests.json as the guest-image artifact (the image whose digests get pinned), and only then
turns the run red in the assert step. That is the intended flow, and nothing admits an image that is not pinned by digest: and the gate test (guest-image-build-gates.test.ts) fails if the workflow's
AGENT_SDK_HEAD and pins.json ever differ. The supervisor digest is computed by the reviewer from the SDK checkout (`git show NEW:packages/runtime/src/guest/linux-supervisor.py | sha256sum`);
image.py refuses a build whose supervisor does not hash to it.
"""
import argparse, json, re, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PINS = HERE / "pins.json"
WORKFLOW = HERE.parents[1] / ".github/workflows/cowork-guest-image-build.yml"
HEX40, HEX64 = re.compile(r"^[0-9a-f]{40}$"), re.compile(r"^[0-9a-f]{64}$")


CLI = HERE / "sdk-supervisor-cli.json"
README = HERE / "README.md"
GUEST_DIR = "packages/runtime/src/guest/"


def sdk_derived_problems(pins_text, workflow_text, cli_text, readme_text):
    """Everything in the image pins that is derived from the SDK commit, checked against `sdkCommit` / `supervisorSha256`. Empty = nothing is stale. Pure."""
    pins, cli, problems = json.loads(pins_text), json.loads(cli_text), []
    commit, supervisor = pins["sdkCommit"], pins["sdkPin"]["supervisorSha256"]
    if pins["sdkPin"]["mainAt"] != commit:
        problems.append("sdkPin.mainAt differs from sdkCommit")
    if re.findall(r"^  AGENT_SDK_HEAD: '([0-9a-f]{40})'", workflow_text, flags=re.M) != [commit]:
        problems.append("the workflow AGENT_SDK_HEAD differs from sdkCommit")
    if (cli["sdkCommit"], cli["supervisorSha256"]) != (commit, supervisor):
        problems.append("sdk-supervisor-cli.json is for another commit or supervisor")
    if f"SDK main at `{commit[:8]}`" not in readme_text:
        problems.append("README.md names another SDK commit")
    for name in ("launcher", "ownerLibrary"):
        if not HEX64.match(pins["runtimeArtifacts"][name]["sourceSha256"]):
            problems.append(f"runtimeArtifacts.{name}.sourceSha256 is not a digest")
    return problems


def read_from_checkout(checkout, commit):
    """(supervisor, launcher, owner) SHA-256 of the three SDK sources at `commit`, read with `git show` only."""
    import hashlib, subprocess
    pins = json.loads(PINS.read_text())
    paths = [GUEST_DIR + "linux-supervisor.py", GUEST_DIR + pins["runtimeArtifacts"]["launcher"]["source"], GUEST_DIR + pins["runtimeArtifacts"]["ownerLibrary"]["source"]]
    return tuple(hashlib.sha256(subprocess.check_output(["git", "-C", str(checkout), "show", f"{commit}:{path}"])).hexdigest() for path in paths)


def bump(pins_text, workflow_text, new_commit, supervisor_sha256, launcher_sha256=None, owner_sha256=None, cli_text=None, readme_text=None):
    """The new texts, or ValueError. Pure. Two texts when only the workflow and pins are given (the original form); four when the CLI fixture and the README are given too."""
    if not HEX40.match(new_commit) or not HEX64.match(supervisor_sha256) or any(v is not None and not HEX64.match(v) for v in (launcher_sha256, owner_sha256)):
        raise ValueError("a full lowercase 40-hex commit and 64-hex source digests are required")
    pins = json.loads(pins_text)
    old = pins["sdkCommit"]
    if new_commit == old:
        raise ValueError("the pin already names this commit")
    if pins["sdkPin"]["mainAt"] != old:
        raise ValueError("pins.json is inconsistent: sdkCommit and sdkPin.mainAt differ")
    edits = [(r'("sdkCommit": ")%s(")' % old, new_commit), (r'("mainAt": ")%s(")' % old, new_commit),
             (r'("supervisorSha256": ")%s(")' % pins["sdkPin"]["supervisorSha256"], supervisor_sha256)]
    for name, value in (("launcher", launcher_sha256), ("ownerLibrary", owner_sha256)):
        current = pins["runtimeArtifacts"][name]["sourceSha256"]
        if value is not None and value != current:
            edits.append((r'("sourceSha256": ")%s(")' % current, value))
    for pattern, value in edits:
        pins_text, count = re.subn(pattern, r"\g<1>%s\g<2>" % value, pins_text)
        if count != 1:
            raise ValueError("expected exactly one occurrence of " + pattern)
    workflow_text, count = re.subn(r"(^  AGENT_SDK_HEAD: ')%s(')" % old, r"\g<1>%s\g<2>" % new_commit, workflow_text, flags=re.M)
    if count != 1:
        raise ValueError("the workflow does not carry AGENT_SDK_HEAD at the pinned commit exactly once")
    moved = json.loads(pins_text)
    if (moved["sdkCommit"], moved["sdkPin"]["mainAt"], moved["sdkPin"]["supervisorSha256"]) != (new_commit, new_commit, supervisor_sha256):
        raise ValueError("the edit did not land")
    if cli_text is None and readme_text is None:
        return pins_text, workflow_text
    cli = json.loads(cli_text)
    if cli["sdkCommit"] != old:
        raise ValueError("sdk-supervisor-cli.json is not for the pinned commit")
    cli_text = cli_text.replace(f'"sdkCommit": "{old}"', f'"sdkCommit": "{new_commit}"', 1).replace(f'"supervisorSha256": "{cli["supervisorSha256"]}"', f'"supervisorSha256": "{supervisor_sha256}"', 1)
    if f"SDK main at `{old[:8]}`" not in readme_text:
        raise ValueError("README.md does not name the pinned SDK commit")
    readme_text = readme_text.replace(f"SDK main at `{old[:8]}`", f"SDK main at `{new_commit[:8]}`", 1)
    leftover = sdk_derived_problems(pins_text, workflow_text, cli_text, readme_text)
    if leftover:
        raise ValueError("the bump left SDK-derived pins stale: " + "; ".join(leftover))
    return pins_text, workflow_text, cli_text, readme_text


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("commit")
    parser.add_argument("--sdk-checkout", type=Path, help="an SDK clone: the three source digests are read from it at COMMIT")
    parser.add_argument("--supervisor-sha256")
    parser.add_argument("--launcher-sha256")
    parser.add_argument("--owner-sha256")
    args = parser.parse_args(argv)
    if args.sdk_checkout:
        supervisor, launcher, owner = read_from_checkout(args.sdk_checkout, args.commit)
    elif args.supervisor_sha256 and args.launcher_sha256 and args.owner_sha256:
        supervisor, launcher, owner = args.supervisor_sha256, args.launcher_sha256, args.owner_sha256
    else:
        parser.error("give --sdk-checkout, or all of --supervisor-sha256 --launcher-sha256 --owner-sha256")
    texts = bump(PINS.read_text(), WORKFLOW.read_text(), args.commit, supervisor, launcher, owner, CLI.read_text(), README.read_text())
    for path, text in zip((PINS, WORKFLOW, CLI, README), texts):
        path.write_text(text)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
