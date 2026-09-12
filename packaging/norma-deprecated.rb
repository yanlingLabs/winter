# Homebrew cask for the DEPRECATED "norma" name (Winter Phase 9c, P9c-5). This is the LAST
# rendering of the "norma" cask that will ever exist — it is not regenerated on every release the
# way packaging/winter.rb.tmpl is, because Norma stops shipping releases after this one.
#
# scripts/publish-tap.ts reads this file's bytes VERBATIM and PUTs them to
# `Casks/norma.rb` on `yanlingLabs/homebrew-winter` — there is no `{{token}}`-substitution pass
# here the way `caskFrom` does for winter.rb.tmpl, because publish-tap.ts never receives the
# 0.2.015 Norma release's own version/sha256 (that release is cut by a DIFFERENT branch's pipeline
# — `norma-final`, Lane H — which this worktree cannot see and must not touch).
#
# CONTROLLER: before running `scripts/publish-tap.ts --publish` for the handoff release, replace
# the two slots below by hand with the REAL values from the norma-final 0.2.015 release:
#   {{version}}  -> "0.2.015"
#   {{sha256}}   -> the sha256 of Norma-0.2.015.dmg (printed by norma-final's own release.ts run,
#                    or `shasum -a 256 Norma-0.2.015.dmg`)
# The download `url` below is NOT a slot — it derives the filename from `#{version}` the same way
# packaging/winter.rb.tmpl does, so filling `{{version}}` above is enough to make it correct too.
# Everything else in this file (name/desc/homepage/binary stanza/the deprecate! line) is final —
# do not change it without a fresh P9c-5-equivalent ruling.
#
# `gh_repo` for this DMG asset is `yanlingLabs/winter` (P9c-12: norma-final's own GH_REPO points at
# the SAME renamed repo Winter releases live in — there is no separate "norma" repo anymore, it was
# renamed there in the Phase 9c spine).
cask "norma" do
  version "{{version}}"
  sha256 "{{sha256}}"

  # P9c-5: the norma cask is deprecated, pointing at winter, at the SAME publish that ships this
  # cask's final rendering — placed right after sha256 per the P9c-5 ruling. `because:` is a
  # free-form string (Homebrew's cask DSL accepts either a preset symbol like :discontinued or
  # prose — see docs.brew.sh/Cask-Cookbook#stanza-deprecate) so `brew install --cask norma` prints
  # exactly this sentence to the user before failing closed.
  #
  # Verified locally (Homebrew 6.0.22-323-gde1ac14, scratch tap): `brew audit --cask --strict`
  # PASSES on this DSL at this exact placement — deprecate!'s parameters and position are both
  # verbatim per the ruling. `brew style` (RuboCop's cask cop, cosmetic-only) would prefer
  # deprecate! nearer the end of the block instead — but packaging/winter.rb.tmpl carries that
  # same class of un-autocorrected stanza-order nit today (its own depends_on/auto_updates pair,
  # measured with the identical tool), so moving only THIS file would trade one inconsistency for
  # another rather than fix one; a repo-wide `brew style --fix --cask` pass, if wanted, is a
  # separate, cross-cask decision for the controller, not a divergence introduced here.
  deprecate! date: "2026-09-12", because: "Norma is now Winter — brew install --cask winter",
             replacement_cask: "winter"

  url "https://github.com/yanlingLabs/winter/releases/download/v#{version}/Norma-#{version}.dmg"
  name "Norma"
  desc "Menu bar app for the Norma AI engine"
  homepage "https://github.com/yanlingLabs/winter"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on arch: :arm64

  auto_updates true

  app "Norma.app"
  binary "#{appdir}/Norma.app/Contents/Resources/norma-core", target: "norma"
end
