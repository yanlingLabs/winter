"""Build the pinned guest kernel on a plain Linux ARM64 host, from the pins in pins.json and the open values in ci-build.json.

NOT RUN by the slice that wrote it. It runs only inside the one-run workflow `cowork-guest-image-build.yml`, after the owner arms it. Its pure parts (digest and
signature checks, the config merge, the command rewrite, the resolved-config check) are unit tested by test_native_build.py.

What it does, in order, and refuses at the first thing that is off:
  1. every input archive, signature and key is the pinned bytes (SHA-256), and each signature verifies with exactly the pinned signer;
  2. the kernel and the compiler are unpacked; the base config plus the one-symbol fragment are merged;
  3. the pinned `olddefconfig` runs, and the resolved .config must hold every required symbol at its required value;
  4. the pinned `Image vmlinux` build runs;
  5. SHA-256 of Image, vmlinux and the resolved .config go into a receipt.
It downloads nothing and installs nothing: the workflow fetches the inputs (checking each digest again) and this script only reads them.
"""
import argparse, hashlib, json, os, re, shutil, subprocess, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
PINS = json.loads((HERE / "pins.json").read_text())
CI = json.loads((HERE / "ci-build.json").read_text())

ARCHIVES = {
    "kernel": ("linux-6.18.35.tar.xz", "linux-6.18.35.tar.sign", "gregkh.key"),
    "toolchain": ("llvm-20.1.8-aarch64.tar.xz", "llvm-20.1.8-aarch64.tar.sign", "nathan.key"),
}
SOURCE_PREFIX = "/build/src/linux-6.18.35"
OUTPUT_PREFIX = "O=/build/output"
LLVM_PREFIX = "LLVM=/build/llvm/llvm-20.1.8-aarch64/bin/"
LLVM_BIN_PATH = "/build/llvm/llvm-20.1.8-aarch64/bin"


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def check_pinned_file(path, expected):
    actual = sha256_file(path)
    if actual != expected:
        raise ValueError(f"{Path(path).name}: digest {actual} is not the pinned {expected}")


def config_symbol(line):
    """The symbol a config line sets or unsets, or None for any other line."""
    match = re.match(r"^(?:# )?(CONFIG_[A-Za-z0-9_]+)(?:=| is not set$)", line)
    return match.group(1) if match else None


def merge_config(base_text, fragment_text):
    """Base config with every symbol the fragment names replaced by the fragment's line, appended at the end. Order of everything else is kept."""
    fragment = [line for line in fragment_text.splitlines() if config_symbol(line)]
    names = {config_symbol(line) for line in fragment}
    if len(names) != len(fragment):
        raise ValueError("the fragment names a symbol twice")
    kept = [line for line in base_text.splitlines() if config_symbol(line) not in names]
    return "\n".join(kept + fragment) + "\n"


def resolved_value(config_text, symbol):
    value = "n"
    for line in config_text.splitlines():
        if config_symbol(line) == symbol:
            value = "n" if line.startswith("# ") else line.split("=", 1)[1]
    return value


def resolved_config_problems(config_text, required, absent):
    """Every required symbol at exactly its value (a dropped symbol counts as n), and no must-be-absent symbol on."""
    problems = [f"{symbol} is {resolved_value(config_text, symbol)}, required {value}" for symbol, value in required.items() if resolved_value(config_text, symbol) != value]
    problems += [f"{symbol} must be absent but is {resolved_value(config_text, symbol)}" for symbol in absent if resolved_value(config_text, symbol) not in ("n",)]
    return problems


def rewrite_command(command, source, output, llvm_bin, jobs):
    """The pinned make command with the container paths replaced by this host's. Anything else in it is kept, and an unknown shape is refused."""
    out = []
    for part in command:
        if part == "/usr/bin/make":
            out.append("make")
        elif part == SOURCE_PREFIX:
            out.append(str(source))
        elif part == OUTPUT_PREFIX:
            out.append(f"O={output}")
        elif part == LLVM_PREFIX:
            out.append(f"LLVM={llvm_bin}/")
        elif part == "-j2":
            out.append(f"-j{jobs}")
        elif part in ("-C", "ARCH=arm64", "LLVM_IAS=1", "olddefconfig", "Image", "vmlinux") or part.startswith("PAHOLE_FLAGS="):
            out.append(part)
        else:
            raise ValueError(f"unexpected token in the pinned command: {part}")
    return out


def build_environment(llvm_bin):
    env = dict(PINS["environment"])
    env["PATH"] = f"{llvm_bin}:/usr/bin:/bin"
    env["SOURCE_DATE_EPOCH"] = CI["sourceDateEpoch"]
    env["KBUILD_BUILD_TIMESTAMP"] = CI["kbuildBuildTimestamp"]
    env["HOME"] = env.get("HOME", "/nonexistent")
    return env


def gpg_verify(signature, data, public_key, fingerprints, gpg="gpg"):
    """The detached signature verifies over `data` with a key whose signing-key or primary fingerprint is one of `fingerprints`. A throwaway keyring is used and removed."""
    with tempfile.TemporaryDirectory() as home:
        os.chmod(home, 0o700)
        base = [gpg, "--homedir", home, "--batch", "--no-tty"]
        subprocess.run(base + ["--import", str(public_key)], check=True, capture_output=True)
        result = subprocess.run(base + ["--status-fd", "1", "--verify", str(signature), str(data)], capture_output=True, text=True)
    if result.returncode != 0:
        raise ValueError("signature does not verify")
    for line in result.stdout.splitlines():
        if line.startswith("[GNUPG:] VALIDSIG "):
            fields = line.split()[2:]
            # VALIDSIG <signing-key fpr> <date> <ts> <expire> <ver> <res> <pk-algo> <hash-algo> <class> <primary fpr>: the signing key is field 0, the primary field 9.
            if len(fields) > 9 and (fields[0] in fingerprints or fields[9] in fingerprints):
                return
    raise ValueError("signature is valid but not by the pinned signer")


def run(command, cwd, env, log):
    log.write(" ".join(command) + "\n")
    log.flush()
    subprocess.run(command, cwd=cwd, env=env, check=True, stdout=log, stderr=subprocess.STDOUT)


def check_inputs(downloads):
    """Every input archive, signature and key, and the two config files, is the pinned bytes."""
    downloads = Path(downloads)
    for key in ("kernel", "toolchain"):
        archive, signature, public_key = ARCHIVES[key]
        pin = PINS[key]
        check_pinned_file(downloads / archive, pin["sha256"])
        check_pinned_file(downloads / signature, pin["signatureSha256"])
        check_pinned_file(downloads / public_key, pin["publicKeySha256"])
    check_pinned_file(HERE / PINS["baseConfig"]["file"], PINS["baseConfig"]["sha256"])
    check_pinned_file(HERE / PINS["fragment"]["file"], PINS["fragment"]["sha256"])


def verify_signatures(downloads, kernel_tar, toolchain_tar):
    """Both signatures are over the DECOMPRESSED tar (kernel.org signs the .tar, not the .tar.xz; run 39323466135 showed the xz stream does not verify)."""
    downloads = Path(downloads)
    gpg_verify(downloads / ARCHIVES["kernel"][1], kernel_tar, downloads / ARCHIVES["kernel"][2], {PINS["kernel"]["signerFingerprint"]})
    gpg_verify(downloads / ARCHIVES["toolchain"][1], toolchain_tar, downloads / ARCHIVES["toolchain"][2],
               {PINS["toolchain"]["signerFingerprint"], PINS["toolchain"]["primaryFingerprint"]})


def resolve_and_build(commands, source, output, env, log, runner=run):
    """`olddefconfig` first; the resolved .config must hold every required symbol before the real build is allowed to start."""
    runner(commands[0], source, env, log)
    problems = resolved_config_problems((Path(output) / ".config").read_text(), PINS["requiredSymbols"], PINS["mustBeAbsentFromTheBuild"])
    if problems:
        raise ValueError("resolved config refused: " + "; ".join(problems))
    runner(commands[1], source, env, log)


def build(downloads, work, out):
    downloads, work, out = Path(downloads), Path(work), Path(out)
    if work.exists() or out.exists():
        raise ValueError("fresh --work and --out are required")
    check_inputs(downloads)
    work.mkdir(parents=True)
    out.mkdir(parents=True)
    tar, llvm_tar = work / "linux-6.18.35.tar", work / "llvm-20.1.8-aarch64.tar"
    for target, key in ((tar, "kernel"), (llvm_tar, "toolchain")):
        with open(target, "wb") as handle:
            subprocess.run(["xz", "-dc", str(downloads / ARCHIVES[key][0])], check=True, stdout=handle)
    verify_signatures(downloads, tar, llvm_tar)
    source_root, llvm_root, output = work / "src", work / "llvm", work / "output"
    for folder in (source_root, llvm_root, output):
        folder.mkdir()
    subprocess.run(["tar", "-xf", str(tar), "-C", str(source_root)], check=True)
    tar.unlink()
    subprocess.run(["tar", "-xf", str(llvm_tar), "-C", str(llvm_root)], check=True)
    llvm_tar.unlink()
    source = source_root / "linux-6.18.35"
    llvm_bin = llvm_root / "llvm-20.1.8-aarch64" / "bin"
    if not source.is_dir() or not (llvm_bin / "clang").is_file():
        raise ValueError("unexpected archive layout")
    (output / ".config").write_text(merge_config((HERE / PINS["baseConfig"]["file"]).read_text(), (HERE / PINS["fragment"]["file"]).read_text()))
    env = build_environment(str(llvm_bin))
    commands = [rewrite_command(command, source, output, llvm_bin, CI["jobs"]) for command in PINS["commands"]]
    with open(out / "build.log", "w") as log:
        resolve_and_build(commands, source, output, env, log)
    image, vmlinux, config = output / CI["installedKernel"]["buildOutput"], output / "vmlinux", output / ".config"
    shutil.copyfile(image, out / "Image")
    shutil.copyfile(config, out / "resolved.config")
    kernel, toolchain = PINS["kernel"], PINS["toolchain"]
    receipt = {
        "formatVersion": 1, "kernelVersion": kernel["version"], "toolchain": toolchain["version"], "jobs": CI["jobs"], "sourceDateEpoch": CI["sourceDateEpoch"],
        "kbuildBuildTimestamp": CI["kbuildBuildTimestamp"],
        "ImageSha256": sha256_file(image), "ImageBytes": image.stat().st_size, "vmlinuxSha256": sha256_file(vmlinux), "resolvedConfigSha256": sha256_file(config),
        "installedAs": CI["installedKernel"]["installedAs"], "bootVerified": False,
    }
    (out / "kernel-receipt.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    return receipt


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--downloads", type=Path, required=True)
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    receipt = build(args.downloads, args.work, args.out)
    print(json.dumps(receipt, indent=2, sort_keys=True))


if __name__ == "__main__":
    sys.exit(main())
