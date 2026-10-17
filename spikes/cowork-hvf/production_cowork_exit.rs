//! Exit reasons and the single termination path of a Cowork VMM process.
//!
//! Every way a started VM ends goes through `finish`: the guest powering off (PSCI SYSTEM_OFF) or resetting
//! (SYSTEM_RESET), a vCPU error, and a terminal fault (a pin, lease, reclaim or lifecycle failure, or
//! `fatal()` in the reclaim fixture). `finish` runs the registered exit observers once, in registration
//! order, then `_exit`s. The reason is recorded once (first writer wins) so the worker's exit hook, which is
//! registered last, can tell a clean power-off from a reset and from a fault.
//!
//! Not covered: hard crashes (SIGSEGV, SIGBUS, SIGILL, SIGSYS and the like). `signal_handler::register_signal_handlers`
//! is never called in this process, so a crash signal kills it by its default disposition: no observer, no hook,
//! a signal exit status. A panic across an `extern "C"` frame aborts. Those are "uncertain" exits: the worker's
//! owner must treat them as such. The watchdog is also not covered by the hook: when it fires over a hung
//! observer the process exits with the effective status (0 after a clean off or reset) and the hook never ran.
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
    finish_with_budget(observers, requested_code, OBSERVER_BUDGET)
}

/// `finish` with the watchdog budget as a parameter, so a test can run the real sequence with a short one in a
/// child process. Production only ever passes `OBSERVER_BUDGET` (pinned by a test).
pub fn finish_with_budget(observers: &Observers, requested_code: i32, budget: Duration) -> ! {
    if !STATE.claim() {
        loop {
            std::thread::park();
        }
    }
    let code = STATE.effective_code(requested_code);
    std::thread::spawn(move || {
        std::thread::sleep(budget);
        unsafe { libc::_exit(code) }
    });
    run_observers(observers);
    unsafe { libc::_exit(code) }
}

/// The terminal-fault notifier's state change: record the reason (so a late clean-stop status cannot hide it
/// and the exit hook reports it) and publish status 77 to the exit code the run loop reads.
pub fn note_terminal_fault(code: &std::sync::atomic::AtomicI32) {
    note_terminal_fault_in(&STATE, code);
}
pub fn note_terminal_fault_in(state: &ExitState, code: &std::sync::atomic::AtomicI32) {
    state.record(REASON_TERMINAL_FAULT);
    code.store(TERMINAL_FAULT_EXIT_CODE, Ordering::SeqCst);
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
    #[test]
    fn the_production_budget_is_twenty_seconds_and_finish_uses_it() {
        assert_eq!(OBSERVER_BUDGET, Duration::from_secs(20));
        let source = include_str!("cowork_exit.rs");
        let body = &source[source.find("pub fn finish(observers").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        assert!(body.contains("finish_with_budget(observers, requested_code, OBSERVER_BUDGET)"));
    }

    #[test]
    fn the_terminal_fault_notifier_records_the_reason_and_publishes_status_77() {
        let state = ExitState::new();
        let code = std::sync::atomic::AtomicI32::new(i32::MAX);
        note_terminal_fault_in(&state, &code);
        assert_eq!(state.reason(), REASON_TERMINAL_FAULT);
        assert_eq!(code.load(Ordering::SeqCst), 77);
        // The builder's notifier goes through it (a text pin: the closure cannot run without a VMM).
        let builder = include_str!("builder.rs");
        let at = builder.find("access.set_terminal_notifier(").expect("notifier");
        let closure = &builder[at..at + builder[at..].find("Some(access)").unwrap()];
        assert!(closure.contains("crate::cowork_exit::note_terminal_fault(&terminal_code)"));
    }

    // The exit sequence ends in `_exit`, so it is run for real in a child process: this test binary re-executed
    // with one case selected through the environment. Without the variable the `child_*` tests do nothing.
    const CASE: &str = "COWORK_EXIT_TEST_CASE";
    const LOG: &str = "COWORK_EXIT_TEST_LOG";

    struct Appender(&'static str);
    impl VmmExitObserver for Appender {
        fn on_vmm_exit(&mut self) {
            use std::io::Write;
            let path = std::env::var(LOG).unwrap();
            let mut file = std::fs::OpenOptions::new().append(true).create(true).open(path).unwrap();
            writeln!(file, "{}", self.0).unwrap();
        }
    }
    struct Hang;
    impl VmmExitObserver for Hang {
        fn on_vmm_exit(&mut self) {
            loop {
                std::thread::sleep(Duration::from_secs(3600));
            }
        }
    }
    struct SleepAfterAppend(&'static str);
    impl VmmExitObserver for SleepAfterAppend {
        fn on_vmm_exit(&mut self) {
            Appender(self.0).on_vmm_exit();
            std::thread::sleep(Duration::from_millis(400));
        }
    }
    fn list(items: Vec<Box<dyn FnOnce() -> Arc<Mutex<dyn VmmExitObserver>>>>) -> Observers {
        items.into_iter().map(|make| make()).collect()
    }

    #[test]
    fn child_exit_sequence() {
        let Ok(case) = std::env::var(CASE) else { return };
        let short = Duration::from_millis(300);
        match case.as_str() {
            // An observer that never returns: the watchdog must end the process with the requested status.
            "hang_fault" => {
                record(REASON_TERMINAL_FAULT);
                let observers = list(vec![Box::new(|| Arc::new(Mutex::new(Appender("first")))), Box::new(|| Arc::new(Mutex::new(Hang))), Box::new(|| Arc::new(Mutex::new(Appender("hook"))))]);
                finish_with_budget(&observers, 77, short)
            }
            // After a clean power-off the watchdog exits 0 and the hook (registered last) never ran.
            "hang_after_off" => {
                record(REASON_OFF);
                let observers = list(vec![Box::new(|| Arc::new(Mutex::new(Hang))), Box::new(|| Arc::new(Mutex::new(Appender("hook"))))]);
                finish_with_budget(&observers, 77, short)
            }
            // A late fault after a clean stop keeps status 0; a fault alone keeps its status.
            "off_then_fault" => {
                record(REASON_OFF);
                finish_with_budget(&Vec::new(), 77, Duration::from_secs(20))
            }
            "reset_then_fault" => {
                record(REASON_RESET);
                finish_with_budget(&Vec::new(), 77, Duration::from_secs(20))
            }
            "fault" => {
                record(REASON_TERMINAL_FAULT);
                finish_with_budget(&Vec::new(), 77, Duration::from_secs(20))
            }
            // Two threads race into the exit path: exactly one runs the observers.
            "two_callers" => {
                record(REASON_VCPU_ERROR);
                let barrier = Arc::new(std::sync::Barrier::new(2));
                let _other = {
                    let barrier = barrier.clone();
                    std::thread::spawn(move || {
                        let observers: Observers = vec![Arc::new(Mutex::new(SleepAfterAppend("second")))];
                        barrier.wait();
                        finish_with_budget(&observers, 77, Duration::from_secs(20))
                    })
                };
                let observers: Observers = vec![Arc::new(Mutex::new(SleepAfterAppend("first")))];
                barrier.wait();
                finish_with_budget(&observers, 77, Duration::from_secs(20))
            }
            other => panic!("unknown case {other}"),
        }
    }

    /// Runs one child case; returns (exit status code, seconds, log lines). The child is killed after 30 s.
    fn run_child(case: &str) -> (Option<i32>, f64, Vec<String>) {
        let log = std::env::temp_dir().join(format!("winter-cowork-exit-{}-{case}.log", std::process::id()));
        let _ = std::fs::remove_file(&log);
        let started = std::time::Instant::now();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "cowork_exit::tests::child_exit_sequence", "--test-threads=1", "--nocapture"])
            .env(CASE, case)
            .env(LOG, &log)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break Some(status);
            }
            if started.elapsed() > Duration::from_secs(30) {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        let seconds = started.elapsed().as_secs_f64();
        let lines = std::fs::read_to_string(&log).map(|text| text.lines().map(str::to_string).collect()).unwrap_or_default();
        let _ = std::fs::remove_file(&log);
        (status.and_then(|s| s.code()), seconds, lines)
    }

    #[test]
    fn a_hung_observer_cannot_keep_the_process_alive_past_the_budget() {
        let (code, seconds, lines) = run_child("hang_fault");
        assert_eq!(code, Some(77), "the watchdog ends the process with the requested status (None means it was still alive after 30 s)");
        assert!(seconds < 15.0, "{seconds}");
        // Observers before the hung one ran; the ones after it, the exit hook among them, did not.
        assert_eq!(lines, vec!["first".to_string()]);
    }

    #[test]
    fn the_watchdog_over_a_hung_observer_after_a_clean_off_exits_zero_without_the_hook() {
        let (code, seconds, lines) = run_child("hang_after_off");
        assert_eq!(code, Some(0));
        assert!(seconds < 15.0, "{seconds}");
        assert!(lines.is_empty(), "the hook must not have run: {lines:?}");
    }

    #[test]
    fn the_exit_status_follows_the_recorded_reason_through_the_real_sequence() {
        assert_eq!(run_child("off_then_fault").0, Some(0));
        assert_eq!(run_child("reset_then_fault").0, Some(0));
        assert_eq!(run_child("fault").0, Some(77));
    }

    #[test]
    fn two_callers_in_the_exit_path_run_the_observers_once() {
        let (code, _, lines) = run_child("two_callers");
        assert_eq!(code, Some(77));
        assert_eq!(lines.len(), 1, "{lines:?}");
    }
}
