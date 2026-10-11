#!/bin/sh
# Optional VZ effective-host-identity probe. Never changes source DAC or owners.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source=/workspace/source/strict-source
unsupported() { printf '{"kind":"summary","id":"direct_strict_source","status":"unsupported","detail":"%s","exitCode":77}\n' "$1"; exit 77; }
[ "$(uname -s)" = Linux ] && [ "$(id -u)" = 0 ] || unsupported root_linux_required
[ "$(cat /workspace/source/.cowork-gate1-disposable 2>/dev/null)" = cowork-gate1-disposable-v1 ] || unsupported disposable_source_required
[ -d "$source" ] && [ ! -L "$source" ] || unsupported strict_source_missing
[ "$(stat -c %a "$source")" = 755 ] || unsupported strict_directory_mode_required
[ -f "$source/seed.txt" ] && [ ! -L "$source/seed.txt" ] || unsupported strict_seed_file_required
[ "$(stat -c %a "$source/seed.txt")" = 644 ] || unsupported strict_seed_mode_required
[ -L "$source/seed-alias" ] || unsupported strict_seed_alias_required
[ -x "$here/confine" ] || unsupported launcher_missing
before_source_mode=$(stat -c %a "$source")
before_seed_mode=$(stat -c %a "$source/seed.txt")
projection() {
    phase=$1
    printf '{"kind":"observation","suite":"direct_strict_source","id":"supervisor_guest_owner_projection","phase":"%s","guestSourceUid":%s,"guestSourceGid":%s,"guestSeedUid":%s,"guestSeedGid":%s,"required":false,"detail":"host_must_verify_ownership_independently"}\n' "$phase" "$(stat -c %u "$source")" "$(stat -c %g "$source")" "$(stat -c %u "$source/seed.txt")" "$(stat -c %g "$source/seed.txt")"
}
projection before
umask 077
mkdir -p /var/lib/cowork-fixture
control=$(mktemp -d /var/lib/cowork-fixture/direct-XXXXXX)
trap 'rm -rf "$control"' EXIT
mkdir -p "$control/memory" "$control/scratch-10001" "$control/scratch-10002"
chgrp 10000 "$control/memory" "$control/scratch-10001" "$control/scratch-10002"
chmod 2777 "$control/memory" "$control/scratch-10001" "$control/scratch-10002"
printf cowork-gate1-instruction > "$control/WINTER.md"
chmod 0444 "$control/WINTER.md"
userns=$(readlink /proc/self/ns/user)
status=0
for view in 'auto 10001' 'auto 10002' 'plan 10001'; do
    set -- $view
    scratch_view=$(mktemp -d "$control/scratch-$2/epoch-$1-XXXXXX")
    chmod 2777 "$scratch_view"
    if "$here/confine" "$1" "$2" "$source" "$control/memory" "$scratch_view" "$control/WINTER.md" "$here/tool-direct.sh" "$userns" "$control"; then :; else
        code=$?; if [ "$code" = 77 ]; then status=77; break; else status=1; fi
    fi
done
projection after
if [ "$before_source_mode" != "$(stat -c %a "$source")" ] || [ "$before_seed_mode" != "$(stat -c %a "$source/seed.txt")" ]; then
    printf '{"kind":"check","suite":"direct_strict_source","id":"source_modes_preserved","status":"fail"}\n'; status=1
else
    printf '{"kind":"check","suite":"direct_strict_source","id":"source_modes_preserved","status":"pass","detail":"host_must_verify_ownership_independently"}\n'
fi
if [ "$status" = 0 ] && [ "$(cat "$source/seed.txt")" != direct-seed-10002 ]; then status=1; fi
printf '{"kind":"observation","id":"direct_production_acl_coverage","status":"unproven","detail":"owner_only_fixture_no_mixed_ownership_acl_or_concurrency_coverage"}\n'
printf '{"kind":"summary","id":"direct_strict_source","status":"%s","exitCode":%s}\n' "$(case "$status" in 0) printf pass;; 77) printf unsupported;; *) printf fail;; esac)" "$status"
exit "$status"
