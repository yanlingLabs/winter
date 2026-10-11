import tempfile
import unittest
import json
import hashlib
import os
import subprocess
from pathlib import Path
from closure import dependencies, is_system, resolve_reference, runpaths, validate
from build import Build, PINS, clean_environment, require_json_receipt
from unittest.mock import patch, Mock
from libslirp_provenance import COMMIT, TREE, PIN_PATH, VENDOR_PATH, tree_hashes, verify_vendor, verify_committed_vendor


class ClosureTests(unittest.TestCase):
    def test_dependency_parser_retains_weak_system_library_and_id(self):
        self.assertEqual(dependencies("a:\n\t@loader_path/a.dylib (compatibility version 0, current version 0)\n"
            "\t/usr/lib/swift/libswiftMetal.dylib (compatibility version 1, current version 2, weak)\n"),
            ["@loader_path/a.dylib", "/usr/lib/swift/libswiftMetal.dylib"])

    def test_rpaths_are_separate_from_dylib_dependencies(self):
        self.assertEqual(runpaths(" cmd LC_RPATH\n cmdsize 48\n path /opt/homebrew/lib (offset 12)\n"),
                         ["/opt/homebrew/lib"])

    def test_loader_relative_closure_refuses_escape_missing_and_absolute(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "lib"
            root.mkdir()
            binary = root / "native.dylib"
            binary.touch()
            library = root / "dependency.dylib"
            library.touch()
            self.assertEqual(resolve_reference("@loader_path/dependency.dylib", binary, root), library.resolve())
            for ref in ("/opt/homebrew/lib/dependency.dylib", "@rpath/dependency.dylib",
                        "@loader_path/missing.dylib", "@loader_path/../outside.dylib"):
                with self.subTest(ref=ref), self.assertRaises(ValueError):
                    resolve_reference(ref, binary, root)
            outside = Path(tmp) / "outside.dylib"
            outside.touch()
            (root / "escape.dylib").symlink_to(outside)
            with self.assertRaises(ValueError):
                resolve_reference("@loader_path/escape.dylib", binary, root)

    def test_system_paths_reject_parent_traversal(self):
        self.assertTrue(is_system("/usr/lib/libSystem.B.dylib"))
        self.assertTrue(is_system("/System/Library/Frameworks/Foundation.framework/Foundation"))
        self.assertFalse(is_system("/usr/lib/../../opt/homebrew/lib/evil.dylib"))

    def test_smoke_environment_strips_injected_library_search(self):
        with patch.dict("os.environ", {"DYLD_LIBRARY_PATH": "/opt/homebrew/lib", "DYLD_FALLBACK_LIBRARY_PATH": "/tmp",
            "PKG_CONFIG_LIBDIR": "/opt/homebrew/lib/pkgconfig", "LDFLAGS": "-L/opt/homebrew/lib",
            "CPATH": "/opt/homebrew/include", "GI_TYPELIB_PATH": "/tmp",
            "WINTER_COWORK_NATIVE_PROFILE": "unreviewed"}):
            env = clean_environment()
        for key in ("DYLD_LIBRARY_PATH", "DYLD_FALLBACK_LIBRARY_PATH", "PKG_CONFIG_LIBDIR", "LDFLAGS", "CPATH", "GI_TYPELIB_PATH", "WINTER_COWORK_NATIVE_PROFILE"):
            self.assertNotIn(key, env)

    def test_native_profile_rejects_unknown_sources_before_io(self):
        build = Build.__new__(Build)
        with self.assertRaisesRegex(ValueError, "unknown native source profile"):
            build.prepare_native("/tmp/unreviewed-dependency")

    def test_smoke_needs_typed_completion_receipt_even_after_successful_exit(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp) / "smoke.log"
            for content in ("", "ordinary output\n", '{"realVM":0}\n', '{"realVM":true}\n'):
                log.write_text(content)
                with self.assertRaisesRegex(ValueError, "without required execution receipt"):
                    require_json_receipt(log, {"realVM": False})
            log.write_text('ordinary output\n{"realVM":false,"nodeAPI":true}\n')
            self.assertEqual(require_json_receipt(log, {"realVM": False, "nodeAPI": True}),
                             {"realVM": False, "nodeAPI": True})

    def test_vendor_pin_refuses_changed_missing_extra_and_aliased_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "vendor"
            root.mkdir()
            source = root / "source.c"
            source.write_text("reviewed fixture")
            hashes = tree_hashes(root)
            pin = Path(tmp) / "pin.json"
            pin.write_text(json.dumps({"format": 1, "upstreamCommit": COMMIT, "upstreamGitTree": TREE,
                "vendoredFileCount": 1, "vendoredTreeSha256": hashlib.sha256(
                    json.dumps(hashes, sort_keys=True, separators=(",", ":")).encode()).hexdigest()}))
            verify_vendor(root, pin)
            source.write_text("unreviewed edit")
            with self.assertRaisesRegex(ValueError, "committed reviewed hash"):
                verify_vendor(root, pin)
            source.unlink()
            with self.assertRaises(ValueError):
                verify_vendor(root, pin)
            source.write_text("reviewed fixture")
            (root / "extra").touch()
            with self.assertRaises(ValueError):
                verify_vendor(root, pin)
            (root / "extra").unlink()
            (root / "alias").symlink_to(source)
            with self.assertRaisesRegex(ValueError, "symlinks"):
                verify_vendor(root, pin)

    def test_recipe_requires_ordinary_and_compiled_output_receipts_with_config_equals(self):
        with tempfile.TemporaryDirectory() as tmp:
            build = Build.__new__(Build)
            build.directory = Path(tmp)
            build.bundle = Path(tmp) / "bundle"
            (build.bundle / "lib").mkdir(parents=True)
            build.native = Path(tmp) / "native"
            build.network = Path(tmp) / "network"
            build.run = Mock()
            with patch("build.clean_environment", return_value={}):
                build.smoke(False)
            calls = {call.args[0]: call for call in build.run.call_args_list}
            for label in ("relocated-native-smoke", "relocated-client-smoke", "relocated-output-smoke", "output-smoke-compile"):
                argv = [str(v) for v in calls[label].args[1]]
                self.assertTrue(any(v.startswith("--config=") for v in argv))
                self.assertNotIn("--config", argv)
            ordinary = calls["relocated-output-smoke"].kwargs["receipt"]
            compiled = calls["relocated-compiled-output-smoke"].kwargs["receipt"]
            self.assertEqual(ordinary, compiled)
            self.assertEqual(ordinary["pressureBytes"], 10 * 1024 * 1024)
            self.assertEqual(ordinary["highFixtureDescriptors"], 140)
            self.assertEqual(ordinary["descriptorEnumeration"], "/dev/fd")
            self.assertIs(ordinary["realVM"], False)

    def test_vendor_pin_authority_is_built_and_reviewed_git_objects(self):
        with tempfile.TemporaryDirectory(prefix="winter-package-git-") as tmp:
            root=Path(tmp);vendor=root/VENDOR_PATH;vendor.mkdir(parents=True)
            (vendor/"source.c").write_text("reviewed fixture")
            env={k:v for k,v in os.environ.items() if not k.startswith("GIT_")}
            env.update(GIT_CONFIG_NOSYSTEM="1",GIT_CONFIG_GLOBAL="/dev/null",GIT_TERMINAL_PROMPT="0")
            def git(*args):
                return subprocess.check_output(["git","-C",root,"-c","user.name=Fixture","-c","user.email=fixture@example.invalid",
                    "-c","core.hooksPath=/dev/null","-c","commit.gpgsign=false",*args],env=env)
            git("init","-q");git("add",".");git("commit","-qm","reviewed vendor")
            reviewed=git("rev-parse","HEAD").decode().strip()
            hashes=tree_hashes(vendor);pin=root/PIN_PATH;pin.parent.mkdir(parents=True)
            record={"format":1,"upstreamCommit":COMMIT,"upstreamGitTree":TREE,"reviewedVendorCommit":reviewed,
                "vendoredFileCount":1,"vendoredTreeSha256":hashlib.sha256(json.dumps(hashes,sort_keys=True,separators=(",",":")).encode()).hexdigest()}
            pin.write_text(json.dumps(record));git("add",".");git("commit","-qm","pin reviewed bytes")
            built=git("rev-parse","HEAD").decode().strip()
            verify_committed_vendor(root,built,vendor,pin)
            pin.write_text("{}")
            with self.assertRaisesRegex(ValueError,"dirty vendor/packaging"):
                verify_committed_vendor(root,built,vendor,pin)
            git("restore",PIN_PATH)
            # Even a committed self-consistent hash cannot lie about which
            # reviewed Git commit supplied those exact vendor bytes.
            (vendor/"source.c").write_text("changed source")
            hashes=tree_hashes(vendor);record["vendoredTreeSha256"]=hashlib.sha256(json.dumps(hashes,sort_keys=True,separators=(",",":")).encode()).hexdigest()
            pin.write_text(json.dumps(record));git("add",".");git("commit","-qm","incorrect claimed review")
            changed=git("rev-parse","HEAD").decode().strip()
            with self.assertRaisesRegex(ValueError,"reviewedVendorCommit contents"):
                verify_committed_vendor(root,changed,vendor,pin)

    def test_verification_checks_runpaths_in_every_architecture(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "native.dylib").touch()
            def tool(*args):
                if args[0] == "lipo":
                    return "arm64 x86_64"
                if args[3] == "-L":
                    return "native:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1, current version 1)\n"
                if args[2] == "x86_64":
                    return " cmd LC_RPATH\n cmdsize 48\n path /opt/homebrew/lib (offset 12)\n"
                return ""
            with patch("closure.output", side_effect=tool), self.assertRaisesRegex(ValueError, "unsafe rpath"):
                validate(root)

    def test_dependency_cache_refuses_unlisted_material_and_aliases(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = {"format": 1, "components": "dependencies-only", "sourcePins": PINS,
                        "aliases": {}, "materialAliases": {}, "materialHashes": {}}
            (root / "manifest.json").write_text(json.dumps(manifest))
            (root / "unlisted").touch()
            build = Build.__new__(Build)
            with self.assertRaisesRegex(ValueError, "inventory mismatch"):
                build.import_dependencies(root)
            (root / "unlisted").unlink()
            (root / "escape").symlink_to("/usr/lib")
            with self.assertRaisesRegex(ValueError, "alias mismatch"):
                build.import_dependencies(root)


if __name__ == "__main__":
    unittest.main()
