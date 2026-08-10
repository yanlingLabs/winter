#!/usr/bin/env python3
"""Derive every number in docs/research/2026-08-10-cef-reparent-spike.md from a spike run.

    ./analyze-spike-ledger.py spike.log [cpu.txt]

`spike.log` is the stderr ledger of a `NORMA_SPIKE_REPARENT=1` run; `cpu.txt` is cpusample.sh's
output for the same run. Prints, per long phase (parked / visible):

  * rAF fps and setInterval Hz          -> §4's "nothing throttles"
  * document.visibilityState             -> §4's "Chromium still thinks it is visible"
  * wall - AudioContext.currentTime, and the per-slice deltas -> §1's audio continuity
  * total CPU as % of one core, by role  -> §4's table

ONLY the WITHIN-RUN parked-vs-visible comparison is meaningful. The absolute fps and CPU numbers
track the display's refresh state, which is outside the spike's control and swings ~2x between
runs; §4 of the document says so and this script prints both phases side by side for that reason.

The page's title payload, index by index:
  0 'NS'  1 seq  2 performance.now()  3 media-time ms  4 AudioContext.currentTime ms  5 rAF count
  6 timer ticks  7 keys  8 visibilityState[0]  9 innerWidth  10 innerHeight  11 audio.paused
  12 AudioContext.state[0]  13 activeElement.id  14 field length  15 last key  16 background colour
"""
import collections, re, sys


def gi(f, i):
    try:
        return int(f[i])
    except (IndexError, ValueError):
        return -1


def samples(lines):
    """(spike_ms, payload_fields, tag, phase) for every ledger line carrying a page sample."""
    out = []
    for L in lines:
        if not L.startswith("SPIKE"):
            continue
        m = re.search(r"(?:sample=|title=)(NS\|[^\s]+)", L)
        if not m:
            continue
        tag = re.search(r"tag=(\S+)", L)
        ph = re.search(r"phase=(\S+)", L)
        out.append((int(L.split()[1]), m.group(1).split("|"),
                    tag.group(1) if tag else "", ph.group(1) if ph else ""))
    return out


def cputime(t):
    """`ps -o time` — MM:SS.ss or HH:MM:SS.ss. A colon-less field means the sampler emitted
    `%cpu` instead, which is a LIFETIME AVERAGE and cannot answer a phase question; refuse it
    loudly rather than silently computing nonsense (that mistake is trap 5 in the document)."""
    p = t.split(":")
    if len(p) == 1:
        raise SystemExit(f"cpu file holds '%cpu' ({t!r}), not `ps -o time` — re-sample with cpusample.sh")
    return int(p[0]) * 60 + float(p[1]) if len(p) == 2 else int(p[0]) * 3600 + int(p[1]) * 60 + float(p[2])


def main():
    lines = open(sys.argv[1], errors="replace").read().splitlines()
    S = samples(lines)
    mode = next((L.split("parkMode=")[1].split()[0] for L in lines if "BEGIN parkMode" in L), "?")
    reparents = sum(1 for L in lines if re.search(r"^SPIKE \d+ (ATTACH|DETACH) ", L))
    print(f"{sys.argv[1]}  parkMode={mode}  reparents={reparents}")

    cpu = collections.defaultdict(list)
    t_app0 = None
    if len(sys.argv) > 2:
        rows = [l.split() for l in open(sys.argv[2]) if l.strip()]
        for ts, pid, tm, rss, role in rows:
            cpu[(pid, role)].append((int(ts), cputime(tm)))
        t_app0 = min(int(r[0]) for r in rows if r[4] == "app")

    for label, prefix in (("PARKED ", "long-parked"), ("VISIBLE", "long-visible")):
        w = [s for s in S if s[2].startswith(prefix)]
        if len(w) == 1:
            # A run from before the long phases were sliced at 5 s (runs 1-2) logs ONE sample per
            # long phase. Bracket it with the nearest preceding sample already in the same phase —
            # which is what produced runs 1-2's published figures, and is why every one of the nine
            # ledgers stays re-derivable by this script.
            ph = "parked" if "parked" in prefix else "visible"
            prev = [s for s in S if s[0] < w[0][0] and (s[3] == ph or s[2] == ph)]
            if prev:
                w = [prev[-1], w[0]]
        if len(w) < 2:
            print(f"  {label} (no window — run with NORMA_SPIKE_LONG_DWELL>=10)")
            continue
        f0, f1 = w[0][1], w[-1][1]
        dt = (gi(f1, 2) - gi(f0, 2)) / 1000.0
        drift = [gi(s[1], 2) - gi(s[1], 4) for s in w]
        deltas = [drift[i + 1] - drift[i] for i in range(len(drift) - 1)]
        print(f"  {label} span={dt:5.1f}s  rAF={(gi(f1,5)-gi(f0,5))/dt:7.1f}fps  "
              f"timer={(gi(f1,6)-gi(f0,6))/dt:5.2f}Hz  vis={set(s[1][8] for s in w)}")
        print(f"          wall-ctx {drift[0]}->{drift[-1]}ms   per-slice deltas={deltas}")
        if not cpu:
            continue
        a, b = t_app0 + w[0][0], t_app0 + w[-1][0]
        tot, det = 0.0, collections.Counter()
        for (pid, role), pts in cpu.items():
            inw = [p for p in pts if a <= p[0] <= b]
            if len(inw) < 2:
                continue
            d = (inw[-1][1] - inw[0][1]) / ((inw[-1][0] - inw[0][0]) / 1000.0) * 100
            det[role] += d
            tot += d
        print(f"          CPU total={tot:5.1f}% of one core   " +
              "  ".join(f"{k}={v:.1f}%" for k, v in sorted(det.items())))

    # §5: a state callback whose title did not change did NOT come from OnTitleChange.
    n = sum(1 for L in lines if "STATE-NOT-A-TITLE-CHANGE" in L)
    late = [L for L in lines if "STATE-NOT-A-TITLE-CHANGE" in L and int(L.split()[1]) > 1000]
    print(f"  non-OnTitleChange state callbacks: {n} total, {len(late)} after the first second "
          f"({'NONE fired by a reparent' if not late else 'INVESTIGATE'})")


if __name__ == "__main__":
    main()
