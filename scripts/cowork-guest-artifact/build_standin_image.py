"""Build the STAND-IN test initramfs as an exact overlay on the production cpio. Reads the production cpio and three inputs; writes one cpio and one receipt. Runs nothing.

    python3 build_standin_image.py --production-cpio build/immutable-root.cpio --init-standin init-standin --provider winter-provider --out NEW_DIR

The stand-in image is the production image with EXACTLY these differences, and the builder refuses anything else:
  * `/init` is the `init-standin` binary (the same PID 1 plus the stand-in lifecycle; built by `build.py --profile standin`),
  * `/opt/winter/standin/winter-provider`   the runtime-sdk provider worker executable (mode 0555),
  * `/opt/winter/standin/standin_prepare.py` and `/opt/winter/standin/profile.json` (mode 0444), byte for byte the files in apple/Cowork/WinterCoworkGuest/standin.
Nothing in the production cpio is edited, so every production file, pin and digest stays what it was; the production image.py, verify.py and refuse_provider_bridge are not touched
and stay unconditional. The result has its own initramfs digest and so its own runtimeImageDigest, which standin-pins.json records and no production pin file may contain.
"""
import argparse, hashlib, json, stat, struct, sys, tempfile
from pathlib import Path

import image
import runtime_image_digest as rid

HERE = Path(__file__).resolve().parent
GUEST = image.GUEST
STANDIN_DIR = "opt/winter/standin"
OVERLAY_FILES = {  # path -> (executable, how it is produced)
    STANDIN_DIR + "/winter-provider": True,
    STANDIN_DIR + "/standin_prepare.py": False,
    STANDIN_DIR + "/profile.json": False,
}
ALLOWED_MODES = {0o555, 0o444, 0o777}
MAX_ENTRY = 512 * 1024 * 1024
ELF_AARCH64 = 183


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read_cpio(data):
    """A newc cpio, as image.Tree writes it, back into a Tree. Anything the writer would not have written is refused."""
    tree = image.Tree()
    at, seen = 0, set()
    while True:
        header = data[at:at + 110]
        if len(header) != 110 or header[:6] != b"070701":
            raise ValueError("cpio header")
        fields = [int(header[6 + 8 * i:14 + 8 * i], 16) for i in range(13)]
        _ino, mode, uid, gid, nlink, mtime, size, _dmaj, _dmin, _rmaj, _rmin, namesize, check = fields
        name_at = at + 110
        name = data[name_at:name_at + namesize - 1].decode()
        if data[name_at + namesize - 1:name_at + namesize] != b"\0":
            raise ValueError("cpio name")
        body_at = name_at + namesize + (-(110 + namesize)) % 4
        if name == "TRAILER!!!":
            break
        if (uid, gid, nlink, mtime, check) != (0, 0, 1, 0, 0) or size > MAX_ENTRY or name in seen:
            raise ValueError("cpio metadata for " + name)
        seen.add(name)
        body = data[body_at:body_at + size]
        if len(body) != size:
            raise ValueError("cpio truncated")
        kind = {stat.S_IFREG: "file", stat.S_IFDIR: "directory", stat.S_IFLNK: "symlink"}.get(stat.S_IFMT(mode))
        permissions = stat.S_IMODE(mode)
        if kind is None or permissions not in ALLOWED_MODES:
            raise ValueError("cpio mode for " + name)
        if (kind == "symlink") != (permissions == 0o777) or (kind == "directory" and permissions != 0o555):
            raise ValueError("cpio mode for " + name)
        tree.add(name, kind, body, executable=(kind == "file" and permissions == 0o555), origin="production-cpio")
        at = body_at + size + (-size) % 4
    return tree


def snapshot(tree):
    return {name: (node["kind"], node["mode"], node["data"]) for name, node in tree.nodes.items()}


def is_aarch64_elf(data):
    return len(data) > 64 and data[:4] == b"\x7fELF" and data[4] == 2 and data[5] == 1 and struct.unpack_from("<H", data, 18)[0] == ELF_AARCH64


def overlay(tree, init_standin, provider, prepare, profile):
    """Edit `tree` in place into the stand-in tree. The production tree must have an executable /init and no stand-in directory."""
    if not is_aarch64_elf(init_standin) or not is_aarch64_elf(provider):
        raise ValueError("init-standin and the provider worker must be 64-bit little-endian aarch64 ELF files")
    init = tree.nodes.get("init")
    if init is None or init["kind"] != "file" or init["mode"] != 0o555:
        raise ValueError("the production tree has no executable /init")
    if any(name == STANDIN_DIR or name.startswith(STANDIN_DIR + "/") for name in tree.nodes):
        raise ValueError("the production tree already has a stand-in directory")
    if init_standin == init["data"]:
        raise ValueError("init-standin is the production init")
    init["data"] = init_standin
    init["origins"] = ["standin:init-standin"]
    contents = {STANDIN_DIR + "/winter-provider": provider, STANDIN_DIR + "/standin_prepare.py": prepare, STANDIN_DIR + "/profile.json": profile}
    for name, data in contents.items():
        tree.add(name, "file", data, OVERLAY_FILES[name], "standin")


def overlay_problems(production, standin):
    """The exact difference between two trees (as snapshot()s) must be the overlay. Empty means it is."""
    problems = []
    removed = sorted(set(production) - set(standin))
    if removed:
        problems.append("removed: " + ", ".join(removed))
    added = set(standin) - set(production)
    expected_added = {STANDIN_DIR, *OVERLAY_FILES}
    if added != expected_added:
        problems.append("added differs: " + ", ".join(sorted(added ^ expected_added)))
    changed = {name for name in set(production) & set(standin) if production[name] != standin[name]}
    if changed != {"init"}:
        problems.append("changed differs from /init: " + ", ".join(sorted(changed ^ {"init"})))
    for name, executable in OVERLAY_FILES.items():
        node = standin.get(name)
        if node is None or node[0] != "file" or node[1] != (0o555 if executable else 0o444):
            problems.append("overlay file missing or wrong mode: " + name)
    if standin.get(STANDIN_DIR, ("", 0, b""))[:2] != ("directory", 0o555):
        problems.append("overlay directory missing or wrong mode")
    return problems


def build(production_cpio, init_standin, provider, out, pins=None, production_pins=None):
    out = Path(out)
    pins = pins if pins is not None else json.loads((HERE / "standin-pins.json").read_text())
    production_pins = production_pins if production_pins is not None else json.loads((HERE / "pins.json").read_text())
    base = Path(production_cpio).read_bytes()
    tree = read_cpio(base)
    production = snapshot(tree)
    rewrite = image.Tree()
    rewrite.nodes = {name: dict(node) for name, node in tree.nodes.items()}
    with tempfile.TemporaryDirectory() as scratch:
        rewrite.cpio(Path(scratch) / "roundtrip.cpio")
        roundtrip = (Path(scratch) / "roundtrip.cpio").read_bytes()
    if roundtrip != base:
        raise ValueError("the production cpio does not survive a read and a rewrite unchanged; refusing to overlay it")
    overlay(tree, Path(init_standin).read_bytes(), Path(provider).read_bytes(), (GUEST / "standin/standin_prepare.py").read_bytes(), (GUEST / "standin/profile.json").read_bytes())
    problems = overlay_problems(production, snapshot(tree))
    if problems:
        raise ValueError("; ".join(problems))
    out.mkdir()
    tree.cpio(out / "initramfs.cpio")
    cpio_sha = sha((out / "initramfs.cpio").read_bytes())
    pinned_base = production_pins["expectedArtifact"]["cpioSha256"]
    receipt = {
        "formatVersion": 1, "profile": "standin", "testOnly": True,
        "baseCpioSha256": sha(base), "baseIsTheProductionPin": sha(base) == pinned_base,
        "initStandinSha256": sha(Path(init_standin).read_bytes()), "providerSha256": sha(Path(provider).read_bytes()),
        "prepareScriptSha256": sha((GUEST / "standin/standin_prepare.py").read_bytes()), "profileSha256": sha((GUEST / "standin/profile.json").read_bytes()),
        "initramfsSha256": cpio_sha, "initramfsBytes": (out / "initramfs.cpio").stat().st_size,
        "overlay": sorted([STANDIN_DIR, *OVERLAY_FILES, "init"]),
        "pinned": pins.get("initramfsSha256") is not None,
        "bootVerified": False,
    }
    if pins.get("initramfsSha256") is not None and pins["initramfsSha256"] != cpio_sha:
        receipt["pinMismatch"] = True
    (out / "receipt.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    return receipt


def main(argv):
    parser = argparse.ArgumentParser()
    for name in ("production-cpio", "init-standin", "provider", "out"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--kernel-sha256", help="the production kernel's digest, to print the stand-in's runtimeImageDigest")
    args = parser.parse_args(argv)
    receipt = build(args.production_cpio, args.init_standin, args.provider, args.out)
    if args.kernel_sha256:
        receipt["runtimeImageDigest"] = rid.runtime_image_digest(args.kernel_sha256, receipt["initramfsSha256"])
        (args.out / "receipt.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    print(json.dumps(receipt, indent=2, sort_keys=True))
    if not receipt["baseIsTheProductionPin"] or receipt.get("pinMismatch"):
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
