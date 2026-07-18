# OS floor raised to macOS 26 / iOS 26 (SP3)
The next Mac release MUST set:
- Sparkle appcast `<sparkle:minimumSystemVersion>26.0</sparkle:minimumSystemVersion>` (scripts/release-lib.ts appcast builder)
- Homebrew cask `depends_on macos: ">= :tahoe"` (packaging/norma.rb.tmpl)
Pre-Tahoe Macs stop being served updates — an accepted, user-confirmed decision (see memory latest-os-floors).
