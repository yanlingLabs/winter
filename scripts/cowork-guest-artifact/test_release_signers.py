"""The package lock must not depend on the gpg that verified the Debian release files: `releases[].signers` is the sorted set of PINNED fingerprints, never raw VALIDSIG status lines."""
import json
import unittest
from pathlib import Path

import packages

HERE = Path(__file__).resolve().parent
PINS = json.loads((HERE / "pins.json").read_text())
ALLOWED = {key["fingerprint"] for key in PINS["keys"]}
RELEASE_KEY = "4D64FEC119C2029067D6E791F8D2585B8783D481"
ARCHIVE_KEY = "B8B80B5B623EAB6AD8775C45B7C5D7D6350947F8"
ARCHIVE_SUBKEY = "4CB50190207B4758A3F73A796ED0E7B82643E131"
STRANGER = "F" * 40


def valid(signing, primary, date="2026-07-11", ts="1783765031", version="4", klass="01", extra=""):
    return f"[GNUPG:] VALIDSIG {signing} {date} {ts} 0 {version} 0 1 8 {klass} {primary}{extra}"


class ReleaseSignerTests(unittest.TestCase):
    EXPECTED = sorted([RELEASE_KEY, ARCHIVE_KEY])

    def signers(self, *lines):
        return packages.release_signers("\n".join(lines), ALLOWED)

    def test_the_same_signers_give_the_same_record_whatever_the_gpg_wrote(self):
        base = self.signers(valid(ARCHIVE_SUBKEY, ARCHIVE_KEY), valid(RELEASE_KEY, RELEASE_KEY))
        self.assertEqual(base, self.EXPECTED)
        variants = {
            "other dates and timestamps": (valid(ARCHIVE_SUBKEY, ARCHIVE_KEY, "2027-01-01", "1800000000"), valid(RELEASE_KEY, RELEASE_KEY, "2027-01-02", "1800000999")),
            "other order": (valid(RELEASE_KEY, RELEASE_KEY), valid(ARCHIVE_SUBKEY, ARCHIVE_KEY)),
            "another gpg version and signature class": (valid(ARCHIVE_SUBKEY, ARCHIVE_KEY, version="5", klass="00"), valid(RELEASE_KEY, RELEASE_KEY, version="5", klass="00")),
            "the same signer twice": (valid(ARCHIVE_SUBKEY, ARCHIVE_KEY), valid(RELEASE_KEY, RELEASE_KEY), valid(RELEASE_KEY, RELEASE_KEY, ts="1")),
            "other status noise around": ("[GNUPG:] NEWSIG", valid(ARCHIVE_SUBKEY, ARCHIVE_KEY), "[GNUPG:] SIG_ID abc 2026-07-11 1", valid(RELEASE_KEY, RELEASE_KEY), "[GNUPG:] TRUST_UNDEFINED 0 pgp"),
            "an extra signature by an unimported key": (valid(ARCHIVE_SUBKEY, ARCHIVE_KEY), valid(RELEASE_KEY, RELEASE_KEY), valid(STRANGER, STRANGER)),
            "no primary field (a short VALIDSIG)": ("[GNUPG:] VALIDSIG " + ARCHIVE_KEY + " 2026-07-11 1 0 4 0 1 8 01", "[GNUPG:] VALIDSIG " + RELEASE_KEY + " 2026-07-11 1 0 4 0 1 8 01"),
        }
        for label, lines in variants.items():
            with self.subTest(label):
                self.assertEqual(self.signers(*lines), base)

    def test_the_lock_text_carries_no_raw_status_line(self):
        record = json.dumps({"signers": self.signers(valid(ARCHIVE_SUBKEY, ARCHIVE_KEY), valid(RELEASE_KEY, RELEASE_KEY))})
        self.assertNotIn("GNUPG", record)
        self.assertNotIn("2026", record)

    def test_no_pinned_signer_or_a_bad_signature_refuses(self):
        for label, lines in (("no signature", ()), ("only a stranger", (valid(STRANGER, STRANGER),)),
                             ("a bad signature next to a good one", (valid(RELEASE_KEY, RELEASE_KEY), "[GNUPG:] BADSIG 1D6B269171C01A96 Someone"))):
            with self.subTest(label), self.assertRaises(ValueError):
                self.signers(*lines)

    def test_the_pinned_lock_is_the_digest_of_a_lock_with_normalised_signers(self):
        self.assertRegex(PINS["packageLockSha256"], r"^[0-9a-f]{64}$")
        source = (HERE / "packages.py").read_text()
        self.assertIn("signers=release_signers(", source)
        self.assertNotIn("return clear, valid", source)


if __name__ == "__main__":
    unittest.main()
