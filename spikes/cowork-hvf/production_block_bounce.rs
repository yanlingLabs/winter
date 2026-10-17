//! Shared guarded block pipeline. Host I/O receives only owned buffers, never guest pointers/slices.
use crate::reclaim_access::{Access, Device, Fault, Lease, Pin, Range};
pub const CHUNK: usize = 64 * 1024;
pub const MAX_REQUEST: usize = 1024 * 1024;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Command {
    Read,
    Write,
    Flush,
    GetId,
    Unsupported,
}
#[derive(Clone, Debug)]
pub struct Captured {
    pub command: Command,
    pub sector: u64,
    pub length: usize,
    pub head: u16,
    pub queue_generation: u64,
    pub protected: Vec<Range>,
    pub write_payload: Vec<u8>,
}
#[derive(Debug)]
pub struct Outcome {
    pub success: bool,
    pub data: Vec<u8>,
    pub unsupported: bool,
}
pub trait Port {
    fn capture(&mut self, lease: &Lease) -> Result<Option<Captured>, Fault>;
    fn complete(
        &mut self,
        lease: &Lease,
        request: &Captured,
        outcome: &Outcome,
    ) -> Result<(), Fault>;
}
pub trait Disk {
    fn capacity(&self) -> u64;
    fn read(&mut self, offset: u64, target: &mut [u8]) -> Result<usize, ()>;
    fn write(&mut self, offset: u64, bytes: &[u8]) -> Result<usize, ()>;
    fn flush(&mut self) -> Result<(), ()>;
    fn id(&self) -> &[u8];
}
pub struct Work {
    request: Captured,
    pin: Option<Pin>,
    device: Device,
}
pub struct Completion {
    work: Work,
    pub outcome: Outcome,
}
fn validate(request: &Captured) -> Result<(), Fault> {
    if request.length > MAX_REQUEST || request.protected.is_empty() || request.protected.len() > 512
    {
        return Err(Fault::Limit);
    }
    if matches!(request.command, Command::Read | Command::Write) && request.length % 512 != 0 {
        return Err(Fault::InvalidRange);
    }
    request
        .sector
        .checked_mul(512)
        .and_then(|offset| offset.checked_add(request.length as u64))
        .ok_or(Fault::Overflow)?;
    if request.command == Command::Write && request.write_payload.len() != request.length {
        return Err(Fault::InvalidRange);
    }
    if request.command != Command::Write && !request.write_payload.is_empty() {
        return Err(Fault::InvalidRange);
    }
    Ok(())
}
pub fn capture(
    access: &Access,
    device: Device,
    port: &mut impl Port,
) -> Result<Option<Work>, Fault> {
    let lease = access.begin(device)?;
    let request = match port.capture(&lease)? {
        Some(request) => request,
        None => return Ok(None),
    };
    validate(&request)?;
    if request.command == Command::Flush {
        crate::cowork_counters::flush_requested(device.id());
    }
    let pin = lease.pin(&request.protected)?;
    drop(lease); // No memory lease survives into Work or the blocking host I/O function.
    Ok(Some(Work {
        request,
        pin: Some(pin),
        device,
    }))
}
pub fn perform(work: Work, disk: &mut impl Disk) -> Completion {
    let request = &work.request;
    let offset = request.sector.checked_mul(512);
    let mut outcome = Outcome {
        success: false,
        data: Vec::new(),
        unsupported: request.command == Command::Unsupported,
    };
    if let Some(offset) = offset {
        let within = offset
            .checked_add(request.length as u64)
            .is_some_and(|end| end <= disk.capacity());
        outcome.success = match request.command {
            Command::Read if within => {
                let mut data = vec![0u8; request.length];
                let mut done = 0;
                let mut good = true;
                while done < data.len() {
                    let limit = (done + CHUNK).min(data.len());
                    let mut part = done;
                    while part < limit {
                        match disk.read(offset + part as u64, &mut data[part..limit]) {
                            Ok(n) if n > 0 && n <= limit - part => part += n,
                            _ => {
                                good = false;
                                break;
                            }
                        }
                    }
                    if !good {
                        break;
                    }
                    done = limit;
                }
                if good {
                    outcome.data = data;
                }
                good
            }
            Command::Write if within => {
                let mut done = 0;
                let mut good = true;
                while done < request.write_payload.len() {
                    let limit = (done + CHUNK).min(request.write_payload.len());
                    let mut part = done;
                    while part < limit {
                        match disk.write(offset + part as u64, &request.write_payload[part..limit])
                        {
                            Ok(n) if n > 0 && n <= limit - part => part += n,
                            _ => {
                                good = false;
                                break;
                            }
                        }
                    }
                    if !good {
                        break;
                    }
                    done = limit;
                }
                good
            }
            Command::Flush => {
                let flushed = disk.flush().is_ok();
                if flushed {
                    crate::cowork_counters::flush_completed(work.device.id());
                }
                flushed
            }
            Command::GetId
                if disk.id().len() <= request.length && disk.id().len() <= MAX_REQUEST =>
            {
                outcome.data = disk.id().to_vec();
                true
            }
            _ => false,
        };
    }
    Completion { work, outcome }
}
/// Frozen returns an error with Completion still owned by the caller, preserving its range pins.
pub fn complete(
    access: &Access,
    completion: &mut Completion,
    port: &mut impl Port,
) -> Result<(), Fault> {
    if completion.work.pin.is_none() {
        return Err(Fault::Duplicate);
    }
    let lease = access.begin(completion.work.device)?;
    port.complete(&lease, &completion.work.request, &completion.outcome)?;
    completion.work.pin.take();
    drop(lease);
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
pub enum Step {
    Empty,
    Completed,
    Stopped,
}
/// One actual worker transaction, also exercised without epoll/VM. Caller holds no VMM/device lock.
pub fn service_next(
    access: &Access,
    device: Device,
    port: &mut impl Port,
    disk: &mut impl Disk,
    stopped: impl Fn() -> bool,
) -> Result<Step, Fault> {
    service_next_fixture(
        access,
        device,
        port,
        disk,
        stopped,
        std::time::Duration::ZERO,
    )
}
pub fn service_next_fixture(
    access: &Access,
    device: Device,
    port: &mut impl Port,
    disk: &mut impl Disk,
    stopped: impl Fn() -> bool,
    hold: std::time::Duration,
) -> Result<Step, Fault> {
    use std::time::{Duration, Instant};
    let wait = || -> Result<bool, Fault> {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if stopped() || access.stopped() {
                return Ok(false);
            }
            match access.wait_begin(device, Duration::from_millis(10)) {
                Ok(lease) => {
                    drop(lease);
                    return Ok(true);
                }
                Err(Fault::Timeout) if Instant::now() < deadline => {}
                Err(fault) => return Err(fault),
            }
        }
    };
    let work = loop {
        if stopped() || access.stopped() {
            return Ok(Step::Stopped);
        }
        match capture(access, device, port) {
            Ok(Some(work)) => break work,
            Ok(None) => return Ok(Step::Empty),
            Err(Fault::Frozen) => {
                if !wait()? {
                    return Ok(Step::Stopped);
                }
            }
            Err(fault) => return Err(fault),
        }
    };
    // This stop check and every disk call happen with no RAM lease.
    if stopped() || access.stopped() {
        return Ok(Step::Stopped);
    }
    let request = work.request.clone();
    let pin = work.pin.as_ref().unwrap().identity();
    let id = crate::block_trace::next_request()?;
    crate::block_trace::emit("block_request_capture",format!("\"request\":{},\"pin\":{},\"head\":{},\"generation\":{},\"command\":\"{:?}\",\"sector\":{},\"length\":{},\"leaseReleased\":true,\"ranges\":{}",id,pin,request.head,request.queue_generation,request.command,request.sector,request.length,crate::block_trace::ranges(&request.protected)))?;
    crate::block_trace::emit("block_owned_io_begin", format!("\"request\":{}", id))?;
    let mut completion = perform(work, disk);
    crate::block_trace::emit(
        "block_owned_io_end",
        format!(
            "\"request\":{},\"success\":{},\"dataBytes\":{}",
            id,
            completion.outcome.success,
            completion.outcome.data.len()
        ),
    )?;
    if !hold.is_zero() {
        crate::block_trace::emit(
            "block_owned_completion_hold",
            format!(
                "\"request\":{},\"millis\":{},\"osSyscallBlocked\":false",
                id,
                hold.as_millis()
            ),
        )?;
        let deadline = Instant::now() + hold;
        while Instant::now() < deadline {
            if stopped() || access.stopped() {
                return Ok(Step::Stopped);
            }
            std::thread::sleep(
                deadline
                    .saturating_duration_since(Instant::now())
                    .min(Duration::from_millis(5)),
            );
        }
    }
    let mut deferred = false;
    loop {
        if stopped() || access.stopped() {
            return Ok(Step::Stopped);
        }
        match complete(access, &mut completion, port) {
            Ok(()) => {
                crate::block_trace::emit(
                    "block_used_ack",
                    format!(
                        "\"request\":{},\"head\":{},\"success\":{}",
                        id, request.head, completion.outcome.success
                    ),
                )?;
                return Ok(Step::Completed);
            }
            Err(Fault::Frozen) => {
                if !deferred {
                    crate::block_trace::emit(
                        "block_completion_deferred",
                        format!("\"request\":{}", id),
                    )?;
                    deferred = true;
                }
                if !wait()? {
                    return Ok(Step::Stopped);
                }
            }
            Err(fault) => return Err(fault),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use std::time::Duration;
    struct FakePort {
        request: Option<Captured>,
        completed: usize,
        generation: u64,
    }
    impl Port for FakePort {
        fn capture(&mut self, _lease: &Lease) -> Result<Option<Captured>, Fault> {
            Ok(self.request.take())
        }
        fn complete(&mut self, _lease: &Lease, r: &Captured, _: &Outcome) -> Result<(), Fault> {
            if r.queue_generation != self.generation {
                return Err(Fault::Stale);
            }
            assert_eq!(r.head, 0);
            self.completed += 1;
            Ok(())
        }
    }
    struct Backend {
        bytes: Vec<u8>,
        access: Access,
        device: Device,
        during_io: Arc<AtomicBool>,
        sizes: Vec<usize>,
        fail: bool,
    }
    impl Disk for Backend {
        fn capacity(&self) -> u64 {
            self.bytes.len() as u64
        }
        fn read(&mut self, o: u64, t: &mut [u8]) -> Result<usize, ()> {
            self.check(t.len());
            if self.fail {
                return Err(());
            }
            t.copy_from_slice(&self.bytes[o as usize..o as usize + t.len()]);
            Ok(t.len())
        }
        fn write(&mut self, o: u64, b: &[u8]) -> Result<usize, ()> {
            self.check(b.len());
            if self.fail {
                return Err(());
            }
            self.bytes[o as usize..o as usize + b.len()].copy_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> Result<(), ()> {
            self.check(0);
            if self.fail {
                Err(())
            } else {
                Ok(())
            }
        }
        fn id(&self) -> &[u8] {
            b"fixture"
        }
    }
    impl Backend {
        fn check(&mut self, n: usize) {
            assert_eq!(self.access.active_leases(), 0);
            assert!(n <= CHUNK);
            self.sizes.push(n);
            if !self.during_io.swap(true, Ordering::SeqCst) {
                let frozen = self.access.freeze(1, Duration::from_secs(1)).unwrap();
                assert!(!frozen.exclusions().is_empty());
                assert!(matches!(self.access.begin(self.device), Err(Fault::Frozen)));
                frozen.resume().unwrap();
            }
        }
    }
    fn fixture(command: Command) -> (Access, Device, FakePort, Backend) {
        let access = Access::new(1, 16, 2 * MAX_REQUEST as u64);
        let device = access.register(0).unwrap();
        let length = if command == Command::Flush {
            0
        } else {
            128 * 1024
        };
        let request = Captured {
            command,
            sector: 0,
            length,
            head: 0,
            queue_generation: 1,
            protected: vec![
                Range {
                    gpa: 0x1000,
                    len: 4096,
                },
                Range {
                    gpa: 0x2000,
                    len: length.max(1) as u64,
                },
            ],
            write_payload: if command == Command::Write {
                vec![0x5a; length]
            } else {
                Vec::new()
            },
        };
        let port = FakePort {
            request: Some(request),
            completed: 0,
            generation: 1,
        };
        let backend = Backend {
            bytes: vec![0xa5; MAX_REQUEST],
            access: access.clone(),
            device,
            during_io: Arc::new(AtomicBool::new(false)),
            sizes: Vec::new(),
            fail: false,
        };
        (access, device, port, backend)
    }
    #[test]
    fn actual_owned_pipeline_performs_io_with_zero_memory_leases_and_pins_excluded() {
        for command in [Command::Read, Command::Write, Command::Flush] {
            let (a, d, mut p, mut b) = fixture(command);
            let work = capture(&a, d, &mut p).unwrap().unwrap();
            let mut result = perform(work, &mut b);
            assert!(result.outcome.success);
            assert!(b.during_io.load(Ordering::SeqCst));
            complete(&a, &mut result, &mut p).unwrap();
            assert_eq!(p.completed, 1);
            let frozen = a.freeze(2, Duration::from_secs(1)).unwrap();
            assert!(frozen.exclusions().is_empty());
            frozen.resume().unwrap();
        }
    }
    /// Flush accounting for the receipt: `requested` when a Flush is captured, `completed` only when the
    /// backing flush returned Ok; reads and writes count nothing. The counters are process-global, so the
    /// assertions are deltas of the device-0 slot.
    #[test]
    fn flush_requests_and_successful_completions_are_counted() {
        let slot = || crate::cowork_counters::flush_snapshot()[0];
        for command in [Command::Read, Command::Write] {
            let before = slot();
            let (a, d, mut p, mut b) = fixture(command);
            let work = capture(&a, d, &mut p).unwrap().unwrap();
            let _ = perform(work, &mut b);
            assert_eq!(slot(), before);
        }
        let before = slot();
        let (a, d, mut p, mut b) = fixture(Command::Flush);
        let work = capture(&a, d, &mut p).unwrap().unwrap();
        assert_eq!(slot().requested - before.requested, 1);
        assert_eq!(slot().completed - before.completed, 0, "not completed before the flush ran");
        assert!(perform(work, &mut b).outcome.success);
        assert_eq!(slot().completed - before.completed, 1);
        let (a, d, mut p, mut b) = fixture(Command::Flush);
        b.fail = true;
        let work = capture(&a, d, &mut p).unwrap().unwrap();
        assert!(!perform(work, &mut b).outcome.success);
        assert_eq!(slot().requested - before.requested, 2);
        assert_eq!(slot().completed - before.completed, 1, "a failed flush is requested but not completed");
        drop(a);
    }
    #[test]
    fn completion_during_freeze_stays_pinned_and_is_deferred() {
        let (a, d, mut p, mut b) = fixture(Command::Read);
        let mut result = perform(capture(&a, d, &mut p).unwrap().unwrap(), &mut b);
        let frozen = a.freeze(2, Duration::from_secs(1)).unwrap();
        assert_eq!(complete(&a, &mut result, &mut p), Err(Fault::Frozen));
        assert_eq!(p.completed, 0);
        assert!(!frozen.exclusions().is_empty());
        frozen.resume().unwrap();
        complete(&a, &mut result, &mut p).unwrap();
        assert_eq!(p.completed, 1);
    }
    #[test]
    fn stale_queue_or_device_generation_cannot_write_completion() {
        for device_reset in [false, true] {
            let (a, d, mut p, mut b) = fixture(Command::Read);
            let mut result = perform(capture(&a, d, &mut p).unwrap().unwrap(), &mut b);
            if device_reset {
                a.reset_generation(d).unwrap();
            } else {
                p.generation = 2;
            }
            assert_eq!(complete(&a, &mut result, &mut p), Err(Fault::Stale));
            assert_eq!(p.completed, 0);
        }
    }
    #[test]
    fn disk_error_has_no_partial_read_data_and_returns_error_status() {
        let (a, d, mut p, mut b) = fixture(Command::Read);
        b.fail = true;
        let mut result = perform(capture(&a, d, &mut p).unwrap().unwrap(), &mut b);
        assert!(!result.outcome.success);
        assert!(result.outcome.data.is_empty());
        complete(&a, &mut result, &mut p).unwrap();
        assert_eq!(p.completed, 1);
    }
    #[test]
    fn malformed_size_and_sector_overflow_do_not_start_io() {
        for overflow in [false, true] {
            let (a, d, mut p, b) = fixture(Command::Read);
            if overflow {
                p.request.as_mut().unwrap().sector = u64::MAX;
            } else {
                p.request.as_mut().unwrap().length = MAX_REQUEST + 1;
            }
            assert!(capture(&a, d, &mut p).is_err());
            assert!(b.sizes.is_empty());
            assert_eq!(a.active_leases(), 0);
        }
    }
    #[test]
    fn stop_blocks_completion_without_guest_access() {
        let (a, d, mut p, mut b) = fixture(Command::Read);
        let mut result = perform(capture(&a, d, &mut p).unwrap().unwrap(), &mut b);
        a.stop();
        assert_eq!(complete(&a, &mut result, &mut p), Err(Fault::Stopped));
        assert_eq!(p.completed, 0);
    }
    #[test]
    fn duplicate_completion_cannot_touch_unpinned_guest_ram() {
        let (a, d, mut p, mut b) = fixture(Command::Read);
        let mut result = perform(capture(&a, d, &mut p).unwrap().unwrap(), &mut b);
        complete(&a, &mut result, &mut p).unwrap();
        assert_eq!(complete(&a, &mut result, &mut p), Err(Fault::Duplicate));
        assert_eq!(p.completed, 1);
    }
    #[test]
    fn get_id_uses_owned_metadata_then_completes_once() {
        let (a, d, mut p, mut b) = fixture(Command::GetId);
        let mut result = perform(capture(&a, d, &mut p).unwrap().unwrap(), &mut b);
        assert_eq!(result.outcome.data, b"fixture");
        complete(&a, &mut result, &mut p).unwrap();
        assert_eq!(p.completed, 1);
    }
}
