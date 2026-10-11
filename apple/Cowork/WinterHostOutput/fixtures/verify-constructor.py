#!/usr/bin/env python3
"""Receipt-driven local SDK constructor fixture; no production path resolver."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import tempfile


def verify(bundle):
    if not bundle.is_absolute():
        raise ValueError("explicit absolute output-only fixture bundle required")
    bun = shutil.which("bun")
    if not bun:
        raise ValueError("existing fixture Bun executable required")
    script = Path(__file__).resolve().with_name("sdk-output-smoke.ts")
    with tempfile.TemporaryDirectory(prefix="winter-output-constructor-launch-") as tmp:
        root = Path(tmp).resolve()
        home, coordination = root / "home", root / "coordination"
        home.mkdir()
        coordination.mkdir()
        result = subprocess.run(
            [bun, "run", "--no-env-file", "--config=/dev/null", str(script), str(bundle), "--constructor"],
            cwd=script.parents[4], capture_output=True, text=True, timeout=30,
            env={"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C", "HOME": str(home),
                 "WINTER_HOME": str(home), "WINTER_KEYCHAIN_SERVICE": "com.winter.test.output-constructor",
                 "WINTER_COWORK_COORDINATION_DIR": str(coordination), "WINTER_LOGIN_SHELL_PATH": "off"},
        )
        if result.returncode != 0:
            raise RuntimeError(f"constructor fixture failed ({result.returncode}): {result.stderr[-8192:]}")
        if not result.stdout.strip() or len(result.stdout.encode()) > 4096:
            raise ValueError("missing or oversized constructor receipt")
        receipt = json.loads(result.stdout)
        for key in ("constructorDefaultService", "actualSdkBroker", "exactStdoutStderr", "mandatoryFloorStillEnforced", "ownedDrainConfirmed", "outputOnlyPackagedAddon"):
            if receipt.get(key) is not True:
                raise ValueError(f"constructor receipt lacks {key}")
        for key in ("installedReleasedSdk", "realVM", "actualKeychain", "workflowAuthorityProved"):
            if receipt.get(key) is not False:
                raise ValueError(f"constructor receipt has invalid {key}")
        if (receipt.get("packageBinding") != "fixture-mocked-with-real-local-sdk-functions"
                or receipt.get("acknowledgedOutputBytes") != 2 * 1024 * 1024
                or type(receipt.get("forwardedFactoryCalls")) is not int
                or receipt["forwardedFactoryCalls"] < 3):
            raise ValueError("invalid constructor forwarding/output receipt")
        return receipt


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--bundle", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(verify(args.bundle), separators=(",", ":")))
