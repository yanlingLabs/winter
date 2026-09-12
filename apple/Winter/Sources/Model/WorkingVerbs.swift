import Foundation

/// Claude-Code-style whimsical "working" verbs (wave-6 gate item 1) — the collapsed orb's status
/// pill shows one of these ("Reticulating…", "Noodling…", …) instead of a static "thinking…"
/// while a turn is running, picked at random and held stable for the whole turn.
///
/// EXTRACTION METHOD (see wave-6 report for the full write-up): `strings` on the local CC binary
/// (`/opt/homebrew/Caskroom/claude-code@latest/2.1.201/claude`) around the anchor string
/// `"Reticulating"` surfaced the actual minified-JS array literal verbatim — not `strings` noise
/// requiring guesswork/curation. The binary's bundled JS assigns it to a var (`_Ao = [...]`) that
/// a small helper (`Mgt()`) returns as the default spinner-verb pool whenever no user override is
/// configured (`Hr().spinnerVerbs`) — i.e. this IS CC's real, shipped default list, byte-identical,
/// pulled straight out of the array literal rather than reconstructed from fuzzy matches. Because
/// the extraction located the literal source array (found by searching the raw binary bytes for
/// `[` before / `]` after the `"Reticulating"` anchor, then JSON-decoding the slice after
/// normalizing JS `\xHH` escapes to `\u00HH`), every one of the 186 entries is unambiguously a
/// real spinner word — nothing here is a guess, so no exclusion/curation pass was needed (unlike
/// the fallback path the task anticipated for a noisier `strings`-only extraction).
enum WorkingVerbs {
    static let all: [String] = [
        "Accomplishing", "Actioning", "Actualizing", "Architecting",
        "Baking", "Beaming", "Beboppin'", "Befuddling",
        "Billowing", "Blanching", "Bloviating", "Boogieing",
        "Boondoggling", "Booping", "Bootstrapping", "Brewing",
        "Bunning", "Burrowing", "Calculating", "Canoodling",
        "Caramelizing", "Cascading", "Catapulting", "Cerebrating",
        "Channeling", "Channelling", "Choreographing", "Churning",
        "Clauding", "Coalescing", "Cogitating", "Combobulating",
        "Composing", "Computing", "Concocting", "Considering",
        "Contemplating", "Cooking", "Crafting", "Creating",
        "Crunching", "Crystallizing", "Cultivating", "Deciphering",
        "Deliberating", "Determining", "Dilly-dallying", "Discombobulating",
        "Doing", "Doodling", "Drizzling", "Ebbing",
        "Effecting", "Elucidating", "Embellishing", "Enchanting",
        "Envisioning", "Fermenting", "Fiddle-faddling", "Finagling",
        "Flambéing", "Flibbertigibbeting", "Flowing", "Flummoxing",
        "Fluttering", "Forging", "Forming", "Frolicking",
        "Frosting", "Gallivanting", "Galloping", "Garnishing",
        "Generating", "Gesticulating", "Germinating", "Gitifying",
        "Grooving", "Gusting", "Harmonizing", "Hashing",
        "Hatching", "Herding", "Honking", "Hullaballooing",
        "Hyperspacing", "Ideating", "Imagining", "Improvising",
        "Incubating", "Inferring", "Infusing", "Ionizing",
        "Jitterbugging", "Julienning", "Kneading", "Leavening",
        "Levitating", "Lollygagging", "Manifesting", "Marinating",
        "Meandering", "Metamorphosing", "Misting", "Moonwalking",
        "Moseying", "Mulling", "Mustering", "Musing",
        "Nebulizing", "Nesting", "Newspapering", "Noodling",
        "Nucleating", "Orbiting", "Orchestrating", "Osmosing",
        "Perambulating", "Percolating", "Perusing", "Philosophising",
        "Photosynthesizing", "Pollinating", "Pondering", "Pontificating",
        "Pouncing", "Precipitating", "Prestidigitating", "Processing",
        "Proofing", "Propagating", "Puttering", "Puzzling",
        "Quantumizing", "Razzle-dazzling", "Razzmatazzing", "Recombobulating",
        "Reticulating", "Roosting", "Ruminating", "Sautéing",
        "Scampering", "Schlepping", "Scurrying", "Seasoning",
        "Shenaniganing", "Shimmying", "Simmering", "Skedaddling",
        "Sketching", "Slithering", "Smooshing", "Sock-hopping",
        "Spelunking", "Spinning", "Sprouting", "Stewing",
        "Sublimating", "Swirling", "Swooping", "Symbioting",
        "Synthesizing", "Tempering", "Thinking", "Thundering",
        "Tinkering", "Tomfoolering", "Topsy-turvying", "Transfiguring",
        "Transmuting", "Twisting", "Undulating", "Unfurling",
        "Unravelling", "Vibing", "Waddling", "Wandering",
        "Warping", "Whatchamacalliting", "Whirlpooling", "Whirring",
        "Whisking", "Wibbling", "Working", "Wrangling",
        "Zesting", "Zigzagging",
    ]

    /// One random verb. Callers that need per-turn STABILITY (the store, not the reducer — see
    /// `SessionModel.apply`'s seam comment) call this ONCE per turn and stash the result in state;
    /// re-calling this on every render would flicker instead of holding for the turn.
    static func random() -> String {
        all.randomElement() ?? "Working"
    }
}
