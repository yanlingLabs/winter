"""standin/standin_prepare.py: the provider worker's metadata for one conversation, and every way it refuses. Reads and writes only temporary files."""
import copy, hashlib, io, json, os, shutil, stat, subprocess, sys, tempfile, unittest
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "standin"))
import standin_prepare as sp

PROFILE_BYTES = (ROOT / "standin/profile.json").read_bytes()
PROFILE = sp.load_profile(PROFILE_BYTES)
SID = "session_0123456789abcdef"
SCOPE = {"homeId": "home_1", "workspaceId": "ws_1", "sessionId": SID, "backendSessionId": "backend_1", "taskId": "task_1", "incarnationId": "inc_1", "bootId": "11111111-2222-4333-8444-555555555555",
         "leaseEpoch": 1, "grantRevision": 2, "accountRevision": 3, "modelRevision": 4}


def item(**changes):
    value = {"logicalSessionId": SID, "authority": {}, "runtimeUid": 4242, "toolUid": 4243, "workspaceGid": 4244, "policy": "ask", "roots": [],
             "hostQueryRuntime": {"storeDirectory": "/workspace/.winter/conversations/" + SID, "runhomeDirectory": "/run/winter/conversations/" + SID,
                                  "provider": {"scope": copy.deepcopy(SCOPE), "selection": copy.deepcopy(PROFILE["selection"])}, "model": "winter-standin/scripted", "timeoutMs": 1000, "toolClasses": []}}
    value.update(changes)
    return value


def refused(test, fn, code):
    with test.assertRaises(sp.Refused) as caught:
        fn()
    test.assertEqual(caught.exception.code, code)


class ProfileTests(unittest.TestCase):
    def test_the_shipped_profile_is_canonical_and_closed(self):
        self.assertEqual(PROFILE["profile"], "standin-v1")
        self.assertEqual(len(PROFILE["answers"]), 2)
        self.assertEqual(PROFILE["workerUid"], 65534)
        self.assertEqual(PROFILE["selection"]["providerId"], "winter-standin")
        self.assertEqual(PROFILE_BYTES, sp.canonical(PROFILE).encode() + b"\n")

    def mutate(self, edit):
        profile = copy.deepcopy(PROFILE)
        edit(profile)
        return sp.canonical(profile).encode() + b"\n"

    def test_every_departure_from_the_closed_profile_is_refused(self):
        cases = {
            "worker uid in the host range": lambda p: p.__setitem__("workerUid", 65533),
            "worker uid as text": lambda p: p.__setitem__("workerUid", "65534"),
            "one answer": lambda p: p.__setitem__("answers", p["answers"][:1]),
            "three answers": lambda p: p.__setitem__("answers", p["answers"] + ["x"]),
            "empty answer": lambda p: p["answers"].__setitem__(0, ""),
            "control character in an answer": lambda p: p["answers"].__setitem__(0, "a\nb"),
            "DEL in an answer": lambda p: p["answers"].__setitem__(0, "a\x7fb"),
            "unit separator in an answer": lambda p: p["answers"].__setitem__(0, "a\x1fb"),
            "worker uid as a float": lambda p: p.__setitem__("workerUid", 65534.0),
            "non-ASCII answer": lambda p: p["answers"].__setitem__(0, "café"),
            "over-long answer": lambda p: p["answers"].__setitem__(0, "x" * 4097),
            "another profile name": lambda p: p.__setitem__("profile", "standin-v2"),
            "a real provider": lambda p: p["selection"].__setitem__("providerId", "openai"),
            "a real model": lambda p: p["selection"].__setitem__("modelKey", "openai/gpt-5.6"),
            "extra key": lambda p: p.__setitem__("extra", 1),
            "missing selection key": lambda p: p["selection"].pop("family"),
        }
        for name, edit in cases.items():
            refused(self, lambda edit=edit: sp.load_profile(self.mutate(edit)), "profile")

    def test_non_canonical_bytes_and_duplicate_keys_are_refused(self):
        refused(self, lambda: sp.load_profile(PROFILE_BYTES.replace(b",", b", ", 1)), "profile")
        refused(self, lambda: sp.load_profile(PROFILE_BYTES.rstrip(b"\n")), "profile")
        refused(self, lambda: sp.load_profile(b'{"profile":"standin-v1","profile":"standin-v1"}'), "profile")
        refused(self, lambda: sp.load_profile(b"not json"), "profile")
        refused(self, lambda: sp.load_profile("{\"profile\":\"é\"}".encode()), "profile")


class ComposeTests(unittest.TestCase):
    def test_the_metadata_is_the_closed_shape_the_worker_parses(self):
        raw = sp.compose(PROFILE, [item()], SID)
        value = json.loads(raw)
        self.assertEqual(sorted(value), ["runtimeUid", "script", "scriptSha256", "version"])
        self.assertEqual(value["version"], 1)
        self.assertEqual(value["runtimeUid"], 4242)
        self.assertEqual(raw, sp.canonical(value).encode())
        script = value["script"]
        self.assertEqual(list(script), ["version", "scope", "selection", "steps"])
        self.assertEqual(script["scope"], SCOPE)
        self.assertEqual(list(script["scope"]), sp.SCOPE_KEYS)
        self.assertEqual(script["selection"], PROFILE["selection"])
        self.assertEqual(len(script["steps"]), 2)
        for step, answer in zip(script["steps"], PROFILE["answers"]):
            self.assertEqual(step, {"system": [], "user": [], "absentSystem": [], "absentUser": [], "response": answer})
        self.assertEqual(value["scriptSha256"], hashlib.sha256(sp.canonical(script).encode()).hexdigest())
        self.assertLessEqual(len(raw), sp.METADATA_MAX)

    def test_golden_vector(self):
        raw = sp.compose(PROFILE, [item()], SID)
        vector = json.loads((ROOT / "vectors/standin-metadata.json").read_text())
        self.assertEqual(vector["metadataSha256"], hashlib.sha256(raw).hexdigest())
        self.assertEqual(vector["metadata"], raw.decode())

    def test_other_conversations_in_the_items_do_not_leak_into_the_script(self):
        other = item(logicalSessionId="session_other", runtimeUid=5000)
        other["hostQueryRuntime"]["provider"]["scope"]["sessionId"] = "session_other"
        raw = sp.compose(PROFILE, [other, item()], SID)
        self.assertEqual(json.loads(raw)["runtimeUid"], 4242)
        self.assertNotIn(b"session_other", raw)

    def test_a_selection_that_is_not_the_reserved_one_is_refused(self):
        for edit in (lambda c: c["provider"]["selection"].__setitem__("providerId", "openai"),
                     lambda c: c["provider"]["selection"].__setitem__("modelKey", "openai/gpt-5.6"),
                     lambda c: c["provider"]["selection"].pop("continuationDomain"),
                     lambda c: c.__setitem__("model", "openai/gpt-5.6"),
                     lambda c: c["provider"]["selection"].__setitem__("capabilities", {})):
            changed = item()
            edit(changed["hostQueryRuntime"])
            refused(self, lambda changed=changed: sp.compose(PROFILE, [changed], SID), "selection")

    def test_uid_item_and_kind_refusals(self):
        for uid in (999, 65534, 65535, 0, "4242", True, None):
            refused(self, lambda uid=uid: sp.compose(PROFILE, [item(runtimeUid=uid)], SID), "uid")
        refused(self, lambda: sp.compose(PROFILE, [], SID), "item")
        refused(self, lambda: sp.compose(PROFILE, [item(), item()], SID), "item")
        refused(self, lambda: sp.compose(PROFILE, {"a": 1}, SID), "items")
        refused(self, lambda: sp.compose(PROFILE, [item(hostQueryRuntime=None)], SID), "profile_kind")
        guided = item()
        guided["hostQueryGuidedRuntime"] = guided.pop("hostQueryRuntime")
        refused(self, lambda: sp.compose(PROFILE, [guided], SID), "profile_kind")
        both = item(hostQueryGuidedRuntime={})
        refused(self, lambda: sp.compose(PROFILE, [both], SID), "profile_kind")

    def test_provider_and_scope_refusals(self):
        def with_config(edit, code):
            changed = item()
            edit(changed["hostQueryRuntime"])
            refused(self, lambda: sp.compose(PROFILE, [changed], SID), code)
        with_config(lambda c: c.__setitem__("provider", {"scope": {}}), "provider")
        with_config(lambda c: c["provider"].__setitem__("url", "https://example.invalid"), "provider")
        with_config(lambda c: c["provider"]["scope"].pop("bootId"), "scope")
        with_config(lambda c: c["provider"]["scope"].__setitem__("extra", 1), "scope")
        with_config(lambda c: c["provider"]["scope"].__setitem__("leaseEpoch", 0), "scope")
        with_config(lambda c: c["provider"]["scope"].__setitem__("leaseEpoch", True), "scope")
        with_config(lambda c: c["provider"]["scope"].__setitem__("leaseEpoch", 2**53), "scope")
        with_config(lambda c: c["provider"]["scope"].__setitem__("leaseEpoch", "1"), "scope")
        with_config(lambda c: c["provider"]["scope"].__setitem__("homeId", ""), "scope")
        with_config(lambda c: c["provider"]["scope"].__setitem__("homeId", "x" * 257), "scope")
        with_config(lambda c: c["provider"]["scope"].__setitem__("homeId", "a\nb"), "scope")
        with_config(lambda c: c["provider"]["scope"].__setitem__("homeId", "a\x7fb"), "scope")
        with_config(lambda c: c["provider"]["scope"].__setitem__("homeId", "a\x1fb"), "scope")
        with_config(lambda c: c["provider"]["scope"].__setitem__("homeId", "café"), "scope")
        with_config(lambda c: c["provider"]["scope"].__setitem__("homeId", 7), "scope")

    def test_the_largest_possible_metadata_is_far_below_the_workers_limit(self):
        biggest = item()
        for key in sp.SCOPE_KEYS:
            if key.endswith("Id"):
                biggest["hostQueryRuntime"]["provider"]["scope"][key] = '"' * sp.ID_MAX
            else:
                biggest["hostQueryRuntime"]["provider"]["scope"][key] = sp.SAFE_INT
        profile = copy.deepcopy(PROFILE)
        profile["answers"] = ['"' * sp.TEXT_MAX, '"' * sp.TEXT_MAX]
        biggest["logicalSessionId"] = SID
        raw = sp.compose(profile, [biggest], SID)
        self.assertLess(len(raw), sp.METADATA_MAX // 2)

    def test_scope_ids_with_quotes_and_backslashes_survive_a_javascript_round_trip(self):
        changed = item()
        changed["hostQueryRuntime"]["provider"]["scope"]["taskId"] = 'a"b\\c/d'
        raw = sp.compose(PROFILE, [changed], SID)
        self.assertEqual(json.loads(raw)["script"]["scope"]["taskId"], 'a"b\\c/d')

    @unittest.skipUnless(shutil.which("bun"), "bun is not installed")
    def test_the_bytes_survive_javascript_parse_and_stringify_unchanged(self):
        """The worker refuses metadata that JSON.stringify(JSON.parse(raw)) does not reproduce, and re-derives the script bytes with JSON.stringify(script)."""
        changed = item()
        changed["hostQueryRuntime"]["provider"]["scope"]["taskId"] = 'a"b\\c/d~'
        raw = sp.compose(PROFILE, [changed], SID)
        program = ("const raw=require('fs').readFileSync(0,'utf8');const v=JSON.parse(raw);"
                   "if(JSON.stringify(v)!==raw)process.exit(3);"
                   "const sha=require('crypto').createHash('sha256').update(JSON.stringify(v.script)).digest('hex');"
                   "if(sha!==v.scriptSha256)process.exit(4);if(Object.keys(v).sort().join()!=='runtimeUid,script,scriptSha256,version')process.exit(5);")
        result = subprocess.run(["bun", "-e", program], input=raw, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)


class WriteTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.dir = Path(self.folder.name)

    def tearDown(self):
        self.folder.cleanup()

    def test_the_file_is_created_exclusively_read_only_and_never_overwritten(self):
        out = self.dir / "a" / "sid"
        sp.write_metadata(out, b"{}")
        path = out / "metadata.json"
        self.assertEqual(path.read_bytes(), b"{}")
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o444)
        self.assertEqual(stat.S_IMODE(out.stat().st_mode), 0o755)
        with self.assertRaises(FileExistsError):
            sp.write_metadata(out, b"{}")

    def test_a_symlink_at_the_target_is_not_followed(self):
        out = self.dir / "sid"
        out.mkdir()
        victim = self.dir / "victim"
        victim.write_bytes(b"keep")
        (out / "metadata.json").symlink_to(victim)
        with self.assertRaises(OSError):
            sp.write_metadata(out, b"{}")
        self.assertEqual(victim.read_bytes(), b"keep")


class MainTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.dir = Path(self.folder.name)
        (self.dir / "profile.json").write_bytes(PROFILE_BYTES)

    def tearDown(self):
        self.folder.cleanup()

    def run_main(self, items, sid=SID, profile=None):
        (self.dir / "items.json").write_bytes(items if isinstance(items, bytes) else json.dumps(items).encode())
        if profile is not None:
            (self.dir / "profile.json").write_bytes(profile)
        out = io.StringIO()
        with redirect_stdout(out):
            code = sp.main(["--profile", str(self.dir / "profile.json"), "--items", str(self.dir / "items.json"), "--sid", sid, "--out", str(self.dir / "out")])
        return code, out.getvalue()

    def test_success_writes_the_file_and_prints_nothing(self):
        code, text = self.run_main([item()])
        self.assertEqual((code, text), (0, ""))
        self.assertEqual((self.dir / "out/metadata.json").read_bytes(), sp.compose(PROFILE, [item()], SID))

    def test_refusals_print_one_fixed_code_and_never_echo_input_and_write_nothing(self):
        secret = "SECRET-VALUE-123"
        changed = item()
        changed["hostQueryRuntime"]["provider"]["selection"]["providerId"] = secret
        code, text = self.run_main([changed])
        self.assertEqual((code, text), (2, "standin-refused selection\n"))
        self.assertFalse((self.dir / "out").exists())
        self.assertEqual(self.run_main(b"not json")[1], "standin-refused items\n")
        self.assertEqual(self.run_main([item()], sid="other")[1], "standin-refused item\n")
        self.assertEqual(self.run_main([item()], profile=b"{}")[1], "standin-refused profile\n")

    def test_an_input_that_is_a_symlink_a_fifo_or_a_device_is_refused_and_never_waited_on(self):
        (self.dir / "items.json").write_text("[]")
        (self.dir / "link.json").symlink_to(self.dir / "items.json")
        os.mkfifo(self.dir / "fifo.json")
        script = str(ROOT / "standin/standin_prepare.py")
        for path, code in ((self.dir / "link.json", "io"), (self.dir / "fifo.json", "input"), (Path("/dev/null"), "input")):
            # a real subprocess with a deadline: an open that waits on the FIFO must fail this test in seconds, not hang it
            result = subprocess.run([sys.executable, "-I", "-S", "-B", script, "--profile", str(self.dir / "profile.json"), "--items", str(path), "--sid", SID, "--out", str(self.dir / "out")],
                                    capture_output=True, text=True, timeout=15)
            self.assertEqual((result.returncode, result.stdout), (2, f"standin-refused {code}\n"), path)

    def test_a_missing_input_is_an_io_refusal(self):
        out = io.StringIO()
        with redirect_stdout(out):
            code = sp.main(["--profile", str(self.dir / "nope"), "--items", str(self.dir / "items.json"), "--sid", SID, "--out", str(self.dir / "out")])
        self.assertEqual((code, out.getvalue()), (2, "standin-refused io\n"))

    def test_an_oversized_input_is_refused(self):
        code, text = self.run_main(b"[" + b" " * (sp.INPUT_MAX + 10) + b"]")
        self.assertEqual((code, text), (2, "standin-refused input\n"))


if __name__ == "__main__":
    unittest.main()
