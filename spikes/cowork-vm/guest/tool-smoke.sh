#!/bin/sh
# Executed only after confine.c has installed the tool boundary.
set -u
policy=${FIXTURE_POLICY:?}
tool_uid=${FIXTURE_UID:?}
supervisor_pidns=${1:?}
supervisor_mountns=${2:?}
control_root=${3:?}
failures=0
checks=0
emit() {
    checks=$((checks + 1))
    [ "$2" != fail ] || failures=$((failures + 1))
    printf '{"kind":"check","policy":"%s","uid":%s,"id":"%s","status":"%s","detail":"%s"}\n' "$policy" "$tool_uid" "$1" "$2" "$3"
}
check() { id=$1; shift; if "$@" >/dev/null 2>&1; then emit "$id" pass observed; else emit "$id" fail assertion_failed; fi; }
denied() { id=$1; shift; if "$@" >/dev/null 2>&1; then emit "$id" fail mutation_or_access_succeeded; else emit "$id" pass operation_denied; fi; }
status_value() { awk -v key="$1:" '$1 == key { print $2; found=1; exit } END { if (!found) exit 1 }' /proc/self/status; }
probe=/opt/syscall-probe
scratch=/workspace/.winter/scratch
source=/workspace/source
token="${tool_uid}-${policy}"
check identity test "$(id -u)" = "$tool_uid"
check group_identity test "$(id -g)" = "$tool_uid"
check nonroot test "$(id -u)" != 0
check pid_namespace test "$(readlink /proc/self/ns/pid)" != "$supervisor_pidns"
check mount_namespace test "$(readlink /proc/self/ns/mnt)" != "$supervisor_mountns"
check no_new_privs test "$(status_value NoNewPrivs)" = 1
check zero_effective_caps test "$(status_value CapEff)" = 0000000000000000
check zero_bounding_caps test "$(status_value CapBnd)" = 0000000000000000
check syscall_filter_installed test "$(status_value Seccomp)" = 2
check namespace_init_identity sh -c 'test "$(awk '\''$1=="Uid:" {print $2}'\'' /proc/1/status)" = "$1"' sh "$tool_uid"
check control_view_hidden test ! -e "$control_root"
check sdk_view_hidden test ! -e "$control_root/sdk/session.json"
check supervisor_executable_hidden test ! -e /opt/cowork-fixture/confine
check supervisor_process_hidden sh -c 'ps >/tmp/process-view && ! grep -v grep /tmp/process-view | grep -q "/opt/cowork-fixture/run.sh"'
check sanitized_environment sh -c 'test -z "${COWORK_CONTROL_SECRET+x}" && test -z "${LD_PRELOAD+x}" && test -z "${NODE_PATH+x}"'
check inherited_fd_closed test ! -e /proc/self/fd/9
check instruction_readable grep -q cowork-gate1-instruction /workspace/.winter/WINTER.md
denied instructions_direct sh -c 'printf attacked > /workspace/.winter/WINTER.md'
denied instructions_indirect sh -c 'p=/workspace/.winter; p=$p/WINTER.md; eval "printf attacked > \"$p\""'
denied instructions_chmod chmod 0666 /workspace/.winter/WINTER.md
denied instructions_unlink rm -f /workspace/.winter/WINTER.md
denied instruction_parent_rename mv /workspace/.winter "/workspace/.winter-$token"
denied workspace_parent_rename mv /workspace "/workspace-$token"
denied control_direct sh -c 'printf attacked > "$1/config.json"' sh "$control_root"
denied sdk_metadata_direct sh -c 'printf attacked > "$1/sdk/session.json"' sh "$control_root"
check scratch_write sh -c 'printf scratch > "$1/probe"' sh "$scratch"
check instruction_symlink_setup ln -s /workspace/.winter/WINTER.md "$scratch/instructions-link-$token"
denied instructions_symlink sh -c 'printf attacked > "$1"' sh "$scratch/instructions-link-$token"
denied instructions_hardlink ln /workspace/.winter/WINTER.md "$scratch/instructions-hardlink-$token"
check control_symlink_setup ln -s "$control_root/config.json" "$scratch/control-link-$token"
denied control_symlink sh -c 'printf attacked > "$1"' sh "$scratch/control-link-$token"
check replacement_seed sh -c 'printf replacement > "$1/replacement-$2"' sh "$scratch" "$token"
denied instructions_replace mv "$scratch/replacement-$token" /workspace/.winter/WINTER.md
denied instruction_alias_create ln -s "$scratch" /workspace/.winter/escaped-scratch
denied root_write sh -c 'printf attacked > /run/escape'
for syscall in vsock mount ptrace unshare; do
    # Probe emits its actual return and errno, then returns success only on EPERM.
    if "$probe" --probe "$syscall"; then emit "syscall_$syscall" pass denied_with_eperm; else emit "syscall_$syscall" fail required_syscall_denial_missing; fi
done
if "$probe" --probe landlock; then landlock_status=available; else landlock_status=unsupported; fi
printf '{"kind":"observation","id":"landlock_abi","status":"%s","required":false,"detail":"supplementary_not_used_by_this_boundary"}\n' "$landlock_status"
if [ "$policy" = auto ]; then
    check source_write sh -c 'printf "guest-%s\n" "$2" > "$1/.cowork-gate1-$2-share.txt"' sh "$source" "$token"
    check memory_write sh -c 'printf memory > /workspace/.winter/memory/tool-memory'
    check source_symlink_setup ln -sf /workspace/.winter/WINTER.md "$source/.cowork-gate1-$token-instruction-link"
    denied source_instruction_alias sh -c 'printf attacked > "$1"' sh "$source/.cowork-gate1-$token-instruction-link"
    # Repository instructions retain ordinary source editing semantics.
    # VZ creates host-owned files. Test-only world-write DAC permits the second
    # distinct guest UID to edit this ordinary source file without claiming idmap.
    check repository_instruction_write sh -c 'umask 000; printf repo > "$1/WINTER.md"' sh "$source"
else
    check source_read grep -q source-seed "$source/seed.txt"
    denied source_direct sh -c 'printf attacked > "$1/seed.txt"' sh "$source"
    denied source_indirect sh -c 'd=$1; f=seed.txt; eval "printf attacked > \"$d/$f\""' sh "$source"
    denied source_symlink sh -c 'printf attacked > "$1/seed-alias"' sh "$source"
    denied source_rename mv "$source/seed.txt" "$source/seed-moved.txt"
    denied source_unlink rm -f "$source/seed.txt"
    denied source_create sh -c 'printf attacked > "$1/new-file"' sh "$source"
    denied source_parent_rename mv "$source" /workspace/replaced-source
    denied source_chmod chmod 0666 "$source/seed.txt"
    denied memory_direct sh -c 'printf attacked > /workspace/.winter/memory/tool-memory'
    denied memory_rename mv /workspace/.winter/memory /workspace/replaced-memory
    check plan_source_alias_setup ln -s "$source/seed.txt" "$scratch/source-link-$token"
    denied source_scratch_alias sh -c 'printf attacked > "$1"' sh "$scratch/source-link-$token"
fi
printf '{"kind":"summary","policy":"%s","uid":%s,"checks":%s,"failures":%s,"status":"%s"}\n' "$policy" "$tool_uid" "$checks" "$failures" "$( [ "$failures" = 0 ] && printf pass || printf fail )"
[ "$failures" = 0 ]
