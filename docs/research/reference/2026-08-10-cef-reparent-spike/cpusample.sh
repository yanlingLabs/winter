#!/bin/zsh
# The CPU sampler behind §4 of docs/research/2026-08-10-cef-reparent-spike.md.
#
# Two things about it are load-bearing:
#
#  1. It records CUMULATIVE CPU TIME (`ps -o time`), not `%cpu`. `ps -o %cpu` is a LIFETIME
#     AVERAGE — it converges on the mean since process start and cannot answer a phase question
#     ("what did this cost while parked?") at all. The first version of this sampler used it and
#     produced numbers that looked fine and meant nothing. Instantaneous cost is the difference of
#     two cumulative readings divided by the wall time between them (see analyze-spike-ledger.py).
#  2. It filters on `norma-dd-spike`, the spike build's derivedData path, so it can never sample
#     the user's own running dev app — a different bundle at a different path, same bundle id.
#
# Usage:  ./cpusample.sh [seconds] > cpu.txt      (run it ~1s BEFORE launching the spike)
# Output: epoch_ms  pid  cputime  rss_kb  role
end=$(( $(date +%s) + ${1:-320} ))
while [ $(date +%s) -lt $end ]; do
  ts=$(python3 -c 'import time;print(int(time.time()*1000))')
  ps -Ao pid=,time=,rss=,command= | grep 'norma-dd-spike' | grep -v grep | while read -r pid tm rss rest; do
    role="app"
    case "$rest" in
      *--type=renderer*) role="renderer" ;;
      *--type=gpu-process*) role="gpu" ;;
      *--type=utility*) role="utility" ;;
      *Helper*) role="helper-other" ;;
    esac
    echo "$ts $pid $tm $rss $role"
  done
  sleep 1
done
