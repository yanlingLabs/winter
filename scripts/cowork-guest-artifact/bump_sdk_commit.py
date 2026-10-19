"""Move the image's agent-SDK pin as ONE reviewed change: every constant derived from the SDK commit, edited together or not at all.

    python3 -I -S -B bump_sdk_commit.py NEW_COMMIT --supervisor-sha256 SHA256 --sdk CHECKOUT

  pins.json              sdkCommit, sdkPin.mainAt, sdkPin.supervisorSha256, runtimeArtifacts.launcher.sourceSha256, runtimeArtifacts.ownerLibrary.sourceSha256
  sdk-supervisor-cli.json  sdkCommit, supervisorSha256 (and every recorded command-line verdict is re-derived from the new supervisor and must be unchanged)
  the one-run workflow   env AGENT_SDK_HEAD

The two native source digests and the supervisor digest are READ from the SDK checkout at NEW_COMMIT (`git show NEW:packages/runtime/src/guest/...`); the supervisor digest the reviewer
passes must equal what is read, so a typo or a different commit is refused. Nothing else moves: `expectedArtifact` (and the per-artifact `binarySha256` values it mirrors) stays what it was and
is therefore STALE after the bump, by design: the supervisor, the owner library and the host-query bundle change the cpio. The next image build reports which digests changed and
`image_build_report.py` publishes them for the re-pin. The gate test (guest-image-build-gates.test.ts) fails if the workflow's AGENT_SDK_HEAD and pins.json ever differ.
"""
import argparse, hashlib, importlib.util, json, re, subprocess, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
PINS = HERE / "pins.json"
CLI = HERE / "sdk-supervisor-cli.json"
WORKFLOW = HERE.parents[1] / ".github/workflows/cowork-guest-image-build.yml"
HEX40, HEX64 = re.compile(r"^[0-9a-f]{40}$"), re.compile(r"^[0-9a-f]{64}$")
GUEST_DIR = "packages/runtime/src/guest/"
SUPERVISOR = GUEST_DIR + "linux-supervisor.py"
SOURCES = {"launcher": "linux-runtime-compartment.c", "ownerLibrary": "linux-session-owner.c"}


def replace_one(text, pattern, value):
    text, count = re.subn(pattern, lambda m: m.group(1) + value + m.group(2), text, flags=re.M)
    if count != 1:
        raise ValueError("expected exactly one occurrence of " + pattern)
    return text


def bump(pins_text, workflow_text, cli_text, new_commit, supervisor_sha256, source_digests):
    """The three new texts, or ValueError. Pure. `source_digests` maps launcher / ownerLibrary to the digest of the native source at the new commit."""
    if not HEX40.match(new_commit) or not HEX64.match(supervisor_sha256) or set(source_digests) != set(SOURCES) or not all(HEX64.match(v) for v in source_digests.values()):
        raise ValueError("a full lowercase 40-hex commit and 64-hex digests are required")
    pins, cli = json.loads(pins_text), json.loads(cli_text)
    old = pins["sdkCommit"]
    if new_commit == old:
        raise ValueError("the pin already names this commit")
    # sdkPin.mainAt and the fixture's sdkCommit must equal `old` too; the edits below find them by that exact value and refuse when they are not there
    if cli["supervisorSha256"] != pins["sdkPin"]["supervisorSha256"]:
        raise ValueError("the pin files are inconsistent with each other before the bump")
    pins_text = replace_one(pins_text, r'("sdkCommit": ")%s(")' % old, new_commit)
    pins_text = replace_one(pins_text, r'("mainAt": ")%s(")' % old, new_commit)
    pins_text = replace_one(pins_text, r'("supervisorSha256": ")%s(")' % pins["sdkPin"]["supervisorSha256"], supervisor_sha256)
    for key, digest in source_digests.items():
        pins_text = replace_one(pins_text, r'("sourceSha256": ")%s(")' % pins["runtimeArtifacts"][key]["sourceSha256"], digest)
    cli_text = replace_one(cli_text, r'("sdkCommit": ")%s(")' % old, new_commit)
    cli_text = replace_one(cli_text, r'("supervisorSha256": ")%s(")' % cli["supervisorSha256"], supervisor_sha256)
    workflow_text = replace_one(workflow_text, r"(^  AGENT_SDK_HEAD: ')%s(')" % old, new_commit)
    moved = json.loads(pins_text)
    if (moved["sdkCommit"], moved["sdkPin"]["mainAt"], moved["sdkPin"]["supervisorSha256"]) != (new_commit, new_commit, supervisor_sha256) or \
       any(moved["runtimeArtifacts"][key]["sourceSha256"] != digest for key, digest in source_digests.items()):
        raise ValueError("the edit did not land")
    return pins_text, workflow_text, cli_text


def read_from_checkout(sdk, commit, relative):
    return subprocess.check_output(["git", "-C", str(sdk), "show", f"{commit}:{relative}"], stderr=subprocess.DEVNULL)


def cli_verdicts_unchanged(cli_text, supervisor_bytes):
    """Every recorded command-line verdict of the supervisor, re-derived by importing the NEW supervisor (nothing is started); the recorded ones must still hold."""
    cli = json.loads(cli_text)
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / "sup.py"
        path.write_bytes(supervisor_bytes)
        spec = importlib.util.spec_from_file_location("sup", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        for case in cli["accepted"]:
            try:
                result = module.parse_arguments(["x", *case["argv"]])
            except SystemExit:
                return False
            if [result[0], list(result[1]) if result[1] else None] != case["result"]:
                return False
        for argv in cli["refused"]:
            try:
                module.parse_arguments(["x", *argv])
            except SystemExit:
                continue
            return False
    return True


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("commit")
    parser.add_argument("--supervisor-sha256", required=True)
    parser.add_argument("--sdk", type=Path, required=True)
    args = parser.parse_args(argv)
    supervisor = read_from_checkout(args.sdk, args.commit, SUPERVISOR)
    if hashlib.sha256(supervisor).hexdigest() != args.supervisor_sha256:
        raise SystemExit("the supervisor at that commit does not hash to the digest given")
    digests = {key: hashlib.sha256(read_from_checkout(args.sdk, args.commit, GUEST_DIR + name)).hexdigest() for key, name in SOURCES.items()}
    pins_text, workflow_text, cli_text = bump(PINS.read_text(), WORKFLOW.read_text(), CLI.read_text(), args.commit, args.supervisor_sha256, digests)
    if not cli_verdicts_unchanged(cli_text, supervisor):
        raise SystemExit("the new supervisor's command-line verdicts differ from the recorded ones: review sdk-supervisor-cli.json by hand")
    PINS.write_text(pins_text)
    WORKFLOW.write_text(workflow_text)
    CLI.write_text(cli_text)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
