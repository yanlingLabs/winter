"""Static properties of the guest sources that the design depends on. Reads files only."""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPO = ROOT.parents[2]
# The four sources of the separate stand-in PID 1 are held to their own rules in test_standin_hygiene.py (they use an AF_UNIX socket by design and nothing else of the network).
STANDIN_C = {"standin.c", "standin.h", "standin_linux.c", "standin_linux.h"}
C_FILES = sorted(p for d in ("common", "init", "relay") for p in (ROOT / d).glob("*.[ch]") if p.name not in STANDIN_C)
ALL_TEXT = [p for p in ROOT.rglob("*") if p.is_file() and p.suffix in {".c", ".h", ".py", ".json", ".md"}] + \
           [p for p in (REPO / "scripts/cowork-guest-artifact").rglob("*") if p.is_file() and p.suffix in {".py", ".json", ".md", ".config"} and "debian-" not in p.name]


def strip_comments(text):
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return re.sub(r"//[^\n]*", "", text)


class GuestSourceHygiene(unittest.TestCase):
    def test_there_is_no_network_bring_up_of_any_kind(self):
        needles = ("AF_INET", "AF_VSOCK", "AF_NETLINK", "AF_PACKET", "socket(", "SIOCSIF", "SIOCGIF", "netlink", "<netinet", "<linux/if", "<net/if", "IFF_UP", "dhcp", "resolv")
        for path in C_FILES:
            if path.parent.name == "tests":
                continue
            code = strip_comments(path.read_text())
            for needle in needles:
                self.assertNotIn(needle, code, f"{path.name}: {needle}")

    def test_no_shell_no_path_search_no_system(self):
        for path in C_FILES:
            code = strip_comments(path.read_text())
            for needle in ("system(", "popen(", "execvp(", "execlp(", "execv(", "execl(", "/bin/sh", "/bin/bash", "getenv(", "setenv(", "putenv("):
                self.assertNotIn(needle, code, f"{path.name}: {needle}")
        # every exec in PID 1 goes through the one function that passes the fixed environment
        init = strip_comments((ROOT / "init/init_linux.c").read_text())
        self.assertEqual(len(re.findall(r"\bexecve\(", init)), 1)
        self.assertIn("execve(argv[0], argv, CHILD_ENV)", init)

    def test_the_bootstrap_helper_never_shells_out_or_evaluates(self):
        text = (ROOT / "bootstrap/guest_bootstrap.py").read_text()
        for needle in ("shell=True", "os.system", "os.popen", "eval(", "exec(", "import ctypes", "import socket", "pickle", "marshal", "__import__"):
            self.assertNotIn(needle, text, needle)

    def test_blkid_is_not_invoked_or_required(self):
        text = (ROOT / "bootstrap/guest_bootstrap.py").read_text()
        self.assertIsNone(re.search(r"""run\(\s*["']blkid""", text))
        self.assertIsNone(re.search(r"""tool_path\(\s*["']blkid""", text))
        self.assertIn('"dumpe2fs"', text)

    def test_the_only_programs_the_helper_runs_are_the_three_e2fsprogs_tools(self):
        text = (ROOT / "bootstrap/guest_bootstrap.py").read_text()
        invoked = set(re.findall(r"""(?:tools|self\.tools)\.run\(\s*["']([a-z0-9]+)["']""", text))
        self.assertEqual(invoked, {"dumpe2fs", "e2fsck", "mke2fs"})

    def test_no_machine_specific_path_name_or_address_in_anything_public(self):
        # (assembled from pieces so that this file does not match its own check)
        parts = ["/Us" + "ers/", "/ho" + "me/[a-z]", "C:\\\\Us" + "ers", "@gm" + "ail", "@users\\.nore" + "ply", "kar" + "im", "Co-Auth" + "ored-By", "claude\\.ai" + "/code"]
        pattern = re.compile("|".join(parts), re.I)
        for path in ALL_TEXT:
            text = path.read_text(errors="replace")
            match = pattern.search(text)
            self.assertIsNone(match, f"{path.relative_to(REPO)}: {match.group(0) if match else ''}")

    def test_pid_1_logs_only_fixed_codes(self):
        code = strip_comments((ROOT / "init/init_linux.c").read_text())
        # log_code() is the single console writer and it writes a fixed prefix plus a sanitised code; nothing formats to a descriptor
        self.assertEqual(len(re.findall(r"write\(fd, line", code)), 1)
        for needle in ("fprintf(", "dprintf(", "puts(", "perror(", "printf(\""):
            self.assertNotIn(needle, code.replace("snprintf(", ""), needle)
        # codes passed to log_code are string literals or built from fixed prefixes plus the two expected serial-free reasons
        for call in re.findall(r"log_code\(([^;]*)\);", code):
            self.assertTrue(call.startswith('"') or re.fullmatch(r"code|line", call.strip()), call)

    def test_the_relay_ignores_sigpipe_and_checks_its_port_is_a_character_device(self):
        code = strip_comments((ROOT / "relay/relay.c").read_text())
        self.assertIn("signal(SIGPIPE, SIG_IGN)", code)
        self.assertIn("S_ISCHR", code)
        self.assertIn("#ifdef WG_TEST_PORT_SOCKET", code)

    def test_the_virtio_port_is_opened_exactly_once_and_only_by_pid_1(self):
        init = strip_comments((ROOT / "init/init_linux.c").read_text())
        relay = strip_comments((ROOT / "relay/relay.c").read_text())
        self.assertEqual(len(re.findall(r"open\(G\.port\.node", init)), 1)
        self.assertNotIn("open(", relay)   # the relay is handed its descriptors and opens no path at all
        # PID 1 closes its copy right after starting the relay
        self.assertLess(init.index("spawn_relay(port_fd"), init.index("close(port_fd)"))

    def test_no_bootstrap_payload_is_parsed_in_c_beyond_the_control_class(self):
        for path in C_FILES:
            code = strip_comments(path.read_text())
            self.assertNotIn("\"plan\"", code, path.name)
            self.assertNotIn("operationId", code, path.name)

    def test_the_supervisor_command_line_is_the_sdks_exact_form(self):
        init = strip_comments((ROOT / "init/init_linux.c").read_text())
        self.assertIn('"--trusted-config-fd", "3", "--runtime-ports-fds", "4,5,6", NULL', init)
        self.assertIn('"--trusted-config-fd", "3", NULL', init)
        self.assertIn("exec_child(sources, with_ports ? 4 : 1, stdin_pipe[0], stdout_pipe[1], with_ports ? with : without)", init)
        self.assertNotIn("conversations.json", init)
        self.assertNotIn("WG_ENVIRONMENT_PATH", init)

    def test_the_test_path_overrides_exist_only_for_the_native_test_build(self):
        init = (ROOT / "init/init_linux.c").read_text()
        for name, value in (("PYTHON_PATH", "/usr/bin/python3"), ("SUPERVISOR_PATH", "/opt/winter/libexec/linux-supervisor.py"), ("TRUSTED_DIR", "/run/winter/trusted")):
            self.assertIn(f'#ifndef {name}\n#define {name} "{value}"\n#endif', init)
        build = (ROOT / "build.py").read_text()
        self.assertNotRegex(build, r"-D\s*(PYTHON_PATH|SUPERVISOR_PATH|TRUSTED_DIR)")
        self.assertNotIn("sys_calls.", (ROOT / "relay/relay.c").read_text())

    def test_only_the_host_query_profile_has_runtime_artifacts_in_this_image(self):
        init = strip_comments((ROOT / "init/init_linux.c").read_text())
        body = init[init.index("static int op_read_runtime_artifacts"):]
        body = body[:body.index("\n}\n")]
        self.assertLess(body.index("if (profile != 1) return -1;"), body.index("wg_read_small_file(RUNTIME_ARTIFACTS_PATH"))
        self.assertEqual(init.count("RUNTIME_ARTIFACTS_PATH"), 2)   # its definition and the one read

    def test_no_production_source_has_a_writable_test_seam(self):
        """The seams in trusted_config.c exist only under WG_TEST_SEAMS (which only the native test build defines), as statics behind one setter; PID 1
        and the relay never reach them, and init_linux.c's sys_calls table is only ever read there."""
        import re as regex
        self.assertNotIn("WG_TEST_SEAMS", (ROOT / "build.py").read_text())
        for path in C_FILES:
            code = strip_comments(path.read_text())
            self.assertNotRegex(code, r"\bextern\s+[^;]*\(\*\s*\w+\)", path.name)                # no exported function-pointer variable
            if path.name not in ("trusted_config.c", "trusted_config.h"):
                self.assertNotIn("WG_TEST_SEAMS", code, path.name)
                self.assertNotIn("wg_trusted_config_test_seams", code, path.name)
        source = strip_comments((ROOT / "init/trusted_config.c").read_text())
        production = regex.sub(r"#ifdef WG_TEST_SEAMS.*?#else", "#else", source, flags=regex.S)
        self.assertNotIn("seam_", production)
        self.assertIn("#define SYNC_CONFIG(fd) fsync(fd)", production)
        self.assertIn("#define AFTER_CLOSE(path) ((void)0)", production)
        self.assertEqual(len(regex.findall(r"\bstatic\b[^;]*\bseam_\w+", source)), 2)
        header = strip_comments((ROOT / "init/trusted_config.h").read_text())
        self.assertRegex(header, r"#ifdef WG_TEST_SEAMS\s+void wg_trusted_config_test_seams\(.*\);\s+#endif")
        init = strip_comments((ROOT / "init/init_linux.c").read_text())
        self.assertIsNone(regex.search(r"sys_calls\.\w+\s*=[^=]", init))                              # only read, never assigned, in PID 1
        self.assertEqual(len(regex.findall(r"static struct \{[^}]*\} sys_calls", init, flags=regex.S)), 1)

    def test_the_guided_reader_block_has_no_source_in_this_image(self):
        """Guided stays off in the first session (decision D10). PID 1 can write the `reader` block and the guidanceDirectory (trusted_config.c, boot.c) only for
        a guided set AND a guided artifacts object; nothing in the image carries that object: PID 1 reads no file for profile 2, image.py writes no `reader`, and
        the one runtime artifacts file the image holds is checked to be exactly launcher, executable, ownerLibrary."""
        init = strip_comments((ROOT / "init/init_linux.c").read_text())
        body = init[init.index("static int op_read_runtime_artifacts"):]
        body = body[:body.index("\n}\n")]
        self.assertIn("if (profile != 1) return -1;", body)
        self.assertNotIn("guided", init.lower().replace("guided profile", ""))
        image = (REPO / "scripts/cowork-guest-artifact/image.py").read_text()
        for needle in ("'reader'", '"reader"', "hostQueryGuidedRuntime", "guidanceDirectory", "instruction-reader"):
            self.assertNotIn(needle, image, needle)
        verify = (REPO / "scripts/cowork-guest-artifact/verify.py").read_text()
        self.assertIn("set(config['artifacts'])!=set(RUNTIME_ARTIFACT_PATHS)", verify)
        self.assertIn("set(config)!={'artifacts'}", verify)

    def test_the_supervisor_ready_line_is_compared_by_length_and_bytes(self):
        init = strip_comments((ROOT / "init/init_linux.c").read_text())
        self.assertNotIn("strcmp(G.ready_line", init)
        self.assertIn("G.ready_have != sizeof SUPERVISOR_READY_LINE - 1", init)
        self.assertIn("memcmp(G.ready_line, SUPERVISOR_READY_LINE, G.ready_have)", init)
        self.assertIn('#define SUPERVISOR_READY_LINE "{\\"fullGuestExecutionEnabled\\":false,\\"ready\\":true}"', init)


if __name__ == "__main__":
    unittest.main()
