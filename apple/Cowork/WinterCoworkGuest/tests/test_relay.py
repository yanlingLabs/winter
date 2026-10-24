"""Behavioural tests of the relay process, natively (macOS or Linux), no root and no VM.

The relay is built with the host compiler (sanitizers when available) and started with socketpair/pipes in place of the virtio
port and the in-guest pipes. The test plays the host on the port and PID 1 / the supervisor on the pipes. A socket stands in
for the port only in this test build (-DWG_TEST_PORT_SOCKET); the production build refuses anything but a character device,
and one test builds it that way to prove it.
"""
import json
import os
import select
import shutil
import socket
import struct
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

from test_native import CC, ROOT, SANITIZE, build

HERE = Path(__file__).resolve().parent
NONCE = "0f" * 16
OTHER_NONCE = "a5" * 16
EXIT_PORT_KIND, EXIT_STRAY_FD, EXIT_ARGUMENTS = 70, 71, 64
EXIT_WMX = 80
STATUS = {"malformed": 1, "oversize": 2, "version": 3, "unknown_type": 4, "bad_field": 5, "reserved_class": 6, "bad_sequence": 7, "bad_direction": 8}


def frame(cls, seq, payload=b"", flags=0):
    return b"WMX1" + bytes([1, cls]) + struct.pack("<HII", flags, seq, len(payload)) + payload


def control(seq, text):
    return frame(0, seq, text.encode())


def rt(stream, data=b"", conversation=0, end=False, flags=None):
    """A runtime payload: the 4 byte prefix and then the stream's bytes."""
    return bytes([conversation, stream, (1 if end else 0) if flags is None else flags, 0]) + data


IN, OUT, ERR = 1, 2, 3


def ctl(tag, payload=b""):
    return struct.pack("<B3xI", ord(tag), len(payload)) + payload


def shutdown_rd_fails_peer_writes():
    """Linux: after one end shuts down reading, the other end's writes fail with EPIPE. macOS buffers them instead."""
    a, b = socket.socketpair()
    try:
        b.shutdown(socket.SHUT_RD)
        a.sendall(b"x")
        return False
    except OSError:
        return True
    finally:
        a.close()
        b.close()


class Harness:
    """One running relay with its six descriptors."""

    def __init__(self, binary, extra_fds=(), arguments=None, file_channel=False, file_in_instead=None, file_out_instead=None):
        self.host, relay_port = socket.socketpair()
        init_to_relay_r, self.init_w = os.pipe()          # init -> relay
        self.init_r, relay_to_init_w = os.pipe()          # relay -> init
        self.sup_r, relay_rt_in_w = os.pipe()             # relay -> supervisor input
        relay_rt_out_r, self.sup_out_w = os.pipe()        # supervisor stdout -> relay
        relay_rt_err_r, self.sup_err_w = os.pipe()        # supervisor stderr -> relay
        fds = [relay_port.fileno(), init_to_relay_r, relay_to_init_w, relay_rt_in_w, relay_rt_out_r, relay_rt_err_r]
        names = ["--port", "--ctl-in", "--ctl-out", "--rt-in", "--rt-out", "--rt-err"]
        self.file_r = self.file_w = None
        relay_file = []
        if file_channel:                                   # the gated relay's two more pipes: FILE_IN to the file service, FILE_OUT back
            self.file_r, relay_file_in_w = os.pipe()        # relay -> file service (FILE_IN)
            relay_file_out_r, self.file_w = os.pipe()       # file service -> relay (FILE_OUT)
            if file_in_instead is not None:                 # a test hands the relay something that is not a pipe in the FILE_IN slot
                os.close(relay_file_in_w)
                relay_file_in_w = file_in_instead
            if file_out_instead is not None:
                os.close(relay_file_out_r)
                relay_file_out_r = file_out_instead
            relay_file = [relay_file_in_w, relay_file_out_r]
            fds += relay_file
            names += ["--file-in", "--file-out"]
        argv = arguments if arguments is not None else [x for pair in zip(names, map(str, fds)) for x in pair]
        self.proc = subprocess.Popen([str(binary), *argv], pass_fds=[*fds, *extra_fds], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        relay_port.close()
        for fd in (init_to_relay_r, relay_to_init_w, relay_rt_in_w, relay_rt_out_r, relay_rt_err_r, *[f for f in relay_file if f not in (file_in_instead, file_out_instead)]):
            os.close(fd)
        for fd in (self.init_r, self.sup_r):
            os.set_blocking(fd, False)
        if self.file_r is not None:
            os.set_blocking(self.file_r, False)
        self.host.settimeout(5)
        self.buffers = {self.init_r: b"", self.sup_r: b""}

    def close(self):
        if self.proc.poll() is None:
            self.proc.kill()
        self.proc.wait()
        for stream in (self.proc.stdout, self.proc.stderr):
            stream.close()
        self.host.close()
        for fd in (self.init_w, self.init_r, self.sup_r, self.sup_out_w, self.sup_err_w, self.file_r, self.file_w):
            if fd is None:
                continue
            try:
                os.close(fd)
            except OSError:
                pass

    def wait_exit(self, timeout=5):
        return self.proc.wait(timeout=timeout)

    # ---- the host side of the port
    def send(self, data):
        self.host.sendall(data)

    def read_frame(self, timeout=5):
        header = self._recv(16, timeout)
        assert header[:4] == b"WMX1", header
        cls, seq, length = header[5], struct.unpack_from("<I", header, 8)[0], struct.unpack_from("<I", header, 12)[0]
        return cls, seq, self._recv(length, timeout) if length else b""

    def _recv(self, count, timeout):
        deadline = time.monotonic() + timeout
        data = b""
        while len(data) < count:
            self.host.settimeout(max(0.01, deadline - time.monotonic()))
            chunk = self.host.recv(count - len(data))
            if not chunk:
                raise EOFError("port closed")
            data += chunk
        return data

    # ---- the init side of the ctl pipes
    def init_send(self, tag, payload=b""):
        os.write(self.init_w, ctl(tag, payload))

    def init_read(self, timeout=5):
        """Next ctl message the relay sent to PID 1: (tag, payload)."""
        return self._read_ctl(self.init_r, timeout)

    def _read_ctl(self, fd, timeout):
        deadline = time.monotonic() + timeout
        while True:
            buffer = self.buffers[fd]
            if len(buffer) >= 8:
                length = struct.unpack_from("<I", buffer, 4)[0]
                if len(buffer) >= 8 + length:
                    self.buffers[fd] = buffer[8 + length:]
                    return chr(buffer[0]), buffer[8:8 + length]
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("no ctl message")
            ready, _, _ = select.select([fd], [], [], remaining)
            if ready:
                chunk = os.read(fd, 65536)
                if not chunk:
                    raise EOFError("ctl closed")
                self.buffers[fd] += chunk

    def read_supervisor_input(self, count, timeout=5):
        deadline = time.monotonic() + timeout
        data = b""
        while len(data) < count:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("supervisor input")
            ready, _, _ = select.select([self.sup_r], [], [], remaining)
            if ready:
                chunk = os.read(self.sup_r, count - len(data))
                if not chunk:
                    break
                data += chunk
        return data


@unittest.skipUnless(CC, "no C compiler")
class RelayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.folder = tempfile.mkdtemp(prefix="guest-relay-")
        sources = [ROOT / "relay/relay.c", ROOT / "common/wmx.c", ROOT / "common/ctl.c"]
        cls.relay = build(sources, Path(cls.folder) / "relay", extra=["-DWG_TEST_PORT_SOCKET"])
        cls.production = build(sources, Path(cls.folder) / "relay-production")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.folder, ignore_errors=True)

    def start(self, **kwargs):
        harness = Harness(kwargs.pop("binary", self.relay), **kwargs)
        self.addCleanup(harness.close)
        return harness

    READY = b'{"conversations":1,"nonce":"0123456789abcdef0123456789abcdef","operationId":"op-1","t":"runtime_ready","v":1}'

    def open_runtime(self, harness, streams=1, ready=True):
        """PID 1's order: `G`, then the helper's `runtime_ready` through the relay. The runtime streams are read only after that frame went up,
        so the test takes it off the port first (it is the first bootstrap-class frame)."""
        harness.init_send("G", bytes([streams]))
        time.sleep(0.1)
        if ready:
            harness.init_send("U", self.READY)
            self.assertEqual(harness.read_frame(), (1, 1, self.READY))

    def read_runtime_until(self, harness, want_bytes, want_ends=()):
        """Collects runtime frames until `want_bytes` data bytes arrived per stream and the listed streams ended. Returns ({stream: bytes}, {stream: end seen}, seqs)."""
        got, ended, seqs = {OUT: b"", ERR: b""}, {}, []
        while any(len(got[k]) < want_bytes.get(k, 0) for k in got) or any(e not in ended for e in want_ends):
            cls, seq, payload = harness.read_frame()
            self.assertEqual(cls, 2)
            seqs.append(seq)
            self.assertLessEqual(len(payload), 4 + 65536)
            self.assertEqual((payload[0], payload[3]), (0, 0))
            stream, flags = payload[1], payload[2]
            self.assertIn(stream, (OUT, ERR))
            self.assertNotIn(stream, ended, "bytes after the end of a stream")
            got[stream] += payload[4:]
            if flags:
                self.assertEqual(flags, 1)
                ended[stream] = True
        return got, ended, seqs

    # ---- control class

    def test_ping_is_answered_with_a_pong_carrying_the_same_number(self):
        h = self.start()
        for seq, n in ((1, 7), (2, 4294967295), (3, 0)):
            h.send(control(seq, '{"v":1,"t":"ping","n":%d}' % n))
            cls, up_seq, payload = h.read_frame()
            self.assertEqual((cls, up_seq, payload), (0, seq, ('{"v":1,"t":"pong","n":%d}' % n).encode()))

    def test_a_bootstrap_payload_reaches_pid_1_byte_for_byte(self):
        h = self.start()
        body = b'{"v":1,"t":"plan","anything":"opaque to the relay"}'
        h.send(frame(1, 1, body))
        self.assertEqual(h.init_read(), ("P", body))

    def test_bootstrap_payloads_from_pid_1_are_framed_with_rising_sequence_numbers(self):
        h = self.start()
        for seq, body in ((1, b"hello"), (2, b"receipt"), (3, b"")):
            h.init_send("U", body)
            self.assertEqual(h.read_frame(), (1, seq, body))

    def test_control_and_bootstrap_sequence_numbers_are_independent(self):
        h = self.start()
        h.init_send("U", b"first")
        h.send(control(1, '{"v":1,"t":"ping","n":1}'))
        frames = sorted([h.read_frame(), h.read_frame()])
        self.assertEqual(frames, [(0, 1, b'{"v":1,"t":"pong","n":1}'), (1, 1, b"first")])

    # ---- drain

    def drain_text(self, nonce=NONCE, budget=30000, origin="host-stop"):
        return '{"v":1,"t":"drain","stopNonce":"%s","budgetMs":%d,"origin":"%s"}' % (nonce, budget, origin)

    def test_drain_is_handed_to_pid_1_and_acknowledged_on_request_in_order(self):
        h = self.start()
        h.send(control(1, self.drain_text()))
        tag, payload = h.init_read()
        self.assertEqual((tag, payload[:32], struct.unpack_from("<I", payload, 32)[0], payload[36]), ("D", NONCE.encode(), 30000, 0))
        self.assertEqual(len(payload), 37)
        h.init_send("K", NONCE.encode())
        self.assertEqual(h.read_frame(), (0, 1, ('{"v":1,"t":"drain_ack","stopNonce":"%s"}' % NONCE).encode()))
        h.init_send("H", NONCE.encode())
        self.assertEqual(h.read_frame(), (0, 2, ('{"v":1,"t":"halting","stopNonce":"%s"}' % NONCE).encode()))
        self.assertEqual(h.init_read(), ("f", b""))

    def test_owner_loss_origin_is_passed_on(self):
        h = self.start()
        h.send(control(1, self.drain_text(OTHER_NONCE, 0, "owner-loss")))
        tag, payload = h.init_read()
        self.assertEqual((payload[:32], struct.unpack_from("<I", payload, 32)[0], payload[36]), (OTHER_NONCE.encode(), 0, 1))

    def test_a_repeated_drain_with_the_same_nonce_is_ignored_and_another_nonce_ends_the_stream(self):
        h = self.start()
        h.send(control(1, self.drain_text()))
        self.assertEqual(h.init_read()[0], "D")
        h.send(control(2, self.drain_text()))
        h.send(control(3, '{"v":1,"t":"ping","n":3}'))
        self.assertEqual(h.read_frame()[0:2], (0, 1))  # the pong: no second 'D' was produced
        self.assertRaises(TimeoutError, h.init_read, 0.3)
        h.send(control(4, self.drain_text(OTHER_NONCE)))
        self.assertEqual(h.wait_exit(), EXIT_WMX + STATUS["bad_field"])

    def test_ack_and_halting_need_the_right_nonce_and_order(self):
        for steps in ([("K", OTHER_NONCE)], [("H", NONCE)], [("K", NONCE), ("K", NONCE)], [("K", NONCE), ("H", OTHER_NONCE)]):
            with self.subTest(steps):
                h = self.start()
                h.send(control(1, self.drain_text()))
                h.init_read()
                for tag, nonce in steps:
                    h.init_send(tag, nonce.encode())
                self.assertEqual(h.wait_exit(), 95)

    @unittest.skipUnless(shutdown_rd_fails_peer_writes(), "this platform buffers writes to a socket whose peer shut down reading (Linux CI runs it)")
    def test_a_halting_the_host_could_not_take_is_not_reported_as_flushed(self):
        h = self.start()
        h.send(control(1, self.drain_text()))
        h.init_read()
        h.init_send("K", NONCE.encode())
        h.read_frame()
        h.host.shutdown(socket.SHUT_RD)               # from now on a write to the port fails
        h.init_send("H", NONCE.encode())
        self.assertEqual(h.wait_exit(), 91)
        self.assertRaises((TimeoutError, EOFError), h.init_read, 1)   # no 'f' was ever sent

    def test_the_fatal_notice_is_not_interleaved_with_a_queued_message(self):
        h = self.start()
        h.send(frame(1, 1, b"x" * 1000))               # becomes a 'P' message queued for PID 1
        h.send(frame(0, 5, b'{"v":1,"t":"ping","n":1}'))   # sequence violation right behind it
        self.assertEqual(h.wait_exit(), EXIT_WMX + STATUS["bad_sequence"])
        self.assertEqual(h.init_read(), ("P", b"x" * 1000))
        self.assertEqual(h.init_read(), ("F", bytes([STATUS["bad_sequence"]])))

    def test_ack_without_a_drain_is_a_state_error(self):
        h = self.start()
        h.init_send("K", NONCE.encode())
        self.assertEqual(h.wait_exit(), 95)

    # ---- runtime class







    # ---- runtime class

    def test_runtime_frames_before_the_supervisor_is_ready_end_the_stream(self):
        h = self.start()
        h.send(frame(2, 1, rt(IN, b"early\n")))
        self.assertEqual(h.wait_exit(), EXIT_WMX + STATUS["bad_field"])
        self.assertEqual(h.init_read(), ("F", bytes([STATUS["bad_field"]])))

    def quiet(self, harness, seconds=0.4):
        """Nothing at all arrives on the port within `seconds`."""
        harness.host.settimeout(seconds)
        try:
            data = harness.host.recv(1)
        except socket.timeout:
            return
        finally:
            harness.host.settimeout(5)
        self.fail("unexpected bytes on the port: %r" % data)

    def test_output_written_before_g_is_not_read_or_framed(self):
        """The poll for OUT and ERR needs `runtime_open`: bytes sitting in the FIFOs before PID 1 said `G` stay there."""
        h = self.start()
        os.write(h.sup_out_w, b"too early\n")
        os.write(h.sup_err_w, b"too early\n")
        self.quiet(h)
        h.init_send("G", b"\x01")
        self.quiet(h)                                    # open, but runtime_ready has not been framed yet

    def test_a_runtime_ready_without_g_does_not_open_the_output_streams(self):
        h = self.start()
        h.init_send("U", self.READY)
        self.assertEqual(h.read_frame(), (1, 1, self.READY))
        os.write(h.sup_out_w, b"no g yet\n")
        os.write(h.sup_err_w, b"no g yet\n")
        self.quiet(h)

    def test_runtime_output_is_held_until_runtime_ready_has_gone_up_and_follows_it(self):
        h = self.start()
        self.open_runtime(h, ready=False)
        os.write(h.sup_out_w, b"out-before-ready\n")
        os.write(h.sup_err_w, b"err-before-ready\n")
        self.quiet(h)
        h.init_send("U", b'{"t":"mounted","v":1}')      # another bootstrap-up message is not runtime_ready
        self.assertEqual(h.read_frame(), (1, 1, b'{"t":"mounted","v":1}'))
        self.quiet(h)
        h.init_send("U", b'{"t":"runtime_readyish","v":1}')   # only the exact type token counts
        self.assertEqual(h.read_frame(), (1, 2, b'{"t":"runtime_readyish","v":1}'))
        self.quiet(h)
        h.init_send("U", self.READY)
        self.assertEqual(h.read_frame(), (1, 3, self.READY))                  # the host sees runtime_ready first ...
        got, _, _ = self.read_runtime_until(h, {OUT: 17, ERR: 16})            # ... and then every byte that was waiting
        self.assertEqual(got, {OUT: b"out-before-ready\n", ERR: b"err-before-ready\n"})

    def test_runtime_down_reaches_the_supervisor_input_and_up_is_framed_with_its_stream_byte(self):
        h = self.start()
        self.open_runtime(h)
        h.send(frame(2, 1, rt(IN, b'{"type":"user"}\n')))
        h.send(frame(2, 2, rt(IN, b"second\n")))
        self.assertEqual(h.read_supervisor_input(16 + 7), b'{"type":"user"}\nsecond\n')
        os.write(h.sup_out_w, b"answer-1\n")
        self.assertEqual(h.read_frame(), (2, 1, rt(OUT, b"answer-1\n")))
        os.write(h.sup_err_w, b"warning\n")
        self.assertEqual(h.read_frame(), (2, 2, rt(ERR, b"warning\n")))

    def test_the_end_of_the_in_stream_closes_the_supervisor_input_after_the_bytes_before_it(self):
        h = self.start()
        self.open_runtime(h)
        h.send(frame(2, 1, rt(IN, b"last words\n", end=True)))
        self.assertEqual(h.read_supervisor_input(11), b"last words\n")
        ready, _, _ = select.select([h.sup_r], [], [], 2)
        self.assertEqual(ready, [h.sup_r])
        self.assertEqual(os.read(h.sup_r, 10), b"")                         # EOF: the input was closed
        h.send(frame(2, 2, rt(IN, b"too late")))                          # bytes after the end
        self.assertEqual(h.wait_exit(), EXIT_WMX + STATUS["bad_field"])

    def test_an_empty_end_frame_alone_closes_the_input(self):
        h = self.start()
        self.open_runtime(h)
        h.send(frame(2, 1, rt(IN, end=True)))
        ready, _, _ = select.select([h.sup_r], [], [], 2)
        self.assertEqual((ready, os.read(h.sup_r, 10)), ([h.sup_r], b""))
        h.send(frame(2, 2, rt(IN, end=True)))                             # a second end
        self.assertEqual(h.wait_exit(), EXIT_WMX + STATUS["bad_field"])

    def test_the_supervisor_closing_stdout_and_stderr_sends_an_end_frame_for_each(self):
        h = self.start()
        self.open_runtime(h)
        os.write(h.sup_out_w, b"bye\n")
        os.close(h.sup_out_w)
        os.close(h.sup_err_w)
        got, ended, seqs = self.read_runtime_until(h, {OUT: 4}, want_ends=(OUT, ERR))
        self.assertEqual((got[OUT], got[ERR], ended), (b"bye\n", b"", {OUT: True, ERR: True}))
        self.assertEqual(seqs, list(range(1, len(seqs) + 1)))

    def test_runtime_output_is_chunked_to_at_most_64_kib_and_loses_no_byte(self):
        h = self.start()
        self.open_runtime(h)
        blob = bytes(range(256)) * 1024 * 3  # 768 KiB
        writer = os.fork()
        if writer == 0:
            try:
                view = memoryview(blob)
                while view:
                    view = view[os.write(h.sup_out_w, view):]
            finally:
                os._exit(0)
        got, _, seqs = self.read_runtime_until(h, {OUT: len(blob)})
        os.waitpid(writer, 0)
        self.assertEqual(got[OUT], blob)
        self.assertEqual(seqs, list(range(1, len(seqs) + 1)))

    def test_supervisor_stderr_is_carried_as_its_own_stream(self):
        h = self.start()
        self.open_runtime(h)
        os.write(h.sup_err_w, b"diagnostic\n" * 100)
        got, _, _ = self.read_runtime_until(h, {ERR: 1100})
        self.assertEqual((got[ERR], got[OUT]), (b"diagnostic\n" * 100, b""))

    def test_a_conversation_outside_the_delivered_set_ends_the_stream(self):
        h = self.start()
        self.open_runtime(h)
        h.send(frame(2, 1, rt(IN, b"x", conversation=1)))
        self.assertEqual(h.wait_exit(), EXIT_WMX + STATUS["bad_field"])

    def test_with_no_runtime_streams_any_runtime_frame_ends_the_stream(self):
        h = self.start()
        self.open_runtime(h, streams=0)
        h.send(control(1, '{"v":1,"t":"ping","n":4}'))
        self.assertEqual(h.read_frame(), (0, 1, b'{"v":1,"t":"pong","n":4}'))
        h.send(frame(2, 1, rt(IN, b"x")))
        self.assertEqual(h.wait_exit(), EXIT_WMX + STATUS["bad_field"])

    def test_with_no_runtime_streams_nothing_is_ever_sent_up_for_them(self):
        h = self.start()
        self.open_runtime(h, streams=0)
        os.write(h.sup_out_w, b"stray\n")
        os.close(h.sup_out_w)
        os.close(h.sup_err_w)
        h.send(control(1, '{"v":1,"t":"ping","n":8}'))
        self.assertEqual(h.read_frame(), (0, 1, b'{"v":1,"t":"pong","n":8}'))     # the very first frame up is the pong: no end frames, no data
        h.send(control(2, '{"v":1,"t":"ping","n":9}'))
        self.assertEqual(h.read_frame(), (0, 2, b'{"v":1,"t":"pong","n":9}'))
        self.assertIsNone(h.proc.poll())

    def test_runtime_prefix_violations_end_the_stream_with_the_contract_category(self):
        cases = ((b"\x00\x01\x00", "malformed"), (rt(IN, b"x", conversation=16), "bad_field"), (rt(0, b"x"), "bad_field"), (rt(4, b"x"), "bad_field"),
                 (rt(IN, b"x", flags=2), "bad_field"), (b"\x00\x01\x00\x01x", "bad_field"), (rt(IN), "bad_field"),
                 (rt(OUT, b"x"), "bad_direction"), (rt(ERR, b"x"), "bad_direction"))
        for payload, status in cases:
            with self.subTest(payload=payload[:6], status=status):
                h = self.start()
                self.open_runtime(h)
                h.send(frame(2, 1, payload))
                self.assertEqual(h.wait_exit(), EXIT_WMX + STATUS[status])

    def test_a_violation_is_reported_to_the_host_as_a_protocol_violation_fault(self):
        h = self.start()
        h.send(frame(0, 1, b"not json"))
        cls, seq, payload = h.read_frame()
        self.assertEqual((cls, seq, payload), (0, 1, b'{"v":1,"t":"fault","code":"protocol_violation","stopNonce":null}'))
        self.assertEqual(h.wait_exit(), EXIT_WMX + STATUS["malformed"])
        h = self.start()
        h.send(control(1, self.drain_text()))
        h.init_read()
        h.send(frame(0, 2, b"not json"))
        self.assertEqual(h.read_frame()[2], ('{"v":1,"t":"fault","code":"protocol_violation","stopNonce":"%s"}' % NONCE).encode())

    def test_pongs_queued_while_the_runtime_streams_have_filled_the_ring_still_fit(self):
        """The runtime streams stop reading the supervisor while less than a reserve is free, so a burst of pings (answered at once, never deferred)
        cannot overflow the upstream ring. Without the reserve the third burst below ends the stream with the overflow code."""
        h = self.start()
        self.open_runtime(h)
        blob = bytes(range(256)) * 1024 * 12  # 3 MiB: more than the ring and the socket buffer together
        writers = []
        for fd in (h.sup_out_w, h.sup_err_w):
            pid = os.fork()
            if pid == 0:
                try:
                    view = memoryview(blob)
                    while view:
                        view = view[os.write(fd, view):]
                finally:
                    os._exit(0)
            writers.append(pid)
        time.sleep(1.0)                                    # the host reads nothing: the ring and the socket buffer fill up
        bursts, per_burst = 3, 1600                        # each burst is one 64 KiB read worth of pings (40 bytes each)
        total = bursts * per_burst
        for burst in range(bursts):
            h.send(b"".join(control(burst * per_burst + i + 1, '{"v":1,"t":"ping","n":%d}' % (burst * per_burst + i + 1)) for i in range(per_burst)))
            time.sleep(0.2)
        self.assertIsNone(h.proc.poll(), "the relay ended the stream while pongs were queued")
        got, pongs, runtime_seqs = {OUT: b"", ERR: b""}, [], []
        while len(pongs) < total or any(len(got[k]) < len(blob) for k in got):
            cls, seq, payload = h.read_frame()
            if cls == 0:
                pongs.append((seq, payload))
            else:
                self.assertEqual(cls, 2)
                runtime_seqs.append(seq)
                got[payload[1]] += payload[4:]
        for pid in writers:
            os.waitpid(pid, 0)
        self.assertEqual(pongs, [(i, ('{"v":1,"t":"pong","n":%d}' % i).encode()) for i in range(1, total + 1)])
        self.assertEqual(got, {OUT: blob, ERR: blob})
        self.assertEqual(runtime_seqs, list(range(1, len(runtime_seqs) + 1)))
        self.assertIsNone(h.proc.poll())

    def test_a_supervisor_that_floods_stderr_never_blocks(self):
        h = self.start()
        self.open_runtime(h)
        writer = os.fork()
        if writer == 0:
            try:
                chunk = b"e" * 65536
                for _ in range(16):          # 1 MiB into a 64 KiB pipe: blocks forever unless the relay reads it
                    os.write(h.sup_err_w, chunk)
            finally:
                os._exit(0)
        got, _, _ = self.read_runtime_until(h, {ERR: 16 * 65536})
        os.waitpid(writer, 0)
        self.assertEqual(len(got[ERR]), 16 * 65536)

    def test_runtime_frames_are_dropped_once_the_supervisor_input_is_gone(self):
        h = self.start()
        self.open_runtime(h)
        os.close(h.sup_r)
        h.sup_r = os.open(os.devnull, os.O_RDONLY)  # keep the harness cleanup valid
        h.send(frame(2, 1, rt(IN, b"x" * 1000)))
        h.send(control(1, '{"v":1,"t":"ping","n":1}'))
        self.assertEqual(h.read_frame()[0], 0)
        time.sleep(0.5)                       # a SIGPIPE from the write to the closed pipe would have killed the relay by now
        h.send(control(2, '{"v":1,"t":"ping","n":2}'))
        self.assertEqual(h.read_frame(), (0, 2, b'{"v":1,"t":"pong","n":2}'))
        self.assertIsNone(h.proc.poll())

    def test_runtime_bytes_after_a_drain_began_are_not_delivered(self):
        h = self.start()
        self.open_runtime(h)
        h.send(control(1, self.drain_text()))
        self.assertEqual(h.init_read()[0], "D")
        h.send(frame(2, 1, rt(IN, b"late input\n")))
        h.send(control(2, '{"v":1,"t":"ping","n":5}'))
        self.assertEqual(h.read_frame()[0:2], (0, 1))
        ready, _, _ = select.select([h.sup_r], [], [], 0.3)
        self.assertEqual(ready, [])

    def test_the_contracts_runtime_flow_cases_never_trouble_the_relay(self):
        """runtime-flow.json: the host keeps runtime IN bytes sent with no OUT or ERR byte received since at or below 1 MiB. Every step the host may take
        (everything before a case's `refusedAt`) must be absorbed: no stream end, every byte delivered in order, the relay still answering. The 4 MiB IN
        queue is a quarter-ratio above that limit, so it needs no guest-side credit or check."""
        flow = json.loads((ROOT / "vectors/runtime-flow.json").read_text())
        self.assertEqual(flow["limitBytes"], 1048576)
        self.assertEqual(len(flow["cases"]), 13)
        for case in flow["cases"]:
            with self.subTest(case["name"]):
                h = self.start()
                self.open_runtime(h)
                seq, sent, seen = 1, bytearray(), {OUT: 0, ERR: 0}
                steps = case["steps"] if case["refusedAt"] is None else case["steps"][:case["refusedAt"]]
                for step in steps:
                    if step["stream"] == "in":
                        left = step["bytes"]
                        while left:
                            n = min(left, 256 * 1024)
                            data = bytes((len(sent) + i) % 251 for i in range(n))
                            h.send(frame(2, seq, rt(IN, data)))
                            seq += 1
                            sent += data
                            left -= n
                    else:
                        stream = OUT if step["stream"] == "out" else ERR
                        os.write(h.sup_out_w if stream == OUT else h.sup_err_w, b"x" * step["bytes"])
                        got, _, _ = self.read_runtime_until(h, {stream: step["bytes"]})
                        self.assertEqual(len(got[stream]), step["bytes"])
                self.assertEqual(h.read_supervisor_input(len(sent), timeout=20), bytes(sent))
                h.send(control(1, '{"v":1,"t":"ping","n":3}'))
                self.assertEqual(h.read_frame(), (0, 1, b'{"v":1,"t":"pong","n":3}'))
                self.assertIsNone(h.proc.poll())

    def test_a_flood_beyond_the_bounded_queue_ends_the_stream(self):
        h = self.start()
        self.open_runtime(h)
        chunk = rt(IN, b"z" * (1024 * 1024 - 4))
        try:
            for seq in range(1, 8):
                h.send(frame(2, seq, chunk))
        except (BrokenPipeError, ConnectionResetError, TimeoutError, OSError):
            pass
        self.assertEqual(h.wait_exit(), 93)

    def test_go_twice_with_a_bad_payload_or_while_draining_is_a_state_error(self):
        for first, second in ((b"\x01", b"\x01"), (b"", None), (b"\x02", None), (b"\x01\x01", None)):
            h = self.start()
            h.init_send("G", first)
            if second is not None:
                h.init_send("G", second)
            self.assertEqual(h.wait_exit(), 95, (first, second))
        h = self.start()
        h.send(control(1, self.drain_text()))
        h.init_read()
        h.init_send("G", b"\x01")
        self.assertEqual(h.wait_exit(), 95)

    # ---- fault (PID 1 asks the relay to send a control-up fault)

    def test_a_fault_from_pid_1_is_framed_flushed_and_reported_flushed(self):
        h = self.start()
        h.init_send("X", bytes([2]))
        self.assertEqual(h.read_frame(), (0, 1, b'{"v":1,"t":"fault","code":"supervisor_lost","stopNonce":null}'))
        self.assertEqual(h.init_read(), ("f", b""))
        h = self.start()
        h.send(control(1, self.drain_text()))
        h.init_read()
        h.init_send("K", NONCE.encode())
        h.init_send("X", bytes([1]) + NONCE.encode())
        self.assertEqual(h.read_frame()[2], ('{"v":1,"t":"drain_ack","stopNonce":"%s"}' % NONCE).encode())
        self.assertEqual(h.read_frame()[2], ('{"v":1,"t":"fault","code":"unmount_failed","stopNonce":"%s"}' % NONCE).encode())
        self.assertEqual(h.init_read(), ("f", b""))

    def test_a_fault_with_trailing_bytes_after_the_nonce_is_a_state_error(self):
        h = self.start()
        h.send(control(1, self.drain_text()))
        h.init_read()
        h.init_send("X", bytes([1]) + NONCE.encode() + b"zzzzzzz")           # the nonce is right; the length is not
        self.assertEqual(h.wait_exit(), 95)

    def test_a_fault_after_halting_is_a_state_error(self):
        h = self.start()
        h.send(control(1, self.drain_text()))
        h.init_read()
        h.init_send("K", NONCE.encode())
        h.init_send("H", NONCE.encode())
        h.read_frame(); h.read_frame()
        self.assertEqual(h.init_read(), ("f", b""))
        h.init_send("X", bytes([1]) + NONCE.encode())
        self.assertEqual(h.wait_exit(), 95)

    def test_a_fault_with_a_bad_code_or_nonce_or_after_halting_is_a_state_error(self):
        bad = [bytes([0]), bytes([5]), b"", bytes([1]) + b"ab" * 15, bytes([1]) + OTHER_NONCE.encode()]
        for payload in bad:
            with self.subTest(payload=payload[:4]):
                h = self.start()
                h.send(control(1, self.drain_text()))
                h.init_read()
                h.init_send("X", payload)
                self.assertEqual(h.wait_exit(), 95)
        h = self.start()                                                  # a nonce with no drain
        h.init_send("X", bytes([1]) + NONCE.encode())
        self.assertEqual(h.wait_exit(), 95)
        h = self.start()                                                  # two faults
        h.init_send("X", bytes([4]))
        h.read_frame()
        h.init_send("X", bytes([4]))
        self.assertEqual(h.wait_exit(), 95)
        h = self.start()                                                  # halting after a fault
        h.send(control(1, self.drain_text()))
        h.init_read()
        h.init_send("K", NONCE.encode())
        h.init_send("X", bytes([1]) + NONCE.encode())
        h.read_frame(); h.read_frame()
        h.init_send("H", NONCE.encode())
        self.assertEqual(h.wait_exit(), 95)

    # ---- violations

    def assert_violation(self, data, status, then_f=True):
        h = self.start()
        try:
            h.send(data)
        except OSError:
            pass
        self.assertEqual(h.wait_exit(), EXIT_WMX + STATUS[status])
        if then_f:
            tag, payload = h.init_read()
            self.assertEqual((tag, payload), ("F", bytes([STATUS[status]])))

    def test_header_violations_end_the_stream_and_tell_pid_1_which(self):
        self.assert_violation(b"WMX2" + frame(0, 1)[4:], "malformed")
        self.assert_violation(frame(0, 1)[:4] + bytes([2]) + frame(0, 1)[5:], "version")
        self.assert_violation(frame(0, 1, flags=1), "malformed")
        self.assert_violation(frame(9, 1), "malformed")
        self.assert_violation(frame(0, 0, b'{"v":1,"t":"ping","n":1}'), "bad_sequence")
        self.assert_violation(frame(1, 1, b"x" * 20481), "oversize")
        self.assert_violation(frame(0, 1, b"x" * 4097), "oversize")

    def test_the_provider_class_is_refused_in_both_shapes(self):
        self.assert_violation(frame(3, 1), "reserved_class")
        self.assert_violation(frame(3, 1, b"{}"), "reserved_class")

    def test_sequence_gaps_repeats_and_rewinds_end_the_stream(self):
        ping = '{"v":1,"t":"ping","n":1}'
        self.assert_violation(control(2, ping), "bad_sequence")
        self.assert_violation(control(1, ping) + control(1, ping), "bad_sequence")
        self.assert_violation(control(1, ping) + control(2, ping) + control(1, ping), "bad_sequence")
        self.assert_violation(frame(1, 2, b"x"), "bad_sequence")

    def test_control_payload_violations(self):
        for text, status in (("nope", "malformed"), ('{"v":1,"t":"ping", "n":7}', "malformed"), ('{"v":1,"t":"explode"}', "unknown_type"),
                             ('{"v":1,"t":"ping","n":7,"extra":1}', "bad_field"), ('{"v":1,"t":"drain_ack","stopNonce":"%s"}' % NONCE, "unknown_type")):
            with self.subTest(text):
                self.assert_violation(control(1, text), status)

    def test_a_frame_split_across_many_writes_is_assembled(self):
        h = self.start()
        data = control(1, '{"v":1,"t":"ping","n":5}')
        for byte in data:
            h.send(bytes([byte]))
        self.assertEqual(h.read_frame(), (0, 1, b'{"v":1,"t":"pong","n":5}'))

    def test_many_frames_in_one_write_are_all_handled(self):
        h = self.start()
        h.send(b"".join(control(i, '{"v":1,"t":"ping","n":%d}' % i) for i in range(1, 51)))
        for i in range(1, 51):
            self.assertEqual(h.read_frame(), (0, i, ('{"v":1,"t":"pong","n":%d}' % i).encode()))

    # ---- peers and descriptors

    def test_the_host_closing_the_port_ends_the_relay(self):
        h = self.start()
        h.send(control(1, '{"v":1,"t":"ping","n":1}'))
        h.read_frame()
        h.host.shutdown(socket.SHUT_RDWR)
        h.host.close()
        self.assertEqual(h.wait_exit(), 91)

    def test_pid_1_closing_its_end_ends_the_relay(self):
        h = self.start()
        os.close(h.init_w)
        h.init_w = os.open(os.devnull, os.O_WRONLY)
        self.assertEqual(h.wait_exit(), 92)

    def test_an_unlisted_or_malformed_ctl_message_ends_the_relay(self):
        for raw in (ctl("Z"), struct.pack("<B3xI", ord("U"), 70000), b"U\x01\x00\x00\x00\x00\x00\x00"):
            with self.subTest(raw[:8]):
                h = self.start()
                os.write(h.init_w, raw)
                self.assertEqual(h.wait_exit(), 92)

    def test_the_production_build_refuses_a_socket_as_the_port(self):
        h = self.start(binary=self.production)
        self.assertEqual(h.wait_exit(), EXIT_PORT_KIND)

    def test_a_stray_inherited_descriptor_is_refused(self):
        leak = os.open(os.devnull, os.O_RDONLY)
        try:
            h = self.start(extra_fds=(leak,))
            self.assertEqual(h.wait_exit(), EXIT_STRAY_FD)
        finally:
            os.close(leak)

    def test_argument_errors(self):
        for argv in ([], ["--port", "3"], ["--port", "3", "--ctl-in", "3", "--ctl-out", "5", "--rt-in", "6", "--rt-out", "7", "--rt-err", "8"],
                     ["--ctl-in", "4", "--port", "3", "--ctl-out", "5", "--rt-in", "6", "--rt-out", "7", "--rt-err", "8"],
                     ["--port", "2", "--ctl-in", "4", "--ctl-out", "5", "--rt-in", "6", "--rt-out", "7", "--rt-err", "8"],
                     ["--port", "x", "--ctl-in", "4", "--ctl-out", "5", "--rt-in", "6", "--rt-out", "7", "--rt-err", "8"]):
            with self.subTest(argv):
                result = subprocess.run([str(self.relay), *argv], capture_output=True, timeout=10)
                self.assertEqual(result.returncode, EXIT_ARGUMENTS)

    def test_a_descriptor_of_the_wrong_kind_is_refused(self):
        # rt-in must be a pipe: hand it a regular file
        with tempfile.TemporaryFile() as handle:
            host, port = socket.socketpair()
            pipes = [os.pipe() for _ in range(4)]
            argv = ["--port", str(port.fileno()), "--ctl-in", str(pipes[0][0]), "--ctl-out", str(pipes[1][1]), "--rt-in", str(handle.fileno()),
                    "--rt-out", str(pipes[2][0]), "--rt-err", str(pipes[3][0])]
            keep = [port.fileno(), pipes[0][0], pipes[1][1], handle.fileno(), pipes[2][0], pipes[3][0]]
            try:
                result = subprocess.run([str(self.relay), *argv], pass_fds=keep, capture_output=True, timeout=10)
            finally:
                for pair in pipes:
                    for fd in pair:
                        os.close(fd)
                host.close()
                port.close()
            self.assertEqual(result.returncode, 65)


FILE_IN, FILE_OUT = 4, 5
EXIT_OVERSIZE, EXIT_BAD_FIELD, EXIT_BAD_DIRECTION = EXIT_WMX + 2, EXIT_WMX + 5, EXIT_WMX + 8
EXIT_STATE = 95


@unittest.skipUnless(CC, "no C compiler")
class FileChannelRelayTests(unittest.TestCase):
    """The relay built with WG_FILE_CHANNEL_V1 (an image that declares `file-channel-v1`): streams 4 and 5 on conversation 0, their own ring and flow rule,
    FILE_IN closed first on a drain, FILE_OUT's end framed before `halting`. The production relay has none of it."""

    @classmethod
    def setUpClass(cls):
        cls.folder = tempfile.mkdtemp(prefix="guest-relay-file-")
        sources = [ROOT / "relay/relay.c", ROOT / "common/wmx.c", ROOT / "common/ctl.c", ROOT / "common/fileflow.c"]
        cls.relay = build(sources, Path(cls.folder) / "relay", extra=["-DWG_TEST_PORT_SOCKET", "-DWG_FILE_CHANNEL_V1"])
        cls.plain = build([ROOT / "relay/relay.c", ROOT / "common/wmx.c", ROOT / "common/ctl.c"], Path(cls.folder) / "relay-plain", extra=["-DWG_TEST_PORT_SOCKET"])

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.folder, ignore_errors=True)

    def start(self, file_channel=True, binary=None, **kwargs):
        harness = Harness(binary or self.relay, file_channel=file_channel, **kwargs)
        self.addCleanup(harness.close)
        return harness

    READY = RelayTests.READY

    def open_all(self, h, bits=3):
        """PID 1's order: `G` (bit 0 runtime streams, bit 1 the file service), then `runtime_ready` through the relay."""
        h.init_send("G", bytes([bits]))
        time.sleep(0.1)
        h.init_send("U", self.READY)
        self.assertEqual(h.read_frame(), (1, 1, self.READY))

    def read_file(self, h, count, timeout=5):
        deadline = time.monotonic() + timeout
        data = b""
        while len(data) < count:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("file service input")
            ready, _, _ = select.select([h.file_r], [], [], remaining)
            if ready:
                chunk = os.read(h.file_r, count - len(data))
                if not chunk:
                    break
                data += chunk
        return data

    def file_eof(self, h, timeout=5):
        """True when FILE_IN reads as closed (every write end gone)."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            ready, _, _ = select.select([h.file_r], [], [], 0.1)
            if ready:
                return os.read(h.file_r, 65536) == b""
        return False

    # ---- the argument and descriptor contract

    def test_the_gated_relay_takes_the_two_file_pipes_and_the_plain_one_refuses_them(self):
        h = self.start(file_channel=True, binary=self.plain)
        self.assertEqual(h.wait_exit(), 64)                         # 17 arguments to a relay that takes 13
        h = self.start(file_channel=False)
        self.assertEqual(h.wait_exit(), 64)                         # 13 arguments to a relay that takes 17
        a, b = os.pipe()
        try:
            h = self.start(extra_fds=[a])
            self.assertEqual(h.wait_exit(), 71)                     # a stray descriptor is refused
        finally:
            os.close(a)
            os.close(b)

    def test_the_file_pipes_must_be_pipes(self):
        with open("/dev/null", "rb") as not_a_pipe:
            h = self.start(file_in_instead=not_a_pipe.fileno())
            self.assertEqual(h.wait_exit(), 65)                     # EXIT_DESCRIPTOR
            h = self.start(file_out_instead=not_a_pipe.fileno())
            self.assertEqual(h.wait_exit(), 65)

    # ---- the production relay refuses the file streams

    def test_a_relay_without_the_gate_ends_the_stream_on_stream_four(self):
        h = self.start(file_channel=False, binary=self.plain)
        h.init_send("G", b"\x01")
        time.sleep(0.1)
        h.send(frame(2, 1, rt(FILE_IN, b"x\n")))
        self.assertEqual(h.wait_exit(), EXIT_BAD_FIELD)

    # ---- FILE_IN

    def test_a_request_line_reaches_the_file_service_byte_for_byte_and_a_response_comes_back_as_stream_five(self):
        h = self.start()
        self.open_all(h)
        request = b'{"op":"stat","path":"/workspace/a"}\n'
        h.send(frame(2, 1, rt(FILE_IN, request)))
        self.assertEqual(self.read_file(h, len(request)), request)
        response = b'{"ok":true}\n'
        os.write(h.file_w, response)
        cls, seq, payload = h.read_frame()
        self.assertEqual((cls, seq, payload[:4], payload[4:]), (2, 1, bytes([0, FILE_OUT, 0, 0]), response))

    def test_file_in_never_reaches_the_runtime_input_and_runtime_input_never_reaches_the_file_service(self):
        h = self.start()
        self.open_all(h)
        h.send(frame(2, 1, rt(IN, b"runtime bytes\n")))
        h.send(frame(2, 2, rt(FILE_IN, b"file bytes\n")))
        self.assertEqual(h.read_supervisor_input(14), b"runtime bytes\n")
        self.assertEqual(self.read_file(h, 11), b"file bytes\n")
        ready, _, _ = select.select([h.sup_r], [], [], 0.3)
        self.assertEqual(ready, [])

    def test_the_runtime_streams_exist_only_for_a_host_query_conversation_even_when_the_file_service_does(self):
        h = self.start()
        self.open_all(h, bits=2)
        h.send(frame(2, 1, rt(IN, b"runtime bytes\n")))
        self.assertEqual(h.wait_exit(), EXIT_BAD_FIELD)

    def test_a_file_service_that_is_not_there_is_never_read(self):
        h = self.start()
        self.open_all(h, bits=1)
        os.write(h.file_w, b"nobody asked\n")
        time.sleep(0.3)
        h.send(control(1, '{"v":1,"t":"ping","n":9}'))
        self.assertEqual(h.read_frame(), (0, 1, b'{"v":1,"t":"pong","n":9}'))      # the next frame is the pong: no FILE_OUT frame before it
        self.assertIsNone(h.proc.poll())

    def test_a_file_service_that_exits_does_not_end_the_relay(self):
        h = self.start()
        self.open_all(h)
        os.close(h.file_r)
        h.file_r = None
        h.send(frame(2, 1, rt(FILE_IN, b"q\n")))
        time.sleep(0.3)
        h.send(frame(2, 2, rt(IN, b"runtime still works\n")))
        self.assertEqual(h.read_supervisor_input(20), b"runtime still works\n")
        h.send(control(1, '{"v":1,"t":"ping","n":4}'))
        self.assertEqual(h.read_frame()[0:2], (0, 1))
        self.assertIsNone(h.proc.poll())

    def test_file_in_works_with_no_host_query_conversation(self):
        h = self.start()
        h.init_send("G", b"\x02")                                   # bit 1 only: a tools-only set still has a file service
        time.sleep(0.1)
        h.init_send("U", self.READY)
        h.read_frame()
        h.send(frame(2, 1, rt(FILE_IN, b"q\n")))
        self.assertEqual(self.read_file(h, 2), b"q\n")
        self.assertIsNone(h.proc.poll())

    def test_the_end_of_file_in_closes_the_file_service_input_after_what_came_before_and_nothing_follows(self):
        h = self.start()
        self.open_all(h)
        h.send(frame(2, 1, rt(FILE_IN, b"last\n")) + frame(2, 2, rt(FILE_IN, b"", end=True)))   # one port read: the end is seen before the data is written
        self.assertEqual(self.read_file(h, 5), b"last\n")
        self.assertTrue(self.file_eof(h))
        h.send(frame(2, 3, rt(FILE_IN, b"late\n")))
        self.assertEqual(h.wait_exit(), EXIT_BAD_FIELD)

    def test_file_in_before_the_go_or_without_a_file_service_ends_the_stream(self):
        h = self.start()
        h.send(frame(2, 1, rt(FILE_IN, b"x\n")))
        self.assertEqual(h.wait_exit(), EXIT_BAD_FIELD)
        h = self.start()
        self.open_all(h, bits=1)                                    # the supervisor has no file service
        h.send(frame(2, 1, rt(FILE_IN, b"x\n")))
        self.assertEqual(h.wait_exit(), EXIT_BAD_FIELD)

    def test_the_streams_exist_on_conversation_zero_and_in_their_own_direction_only(self):
        for payload, code in ((rt(FILE_IN, b"x\n", conversation=1), EXIT_BAD_FIELD), (rt(FILE_OUT, b"x\n"), EXIT_BAD_DIRECTION), (rt(6, b"x\n"), EXIT_BAD_FIELD),
                              (rt(FILE_IN, b"", end=False), EXIT_BAD_FIELD), (rt(FILE_IN, b"x\n", flags=2), EXIT_BAD_FIELD)):
            h = self.start()
            self.open_all(h)
            h.send(frame(2, 1, payload))
            self.assertEqual(h.wait_exit(), code, payload)

    def test_the_file_in_flow_rule_is_the_contracts(self):
        """Four request lines outstanding, 16 KiB per line; a fifth line or a longer line ends the stream with `oversize`."""
        h = self.start()
        self.open_all(h)
        for seq in range(1, 5):
            h.send(frame(2, seq, rt(FILE_IN, b"r\n")))
        self.assertEqual(self.read_file(h, 8), b"r\n" * 4)
        h.send(frame(2, 5, rt(FILE_IN, b"r\n")))
        self.assertEqual(h.wait_exit(), EXIT_OVERSIZE)
        h = self.start()
        self.open_all(h)
        h.send(frame(2, 1, rt(FILE_IN, b"x" * 16383 + b"\n")))
        self.assertEqual(len(self.read_file(h, 16384)), 16384)
        self.assertIsNone(h.proc.poll())
        h = self.start()
        self.open_all(h)
        h.send(frame(2, 1, rt(FILE_IN, b"x" * 16384 + b"\n")))
        self.assertEqual(h.wait_exit(), EXIT_OVERSIZE)

    def test_a_response_frees_a_slot_and_a_response_with_nothing_outstanding_is_a_state_error(self):
        h = self.start()
        self.open_all(h)
        for seq in range(1, 5):
            h.send(frame(2, seq, rt(FILE_IN, b"r\n")))
        self.read_file(h, 8)
        os.write(h.file_w, b"a\n")
        h.read_frame()
        h.send(frame(2, 5, rt(FILE_IN, b"r\n")))
        self.assertEqual(self.read_file(h, 2), b"r\n")
        self.assertIsNone(h.proc.poll())
        h = self.start()
        self.open_all(h)
        os.write(h.file_w, b"unasked\n")                           # the guest's own supervisor answered nobody: a broken guest, not a host violation
        self.assertEqual(h.wait_exit(), EXIT_STATE)

    def test_file_out_is_not_read_before_runtime_ready_is_framed(self):
        h = self.start()
        h.init_send("G", b"\x03")
        time.sleep(0.1)
        h.send(frame(2, 1, rt(FILE_IN, b"q\n")))
        self.read_file(h, 2)
        os.write(h.file_w, b"early\n")
        time.sleep(0.3)
        h.init_send("U", self.READY)
        self.assertEqual(h.read_frame(), (1, 1, self.READY))
        cls, _, payload = h.read_frame()
        self.assertEqual((cls, payload[1], payload[4:]), (2, FILE_OUT, b"early\n"))

    # ---- drain and halting

    def test_a_drain_closes_file_in_before_pid_1_hears_of_it(self):
        h = self.start()
        self.open_all(h)
        h.send(control(1, RelayTests.drain_text(None)))
        self.assertEqual(h.init_read()[0], "D")
        self.assertTrue(self.file_eof(h, timeout=0.5), "FILE_IN must already be closed when PID 1 reads the drain")
        h.send(frame(2, 1, rt(FILE_IN, b"late\n")))                # ignored while draining, like runtime input
        h.send(control(2, '{"v":1,"t":"ping","n":5}'))
        self.assertEqual(h.read_frame()[0:2], (0, 1))
        self.assertIsNone(h.proc.poll())

    def test_file_outs_end_is_framed_before_halting(self):
        h = self.start()
        self.open_all(h)
        h.send(frame(2, 1, rt(FILE_IN, b"q\n")))
        self.read_file(h, 2)
        h.send(control(1, RelayTests.drain_text(None)))
        h.init_read()
        h.init_send("K", NONCE.encode())
        self.assertEqual(h.read_frame()[0:2], (0, 1))                 # drain_ack
        os.write(h.file_w, b"final\n")                             # the file service's last answer, then it exits
        os.close(h.file_w)
        h.file_w = None
        h.init_send("H", NONCE.encode())
        frames = [h.read_frame(), h.read_frame(), h.read_frame()]
        self.assertEqual([f[0] for f in frames], [2, 2, 0])
        self.assertEqual((frames[0][2][1], frames[0][2][2], frames[0][2][4:]), (FILE_OUT, 0, b"final\n"))
        self.assertEqual((frames[1][2][1], frames[1][2][2], frames[1][2][4:]), (FILE_OUT, 1, b""))
        self.assertEqual(frames[2][2], ('{"v":1,"t":"halting","stopNonce":"%s"}' % NONCE).encode())
        self.assertEqual(h.init_read(), ("f", b""))

    def drain_to_halting(self, h):
        h.send(control(1, RelayTests.drain_text(None)))
        h.init_read()
        h.init_send("K", NONCE.encode())
        self.assertEqual(h.read_frame()[0:2], (0, 1))                 # drain_ack

    def test_file_outs_end_is_framed_even_when_the_service_has_not_closed_its_side(self):
        h = self.start()
        self.open_all(h)
        self.drain_to_halting(h)
        h.init_send("H", NONCE.encode())
        cls, _, payload = h.read_frame()
        self.assertEqual((cls, payload[1], payload[2], payload[4:]), (2, FILE_OUT, 1, b""))
        self.assertEqual(h.read_frame()[0], 0)                        # halting, after it

    def test_no_file_out_end_is_framed_for_a_guest_without_a_file_service_or_before_runtime_ready(self):
        h = self.start()
        self.open_all(h, bits=1)                                      # no file service
        self.drain_to_halting(h)
        h.init_send("H", NONCE.encode())
        self.assertEqual(h.read_frame()[0], 0)                        # halting is the very next frame
        h = self.start()
        h.init_send("G", b"\x03")                                     # a file service, but `runtime_ready` was never framed
        time.sleep(0.1)
        self.drain_to_halting(h)
        h.init_send("H", NONCE.encode())
        self.assertEqual(h.read_frame()[0], 0)

    def test_the_go_byte_has_two_bits_and_nothing_else(self):
        for value in (4, 7, 255):
            h = self.start()
            h.init_send("G", bytes([value]))
            self.assertEqual(h.wait_exit(), EXIT_STATE, value)

    def test_a_file_out_that_ended_earlier_is_not_ended_twice(self):
        h = self.start()
        self.open_all(h)
        os.close(h.file_w)
        h.file_w = None
        cls, _, payload = h.read_frame()
        self.assertEqual((cls, payload[1], payload[2]), (2, FILE_OUT, 1))
        h.send(control(1, RelayTests.drain_text(None)))
        h.init_read()
        h.init_send("K", NONCE.encode())
        h.read_frame()
        h.init_send("H", NONCE.encode())
        self.assertEqual(h.read_frame()[0], 0)                        # halting follows at once: no second end frame


if __name__ == "__main__":
    unittest.main()
