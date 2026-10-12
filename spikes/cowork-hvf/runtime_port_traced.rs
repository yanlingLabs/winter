//! Guarded fixed generic port: closed MULTIPORT handshake; upstream worker/volatile I/O paths unused.
use super::runtime_port_control::{Control, Transition, CONTROL_BYTES, FEATURES};
use super::runtime_port_fixture_trace::Trace;
use crate::reclaim_access::{Access, Device, Fault, Pin, Range};
use crate::stream_io::{ScopedStream, CHUNK, MAX_CHAIN, MAX_TX};
use crate::virtio::queue::fixture_chain;
use crate::virtio::{
    ActivateError, ActivateResult, DeviceQueue, InterruptTransport, Queue, QueueConfig,
    VirtioDevice, VmmExitObserver,
};
use std::io::ErrorKind;
use std::os::fd::AsRawFd;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread::JoinHandle;
use utils::eventfd::{EventFd, EFD_NONBLOCK};
use vm_memory::{Address, Bytes, GuestAddress, GuestMemory, GuestMemoryMmap, GuestMemoryRegion};
const QUEUES: [QueueConfig; 4] = [
    QueueConfig::new(32),
    QueueConfig::new(32),
    QueueConfig::new(32),
    QueueConfig::new(32),
];
struct Frame {
    head: u16,
    ranges: Vec<Range>,
    capacity: usize,
    data: Vec<u8>,
    offset: usize,
    _pin: Pin,
}
impl Drop for Frame {
    fn drop(&mut self) {
        for byte in &mut self.data {
            unsafe { std::ptr::write_volatile(byte, 0) }
        }
        std::sync::atomic::compiler_fence(Ordering::SeqCst);
    }
}
struct StreamQueues {
    memory: GuestMemoryMmap,
    rx: Queue,
    tx: Queue,
    control_rx: Queue,
    control_tx: Queue,
    access: Access,
    device: Device,
    _rings: Vec<Pin>,
}
impl StreamQueues {
    fn new(
        memory: GuestMemoryMmap,
        queues: Vec<DeviceQueue>,
        access: Access,
        device: Device,
    ) -> Result<(Self, Vec<Arc<EventFd>>), Fault> {
        if queues.len() != 4 {
            return Err(Fault::Limit);
        }
        let lease = access.begin(device)?;
        let mut pins = Vec::new();
        for q in &queues {
            q.queue
                .fixture_validate_report(&memory)
                .map_err(|_| Fault::InvalidRange)?;
            let ranges = q
                .queue
                .fixture_exclusions(&memory, false)
                .map_err(|_| Fault::InvalidRange)?
                .into_iter()
                .map(|(gpa, len)| Range { gpa, len })
                .collect::<Vec<_>>();
            pins.push(lease.pin(&ranges)?);
        }
        let events = queues.iter().map(|q| q.event.clone()).collect();
        let mut queues = queues.into_iter();
        let rx = queues.next().unwrap().queue;
        let tx = queues.next().unwrap().queue;
        let control_rx = queues.next().unwrap().queue;
        let control_tx = queues.next().unwrap().queue;
        drop(lease);
        Ok((
            Self {
                memory,
                rx,
                tx,
                control_rx,
                control_tx,
                access,
                device,
                _rings: pins,
            },
            events,
        ))
    }
    fn range(memory: &GuestMemoryMmap, r: Range) -> Result<(), Fault> {
        let end = r.gpa.checked_add(r.len).ok_or(Fault::Overflow)?;
        let region = memory
            .find_region(GuestAddress(r.gpa))
            .ok_or(Fault::InvalidRange)?;
        if r.len == 0
            || end
                > region
                    .start_addr()
                    .raw_value()
                    .checked_add(region.len())
                    .ok_or(Fault::Overflow)?
        {
            return Err(Fault::InvalidRange);
        }
        Ok(())
    }
    fn capture(&mut self, rx: bool) -> Result<Option<Frame>, Fault> {
        self.capture_queue(rx, false)
    }
    fn capture_queue(&mut self, rx: bool, control: bool) -> Result<Option<Frame>, Fault> {
        let lease = self.access.begin(self.device)?;
        let memory = &self.memory;
        let queue = match (rx, control) {
            (true, false) => &mut self.rx,
            (false, false) => &mut self.tx,
            (true, true) => &mut self.control_rx,
            (false, true) => &mut self.control_tx,
        };
        let result = lease.operation(
            &self.access,
            self.device,
            || -> Result<Option<(u16, Vec<Range>, usize, Vec<u8>)>, Fault> {
                let Some(head) = queue
                    .fixture_checked_pop(memory)
                    .map_err(|_| Fault::InvalidRange)?
                else {
                    return Ok(None);
                };
                let index = head.index;
                let mut ranges = Vec::new();
                let mut total = 0usize;
                for d in fixture_chain(head).map_err(|_| Fault::InvalidRange)? {
                    if d.is_write_only() != rx {
                        return Err(Fault::InvalidRange);
                    }
                    if d.len == 0 {
                        continue;
                    }
                    let range = Range {
                        gpa: d.addr.raw_value(),
                        len: u64::from(d.len),
                    };
                    Self::range(memory, range)?;
                    total = total.checked_add(d.len as usize).ok_or(Fault::Overflow)?;
                    if total
                        > if rx {
                            MAX_CHAIN
                        } else if control {
                            CONTROL_BYTES
                        } else {
                            MAX_TX
                        }
                    {
                        return Err(Fault::Limit);
                    }
                    ranges.push(range);
                }
                if total == 0 || ranges.len() > 256 {
                    return Err(Fault::InvalidRange);
                }
                if control && ((!rx && total != CONTROL_BYTES) || (rx && total < CONTROL_BYTES)) {
                    return Err(Fault::Limit);
                }
                let capacity = if rx {
                    total.min(if control { CONTROL_BYTES } else { CHUNK })
                } else {
                    total
                };
                let mut data = vec![0u8; capacity];
                if !rx {
                    let mut offset = 0;
                    for r in &ranges {
                        let n = r.len as usize;
                        memory
                            .read_slice(&mut data[offset..offset + n], GuestAddress(r.gpa))
                            .map_err(|_| Fault::InvalidRange)?;
                        offset += n;
                    }
                }
                Ok(Some((index, ranges, capacity, data)))
            },
        )??;
        let Some((head, ranges, capacity, mut data)) = result else {
            return Ok(None);
        };
        let pin = match lease.pin(&ranges) {
            Ok(pin) => pin,
            Err(fault) => {
                for byte in &mut data {
                    unsafe { std::ptr::write_volatile(byte, 0) }
                }
                std::sync::atomic::compiler_fence(Ordering::SeqCst);
                return Err(fault);
            }
        };
        drop(lease);
        Ok(Some(Frame {
            head,
            ranges,
            capacity,
            data,
            offset: 0,
            _pin: pin,
        }))
    }
    fn complete(&mut self, rx: bool, frame: &Frame) -> Result<(), Fault> {
        self.complete_queue(rx, false, frame)
    }
    fn complete_queue(&mut self, rx: bool, control: bool, frame: &Frame) -> Result<(), Fault> {
        let lease = self.access.begin(self.device)?;
        let memory = &self.memory;
        let queue = match (rx, control) {
            (true, false) => &mut self.rx,
            (false, false) => &mut self.tx,
            (true, true) => &mut self.control_rx,
            (false, true) => &mut self.control_tx,
        };
        lease.operation(&self.access, self.device, || -> Result<(), Fault> {
            queue
                .fixture_validate_report(memory)
                .map_err(|_| Fault::InvalidRange)?;
            if rx {
                if frame.offset > frame.capacity {
                    return Err(Fault::Limit);
                }
                let mut copied = 0;
                for r in &frame.ranges {
                    Self::range(memory, *r)?;
                    let n = (r.len as usize).min(frame.offset - copied);
                    memory
                        .write_slice(&frame.data[copied..copied + n], GuestAddress(r.gpa))
                        .map_err(|_| Fault::InvalidRange)?;
                    copied += n;
                    if copied == frame.offset {
                        break;
                    }
                }
                if copied != frame.offset {
                    return Err(Fault::InvalidRange);
                }
            }
            queue
                .add_used(memory, frame.head, frame.offset as u32)
                .map_err(|_| Fault::InvalidRange)
        })??;
        drop(lease);
        Ok(())
    }
}
struct Worker {
    queues: StreamQueues,
    events: Vec<Arc<EventFd>>,
    stream: ScopedStream,
    stop: Arc<AtomicBool>,
    stopfd: EventFd,
    interrupt: InterruptTransport,
    rx: Option<Frame>,
    tx: Option<Frame>,
    control_rx: Option<Frame>,
    control_tx: Option<Frame>,
    control: Control,
    transition: Option<Transition>,
    response: Option<[u8; CONTROL_BYTES]>,
    trace: Option<Trace>,
    #[cfg(test)]
    observe_tx: Option<(Arc<std::sync::atomic::AtomicUsize>, Arc<AtomicBool>)>,
}
impl Worker {
    fn control_turn(&mut self) -> Result<(), Fault> {
        if self.response.is_none() && self.control_tx.is_none() {
            match self.queues.capture_queue(false, true) {
                Ok(frame) => self.control_tx = frame,
                Err(Fault::Frozen) => {}
                Err(fault) => return Err(fault),
            }
        }
        if let Some(frame) = &mut self.control_tx {
            frame.offset = CONTROL_BYTES;
            if self.transition.is_none() {
                self.transition = Some(self.control.validate(&frame.data)?);
            }
            match self.queues.complete_queue(false, true, frame) {
                Ok(()) => {
                    let transition = self.transition.take().unwrap();
                    if let Some(trace) = &self.trace {
                        trace.used_ack(3, &frame.data)?;
                    }
                    self.response = transition.response;
                    self.control.apply(transition);
                    self.control_tx = None;
                    self.interrupt.signal_used_queue();
                }
                Err(Fault::Frozen) => {}
                Err(fault) => return Err(fault),
            }
        }
        if let Some(response) = &self.response {
            if self.control_rx.is_none() {
                match self.queues.capture_queue(true, true) {
                    Ok(frame) => self.control_rx = frame,
                    Err(Fault::Frozen) => {}
                    Err(fault) => return Err(fault),
                }
            }
            if let Some(frame) = &mut self.control_rx {
                frame.data.copy_from_slice(response);
                frame.offset = CONTROL_BYTES;
                match self.queues.complete_queue(true, true, frame) {
                    Ok(()) => {
                        if let Some(trace) = &self.trace {
                            trace.used_ack(2, response)?;
                        }
                        self.response = None;
                        self.control_rx = None;
                        self.interrupt.signal_used_queue();
                    }
                    Err(Fault::Frozen) => {}
                    Err(fault) => return Err(fault),
                }
            }
        }
        if self.control.closed() {
            return Err(Fault::Stopped);
        }
        Ok(())
    }
    fn run(&mut self) -> Result<(), Fault> {
        loop {
            if self.stop.load(Ordering::Acquire) || self.queues.access.stopped() {
                return Err(Fault::Stopped);
            }
            // Control ACK service is independent of nonblocking host data readiness.
            self.control_turn()?;
            if self.control.open() {
                for direction in [true, false] {
                    let slot = if direction {
                        &mut self.rx
                    } else {
                        &mut self.tx
                    };
                    if slot.is_none() {
                        match self.queues.capture(direction) {
                            Ok(frame) => *slot = frame,
                            Err(Fault::Frozen) => {}
                            Err(fault) => return Err(fault),
                        }
                    }
                }
                if let Some(frame) = &mut self.tx {
                    if frame.offset < frame.capacity {
                        match self.stream.write_owned(
                            &frame.data[frame.offset..(frame.offset + CHUNK).min(frame.capacity)],
                        ) {
                            Ok(0) => return Err(Fault::Stopped),
                            Ok(n) => {
                                #[cfg(test)]
                                let attempted =
                                    (frame.offset + CHUNK).min(frame.capacity) - frame.offset;
                                frame.offset += n;
                                #[cfg(test)]
                                if let Some((offset, short)) = &self.observe_tx {
                                    offset.store(frame.offset, Ordering::Release);
                                    if n < attempted {
                                        short.store(true, Ordering::Release);
                                    }
                                }
                            }
                            Err(e)
                                if e.kind() == ErrorKind::WouldBlock
                                    || e.kind() == ErrorKind::Interrupted => {}
                            Err(_) => return Err(Fault::Stopped),
                        }
                    }
                    if frame.offset == frame.capacity {
                        match self.queues.complete(false, frame) {
                            Ok(()) => {
                                self.tx = None;
                                self.interrupt.signal_used_queue();
                            }
                            Err(Fault::Frozen) => {}
                            Err(fault) => return Err(fault),
                        }
                    }
                }
                if let Some(frame) = &mut self.rx {
                    if frame.offset == 0 {
                        match self.stream.read_owned(&mut frame.data) {
                            Ok(0) => return Err(Fault::Stopped),
                            Ok(n) => frame.offset = n,
                            Err(e)
                                if e.kind() == ErrorKind::WouldBlock
                                    || e.kind() == ErrorKind::Interrupted => {}
                            Err(_) => return Err(Fault::Stopped),
                        }
                    }
                    if frame.offset > 0 {
                        match self.queues.complete(true, frame) {
                            Ok(()) => {
                                self.rx = None;
                                self.interrupt.signal_used_queue();
                            }
                            Err(Fault::Frozen) => {}
                            Err(fault) => return Err(fault),
                        }
                    }
                }
            } // Generic data remains gated until the exact guest-open ACK.
            if self.stop.load(Ordering::Acquire) {
                return Err(Fault::Stopped);
            }
            let mut want = 0;
            if self.rx.as_ref().is_some_and(|f| f.offset == 0) {
                want |= libc::POLLIN;
            }
            if self.tx.as_ref().is_some_and(|f| f.offset < f.capacity) {
                want |= libc::POLLOUT;
            }
            let mut fds = [
                libc::pollfd {
                    fd: self.stream.as_raw_fd(),
                    events: want,
                    revents: 0,
                },
                libc::pollfd {
                    fd: self.stopfd.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                },
                libc::pollfd {
                    fd: self.events[0].as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                },
                libc::pollfd {
                    fd: self.events[1].as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                },
                libc::pollfd {
                    fd: self.events[2].as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                },
                libc::pollfd {
                    fd: self.events[3].as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                },
            ];
            let rc = unsafe { libc::poll(fds.as_mut_ptr(), 6, 20) };
            if rc < 0 {
                if std::io::Error::last_os_error().kind() == ErrorKind::Interrupted {
                    continue;
                }
                return Err(Fault::Stopped);
            }
            if fds[1].revents != 0 || self.stop.load(Ordering::Acquire) {
                return Err(Fault::Stopped);
            }
            if fds[0].revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0 {
                return Err(Fault::Stopped);
            }
            for (index, event) in self.events.iter().enumerate() {
                if fds[index + 2].revents != 0 {
                    let _ = event.read();
                }
            }
        }
    }
}
struct Finished {
    _ownership: Worker,
    result: Result<(), Fault>,
}
struct Active {
    thread: JoinHandle<Finished>,
    stop: Arc<AtomicBool>,
    stopfd: EventFd,
}
struct Pending {
    queues: StreamQueues,
    events: Vec<Arc<EventFd>>,
    interrupt: InterruptTransport,
}
pub struct GuardedPort {
    access: Access,
    device: Device,
    stream: ScopedStream,
    acked: u64,
    activated: bool,
    active: Option<Active>,
    pending: Option<Pending>,
    done: EventFd,
    fixture_trace: Option<Trace>,
    #[cfg(test)]
    test_data_open: bool,
}
impl GuardedPort {
    pub fn new(access: Access, device: Device, stream: ScopedStream) -> Result<Self, Fault> {
        Ok(Self {
            access,
            device,
            stream,
            acked: 0,
            fixture_trace: None,
            #[cfg(test)]
            test_data_open: false,
            activated: false,
            active: None,
            pending: None,
            done: EventFd::new(EFD_NONBLOCK).map_err(|_| Fault::Stopped)?,
        })
    }
    pub fn enable_fixture_trace(&mut self) {
        self.fixture_trace = Some(Trace::new());
    }
    fn initial_control(&self) -> Control {
        #[cfg(test)]
        if self.test_data_open {
            return Control::opened_for_test();
        }
        Control::new()
    }
    pub fn fail_terminal(&self) {
        self.access.stop();
    }
    pub fn lifecycle_pending(&self) -> bool {
        self.pending.is_some()
            || self
                .active
                .as_ref()
                .is_some_and(|a| a.stop.load(Ordering::Acquire))
    }
    pub fn progress_lifecycle(&mut self) -> Result<(), Fault> {
        if self.active.as_ref().is_some_and(|a| a.thread.is_finished()) {
            let active = self.active.take().unwrap();
            let stopping = active.stop.load(Ordering::Acquire);
            let result = active.thread.join().map_err(|_| Fault::Stopped)?;
            if !stopping && result.result.is_err() {
                self.access.stop();
                return Err(Fault::Stopped);
            }
        }
        if self.active.is_none() {
            if let Some(pending) = self.pending.take() {
                let stop = Arc::new(AtomicBool::new(false));
                let stopfd = EventFd::new(EFD_NONBLOCK).map_err(|_| Fault::Stopped)?;
                let done = self.done.try_clone().map_err(|_| Fault::Stopped)?;
                let access = self.access.clone();
                let worker_stop = stop.clone();
                let mut worker = Worker {
                    queues: pending.queues,
                    events: pending.events,
                    stream: self.stream.duplicate().map_err(|_| Fault::Stopped)?,
                    stop: worker_stop.clone(),
                    stopfd: stopfd.try_clone().map_err(|_| Fault::Stopped)?,
                    interrupt: pending.interrupt,
                    rx: None,
                    tx: None,
                    control_rx: None,
                    control_tx: None,
                    control: self.initial_control(),
                    transition: None,
                    response: None,
                    trace: self.fixture_trace.clone(),
                    #[cfg(test)]
                    observe_tx: None,
                };
                let thread = std::thread::Builder::new()
                    .name("guarded runtime port".into())
                    .spawn(move || {
                        let result = worker.run();
                        if result.is_err() && !worker_stop.load(Ordering::Acquire) {
                            access.stop();
                        }
                        let _ = done.write(1);
                        Finished {
                            _ownership: worker,
                            result,
                        }
                    })
                    .map_err(|_| Fault::Stopped)?;
                self.active = Some(Active {
                    thread,
                    stop,
                    stopfd,
                });
            }
        }
        Ok(())
    }
}
/// Same lifecycle tick used by the VMM after releasing its own mutex.
pub fn lifecycle_tick(console: &Arc<std::sync::Mutex<GuardedPort>>) -> bool {
    let mut device = console.lock().unwrap();
    if device.progress_lifecycle().is_err() {
        device.fail_terminal();
    }
    device.lifecycle_pending()
}
impl VirtioDevice for GuardedPort {
    fn avail_features(&self) -> u64 {
        FEATURES
    }
    fn acked_features(&self) -> u64 {
        self.acked
    }
    fn set_acked_features(&mut self, f: u64) {
        self.acked = f & FEATURES;
    }
    fn device_type(&self) -> u32 {
        3
    }
    fn device_name(&self) -> &str {
        "cowork-runtime-port"
    }
    fn queue_config(&self) -> &[QueueConfig] {
        &QUEUES
    }
    fn read_config(&self, offset: u64, data: &mut [u8]) {
        let mut config = [0u8; 12];
        config[4..8].copy_from_slice(&1u32.to_le_bytes());
        for (i, target) in data.iter_mut().enumerate() {
            *target = offset
                .checked_add(i as u64)
                .and_then(|position| usize::try_from(position).ok())
                .and_then(|position| config.get(position))
                .copied()
                .unwrap_or(0);
        }
    }
    fn write_config(&mut self, _: u64, _: &[u8]) {}
    fn activate(
        &mut self,
        memory: GuestMemoryMmap,
        interrupt: InterruptTransport,
        queues: Vec<DeviceQueue>,
    ) -> ActivateResult {
        if self.acked != FEATURES || self.activated || self.pending.is_some() {
            self.access.stop();
            return Err(ActivateError::BadActivate);
        }
        let (queues, events) = StreamQueues::new(memory, queues, self.access.clone(), self.device)
            .map_err(|_| {
                self.access.stop();
                ActivateError::BadActivate
            })?;
        self.pending = Some(Pending {
            queues,
            events,
            interrupt,
        });
        self.activated = true;
        self.progress_lifecycle().map_err(|_| {
            self.access.stop();
            ActivateError::BadActivate
        })?;
        Ok(())
    }
    fn is_activated(&self) -> bool {
        self.activated
    }
    fn reset(&mut self) -> bool {
        if let Some(active) = &self.active {
            active.stop.store(true, Ordering::Release);
            let _ = active.stopfd.write(1);
        }
        self.pending = None;
        self.activated = false;
        self.acked = 0;
        match self.access.retire_generation(self.device) {
            Ok(next) => self.device = next,
            Err(_) => self.access.stop(),
        };
        let _ = self.done.write(1);
        true
    }
}
impl Drop for GuardedPort {
    fn drop(&mut self) {
        if let Some(active) = &self.active {
            active.stop.store(true, Ordering::Release);
            let _ = active.stopfd.write(1);
        }
        let _ = self.access.retire_generation(self.device);
    }
}
impl VmmExitObserver for GuardedPort {
    fn on_vmm_exit(&mut self) {
        self.reset();
    }
}
impl polly::event_manager::Subscriber for GuardedPort {
    fn interest_list(&self) -> Vec<utils::epoll::EpollEvent> {
        vec![utils::epoll::EpollEvent::new(
            utils::epoll::EventSet::IN,
            self.done.as_raw_fd() as u64,
        )]
    }
    fn process(
        &mut self,
        _: &utils::epoll::EpollEvent,
        _: &mut polly::event_manager::EventManager,
    ) {
        let _ = self.done.read();
        if self.progress_lifecycle().is_err() {
            self.access.stop();
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::virtio::Descriptor;
    use std::io::{Read, Write};
    use std::time::{Duration, Instant};
    // Explicit opened-state fixture for inherited DATA/lease/lifecycle scope only.
    fn data_test_device(
        access: Access,
        device: Device,
        stream: ScopedStream,
    ) -> Result<GuardedPort, Fault> {
        let mut port = GuardedPort::new(access, device, stream)?;
        port.test_data_open = true;
        port.set_acked_features(FEATURES);
        Ok(port)
    }
    pub(super) fn wait(mut ready: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while !ready() {
            assert!(Instant::now() < deadline, "metadata completion deadline");
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    fn fixture() -> (
        Access,
        Device,
        StreamQueues,
        Vec<Arc<EventFd>>,
        GuestMemoryMmap,
    ) {
        fixture_memory(GuestMemoryMmap::from_ranges(&[(GuestAddress(0), 0x20000)]).unwrap())
    }
    fn fixture_memory(
        memory: GuestMemoryMmap,
    ) -> (
        Access,
        Device,
        StreamQueues,
        Vec<Arc<EventFd>>,
        GuestMemoryMmap,
    ) {
        let access = Access::new(2, 16, 4 * 1024 * 1024);
        let token = access.register(1).unwrap();

        let mut queues = Vec::new();
        for (index, base) in [0x1000u64, 0x7000, 0x4000, 0xa000].into_iter().enumerate() {
            let mut queue = Queue::new(8);
            queue.ready = true;
            queue.size = 8;
            queue.desc_table = GuestAddress(base);
            queue.avail_ring = GuestAddress(base + 0x1000);
            queue.used_ring = GuestAddress(base + 0x2000);
            let descriptor = Descriptor {
                addr: if index == 0 { 0x10000 } else { 0x14000 },
                len: 16,
                flags: if index == 0 { 2 } else { 0 },
                next: 0,
            };
            memory.write_obj(descriptor, GuestAddress(base)).unwrap();
            memory
                .write_obj(
                    if index < 2 { 1u16 } else { 0u16 },
                    GuestAddress(base + 0x1002),
                )
                .unwrap();
            memory.write_obj(0u16, GuestAddress(base + 0x1004)).unwrap();
            if index == 1 {
                memory
                    .write_slice(&[0x31; 16], GuestAddress(0x14000))
                    .unwrap();
            }
            queues.push(DeviceQueue::new(
                queue,
                Arc::new(EventFd::new(EFD_NONBLOCK).unwrap()),
            ));
        }
        let (queues, events) =
            StreamQueues::new(memory.clone(), queues, access.clone(), token).unwrap();
        (access, token, queues, events, memory)
    }
    pub(super) fn interrupt() -> InterruptTransport {
        InterruptTransport::new(
            crate::legacy::DummyIrqChip::new().into(),
            "guarded-stream-test".into(),
        )
        .unwrap()
    }
    #[test]
    fn runtime_port_actual_queue_socketpair_duplex_owned_io() {
        let (access, _token, queues, events, memory) = fixture();
        let (stream, mut peer) = crate::stream_io::test_pair();
        let stop = Arc::new(AtomicBool::new(false));
        let stopfd = EventFd::new(EFD_NONBLOCK).unwrap();
        let fd = stopfd.try_clone().unwrap();
        let worker_stop = stop.clone();
        let mut worker = Worker {
            queues,
            events,
            stream,
            stop: worker_stop,
            stopfd: fd,
            interrupt: interrupt(),
            rx: None,
            tx: None,
            control_rx: None,
            control_tx: None,
            control: Control::opened_for_test(),
            transition: None,
            response: None,
            trace: None,
            observe_tx: None,
        };
        let thread = std::thread::spawn(move || worker.run());
        peer.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        peer.write_all(&[0x42; 16]).unwrap();
        let mut received = [0; 16];
        peer.read_exact(&mut received).unwrap();
        assert!(received.iter().all(|byte| *byte == 0x31));
        wait(|| {
            memory.read_obj::<u16>(GuestAddress(0x3002)).unwrap() == 1
                && memory.read_obj::<u16>(GuestAddress(0x9002)).unwrap() == 1
        });
        let mut input = [0; 16];
        memory
            .read_slice(&mut input, GuestAddress(0x10000))
            .unwrap();
        assert!(input.iter().all(|byte| *byte == 0x42));
        assert_eq!(access.active_leases(), 0);
        stop.store(true, Ordering::Release);
        stopfd.write(1).unwrap();
        assert!(thread.join().unwrap().is_err());
    }
    #[test]
    fn runtime_port_frozen_pending_rx_tx_keep_pins_and_no_guest_ack() {
        let (access, token, mut queues, _events, memory) = fixture();
        let rx = queues.capture(true).unwrap().unwrap();
        let tx = queues.capture(false).unwrap().unwrap();
        assert_eq!(access.active_leases(), 0);
        let frozen = access.freeze(1, Duration::from_secs(1)).unwrap();
        assert!(frozen.exclusions().iter().any(|r| r.gpa == 0x10000));
        assert!(frozen.exclusions().iter().any(|r| r.gpa == 0x14000));
        assert_eq!(queues.complete(false, &tx), Err(Fault::Frozen));
        assert_eq!(memory.read_obj::<u16>(GuestAddress(0x9002)).unwrap(), 0);
        frozen.resume().unwrap();
        access.retire_generation(token).unwrap();
        assert_eq!(queues.complete(true, &rx), Err(Fault::Stale));
        assert_eq!(memory.read_obj::<u16>(GuestAddress(0x3002)).unwrap(), 0);
    }
    #[test]
    fn runtime_port_reset_retires_but_holds_ownership_until_actual_thread_completion() {
        let (access, token, queues, events, memory) = fixture();
        let (stream, peer) = crate::stream_io::test_pair();
        let mut device = data_test_device(access.clone(), token, stream).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let stopfd = EventFd::new(EFD_NONBLOCK).unwrap();
        let (entered, inflight) = std::sync::mpsc::sync_channel(0);
        let (release, waiting) = std::sync::mpsc::sync_channel(0);
        let owned_stream = device.stream.duplicate().unwrap();
        let thread = std::thread::spawn(move || {
            entered.send(()).unwrap();
            waiting.recv_timeout(Duration::from_secs(2)).unwrap();
            Finished {
                _ownership: Worker {
                    queues,
                    events,
                    stream: owned_stream,
                    stop: Arc::new(AtomicBool::new(true)),
                    stopfd: EventFd::new(EFD_NONBLOCK).unwrap(),
                    interrupt: interrupt(),
                    rx: None,
                    tx: None,
                    control_rx: None,
                    control_tx: None,
                    control: Control::opened_for_test(),
                    transition: None,
                    response: None,
                    trace: None,
                    observe_tx: None,
                },
                result: Err(Fault::Stopped),
            }
        });
        inflight.recv_timeout(Duration::from_secs(1)).unwrap();
        device.active = Some(Active {
            thread,
            stop: stop.clone(),
            stopfd,
        });
        device.activated = true;
        let before = Instant::now();
        assert!(device.reset());
        assert!(before.elapsed() < Duration::from_millis(100));
        assert!(device.active.is_some());
        assert!(device.lifecycle_pending());
        let frozen = access.freeze(1, Duration::from_secs(1)).unwrap();
        assert!(!frozen.exclusions().is_empty());
        frozen.resume().unwrap();
        assert_eq!(memory.read_obj::<u16>(GuestAddress(0x3002)).unwrap(), 0);
        release.send(()).unwrap();
        wait(|| device.active.as_ref().unwrap().thread.is_finished());
        device.progress_lifecycle().unwrap();
        assert!(device.active.is_none());
        drop(peer);
    }
    #[test]
    fn runtime_port_actual_socket_backpressure_poll_is_stop_interruptible_without_ram_lease() {
        let (access, _token, mut queues, _events, _) = fixture();
        let frame = queues.capture(false).unwrap().unwrap();
        let (stream, _peer) = crate::stream_io::test_pair();
        let small = 4096i32;
        unsafe {
            libc::setsockopt(
                stream.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_SNDBUF,
                &small as *const _ as *const _,
                4,
            )
        };
        let bytes = [0u8; CHUNK];
        let mut full = false;
        for _ in 0..256 {
            match stream.write_owned(&bytes) {
                Ok(_) => {}
                Err(e) if e.kind() == ErrorKind::WouldBlock => {
                    full = true;
                    break;
                }
                Err(_) => panic!("metadata write failure"),
            }
        }
        assert!(full);
        assert_eq!(access.active_leases(), 0);
        let stop = Arc::new(AtomicBool::new(false));
        let stopfd = EventFd::new(EFD_NONBLOCK).unwrap();
        let fd = stopfd.try_clone().unwrap();
        let worker_stop = stop.clone();
        let thread = std::thread::spawn(move || {
            let _owned = frame;
            stream.wait(true, &fd, &worker_stop)
        });
        let frozen = access.freeze(1, Duration::from_millis(100)).unwrap();
        assert!(frozen.exclusions().iter().any(|r| r.gpa == 0x14000));
        stop.store(true, Ordering::Release);
        stopfd.write(1).unwrap();
        assert_eq!(thread.join().unwrap(), Err(Fault::Stopped));
        frozen.resume().unwrap();
    }
    #[test]
    fn runtime_port_malformed_and_oversized_spans_reject_before_payload_io() {
        for option in 0..4 {
            let (_access, _token, mut queues, _events, memory) = fixture();
            let descriptor = Descriptor {
                addr: if option == 0 { 0x1fff8 } else { 0x14000 },
                len: if option == 1 { (MAX_TX + 1) as u32 } else { 16 },
                flags: if option == 2 {
                    2
                } else if option == 3 {
                    1
                } else {
                    0
                },
                next: 8,
            };
            memory.write_obj(descriptor, GuestAddress(0x7000)).unwrap();
            assert!(queues.capture(false).is_err());
            assert_eq!(memory.read_obj::<u16>(GuestAddress(0x9002)).unwrap(), 0);
        }
    }
    #[test]
    fn runtime_port_actual_worker_rx_wait_survives_freeze_then_acks_after_resume() {
        let (access, _token, queues, events, memory) = fixture();
        memory.write_obj(0u16, GuestAddress(0x8002)).unwrap(); // No TX demand; RX owned wait alone.
        let (stream, mut peer) = crate::stream_io::test_pair();
        let stop = Arc::new(AtomicBool::new(false));
        let stopfd = EventFd::new(EFD_NONBLOCK).unwrap();
        let mut worker = Worker {
            queues,
            events,
            stream,
            stop: stop.clone(),
            stopfd: stopfd.try_clone().unwrap(),
            interrupt: interrupt(),
            rx: None,
            tx: None,
            control_rx: None,
            control_tx: None,
            control: Control::opened_for_test(),
            transition: None,
            response: None,
            trace: None,
            observe_tx: None,
        };
        let thread = std::thread::spawn(move || worker.run());
        wait(|| access.pinned_usage().0 == 5);
        assert_eq!(access.active_leases(), 0);
        let frozen = access.freeze(1, Duration::from_secs(1)).unwrap();
        peer.write_all(&[0x52; 16]).unwrap();
        std::thread::sleep(Duration::from_millis(30));
        assert_eq!(memory.read_obj::<u16>(GuestAddress(0x3002)).unwrap(), 0);
        assert!(frozen.exclusions().iter().any(|r| r.gpa == 0x10000));
        frozen.resume().unwrap();
        wait(|| memory.read_obj::<u16>(GuestAddress(0x3002)).unwrap() == 1);
        stop.store(true, Ordering::Release);
        stopfd.write(1).unwrap();
        thread.join().unwrap().unwrap_err();
    }
    #[test]
    fn runtime_port_async_pending_reactivation_waits_old_owner_then_real_io() {
        let (access, token, old_queues, events, _) = fixture();
        let (stream, mut peer) = crate::stream_io::test_pair();
        let mut device = data_test_device(access.clone(), token, stream).unwrap();
        let (release, go) = std::sync::mpsc::sync_channel(0);
        let (old_ready, ready) = std::sync::mpsc::sync_channel(0);
        let owned_stream = device.stream.duplicate().unwrap();
        let old = std::thread::spawn(move || {
            old_ready.send(()).unwrap();
            go.recv_timeout(Duration::from_secs(1)).unwrap();
            Finished {
                _ownership: Worker {
                    queues: old_queues,
                    events,
                    stream: owned_stream,
                    stop: Arc::new(AtomicBool::new(true)),
                    stopfd: EventFd::new(EFD_NONBLOCK).unwrap(),
                    interrupt: interrupt(),
                    rx: None,
                    tx: None,
                    control_rx: None,
                    control_tx: None,
                    control: Control::opened_for_test(),
                    transition: None,
                    response: None,
                    trace: None,
                    observe_tx: None,
                },
                result: Err(Fault::Stopped),
            }
        });
        ready.recv_timeout(Duration::from_secs(1)).unwrap();
        device.active = Some(Active {
            thread: old,
            stop: Arc::new(AtomicBool::new(false)),
            stopfd: EventFd::new(EFD_NONBLOCK).unwrap(),
        });
        device.activated = true;
        device.reset();
        let new_memory = GuestMemoryMmap::from_ranges(&[(GuestAddress(0), 0x20000)]).unwrap();
        let mut new_queues = Vec::new();
        for (index, base) in [0x1000u64, 0x7000, 0x4000, 0xa000].into_iter().enumerate() {
            let mut queue = Queue::new(8);
            queue.ready = true;
            queue.size = 8;
            queue.desc_table = GuestAddress(base);
            queue.avail_ring = GuestAddress(base + 0x1000);
            queue.used_ring = GuestAddress(base + 0x2000);
            new_memory
                .write_obj(
                    Descriptor {
                        addr: if index == 0 { 0x10000 } else { 0x14000 },
                        len: 16,
                        flags: if index == 0 { 2 } else { 0 },
                        next: 0,
                    },
                    GuestAddress(base),
                )
                .unwrap();
            new_memory
                .write_obj(
                    if index < 2 { 1u16 } else { 0u16 },
                    GuestAddress(base + 0x1002),
                )
                .unwrap();
            new_memory
                .write_obj(0u16, GuestAddress(base + 0x1004))
                .unwrap();
            if index == 1 {
                new_memory
                    .write_slice(&[0x71; 16], GuestAddress(0x14000))
                    .unwrap();
            }
            new_queues.push(DeviceQueue::new(
                queue,
                Arc::new(EventFd::new(EFD_NONBLOCK).unwrap()),
            ));
        }
        device.set_acked_features(FEATURES);
        device
            .activate(new_memory.clone(), interrupt(), new_queues)
            .unwrap();
        assert!(device.pending.is_some());
        assert_eq!(access.pinned_usage().0, 8); // Old and new permanent rings both owned.
        release.send(()).unwrap();
        wait(|| device.active.as_ref().unwrap().thread.is_finished());
        device.progress_lifecycle().unwrap();
        assert!(device.pending.is_none());
        peer.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        peer.write_all(&[0x72; 16]).unwrap();
        let mut received = [0; 16];
        peer.read_exact(&mut received).unwrap();
        assert!(received.iter().all(|byte| *byte == 0x71));
        wait(|| new_memory.read_obj::<u16>(GuestAddress(0x3002)).unwrap() == 1);
        device.reset();
        wait(|| device.active.as_ref().unwrap().thread.is_finished());
        device.progress_lifecycle().unwrap();
        assert!(device.active.is_none());
        assert_eq!(access.pinned_usage().0, 0);
    }
    #[test]
    fn runtime_port_peer_eof_terminal_notifier_never_acks_guest() {
        let (access, token, queues, events, memory) = fixture();
        let (stream, peer) = crate::stream_io::test_pair();
        let notices = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = notices.clone();
        access.set_terminal_notifier(Arc::new(move || {
            count.fetch_add(1, Ordering::Release);
        }));
        let mut device = data_test_device(access.clone(), token, stream).unwrap();
        device.pending = Some(Pending {
            queues,
            events,
            interrupt: interrupt(),
        });
        device.activated = true;
        device.progress_lifecycle().unwrap();
        drop(peer);
        wait(|| access.stopped());
        wait(|| device.active.as_ref().unwrap().thread.is_finished());
        assert!(notices.load(Ordering::Acquire) > 0);
        assert_eq!(memory.read_obj::<u16>(GuestAddress(0x3002)).unwrap(), 0);
        assert!(device.progress_lifecycle().is_err());
    }
    #[test]
    fn runtime_port_actual_worker_tx_backpressure_keeps_pin_stop_has_zero_old_ack() {
        let (access, _token, queues, events, memory) = fixture();
        let (stream, _peer) = crate::stream_io::test_pair();
        let small = 4096i32;
        unsafe {
            libc::setsockopt(
                stream.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_SNDBUF,
                &small as *const _ as *const _,
                4,
            )
        };
        let bytes = [0u8; CHUNK];
        let mut full = false;
        for _ in 0..256 {
            match stream.write_owned(&bytes) {
                Ok(_) => {}
                Err(e) if e.kind() == ErrorKind::WouldBlock => {
                    full = true;
                    break;
                }
                Err(_) => panic!("metadata IO error"),
            }
        }
        assert!(full);
        let stop = Arc::new(AtomicBool::new(false));
        let stopfd = EventFd::new(EFD_NONBLOCK).unwrap();
        let mut worker = Worker {
            queues,
            events,
            stream,
            stop: stop.clone(),
            stopfd: stopfd.try_clone().unwrap(),
            interrupt: interrupt(),
            rx: None,
            tx: None,
            control_rx: None,
            control_tx: None,
            control: Control::opened_for_test(),
            transition: None,
            response: None,
            trace: None,
            observe_tx: None,
        };
        let thread = std::thread::spawn(move || worker.run());
        wait(|| access.pinned_usage().0 == 6);
        let frozen = access.freeze(1, Duration::from_secs(1)).unwrap();
        assert_eq!(access.active_leases(), 0);
        assert!(frozen.exclusions().iter().any(|r| r.gpa == 0x14000));
        assert_eq!(memory.read_obj::<u16>(GuestAddress(0x9002)).unwrap(), 0);
        stop.store(true, Ordering::Release);
        stopfd.write(1).unwrap();
        assert!(thread.join().unwrap().is_err());
        frozen.resume().unwrap();
        assert_eq!(memory.read_obj::<u16>(GuestAddress(0x9002)).unwrap(), 0);
    }
    #[test]
    fn runtime_port_explicit_rx_owned_limit_report_limit_and_cross_region() {
        let (_access, _token, mut queues, _events, memory) = fixture();
        memory
            .write_obj(
                Descriptor {
                    addr: 0x10000,
                    len: 60 * 1024,
                    flags: 2,
                    next: 0,
                },
                GuestAddress(0x1000),
            )
            .unwrap();
        let frame = queues.capture(true).unwrap().unwrap();
        assert_eq!(frame.capacity, CHUNK);
        assert_eq!(frame.data.len(), CHUNK);
        drop(frame);
        for cross in [false, true] {
            let memory = if cross {
                GuestMemoryMmap::from_ranges(&[
                    (GuestAddress(0), 0x18000),
                    (GuestAddress(0x18000), 0x8000),
                ])
                .unwrap()
            } else {
                GuestMemoryMmap::from_ranges(&[(GuestAddress(0), 0x140000)]).unwrap()
            };
            let (access, _token, mut queues, _events, memory) = fixture_memory(memory);
            memory
                .write_obj(
                    Descriptor {
                        addr: if cross { 0x17ff8 } else { 0x10000 },
                        len: if cross { 16 } else { (MAX_CHAIN + 1) as u32 },
                        flags: 2,
                        next: 0,
                    },
                    GuestAddress(0x1000),
                )
                .unwrap();
            assert!(queues.capture(true).is_err());
            assert_eq!(memory.read_obj::<u16>(GuestAddress(0x3002)).unwrap(), 0);
            assert_eq!(access.pinned_usage().0, 4);
        }
    }
    #[test]
    fn runtime_port_actual_event_manager_notify_before_finished_reset_completion() {
        use polly::event_manager::EventManager;
        use std::sync::Mutex;
        let (access, token, old_queues, old_events, _) = fixture();
        let (stream, mut peer) = crate::stream_io::test_pair();
        let console = Arc::new(Mutex::new(
            data_test_device(access.clone(), token, stream).unwrap(),
        ));
        let (done, owned_stream) = {
            let device = console.lock().unwrap();
            (
                device.done.try_clone().unwrap(),
                device.stream.duplicate().unwrap(),
            )
        };
        let (notified, notice) = std::sync::mpsc::sync_channel(0);
        let (release, waiting) = std::sync::mpsc::sync_channel(0);
        let old = std::thread::spawn(move || {
            done.write(1).unwrap();
            notified.send(()).unwrap();
            waiting.recv_timeout(Duration::from_secs(2)).unwrap();
            Finished {
                _ownership: Worker {
                    queues: old_queues,
                    events: old_events,
                    stream: owned_stream,
                    stop: Arc::new(AtomicBool::new(true)),
                    stopfd: EventFd::new(EFD_NONBLOCK).unwrap(),
                    interrupt: interrupt(),
                    rx: None,
                    tx: None,
                    control_rx: None,
                    control_tx: None,
                    control: Control::opened_for_test(),
                    transition: None,
                    response: None,
                    trace: None,
                    observe_tx: None,
                },
                result: Err(Fault::Stopped),
            }
        });
        notice.recv_timeout(Duration::from_secs(1)).unwrap();
        {
            let mut device = console.lock().unwrap();
            device.active = Some(Active {
                thread: old,
                stop: Arc::new(AtomicBool::new(false)),
                stopfd: EventFd::new(EFD_NONBLOCK).unwrap(),
            });
            device.activated = true;
            device.reset();
        }
        let mut manager = EventManager::new().unwrap();
        manager.add_subscriber(console.clone()).unwrap();
        assert!(manager.run_cowork_lifecycle_timeout(100).unwrap() > 0);
        // Darwin emulates eventfd with a pipe: consume both bounded pre-finish notices.
        // Readiness check avoids accidentally blocking this owned test on the historical 3s shim.
        for _ in 0..4 {
            let fd = console.lock().unwrap().done.as_raw_fd();
            let mut ready = libc::pollfd {
                fd,
                events: libc::POLLIN,
                revents: 0,
            };
            if unsafe { libc::poll(&mut ready, 1, 0) } <= 0 {
                break;
            }
            manager.run_cowork_lifecycle_timeout(0).unwrap();
        }
        assert!(console.lock().unwrap().active.is_some());
        assert!(lifecycle_tick(&console)); // Completion notice was consumed BEFORE actual thread finished.
        let (_other, _other_token, new, events, memory) = fixture();
        let StreamQueues {
            rx,
            tx,
            control_rx,
            control_tx,
            ..
        } = new;
        let new_queues = vec![
            DeviceQueue::new(rx, events[0].clone()),
            DeviceQueue::new(tx, events[1].clone()),
            DeviceQueue::new(control_rx, events[2].clone()),
            DeviceQueue::new(control_tx, events[3].clone()),
        ];
        console.lock().unwrap().set_acked_features(FEATURES);
        console
            .lock()
            .unwrap()
            .activate(memory.clone(), interrupt(), new_queues)
            .unwrap();
        assert_eq!(access.pinned_usage().0, 8);
        release.send(()).unwrap();
        wait(|| {
            console
                .lock()
                .unwrap()
                .active
                .as_ref()
                .unwrap()
                .thread
                .is_finished()
        });
        assert_eq!(access.pinned_usage().0, 8);
        let bounded_started = Instant::now();
        assert_eq!(manager.run_cowork_lifecycle_timeout(5).unwrap(), 0);
        assert!(bounded_started.elapsed() < Duration::from_millis(100));

        assert!(!lifecycle_tick(&console));
        peer.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        peer.write_all(&[0x66; 16]).unwrap();
        let mut received = [0; 16];
        peer.read_exact(&mut received).unwrap();
        assert!(received.iter().all(|b| *b == 0x31));
        wait(|| memory.read_obj::<u16>(GuestAddress(0x3002)).unwrap() == 1);
        console.lock().unwrap().reset();
        let deadline = Instant::now() + Duration::from_secs(1);
        loop {
            manager.run_cowork_lifecycle_timeout(5).unwrap();
            if !lifecycle_tick(&console) {
                break;
            }
            assert!(Instant::now() < deadline);
        }
        assert_eq!(access.pinned_usage().0, 0);
    }
    #[test]
    fn runtime_port_actual_short_tx_has_no_replay_across_freeze_or_reset() {
        use std::sync::atomic::AtomicUsize;
        for reset in [false, true] {
            let (access, token, queues, events, memory) = fixture();
            let length = 48 * 1024;
            memory
                .write_obj(
                    Descriptor {
                        addr: 0x14000,
                        len: length as u32,
                        flags: 0,
                        next: 0,
                    },
                    GuestAddress(0x7000),
                )
                .unwrap();
            let expected = (0..length).map(|n| (n % 251 + 1) as u8).collect::<Vec<_>>();
            memory
                .write_slice(&expected, GuestAddress(0x14000))
                .unwrap();
            let (stream, mut peer) = crate::stream_io::test_pair();
            let small = 4096i32;
            unsafe {
                libc::setsockopt(
                    stream.as_raw_fd(),
                    libc::SOL_SOCKET,
                    libc::SO_SNDBUF,
                    &small as *const _ as *const _,
                    4,
                )
            };
            let offset = Arc::new(AtomicUsize::new(0));
            let short = Arc::new(AtomicBool::new(false));
            let stop = Arc::new(AtomicBool::new(false));
            let stopfd = EventFd::new(EFD_NONBLOCK).unwrap();
            let retained_stream = stream.duplicate().unwrap();
            let mut worker = Worker {
                queues,
                events,
                stream,
                stop: stop.clone(),
                stopfd: stopfd.try_clone().unwrap(),
                interrupt: interrupt(),
                rx: None,
                tx: None,
                control_rx: None,
                control_tx: None,
                control: Control::opened_for_test(),
                transition: None,
                response: None,
                trace: None,
                observe_tx: Some((offset.clone(), short.clone())),
            };
            let thread = std::thread::spawn(move || {
                let result = worker.run();
                Finished {
                    _ownership: worker,
                    result,
                }
            });
            wait(|| short.load(Ordering::Acquire));
            assert!(offset.load(Ordering::Acquire) > 0 && offset.load(Ordering::Acquire) < length);
            peer.set_nonblocking(true).unwrap();
            let mut received = Vec::new();
            if reset {
                let mut device = data_test_device(access.clone(), token, retained_stream).unwrap();
                device.active = Some(Active {
                    thread,
                    stop,
                    stopfd,
                });
                device.activated = true;
                device.reset();
                wait(|| device.active.as_ref().unwrap().thread.is_finished());
                let count = offset.load(Ordering::Acquire);
                assert!(count < length);
                device.progress_lifecycle().unwrap();
                let deadline = Instant::now() + Duration::from_secs(1);
                while received.len() < count {
                    let mut chunk = [0; 7];
                    match peer.read(&mut chunk) {
                        Ok(n) if n > 0 => received.extend_from_slice(&chunk[..n]),
                        Err(e) if e.kind() == ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(1))
                        }
                        _ => panic!("short TX metadata read"),
                    };
                    assert!(Instant::now() < deadline);
                }
                assert!(received == expected[..count]);
                assert_eq!(memory.read_obj::<u16>(GuestAddress(0x9002)).unwrap(), 0);
                let mut extra = [0; 1];
                assert!(peer.read(&mut extra).unwrap_err().kind() == ErrorKind::WouldBlock);
            } else {
                let frozen = access.freeze(1, Duration::from_secs(1)).unwrap();
                assert!(frozen.exclusions().iter().any(|r| r.gpa == 0x14000));
                let deadline = Instant::now() + Duration::from_secs(2);
                while received.len() < length {
                    let mut chunk = [0; 7];
                    match peer.read(&mut chunk) {
                        Ok(n) if n > 0 => received.extend_from_slice(&chunk[..n]),
                        Err(e) if e.kind() == ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(1))
                        }
                        _ => panic!("short TX metadata read"),
                    };
                    assert!(Instant::now() < deadline);
                }
                assert!(received == expected);
                assert_eq!(memory.read_obj::<u16>(GuestAddress(0x9002)).unwrap(), 0);
                frozen.resume().unwrap();
                wait(|| memory.read_obj::<u16>(GuestAddress(0x9002)).unwrap() == 1);
                stop.store(true, Ordering::Release);
                stopfd.write(1).unwrap();
                thread.join().unwrap();
                let mut extra = [0; 1];
                assert!(peer.read(&mut extra).unwrap_err().kind() == ErrorKind::WouldBlock);
            }
        }
    }
}

#[cfg(test)]
mod protocol_queue_tests {
    use super::*;
    use crate::virtio::Descriptor;
    use std::time::Duration;
    fn packet(memory: &GuestMemoryMmap, index: u16, bytes: &[u8]) {
        memory.write_slice(bytes, GuestAddress(0x18000)).unwrap();
        memory
            .write_obj(
                Descriptor {
                    addr: 0x18000,
                    len: bytes.len() as u32,
                    flags: 0,
                    next: 0,
                },
                GuestAddress(0xa000),
            )
            .unwrap();
        memory
            .write_obj(0u16, GuestAddress(0xb004 + u64::from(index % 8) * 2))
            .unwrap();
        memory.write_obj(index + 1, GuestAddress(0xb002)).unwrap();
    }
    fn fixture() -> (Worker, GuestMemoryMmap, std::os::unix::net::UnixStream) {
        let memory = GuestMemoryMmap::from_ranges(&[(GuestAddress(0), 0x20000)]).unwrap();
        let access = Access::new(2, 32, 8 * 1024 * 1024);
        let device = access.register(1).unwrap();
        let mut queues = Vec::new();
        for (index, base) in [0x1000, 0x7000, 0x4000, 0xa000].into_iter().enumerate() {
            let mut q = Queue::new(8);
            q.ready = true;
            q.size = 8;
            q.desc_table = GuestAddress(base);
            q.avail_ring = GuestAddress(base + 0x1000);
            q.used_ring = GuestAddress(base + 0x2000);
            memory
                .write_obj(
                    Descriptor {
                        addr: if index == 2 { 0x17000 } else { 0x18000 },
                        len: 4096,
                        flags: if index % 2 == 0 { 2 } else { 0 },
                        next: 0,
                    },
                    GuestAddress(base),
                )
                .unwrap();
            if index == 2 {
                memory.write_obj(1u16, GuestAddress(base + 0x1002)).unwrap();
            }
            queues.push(DeviceQueue::new(
                q,
                Arc::new(EventFd::new(EFD_NONBLOCK).unwrap()),
            ));
        }
        let (queues, events) = StreamQueues::new(memory.clone(), queues, access, device).unwrap();
        let (stream, peer) = crate::stream_io::test_pair();
        let w = Worker {
            queues,
            events,
            stream,
            stop: Arc::new(AtomicBool::new(false)),
            stopfd: EventFd::new(EFD_NONBLOCK).unwrap(),
            interrupt: super::tests::interrupt(),
            rx: None,
            tx: None,
            control_rx: None,
            control_tx: None,
            control: Control::new(),
            transition: None,
            response: None,
            trace: None,
            observe_tx: None,
        };
        (w, memory, peer)
    }
    #[test]
    fn runtime_port_actual_four_queue_linux_handshake_copy_ack_and_data_gate() {
        let (mut worker, memory, _peer) = fixture();
        assert!(!worker.control.open());
        packet(
            &memory,
            0,
            &super::super::runtime_port_control::frame(u32::MAX, 0, 1),
        );
        worker.control_turn().unwrap();
        assert_eq!(memory.read_obj::<u16>(GuestAddress(0xc002)).unwrap(), 1);
        assert_eq!(memory.read_obj::<u16>(GuestAddress(0x6002)).unwrap(), 1);
        let mut reply = [0u8; 8];
        memory
            .read_slice(&mut reply, GuestAddress(0x17000))
            .unwrap();
        assert_eq!(reply, super::super::runtime_port_control::frame(0, 1, 0));
        assert!(!worker.control.open());
        memory.write_obj(0u16, GuestAddress(0x5006)).unwrap();
        memory.write_obj(2u16, GuestAddress(0x5002)).unwrap();
        packet(
            &memory,
            1,
            &super::super::runtime_port_control::frame(0, 3, 1),
        );
        worker.control_turn().unwrap();
        memory
            .read_slice(&mut reply, GuestAddress(0x17000))
            .unwrap();
        assert_eq!(reply, super::super::runtime_port_control::frame(0, 6, 1));
        assert!(!worker.control.open());
        packet(
            &memory,
            2,
            &super::super::runtime_port_control::frame(0, 6, 1),
        );
        worker.control_turn().unwrap();
        assert!(worker.control.open());
        assert_eq!(worker.queues.access.active_leases(), 0);
    }
    #[test]
    fn runtime_port_actual_control_freeze_holds_pin_no_ack_or_phase_advance() {
        let (mut worker, memory, _peer) = fixture();
        packet(
            &memory,
            0,
            &super::super::runtime_port_control::frame(u32::MAX, 0, 1),
        );
        worker.control_tx = worker.queues.capture_queue(false, true).unwrap();
        let frozen = worker
            .queues
            .access
            .freeze(1, Duration::from_secs(1))
            .unwrap();
        worker.control_turn().unwrap();
        assert_eq!(memory.read_obj::<u16>(GuestAddress(0xc002)).unwrap(), 0);
        assert!(!worker.control.open());
        assert!(worker.response.is_none());
        assert!(frozen.exclusions().iter().any(|r| r.gpa == 0x18000));
        assert_eq!(worker.queues.access.active_leases(), 0);
        frozen.resume().unwrap();
        worker.control_turn().unwrap();
        assert_eq!(memory.read_obj::<u16>(GuestAddress(0xc002)).unwrap(), 1);
        assert!(worker
            .control
            .validate(&super::super::runtime_port_control::frame(0, 3, 1))
            .is_ok());
    }
    #[test]
    fn runtime_port_actual_stale_control_generation_never_acks_or_advances() {
        let (mut worker, memory, _peer) = fixture();
        packet(
            &memory,
            0,
            &super::super::runtime_port_control::frame(u32::MAX, 0, 1),
        );
        worker.control_tx = worker.queues.capture_queue(false, true).unwrap();
        worker
            .queues
            .access
            .retire_generation(worker.queues.device)
            .unwrap();
        assert!(worker.control_turn().is_err());
        assert_eq!(memory.read_obj::<u16>(GuestAddress(0xc002)).unwrap(), 0);
        assert!(worker.response.is_none());
    }
    #[test]
    fn runtime_port_actual_malformed_control_direction_span_length_and_state_fault() {
        for option in 0..5 {
            let (mut worker, memory, _peer) = fixture();
            let bytes = super::super::runtime_port_control::frame(
                if option == 4 { 0 } else { u32::MAX },
                0,
                1,
            );
            packet(&memory, 0, &bytes);
            if option < 4 {
                memory
                    .write_obj(
                        Descriptor {
                            addr: if option == 3 { 0x1fffc } else { 0x18000 },
                            len: if option == 0 {
                                9
                            } else if option == 1 {
                                7
                            } else {
                                8
                            },
                            flags: if option == 2 { 2 } else { 0 },
                            next: 0,
                        },
                        GuestAddress(0xa000),
                    )
                    .unwrap();
            }
            assert!(worker.control_turn().is_err());
            assert_eq!(memory.read_obj::<u16>(GuestAddress(0xc002)).unwrap(), 0);
            assert!(worker.response.is_none());
            assert_eq!(worker.queues.access.active_leases(), 0);
        }
    }
    #[test]
    fn runtime_port_actual_control_ack_remains_live_during_data_peer_backpressure() {
        let (mut worker, memory, _peer) = fixture();
        worker.control = Control::opened_for_test();
        let small = 4096i32;
        unsafe {
            libc::setsockopt(
                worker.stream.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_SNDBUF,
                &small as *const _ as *const _,
                4,
            )
        };
        let mut full = false;
        for _ in 0..256 {
            match worker.stream.write_owned(&[0x41; CHUNK]) {
                Ok(_) => {}
                Err(error) if error.kind() == ErrorKind::WouldBlock => {
                    full = true;
                    break;
                }
                _ => panic!("metadata socket capacity failure"),
            }
        }
        assert!(full);
        memory
            .write_obj(
                Descriptor {
                    addr: 0x14000,
                    len: 16,
                    flags: 0,
                    next: 0,
                },
                GuestAddress(0x7000),
            )
            .unwrap();
        memory.write_obj(1u16, GuestAddress(0x8002)).unwrap();
        let access = worker.queues.access.clone();
        let kick = worker.events[3].clone();
        let thread = std::thread::spawn(move || {
            let result = worker.run();
            (result, worker)
        });
        super::tests::wait(|| access.pinned_usage().0 == 5);
        packet(
            &memory,
            0,
            &super::super::runtime_port_control::frame(0, 6, 0),
        );
        kick.write(1).unwrap();
        super::tests::wait(|| thread.is_finished());
        let (result, worker) = thread.join().unwrap();
        assert_eq!(result, Err(Fault::Stopped));
        assert_eq!(memory.read_obj::<u16>(GuestAddress(0xc002)).unwrap(), 1);
        assert_eq!(memory.read_obj::<u16>(GuestAddress(0x9002)).unwrap(), 0);
        assert_eq!(access.active_leases(), 0);
        drop(worker);
    }

    #[test]
    fn runtime_port_requires_both_features_before_four_queue_activation() {
        for features in [0, 1u64 << 32, 1u64 << 1] {
            let (worker, memory, _peer) = fixture();
            let access = worker.queues.access.clone();
            let token = worker.queues.device;
            let StreamQueues {
                rx,
                tx,
                control_rx,
                control_tx,
                ..
            } = worker.queues;
            let queues = vec![
                DeviceQueue::new(rx, worker.events[0].clone()),
                DeviceQueue::new(tx, worker.events[1].clone()),
                DeviceQueue::new(control_rx, worker.events[2].clone()),
                DeviceQueue::new(control_tx, worker.events[3].clone()),
            ];
            let mut port = GuardedPort::new(access.clone(), token, worker.stream).unwrap();
            port.set_acked_features(features);
            assert!(port
                .activate(memory, super::tests::interrupt(), queues)
                .is_err());
            assert!(access.stopped());
            assert!(!port.is_activated());
        }
    }
    #[test]
    fn runtime_port_actual_control_rx_freeze_holds_entire_destination_until_fresh_copy_ack() {
        let (mut worker, memory, _peer) = fixture();
        packet(
            &memory,
            0,
            &super::super::runtime_port_control::frame(u32::MAX, 0, 1),
        );
        worker.control_tx = worker.queues.capture_queue(false, true).unwrap();
        let frame = worker.control_tx.as_mut().unwrap();
        frame.offset = CONTROL_BYTES;
        let transition = worker.control.validate(&frame.data).unwrap();
        worker.queues.complete_queue(false, true, frame).unwrap();
        worker.control_tx = None;
        worker.response = transition.response;
        worker.control.apply(transition);
        worker.control_rx = worker.queues.capture_queue(true, true).unwrap();
        let frozen = worker
            .queues
            .access
            .freeze(1, Duration::from_secs(1))
            .unwrap();
        worker.control_turn().unwrap();
        assert_eq!(memory.read_obj::<u16>(GuestAddress(0x6002)).unwrap(), 0);
        assert!(worker.response.is_some());
        assert_eq!(worker.queues.access.active_leases(), 0);
        assert!(frozen
            .exclusions()
            .iter()
            .any(|r| r.gpa == 0x17000 && r.len == 4096));
        let mut before = [0u8; 8];
        memory
            .read_slice(&mut before, GuestAddress(0x17000))
            .unwrap();
        assert_eq!(before, [0; 8]);
        frozen.resume().unwrap();
        worker.control_turn().unwrap();
        assert_eq!(memory.read_obj::<u16>(GuestAddress(0x6002)).unwrap(), 1);
        let mut after = [0u8; 8];
        memory
            .read_slice(&mut after, GuestAddress(0x17000))
            .unwrap();
        assert_eq!(after, super::super::runtime_port_control::frame(0, 1, 0));
        assert!(worker.response.is_none());
    }
    #[test]
    fn runtime_port_fixture_trace_frozen_control_has_no_rows_until_actual_used_ack() {
        let (mut worker, memory, _peer) = fixture();
        let trace = Trace::new();
        worker.trace = Some(trace.clone());
        packet(
            &memory,
            0,
            &super::super::runtime_port_control::frame(u32::MAX, 0, 1),
        );
        worker.control_tx = worker.queues.capture_queue(false, true).unwrap();
        let frozen = worker
            .queues
            .access
            .freeze(1, Duration::from_secs(1))
            .unwrap();
        worker.control_turn().unwrap();
        assert_eq!(trace.row_count(), 0);
        assert_eq!(memory.read_obj::<u16>(GuestAddress(0xc002)).unwrap(), 0);
        frozen.resume().unwrap();
        worker.control_turn().unwrap();
        assert_eq!(trace.row_count(), 2);
        assert_eq!(memory.read_obj::<u16>(GuestAddress(0xc002)).unwrap(), 1);
        assert_eq!(memory.read_obj::<u16>(GuestAddress(0x6002)).unwrap(), 1);
    }
}
