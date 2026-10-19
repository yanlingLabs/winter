"""Compare two builds of each artifact and publish the digests a reviewed pin PR needs. Reads files only.

    image_build_report.py report --kernel-1 D --kernel-2 D --image-1 D --image-2 D --status-1 N --status-2 N --out digests.json   (always exits 0 once it has written the file)
    image_build_report.py assert digests.json                                                                                   (exits 1 and lists every problem)
    image_build_report.py collect --kernel D --image D --out NEW_DIR                                                            (copies exactly the files to publish, under their installed names)

The split lets the workflow upload the artifacts and the digests BEFORE the run turns red, so a mismatch against the local pins costs nothing but the colour:
digests.json is then the input of the re-pin. Nothing here changes a pin file.
"""
import argparse, hashlib, json, os, shutil, sys
from pathlib import Path

# Under `python3 -I` the script's own directory is NOT on sys.path (that is the point of -I), so the sibling modules are found by an explicit insert of this file's directory
# and nothing else: the interpreter still ignores PYTHON* variables, the user site and the current directory.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import runtime_image_digest as rid

HERE = Path(__file__).resolve().parent
PINS = json.loads((HERE / "pins.json").read_text())
KERNEL_PINS = json.loads((HERE / "kernel" / "pins.json").read_text())


def sha256_file(path):
    return rid.file_sha256(path).hex()


def read_json(path):
    return json.loads(Path(path).read_text())


def kernel_summary(folder):
    receipt = read_json(Path(folder) / "kernel-receipt.json")
    return {key: receipt[key] for key in ("ImageSha256", "ImageBytes", "vmlinuxSha256", "resolvedConfigSha256")}


def image_summary(folder):
    folder = Path(folder)
    receipt = read_json(folder / "receipt.json")
    return {"cpioSha256": sha256_file(folder / "immutable-root.cpio"), "cpioBytes": (folder / "immutable-root.cpio").stat().st_size,
            "rootManifestSha256": sha256_file(folder / "root.manifest.json"), "runtimeSha256": receipt["runtimeSha256"], "initSha256": receipt["initSha256"],
            "reproducibilityPinned": receipt.get("reproducibilityPinned")}


def report(kernel_1, kernel_2, image_1, image_2, status_1, status_2):
    k1, k2, i1, i2 = kernel_summary(kernel_1), kernel_summary(kernel_2), image_summary(image_1), image_summary(image_2)
    expected = PINS["expectedArtifact"]
    pins_hold = {"cpioSha256": i1["cpioSha256"] == expected["cpioSha256"], "rootManifestSha256": i1["rootManifestSha256"] == expected["rootManifestSha256"], "runtimeSha256": i1["runtimeSha256"] == expected["runtimeSha256"]}
    return {
        "formatVersion": 1,
        "kernel": {**k1, "reproducible": k1 == k2, "pinnedBefore": KERNEL_PINS["expectedOutputs"]["Image"], "bootVerified": False},
        "image": {**i1, "reproducible": i1 == i2, "imageExitStatus": [status_1, status_2], "pinsHold": pins_hold},
        "runtimeImageDigest": rid.runtime_image_digest(k1["ImageSha256"], i1["cpioSha256"]),
        "installedFiles": {"kernel": "cowork-guest/kernel", "initramfs": "cowork-guest/initramfs.cpio"},
        "note": "runtimeImageDigest = SHA-256(SHA-256(kernel) || SHA-256(initramfs.cpio)), raw digests. Nothing here has booted: gate G1 is the first boot.",
    }


def problems(digests):
    out = []
    if not digests["kernel"]["reproducible"]:
        out.append("the two kernel builds differ")
    if not digests["image"]["reproducible"]:
        out.append("the two image builds differ")
    if digests["image"]["imageExitStatus"] != [0, 0]:
        out.append(f"image.py exited {digests['image']['imageExitStatus']} (3 means a built digest differs from pins.json)")
    out += [f"pins.json {name} does not hold" for name, held in digests["image"]["pinsHold"].items() if not held]
    return out


# Exit codes of `assert`. 0 is green and means ONE thing: both builds of each artifact are identical and every digest matches pins.json. Anything else is red, and the code says why.
EXIT_OK, EXIT_PINS_STALE, EXIT_NOT_REPRODUCIBLE, EXIT_UNEXPECTED_STATUS = 0, 10, 20, 30
LABELS = {EXIT_OK: "OK", EXIT_PINS_STALE: "PINS_STALE", EXIT_NOT_REPRODUCIBLE: "NOT_REPRODUCIBLE", EXIT_UNEXPECTED_STATUS: "UNEXPECTED_STATUS"}
MEANINGS = {
    EXIT_OK: "Both builds of each artifact are identical and every digest matches pins.json.",
    EXIT_PINS_STALE: "Both builds of each artifact are identical, but pins.json no longer matches them. This is the EXPECTED result after an sdkCommit bump (or a Zig or dependency change): digests.json is the input of the re-pin pull request.",
    EXIT_NOT_REPRODUCIBLE: "The two builds of the kernel or of the image differ from each other. The build is NOT reproducible: do not pin anything from this run.",
    EXIT_UNEXPECTED_STATUS: "image.py ended with a status other than 0 (pins hold) or 3 (a digest differs from pins.json).",
}


PINS_HOLD_KEYS = ("cpioSha256", "rootManifestSha256", "runtimeSha256")


def classify(digests):
    """(exit code, details). Most severe first: a non-reproducible build outranks everything, then an unexpected image.py status, then stale pins.
    Defensive on purpose: OK needs `reproducible is True` for both artifacts, an image status that is exactly two ints from {0, 3} that are both 0, `pinsHold` with EXACTLY the three
    expected keys each `is True` (a missing key, an extra key or a non-True value is never green), and, when kernel/pins.json pins the kernel Image (non-null), the built Image equal to it.
    A null kernel pin still means 'new', as before."""
    kernel, image_ = digests["kernel"], digests["image"]
    if kernel.get("reproducible") is not True or image_.get("reproducible") is not True:
        return EXIT_NOT_REPRODUCIBLE, [f"the two {name} builds differ" for name, part in (("kernel", kernel), ("image", image_)) if part.get("reproducible") is not True]
    status = image_.get("imageExitStatus")
    if not (isinstance(status, list) and len(status) == 2 and all(type(s) is int and s in (0, 3) for s in status)):
        return EXIT_UNEXPECTED_STATUS, [f"image.py exited {status}"]
    stale = []
    hold = image_.get("pinsHold")
    if not isinstance(hold, dict) or set(hold) != set(PINS_HOLD_KEYS):
        stale.append(f"pinsHold has keys {sorted(hold) if isinstance(hold, dict) else hold!r}, expected {sorted(PINS_HOLD_KEYS)}")
    else:
        stale += [f"pins.json {name} does not hold" for name in PINS_HOLD_KEYS if hold[name] is not True]
    pinned = kernel.get("pinnedBefore")
    if pinned is not None and pinned != kernel.get("ImageSha256"):
        stale.append("kernel/pins.json expectedOutputs.Image does not hold")
    if stale or status != [0, 0]:
        return EXIT_PINS_STALE, stale or [f"image.py exited {status}"]
    return EXIT_OK, []


def summary(digests, code, details):
    kernel, image_ = digests["kernel"], digests["image"]
    lines = [f"## Guest image build: {LABELS[code]}", "", MEANINGS[code], ""]
    lines += [f"* {detail}" for detail in details] + ([""] if details else [])
    lines += ["| artifact | sha256 | reproducible |", "| --- | --- | --- |",
              f"| kernel `Image` | `{kernel['ImageSha256']}` | {kernel['reproducible']} |", f"| kernel `vmlinux` | `{kernel['vmlinuxSha256']}` | {kernel['reproducible']} |",
              f"| `initramfs.cpio` | `{image_['cpioSha256']}` | {image_['reproducible']} |", f"| root manifest | `{image_['rootManifestSha256']}` | {image_['reproducible']} |",
              f"| host-query runtime | `{image_['runtimeSha256']}` | {image_['reproducible']} |", f"| **runtimeImageDigest** | `{digests['runtimeImageDigest']}` | |", ""]
    hold = image_.get("pinsHold")
    held = ", ".join(f"{name}: {'holds' if ok is True else 'DIFFERS'}" for name, ok in hold.items()) if isinstance(hold, dict) else "malformed"
    pinned = kernel.get("pinnedBefore")
    kernel_note = ("are new (kernel/pins.json expectedOutputs was unpinned)" if pinned is None
                   else "match kernel/pins.json expectedOutputs.Image" if pinned == kernel["ImageSha256"] else "DIFFER from kernel/pins.json expectedOutputs.Image")
    lines += [f"pins.json: {held}", "", f"The kernel digests {kernel_note}. Nothing here has booted: gate G1 is the first boot.", ""]
    return "\n".join(lines)


PUBLISH = [("kernel", "Image", "kernel"), ("kernel", "resolved.config", "resolved.config"), ("kernel", "kernel-receipt.json", "kernel-receipt.json"),
           ("image", "immutable-root.cpio", "initramfs.cpio"), ("image", "receipt.json", "receipt.json"), ("image", "root.manifest.json", "root.manifest.json"),
           ("image", "elf-dependencies.json", "elf-dependencies.json"), ("image", "size-breakdown.json", "size-breakdown.json"), ("image", "cpio-verification.json", "cpio-verification.json")]


def collect(kernel, image, out):
    """The files a reviewer or the first boot needs, under the names the worker expects (`kernel`, `initramfs.cpio`). Nothing else from the build trees."""
    out = Path(out)
    out.mkdir()
    sources = {"kernel": Path(kernel), "image": Path(image)}
    for where, name, published in PUBLISH:
        shutil.copyfile(sources[where] / name, out / published)


def main(argv):
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    r = sub.add_parser("report")
    for name in ("kernel-1", "kernel-2", "image-1", "image-2", "out"):
        r.add_argument(f"--{name}", type=Path, required=True)
    for name in ("status-1", "status-2"):
        r.add_argument(f"--{name}", type=int, required=True)
    c = sub.add_parser("collect")
    for name in ("kernel", "image", "out"):
        c.add_argument(f"--{name}", type=Path, required=True)
    a = sub.add_parser("assert")
    a.add_argument("digests", type=Path)
    args = parser.parse_args(argv)
    if args.command == "report":
        digests = report(args.kernel_1, args.kernel_2, args.image_1, args.image_2, args.status_1, args.status_2)
        args.out.write_text(json.dumps(digests, indent=2, sort_keys=True) + "\n")
        print(json.dumps(digests, indent=2, sort_keys=True))
        return 0
    if args.command == "collect":
        collect(args.kernel, args.image, args.out)
        return 0
    digests = read_json(args.digests)
    code, details = classify(digests)
    print(f"RESULT: {LABELS[code]} (exit {code}): {MEANINGS[code]}")
    for line in details:
        print("PROBLEM: " + line)
    target = os.environ.get("GITHUB_STEP_SUMMARY")
    if target:
        with open(target, "a") as handle:
            handle.write(summary(digests, code, details))
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
