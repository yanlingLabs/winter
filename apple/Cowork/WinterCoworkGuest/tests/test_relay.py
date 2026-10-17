"""Behavioural tests of the relay process, natively (macOS or Linux), no root and no VM.

The relay is built with the host compiler (sanitizers when available) and started with socketpair/pipes in place of the virtio
port and the in-guest pipes. The test plays the host on the port and PID 1 / the supervisor on the pipes. A socket stands in
for the port only in this test build (-DWG_TEST_PORT_SOCKET); the production build refuses anything but a character device,
and one test builds it that way to prove it.
"""
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
STATUS = {"malformed": 1, "oversize": 2, "version": 3, "unknown_type": 4, "bad_field": 5, "reserved_class": 6, "bad_sequence": 7}


def frame(cls, seq, payload=b"", flags=0):
    return b"WMX1" + bytes([1, cls]) + struct.pack("<HII", flags, seq, len(payload)) + payload


def control(seq, text):
    return frame(0, seq, text.encode())


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

    def __init__(self, binary, extra_fds=(), arguments=None):
        self.host, relay_port = socket.socketpair()
        init_to_relay_r, self.init_w = os.pipe()          # init -> relay
        self.init_r, relay_to_init_w = os.pipe()          # relay -> init
        self.sup_r, relay_rt_in_w = os.pipe()             # relay -> supervisor input
        relay_rt_out_r, self.sup_out_w = os.pipe()        # supervisor stdout -> relay
        relay_rt_err_r, self.sup_err_w = os.pipe()        # supervisor stderr -> relay
        fds = [relay_port.fileno(), init_to_relay_r, relay_to_init_w, relay_rt_in_w, relay_rt_out_r, relay_rt_err_r]
        names = ["--port", "--ctl-in", "--ctl-out", "--rt-in", "--rt-out", "--rt-err"]
        argv = arguments if arguments is not None else [x for pair in zip(names, map(str, fds)) for x in pair]
        self.proc = subprocess.Popen([str(binary), *argv], pass_fds=[*fds, *extra_fds], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        relay_port.close()
        for fd in (init_to_relay_r, relay_to_init_w, relay_rt_in_w, relay_rt_out_r, relay_rt_err_r):
            os.close(fd)
        for fd in (self.init_r, self.sup_r):
            os.set_blocking(fd, False)
        self.host.settimeout(5)
        self.buffers = {self.init_r: b"", self.sup_r: b""}

    def close(self):
        if self.proc.poll() is None:
            self.proc.kill()
        self.proc.wait()
        for stream in (self.proc.stdout, self.proc.stderr):
            stream.close()
        self.host.close()
        for fd in (self.init_w, self.init_r, self.sup_r, self.sup_out_w, self.sup_err_w):
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

    def open_runtime(self, harness):
        harness.init_send("G")
        time.sleep(0.1)

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

    def test_runtime_bytes_that_arrive_before_the_supervisor_exists_wait_for_it(self):
        h = self.start()
        h.send(frame(2, 1, b"early one\n"))
        h.send(frame(2, 2, b"early two\n"))
        h.send(control(1, '{"v":1,"t":"ping","n":1}'))
        self.assertEqual(h.read_frame()[0:2], (0, 1))                 # the relay is alive and answering
        ready, _, _ = select.select([h.sup_r], [], [], 0.3)
        self.assertEqual(ready, [])                                    # and nothing reached the supervisor's input yet
        self.open_runtime(h)
        self.assertEqual(h.read_supervisor_input(20), b"early one\nearly two\n")

    def test_a_flood_with_no_supervisor_ends_the_stream_at_the_bound(self):
        h = self.start()
        try:
            for seq in range(1, 8):
                h.send(frame(2, seq, b"z" * (1024 * 1024)))
        except OSError:
            pass
        self.assertEqual(h.wait_exit(), 93)

    def test_runtime_down_reaches_the_supervisor_input_and_up_is_framed(self):
        h = self.start()
        self.open_runtime(h)
        h.send(frame(2, 1, b'{"type":"user"}\n'))
        h.send(frame(2, 2, b""))
        h.send(frame(2, 3, b"second\n"))
        self.assertEqual(h.read_supervisor_input(16 + 7), b'{"type":"user"}\nsecond\n')
        os.write(h.sup_out_w, b"answer-1\n")
        cls, seq, payload = h.read_frame()
        self.assertEqual((cls, seq), (2, 1))
        self.assertEqual(payload, b"answer-1\n")

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
        got, seqs = b"", []
        while len(got) < len(blob):
            cls, seq, payload = h.read_frame()
            self.assertEqual(cls, 2)
            self.assertLessEqual(len(payload), 65536)
            seqs.append(seq)
            got += payload
        os.waitpid(writer, 0)
        self.assertEqual(got, blob)
        self.assertEqual(seqs, list(range(1, len(seqs) + 1)))

    def test_supervisor_stderr_is_drained_and_never_forwarded(self):
        h = self.start()
        self.open_runtime(h)
        os.write(h.sup_err_w, b"secret diagnostic\n" * 100)
        h.send(control(1, '{"v":1,"t":"ping","n":9}'))
        self.assertEqual(h.read_frame(), (0, 1, b'{"v":1,"t":"pong","n":9}'))

    def test_a_supervisor_that_floods_stderr_never_blocks(self):
        h = self.start()
        self.open_runtime(h)
        writer = os.fork()
        if writer == 0:
            try:
                chunk = b"e" * 65536
                for _ in range(16):          # 1 MiB into a 64 KiB pipe: blocks forever unless the relay drains it
                    os.write(h.sup_err_w, chunk)
            finally:
                os._exit(0)
        deadline = time.monotonic() + 10
        finished = False
        while time.monotonic() < deadline:
            pid, _ = os.waitpid(writer, os.WNOHANG)
            if pid:
                finished = True
                break
            time.sleep(0.05)
        if not finished:
            os.kill(writer, 9)
            os.waitpid(writer, 0)
        self.assertTrue(finished, "stderr was not drained")

    def test_runtime_frames_are_dropped_once_the_supervisor_input_is_gone(self):
        h = self.start()
        self.open_runtime(h)
        os.close(h.sup_r)
        h.sup_r = os.open(os.devnull, os.O_RDONLY)  # keep the harness cleanup valid
        h.send(frame(2, 1, b"x" * 1000))
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
        h.send(frame(2, 1, b"late input\n"))
        h.send(control(2, '{"v":1,"t":"ping","n":5}'))
        self.assertEqual(h.read_frame()[0:2], (0, 1))
        ready, _, _ = select.select([h.sup_r], [], [], 0.3)
        self.assertEqual(ready, [])

    def test_a_flood_beyond_the_bounded_queue_ends_the_stream(self):
        h = self.start()
        self.open_runtime(h)
        chunk = b"z" * (1024 * 1024)
        try:
            for seq in range(1, 8):
                h.send(frame(2, seq, chunk))
        except (BrokenPipeError, ConnectionResetError, TimeoutError, OSError):
            pass
        self.assertEqual(h.wait_exit(), 93)

    def test_go_twice_or_while_draining_is_a_state_error(self):
        h = self.start()
        h.init_send("G")
        h.init_send("G")
        self.assertEqual(h.wait_exit(), 95)
        h = self.start()
        h.send(control(1, self.drain_text()))
        h.init_read()
        h.init_send("G")
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
        for raw in (ctl("X"), struct.pack("<B3xI", ord("U"), 70000), b"U\x01\x00\x00\x00\x00\x00\x00"):
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


if __name__ == "__main__":
    unittest.main()
