"""Native (host compiler) tests of the portable guest C modules. Run as:
    python3 -I -S -B -m unittest discover -s apple/Cowork/WinterCoworkGuest/tests -p 'test_*.py'

Compiles tests/native_tool.c (wmx.c + ctl.c) with the machine's C compiler, with the address and undefined-behaviour
sanitizers when the compiler has them, and feeds it the pinned S1 golden vectors. Nothing here needs root, Linux or a VM.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
VECTORS = json.loads((ROOT / "vectors/mux-frames.json").read_text())
PINS = json.loads((ROOT / "vectors/PINS.json").read_text())
CC = os.environ.get("CC") or shutil.which("cc") or shutil.which("clang") or shutil.which("gcc")
SANITIZE = os.environ.get("WG_SANITIZE", "1") == "1"

# A bootstrap-class payload is judged by the Python bootstrap helper; in C it is a well-formed frame (the relay forwards bootstrap
# payloads byte for byte), unless the header itself is at fault. test_guest_bootstrap.py holds every one of them to its contract
# category. The class byte of the frame says which ones these are; control and runtime payloads are judged in C.
def is_bootstrap(vector):
    raw = bytes.fromhex(vector["hex"])
    return len(raw) > 5 and raw[:4] == b"WMX1" and raw[5] == 1


def build(sources, output, extra=()):
    flags = ["-std=c11", "-O1", "-g", "-Wall", "-Wextra", "-Werror", "-pedantic", "-DWG_TEST_SEAMS", *extra]
    if SANITIZE:
        flags += ["-fsanitize=address,undefined", "-fno-sanitize-recover=all"]
    command = [CC, *flags, *map(str, sources), "-o", str(output)]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0 and SANITIZE and "sanitize" in result.stderr:
        command = [CC, *[f for f in flags if "sanitize" not in f], *map(str, sources), "-o", str(output)]
        result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise AssertionError(result.stderr)
    return output


@unittest.skipUnless(CC, "no C compiler")
class NativeCodecTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.folder = tempfile.mkdtemp(prefix="guest-native-")
        # The contract vectors are revision 3 and the file streams exist only for an image that declares file-channel-v1, so they are judged by the gated build;
        # the production build (no WG_FILE_CHANNEL_V1) is a revision-2 guest for stream 4 and above, and a test below holds it to that.
        cls.tool = build([HERE / "native_tool.c", ROOT / "common/wmx.c", ROOT / "common/ctl.c", ROOT / "common/fileflow.c"], Path(cls.folder) / "native_tool", extra=["-DWG_FILE_CHANNEL_V1"])
        cls.production_tool = build([HERE / "native_tool.c", ROOT / "common/wmx.c", ROOT / "common/ctl.c"], Path(cls.folder) / "native_tool_production")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.folder, ignore_errors=True)

    def run_tool(self, *args, stdin=None):
        result = subprocess.run([str(self.tool), *args], input=stdin, capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.splitlines()

    def vector_results(self, tool=None):
        lines = [f'{section[:3]}:{v["name"]} {v["direction"]} {v["hex"]}' for section in ("positive", "negative") for v in VECTORS[section]]
        out = {}
        result = subprocess.run([str(tool or self.tool), "vectors"], input="\n".join(lines) + "\n", capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        for line in result.stdout.splitlines():
            name, *fields = line.split("|")
            out[name] = fields
        return out

    def test_the_vector_copy_is_the_pinned_one(self):
        self.assertEqual(hashlib.sha256((ROOT / "vectors/mux-frames.json").read_bytes()).hexdigest(), PINS["files"]["mux-frames.json"]["sha256"])

    def test_every_positive_vector_parses_with_its_header_fields(self):
        results = self.vector_results()
        for v in VECTORS["positive"]:
            with self.subTest(v["name"]):
                fields = results["pos:" + v["name"]]
                self.assertEqual(fields[0], "ok")
                self.assertEqual((int(fields[1]), int(fields[2])), ({"control": 0, "bootstrap": 1, "runtime": 2}[v["class"]], v["seq"]))
                self.assertEqual(int(fields[3]), len(bytes.fromhex(v["hex"])) - 16)

    def test_the_file_streams_exist_only_in_the_gated_build(self):
        """Without WG_FILE_CHANNEL_V1 the guest is a revision-2 guest: stream 4 and above are bad_field in either direction, so a host that offered them would end the stream."""
        gated, production = self.vector_results(), self.vector_results(self.production_tool)
        file_names = [v["name"] for v in VECTORS["positive"] if "file" in v["name"]]
        self.assertEqual(len(file_names), 4)
        for name in file_names:
            self.assertEqual(gated["pos:" + name][0], "ok", name)
            self.assertEqual(production["pos:" + name][0], "bad_field", name)
        for name in ("runtime-stream-four", "runtime-file-in-travelling-up", "runtime-file-out-travelling-down"):
            self.assertEqual(gated["neg:" + name], ["bad_direction"], name)
            self.assertEqual(production["neg:" + name], ["bad_field"], name)
        for name in ("runtime-file-in-on-conversation-one", "runtime-file-out-on-conversation-one", "runtime-file-out-empty-without-end", "runtime-stream-six", "runtime-stream-zero"):
            self.assertEqual(gated["neg:" + name], ["bad_field"], name)

    def test_the_file_flow_rule_matches_every_contract_case(self):
        """runtime-flow.json fileCases: the file bound is its own (4 requests, 16 KiB request lines, 384 KiB response lines); steps on the runtime streams
        (in, out, err) belong to the runtime IN count, which the relay's 4 MiB queue absorbs (test_relay.py), so they are not part of this rule."""
        flow = json.loads((ROOT / "vectors/runtime-flow.json").read_text())
        self.assertEqual((flow["fileInFlightRequests"], flow["fileRequestBytes"], flow["fileResponseBytes"]), (4, 16384, 393216))
        for case in flow["fileCases"]:
            with self.subTest(case["name"]):
                steps = [s for s in case["steps"] if s["stream"].startswith("file_")]
                out = self.run_tool("fileflow", stdin="".join(f'{s["stream"]} {s["bytes"]} {s["newlines"]}\n' for s in steps))
                refused = [i for i, line in enumerate(out) if line != "ok"]
                file_refusal = case["refusedAt"] is not None and case["steps"][case["refusedAt"]]["stream"].startswith("file_")
                if file_refusal:
                    index = [i for i, s in enumerate(case["steps"]) if s["stream"].startswith("file_")].index(case["refusedAt"])
                    self.assertEqual(refused, [index])
                    self.assertEqual(out[index], case["error"])
                else:
                    self.assertEqual(refused, [])

    def test_each_response_line_is_counted_on_its_own(self):
        steps = "file_in 1 1\nfile_in 1 1\nfile_out 250000 1\nfile_out 250000 1\n"      # two lines of 250,000 bytes: 500,000 in all, each under 384 KiB
        self.assertEqual(self.run_tool("fileflow", stdin=steps), ["ok"] * 4)
        steps = "file_in 1 1\nfile_in 1 1\nfile_out 250000 0\nfile_out 250000 1\n"      # one line of 500,000 bytes
        self.assertEqual(self.run_tool("fileflow", stdin=steps), ["ok", "ok", "ok", "oversize"])
        steps = "file_in 10000 0\nfile_in 6384 1\nfile_in 16384 1\n"                  # the request line restarts after each newline
        self.assertEqual(self.run_tool("fileflow", stdin=steps), ["ok", "ok", "ok"])
        steps = "file_in 16384 1\nfile_in 16384 1\nfile_in 16384 1\n"
        self.assertEqual(self.run_tool("fileflow", stdin=steps), ["ok", "ok", "ok"])

    def test_the_guests_own_control_messages_reencode_to_the_vector_bytes(self):
        results = self.vector_results()
        for name in ("control-up-drain-ack", "control-up-halting", "control-up-pong", "control-up-fault-during-drain", "control-up-fault-outside-drain"):
            self.assertEqual(results["pos:" + name][-1], "reencode-same", name)

    def test_control_fields_are_decoded(self):
        results = self.vector_results()
        self.assertEqual(results["pos:control-down-drain-host-stop"][4:], ["drain", "0f" * 16, "30000", "0", "0"])
        self.assertEqual(results["pos:control-down-drain-owner-loss"][4:], ["drain", "a5" * 16, "30000", "1", "0"])
        self.assertEqual(results["pos:control-down-ping"][4:], ["ping", "", "0", "0", "7"])
        self.assertEqual(results["pos:control-up-fault-during-drain"][4:8], ["fault", "0f" * 16, "0", "0"])
        self.assertEqual(results["pos:control-up-fault-during-drain"][9:11], ["unmount_failed", "1"])
        self.assertEqual(results["pos:control-up-fault-outside-drain"][9:11], ["supervisor_lost", "0"])

    def test_runtime_prefixes_are_decoded_and_rebuilt(self):
        results = self.vector_results()
        expected = {"runtime-down-bytes": (0, 1, 0), "runtime-up-bytes": (0, 2, 0), "runtime-up-empty-end": (0, 2, 1), "runtime-up-err-bytes": (0, 3, 0),
                    "runtime-down-in-end": (2, 1, 1), "runtime-up-last-conversation": (15, 2, 1)}
        for name, (conversation, stream, end) in expected.items():
            with self.subTest(name):
                self.assertEqual(results["pos:" + name][4:], ["runtime", str(conversation), str(stream), str(end), "prefix-same"])

    def test_the_guests_fault_frames_are_built_to_the_vector_bytes(self):
        by_name = {v["name"]: v["hex"] for v in VECTORS["positive"]}
        for name, code, seq, nonce in (("control-up-fault-during-drain", 1, None, "0f" * 16), ("control-up-fault-outside-drain", 2, None, "")):
            raw = bytes.fromhex(by_name[name])
            seq = int.from_bytes(raw[8:12], "little")
            self.assertEqual(self.run_tool("encode", "fault", str(code), str(seq), nonce)[0], by_name[name])
        for refused in (("0", "1", ""), ("5", "1", ""), ("1", "1", "ZZ" * 16), ("1", "0", "")):
            self.assertEqual(self.run_tool("encode", "fault", *refused), ["refused"], refused)

    def fault_hex(self, code, seq, nonce):
        return self.run_tool("encode", "fault", str(code), str(seq), nonce)[0]

    def test_every_negative_vector_is_refused_with_the_contract_category(self):
        results = self.vector_results()
        for v in VECTORS["negative"]:
            with self.subTest(v["name"]):
                fields = results["neg:" + v["name"]]
                if fields[0] == "ok":
                    self.assertTrue(is_bootstrap(v), "only a bootstrap payload may be judged by the helper instead of C")
                else:
                    self.assertEqual(fields, [v["error"]])

    def frames(self, direction):
        # One link's stream: the sequence number of a class rises by one frame at a time, so the vectors that restate a number already used
        # (the alternative faults of the same slot) are left out here; each is parsed on its own by the vector tests.
        order, seen = [], {}
        for v in VECTORS["positive"]:
            if v["direction"] == direction and v["seq"] == seen.get(v["class"], 0) + 1:
                order.append(v)
                seen[v["class"]] = v["seq"]
        return order, "".join(v["hex"] for v in order)

    def test_the_stream_assembler_yields_the_same_frames_at_every_chunk_size(self):
        for direction in ("down", "up"):
            vectors, stream = self.frames(direction)
            expected = None
            for chunk in (0, 1, 2, 7, 16, 17, 100, 4096):
                with self.subTest(direction=direction, chunk=chunk):
                    lines = self.run_tool("stream", str(chunk), direction, stream)
                    frames = [line for line in lines if line.startswith("F ")]
                    self.assertEqual(lines[-1], "END")
                    self.assertEqual(len(frames), len(vectors))
                    for line, v in zip(frames, vectors):
                        parts = line.split()
                        self.assertEqual((int(parts[1]), int(parts[2]), int(parts[3]), parts[4]), ({"control": 0, "bootstrap": 1, "runtime": 2}[v["class"]], v["seq"], len(bytes.fromhex(v["hex"])) - 16, "ok"))
                    if expected is None:
                        expected = frames
                    self.assertEqual(frames, expected)

    def test_the_assembler_stops_at_the_first_bad_header(self):
        good = VECTORS["positive"][2]["hex"]
        bad = NEGATIVE_HEX("bad-magic")
        lines = self.run_tool("stream", "5", "down", good + bad + good)
        self.assertEqual([l.split()[0] for l in lines], ["F", "E"])
        self.assertEqual(lines[1], "E malformed")

    def test_provider_class_is_refused_in_a_stream_in_both_directions(self):
        for direction in ("down", "up"):
            lines = self.run_tool("stream", "0", direction, NEGATIVE_HEX("provider-class-with-payload"))
            self.assertEqual(lines, ["E reserved_class"])

    def test_a_sequence_gap_is_reported_per_class_and_direction(self):
        ping = VECTORS["positive"][2]["hex"]  # control down seq 3
        lines = self.run_tool("stream", "0", "down", ping)
        self.assertIn("bad_sequence", lines[0])

    def test_oversize_headers_are_refused_before_any_payload_is_read(self):
        lines = self.run_tool("stream", "0", "down", NEGATIVE_HEX("runtime-over-limit-header-only"))
        self.assertEqual(lines, ["E oversize"])

    def test_encoding_refuses_a_bad_nonce(self):
        self.assertEqual(self.run_tool("encode", "drain_ack", "ZZ" * 16, "1"), ["refused"])
        self.assertEqual(self.run_tool("encode", "drain_ack", "ab" * 15, "1"), ["refused"])
        self.assertEqual(self.run_tool("encode", "drain_ack", "ab" * 16, "0"), ["refused"])  # seq 0 is never sent
        self.assertEqual(self.run_tool("encode", "drain", "ab" * 16, "1"), ["refused"])      # the guest never writes host messages
        self.assertEqual(self.run_tool("encode", "drain_ack", "0f" * 16, "1"), [next(v["hex"] for v in VECTORS["positive"] if v["name"] == "control-up-drain-ack")])
        self.assertEqual(self.run_tool("encode", "pong", "7", "3"), [next(v["hex"] for v in VECTORS["positive"] if v["name"] == "control-up-pong")])

    def control(self, direction, text):
        return self.run_tool("control", direction, text)[0].split("|")[0]

    def test_frames_are_only_built_for_the_classes_and_numbers_the_guest_may_send(self):
        self.assertTrue(self.run_tool("frame", "0", "1", "7b7d")[0].startswith("574d5831010000000100000002000000"))
        self.assertTrue(self.run_tool("frame", "2", "9", "")[0].startswith("574d583101020000" + "09000000" + "00000000"))
        for cls, seq, payload in ((3, 1, ""), (3, 1, "7b7d"), (4, 1, ""), (255, 1, ""), (0, 0, ""), (0, 1, "00" * 4097), (1, 1, "00" * 262145)):
            with self.subTest(cls=cls, seq=seq, size=len(payload) // 2):
                self.assertEqual(self.run_tool("frame", str(cls), str(seq), "@-", stdin=payload), ["refused"])
        self.assertNotEqual(self.run_tool("frame", "1", "1", "@-", stdin="00" * 262144), ["refused"])

    def test_control_text_corner_cases(self):
        n = '{"v":1,"t":"ping","n":%s}'
        drain = '{"v":1,"t":"drain","stopNonce":"%s","budgetMs":%s,"origin":"%s"}'
        good_nonce = "0123456789abcdef" * 2
        cases = [
            (n % "7", "ok"), (n % "0", "ok"), (n % "4294967295", "ok"),
            (n % "4294967296", "bad_field"), (n % "99999999999999999999", "bad_field"), (n % "-1", "bad_field"),
            (n % "07", "malformed"), (n % "7.0", "malformed"), (n % "7e0", "malformed"), (n % "+7", "malformed"), (n % "", "malformed"), (n % '"7"', "malformed"),
            (n % "7" + "x", "malformed"), (n % "7" + "\n", "malformed"), (n % "7" + " ", "malformed"), (" " + n % "7", "malformed"),
            (drain % (good_nonce, "30000", "host-stop"), "ok"), (drain % (good_nonce, "120000", "owner-loss"), "ok"), (drain % (good_nonce, "0", "host-stop"), "ok"),
            (drain % (good_nonce, "120001", "host-stop"), "bad_field"), (drain % (good_nonce, "30000", "other"), "bad_field"),
            (drain % (good_nonce.upper(), "30000", "host-stop"), "bad_field"), (drain % (good_nonce[:-1], "30000", "host-stop"), "bad_field"),
            (drain % (good_nonce + "0", "30000", "host-stop"), "bad_field"), (drain % ("g" * 32, "30000", "host-stop"), "bad_field"),
            ('{"v":1,"t":"drain","stopNonce":"%s","budgetMs":30000}' % good_nonce, "bad_field"),
            ('{"v":2,"t":"ping","n":1}', "malformed"), ('{"v":1,"t":"ping"}', "bad_field"), ('{"v":1,"t":"ping","n":1,"n":1}', "malformed"),
            ('{"v":1,"t":"ping","n":1,"v":1}', "malformed"),
            ('{"v":1,"t":"drain","budgetMs":1,"stopNonce":"%s","origin":"host-stop"}' % good_nonce, "malformed"),
            ('{"v":1,"t":"drain","stopNonce":"%s","origin":"host-stop","budgetMs":1}' % good_nonce, "malformed"),
            ('{"v":1,"t":"drain","stopNonce":"%s","other":1,"origin":"host-stop"}' % good_nonce, "bad_field"), ('{"v":1,"t":"ping","extra":1,"n":1}', "bad_field"), ('{"v":1,"t":"ping","n":1,"x":1}', "bad_field"),
            ('{"v":1,"t":"ping","n":1}\x01', "malformed"), ('{"v":1,"t":"p\xc3\xafng","n":1}', "malformed"), ('{"v":1,"t":"ping","n":1}\t', "malformed"),
        ]
        for text, expected in cases:
            with self.subTest(text=text):
                self.assertEqual(self.control("down", text), expected)
        up_nonce = '{"v":1,"t":"drain_ack","stopNonce":"%s"}' % good_nonce
        self.assertEqual(self.control("up", up_nonce), "ok")
        self.assertEqual(self.control("down", up_nonce), "unknown_type")
        self.assertEqual(self.control("up", n % "7"), "unknown_type")
        self.assertEqual(self.control("up", '{"v":1,"t":"pong","n":7}'), "ok")
        for code in ("unmount_failed", "supervisor_lost", "protocol_violation", "internal"):
            self.assertEqual(self.control("up", '{"v":1,"t":"fault","code":"%s","stopNonce":null}' % code), "ok", code)
            self.assertEqual(self.control("up", '{"v":1,"t":"fault","code":"%s","stopNonce":"%s"}' % (code, good_nonce)), "ok", code)
        for text, expected in (('{"v":1,"t":"fault","code":"melted","stopNonce":null}', "bad_field"), ('{"v":1,"t":"fault","code":"","stopNonce":null}', "bad_field"),
                               ('{"v":1,"t":"fault","code":"internal","stopNonce":"%s"}' % good_nonce.upper(), "bad_field"), ('{"v":1,"t":"fault","code":"internal","stopNonce":"abc"}', "bad_field"),
                               ('{"v":1,"t":"fault","code":"internal","stopNonce":0}', "malformed"), ('{"v":1,"t":"fault","code":"internal"}', "bad_field"),
                               ('{"v":1,"t":"drain_ack","stopNonce":null}', "malformed"), ('{"v":1,"t":"halting","stopNonce":null}', "malformed"),
                               ('{"v":1,"t":"fault","stopNonce":null,"code":"internal"}', "malformed")):
            with self.subTest(text=text):
                self.assertEqual(self.control("up", text), expected)
        self.assertEqual(self.control("down", '{"v":1,"t":"fault","code":"internal","stopNonce":null}'), "unknown_type")
        self.assertEqual(self.control("up", '{"v":1,"t":"halting","stopNonce":"%s"}' % good_nonce.upper()), "bad_field")

    # ---- ctl (private pipe framing)

    def test_ctl_golden_encoding(self):
        self.assertEqual(self.run_tool("ctl", "encode", "U", "6869"), ["5500000002000000" + "6869"])
        self.assertEqual(self.run_tool("ctl", "encode", "G", ""), ["4700000000000000"])

    def test_ctl_matches_the_python_framing(self):
        sys.path.insert(0, str(ROOT / "bootstrap"))
        try:
            import guest_bootstrap as gb
        finally:
            sys.path.pop(0)
        for tag, payload in ((ord("B"), b"hello"), (ord("E"), b""), (ord("M"), b"x" * 72)):
            self.assertEqual(self.run_tool("ctl", "encode", chr(tag), payload.hex())[0], gb.ctl_encode(tag, payload).hex())

    def test_ctl_reader_at_every_chunk_size(self):
        wire = "5000000003000000616263" + "4600000001000000" + "07" + "6600000000000000"
        for chunk in (0, 1, 3, 8, 11):
            with self.subTest(chunk=chunk):
                lines = self.run_tool("ctl", "feed", str(chunk), "PFf", wire)
                self.assertEqual(lines, ["M P 3 616263", "M F 1 07", "M f 0 ", "END"])

    def test_ctl_reader_refuses_what_it_did_not_list_and_what_is_not_zero(self):
        self.assertEqual(self.run_tool("ctl", "feed", "0", "P", "4600000000000000"), ["BAD"])             # tag not allowed
        self.assertEqual(self.run_tool("ctl", "feed", "0", "P", "5001000000000000"), ["BAD"])             # reserved byte
        self.assertEqual(self.run_tool("ctl", "feed", "0", "P", "50000000ffff0100"), ["BAD"])             # length above the ceiling
        self.assertEqual(self.run_tool("ctl", "feed", "0", "P", "0000000000000000"), ["BAD"])             # tag 0
        self.assertEqual(self.run_tool("ctl", "feed", "0", "P", "50000000" + "01000100"), ["BAD"])        # 65537 bytes: one above the ceiling
        self.assertEqual(self.run_tool("ctl", "feed", "0", "P", "50000000" + "00000100"), ["END"])        # 65536 bytes announced, none sent: no message yet
        self.assertEqual(self.run_tool("ctl", "feed", "1", "P", "5000000001000000"), ["END"])             # truncated payload: no message

    def test_ctl_encode_refuses_oversize(self):
        self.assertEqual(self.run_tool("ctl", "encode", "U", "@-", stdin="00" * 65537), ["refused"])


def NEGATIVE_HEX(name):
    return next(v["hex"] for v in VECTORS["negative"] if v["name"] == name)


if __name__ == "__main__":
    unittest.main()
