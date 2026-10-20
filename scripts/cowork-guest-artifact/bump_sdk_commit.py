"""Move the image's agent-SDK pin as ONE reviewed change: four constants, edited together or not at all.

    python3 -I -S -B bump_sdk_commit.py NEW_COMMIT --supervisor-sha256 SHA256_OF_linux-supervisor.py_AT_NEW_COMMIT

  pins.json            sdkCommit, sdkPin.mainAt, sdkPin.supervisorSha256
  the one-run workflow env AGENT_SDK_HEAD

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


def bump(pins_text, workflow_text, new_commit, supervisor_sha256):
    """The two new texts, or ValueError. Pure."""
    if not HEX40.match(new_commit) or not HEX64.match(supervisor_sha256):
        raise ValueError("a full lowercase 40-hex commit and a 64-hex supervisor digest are required")
    pins = json.loads(pins_text)
    old = pins["sdkCommit"]
    if new_commit == old:
        raise ValueError("the pin already names this commit")
    if pins["sdkPin"]["mainAt"] != old:
        raise ValueError("pins.json is inconsistent: sdkCommit and sdkPin.mainAt differ")
    edits = [(r'("sdkCommit": ")%s(")' % old, new_commit), (r'("mainAt": ")%s(")' % old, new_commit),
             (r'("supervisorSha256": ")%s(")' % pins["sdkPin"]["supervisorSha256"], supervisor_sha256)]
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
    return pins_text, workflow_text


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("commit")
    parser.add_argument("--supervisor-sha256", required=True)
    args = parser.parse_args(argv)
    pins_text, workflow_text = bump(PINS.read_text(), WORKFLOW.read_text(), args.commit, args.supervisor_sha256)
    PINS.write_text(pins_text)
    WORKFLOW.write_text(workflow_text)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
