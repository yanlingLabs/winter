"""Source guards for the production Cowork worker (N2 slice S3). Pure Python over the source text; nothing is compiled or run.

Run as `python3 -I Tests/test_guards.py <repository root>`.

These pin the properties no VM-free C test can reach: the ORDER of main (sandbox before the first read), the APIs the worker must
never call (no network, no fork or exec outside the sandbox probe, no alarm, no argv layout, no fixture symbol), the HARD receive
rule (recvmsg with a control buffer only), the exact entitlement set, the pinned golden vectors, and the anti-wiring pin.
"""
import hashlib
import json
import os
import plistlib
import re
import subprocess
import sys
import unittest
from pathlib import Path

REPO = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parents[4]
PACKAGE = REPO / "apple" / "Cowork" / "WinterCoworkHVFWorker"
SOURCES = PACKAGE / "Sources" / "WorkerNative"
TESTS = PACKAGE / "Tests"

# Only these paths may mention the package or the binary. S2 (launcher) and S7 (integration) will each have to extend this
# list in the commit that first wires the worker; until then nothing outside the package refers to it.
ANTI_WIRING_ALLOWED = ("apple/Cowork/WinterCoworkHVFWorker/", "docs/research/2026-10-17-cowork-n2-worker.md")
ANTI_WIRING_NEEDLES = ("WinterCoworkHVFWorker", "winter-cowork-worker", "WorkerNative", "com.winter.cowork.worker")

ALLOWED_KRUN = {
    "krun_init_log", "krun_create_ctx", "krun_set_vm_config", "krun_disable_implicit_vsock", "krun_set_env", "krun_disable_implicit_console",
    "krun_add_serial_console_default", "krun_set_kernel", "krun_start_enter",
    "krun_cowork_enable_profile_v1", "krun_cowork_create_runtime_port_v1", "krun_cowork_set_workspace_disks_v1", "krun_cowork_validate_profile_v1",
    "krun_cowork_get_flush_counters_v1", "krun_cowork_set_exit_hook_v1",
}
# S4's pre-v1 names and the contract's earlier mux-stream name: the archive exports none of them any more, so no source may call them.
OLD_NAMES = ("krun_cowork_enable_production_profile", "krun_cowork_set_workspace_disks", "krun_cowork_create_runtime_port", "krun_cowork_validate_production_profile",
             "krun_cowork_create_mux_stream_v1")
# COWORK_LIBKRUN_FORBIDDEN_SYMBOLS of the contract, and the fixture entry points that have no production equivalent.
FORBIDDEN_KRUN = ("krun_get_shutdown_eventfd", "krun_add_vsock", "krun_add_vsock_port", "krun_add_vsock_port2", "krun_add_virtiofs", "krun_add_virtiofs2", "krun_add_virtiofs3",
                  "krun_add_virtiofs4", "krun_set_port_map", "krun_set_gpu_options", "krun_set_gpu_options2", "krun_add_display", "krun_add_input_device", "krun_add_input_device_fd",
                  "krun_enable_cowork_block_fixture_reclaim", "krun_create_cowork_runtime_stream", "krun_set_cowork_workspace_disks", "krun_enable_cowork_runtime_port_fixture_trace",
                  "krun_create_cowork_bootstrap_stream", "krun_set_cowork_bootstrap_stream", "krun_enable_cowork_fixture_reclaim", "krun_add_net", "krun_set_passt_fd", "krun_set_gvproxy_path")


def strip_c(text: str) -> str:
    """Remove comments, keep string and character literals."""
    out, i, n = [], 0, len(text)
    while i < n:
        c = text[i]
        if c == '"' or c == "'":
            j = i + 1
            while j < n and text[j] != c:
                j += 2 if text[j] == "\\" else 1
            out.append(text[i:j + 1])
            i = j + 1
        elif text.startswith("/*", i):
            j = text.find("*/", i + 2)
            i = n if j < 0 else j + 2
            out.append(" ")
        elif text.startswith("//", i):
            j = text.find("\n", i)
            i = n if j < 0 else j
        else:
            out.append(c)
            i += 1
    return "".join(out)


def code(path: Path) -> str:
    return strip_c(path.read_text())


def function_body(text: str, signature: str) -> str:
    start = text.index(signature)
    brace = text.index("{", start)
    depth = 0
    for i in range(brace, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[brace:i + 1]
    raise AssertionError(f"unbalanced braces after {signature}")


def source_files():
    return sorted(SOURCES.glob("*.[ch]"))


def repo_files():
    if (REPO / ".git").exists():
        names = subprocess.run(["/usr/bin/git", "-C", str(REPO), "ls-files", "-z", "--cached", "--others", "--exclude-standard"], capture_output=True, check=True).stdout.split(b"\0")
        return [REPO / name.decode() for name in names if name]
    return [Path(root) / name for root, dirs, files in os.walk(REPO) if ".git" not in Path(root).parts for name in files]


class MainOrder(unittest.TestCase):
    def test_the_sandbox_is_installed_before_the_first_read(self):
        main = function_body(code(SOURCES / "WorkspaceWorker.c"), "int main(int argc")
        self.assertLess(main.index("cw_intake_run("), main.index("configure_vm("), "intake must precede the VM")
        self.assertLess(main.index("cw_prepare_descriptors("), main.index("resolve_artifacts("), "stray descriptors are closed before anything else is done")
        self.assertLess(main.index("resolve_artifacts("), main.index("cw_intake_run("), "artifact paths are resolved before the sandbox: they cannot be after it")
        step = function_body(code(SOURCES / "WorkspaceWorker.c"), "static int install_sandbox_step")
        self.assertLess(step.index("cw_sandbox_install("), step.index("cw_sandbox_probe("))
        self.assertLess(step.index("cw_sandbox_probe("), step.index("CW_STATUS_SANDBOXED"), "'sandboxed' is reported only after the sandbox and its probes")

    def test_a_launcher_that_is_already_gone_ends_the_worker_before_anything_is_held(self):
        main = function_body(code(SOURCES / "WorkspaceWorker.c"), "int main(int argc")
        self.assertIn("const pid_t launcher_pid = getppid();", main)
        self.assertRegex(main, r"if \(launcher_pid == 1\) \{[^}]*return CW_EXIT_OK;")
        self.assertLess(main.index("launcher_pid == 1"), main.index("cw_intake_run("))
        self.assertLess(main.index("launcher_pid == 1"), main.index("resolve_artifacts("))
        self.assertIn("launcher_pid, &env)", main, "the same pid reaches the relay's watchdog")

    def test_the_stop_timeline_and_the_round_3_statuses(self):
        stop = (SOURCES / "OwnedStop.h").read_text()
        self.assertRegex(stop, r"#define CW_STOP_GRACE_MS 0u\b", "layer G: the worker exits 75 at the DRAIN's own budget")
        self.assertIn("now_ms + budget_ms + CW_STOP_GRACE_MS", code(SOURCES / "OwnedStop.c"))
        envelope = (SOURCES / "Envelope.h").read_text()
        self.assertRegex(envelope, r"CW_STATUS_HALTING = 9\b")
        self.assertRegex(envelope, r"CW_STATUS_GUEST_FAULT = 10\b")
        self.assertIn("s->state > CW_STATUS_GUEST_FAULT", code(SOURCES / "Envelope.c"))
        owned = code(SOURCES / "OwnedStop.c")
        halting = function_body(owned, "cw_stop_guest_control")
        self.assertLess(halting.index("case CW_CTL_HALTING:"), halting.index("guest_faulted) return CW_STOP_VIOLATION"), "halting after a fault is refused")
        relay = code(SOURCES / "Relay.c")
        exit_body = function_body(relay, "void cw_relay_vmm_exit(")
        self.assertNotIn("cw_l2_send_fault", exit_body, "a withheld guest_halted is `exiting` alone, never a fault")
        self.assertEqual(exit_body.count("CW_STATUS_EXITING"), 1)
        self.assertNotIn("cw_l2_send_status(", exit_body, "the hook must not block: one non-blocking attempt per status, no retry loop")
        self.assertIn("pthread_mutex_trylock(&r->lock)", exit_body)
        self.assertNotRegex(exit_body, r"pthread_mutex_lock\(")
        self.assertIn("report->completed[disk] != report->requested[disk]", relay, "completed above requested is withheld too")
        halted_gate = function_body(relay, "bool cw_exit_report_halted(")
        self.assertIn("report->guest_faulted || report->mux_quarantined", halted_gate, "an accepted fault or a quarantine withholds guest_halted")
        self.assertIn("atomic_load(&r->guest_fault_seen)", exit_body)
        self.assertIn("atomic_load(&r->quarantine_seen)", exit_body)
        self.assertIn("atomic_store(&r->guest_fault_seen, true)", function_body(relay, "static void apply(cw_relay *r, cw_stop_action action, uint64_t now) {"))
        self.assertIn("atomic_store(&r->quarantine_seen, true)", function_body(relay, "static void violation("))
        self.assertLess(function_body(relay, "static void violation(").index("atomic_store"), function_body(relay, "static void violation(").index("cw_l2_send_fault"), "the flag is set before the status is attempted")
        self.assertIn("CW_STATUS_HALTING", function_body(relay, "static void apply(cw_relay *r, cw_stop_action action, uint64_t now) {"))
        self.assertIn("CW_STATUS_GUEST_FAULT", function_body(relay, "static void apply(cw_relay *r, cw_stop_action action, uint64_t now) {"))
        mux = code(SOURCES / "Mux.c")
        self.assertIn('IS_TYPE("fault")', mux)
        self.assertRegex(mux, r'direction == CW_MUX_UP && IS_TYPE\("fault"\)', "fault travels up only")

    def test_the_flush_counters_are_asked_for_with_their_size(self):
        abi = code(SOURCES / "CoworkAbi.h")
        reader = function_body(abi, "static inline int32_t cw_read_flush_counters(")
        self.assertLess(reader.index("memset(out, 0, sizeof *out);"), reader.index("out->size = (uint32_t)sizeof *out;"))
        self.assertLess(reader.index("out->size ="), reader.index("krun_cowork_get_flush_counters_v1(out)"))

    def test_intake_installs_the_sandbox_before_it_reads(self):
        body = function_body(code(SOURCES / "AdmittedVolumes.c"), "void cw_intake_run(")
        self.assertLess(body.index("config->install_sandbox("), body.index("next_datagram("), "the sandbox hook must precede the first receive")
        self.assertEqual(body.count("config->install_sandbox("), 1)
        self.assertFalse("cw_env_recv(" in body, "intake receives only through next_datagram")

    def test_only_intake_and_the_relay_receive_envelopes(self):
        for path in source_files():
            if path.suffix != ".c":
                continue
            text = code(path)
            if path.name not in ("AdmittedVolumes.c", "Relay.c", "Envelope.c"):
                self.assertFalse("cw_env_recv(" in text, f"{path.name} must not read L2")
        self.assertNotIn("cw_env_recv(", code(SOURCES / "WorkspaceWorker.c"))

    def test_the_vm_is_configured_after_the_volumes_and_the_relay_starts_before_krun_start_enter(self):
        main = function_body(code(SOURCES / "WorkspaceWorker.c"), "int main(int argc")
        self.assertLess(main.index("configure_vm("), main.index("cw_relay_init("))
        self.assertLess(main.index("cw_relay_init("), main.index("pthread_create(&pump"))
        self.assertLess(main.index("pthread_create(&pump"), main.index("krun_start_enter("), "everything that must keep running starts before krun_start_enter, which never returns")
        self.assertLess(main.index("cw_relay_vm_started("), main.index("pthread_create(&pump"))
        self.assertEqual(code(SOURCES / "WorkspaceWorker.c").count("krun_start_enter("), 1)

    def test_check_mode_creates_no_libkrun_context(self):
        main = function_body(code(SOURCES / "WorkspaceWorker.c"), "int main(int argc")
        check = main[main.index("if (check_only) {"):main.index("pthread_t console;")]
        self.assertFalse("krun_" in check)
        self.assertFalse("configure_vm" in check)
        self.assertIn("worker_exit(CW_EXIT_OK)", check)
        self.assertLess(main.index("if (check_only) {"), main.index("configure_vm("), "--sandbox-check leaves before any libkrun call")


class ForbiddenApis(unittest.TestCase):
    def test_no_alarm_no_argv_layout_no_environment_no_fixture(self):
        for path in source_files():
            text = code(path)
            self.assertNotRegex(text, r"\balarm\s*\(", f"{path.name}: the fixture's alarm(120) must stay removed")
            for needle in ("getenv(", "setenv(", "putenv(", "system(", "popen(", "posix_spawn", "dlopen(", "dlsym(", "NSBundle", "generic_sampler", "sampler"):
                self.assertFalse(needle in text, f"{path.name}: {needle}")
            if path.name != "Sandbox.c": # the denial probe is the one place a process image is ever asked for
                self.assertIsNone(re.search(r"\bexec[lv]\w*\s*\(", text), f"{path.name}: exec")
            self.assertIsNone(re.search(r"\benviron\b", text), f"{path.name}: environ (the worker takes nothing from its environment)")
            self.assertNotRegex(text, r"(?i)fixture", f"{path.name}: no fixture opt-in, trace or name in code")
        worker = code(SOURCES / "WorkspaceWorker.c")
        self.assertEqual(sorted(set(re.findall(r"argv\[\d+\]", worker))), ["argv[1]"], "the only argv use is the --sandbox-check mode switch")
        self.assertIn('strcmp(argv[1], "--sandbox-check")', worker)
        self.assertTrue("argc != 1" in worker, "no argument layout: anything but the one flag is refused")

    def test_no_baked_in_fixture_limits(self):
        worker = code(SOURCES / "WorkspaceWorker.c")
        self.assertNotRegex(worker, r"\b768\b", "the 2 vCPU / 768 MiB fixture constants came from the SCOPE envelope, not the source")
        self.assertNotRegex(worker, r"krun_set_vm_config\([^;]*\b2\s*,", "vCPUs come from SCOPE")
        self.assertTrue("intake->scope.vcpus" in worker)
        self.assertTrue("intake->scope.memory_mib" in worker)
        self.assertTrue("CW_GATE_VCPUS" in worker)

    def test_process_creation_and_network_exist_only_in_the_sandbox_probe(self):
        for path in source_files():
            if path.suffix != ".c" or path.name == "Sandbox.c":
                continue
            text = code(path)
            for call in ("fork", "execve", "socket", "connect", "bind", "listen", "accept", "sendto", "getaddrinfo", "gethostbyname"):
                self.assertIsNone(re.search(rf"(?<![A-Za-z0-9_]){call}\s*\(", text), f"{path.name}: {call}()")
            self.assertFalse("AF_INET" in text, f"{path.name}: AF_INET")
        # socketpair and getsockopt on inherited descriptors are allowed; opening a socket is not.
        self.assertTrue("fork()" in code(SOURCES / "Sandbox.c"))

    def test_libkrun_references_are_the_reviewed_inventory(self):
        not_functions = {"krun_check", "krun_cowork_volume_identity", "krun_cowork_volume_identity_v1", "krun_cowork_flush_counters_v1", "krun_cowork_exit_hook_v1",
                         "krun_cowork_flush_device_v1"}
        for path in source_files():
            text = code(path)
            for name in FORBIDDEN_KRUN:
                self.assertNotRegex(text, rf"\b{name}\b", f"{path.name}: {name} is not admitted")
            used = set(re.findall(r"\bkrun_[a-z0-9_]+\b", text)) - not_functions
            self.assertLessEqual(used, ALLOWED_KRUN, f"{path.name}: {sorted(used - ALLOWED_KRUN)}")
            for name in OLD_NAMES:
                self.assertIsNone(re.search(rf"\b{name}\b", text), f"{path.name}: {name} is not exported by the pinned archive")
            self.assertNotRegex(text, r"\bkrun_cowork_get_pin_counters_v1\b", f"{path.name}: the pin counters are read by gate G4, never by the worker")

    def test_the_vm_start_order_and_the_mandatory_preflight(self):
        worker = code(SOURCES / "WorkspaceWorker.c")
        configure = function_body(worker, "static int configure_vm(")
        order = ["krun_create_ctx(", "krun_cowork_enable_profile_v1(", "krun_cowork_create_runtime_port_v1(", "krun_cowork_set_workspace_disks_v1(",
                 "krun_cowork_set_exit_hook_v1(", "krun_cowork_validate_profile_v1("]
        positions = [configure.index(name) for name in order]
        self.assertEqual(positions, sorted(positions), "port before disks, exit hook before the preflight, preflight last")
        self.assertRegex(configure, r"krun_check\(krun_cowork_validate_profile_v1\(")
        self.assertRegex(configure, r"krun_check\(krun_cowork_set_exit_hook_v1\(")
        self.assertLess(configure.index("krun_cowork_validate_profile_v1("), configure.index("return 0;", configure.index("krun_cowork_validate_profile_v1(")))
        self.assertNotIn("krun_start_enter", configure)
        abi = code(SOURCES / "CoworkAbi.h")
        self.assertRegex(abi, r"#define CW_ABI_FLUSH_EVIDENCE 1\b")
        self.assertIn("CW_ASSERT_EXIT_HOOK_SIGNATURE(exit_hook)", worker)
        self.assertIn("_Generic(&(function), krun_cowork_exit_hook_v1: 1, default: 0)", abi)
        self.assertNotIn("ENOSYS", abi + worker, "no stand-in for a missing symbol: the archive has them all")
        self.assertFalse("atexit" in abi + worker)

    def test_the_hard_receive_rule(self):
        for path in source_files():
            if path.suffix != ".c":
                continue
            text = code(path)
            regular_file = path.name == "RuntimeImage.c" # hashes two O_NOFOLLOW regular-file descriptors; it never touches a socket
            for needle in (r"\brecv\s*\(", r"\brecvfrom\s*\(", r"\breadv\s*\(") + (() if regular_file else (r"\bpread\s*\(",)):
                self.assertNotRegex(text, needle, f"{path.name}: sockets are read with recvmsg and a control buffer only")
            if path.name not in ("WorkspaceWorker.c", "RuntimeImage.c"):
                self.assertNotRegex(text, r"\bread\s*\(", f"{path.name}: plain read() installs rights on macOS")
        worker = code(SOURCES / "WorkspaceWorker.c")
        self.assertEqual(re.findall(r"\bread\s*\(([^,]*),", worker), ["source[i]"], "the only plain read() is the console PIPE pair")
        for name in ("Envelope.c", "Mux.c"):
            text = code(SOURCES / name)
            self.assertEqual(len(re.findall(r"\brecvmsg\s*\(", text)), len(re.findall(r"MSG_CTRUNC", text)), f"{name}: every recvmsg judges MSG_CTRUNC")
            self.assertTrue("msg_control" in text)
        for name in ("Relay.c", "AdmittedVolumes.c", "ConsoleRing.c", "OwnedStop.c", "Sandbox.c", "WorkspaceWorker.c"):
            self.assertFalse("recvmsg" in code(SOURCES / name), f"{name} reads through Envelope.c or Mux.c only")

    def test_silent_exit_is_79(self):
        common = (SOURCES / "WorkerCommon.h").read_text()
        self.assertRegex(common, r"#define CW_EXIT_RIGHTS 79\b")
        volumes = code(SOURCES / "AdmittedVolumes.c")
        self.assertTrue("CW_EXIT_RIGHTS" in volumes)
        self.assertTrue("CW_RECV_CTRUNC" in volumes)
        self.assertTrue("CW_EXIT_RIGHTS" in code(SOURCES / "Relay.c"))

    def test_the_lock_is_flock_and_never_release_evidence(self):
        text = code(SOURCES / "AdmittedVolumes.c")
        self.assertIn("flock(fd, LOCK_EX | LOCK_NB)", text)
        self.assertFalse("F_SETLK" in text, "a POSIX lock is dropped by any close in the process")
        for path in source_files():
            self.assertNotRegex(code(path), r"\b(release|released)\w*\s*=", f"{path.name}")

    def test_the_status_never_claims_more_than_it_saw(self):
        relay = code(SOURCES / "Relay.c")
        self.assertEqual(relay.count("CW_STATUS_DRAIN_ACKED"), 1)
        self.assertTrue("CW_STOP_REPORT_ACKED" in relay)
        self.assertEqual(relay.count("CW_STATUS_GUEST_HALTED"), 1)
        # guest_halted comes from the exit hook only
        self.assertTrue("cw_relay_vmm_exit(" in code(SOURCES / "WorkspaceWorker.c"))
        self.assertEqual(code(SOURCES / "WorkspaceWorker.c").count("cw_relay_vmm_exit("), 1)
        self.assertEqual(relay.count("cw_exit_report_halted("), 2, "the definition and the one use in cw_relay_vmm_exit")
        # only the library's OFF may be "off"
        abi = code(SOURCES / "CoworkAbi.h")
        self.assertIn("out->reason_off = reason == (uint32_t)KRUN_COWORK_EXIT_OFF;", abi)


class Package(unittest.TestCase):
    def test_entitlements_are_exactly_the_hypervisor(self):
        self.assertEqual(plistlib.loads((PACKAGE / "worker.entitlements").read_bytes()), {"com.apple.security.hypervisor": True})

    def test_the_fixtures_are_the_pinned_s1_vectors(self):
        pins = json.loads((TESTS / "fixtures" / "PINS.json").read_text())
        self.assertEqual(sorted(pins["files"]), ["bootstrap-order.json", "envelopes.json", "guest-stop.json", "launcher-lines.json", "mux-frames.json", "runtime-flow.json", "runtime-image.json", "stop-receipts.json"])
        self.assertEqual(pins["source"]["head"], "6c1f04e807df3a10579d6f14a15e39652bd1c7a6")
        for name, expected in pins["files"].items():
            self.assertEqual(hashlib.sha256((TESTS / "fixtures" / name).read_bytes()).hexdigest(), expected, name)
        self.assertEqual(pins["source"]["lastCommitTouchingTheseFiles"], pins["source"]["head"])
        self.assertEqual(len(pins["relayBlind"]["vectors"]), len(set(pins["relayBlind"]["vectors"])))
        self.assertEqual(len(pins["relayBlind"]["vectors"]), 84)
        self.assertFalse([name for name in pins["relayBlind"]["vectors"] if name.startswith("control-")], "control frames are the worker's own: none of them is passed through")

    def test_every_test_source_is_run_and_none_touches_the_sandbox_or_a_vm(self):
        build = (PACKAGE / "build.py").read_text()
        run = {re.sub(r"_(256|16)$", "", name) for name in re.findall(r'\("(test_[a-z_0-9]+)",', build)}
        self.assertEqual(run, {p.stem for p in TESTS.glob("test_*.c")}, "build.py runs exactly the C tests that exist")
        for path in TESTS.glob("test_*.c"):
            text = code(path)
            self.assertIsNone(re.search(r"\bkrun_\w+\s*\(", text), f"{path.name}: no libkrun call (types and constants of the header are fine)")
            for needle in ("hv_vm", "hv_vcpu", "Hypervisor", "cw_sandbox_install", "cw_sandbox_probe", "execv", "posix_spawn", "system(", "popen(", "dlopen("):
                self.assertFalse(needle in text, f"{path.name}: {needle}")
            if path.name != "test_sandbox_profile.c":
                self.assertFalse("sandbox_init" in text, f"{path.name}")
        profile = code(TESTS / "test_sandbox_profile.c")
        self.assertEqual(profile.count("_exit(99)"), 3, "the profile test replaces all three SPI entry points with poisoned stubs")
    def test_the_build_is_offline_and_isolated(self):
        build = (PACKAGE / "build.py").read_text()
        for needle in ("import urllib", "import socket", "http.client", "import requests", "import ssl", "pip install", "curl ", "wget ", "git clone", "cargo build", "npm install"):
            self.assertNotIn(needle, build, needle)
        for needle in ('"-Werror"', "-ffile-prefix-map", '"-Wl,-dead_strip"', "/usr/bin/strip", "--out must be outside the repository", '"-I", TESTS / "gen_vectors.py"'.replace('"-I", ', "")):
            self.assertIn(needle, build, needle)
        self.assertEqual(build.count('"--sign"'), 1)
        self.assertIn('"--sign", "-"', build, "ad-hoc signing only")
        for needle in ("/usr/bin/security", "stapler", "notarytool", "altool", "Developer ID Application", "find-identity"):
            self.assertNotIn(needle, build, needle)
        self.assertIn('sys.executable, "-I"', build, "child Python runs isolated")

    def test_no_personal_paths_or_names_in_the_package(self):
        document = REPO / "docs" / "research" / "2026-10-17-cowork-n2-worker.md"
        for path in list(PACKAGE.rglob("*")) + ([document] if document.exists() else []):
            if path.is_file() and path.suffix in (".c", ".h", ".py", ".json", ".md", ".entitlements"):
                text = path.read_text()
                for needle in ("/Us" + "ers/", "/ho" + "me/", "@" + "gmail", "kar" + "im", "Kar" + "im", "Nor" + "ma" + " v2"):
                    self.assertFalse(needle in text, f"{path.relative_to(REPO)}: {needle}")


class AntiWiring(unittest.TestCase):
    def test_nothing_outside_the_package_refers_to_it(self):
        offenders = []
        for path in repo_files():
            relative = path.relative_to(REPO).as_posix()
            if relative.startswith(ANTI_WIRING_ALLOWED) or not path.is_file():
                continue
            try:
                text = path.read_text()
            except (UnicodeDecodeError, OSError):
                continue
            offenders += [f"{relative}: {needle}" for needle in ANTI_WIRING_NEEDLES if needle in text]
        self.assertEqual(offenders, [], "the worker is unwired: no source, script, project file or workflow outside the package may name it")

    def test_the_worker_package_imports_nothing_from_the_daemon_or_the_launcher(self):
        for path in source_files():
            for include in re.findall(r'#include\s+"([^"]+)"', path.read_text()):
                self.assertTrue((SOURCES / include).exists() or include == "libkrun.h" or include == "vectors.h", f"{path.name}: {include}")


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0]], verbosity=1)
