#import "NormaCEFAssetResolve.h"

#include <cstdlib>
#include <cstring>
#include <string>
#include <unistd.h>

// editor-plumbing Task 2 — the implementation of the fence the header describes.
//
// **Nothing here may grow a CEF dependency.** The whole reason this is a separate translation unit
// is that the app suite can call it: CEF refuses to start under XCTest, so a fence living inside
// the resource handler would be untestable by construction. One `#include "include/cef_*.h"` added
// below would quietly undo that — the file would still compile, and `EditorPlumbingTests` would
// still pass, right up until the day the scheme needs a change nobody can verify.

namespace {

/// A hex digit's value, or -1 for anything else — INCLUDING the string terminator, which is what
/// makes the two-character lookahead in `PercentDecodeOnce` safe without a separate length check.
int HexValue(char c) {
  if (c >= '0' && c <= '9') {
    return c - '0';
  }
  if (c >= 'a' && c <= 'f') {
    return c - 'a' + 10;
  }
  if (c >= 'A' && c <= 'F') {
    return c - 'A' + 10;
  }
  return -1;
}

/// Percent-decode `input` into `out`. **ONE PASS, never a loop over the result** — `%252e%252e`
/// becomes the literal `%2e%2e` here and stops, where a re-decoding loop would turn it into `..`
/// and hand the caller a traversal the fence was written to stop.
///
/// Returns false — refusing the whole path — for a malformed escape (`%z`, `%2`, a trailing `%`)
/// and for an encoded NUL. Both could instead be passed through as literal bytes, and both are
/// refused on purpose: the assets this scheme serves are Norma's own vendored files, none of which
/// contains a `%` in its name, so accepting either only widens what a URL can say. `%00` in
/// particular is the standard truncation trick against every C consumer of the resolved path.
///
/// `+` is NOT decoded to a space. That is form-encoding, not path-encoding, and a path segment's
/// `+` is a literal plus (Monaco ships none, but the rule is the rule).
bool PercentDecodeOnce(const char *input, std::string &out) {
  for (const char *p = input; *p != '\0'; ++p) {
    if (*p != '%') {
      out.push_back(*p);
      continue;
    }
    const int high = HexValue(p[1]);
    if (high < 0) {
      return false;
    }
    const int low = HexValue(p[2]);
    if (low < 0) {
      return false;
    }
    const int value = (high << 4) | low;
    if (value == 0) {
      return false;
    }
    out.push_back(static_cast<char>(value));
    p += 2;
  }
  return true;
}

}  // namespace

char *NormaCEFEditorAssetResolve(const char *assetsRoot, const char *urlPath) {
  if (assetsRoot == nullptr || *assetsRoot == '\0' || urlPath == nullptr || *urlPath == '\0') {
    // An unset root is the state the handler is in before `NormaCEFRegisterEditorAssetRoot` runs.
    // It resolves NOTHING rather than falling back to the process's working directory.
    return nullptr;
  }

  std::string decoded;
  if (!PercentDecodeOnce(urlPath, decoded) || decoded.empty()) {
    return nullptr;
  }

  // Join with exactly one separator. Written to survive a root given with or without a trailing
  // slash, and a path given with or without a leading one — including the degenerate root "/",
  // where dropping the trailing slash leaves an empty string and the path supplies the separator.
  std::string joined(assetsRoot);
  if (joined.back() == '/') {
    joined.pop_back();
  }
  if (decoded.front() != '/') {
    joined.push_back('/');
  }
  joined += decoded;

  // BOTH sides. The root as well: scratch and bundle paths on this platform run through symlinked
  // parents (`/var` → `/private/var`), and comparing a raw root against a resolved target either
  // refuses everything or, with the operands the other way round, accepts everything.
  char *rootReal = realpath(assetsRoot, nullptr);
  if (rootReal == nullptr) {
    return nullptr;
  }
  char *targetReal = realpath(joined.c_str(), nullptr);
  if (targetReal == nullptr) {
    // `realpath` fails for a path that does not exist, so a miss lands here — indistinguishable, to
    // the caller, from an escape. That is deliberate: a resolver that reported which of the two
    // happened would be a directory oracle over the whole disk.
    free(rootReal);
    return nullptr;
  }

  // Containment, with the separator boundary that a bare prefix test lacks: `/tmp/assets-elsewhere`
  // string-starts-with `/tmp/assets`. Comparing against `<root>/` instead of `<root>` also refuses
  // the root itself, which is a directory rather than an asset.
  std::string prefix(rootReal);
  if (prefix.back() != '/') {
    prefix.push_back('/');
  }
  const std::string target(targetReal);
  const bool inside =
      target.size() > prefix.size() && target.compare(0, prefix.size(), prefix) == 0;

  // Belt to `realpath`'s braces. The fence's contract includes existence — callers treat NULL as
  // "404" without a second `stat` — so it is checked rather than merely implied. Regular-file-ness
  // is NOT checked here; that belongs to the reader, which has to `stat` for a size anyway.
  char *resolved = (inside && access(targetReal, F_OK) == 0) ? strdup(targetReal) : nullptr;

  free(rootReal);
  free(targetReal);
  return resolved;
}
