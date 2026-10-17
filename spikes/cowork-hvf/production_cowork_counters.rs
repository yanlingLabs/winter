//! Process-global production counters for the Cowork worker: flush accounting per disk and the pin
//! high-water marks. They are process-global (not per context) because the context leaves the context
//! map when `krun_start_enter` takes it, and one VM runs per process. Plain atomics: no locks, no
//! allocation, no output, so they are safe to bump from any device thread and to read from any thread.
use std::sync::atomic::{AtomicU64, Ordering};

/// Disks that are counted: the admitted pair (`workspace_disks::DATA_DEVICE`, `ENVIRONMENT_DEVICE`).
pub const FLUSH_SLOTS: usize = 2;

struct FlushSlot {
    requested: AtomicU64,
    completed: AtomicU64,
    final_attempted: AtomicU64,
    final_completed: AtomicU64,
}
impl FlushSlot {
    const fn new() -> Self {
        Self {
            requested: AtomicU64::new(0),
            completed: AtomicU64::new(0),
            final_attempted: AtomicU64::new(0),
            final_completed: AtomicU64::new(0),
        }
    }
}
static FLUSH: [FlushSlot; FLUSH_SLOTS] = [FlushSlot::new(), FlushSlot::new()];
static PIN_HIGH_COUNT: AtomicU64 = AtomicU64::new(0);
static PIN_HIGH_BYTES: AtomicU64 = AtomicU64::new(0);
static PIN_REFUSED: AtomicU64 = AtomicU64::new(0);

fn slot(device: u64) -> Option<&'static FlushSlot> {
    usize::try_from(device).ok().and_then(|index| FLUSH.get(index))
}
/// A guest FLUSH request was captured from the queue.
pub fn flush_requested(device: u64) {
    if let Some(slot) = slot(device) {
        slot.requested.fetch_add(1, Ordering::AcqRel);
    }
}
/// The backing file's flush and `sync_all` returned success for a guest FLUSH request.
pub fn flush_completed(device: u64) {
    if let Some(slot) = slot(device) {
        slot.completed.fetch_add(1, Ordering::AcqRel);
    }
}
/// The final flush at VMM exit ran (and whether it succeeded).
pub fn final_sync(device: u64, ok: bool) {
    if let Some(slot) = slot(device) {
        slot.final_attempted.fetch_add(1, Ordering::AcqRel);
        if ok {
            slot.final_completed.fetch_add(1, Ordering::AcqRel);
        }
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FlushSnapshot {
    pub requested: u64,
    pub completed: u64,
    pub final_attempted: u64,
    pub final_completed: u64,
}
pub fn flush_snapshot() -> [FlushSnapshot; FLUSH_SLOTS] {
    let read = |slot: &FlushSlot| FlushSnapshot {
        requested: slot.requested.load(Ordering::Acquire),
        completed: slot.completed.load(Ordering::Acquire),
        final_attempted: slot.final_attempted.load(Ordering::Acquire),
        final_completed: slot.final_completed.load(Ordering::Acquire),
    };
    [read(&FLUSH[0]), read(&FLUSH[1])]
}

/// A pin was accepted; `count` and `bytes` are the totals after it.
pub fn pin_accepted(count: usize, bytes: u64) {
    PIN_HIGH_COUNT.fetch_max(count as u64, Ordering::AcqRel);
    PIN_HIGH_BYTES.fetch_max(bytes, Ordering::AcqRel);
}
/// A pin was refused because the count or byte budget would be exceeded (the worker then stops).
pub fn pin_refused() {
    PIN_REFUSED.fetch_add(1, Ordering::AcqRel);
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PinSnapshot {
    pub high_water_pins: u64,
    pub high_water_bytes: u64,
    pub budget_refusals: u64,
}
pub fn pin_snapshot() -> PinSnapshot {
    PinSnapshot {
        high_water_pins: PIN_HIGH_COUNT.load(Ordering::Acquire),
        high_water_bytes: PIN_HIGH_BYTES.load(Ordering::Acquire),
        budget_refusals: PIN_REFUSED.load(Ordering::Acquire),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    /// The counters are process-global, so assertions are relative to a snapshot taken first.
    #[test]
    fn flush_counters_count_per_disk_and_ignore_other_devices() {
        let before = flush_snapshot();
        flush_requested(0);
        flush_requested(0);
        flush_requested(1);
        flush_completed(0);
        final_sync(1, true);
        final_sync(1, false);
        flush_requested(2);
        flush_completed(u64::MAX);
        final_sync(7, true);
        let after = flush_snapshot();
        assert_eq!(after[0].requested - before[0].requested, 2);
        assert_eq!(after[0].completed - before[0].completed, 1);
        assert_eq!(after[1].requested - before[1].requested, 1);
        assert_eq!(after[1].completed - before[1].completed, 0);
        assert_eq!(after[1].final_attempted - before[1].final_attempted, 2);
        assert_eq!(after[1].final_completed - before[1].final_completed, 1);
        assert_eq!(after[0].final_attempted, before[0].final_attempted);
    }
    #[test]
    fn pin_high_water_only_rises() {
        pin_accepted(3, 100);
        let high = pin_snapshot();
        pin_accepted(1, 10);
        let same = pin_snapshot();
        assert_eq!((same.high_water_pins, same.high_water_bytes), (high.high_water_pins, high.high_water_bytes));
        pin_accepted(high.high_water_pins as usize + 5, high.high_water_bytes + 7);
        let raised = pin_snapshot();
        assert_eq!(raised.high_water_pins, high.high_water_pins + 5);
        assert_eq!(raised.high_water_bytes, high.high_water_bytes + 7);
        let refused = pin_snapshot().budget_refusals;
        pin_refused();
        assert_eq!(pin_snapshot().budget_refusals, refused + 1);
    }
}
