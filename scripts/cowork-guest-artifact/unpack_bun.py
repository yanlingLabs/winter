"""Unpack the pinned official Linux ARM64 Bun release archive into one executable, checking every digest. Reads the archive, writes one file.

    python3 -I -S -B unpack_bun.py ARCHIVE.zip OUTPUT_EXECUTABLE

The archive must already be the pinned bytes (the workflow checks `archiveSha256` before calling this, and this checks it again); the single entry named in
pins.json is read with a size bound and must hash to `executableSha256`. The output is created exclusively (never overwritten) and is not executed here.
"""
import hashlib, io, json, os, sys, zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
MAX_ARCHIVE = 64 * 1024 * 1024
MAX_ENTRY = 128 * 1024 * 1024


def unpack(archive, output, pins=None):
    pins = pins or json.loads((HERE / "pins.json").read_text())["bun"]
    data = Path(archive).read_bytes()
    if len(data) > MAX_ARCHIVE or hashlib.sha256(data).hexdigest() != pins["archiveSha256"]:
        raise ValueError("the Bun archive is not the pinned bytes")
    with zipfile.ZipFile(io.BytesIO(data)) as bundle:
        entry = bundle.getinfo(pins["archiveEntry"])
        if entry.is_dir() or entry.file_size > MAX_ENTRY:
            raise ValueError("the pinned Bun entry is not a bounded file")
        executable = bundle.read(entry)
    if hashlib.sha256(executable).hexdigest() != pins["executableSha256"]:
        raise ValueError("the Bun executable is not the pinned bytes")
    descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o755)
    try:
        with os.fdopen(descriptor, "wb", closefd=False) as handle:
            handle.write(executable)
    finally:
        os.close(descriptor)


if __name__ == "__main__":
    if sys.argv[1:] == ["--help"]:
        raise SystemExit(0 if print("usage: unpack_bun.py ARCHIVE.zip OUTPUT") is None else 1)
    if len(sys.argv) != 3:
        raise SystemExit("usage: unpack_bun.py ARCHIVE.zip OUTPUT")
    unpack(sys.argv[1], sys.argv[2])
