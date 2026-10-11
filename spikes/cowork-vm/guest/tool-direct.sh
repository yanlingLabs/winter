#!/bin/sh
# Strict host-owner source test using the ordinary, non-idmapped mount view.
set -u
policy=${FIXTURE_POLICY:?}
uid=${FIXTURE_UID:?}
supervisor_userns=${1:?}
control=${2:?}
source=/workspace/source
failures=0
checks=0
check() {
    checks=$((checks + 1))
    id=$1; shift
    if "$@" >/dev/null 2>&1; then result=pass; else result=fail; failures=$((failures + 1)); fi
    printf '{"kind":"check","suite":"direct_strict_source","policy":"%s","uid":%s,"id":"%s","status":"%s"}\n' "$policy" "$uid" "$id" "$result"
}
emit_denial() {
    checks=$((checks + 1)); [ "$2" != fail ] || failures=$((failures + 1))
    printf '{"kind":"check","suite":"direct_strict_source","policy":"%s","uid":%s,"id":"%s","status":"%s","denial":{"exitCode":%s,"failureClass":"%s","expectedFailureClasses":%s,"positiveControlPassed":%s,"positiveControlExitCode":%s}}\n' "$policy" "$uid" "$1" "$2" "$3" "$4" "$5" "$6" "$7"
}
. /opt/denials.sh
projection() {
    object=$1; filename=$2
    projected_uid=$(stat -c %u "$filename" 2>/dev/null || printf -- -1)
    projected_gid=$(stat -c %g "$filename" 2>/dev/null || printf -- -1)
    printf '{"kind":"observation","suite":"direct_strict_source","id":"guest_owner_projection","object":"%s","policy":"%s","toolKernelUid":%s,"guestUid":%s,"guestGid":%s,"required":false}\n' "$object" "$policy" "$uid" "$projected_uid" "$projected_gid"
}
check distinct_tool_uid test "$(id -u)" = "$uid"
check original_user_namespace test "$(readlink /proc/self/ns/user)" = "$supervisor_userns"
check no_new_privs test "$(status_value NoNewPrivs)" = 1
check zero_effective_caps test "$(status_value CapEff)" = 0000000000000000
check zero_permitted_caps test "$(status_value CapPrm)" = 0000000000000000
check zero_inheritable_caps test "$(status_value CapInh)" = 0000000000000000
check zero_ambient_caps test "$(status_value CapAmb)" = 0000000000000000
check zero_bounding_caps test "$(status_value CapBnd)" = 0000000000000000
projection source "$source"
projection seed "$source/seed.txt"
check source_mode_preserved test "$(stat -c %a "$source")" = 755
check seed_mode_preserved test "$(stat -c %a "$source/seed.txt")" = 644
check source_read test -r "$source/seed.txt"
check control_hidden test ! -e "$control"
denied shared_instruction_write sh -c 'printf attacked > /workspace/.winter/WINTER.md'
denied protected_ancestor_rename mv /workspace/.winter /workspace/moved-instructions
if [ "$policy" = auto ]; then
    check seed_write sh -c 'printf "direct-seed-%s\n" "$2" > "$1/seed.txt"' sh "$source" "$uid"
    check seed_reopen sh -c 'test "$(cat "$1/seed.txt")" = "direct-seed-$2"' sh "$source" "$uid"
    check source_create sh -c 'umask 022; printf "direct-created-%s\n" "$2" > "$1/direct-created-$2.txt"' sh "$source" "$uid"
    check created_reopen sh -c 'test "$(cat "$1/direct-created-$2.txt")" = "direct-created-$2"' sh "$source" "$uid"
    check created_mode test "$(stat -c %a "$source/direct-created-$uid.txt")" = 644
    projection created "$source/direct-created-$uid.txt"
    check shared_existing_write sh -c 'umask 022; printf "direct-shared-%s\n" "$2" > "$1/direct-shared-existing.txt"' sh "$source" "$uid"
    check shared_existing_reopen sh -c 'test "$(cat "$1/direct-shared-existing.txt")" = "direct-shared-$2"' sh "$source" "$uid"
else
    check plan_reads_latest_seed grep -q direct-seed-10002 "$source/seed.txt"
    denied plan_write sh -c 'printf attacked > "$1/seed.txt"' sh "$source"
    denied plan_alias_write sh -c 'printf attacked > "$1/seed-alias"' sh "$source"
    denied plan_create sh -c 'printf attacked > "$1/direct-plan-created.txt"' sh "$source"
    denied plan_unlink rm -f "$source/seed.txt"
    denied plan_rename mv "$source/seed.txt" "$source/direct-seed-moved.txt"
    denied plan_chmod chmod 0666 "$source/seed.txt"
    check plan_scratch_write sh -c 'printf scratch > /workspace/.winter/scratch/direct-plan'
fi
printf '{"kind":"summary","id":"direct_tool_view","policy":"%s","uid":%s,"checks":%s,"failures":%s,"status":"%s"}\n' "$policy" "$uid" "$checks" "$failures" "$( [ "$failures" = 0 ] && printf pass || printf fail )"
[ "$failures" = 0 ]
