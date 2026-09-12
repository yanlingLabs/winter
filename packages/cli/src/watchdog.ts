// Pure stall-detection state for `winter -p`. No timers, no wall-clock reads — every function
// takes `now` as an argument so the logic can be tested deterministically with synthetic
// timelines. The only real setInterval/Date.now() calls live in main.ts's wiring.
export interface WatchdogState { turnRunning: boolean; toolsInFlight: number; approvalsPending: number; lastEventAt: number }

export function applyEvent(s: WatchdogState, e: { type: string }, now: number): void {
  s.lastEventAt = now;
  switch (e.type) {
    case "turn_started": s.turnRunning = true; s.toolsInFlight = 0; s.approvalsPending = 0; break;
    case "turn_completed": s.turnRunning = false; break;
    case "tool_call": s.toolsInFlight++; break;
    case "tool_result": s.toolsInFlight = Math.max(0, s.toolsInFlight - 1); break;
    case "approval_requested": s.approvalsPending++; break;
    case "approval_resolved": s.approvalsPending = Math.max(0, s.approvalsPending - 1); break;
  }
}

// A stall means: the turn is running, nothing is in flight (no tool executing, no approval
// awaiting a human), and no event has landed for longer than the threshold. Any in-flight work
// or pending approval is legitimate silence, not a stall.
export function isStalled(s: WatchdogState, now: number, thresholdMs: number): boolean {
  return s.turnRunning && s.toolsInFlight === 0 && s.approvalsPending === 0 && (now - s.lastEventAt) > thresholdMs;
}
