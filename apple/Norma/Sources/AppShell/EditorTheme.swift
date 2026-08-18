import AppKit
import SwiftUI

/// editor-product Task 4 — Norma's brand palette, resolved to the two payloads the editor's
/// white-flash fix and branded repaint need: a Monaco `defineTheme` object (`tokensJSON`) and the
/// CEF browser's own creation-time background (`cardSurfaceBackgroundARGB`).
///
/// **`ColorScheme`, not `NSAppearance.Name`** — the plan's own stated interface
/// (`EditorTheme.tokensJSON(for scheme: ColorScheme) -> String`), and the same type
/// `MessageTextFormatter.themeColor(_:colorScheme:)` already resolves brand tokens against
/// throughout `ChatContent/`. `EditorRuntime` has no SwiftUI environment to read one from (it is not
/// a view), so it asks AppKit directly and converts once — see `EditorRuntime.currentColorScheme()`.
///
/// **No raw literals** (`docs/brand.md` § 3.1's anti-rule): every value below traces to a named
/// asset (`Theme`'s catalog, via `MessageTextFormatter.themeColor`) or a system semantic color
/// already painting something else in this app (`SyntaxHighlighter`'s own palette,
/// `NSColor.labelColor`). This file's only job is RESOLVING those to concrete sRGB hex for one
/// scheme — the one step `Color`'s automatic SwiftUI adaptation cannot do for a payload handed to a
/// Chromium page that has no SwiftUI environment at all.
enum EditorTheme {

    // MARK: - The Monaco payload

    /// The `defineTheme` payload for `scheme`, as a JSON **object** string —
    /// `EditorBridgeOutbound.setTheme(tokensJSON:)`'s own contract (it parses this back to embed as
    /// an object the page reads `message.tokens.…` off, never as a string the page would have to
    /// parse itself).
    ///
    /// `base`/`inherit`/`rules`/`colors` are exactly what `editor.js`'s `setTheme` reads (its own
    /// file header): `base` is validated there against Monaco's `BUILTIN_THEME_BASES` allowlist, and
    /// `rules`/`colors` are defaulted to empty on a shape mismatch — so a bug here degrades to an
    /// unbranded builtin rather than a dead bridge call. `inherit: true` so every one of the
    /// hundred-odd other theme colors Monaco defines, which this payload does not name, still comes
    /// from the matching builtin (`vs`/`vs-dark`) instead of defaulting to unstyled black-on-nothing.
    static func tokensJSON(for scheme: ColorScheme) -> String {
        let payload: [String: Any] = [
            "base": scheme == .dark ? "vs-dark" : "vs",
            "inherit": true,
            "rules": syntaxRules(for: scheme),
            "colors": editorColors(for: scheme)
        ]
        // `.sortedKeys` + `.withoutEscapingSlashes` — the same rendering discipline
        // `EditorBridgeOutbound.payloadJSON` uses one file over: deterministic key order (so an
        // exact-string test pin means something) and no `\/` noise in a payload that is otherwise
        // all plain hex and booleans.
        guard let data = try? JSONSerialization.data(withJSONObject: payload,
                                                     options: [.sortedKeys, .withoutEscapingSlashes]),
              let json = String(data: data, encoding: .utf8) else {
            // Unreachable — every leaf value above is a `String` or `Bool` — but not silence if it
            // ever were: `EditorBridgeOutbound.setTheme` treats unparseable tokens as `{}`, which
            // `editor.js` renders as an all-defaults builtin rather than a dead call.
            return "{}"
        }
        return json
    }

    /// The CEF browser's OWN background at creation, packed `0xAARRGGBB` — `NormaCEF.h`'s
    /// `backgroundColorARGB` parameter, in the shape CEF's `cef_color_t`/`CefColorSetARGB` already
    /// use inside the framework. The white-flash fix's OTHER half: `tokensJSON` colors the PAGE once
    /// Monaco boots and a theme lands; this colors the BROWSER itself for the window before that —
    /// asset load, the AMD bootstrap, Monaco's own construction — during which nothing has painted
    /// anything yet and Chromium's default is a flat white.
    ///
    /// Always fully opaque (`0xFF` alpha) — CEF's own contract requires the alpha component be
    /// either fully opaque or fully transparent, and `0x00…` is reserved as "no override" for every
    /// OTHER caller of `NormaCEFCreateBrowser` (ordinary web tabs, the CEF spikes): passing an
    /// intermediate alpha here would silently fall outside that contract.
    static func cardSurfaceBackgroundARGB(for scheme: ColorScheme) -> UInt32 {
        let cardSurface = MessageTextFormatter.themeColor("CardSurface", colorScheme: scheme)
        return argb(cardSurface)
    }

    // MARK: - `colors` — the editor chrome

    /// **Mapping choices, stated once here rather than scattered through the dictionary literal:**
    ///
    ///   * `editor.background` = `CardSurface` — the plane every other panel content view sits on
    ///     (`docs/brand.md` § 2's plane mapping); the editor is one more tenant of it.
    ///   * `editor.foreground` = `NSColor.labelColor`, composited over `CardSurface` rather than sent
    ///     with its own alpha — `labelColor` is measured NOT fully opaque (84.7% both appearances,
    ///     `PanelKindTintTests`), and every value this file emits is kept uniformly opaque rather than
    ///     special-casing the one translucent system ink (Monaco's own bundled theme rules never ship
    ///     an 8-digit `RRGGBBAA` — checked against the vendored bundle). Compositing is exactly
    ///     `docs/brand.md` § 3.5's method, applied at runtime instead of at measurement time.
    ///   * `editor.selectionBackground` = `SelectionPill` — the one existing token named for exactly
    ///     this job ("the selected row's fill", `Theme.swift`); already fully opaque, so compositing
    ///     it over `CardSurface` is a no-op, applied anyway so every value here shares one code path
    ///     rather than special-casing the tokens that happen to need no correction.
    ///   * `editor.lineHighlightBackground` = `RowHover` — the closest existing token to "the row
    ///     under the cursor, gently set apart from its neighbours", which is exactly what a list
    ///     row's hover state already means everywhere else in this app.
    ///   * `editorCursor.foreground` = `Theme.accent` — neither `SelectionPill` nor `RowHover` reads
    ///     as a CARET color (both are quiet row washes, and a cursor wants to be found at a glance,
    ///     not blended in); `accent` is the app's one token reserved for exactly that job elsewhere
    ///     (`Theme.swift`: "tints prominent controls and glyphs", the transcript's own selection
    ///     chrome and in-progress markers) — the nearest existing token to "the one moving thing
    ///     you're meant to notice". `docs/brand.md` § 3.4 already records the accent's own contrast
    ///     ceiling as "fine for controls and glyphs, short of the body-text floor" — a cursor is a
    ///     control-shaped mark, not a run of text, so that recorded limitation does not carry over.
    private static func editorColors(for scheme: ColorScheme) -> [String: String] {
        let cardSurface = MessageTextFormatter.themeColor("CardSurface", colorScheme: scheme)
        let selectionPill = MessageTextFormatter.themeColor("SelectionPill", colorScheme: scheme)
        let rowHover = MessageTextFormatter.themeColor("RowHover", colorScheme: scheme)
        let accent = MessageTextFormatter.themeColor("AccentColor", colorScheme: scheme)
        let labelInk = resolvedSRGB(.labelColor, for: scheme)

        return [
            "editor.background": "#" + hex(cardSurface),
            "editor.foreground": "#" + hex(composite(labelInk, over: cardSurface)),
            "editor.selectionBackground": "#" + hex(composite(selectionPill, over: cardSurface)),
            "editor.lineHighlightBackground": "#" + hex(composite(rowHover, over: cardSurface)),
            "editorCursor.foreground": "#" + hex(composite(accent, over: cardSurface))
        ]
    }

    // MARK: - `rules` — syntax colors, the SAME NSColors `SyntaxHighlighter` paints the transcript with

    /// The transcript's code blocks (`ChatContent/MessageTextFormatting.swift`'s
    /// `SyntaxHighlighter.palette`) and the editor's code now agree by construction: every rule below
    /// reads the identical `NSColor` that palette names, resolved for the same scheme.
    ///
    /// **`type` has no role of its own in `SyntaxHighlighter.palette`** — that palette has exactly
    /// four (keyword/string/number/comment), not five. Reusing `keyword`'s color rather than
    /// introducing a fifth `NSColor` the transcript never paints with: the brief's own constraint is
    /// agreement with the transcript's ACTUAL palette, and of the three other roles on offer, a type
    /// name (a class, an interface) reads far closer to a structural/declaration token — what
    /// `keyword` already means here — than to a quoted string, a numeric literal or a comment.
    private static func syntaxRules(for scheme: ColorScheme) -> [[String: String]] {
        let cardSurface = MessageTextFormatter.themeColor("CardSurface", colorScheme: scheme)
        let keyword = resolvedSRGB(.systemBlue, for: scheme)
        let string = resolvedSRGB(.systemGreen, for: scheme)
        let number = resolvedSRGB(.systemPurple, for: scheme)
        let comment = resolvedSRGB(.secondaryLabelColor, for: scheme)

        func rule(_ token: String, _ color: NSColor) -> [String: String] {
            // Bare hex, no `#` — Monaco's OWN bundled theme rules use exactly this shape for
            // `rules[].foreground` (measured in the vendored bundle: `"foreground":"608B4E"`); see
            // `hex(_:)`'s own doc for why the `colors` map above adds the `#` back.
            ["token": token, "foreground": hex(composite(color, over: cardSurface))]
        }

        return [
            rule("keyword", keyword),
            rule("string", string),
            rule("number", number),
            rule("comment", comment),
            rule("type", keyword)
        ]
    }

    // MARK: - Resolution (the srgb pattern `PanelKindTintTests`/`MessageTextFormatter.themeColor` use)

    /// A raw system color — not a named asset, so `MessageTextFormatter.themeColor`'s
    /// `NSColor(named:)` cannot reach it — resolved for an EXPLICIT appearance rather than the
    /// ambient one. `SyntaxHighlighter`'s palette and `.labelColor` are both system-dynamic; this is
    /// the same `performAsCurrentDrawingAppearance` + `usingColorSpace(.sRGB)` mechanism
    /// `MessageTextFormatter.themeColor` and `PanelKindTintTests.srgb` both already use, spelled out
    /// again here because it takes a color rather than a catalog name.
    private static func resolvedSRGB(_ color: NSColor, for scheme: ColorScheme) -> NSColor {
        var resolved = color
        let appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
        appearance?.performAsCurrentDrawingAppearance {
            resolved = color.usingColorSpace(.sRGB) ?? color
        }
        return resolved
    }

    /// Alpha-composite `top` over an OPAQUE `bottom` — `docs/brand.md` § 3.5's method
    /// (`PanelKindTintTests.composite`'s identical formula), applied here to bake every value this
    /// file emits into ONE opaque hex, whether or not the source color happened to need it.
    private static func composite(_ top: NSColor, over bottom: NSColor) -> NSColor {
        let a = top.alphaComponent
        return NSColor(srgbRed: top.redComponent * a + bottom.redComponent * (1 - a),
                       green: top.greenComponent * a + bottom.greenComponent * (1 - a),
                       blue: top.blueComponent * a + bottom.blueComponent * (1 - a), alpha: 1)
    }

    /// Uppercase `RRGGBB`, no leading `#`. Monaco's `colors` map wants the CSS convention
    /// (`"editor.background": "#1e1e1e"`, checked against the official `defineTheme` sample); its
    /// `rules[].foreground` wants the bare form (checked against the vendored bundle's own built-in
    /// theme rules: `"foreground":"608B4E"`). Callers add the `#` back only where they need it.
    private static func hex(_ color: NSColor) -> String {
        String(format: "%02X%02X%02X", byte(color.redComponent), byte(color.greenComponent),
              byte(color.blueComponent))
    }

    /// `0xFF` alpha, then the same three bytes `hex(_:)` formats — CEF's `cef_color_t` packing
    /// (`CefColorSetARGB`'s own bit layout, mirrored without including a CEF header: `NormaCEF.h`
    /// stays framework-free).
    private static func argb(_ color: NSColor) -> UInt32 {
        (0xFF << 24) | (UInt32(byte(color.redComponent)) << 16)
            | (UInt32(byte(color.greenComponent)) << 8) | UInt32(byte(color.blueComponent))
    }

    private static func byte(_ value: CGFloat) -> Int {
        min(max(Int((value * 255).rounded()), 0), 255)
    }
}
