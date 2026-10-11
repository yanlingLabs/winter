// Bare-metal fixture only. x1..x2 is a guest-owned data range, x3 is the
// unmapped completion doorbell, x5 is the word to fill/verify, x4 is mismatches.+.text
.p2align 2
.global _cowork_fill_start, _cowork_fill_end
_cowork_fill_start:
1: str x5, [x1], #8
   cmp x1, x2
   b.lo 1b
   str xzr, [x3]
2: wfi
   b 2b
_cowork_fill_end:
.p2align 2
.global _cowork_verify_start, _cowork_verify_end
_cowork_verify_start:
1: ldr x6, [x1], #8
   cmp x6, x5
   cinc x4, x4, ne
   cmp x1, x2
   b.lo 1b
   str x4, [x3]
2: wfi
   b 2b
_cowork_verify_end:
