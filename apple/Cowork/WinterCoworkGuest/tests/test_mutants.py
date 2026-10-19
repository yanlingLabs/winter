"""Mutation checks of the guards that the behavioural tests were written for: each mutant is a one-line change to the real source in a scratch
copy of this tree, and the test that is meant to catch it must fail on the copy. A mutant that survives means a guard lost its test.

The Linux-only mutants (init_linux.c, exercised by test_pid1_linux.py) run only where that suite runs. Two guards are deliberately absent because
they cannot change behaviour: `!S_ISDIR` on a descriptor opened with O_DIRECTORY, and `!S_ISREG` next to the size, mode and link-count checks
(a replacement would need to be a non-regular file of the same size, mode and link count; the open of a FIFO there would block, which the
function's single caller never meets because it created the file itself a moment earlier).
"""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from test_native import CC, ROOT

LINUX = sys.platform.startswith("linux")

T = "init/trusted_config.c"

# (file, old text, new text, suite) -- suite: a key of SUITES
MUTANTS = [
    ("init/init_linux.c","    int fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);","    int fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_CLOEXEC);","pid1"),
    ("init/init_linux.c","    int parent = open(parent_path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);","    int parent = open(parent_path, O_RDONLY | O_DIRECTORY | O_CLOEXEC);","pid1"),
    ("init/init_linux.c","if (rc == 0) rc = sys_calls.fchmod_fn(fd, 0700);","if (rc == 0) rc = 0;","pid1"),
    ("init/init_linux.c","int rc = sys_calls.fchown_fn(fd, uid, (gid_t)uid);","int rc = 0;","pid1"),
    ("init/init_linux.c","sys_calls.fchown_fn(fd, uid, (gid_t)uid)","sys_calls.fchown_fn(fd, uid, (gid_t)0)","pid1"),
    ("init/init_linux.c","sys_calls.fchown_fn(fd, uid, (gid_t)uid)","sys_calls.fchown_fn(fd, 0, (gid_t)uid)","pid1"),
    ("init/init_linux.c","sys_calls.fchmod_fn(fd, 0700)","sys_calls.fchmod_fn(fd, 0755)","pid1"),
    ("init/init_linux.c","mkdirat(parent, name, 0700)","mkdirat(parent, name, 0755)","pid1"),
    ("init/init_linux.c","mkdirat(parent, name, 0700)","mkdirat(parent, name, 0)","pid1"),
    ("init/init_linux.c","&& errno != EEXIST) { close(parent); return -1; }","&& 1) { close(parent); return -1; }","pid1"),
    ("init/init_linux.c","st.st_uid != uid ||","0 ||","pid1"),
    ("init/init_linux.c","(st.st_mode & 07777) != 0700)) rc = -1;","0)) rc = -1;","pid1"),
    ("init/init_linux.c","if (rc == 0 && (fstat(fd, &st) != 0 ||","if (rc == 0 && (0 ||","pid1"),
    ("init/init_linux.c","if (sys_calls.fsync_fn(fd) != 0) result = -1;","sys_calls.fsync_fn(fd);","pid1"),
    ("init/init_linux.c","if (fd < 0) { result = -1; continue; }","if (fd < 0) { continue; }","pid1"),
    ("init/init_linux.c","if (!(volumes & (1u << v))) continue;","if (0) continue;","pid1"),
    ("init/init_linux.c","open(v == WG_VOLUME_DATA ? G.data.node : G.environment.node, O_RDONLY | O_CLOEXEC)","open(v == WG_VOLUME_DATA ? G.environment.node : G.data.node, O_RDONLY | O_CLOEXEC)","pid1"),
    ("init/init_linux.c","    return flags >= 0 && fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0 ? 0 : -1;","    return 0;","pid1"),
    ("init/init_linux.c","set_nonblocking(G.rt_in_r) == 0 &&","1 &&","pid1"),
    ("init/init_linux.c","set_nonblocking(G.rt_out_w) == 0 &&","1 &&","pid1"),
    ("init/init_linux.c","set_nonblocking(G.rt_err_w) == 0 ?","1 ?","pid1"),
    ("init/init_linux.c","if (with_ports && runtime_ends_nonblocking() != 0)","if (0)","pid1"),
    ("init/init_linux.c","    release_runtime_ends();\n#ifdef WG_FILE_CHANNEL_V1","#ifdef WG_FILE_CHANNEL_V1","pid1"),
    ("init/init_linux.c","    close_fd(&G.rt_in_r);\n    close_fd(&G.rt_out_w);","    close_fd(&G.rt_out_w);","pid1"),
    ("init/init_linux.c","    close_fd(&G.rt_out_w);\n    close_fd(&G.rt_err_w);\n}","    close_fd(&G.rt_err_w);\n}","pid1"),
    ("init/init_linux.c","    close_fd(&G.rt_err_w);\n}","}","pid1"),
    ("init/init_linux.c","    umask(022); ","    ","pid1"),
    ("init/init_linux.c","    signal(SIGPIPE, SIG_DFL); ","    ","pid1"),
    ("init/init_linux.c","    sigprocmask(SIG_SETMASK, &none, NULL);","","pid1"),
    ("init/init_linux.c","        setsid();\n#ifdef WG_FILE_CHANNEL_V1","#ifdef WG_FILE_CHANNEL_V1","pid1"),
    ("init/init_linux.c","    close(config_fd);\n    close(stdin_pipe[0]);\n    close(stdout_pipe[1]);\n    release","    close(stdin_pipe[0]);\n    close(stdout_pipe[1]);\n    release","pid1"),
    ("init/trusted_config.c","if (index == count || (seen & (1u << index))) return 0;","if (index == count) return 0;","config"),
    ("init/trusted_config.c","st.st_nlink != 1 ||","0 ||","config"),
    ("init/trusted_config.c","(st.st_mode & 0777) != 0400 ||","0 ||","config"),
    ("init/trusted_config.c","|| (size_t)st.st_size != length)","|| 0)","config"),
    ("init/trusted_config.c","SYNC_CONFIG(fd) != 0","0","config"),
    ("init/trusted_config.c","SYNC_CONFIG(fd) != 0) { close(fd); unlink(path); return -1; }","SYNC_CONFIG(fd) != 0) { close(fd); return -1; }","config"),
    ("init/trusted_config.c","if (reader < 0) return -1;","if (reader < 0) return -1; if (0)","config"),
    ("relay/relay.c", "if (runtime_open && runtime_ready_framed && !out_end_sent", "if (runtime_ready_framed && !out_end_sent", "relay"),
    ("relay/relay.c", "if (runtime_open && runtime_ready_framed && !err_end_sent", "if (runtime_ready_framed && !err_end_sent", "relay"),
    ("relay/relay.c", "if (runtime_open && runtime_ready_framed && !out_end_sent", "if (runtime_open && !out_end_sent", "relay"),
    ("relay/relay.c", "if (runtime_open && runtime_ready_framed && !err_end_sent", "if (runtime_open && !err_end_sent", "relay"),
    ("relay/relay.c", 'runtime_ready\\"", 19) != NULL', 'runtime_ready\\"", 19) == NULL', "relay"),
    ("relay/relay.c", 'runtime_ready\\"", 19)', 'runtime_ready\\"", 18)', "relay"),
    # contract re-pin round: unixId 1000 to 65533, a workspaceGid that is no uid, nothing from the host before `mounted`, runtime IN flow, guided profile
    ("bootstrap/guest_bootstrap.py", "UNIX_ID_MIN, UNIX_ID_MAX = 1000, 65533", "UNIX_ID_MIN, UNIX_ID_MAX = 1000, 65535", "bootstrap"),
    ("bootstrap/guest_bootstrap.py", "UNIX_ID_MIN, UNIX_ID_MAX = 1000, 65533", "UNIX_ID_MIN, UNIX_ID_MAX = 999, 65533", "bootstrap"),
    ("bootstrap/guest_bootstrap.py", 'a["workspaceGid"] in (b["runtimeUid"], b["toolUid"])', 'a["workspaceGid"] == b["runtimeUid"]', "bootstrap"),
    ("bootstrap/guest_bootstrap.py", 'a["workspaceGid"] in (b["runtimeUid"], b["toolUid"])', 'a["workspaceGid"] == b["toolUid"]', "bootstrap"),
    ("bootstrap/guest_bootstrap.py", "        if self.channel.has_pending():", "        if False:", "bootstrap"),
    ("bootstrap/guest_bootstrap.py", "return waiting[0] > 0", "return waiting[0] >= 0", "bootstrap"),
    ("bootstrap/guest_bootstrap.py", "fcntl.ioctl(self.read_fd, termios.FIONREAD, waiting, True)", "pass", "bootstrap"),
    ("init/boot.c", "uid < WG_UNIX_ID_MIN || uid > WG_UNIX_ID_MAX", "uid < WG_UNIX_ID_MIN || uid > 65535", "cboot"),
    ("init/boot.c", "uid < WG_UNIX_ID_MIN || uid > WG_UNIX_ID_MAX", "uid < 999 || uid > WG_UNIX_ID_MAX", "cboot"),
    ("init/boot.c", "ops->read_runtime_artifacts(ops->ctx, set.profile, runtime_buffer,", "ops->read_runtime_artifacts(ops->ctx, 1, runtime_buffer,", "cboot"),
    ("init/init_linux.c", "    if (profile != 1) return -1;", "    if (profile == 0) return -1;", "hygiene"),
    ("relay/relay.c", "static uint8_t rt_in_storage[4u * 1024u * 1024u];", "static uint8_t rt_in_storage[512u * 1024u];", "flow"),
    # the guided reader block, guidanceDirectory and the exact shape of the runtime object (agent-sdk 68e57c64)
    (T, r'jp_object(&p, profile == 2 ? GUIDED : V1, profile == 2 ? 2 : 1, block_member, NULL)', r'jp_object(&p, profile == 2 ? GUIDED : V1, 1, block_member, NULL)', "config"),
    (T, r'jp_object(&p, profile == 2 ? GUIDED : V1, profile == 2 ? 2 : 1, block_member, NULL)', r'jp_object(&p, GUIDED, 2, block_member, NULL)', "config"),
    
    (T, r'if (profile != 1 && profile != 2) return 0;', r'if (profile > 2) return 0;', "config"),
    (T, r"if (jp_char(p, ']')) return 1;", r"if (jp_char(p, ']')) return 0;", "config"),
    (T, r'if (d.count >= WG_READER_DEPENDENCIES_MAX) return 0;', r'if (d.count > WG_READER_DEPENDENCIES_MAX) return 0;', "config"),
    (T, r'jp_uint(p, 65535ul, &uid) && uid >= 65534ul', r'jp_uint(p, 65535ul, &uid) && uid >= 1000ul', "config"),
    (T, r'jp_uint(p, 65535ul, &uid) && uid >= 65534ul', r'jp_uint(p, 65536ul, &uid) && uid >= 65534ul', "config"),
    (T, r'jp_uint(p, 65535ul, &uid) && uid >= 65534ul', r'jp_uint(p, 65535ul, &uid) && uid >= 65533ul', "config"),
    (T, r'has_prefix(s, n, "/lib/") || has_prefix(s, n, "/lib64/") || has_prefix(s, n, "/usr/lib/")', r'has_prefix(s, n, "/lib64/") || has_prefix(s, n, "/usr/lib/")', "config"),
    (T, r'has_prefix(s, n, "/lib/") || has_prefix(s, n, "/lib64/") || has_prefix(s, n, "/usr/lib/")', r'has_prefix(s, n, "/lib/") || has_prefix(s, n, "/usr/lib/")', "config"),
    (T, r'has_prefix(s, n, "/lib/") || has_prefix(s, n, "/lib64/") || has_prefix(s, n, "/usr/lib/")', r'has_prefix(s, n, "/lib/") || has_prefix(s, n, "/lib64/")', "config"),
    (T, r'if (n > 1024 || !(has_prefix', r'if (!(has_prefix', "config"),
    (T, r"(d->length[k] == n || (d->length[k] < n ? s[m] == '/' : d->guest[k][m] == '/'))", r"(d->length[k] == n)", "config"),
    (T, r"(d->length[k] == n || (d->length[k] < n ? s[m] == '/' : d->guest[k][m] == '/'))", r"(d->length[k] == n || (d->length[k] < n && s[m] == '/'))", "config"),
    (T, r"(d->length[k] == n || (d->length[k] < n ? s[m] == '/' : d->guest[k][m] == '/'))", r"(d->length[k] == n || (d->length[k] > n && d->guest[k][m] == '/'))", "config"),
    (T, r"(d->length[k] == n || (d->length[k] < n ? s[m] == '/' : d->guest[k][m] == '/'))", r"(d->length[k] == n || s[m] == '/')", "config"),
    (T, r"if (length == 0 || (length == 1 && s[start] == '.') || (length == 2 && s[start] == '.' && s[start + 1] == '.')) return 0;", r"if ((length == 1 && s[start] == '.') || (length == 2 && s[start] == '.' && s[start + 1] == '.')) return 0;", "config"),
    (T, r"if (length == 0 || (length == 1 && s[start] == '.') || (length == 2 && s[start] == '.' && s[start + 1] == '.')) return 0;", r"if (length == 0 || (length == 2 && s[start] == '.' && s[start + 1] == '.')) return 0;", "config"),
    (T, r"if (length == 0 || (length == 1 && s[start] == '.') || (length == 2 && s[start] == '.' && s[start + 1] == '.')) return 0;", r"if (length == 0 || (length == 1 && s[start] == '.')) return 0;", "config"),
    (T, r'if (n != 64) return 0;', r'if (n < 64) return 0;', "config"),
    (T, r'if (n != 64) return 0;', r'if (n > 64) return 0;', "config"),
    (T, r"(s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f')", r"(s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'g')", "config"),
    (T, r"(s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f')", r"(s[i] >= '0' && s[i] <= '9') || (s[i] >= 'A' && s[i] <= 'f')", "config"),
    (T, r"if (index == 0) return n <= 1024 && s[0] == '/' && path_parts_ok(s, n);", r"if (index == 0) return n <= 1024 && path_parts_ok(s, n);", "config"),
    (T, r"if (index == 0) return n <= 1024 && s[0] == '/' && path_parts_ok(s, n);", r"if (index == 0) return n <= 1025 && s[0] == '/' && path_parts_ok(s, n);", "config"),
    (T, r"if (index == 0) return n <= 1024 && s[0] == '/' && path_parts_ok(s, n);", r"if (index == 0) return s[0] == '/' && path_parts_ok(s, n);", "config"),
    (T, r"if (index == 1) return n <= 1024 && s[0] == '/' && path_parts_ok(s, n);", r"if (index == 1) return n <= 1024 && s[0] == '/';", "config"),
    (T, r"if (index == 1) return n <= 1024 && s[0] == '/' && path_parts_ok(s, n);", r"if (index == 1) return s[0] == '/' && path_parts_ok(s, n);", "config"),
    (T, r'if (index == count || (seen & (1u << index))) return 0;', r'if (index == count) return 0;', "config"),
    (T, r'if (index == count || (seen & (1u << index))) return 0;', r'if ((seen & (1u << index))) return 0;', "config"),
    (T, r"if (k > 0 && !jp_char(p, ',')) return 0;", r"if (k > 0) jp_char(p, ',');", "config"),
    (T, r"if (c < 0x21 || c == '\\') return 0;", r"if (c < 0x20 || c == '\\') return 0;", "config"),
    (T, r"if (c < 0x21 || c == '\\') return 0;", r"if (c < 0x21) return 0;", "config"),
    (T, r"p->s[p->i] < '1' || p->s[p->i] > '9') return 0;", r"p->s[p->i] < '0' || p->s[p->i] > '9') return 0;", "config"),
    (T, r"if (p->i >= p->n || p->s[p->i] < '1' || p->s[p->i] > '9') return 0;", r"if (p->i >= p->n) return 0;", "config"),
    (T, r'if (v > maximum) return 0;', r'if (v > maximum + 1) return 0;', "config"),
    (T, r'if (profile != 2) return named == 0;', r'if (profile != 2) return 1;', "config"),
    (T, r'if (named != count) return 0;', r'if (named < count) return 0;', "config"),
    (T, r'if (named != count) return 0;', r'if (named > count) return 0;', "config"),
    (T, r'return !(exact < named);', r'return !(exact <= named);', "config"),
    (T, r'return !(exact < named);', r'return !(exact > named);', "config"),
    ("init/boot.c", r'if (!wg_guidance_members_ok(set.profile, set.count, set.json, set.json_length)) { conversations_failed(boot, 1, "config-refused"); return; }', r'', "cboot"),
    ("init/boot.c", r'if (built == WG_CONFIG_RUNTIME_SHAPE) { conversations_failed(boot, 2, "runtime-artifacts-invalid"); return; }', r'', "cboot"),
    ("init/boot.c", r'if (built == WG_CONFIG_RUNTIME_SHAPE) { conversations_failed(boot, 2,', r'if (built == WG_CONFIG_RUNTIME_SHAPE) { conversations_failed(boot, 1,', "cboot"),
    ("init/boot.c", r'static char runtime_buffer[WG_CONFIG_RUNTIME_MAX + 1];', r'static char runtime_buffer[4096u + 1];', "cboot"),
    ("bootstrap/guest_bootstrap.py", r'                config["guidanceDirectory"] = GUIDANCE_DIRECTORY', r'                pass', "bootstrap"),
    ("bootstrap/guest_bootstrap.py", r'GUIDANCE_DIRECTORY = "/run/winter/shared-instructions"', r'GUIDANCE_DIRECTORY = "/run/winter/shared"', "bootstrap"),
    # ---- FC3: the guest side of the file channel (WG_FILE_CHANNEL_V1 images). The Linux-only suite (fcpid1) runs where test_pid1_linux.py does.
    ('relay/relay.c', 'if (!file_active || file_in_ended) fatal_status(WMX_BAD_FIELD);', 'if (file_in_ended) fatal_status(WMX_BAD_FIELD);', 'fcrelay'),
    ('relay/relay.c', 'if (!file_active || file_in_ended) fatal_status(WMX_BAD_FIELD);', 'if (!file_active) fatal_status(WMX_BAD_FIELD);', 'fcrelay'),
    ('relay/relay.c', '            if (prefix.end) file_in_ended = 1;\n            size_t request', '            size_t request', 'fcrelay'),
    ('relay/relay.c', '            status = wg_fileflow_request(&file_flow, rx.payload + WMX_RUNTIME_PREFIX_BYTES, request);\n            if (status != WMX_OK) fatal_status(status);\n', '', 'fcrelay'),
    ('relay/relay.c', '    close_file_in();   /* FIRST,', '    (void)0;   /* FIRST,', 'fcrelay'),
    ('relay/relay.c', 'if (tag == CTL_HALTING) finish_file_out();', 'if (0) finish_file_out();', 'fcrelay'),
    ('relay/relay.c', '    if (!file_active || !runtime_ready_framed) return;', '    if (!file_active) return;', 'fcrelay'),
    ('relay/relay.c', '    if (!file_active || !runtime_ready_framed) return;', '    if (!runtime_ready_framed) return;', 'fcrelay'),
    ('relay/relay.c', '        if (!file_out_end_sent && wg_ring_used(&out_ring) == before) break;', '        if (0) break;', 'fcrelay'),
    ('relay/relay.c', '    if (!file_out_end_sent) {\n        wmx_write_runtime_prefix(up_chunk, 0, WMX_STREAM_FILE_OUT, 1);', '    if (0) {\n        wmx_write_runtime_prefix(up_chunk, 0, WMX_STREAM_FILE_OUT, 1);', 'fcrelay'),
    ('relay/relay.c', '        if (status != WMX_OK) die(EXIT_STATE, 1, status);\n        wmx_write_runtime_prefix(up_chunk, 0, WMX_STREAM_FILE_OUT, 0);', '        wmx_write_runtime_prefix(up_chunk, 0, WMX_STREAM_FILE_OUT, 0);', 'fcrelay'),
    ('relay/relay.c', 'ctl_reader.payload[0] > 3 || runtime_open', 'ctl_reader.payload[0] > 4 || runtime_open', 'fcrelay'),
    ('relay/relay.c', 'ctl_reader.payload[0] > 3 || runtime_open', 'ctl_reader.payload[0] > 2 || runtime_open', 'fcrelay'),
    ('relay/relay.c', 'file_active = (ctl_reader.payload[0] & 2) != 0;', 'file_active = 1;', 'fcrelay'),
    ('relay/relay.c', 'file_active = (ctl_reader.payload[0] & 2) != 0;', 'file_active = (ctl_reader.payload[0] & 1) != 0;', 'fcrelay'),
    ('relay/relay.c', 'runtime_streams = ctl_reader.payload[0] & 1;', 'runtime_streams = ctl_reader.payload[0];', 'fcrelay'),
    ('relay/relay.c', 'if (runtime_open && runtime_ready_framed && file_active && !file_out_end_sent && room)', 'if (runtime_open && file_active && !file_out_end_sent && room)', 'fcrelay'),
    ('relay/relay.c', 'if (runtime_open && runtime_ready_framed && file_active && !file_out_end_sent && room)', 'if (runtime_open && runtime_ready_framed && !file_out_end_sent && room)', 'fcrelay'),
    ('relay/relay.c', 'if (file_in_ended && file_in_fd >= 0 && !wg_ring_used(&file_in_ring)) close_file_in();', 'if (file_in_ended && file_in_fd >= 0) close_file_in();', 'fcrelay'),
    ('relay/relay.c', '        file_out_end_sent = 1;\n    }\n}\n\n/* Before', '    }\n}\n\n/* Before', 'fcrelay'),
    ('relay/relay.c', '    check_descriptor(file_in_fd, 1, "file-in");\n', '', 'fcrelay'),
    ('relay/relay.c', '    check_descriptor(file_out_fd, 1, "file-out");\n', '', 'fcrelay'),
    ('relay/relay.c', '        , file_in_fd, file_out_fd\n#endif\n    };\n    for (int fd = 3;', '\n#endif\n    };\n    for (int fd = 3;', 'fcrelay'),
    ('common/wmx.c', '    if (stream >= WMX_STREAM_FILE_IN && conversation != 0) return WMX_BAD_FIELD;', '', 'fcnative'),
    ('common/wmx.c', 'const unsigned last_stream = WMX_STREAM_FILE_OUT;', 'const unsigned last_stream = WMX_STREAM_FILE_IN;', 'fcnative'),
    ('common/wmx.c', 'if ((stream == WMX_STREAM_IN || stream == WMX_STREAM_FILE_IN) != (direction == WMX_DOWN))', 'if ((stream == WMX_STREAM_IN) != (direction == WMX_DOWN))', 'fcnative'),
    ('common/fileflow.c', 'if (++flow->request_line > WG_FILE_REQUEST_BYTES) return WMX_OVERSIZE;', 'if (++flow->request_line >= WG_FILE_REQUEST_BYTES) return WMX_OVERSIZE;', 'fcnative'),
    ('common/fileflow.c', 'if (++flow->outstanding > WG_FILE_IN_FLIGHT) return WMX_OVERSIZE;', 'if (++flow->outstanding >= WG_FILE_IN_FLIGHT) return WMX_OVERSIZE;', 'fcnative'),
    ('common/fileflow.c', 'if (++flow->outstanding > WG_FILE_IN_FLIGHT) return WMX_OVERSIZE;\n            flow->request_line = 0;', 'if (++flow->outstanding > WG_FILE_IN_FLIGHT) return WMX_OVERSIZE;', 'fcnative'),
    ('common/fileflow.c', 'if (flow->outstanding == 0) return WMX_BAD_FIELD;', '', 'fcnative'),
    ('common/fileflow.c', 'if (++flow->response_line > WG_FILE_RESPONSE_BYTES) return WMX_OVERSIZE;', 'if (++flow->response_line >= WG_FILE_RESPONSE_BYTES) return WMX_OVERSIZE;', 'fcnative'),
    ('common/fileflow.c', '            flow->outstanding--;', '', 'fcnative'),
    ('common/fileflow.c', '            flow->outstanding--;\n            flow->response_line = 0;', '            flow->outstanding--;', 'fcnative'),
    ('common/fileflow.h', '#define WG_FILE_IN_FLIGHT 4u', '#define WG_FILE_IN_FLIGHT 5u', 'fcnative'),
    ('init/boot.c', 'if (out->browse_uid != 0 && (out->browse_uid < WG_UNIX_ID_MIN || out->browse_uid > WG_UNIX_ID_MAX)) return -1;', 'if (out->browse_uid != 0 && (out->browse_uid > WG_UNIX_ID_MAX)) return -1;', 'fcboot'),
    ('init/boot.c', 'if (out->browse_uid != 0 && (out->browse_uid < WG_UNIX_ID_MIN || out->browse_uid > WG_UNIX_ID_MAX)) return -1;', 'if (out->browse_uid != 0 && (out->browse_uid < WG_UNIX_ID_MIN)) return -1;', 'fcboot'),
    ('init/boot.c', 'gid < WG_UNIX_ID_MIN || gid > WG_UNIX_ID_MAX || roots < 1 || roots > WG_ROOTS_MAX', 'gid > WG_UNIX_ID_MAX || roots < 1 || roots > WG_ROOTS_MAX', 'fcboot'),
    ('init/boot.c', 'gid < WG_UNIX_ID_MIN || gid > WG_UNIX_ID_MAX || roots < 1 || roots > WG_ROOTS_MAX', 'gid < WG_UNIX_ID_MIN || roots < 1 || roots > WG_ROOTS_MAX', 'fcboot'),
    ('init/boot.c', 'gid < WG_UNIX_ID_MIN || gid > WG_UNIX_ID_MAX || roots < 1 || roots > WG_ROOTS_MAX', 'gid < WG_UNIX_ID_MIN || gid > WG_UNIX_ID_MAX || roots > WG_ROOTS_MAX', 'fcboot'),
    ('init/boot.c', 'gid < WG_UNIX_ID_MIN || gid > WG_UNIX_ID_MAX || roots < 1 || roots > WG_ROOTS_MAX', 'gid < WG_UNIX_ID_MIN || gid > WG_UNIX_ID_MAX || roots < 1', 'fcboot'),
    ('init/boot.c', 'if (length - at < source_length || !root_source_ok(payload + at, source_length)) return -1;', 'if (length - at < source_length) return -1;', 'fcboot'),
    ('init/boot.c', 'if (length - at < source_length || !root_source_ok(payload + at, source_length)) return -1;', 'if (!root_source_ok(payload + at, source_length)) return -1;', 'fcboot'),
    ('init/boot.c', "if (component == 0 || (component == 1 && start[0] == '.') || (component == 2 && start[0] == '.' && start[1] == '.')) return 0;", "if ((component == 1 && start[0] == '.') || (component == 2 && start[0] == '.' && start[1] == '.')) return 0;", 'fcboot'),
    ('init/boot.c', "if (component == 0 || (component == 1 && start[0] == '.') || (component == 2 && start[0] == '.' && start[1] == '.')) return 0;", "if (component == 0 || (component == 2 && start[0] == '.' && start[1] == '.')) return 0;", 'fcboot'),
    ('init/boot.c', "if (component == 0 || (component == 1 && start[0] == '.') || (component == 2 && start[0] == '.' && start[1] == '.')) return 0;", "if (component == 0 || (component == 1 && start[0] == '.')) return 0;", 'fcboot'),
    ('init/boot.c', 'if (!ok || ++component > 64) return 0;', 'if (!ok || ++component > 65) return 0;', 'fcboot'),
    ('init/boot.c', 'if (!ok || ++component > 64) return 0;', 'if (++component > 64) return 0;', 'fcboot'),
    ('init/boot.c', 'for (unsigned i = 0; i < out->count; i++)\n            if (out->browse_uid != 0 && (out->browse_uid == out->runtime_uid[i] || out->browse_uid == out->workspace_gid[i])) return -1;', 'for (unsigned i = 0; i < out->count; i++)\n            if (out->browse_uid != 0 && (out->browse_uid == out->workspace_gid[i])) return -1;', 'fcboot'),
    ('init/boot.c', 'for (unsigned i = 0; i < out->count; i++)\n            if (out->browse_uid != 0 && (out->browse_uid == out->runtime_uid[i] || out->browse_uid == out->workspace_gid[i])) return -1;', 'for (unsigned i = 0; i < out->count; i++)\n            if (out->browse_uid != 0 && (out->browse_uid == out->runtime_uid[i])) return -1;', 'fcboot'),
    ('init/boot.c', 'if (out->workspace_gid[i] == out->runtime_uid[j]) return -1;', 'if (0) return -1;', 'fcboot'),
    ('init/boot.c', '        if (length - at < 4) return -1;\n        out->browse_uid', '        out->browse_uid', 'fcboot'),
    ('init/boot.c', '            if (length - at < 5) return -1;\n            uint32_t gid', '            uint32_t gid', 'fcboot'),
    ('init/boot.c', '                if (length - at < 1) return -1;\n                size_t source_length', '                size_t source_length', 'fcboot'),
    ('init/boot.c', '    if (set.browse_uid != 0) {\n        uint64_t device = 0;', '    if (1) {\n        uint64_t device = 0;', 'fcboot'),
    ('init/boot.c', '        start_flags |= WG_START_FILE_CHANNEL;', '', 'fcboot'),
    ('init/boot.c', 'if (boot->conv_file_channel) streams |= 2;', '', 'fcboot'),
    ('init/boot.c', 'boot->conv_file_channel = (start_flags & WG_START_FILE_CHANNEL) != 0;', 'boot->conv_file_channel = 0;', 'fcboot'),
    ('init/boot.c', 'if (ops->read_data_device(ops->ctx, &device) != 0 || wg_add_file_channel(', 'if (wg_add_file_channel(', 'fcboot'),
    ('init/boot.c', '|| wg_add_file_channel(config_buffer, config_length, sizeof config_buffer, set.browse_uid, device, &config_length) != 0) {', ') {', 'fcboot'),
    ('init/trusted_config.c', 'if (browse_uid < 1000u || browse_uid > 65533u || data_device == 0 ||', 'if (browse_uid > 65533u || data_device == 0 ||', 'fcboot'),
    ('init/trusted_config.c', 'if (browse_uid < 1000u || browse_uid > 65533u || data_device == 0 ||', 'if (browse_uid < 1000u || data_device == 0 ||', 'fcboot'),
    ('init/trusted_config.c', 'if (browse_uid < 1000u || browse_uid > 65533u || data_device == 0 ||', 'if (browse_uid < 1000u || browse_uid > 65533u ||', 'fcboot'),
    ('init/trusted_config.c', "length < 2 || config[length - 1] != '}' || config[0] != '{') return -1;", "config[length - 1] != '}' || config[0] != '{') return -1;", 'fcboot'),
    ('init/trusted_config.c', "length < 2 || config[length - 1] != '}' || config[0] != '{') return -1;", "length < 2 || config[0] != '{') return -1;", 'fcboot'),
    ('init/trusted_config.c', "length < 2 || config[length - 1] != '}' || config[0] != '{') return -1;", "length < 2 || config[length - 1] != '}') return -1;", 'fcboot'),
    ('init/trusted_config.c', '    if (top_level_key(config, length, "fileChannel") != 0) return -1;', '', 'fcboot'),
    ('init/trusted_config.c', '|| length - 1 + (size_t)n + 1 >= capacity ||', '||', 'fcboot'),
    ('init/trusted_config.c', '|| length - 1 + (size_t)n > WG_CONFIG_MAX_BYTES) return -1;', ') return -1;', 'fcboot'),
    ('init/dataroots.c', 'return under(source, "/workspace/outputs") || under(source, "/workspace/.winter/memory");', 'return under(source, "/workspace/.winter/memory");', 'fcroots'),
    ('init/dataroots.c', 'return under(source, "/workspace/outputs") || under(source, "/workspace/.winter/memory");', 'return under(source, "/workspace/outputs");', 'fcroots'),
    ('init/dataroots.c', "return strncmp(source, directory, n) == 0 && (source[n] == '\\0' || source[n] == '/');", 'return strncmp(source, directory, n) == 0;', 'fcroots'),
    ('init/dataroots.c', "return strncmp(source, directory, n) == 0 && (source[n] == '\\0' || source[n] == '/');", "return strncmp(source, directory, n) == 0 && source[n] == '\\0';", 'fcroots'),
    ('init/dataroots.c', '    return openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);', '    return openat(parent, name, O_RDONLY | O_DIRECTORY | O_CLOEXEC);', 'fcroots'),
    ('init/dataroots.c', 'int workspace = open(workspace_path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);', 'int workspace = open(workspace_path, O_RDONLY | O_DIRECTORY | O_CLOEXEC);', 'fcroots'),
    ('init/dataroots.c', 'if (st.st_uid != parent_owner) { close(current); return -1; }', '', 'fcroots'),
    ('init/dataroots.c', 'if (rc == 0) rc = fchmod(current, ROOT_MODE);', '', 'fcroots'),
    ('init/dataroots.c', '#define ROOT_MODE 02770', '#define ROOT_MODE 0770', 'fcroots'),
    ('init/dataroots.c', '#define PARENT_MODE 0711', '#define PARENT_MODE 0777', 'fcroots'),
    ('init/dataroots.c', '(fstat(current, &st) != 0 || st.st_uid != owner || st.st_gid != gid)) rc = -1;', '(fstat(current, &st) != 0 || st.st_gid != gid)) rc = -1;', 'fcroots'),
    ('init/dataroots.c', '(fstat(current, &st) != 0 || st.st_uid != owner || st.st_gid != gid)) rc = -1;', '(fstat(current, &st) != 0 || st.st_uid != owner)) rc = -1;', 'fcroots'),
    ('init/dataroots.c', 'if (strncmp(source, WORKSPACE_PREFIX, sizeof WORKSPACE_PREFIX - 1) != 0) { rc = -1; break; }', '', 'fcroots'),
    ('init/dataroots.c', 'if (length > 64) { close(current); return -1; }', 'if (length == 0) { close(current); return -1; }', 'fcroots'),
    ('init/dataroots.c', 'if (wg_data_root_is_share_mount(source)) continue;', '', 'fcroots'),
    ('bootstrap/guest_bootstrap.py', 'if REVISION_THREE and (type(parsed.get("v")) is not int or parsed["v"] != BOOTSTRAP_VERSION):', 'if False:', 'bootstrap'),
    ('bootstrap/guest_bootstrap.py', 'MAX_ENDED_BOOTS = 4', 'MAX_ENDED_BOOTS = 5', 'bootstrap'),
    ('bootstrap/guest_bootstrap.py', 'MAX_RUNTIME_TIMEOUT_MS_V3 = 86_400_000', 'MAX_RUNTIME_TIMEOUT_MS_V3 = 86_400_001', 'bootstrap'),
    ('bootstrap/guest_bootstrap.py', 'and all(_boot_id(v) for v in value) and len(set(value)) == len(value)', 'and all(_boot_id(v) for v in value)', 'bootstrap'),
    ('bootstrap/guest_bootstrap.py', 'or scope["bootId"] in runtime["endedGuestBoots"]):', '):', 'bootstrap'),
    ('bootstrap/guest_bootstrap.py', '(runtime["continuation"] == "fresh" and runtime["endedGuestBoots"]) or', '', 'bootstrap'),
    ('bootstrap/guest_bootstrap.py', 'message["browseUid"] in uids or any(i["workspaceGid"] == message["browseUid"] for i in items)', 'any(i["workspaceGid"] == message["browseUid"] for i in items)', 'bootstrap'),
    ('bootstrap/guest_bootstrap.py', 'message["browseUid"] in uids or any(i["workspaceGid"] == message["browseUid"] for i in items)', 'message["browseUid"] in uids', 'bootstrap'),
    ('bootstrap/guest_bootstrap.py', 'if sum(1 for s in value if s["kind"] == "folder") > MAX_FOLDER_SHARES or any(sum(1 for s in value if s["kind"] == kind) > 1 for kind in ("guidance", "memory", "outputs")):', 'if False:', 'bootstrap'),
    ('bootstrap/guest_bootstrap.py', 'mode_ok = share["kind"] == "folder" or share["readOnly"] == (share["kind"] == "guidance")', 'mode_ok = True', 'bootstrap'),
    ('bootstrap/guest_bootstrap.py', 'self._fault(operation, nonce, "share_inventory")', 'self._fault(operation, nonce, "internal")', 'bootstrap'),
    ('bootstrap/guest_bootstrap.py', 'self._fault(operation, nonce, "resume_store_missing")', 'self._fault(operation, nonce, "internal")', 'bootstrap'),
    ('bootstrap/guest_bootstrap.py', 'item["runtime"] is not None and item["runtime"]["continuation"] == "resume" for item in message["conversations"]', "False for item in message['conversations']", 'bootstrap'),
    ('bootstrap/guest_bootstrap.py', 'ready["continuations"] = ["fresh" for item in message["conversations"] if item["runtime"] is not None]', 'ready["continuations"] = []', 'bootstrap'),
    ('bootstrap/guest_bootstrap.py', 'out = bytearray([profile | (EXTENDED_PAYLOAD if REVISION_THREE else 0), len(message["conversations"])])', 'out = bytearray([profile, len(message["conversations"])])', 'bootstrap'),
    ('bootstrap/guest_bootstrap.py', 'out += struct.pack("<I", message["browseUid"] or 0)', 'out += struct.pack("<I", 0)', 'bootstrap'),
    ('bootstrap/guest_bootstrap.py', 'out += struct.pack("<IB", item["workspaceGid"], len(item["roots"]))', 'out += struct.pack("<IB", item["runtimeUid"], len(item["roots"]))', 'bootstrap'),
    ('bootstrap/guest_bootstrap.py', 'source = root["source"].encode("ascii")', 'source = root["guestPath"].encode("ascii")', 'bootstrap'),
    ('bootstrap/guest_bootstrap.py', 'if name == "--file-channel-v1" and not file_channel:', 'if name == "--file-channel-v1":', 'bootstrap'),
    ('bootstrap/guest_bootstrap.py', 'set_revision_three(flags["file_channel_v1"])', 'set_revision_three(True)', 'bootstrap'),
    ('init/init_linux.c', 'return fstat(fd, &st) == 0 && S_ISFIFO(st.st_mode) && st.st_uid == geteuid() && st.st_nlink == 1 && flags >= 0 && (flags & O_NONBLOCK) != 0;', 'return fstat(fd, &st) == 0 && st.st_uid == geteuid() && st.st_nlink == 1 && flags >= 0 && (flags & O_NONBLOCK) != 0;', 'fcpid1'),
    ('init/init_linux.c', 'return fstat(fd, &st) == 0 && S_ISFIFO(st.st_mode) && st.st_uid == geteuid() && st.st_nlink == 1 && flags >= 0 && (flags & O_NONBLOCK) != 0;', 'return fstat(fd, &st) == 0 && S_ISFIFO(st.st_mode) && st.st_uid == geteuid() && flags >= 0 && (flags & O_NONBLOCK) != 0;', 'fcpid1'),
    ('init/init_linux.c', 'return fstat(fd, &st) == 0 && S_ISFIFO(st.st_mode) && st.st_uid == geteuid() && st.st_nlink == 1 && flags >= 0 && (flags & O_NONBLOCK) != 0;', 'return fstat(fd, &st) == 0 && S_ISFIFO(st.st_mode) && st.st_uid == geteuid() && st.st_nlink == 1 && flags >= 0;', 'fcpid1'),
    ('init/init_linux.c', 'if (with_files) { argv[n++] = "--file-channel-fds"; argv[n++] = with_ports ? "7,8" : "4,5"; }', 'if (with_files) { argv[n++] = "--file-channel-fds"; argv[n++] = "7,8"; }', 'fcpid1'),
    ('init/init_linux.c', 'if (with_files) { sources[count++] = G.file_in_r; sources[count++] = G.file_out_w; }', 'if (with_files) { sources[count++] = G.file_out_w; sources[count++] = G.file_in_r; }', 'fcpid1'),
    ('init/init_linux.c', '#ifdef WG_FILE_CHANNEL_V1\n    release_file_ends();\n#endif\n    G.supervisor = pid;', '    G.supervisor = pid;', 'fcpid1'),
    ('init/init_linux.c', 'if (with_files && (!fifo_end_ok(G.file_in_r) || !fifo_end_ok(G.file_out_w))) {', 'if (0) {', 'fcpid1'),
    ('init/init_linux.c', 'if (set->browse_uid == 0) return 0;', '', 'fcpid1'),
    ('init/init_linux.c', 'if (prepare_data_roots(set) != 0) return -1;', '', 'fcpid1'),
    ('init/init_linux.c', 'return pipe2(pair, O_CLOEXEC | O_NONBLOCK);', 'return pipe2(pair, O_CLOEXEC);', 'fcpid1'),
    ('init/init_linux.c', 'int fd = open(path, O_WRONLY | O_CLOEXEC | O_NOFOLLOW);', 'int fd = open(path, O_WRONLY | O_CLOEXEC);', 'fcpid1'),
    ('init/init_linux.c', 'return written == 2 ? 0 : -1;', 'return 0;', 'fcpid1'),
    ('init/init_linux.c', 'if (stat(WG_WORKSPACE_PATH, &st) != 0 || !S_ISDIR(st.st_mode)) return -1;', 'if (stat(WG_WORKSPACE_PATH, &st) != 0) return -1;', 'fcpid1'),
    ('init/init_linux.c', '*device = (uint64_t)st.st_dev;', '*device = (uint64_t)st.st_ino;', 'fcpid1'),
    ('init/init_linux.c', 'static int op_start_supervisor(void *ctx, const char *config, size_t length, int flags) {', 'static int op_start_supervisor(void *ctx, const char *config, size_t length, int flags) {\n    flags &= ~WG_START_FILE_CHANNEL;', 'fcpid1'),
    ('init/dataroots.c', 'if (length > 64) { close(current); return -1; }', '', 'fcroots'),
    ('init/boot.c', 'if (length < sizeof prefix || memcmp(text, prefix, sizeof prefix - 1) != 0) return 0;', 'if (memcmp(text, prefix, sizeof prefix - 1) != 0) return 0;', 'fcboot'),
    ('init/trusted_config.c', 'if (length == 2 && n > 0) { text++; n--; }', '', 'fcboot'),
    ('build.py', 'default="production", help="file-channel builds', 'default="file-channel", help="file-channel builds', 'fchygiene'),
    ('build.py', '"init": [\n        "init/init_linux.c",', '"init": [\n        "init/dataroots.c", "init/init_linux.c",', 'fchygiene'),
]

SUITES = {
    "pid1": ("tests", "test_pid1_linux.py", []),
    "config": ("tests", "test_init_modules.py", ["-k", "TrustedConfig"]),
    "relay": ("tests", "test_relay.py", ["-k", "output_written_before_g", "-k", "runtime_ready", "-k", "held_until"]),
    "flow": ("tests", "test_relay.py", ["-k", "runtime_flow"]),
    "cboot": ("tests", "test_init_modules.py", ["-k", "BootStateMachine"]),
    "hygiene": ("tests", "test_hygiene.py", []),
    "bootstrap": ("bootstrap", "test_guest_bootstrap.py", []),
    "guided": ("tests", "test_guided_config.py", []),
    "fcrelay": ("tests", "test_relay.py", ["-k", "FileChannelRelayTests"]),
    "fcnative": ("tests", "test_native.py", []),
    "fcboot": ("tests", "test_filechannel.py", ["-k", "BootFileChannelTests"]),
    "fcroots": ("tests", "test_filechannel.py", ["-k", "DataRootTests"]),
    "fchygiene": ("tests", "test_filechannel.py", ["-k", "ProductionHas"]),
    "fcpid1": ("tests", "test_pid1_linux.py", ["-k", "FileChannelPid1Tests"]),
}


def run_mutant(mutant):
    relative, old, new, suite = mutant
    folder = Path(tempfile.mkdtemp(prefix="guest-mutant-"))
    try:
        copy = folder / "g"
        shutil.copytree(ROOT, copy, ignore=shutil.ignore_patterns("__pycache__"))
        path = copy / relative
        text = path.read_text()
        if old not in text:
            return "STALE"
        path.write_text(text.replace(old, new, 1))
        directory, script, arguments = SUITES[suite]
        try:
            result = subprocess.run([sys.executable, "-I", "-S", "-B", "-m", "unittest", "discover", "-s", str(copy / directory), "-p", script, *arguments],
                                    capture_output=True, text=True, timeout=300)
        except subprocess.TimeoutExpired:
            return "KILLED"   # a guard whose removal makes the code under test loop or block is caught too
        return "KILLED" if result.returncode != 0 else "SURVIVED"
    finally:
        shutil.rmtree(folder, ignore_errors=True)


@unittest.skipUnless(CC, "no C compiler")
class MutantTests(unittest.TestCase):
    def test_every_mutant_is_caught_by_its_suite(self):
        runnable = [m for m in MUTANTS if m[3] not in ("pid1", "fcpid1") or LINUX]
        with ThreadPoolExecutor(4) as pool:
            outcomes = list(pool.map(run_mutant, runnable))
        for mutant, outcome in zip(runnable, outcomes):
            with self.subTest(file=mutant[0], old=mutant[1].strip()[:60], new=mutant[2].strip()[:30]):
                self.assertEqual(outcome, "KILLED")


if __name__ == "__main__":
    unittest.main()
