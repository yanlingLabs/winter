"""Compare two builds of each artifact and publish the digests a reviewed pin PR needs. Reads files only.

    image_build_report.py report --kernel-1 D --kernel-2 D --image-1 D --image-2 D --status-1 N --status-2 N --out digests.json   (always exits 0 once it has written the file)
    image_build_report.py assert digests.json                                                                                   (exits 1 and lists every problem)
    image_build_report.py collect --kernel D --image D --out NEW_DIR                                                            (copies exactly the files to publish, under their installed names)

The split lets the workflow upload the artifacts and the digests BEFORE the run turns red, so a mismatch against the local pins costs nothing but the colour:
digests.json is then the input of the re-pin. Nothing here changes a pin file.
"""
import argparse, hashlib, json, shutil, sys
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
            "rootManifestSha256": sha256_file(folder / "root.manifest.json"), "runtimeSha256": receipt["runtimeSha256"], "initSha256": receipt["initSha256"], "relaySha256": receipt["relaySha256"], "packageLockSha256": receipt.get("packageLockSha256"),
            # the guest binaries are pinned only when pins.json holds a digest and it is the one this build produced (a null pin, or a stale one, is false): the post-build pin step reads both digests here
            "initPinned": PINS["guest"]["programs"]["init"]["binarySha256"] == receipt["initSha256"], "relayPinned": PINS["guest"]["programs"]["winter-guest-relay"]["binarySha256"] == receipt["relaySha256"],
            "reproducibilityPinned": receipt.get("reproducibilityPinned")}


def report(kernel_1, kernel_2, image_1, image_2, status_1, status_2):
    k1, k2, i1, i2 = kernel_summary(kernel_1), kernel_summary(kernel_2), image_summary(image_1), image_summary(image_2)
    expected = PINS["expectedArtifact"]
    pins_hold = {"cpioSha256": i1["cpioSha256"] == expected["cpioSha256"], "rootManifestSha256": i1["rootManifestSha256"] == expected["rootManifestSha256"], "runtimeSha256": i1["runtimeSha256"] == expected["runtimeSha256"],
                 "packageLockSha256": i1["packageLockSha256"] == PINS["packageLockSha256"]}
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
    pinned_kernel = digests["kernel"]["pinnedBefore"]
    if pinned_kernel is None:
        out.append("the kernel Image is not pinned yet (kernel/pins.json expectedOutputs.Image)")
    elif pinned_kernel != digests["kernel"]["ImageSha256"]:
        out.append("the built kernel is not the pinned kernel (kernel/pins.json expectedOutputs.Image)")
    if not digests["image"]["reproducible"]:
        out.append("the two image builds differ")
    if digests["image"]["imageExitStatus"] != [0, 0]:
        out.append(f"image.py exited {digests['image']['imageExitStatus']} (3 means a built digest differs from pins.json)")
    for name, key, pinned in (("init", "initSha256", "initPinned"), ("winter-guest-relay", "relaySha256", "relayPinned")):
        if digests["image"].get(pinned) is False:
            out.append(f"pins.json guest.programs.{name}.binarySha256 is null or does not hold (digests.json image.{key} is what this build produced)")
    out += [f"pins.json {name} does not hold" for name, held in digests["image"]["pinsHold"].items() if not held]
    return out


PUBLISH = [("kernel", "Image", "kernel"), ("kernel", "resolved.config", "resolved.config"), ("kernel", "kernel-receipt.json", "kernel-receipt.json"),
           ("image", "immutable-root.cpio", "initramfs.cpio"), ("image", "receipt.json", "receipt.json"), ("image", "root.manifest.json", "root.manifest.json"), ("image", "packages.lock.json", "packages.lock.json"),
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
    found = problems(read_json(args.digests))
    for line in found:
        print("PROBLEM: " + line)
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
