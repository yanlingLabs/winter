#ifndef NormaCEFAssetResolve_h
#define NormaCEFAssetResolve_h

#include <stddef.h>

/// editor-plumbing Task 2 — the `norma-editor://` scheme's PATH FENCE, and nothing else.
///
/// **This file deliberately includes no CEF header, no AppKit header and no Objective-C.** It is
/// the one piece of the scheme a test can execute: CEF never starts under XCTest (`NormaCEFRuntime`
/// refuses; `CEFRuntimeTests` pins that), so a fence written inside the resource handler would be
/// unreachable by every test this repo can run, forever. Split out, it is a plain C function over
/// two strings that the app suite calls directly — which is why the fence, and not the handler,
/// is where the security property lives.
///
/// THE PROPERTY. `NormaCEFEditorAssetResolve` answers a filesystem path only when that path is a
/// real, existing file strictly INSIDE `assetsRoot` after full canonicalisation of both sides. Not
/// "the URL looked harmless": `..`, percent-encoded `..`, and symlinks pointing out of the tree are
/// all resolved away before the containment test runs, because each of them is a way for a
/// syntactically-inside path to name an outside file. The scheme serves the app's own vendored
/// editor assets and nothing else — user file content reaches the editor over the JS bridge, never
/// over this scheme — so a resolver that can be talked into `~/.ssh/id_ed25519` is the whole risk
/// this function exists to remove.
///
/// THE ORDER IS THE POINT, and every step is load-bearing:
///
///   1. **Percent-decode `urlPath` — exactly once.** A single pass, never a loop: decoding twice is
///      the classic hole (`%252e%252e` survives one pass as `%2e%2e` and becomes `..` on the
///      second). A malformed escape (`%z`, a trailing `%`) and an encoded NUL (`%00`) are REFUSED
///      rather than passed through literally — fail closed, and no asset Norma ships needs either.
///   2. **Join** `assetsRoot` and the decoded path with exactly one separator.
///   3. **`realpath()` BOTH sides.** The root as well as the target: this checkout's own scratch
///      directories live under `/var/folders/...`, which is a symlink to `/private/var/...`, so an
///      unresolved root fails to prefix-match a resolved target and the fence would refuse
///      everything (or, with the comparison the other way round, accept everything).
///   4. **Prefix test PLUS a separator boundary.** `strncmp` alone accepts a SIBLING whose name
///      merely starts with the root's — `/tmp/assets-elsewhere/x` "begins with" `/tmp/assets` —
///      so the byte after the prefix must be `/`. Equality with the root itself is refused too: the
///      root is a directory, and a directory is not an asset.
///   5. **`access(F_OK)`.** `realpath` already fails for a path that does not exist, so this is
///      belt-and-braces rather than the existence check on its own; it is stated as a step because
///      the fence's contract INCLUDES existence (a caller may treat NULL as "404" without a second
///      `stat`). Regular-file-ness is deliberately NOT checked here — that belongs with the reader,
///      which has to `stat` for a size anyway.
///
/// Returns a `malloc`'d absolute path the CALLER FREES, or NULL. NULL is the only failure signal
/// and it never distinguishes "escaped the root" from "does not exist" — a resolver that told an
/// attacker which of the two happened would be a directory oracle over the user's disk.
///
/// `urlPath` is a URL PATH, not a URL: no scheme, no host, no query, no fragment. Splitting those
/// off is the handler's job (`CefParseURL`), and keeping them out of here is what lets this
/// function stay CEF-free.

#ifdef __cplusplus
extern "C" {
#endif

/// The resolved absolute path (caller `free`s) iff `urlPath` names an existing file strictly inside
/// `assetsRoot` after canonicalisation; NULL otherwise. NULL or empty arguments answer NULL.
char *NormaCEFEditorAssetResolve(const char *assetsRoot, const char *urlPath);

#ifdef __cplusplus
}
#endif

#endif /* NormaCEFAssetResolve_h */
