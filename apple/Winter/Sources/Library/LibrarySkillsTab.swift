import SwiftUI

// -----------------------------------------------------------------------------------------------
// Library → Skills (2026-09-17).
//
// A RE-HOUSING, not a rewrite. `skills.list`/`read`/`write`/`delete` all exist on the daemon,
// `WinterClient+Methods.swift` wraps all four, and `SkillsPaneModel` (Sources/Dashboard/panes/
// SkillsPane.swift) already drives the whole list + edit + delete loop against them. The Library's
// Skills tab is therefore the SAME `SkillsPane`, mounted here — the exact same posture Task 7 took
// when the Dashboard moved into the shell (the design review's verified finding: pane moves are
// re-hosting, never rewrites).
//
// Why a wrapper view at all, rather than `SkillsPane(model:)` straight in `LibraryPanel`'s switch:
// the tab owns one fact the pane does not, and that fact needs somewhere to live — see the
// comment below on per-skill enable/disable. A wrapper also keeps the "every tab is a
// `Library*Tab`" symmetry, so the switch in `ShellOverlays.swift` reads as five peers rather than
// two mounted panes and three bespoke bodies.
//
// The pane is mounted with the SAME model instance the Dashboard's own Skills pane uses
// (`DashboardWiring.skillsModel`, built once per process in `AppDelegate.makeDashboardWiring`).
// That is deliberate and harmless: the model re-seeds itself on `.task`, so whichever surface
// appears last has the fresh list, and an edit made in one is visible in the other on its next
// appearance. It does mean a half-typed, unsaved edit in one surface is visible in the other —
// which is the honest behaviour for "one skill store, two windows onto it", not a bug to paper
// over with a second model.
// -----------------------------------------------------------------------------------------------

struct LibrarySkillsTab: View {
    @ObservedObject var model: SkillsPaneModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SkillsPane(model: model)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            // NO per-skill enable/disable toggle here, and this is a decision rather than an
            // omission: the daemon has no per-skill on/off switch today. The mechanism being built
            // for it (another session) is a permission DENY RULE spelled `Skill(<name>)` — i.e.
            // disabling a skill is a rules-store write, not a field on the skill, and it will
            // arrive through the permissions surface with the rest of the deny vocabulary. Adding
            // a toggle here now would mean inventing a second, unbacked source of truth for
            // "is this skill on", which is exactly the split-brain the rule design avoids.
            //
            // When `Skill(<name>)` lands, it arrives as a per-row toggle bound to the rule's
            // presence — the list above needs no change. (The footnote that used to explain this
            // under the list is gone: user call, 2026-09-18, no explanatory footer rows.)
        }
    }
}
