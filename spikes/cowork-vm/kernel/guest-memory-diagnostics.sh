#!/bin/sh
# Trusted fixture-only diagnostic, read-only. No host pressure, page allocation,
# kernel setting changes or attempts to reach the Mac are performed here.
set -eu
[ "$(uname -s)" = Linux ] || exit 77
printf '{"kind":"kernel","release":"%s","machine":"%s"}\n' "$(uname -r)" "$(uname -m)"
found=false
for dir in /sys/bus/virtio/devices/virtio*; do
    [ -r "$dir/device" ] || continue
    case "$(cat "$dir/device")" in 0x0005|0x00000005|0x5|5) :;; *) continue;; esac
    features=$(cat "$dir/features")
    case "$features" in ''|*[!01]*) exit 77;; esac
    [ "${#features}" -ge 6 ] && [ "${#features}" -le 128 ] || exit 77
    printf '{"kind":"virtio-balloon","device":"%s","features":"%s","bitOrder":"least-feature-index-first","hostReclaimVerified":false}\n' "${dir##*/}" "$features"
    found=true
done
printf '{"kind":"balloon-discovery","found":%s,"hostReclaimVerified":false}\n' "$found"
if [ -r /proc/config.gz ]; then
    gzip -dc /proc/config.gz | awk '
        /^CONFIG_(VIRTIO_BALLOON|MEMORY_BALLOON|COMPACTION|BALLOON_COMPACTION|PAGE_REPORTING|ARM64_4K_PAGES|ARM64_16K_PAGES|ARM64_64K_PAGES)=/ { split($0,a,"="); printf "{\"kind\":\"kernel-config\",\"name\":\"%s\",\"value\":\"%s\"}\n",a[1],a[2] }
        /^# CONFIG_(VIRTIO_BALLOON|MEMORY_BALLOON|COMPACTION|BALLOON_COMPACTION|PAGE_REPORTING|ARM64_4K_PAGES|ARM64_16K_PAGES|ARM64_64K_PAGES) is not set/ { printf "{\"kind\":\"kernel-config\",\"name\":\"%s\",\"value\":\"n\"}\n",$2 }
    '
else
    printf '{"kind":"kernel-config","status":"unavailable","detail":"proc_config_gz_missing"}\n'
fi
