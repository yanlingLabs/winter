import tempfile
import unittest
import json
from pathlib import Path
from closure import dependencies, is_system, resolve_reference, runpaths, validate
from build import Build, PINS, clean_environment
from unittest.mock import patch


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
