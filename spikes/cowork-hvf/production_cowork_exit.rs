//! Exit reasons and the single termination path of a Cowork VMM process.
//!
//! Every way a started VM ends goes through `finish`: the guest powering off (PSCI SYSTEM_OFF) or resetting
//! (SYSTEM_RESET), a vCPU error, and a terminal fault (a pin, lease, reclaim or lifecycle failure, or
//! `fatal()` in the reclaim fixture). `finish` runs the registered exit observers once, in registration
//! order, then `_exit`s. The reason is recorded once (first writer wins) so the worker's exit hook, which is
//! registered last, can tell a clean power-off from a reset and from a fault.
//!
//! Not covered: hard crashes (SIGSEGV, SIGBUS, SIGILL, SIGSYS and the like) exit from a signal handler with
//! `_exit` and cannot run observers or the hook, and a panic across an `extern "C"` frame aborts. Those are
//! "uncertain" exits: the worker's owner must treat them as such.
use devices::virtio::VmmExitObserver;
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

pub const REASON_NONE: u32 = 0;
/// The guest called PSCI SYSTEM_OFF: an orderly power-off.
pub const REASON_OFF: u32 = 1;
/// The guest called PSCI SYSTEM_RESET. Not an orderly power-off.
pub const REASON_RESET: u32 = 2;
/// A vCPU stopped on an emulation error.
pub const REASON_VCPU_ERROR: u32 = 3;
/// A terminal fault stopped the VMM (exit status 77).
pub const REASON_TERMINAL_FAULT: u32 = 4;
pub const TERMINAL_FAULT_EXIT_CODE: i32 = 77;
/// Upper bound on the whole observer sequence. A watchdog thread exits the process with the same status
/// when it elapses, so an observer that cannot finish (a join on a worker stuck in host I/O) cannot keep
/// the process alive; what is left, including the exit hook, is skipped.
pub const OBSERVER_BUDGET: Duration = Duration::from_secs(20);

pub type Observers = Vec<Arc<Mutex<dyn VmmExitObserver>>>;

/// First-writer-wins reason and the claim that lets exactly one thread run the exit sequence.
pub struct ExitState {
    reason: AtomicU32,
    finishing: AtomicBool,
}
impl ExitState {
    pub const fn new() -> Self {
        Self { reason: AtomicU32::new(REASON_NONE), finishing: AtomicBool::new(false) }
    }
    pub fn record(&self, reason: u32) {
        let _ = self.reason.compare_exchange(REASON_NONE, reason, Ordering::AcqRel, Ordering::Acquire);
    }
    pub fn reason(&self) -> u32 {
        self.reason.load(Ordering::Acquire)
    }
    /// A guest that already stopped cleanly (off or reset) exits with status 0 even if a late stop-wins
    /// fault fires while the VMM winds down; any other reason keeps the requested status.
    pub fn effective_code(&self, requested: i32) -> i32 {
        if matches!(self.reason(), REASON_OFF | REASON_RESET) { 0 } else { requested }
    }
    /// True for exactly one caller.
    pub fn claim(&self) -> bool {
        !self.finishing.swap(true, Ordering::AcqRel)
    }
}
impl Default for ExitState {
    fn default() -> Self {
        Self::new()
    }
}

static STATE: ExitState = ExitState::new();
static OBSERVERS: OnceLock<Observers> = OnceLock::new();

pub fn record(reason: u32) {
    STATE.record(reason);
}
pub fn reason() -> u32 {
    STATE.reason()
}
/// Publishes the final observer list (the exit hook last) so `terminate` can reach it from code that has
/// no `&mut Vmm`.
pub fn publish(observers: &Observers) {
    let _ = OBSERVERS.set(observers.clone());
}

/// Runs the observers in order, each once. A poisoned lock does not stop the sequence.
pub fn run_observers(observers: &[Arc<Mutex<dyn VmmExitObserver>>]) {
    for observer in observers {
        observer.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).on_vmm_exit();
    }
}

/// The one exit path: claim, bound, run the observers, `_exit`. A second thread that arrives here while
/// the first is finishing never returns.
pub fn finish(observers: &Observers, requested_code: i32) -> ! {
    if !STATE.claim() {
        loop {
            std::thread::park();
        }
    }
    let code = STATE.effective_code(requested_code);
    std::thread::spawn(move || {
        std::thread::sleep(OBSERVER_BUDGET);
        unsafe { libc::_exit(code) }
    });
    run_observers(observers);
    unsafe { libc::_exit(code) }
}

/// For callers without the VMM (the reclaim fixture's `fatal()`): record the reason and take the same
/// path. Before the observers are published there is nothing to run.
pub fn terminate(reason: u32, code: i32) -> ! {
    record(reason);
    match OBSERVERS.get() {
        Some(observers) => finish(observers, code),
        None => unsafe { libc::_exit(STATE.effective_code(code)) },
    }
}

/// The worker's exit hook (`krun_cowork_set_exit_hook_v1`). Registered last, so it runs after every
/// observer, including the final flush, and immediately before `_exit`, on the exiting thread.
#[derive(Clone, Copy)]
pub struct ExitHook {
    callback: extern "C" fn(*mut c_void, u32),
    user_data: usize,
}
impl ExitHook {
    pub fn new(callback: extern "C" fn(*mut c_void, u32), user_data: *mut c_void) -> Self {
        Self { callback, user_data: user_data as usize }
    }
}
impl VmmExitObserver for ExitHook {
    fn on_vmm_exit(&mut self) {
        (self.callback)(self.user_data as *mut c_void, reason());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn the_first_recorded_reason_wins() {
        let state = ExitState::new();
        assert_eq!(state.reason(), REASON_NONE);
        state.record(REASON_RESET);
        state.record(REASON_TERMINAL_FAULT);
        state.record(REASON_OFF);
        assert_eq!(state.reason(), REASON_RESET);
    }

    #[test]
    fn a_clean_guest_stop_keeps_status_zero_and_a_fault_keeps_its_status() {
        for (reason, expected) in [(REASON_OFF, 0), (REASON_RESET, 0), (REASON_VCPU_ERROR, 77), (REASON_TERMINAL_FAULT, 77), (REASON_NONE, 77)] {
            let state = ExitState::new();
            state.record(reason);
            assert_eq!(state.effective_code(TERMINAL_FAULT_EXIT_CODE), expected, "reason {reason}");
        }
    }

    #[test]
    fn exactly_one_caller_claims_the_exit_sequence() {
        let state = Arc::new(ExitState::new());
        let winners = Arc::new(AtomicUsize::new(0));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let (state, winners) = (state.clone(), winners.clone());
                std::thread::spawn(move || {
                    if state.claim() {
                        winners.fetch_add(1, Ordering::SeqCst);
                    }
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        assert_eq!(winners.load(Ordering::SeqCst), 1);
    }

    struct Probe(usize, Arc<Mutex<Vec<usize>>>, bool);
    impl VmmExitObserver for Probe {
        fn on_vmm_exit(&mut self) {
            self.1.lock().unwrap().push(self.0);
            if self.2 {
                panic!("an observer panicked");
            }
        }
    }

    #[test]
    fn observers_run_once_in_registration_order_and_survive_a_poisoned_lock() {
        let order = Arc::new(Mutex::new(Vec::new()));
        let poisoned: Arc<Mutex<dyn VmmExitObserver>> = Arc::new(Mutex::new(Probe(1, order.clone(), true)));
        // Poison the second observer's lock.
        let handle = poisoned.clone();
        let _ = std::thread::spawn(move || {
            let _guard = handle.lock().unwrap();
            panic!("poison");
        })
        .join();
        let observers: Observers = vec![Arc::new(Mutex::new(Probe(0, order.clone(), false))), poisoned.clone(), Arc::new(Mutex::new(Probe(2, order.clone(), false)))];
        // The poisoned observer's own callback panics too; run it inside catch_unwind so the test can read
        // the order of the others.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run_observers(&observers)));
        assert!(result.is_err());
        assert_eq!(*order.lock().unwrap(), vec![0, 1]);
    }

    #[test]
    fn the_hook_receives_the_recorded_reason() {
        static SEEN: AtomicU32 = AtomicU32::new(u32::MAX);
        static DATA: AtomicUsize = AtomicUsize::new(0);
        extern "C" fn callback(data: *mut c_void, reason: u32) {
            SEEN.store(reason, Ordering::SeqCst);
            DATA.store(data as usize, Ordering::SeqCst);
        }
        record(REASON_RESET);
        ExitHook::new(callback, 0x1234 as *mut c_void).on_vmm_exit();
        assert_eq!(SEEN.load(Ordering::SeqCst), reason());
        assert_eq!(DATA.load(Ordering::SeqCst), 0x1234);
    }
}
