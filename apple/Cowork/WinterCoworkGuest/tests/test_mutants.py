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
    ("init/init_linux.c","    release_runtime_ends();\n    G.supervisor = pid;","    G.supervisor = pid;","pid1"),
    ("init/init_linux.c","    close_fd(&G.rt_in_r);\n    close_fd(&G.rt_out_w);","    close_fd(&G.rt_out_w);","pid1"),
    ("init/init_linux.c","    close_fd(&G.rt_out_w);\n    close_fd(&G.rt_err_w);\n}","    close_fd(&G.rt_err_w);\n}","pid1"),
    ("init/init_linux.c","    close_fd(&G.rt_err_w);\n}","}","pid1"),
    ("init/init_linux.c","    umask(022); ","    ","pid1"),
    ("init/init_linux.c","    signal(SIGPIPE, SIG_DFL); ","    ","pid1"),
    ("init/init_linux.c","    sigprocmask(SIG_SETMASK, &none, NULL);","","pid1"),
    ("init/init_linux.c","        setsid();\n        int sources[4]","        int sources[4]","pid1"),
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
    # ---- the stand-in lifecycle (init/standin.c), the stand-in effects (init/standin_linux.c) and the metadata composer (standin/standin_prepare.py)
    ('init/standin.c', '    if (s->state != WG_SI_NONE) return;', '    if (0) return;', 'standin'),
    ('init/standin.c', '    if (s->items_length == 0) {', '    if (0) {', 'standin'),
    ('init/standin.c', '    s->items_length = 0;   /* nothing is kept unless every check below passes */\n', '', 'standin'),
    ('init/standin.c', 's->items, s->items_length) != 0) { fail(s, "standin-prepare-failed"); return; }', 's->items, s->items_length) == 0) { fail(s, "standin-prepare-failed"); return; }', 'standin'),
    ('init/standin.c', 'if (listener < 3) {', 'if (listener < 0) {', 'standin'),
    ('init/standin.c', '    s->listener_fd = listener;\n', '', 'standin'),
    ('init/standin.c', 'now_ms(s->ops->ctx) + WG_STANDIN_LOCATE_MS;', 'now_ms(s->ops->ctx);', 'standin'),
    ('init/standin.c', 'now_ms(s->ops->ctx) >= s->deadline_ms', 'now_ms(s->ops->ctx) > s->deadline_ms', 'standin'),
    ('init/standin.c', 'if (pidfd < 0) { fail(s, "standin-runtime-refused"); return; }', 'if (pidfd < 0) { return; }', 'standin'),
    ('init/standin.c', '    if (s->state != WG_SI_LISTENING) return;\n    int pidfd', '    int pidfd', 'standin'),
    ('init/standin.c', '    s->ops->close_fd(s->ops->ctx, pidfd);', '    (void)pidfd;', 'standin'),
    ('init/standin.c', 'if (started != 0) {', 'if (0) {', 'standin'),
    ('init/standin.c', '    s->ops->close_fd(s->ops->ctx, s->listener_fd); /* the worker holds', '    (void)s; /* the worker holds', 'standin'),
    ('init/standin.c', '    s->listener_fd = -1;\n    s->worker = worker;', '    s->worker = worker;', 'standin'),
    ('init/standin.c', 'if (s->state != WG_SI_RUNNING || pid != s->worker) return;', 'if (s->state != WG_SI_RUNNING) return;', 'standin'),
    ('init/standin.c', '    s->worker = 0;\n    s->state = WG_SI_FAILED;   /* never restarted', '    s->worker = 0;\n    s->state = WG_SI_RUNNING;   /* never restarted', 'standin'),
    ('init/standin.c', '    if (s->state == WG_SI_RUNNING) s->ops->stop_worker(s->ops->ctx, s->worker);', '    if (0) s->ops->stop_worker(s->ops->ctx, s->worker);', 'standin'),
    ('init/standin.c', '    if (s->listener_fd >= 3) s->ops->close_fd(s->ops->ctx, s->listener_fd);\n    s->listener_fd = -1;\n    s->worker = 0;\n    s->state = WG_SI_STOPPED;', '    s->listener_fd = -1;\n    s->worker = 0;\n    s->state = WG_SI_STOPPED;', 'standin'),
    ('init/standin.c', 'set->json_length < 2', 'set->json_length < 1', 'standin'),
    ('init/standin.c', 'set->json_length > WG_STANDIN_ITEMS_MAX', 'set->json_length >= WG_STANDIN_ITEMS_MAX', 'standin'),
    ('init/standin.c', '    if (sid_length < 1) return -1;\n', '', 'standin'),
    ('init/standin.c', 'return s->state == WG_SI_LISTENING ?', 'return s->state != WG_SI_NONE ?', 'standin'),
    ('init/standin.c', '    s->listener_fd = -1;\n    s->state = WG_SI_FAILED;\n    note(s, code);', '    s->listener_fd = -1;\n    note(s, code);', 'standin'),
    ('init/standin.c', '    if (s->listener_fd >= 3) s->ops->close_fd(s->ops->ctx, s->listener_fd);\n    s->listener_fd = -1;\n    s->state = WG_SI_FAILED;', '    s->listener_fd = -1;\n    s->state = WG_SI_FAILED;', 'standin'),
    ('init/standin.c', 'memcpy(s->items, set->json, set->json_length);', 's->items[0] = 0;', 'standin'),
    ('init/standin.c', '    s->runtime_uid = set->runtime_uid[0];\n', '', 'standin'),
    ('init/standin.c', 'set->profile != 1 ||', 'set->profile > 2 ||', 'standin'),
    ('init/standin.c', ' || set->count != 1 ||', ' ||', 'standin'),
    ('standin/standin_prepare.py', 'WORKER_UID = 65534', 'WORKER_UID = 65533', 'prepare'),
    ('standin/standin_prepare.py', 'or len(answers) != 2 or', 'or len(answers) > 2 or', 'prepare'),
    ('standin/standin_prepare.py', '0x20 <= ord(c) <= 0x7E', '0x20 <= ord(c) <= 0x7F', 'prepare'),
    ('standin/standin_prepare.py', '0x20 <= ord(c) <= 0x7E', '0x1F <= ord(c) <= 0x7E', 'prepare'),
    ('standin/standin_prepare.py', '1 <= len(text) <= limit', '0 <= len(text) <= limit', 'prepare'),
    ('standin/standin_prepare.py', '1 <= len(text) <= limit', '1 <= len(text) <= limit + 1', 'prepare'),
    ('standin/standin_prepare.py', '    if raw != canonical(profile).encode("ascii") + b"\\n":\n        refuse("profile")\n', '', 'prepare'),
    ('standin/standin_prepare.py', 'profile["workerUid"] != WORKER_UID or type(profile["workerUid"]) is not int', 'type(profile["workerUid"]) is not int', 'prepare'),
    ('standin/standin_prepare.py', 'profile["workerUid"] != WORKER_UID or type(profile["workerUid"]) is not int', 'profile["workerUid"] != WORKER_UID', 'prepare'),
    ('standin/standin_prepare.py', 'set(profile) != PROFILE_KEYS or', '', 'prepare'),
    ('standin/standin_prepare.py', 'selection["providerId"] != "winter-standin" or selection["modelKey"] != "winter-standin/scripted"', 'selection["modelKey"] != "winter-standin/scripted"', 'prepare'),
    ('standin/standin_prepare.py', 'selection["providerId"] != "winter-standin" or selection["modelKey"] != "winter-standin/scripted"', 'selection["providerId"] != "winter-standin"', 'prepare'),
    ('standin/standin_prepare.py', 'set(selection) != SELECTION_KEYS or', '', 'prepare'),
    ('standin/standin_prepare.py', '    if len(found) != 1:', '    if len(found) < 1:', 'prepare'),
    ('standin/standin_prepare.py', 'not 1000 <= uid <= 65533', 'not 999 <= uid <= 65533', 'prepare'),
    ('standin/standin_prepare.py', 'not 1000 <= uid <= 65533', 'not 1000 <= uid <= 65534', 'prepare'),
    ('standin/standin_prepare.py', 'type(uid) is not int or', '', 'prepare'),
    ('standin/standin_prepare.py', ' or set(item) & {"hostQueryGuidedRuntime"}', '', 'prepare'),
    ('standin/standin_prepare.py', 'set(provider) != {"scope", "selection"}', '"scope" not in provider', 'prepare'),
    ('standin/standin_prepare.py', 'provider["selection"] != profile["selection"] or config.get("model") != profile["selection"]["modelKey"]', 'config.get("model") != profile["selection"]["modelKey"]', 'prepare'),
    ('standin/standin_prepare.py', 'provider["selection"] != profile["selection"] or config.get("model") != profile["selection"]["modelKey"]', 'provider["selection"] != profile["selection"]', 'prepare'),
    ('standin/standin_prepare.py', 'not isinstance(scope, dict) or set(scope) != set(SCOPE_KEYS)', 'not isinstance(scope, dict)', 'prepare'),
    ('standin/standin_prepare.py', 'elif type(value) is not int or not 1 <= value <= SAFE_INT:', 'elif not isinstance(value, int) or not 1 <= value <= SAFE_INT:', 'prepare'),
    ('standin/standin_prepare.py', 'elif type(value) is not int or not 1 <= value <= SAFE_INT:', 'elif type(value) is not int or not 0 <= value <= SAFE_INT:', 'prepare'),
    ('standin/standin_prepare.py', 'elif type(value) is not int or not 1 <= value <= SAFE_INT:', 'elif type(value) is not int or not 1 <= value:', 'prepare'),
    ('standin/standin_prepare.py', '            if not printable(value, ID_MAX):', '            if not isinstance(value, str):', 'prepare'),
    ('standin/standin_prepare.py', 'ID_MAX = 256', 'ID_MAX = 100000', 'prepare'),
    ('standin/standin_prepare.py', '"selection": profile["selection"],', '"selection": {},', 'prepare'),
    ('standin/standin_prepare.py', '"system": [], "user": [], "absentSystem": [], "absentUser": []', '"system": ["x"], "user": [], "absentSystem": [], "absentUser": []', 'prepare'),
    ('standin/standin_prepare.py', 'for answer in profile["answers"]]', 'for answer in profile["answers"][:1] * 2]', 'prepare'),
    ('standin/standin_prepare.py', 'hashlib.sha256(script_text.encode("ascii")).hexdigest()', 'hashlib.sha256(script_text.encode("ascii") + b" ").hexdigest()', 'prepare'),
    ('standin/standin_prepare.py', '"version": 1, "runtimeUid": uid,', '"version": 2, "runtimeUid": uid,', 'prepare'),
    ('standin/standin_prepare.py', 'os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o444)', 'os.O_WRONLY | os.O_CREAT | os.O_CLOEXEC, 0o444)', 'prepare'),
    ('standin/standin_prepare.py', 'os.O_CLOEXEC, 0o444)', 'os.O_CLOEXEC, 0o644)', 'prepare'),
    ('standin/standin_prepare.py', 'os.makedirs(directory, mode=0o755, exist_ok=True)', 'os.makedirs(directory, mode=0o700, exist_ok=True)', 'prepare'),
    ('standin/standin_prepare.py', '        if not stat.S_ISREG(os.fstat(descriptor).st_mode):\n            refuse("input")\n', '', 'prepare'),
    ('standin/standin_prepare.py', '    if len(data) > INPUT_MAX:', '    if len(data) > INPUT_MAX * 4:', 'prepare'),
    ('standin/standin_prepare.py', 'os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)', 'os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)', 'prepare'),
    ('standin/standin_prepare.py', 'os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)', 'os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)', 'prepare'),
    ('standin/standin_prepare.py', '        return 2\n    except OSError:', '        return 0\n    except OSError:', 'prepare'),
    ('standin/standin_prepare.py', '        print("standin-refused " + error.code)', '        print("standin-refused " + error.code + " " + str(error))', 'prepare'),
    ('standin/standin_prepare.py', '    except Refused as error:', '    except ZeroDivisionError as error:', 'prepare'),
    ('standin/standin_prepare.py', '        if os.geteuid() == 0:\n            os.fchown(descriptor, 0, 0)\n', '        os.fchown(descriptor, 0, 0)\n', 'prepare'),
    ('init/standin_linux.c', 'if (ids[i] != uid) return 0;', 'if (0) return 0;', 'standinlinux'),
    ('init/standin_linux.c', '    if (found > 1) return -1;\n', '', 'standinlinux'),
    ('init/standin_linux.c', 'if (*end || value < 2 ||', 'if (*end || value < 1 ||', 'standinlinux'),
    ('init/standin_linux.c', 'if (!strcmp(target, exe)) return 1;', 'return 1;', 'standinlinux'),
    ('init/standin_linux.c', 'if (!strcmp(text, comm)) return 1;', 'return 1;', 'standinlinux'),
    ('init/standin_linux.c', "char marker = 'I';", "char marker = 'J';", 'standinlinux'),
    ('init/standin_linux.c', '    return wait_child(child, 10000) == 0 ? 0 : -1;', '    return wait_child(child, 10000) == 0 ? 0 : 0;', 'standinlinux'),
    ('init/standin_linux.c', '        for (int fd = 7; fd < 1024; fd++) close(fd);\n', '', 'standinlinux'),
    ('init/standin_linux.c', 'static char *const WORKER_ENV[] = { NULL };', 'static char *const WORKER_ENV[] = { "A=1", NULL };', 'standinlinux'),
    ('init/standin_linux.c', '        if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) _exit(125);\n', '', 'standinlinux'),
    ('init/standin_linux.c', 'dup2(null_fd, 0) < 0', 'dup2(out, 0) < 0', 'standinlinux'),
    ('init/standin_linux.c', '"--listener-fd", "3", "--admission-fd", "4"', '"--admission-fd", "4", "--listener-fd", "3"', 'standinlinux'),
    ('init/standin_linux.c', '    int sent = wg_standin_send_admission(pair[0], pidfd);', '    int sent = 0;', 'standinlinux'),
    ('init/standin_linux.c', 'for (int i = 0; i < 4; i++) if (dup2(temporary[i], 3 + i) < 0) _exit(122);', 'for (int i = 0; i < 4; i++) if (dup2(temporary[i], 4 + i) < 0) _exit(122);', 'standinlinux'),
    ('init/standin_linux.c', '    if (process_matches(p->proc_root, pid, uid, p->runtime_exe, p->runtime_comm) != 1) { close(pidfd); return -1; }\n', '', 'standinlinux'),
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
    "standin": ("tests", "test_standin.py", []),
    "prepare": ("tests", "test_standin_prepare.py", []),
    "standinlinux": ("tests", "test_standin_linux.py", []),
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
            return "KILLED"   # a mutant that makes the suite hang is caught by the hang
        return "KILLED" if result.returncode != 0 else "SURVIVED"
    finally:
        shutil.rmtree(folder, ignore_errors=True)


@unittest.skipUnless(CC, "no C compiler")
class MutantTests(unittest.TestCase):
    def test_every_mutant_is_caught_by_its_suite(self):
        runnable = [m for m in MUTANTS if m[3] not in ("pid1", "standinlinux") or LINUX]
        with ThreadPoolExecutor(4) as pool:
            outcomes = list(pool.map(run_mutant, runnable))
        for mutant, outcome in zip(runnable, outcomes):
            with self.subTest(file=mutant[0], old=mutant[1].strip()[:60], new=mutant[2].strip()[:30]):
                self.assertEqual(outcome, "KILLED")


if __name__ == "__main__":
    unittest.main()
