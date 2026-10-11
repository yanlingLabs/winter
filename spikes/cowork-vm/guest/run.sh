#!/bin/sh
# Trusted guest-side test driver. Only run in a disposable fixture VM.
set -eu
source=/workspace/source
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
unsupported() { printf '{"kind":"check","id":"guest_preflight","status":"unsupported","detail":"%s"}\n' "$1"; exit 77; }
[ "$(uname -s)" = Linux ] || unsupported linux_required
[ "$(id -u)" = 0 ] || unsupported root_supervisor_required
[ -x "$here/confine" ] || unsupported compiled_launcher_missing
[ -f "$source/.cowork-gate1-disposable" ] || unsupported disposable_source_marker_missing
[ "$(cat "$source/.cowork-gate1-disposable")" = cowork-gate1-disposable-v1 ] || unsupported disposable_source_marker_invalid
[ ! -L "$source" ] || unsupported source_alias_refused
umask 077
mkdir -p /var/lib/cowork-fixture
chmod 0700 /var/lib/cowork-fixture
control=$(mktemp -d /var/lib/cowork-fixture/run-XXXXXX)
cleanup() { rm -rf "$control"; }
trap cleanup EXIT
mkdir -p "$control/sdk" "$control/memory" "$control/scratch-10001" "$control/scratch-10002"
printf control-seed > "$control/config.json"
printf sdk-seed > "$control/sdk/session.json"
printf cowork-gate1-instruction > "$control/WINTER.md"
chmod 0444 "$control/WINTER.md"
chgrp 10000 "$control/memory" "$control/scratch-10001" "$control/scratch-10002"
chmod 2777 "$control/memory" "$control/scratch-10001" "$control/scratch-10002"
# Native host prepares these disposable fixture permissions. Apple's virtiofs
# does not necessarily allow guest ownership/group changes of a host-owned path.
# World-write in this private host fixture is test DAC only, not a product mapping.
[ -f "$source/seed.txt" ] || unsupported host_source_seed_missing
[ "$(cat "$source/seed.txt")" = source-seed ] || unsupported host_source_seed_invalid
[ -L "$source/seed-alias" ] || unsupported host_source_alias_missing
printf '{"kind":"observation","id":"host_source_identity_mapping","status":"unproven","detail":"disposable_host_prepared_world_writable_source_dac_only"}\n'
export COWORK_CONTROL_SECRET=fixture-not-a-real-secret
export NODE_PATH="$control"
pidns=$(readlink /proc/self/ns/pid)
mountns=$(readlink /proc/self/ns/mnt)
status=0
run_view() {
    policy=$1; uid=$2
    # Descriptor9 is intentionally inherited by the launcher and must disappear.
    if "$here/confine" "$policy" "$uid" "$source" "$control/memory" "$control/scratch-$uid" "$control/WINTER.md" "$here/tool-smoke.sh" "$pidns" "$mountns" "$control" 9<"$control/config.json"; then
        :
    else
        code=$?; [ "$code" = 77 ] && status=77 || status=1
    fi
}
run_view auto 10001
# The second identity must share source data while receiving its own process view.
run_view auto 10002
run_view plan 10001
check_host() {
    if "$@" >/dev/null 2>&1; then
        printf '{"kind":"check","id":"trusted_integrity","status":"pass","detail":"verified_after_tool_exit"}\n'
    else
        printf '{"kind":"check","id":"trusted_integrity","status":"fail","detail":"control_or_plan_source_changed"}\n'; status=1
    fi
}
check_host sh -c 'test "$(cat "$1/config.json")" = control-seed && test "$(cat "$1/sdk/session.json")" = sdk-seed && test "$(cat "$1/WINTER.md")" = cowork-gate1-instruction && test "$(cat "$2/seed.txt")" = source-seed && test -L "$2/seed-alias"' sh "$control" "$source"
for uid in 10001 10002; do
    if [ -f "$source/.cowork-gate1-$uid-auto-share.txt" ] && [ "$(cat "$source/.cowork-gate1-$uid-auto-share.txt")" = "guest-$uid-auto" ]; then
        printf '{"kind":"check","id":"direct_share_write","uid":%s,"status":"pass","detail":"guest_supervisor_observed_host_must_verify"}\n' "$uid"
    else
        printf '{"kind":"check","id":"direct_share_write","uid":%s,"status":"fail","detail":"write_missing"}\n' "$uid"; [ "$status" = 77 ] || status=1
    fi
done
printf '{"kind":"observation","id":"guest_kernel","release":"%s","machine":"%s"}\n' "$(uname -r)" "$(uname -m)"
printf '{"kind":"summary","id":"guest_suite","status":"%s","exitCode":%s}\n' "$(case "$status" in 0) printf pass;; 77) printf unsupported;; *) printf fail;; esac)" "$status"
exit "$status"
