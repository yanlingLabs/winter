import XCTest
@testable import WinterCUCore

/// The §2.4 floor classifiers.
final class FloorsTests: XCTestCase {
    func testSecureFields() {
        XCTAssertTrue(CUFloors.isSecureField(role: "AXTextField", subrole: "AXSecureTextField"))
        XCTAssertTrue(CUFloors.isSecureField(role: "AXSecureTextField", subrole: nil))
        XCTAssertFalse(CUFloors.isSecureField(role: "AXTextField", subrole: "AXSearchField"))
        XCTAssertFalse(CUFloors.isSecureField(role: "AXTextArea", subrole: nil))
        XCTAssertTrue(CUNode(ref: 1, role: "AXTextField", subrole: "AXSecureTextField").isSecure)
    }

    func testAuthAndSystemDialogs() {
        for id in ["com.apple.SecurityAgent", "com.apple.loginwindow", "com.apple.keychainaccess",
                   "com.apple.UserNotificationCenter", "com.apple.Passwords"] {
            XCTAssertTrue(CUFloors.isAuthOrSystemDialog(bundleId: id, processName: nil), id)
        }
        XCTAssertTrue(CUFloors.isAuthOrSystemDialog(bundleId: nil, processName: "SecurityAgent"))
        XCTAssertTrue(CUFloors.isAuthOrSystemDialog(bundleId: nil, processName: "universalAccessAuthWarn"))
        XCTAssertFalse(CUFloors.isAuthOrSystemDialog(bundleId: "com.apple.Notes", processName: "Notes"))
        XCTAssertFalse(CUFloors.isAuthOrSystemDialog(bundleId: nil, processName: nil))
    }

    func testWinterItself() {
        for id in ["com.winter.app", "com.winter.app.dev", "com.winter.computeruse", "com.winter.computeruse.dev"] {
            XCTAssertTrue(CUFloors.isWinterItself(bundleId: id, pid: 999, ownPid: 1), id)
        }
        for id in ["com.winter.helper", "com.winter.helper.dev", "com.winter.office-helper", "com.winter.app.cefhelper.renderer",
                   "COM.WINTER.App"] {
            XCTAssertTrue(CUFloors.isWinterItself(bundleId: id, pid: 999, ownPid: 1), "every com.winter. bundle: \(id)")
        }
        XCTAssertFalse(CUFloors.isWinterItself(bundleId: "com.winterbourne.app", pid: 999, ownPid: 1))
        XCTAssertTrue(CUFloors.isWinterItself(bundleId: "com.apple.Notes", pid: 42, ownPid: 42), "the helper's own pid")
        XCTAssertFalse(CUFloors.isWinterItself(bundleId: "com.apple.Notes", pid: 42, ownPid: 1))
        XCTAssertFalse(CUFloors.isWinterItself(bundleId: nil, pid: 42, ownPid: 1))
        XCTAssertTrue(CUFloors.alwaysExcludedFromScreenshots.contains("com.winter.computeruse"))
        XCTAssertTrue(CUFloors.alwaysExcludedFromScreenshots.contains("com.winter.computeruse.dev"))
        XCTAssertTrue(CUFloors.excludedFromScreenshots("com.winter.app.cefhelper.gpu", extra: []))
        XCTAssertTrue(CUFloors.excludedFromScreenshots("com.apple.SecurityAgent", extra: []))
        XCTAssertTrue(CUFloors.excludedFromScreenshots("com.1password.1password", extra: ["com.1password.1password"]))
        XCTAssertFalse(CUFloors.excludedFromScreenshots("com.apple.Notes", extra: []))
    }

    func testPrivacyPanes() {
        let ss = "com.apple.systempreferences"
        XCTAssertTrue(CUFloors.isPrivacyPane(bundleId: ss, texts: ["Privacy & Security"], identifiers: []))
        XCTAssertTrue(CUFloors.isPrivacyPane(bundleId: ss, texts: ["  privacy & security "], identifiers: []))
        XCTAssertTrue(CUFloors.isPrivacyPane(bundleId: ss, texts: ["Datenschutz & Sicherheit"], identifiers: []))
        // A sub-pane is titled "Accessibility"; its identifiers give it away.
        XCTAssertTrue(CUFloors.isPrivacyPane(bundleId: ss, texts: ["Accessibility"],
                                             identifiers: ["com.apple.settings.PrivacySecurity.extension"]))
        XCTAssertTrue(CUFloors.isPrivacyPane(bundleId: ss, texts: [], identifiers: ["Privacy_ScreenCapture"]))
        XCTAssertFalse(CUFloors.isPrivacyPane(bundleId: ss, texts: ["Wi‑Fi", "Accessibility"], identifiers: ["com.apple.wifi"]))
        // Only System Settings counts.
        XCTAssertFalse(CUFloors.isPrivacyPane(bundleId: "com.apple.Notes", texts: ["Privacy & Security"], identifiers: []))
    }

    func testProtectedSavePaths() {
        let home = "/Users/u"
        for p in ["~/.zshrc", "/Users/u/.bashrc", ".profile", "~/.ssh/id_ed25519", "~/.ssh", "/Users/u/.ssh/config",
                  "~/Library/LaunchAgents/com.x.plist", "/Library/LaunchDaemons/evil.plist", "~/.config/fish/config.fish",
                  "~/.config/fish/conf.d/x.fish", "~/Documents/../.zprofile"] {
            XCTAssertTrue(CUFloors.isProtectedSavePath(p, home: home), p)
        }
        for p in ["~/Documents/notes.txt", "report.pdf", "/tmp/out.csv", "~/sshkeys.txt", "", "~/Library/Agents.txt"] {
            XCTAssertFalse(CUFloors.isProtectedSavePath(p, home: home), p)
        }
    }

    func testTypedSavePaths() {
        XCTAssertTrue(CUFloors.typedSavePathIsProtected(".zshrc", home: "/Users/u"))
        XCTAssertTrue(CUFloors.typedSavePathIsProtected("go to ~/.ssh/authorized_keys now", home: "/Users/u"))
        XCTAssertFalse(CUFloors.typedSavePathIsProtected("Quarterly report", home: "/Users/u"))
        XCTAssertFalse(CUFloors.typedSavePathIsProtected("my file name.txt", home: "/Users/u"))
    }

    func testFloorErrors() {
        let e = CUError.refused(.secureField, "no")
        XCTAssertEqual(e.code, "refused")
        XCTAssertEqual(e.data?["reason"], .string("secure_field"))
        XCTAssertEqual(CUFloorReason.savePath.rawValue, "save_path")
        XCTAssertEqual(CUFloorReason.winterItself.rawValue, "winter_itself")
        XCTAssertEqual(CUFloorReason.privacyPane.rawValue, "privacy_pane")
        XCTAssertEqual(CUFloorReason.authDialog.rawValue, "auth_dialog")
    }
}
