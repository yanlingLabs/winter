//! Per-VM host-RAM admission/pins. Pure implementation; no raw guest-memory or OS mapping APIs.
use std::collections::BTreeMap;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Device {
    id: u64,
    generation: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Range {
    pub gpa: u64,
    pub len: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fault {
    Stopped,
    Frozen,
    Stale,
    Duplicate,
    Overflow,
    Limit,
    InvalidRange,
    Busy,
    Timeout,
    Epoch,
    Mutation,
}
struct State {
    stopped: bool,
    closed: Option<u64>,
    last_epoch: u64,
    devices: BTreeMap<u64, u64>,
    active: usize,
    pins: BTreeMap<u64, (Device, Vec<Range>)>,
    next_pin: u64,
    pinned_bytes: u64,
}
struct Inner {
    state: Mutex<State>,
    wake: Condvar,
    max_devices: usize,
    max_pins: usize,
    max_pinned_bytes: u64,
}
#[derive(Clone)]
pub struct Access {
    inner: Arc<Inner>,
}
pub struct Lease {
    inner: Arc<Inner>,
    device: Device,
}
pub struct Pin {
    inner: Arc<Inner>,
    id: u64,
}
pub struct Frozen {
    inner: Arc<Inner>,
    epoch: u64,
    mutation: bool,
    mapping_complete: bool,
    finished: bool,
    ranges: Vec<Range>,
}
fn valid(state: &State, device: Device) -> Result<(), Fault> {
    if state.stopped {
        return Err(Fault::Stopped);
    }
    if state.devices.get(&device.id) != Some(&device.generation) {
        return Err(Fault::Stale);
    }
    Ok(())
}
impl Access {
    pub fn new(max_devices: usize, max_pins: usize, max_pinned_bytes: u64) -> Self {
        Self {
            inner: Arc::new(Inner {
                state: Mutex::new(State {
                    stopped: false,
                    closed: None,
                    last_epoch: 0,
                    devices: BTreeMap::new(),
                    active: 0,
                    pins: BTreeMap::new(),
                    next_pin: 0,
                    pinned_bytes: 0,
                }),
                wake: Condvar::new(),
                max_devices,
                max_pins,
                max_pinned_bytes,
            }),
        }
    }
    pub fn register(&self, id: u64) -> Result<Device, Fault> {
        let mut state = self.inner.state.lock().unwrap();
        if state.stopped {
            return Err(Fault::Stopped);
        }
        if state.closed.is_some() {
            return Err(Fault::Frozen);
        }
        if state.devices.contains_key(&id) {
            return Err(Fault::Duplicate);
        }
        if state.devices.len() >= self.inner.max_devices {
            return Err(Fault::Limit);
        }
        state.devices.insert(id, 1);
        Ok(Device { id, generation: 1 })
    }
    pub fn begin(&self, device: Device) -> Result<Lease, Fault> {
        let mut state = self.inner.state.lock().unwrap();
        valid(&state, device)?;
        if state.closed.is_some() {
            return Err(Fault::Frozen);
        }
        state.active = state.active.checked_add(1).ok_or(Fault::Overflow)?;
        Ok(Lease {
            inner: self.inner.clone(),
            device,
        })
    }
    pub fn wait_begin(&self, device: Device, timeout: Duration) -> Result<Lease, Fault> {
        let deadline = Instant::now() + timeout;
        let mut state = self.inner.state.lock().unwrap();
        loop {
            valid(&state, device)?;
            if state.closed.is_none() {
                state.active = state.active.checked_add(1).ok_or(Fault::Overflow)?;
                return Ok(Lease {
                    inner: self.inner.clone(),
                    device,
                });
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(Fault::Timeout);
            }
            let (next, _) = self.inner.wake.wait_timeout(state, remaining).unwrap();
            state = next;
        }
    }
    /// Invalidate old completions only after all memory copies drain; reset owner supplies this call.
    pub fn reset_generation(&self, device: Device) -> Result<Device, Fault> {
        let mut state = self.inner.state.lock().unwrap();
        valid(&state, device)?;
        if state.closed.is_some() {
            return Err(Fault::Frozen);
        }
        if state.active != 0 {
            return Err(Fault::Busy);
        }
        let generation = device.generation.checked_add(1).ok_or(Fault::Overflow)?;
        state.devices.insert(device.id, generation);
        self.inner.wake.notify_all();
        Ok(Device {
            id: device.id,
            generation,
        })
    }
    /// Called only AFTER exact CPU park and with NO VMM/device/disk mutex held by the caller.
    pub fn freeze(&self, epoch: u64, timeout: Duration) -> Result<Frozen, Fault> {
        let deadline = Instant::now() + timeout;
        let mut state = self.inner.state.lock().unwrap();
        if state.stopped {
            return Err(Fault::Stopped);
        }
        if state.closed.is_some() {
            return Err(Fault::Frozen);
        }
        if epoch == 0 || epoch <= state.last_epoch {
            return Err(Fault::Epoch);
        }
        state.last_epoch = epoch;
        state.closed = Some(epoch);
        while state.active != 0 {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                state.stopped = true;
                self.inner.wake.notify_all();
                return Err(Fault::Timeout);
            }
            let (waited, _) = self.inner.wake.wait_timeout(state, remaining).unwrap();
            state = waited;
            if state.stopped {
                return Err(Fault::Stopped);
            }
        }
        let ranges = state
            .pins
            .values()
            .flat_map(|(_, ranges)| ranges.iter().copied())
            .collect();
        Ok(Frozen {
            inner: self.inner.clone(),
            epoch,
            mutation: false,
            mapping_complete: false,
            finished: false,
            ranges,
        })
    }
    pub fn stopped(&self) -> bool {
        self.inner.state.lock().unwrap().stopped
    }
    pub fn active_leases(&self) -> usize {
        self.inner.state.lock().unwrap().active
    }
    pub fn stop(&self) {
        let mut s = self.inner.state.lock().unwrap();
        s.stopped = true;
        self.inner.wake.notify_all();
    }
}
impl Lease {
    pub fn check(&self, access: &Access, device: Device) -> Result<(), Fault> {
        if !Arc::ptr_eq(&self.inner, &access.inner) || self.device != device {
            return Err(Fault::Stale);
        }
        valid(&self.inner.state.lock().unwrap(), device)
    }
    pub fn pin(&self, ranges: &[Range]) -> Result<Pin, Fault> {
        let mut bytes = 0u64;
        if ranges.is_empty() {
            return Err(Fault::InvalidRange);
        }
        for r in ranges {
            if r.len == 0 || r.gpa.checked_add(r.len).is_none() {
                return Err(Fault::InvalidRange);
            }
            bytes = bytes.checked_add(r.len).ok_or(Fault::Overflow)?;
        }
        let mut state = self.inner.state.lock().unwrap();
        valid(&state, self.device)?;
        // A lease already active when admission closes may finish its copy and publish pins.
        // freeze waits for that lease to drop before taking its exclusion snapshot.
        let total = state
            .pinned_bytes
            .checked_add(bytes)
            .ok_or(Fault::Overflow)?;
        if state.pins.len() >= self.inner.max_pins || total > self.inner.max_pinned_bytes {
            return Err(Fault::Limit);
        }
        state.next_pin = state.next_pin.checked_add(1).ok_or(Fault::Overflow)?;
        let id = state.next_pin;
        state.pins.insert(id, (self.device, ranges.to_vec()));
        state.pinned_bytes = total;
        Ok(Pin {
            inner: self.inner.clone(),
            id,
        })
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        let mut s = self.inner.state.lock().unwrap();
        s.active = s.active.checked_sub(1).expect("lease accounting");
        self.inner.wake.notify_all();
    }
}
impl Drop for Pin {
    fn drop(&mut self) {
        let mut s = self.inner.state.lock().unwrap();
        if let Some((_, ranges)) = s.pins.remove(&self.id) {
            let bytes: u64 = ranges.iter().map(|r| r.len).sum();
            s.pinned_bytes = s.pinned_bytes.checked_sub(bytes).expect("pin accounting");
        }
        self.inner.wake.notify_all();
    }
}
impl Frozen {
    pub fn exclusions(&self) -> &[Range] {
        &self.ranges
    }
    pub fn begin_mutation(&mut self) -> Result<(), Fault> {
        let s = self.inner.state.lock().unwrap();
        if s.stopped {
            return Err(Fault::Stopped);
        }
        if s.closed != Some(self.epoch) || s.active != 0 {
            return Err(Fault::Epoch);
        }
        if self.mutation {
            return Err(Fault::Mutation);
        }
        self.mutation = true;
        Ok(())
    }
    pub fn complete_mutation(&mut self) -> Result<(), Fault> {
        let s = self.inner.state.lock().unwrap();
        if s.stopped {
            return Err(Fault::Stopped);
        }
        if s.closed != Some(self.epoch) || !self.mutation {
            return Err(Fault::Mutation);
        }
        self.mapping_complete = true;
        Ok(())
    }
    pub fn resume(mut self) -> Result<(), Fault> {
        let mut s = self.inner.state.lock().unwrap();
        if s.stopped {
            return Err(Fault::Stopped);
        }
        if s.closed != Some(self.epoch) {
            return Err(Fault::Epoch);
        }
        if self.mutation && !self.mapping_complete {
            s.stopped = true;
            self.finished = true;
            self.inner.wake.notify_all();
            return Err(Fault::Mutation);
        }
        s.closed = None;
        self.finished = true;
        self.inner.wake.notify_all();
        Ok(())
    }
    pub fn abort(mut self) {
        self.inner.state.lock().unwrap().stopped = true;
        self.finished = true;
        self.inner.wake.notify_all();
    }
}
impl Drop for Frozen {
    fn drop(&mut self) {
        if !self.finished {
            self.inner.state.lock().unwrap().stopped = true;
            self.inner.wake.notify_all();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;
    fn access() -> (Access, Device) {
        let a = Access::new(2, 8, 1024 * 1024);
        let d = a.register(7).unwrap();
        (a, d)
    }
    #[test]
    fn freeze_denies_new_access_and_snapshots_pinned_io_with_zero_readers() {
        let (a, d) = access();
        let lease = a.begin(d).unwrap();
        let pin = lease
            .pin(&[Range {
                gpa: 0x1000,
                len: 4096,
            }])
            .unwrap();
        drop(lease);
        let frozen = a.freeze(1, Duration::from_secs(1)).unwrap();
        assert_eq!(a.active_leases(), 0);
        assert!(matches!(a.begin(d), Err(Fault::Frozen)));
        assert_eq!(
            frozen.exclusions(),
            [Range {
                gpa: 0x1000,
                len: 4096
            }]
        );
        frozen.resume().unwrap();
        drop(pin);
        assert!(a.begin(d).is_ok());
    }
    #[test]
    fn drain_waits_for_short_copy_without_blocking_lease_drop() {
        let (a, d) = access();
        let lease = a.begin(d).unwrap();
        let other = a.clone();
        let thread = thread::spawn(move || other.freeze(1, Duration::from_secs(1)));
        thread::sleep(Duration::from_millis(10));
        assert!(!thread.is_finished());
        drop(lease);
        thread.join().unwrap().unwrap().resume().unwrap();
    }
    #[test]
    fn no_implicit_resume_after_partial_mutation_or_abandoned_freeze() {
        for mutation in [false, true] {
            let (a, d) = access();
            let mut frozen = a.freeze(1, Duration::from_secs(1)).unwrap();
            if mutation {
                frozen.begin_mutation().unwrap();
            }
            drop(frozen);
            assert!(a.stopped());
            assert!(matches!(a.begin(d), Err(Fault::Stopped)));
        }
    }
    #[test]
    fn resume_requires_explicit_complete_mapping_transaction() {
        for complete in [false, true] {
            let (a, d) = access();
            let mut frozen = a.freeze(1, Duration::from_secs(1)).unwrap();
            frozen.begin_mutation().unwrap();
            if complete {
                frozen.complete_mutation().unwrap();
                assert!(frozen.resume().is_ok());
                assert!(a.begin(d).is_ok());
            } else {
                assert_eq!(frozen.resume(), Err(Fault::Mutation));
                assert!(a.stopped());
            }
        }
    }
    #[test]
    fn explicit_abort_keeps_gate_closed() {
        let (a, d) = access();
        a.freeze(1, Duration::from_secs(1)).unwrap().abort();
        assert!(a.stopped());
        assert!(matches!(a.begin(d), Err(Fault::Stopped)));
    }
    #[test]
    fn waiting_completion_wakes_on_resume_and_stop() {
        for stop in [false, true] {
            let (a, d) = access();
            let frozen = a.freeze(1, Duration::from_secs(1)).unwrap();
            let other = a.clone();
            let worker = thread::spawn(move || other.wait_begin(d, Duration::from_secs(1)));
            if stop {
                a.stop();
                drop(frozen);
                assert!(matches!(worker.join().unwrap(), Err(Fault::Stopped)));
            } else {
                frozen.resume().unwrap();
                assert!(worker.join().unwrap().is_ok());
            }
        }
    }
    #[test]
    fn stopped_or_stale_generation_never_reenters_ram() {
        let (a, d) = access();
        let newer = a.reset_generation(d).unwrap();
        assert!(matches!(a.begin(d), Err(Fault::Stale)));
        assert!(a.begin(newer).is_ok());
        a.stop();
        assert!(matches!(a.begin(newer), Err(Fault::Stopped)));
    }
    #[test]
    fn timeout_stops_gate_and_preserves_outstanding_lease() {
        let (a, d) = access();
        let lease = a.begin(d).unwrap();
        assert!(matches!(
            a.freeze(1, Duration::from_millis(1)),
            Err(Fault::Timeout)
        ));
        assert!(a.stopped());
        drop(lease);
        assert_eq!(a.active_leases(), 0);
    }
    #[test]
    fn pins_budget_and_overflow_are_checked_before_recording() {
        let (a, d) = access();
        let lease = a.begin(d).unwrap();
        assert!(matches!(
            lease.pin(&[Range {
                gpa: u64::MAX,
                len: 1
            }]),
            Err(Fault::InvalidRange)
        ));
        assert!(matches!(
            lease.pin(&[Range {
                gpa: 0,
                len: 2 * 1024 * 1024
            }]),
            Err(Fault::Limit)
        ));
        drop(lease);
        assert!(a
            .freeze(1, Duration::from_secs(1))
            .unwrap()
            .exclusions()
            .is_empty());
    }
}
