import { expect, test } from "bun:test";
import { openOutputAt } from "../../src/cowork/output-fs";
// Invalid inputs refuse BEFORE library load/syscall on every platform.
test("read helper refuses i32 wrapping descriptors and ambiguous filename encodings before FFI", () => {
  for (const fd of [-1, -2, 2 ** 31, 2 ** 32 - 2, Number.MAX_SAFE_INTEGER, NaN, 1.5]) expect(() => openOutputAt(fd, "file.bin")).toThrow("invalid_request");
  for (const name of ["", ".", "..", "../outside", "bad\0name", "\ud800", "😀".repeat(64)]) expect(() => openOutputAt(0, name)).toThrow("invalid_request");
});
