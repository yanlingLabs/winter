import NormaProtocol

/// Pure resume-decision logic shared by the gateway (Task 5): given a client's replay cursor and
/// the host's high watermark for a stream, decide whether to replay events, report up-to-date, or
/// demand a snapshot — and, separately, compute the exact slice of already-fetched events to
/// replay. No I/O; safe to unit-test in isolation from the daemon/gateway plumbing.
public enum ResumePlanner {
    /// Decides the per-stream resume verdict.
    ///
    /// - `fromSeq > highWatermark`: the client's cursor is ahead of what the host has — the
    ///   client must fetch a full snapshot (`.snapshotRequired`).
    /// - `fromSeq == highWatermark`: the client is already caught up (`.upToDate`).
    /// - `fromSeq < highWatermark`: the client is behind but within range — replay from `fromSeq`
    ///   (exclusive) up to `highWatermark` (`.replayBegin`).
    public static func verdict(fromSeq: Int, highWatermark: Int, sessionID: String) -> ResumeVerdict {
        if fromSeq > highWatermark {
            return .snapshotRequired(sessionID: sessionID, reason: "cursor-ahead", oldestAvailableSeq: 0)
        } else if fromSeq == highWatermark {
            return .upToDate(sessionID: sessionID, highWatermark: highWatermark)
        } else {
            return .replayBegin(sessionID: sessionID, fromSeq: fromSeq, highWatermark: highWatermark)
        }
    }

    /// Returns the subset of `events` with `seqOf(e) > fromSeq`, order preserved — mirrors the
    /// daemon's exclusive-`fromSeq` semantics (hub.ts read filter).
    public static func replaySlice<E>(events: [E], fromSeq: Int, seqOf: (E) -> Int) -> [E] {
        events.filter { seqOf($0) > fromSeq }
    }
}
