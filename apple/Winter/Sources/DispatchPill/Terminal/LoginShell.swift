import Darwin
import Foundation

// The user's LOGIN shell, as the Dispatch pill's command mode sees it: which shell, what its PATH and aliases
// are (resolved once, off the main thread, cached and refreshed now and then), and how a line is run in it.
//
// The probe mirrors the daemon's (`packages/core/src/login-shell-path.ts`): `$SHELL -l -c <script>` with the
// interactive rc file sourced explicitly (stdin from /dev/null, its output discarded), the PATH printed between
// two markers so whatever a profile prints can never be mistaken for it, its own process group, a hard
// deadline after which the whole group is SIGKILLed. A RUN is an interactive login shell with the user's own
// startup files (`loginShellSessionInvocation`), so what the validator found on PATH is what the run can reach.
//
// Nothing here logs a command line, a PATH value or anything a shell printed.

// MARK: - Pure pieces (`ShellCommandLineTests`)

let loginShellPathStart = "__WINTER_PILL_PATH_START__"
let loginShellPathEnd = "__WINTER_PILL_PATH_END__"
let loginShellAliasesStart = "__WINTER_PILL_ALIASES_START__"
let loginShellAliasesEnd = "__WINTER_PILL_ALIASES_END__"

/// The dialect a shell path speaks, as far as this file cares.
enum LoginShellDialect: Equatable {
    case zsh, bash, posix, fish
}

/// PURE: the shell to use. The user's account record first (`pw_shell` — a GUI app's environment is thin),
/// then `$SHELL`, then macOS's default. Anything that is not an absolute path to a known dialect falls back to
/// `/bin/zsh`, as the daemon's probe does.
func loginShellPath(accountShell: String?, environmentShell: String?) -> String {
    for candidate in [accountShell, environmentShell] {
        guard let candidate, candidate.hasPrefix("/"), loginShellDialect(candidate) != nil else { continue }
        return candidate
    }
    return "/bin/zsh"
}

/// PURE: the dialect of a shell path, or nil for one this file has no script for.
func loginShellDialect(_ shell: String) -> LoginShellDialect? {
    switch (shell as NSString).lastPathComponent {
    case "zsh": return .zsh
    case "bash": return .bash
    case "sh", "ksh", "dash": return .posix
    case "fish": return .fish
    default: return nil
    }
}

/// PURE: the rc-file prelude a POSIX dialect runs before anything else — the interactive rc sourced quietly
/// (PATH additions made there, nvm/pyenv/a `brew shellenv` line, count), stdin from /dev/null so it can never
/// read the terminal. Empty for dialects with no rc to source.
func loginShellRcPrelude(_ dialect: LoginShellDialect) -> String {
    switch dialect {
    case .zsh:
        return #"[ -f "${ZDOTDIR:-$HOME}/.zshrc" ] && . "${ZDOTDIR:-$HOME}/.zshrc" </dev/null >/dev/null 2>&1; "#
    case .bash:
        return #"shopt -s expand_aliases 2>/dev/null; [ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc" </dev/null >/dev/null 2>&1; "#
    case .posix, .fish:
        return ""
    }
}

/// PURE: the probe's arguments — print the PATH (and the alias names, where the dialect can list them)
/// between markers.
func loginShellProbeArguments(_ dialect: LoginShellDialect) -> [String] {
    let path = "printf '%s' '\(loginShellPathStart)'; printf '%s' \"$PATH\"; printf '%s' '\(loginShellPathEnd)'; "
    let aliases: String
    switch dialect {
    case .zsh: aliases = #"print -rl -- ${(k)aliases} 2>/dev/null; "#
    case .bash: aliases = "compgen -a 2>/dev/null; "
    case .posix, .fish: aliases = ""
    }
    if dialect == .fish {
        return ["-l", "-c", "printf '%s' '\(loginShellPathStart)'; printf '%s' (string join : $PATH); "
                + "printf '%s' '\(loginShellPathEnd)'; printf '%s' '\(loginShellAliasesStart)'; "
                + "printf '%s' '\(loginShellAliasesEnd)'"]
    }
    return ["-l", "-c", loginShellRcPrelude(dialect) + path
            + "printf '%s\\n' '\(loginShellAliasesStart)'; " + aliases + "printf '%s' '\(loginShellAliasesEnd)'"]
}

/// PURE: what the probe printed → the PATH directories and alias names, or nil when the PATH markers are
/// missing or the value is not a PATH.
func loginShellParseProbe(_ output: String) -> (path: [String], aliases: Set<String>)? {
    guard let pathValue = loginShellBetween(output, loginShellPathStart, loginShellPathEnd),
          !pathValue.isEmpty, !pathValue.contains(where: { $0 == "\n" || $0 == "\r" || $0 == "\0" }) else { return nil }
    var seen = Set<String>()
    let path = pathValue.split(separator: ":").map(String.init).filter { !$0.isEmpty && seen.insert($0).inserted }
    let aliasBlock = loginShellBetween(output, loginShellAliasesStart, loginShellAliasesEnd) ?? ""
    let aliases = Set(aliasBlock.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }
        .filter { !$0.isEmpty && !$0.contains(" ") })
    return (path, aliases)
}

private func loginShellBetween(_ text: String, _ start: String, _ end: String) -> String? {
    guard let a = text.range(of: start), let b = text.range(of: end, range: a.upperBound..<text.endIndex) else { return nil }
    return String(text[a.upperBound..<b.lowerBound])
}

/// The run's trampoline: SwiftTerm's `forkpty` + `execve` hands the child every descriptor the app holds that is
/// not close-on-exec, and it offers no pre-exec hook. So a run starts in `/bin/zsh -f`, which closes every
/// descriptor above 2 and then `exec`s the user's shell — nothing of the app's reaches the user's command.
let loginShellRunTrampoline = #"{ for __fd in /dev/fd/<3->(N:t); do exec {__fd}>&-; done } 2>/dev/null; exec "$@""#

// MARK: - A run is a terminal tab: an interactive login shell that runs the line first

/// A run's random tag (16 hex digits). Its OSC 133 marks carry `winter-<nonce>`, and only marks carrying it count —
/// a `133;D;0` printed by the command itself, or by a shell nested in it (ssh, tmux, nix-shell), is not the line's end.
func loginShellRunNonce() -> String {
    var generator = SystemRandomNumberGenerator()
    return String(format: "%016llx", generator.next() as UInt64)
}

/// The mark field that names a run.
func loginShellMarkTag(_ nonce: String) -> String { "winter-" + nonce }

/// `text` as ONE single-quoted POSIX shell word.
func loginShellSingleQuoted(_ text: String) -> String {
    "'" + text.replacingOccurrences(of: "'", with: #"'\''"#) + "'"
}

/// `text` as ONE single-quoted fish word.
func loginShellFishQuoted(_ text: String) -> String {
    "'" + text.replacingOccurrences(of: #"\"#, with: #"\\"#).replacingOccurrences(of: "'", with: #"\'"#) + "'"
}

/// How a run starts: the executable and arguments (through the fd-closing trampoline), the variables to add to
/// the run's environment (never the line), the files its private shim folder holds, and what to TYPE into the
/// terminal if the shim was skipped.
struct LoginShellSessionInvocation: Equatable {
    var executable: String
    var arguments: [String]
    var environment: [String: String]
    /// File name → contents, written into the shim folder (mode 0600) before the shell starts. `line` is the line.
    var files: [String: String]
    /// The fallback: sources the folder's run script, which runs the line from the `line` file (or from the shim's
    /// variable, if the shim read it) — unless it already started. Ends in Return; starts with a space (kept out
    /// of history where the shell is set to).
    var fallbackInput: String
}

/// The name of the file the line travels in.
let loginShellLineFile = "line"

/// PURE: a run as an INTERACTIVE LOGIN SHELL — the user's own shell with their own startup files, which runs the
/// typed line once and then stays at its prompt, like a terminal tab.
///
/// The line travels in a FILE — `line`, mode 0600, in the run's private 0700 `mkdtemp` folder — that the shell
/// reads and deletes as it starts; no environment variable or argument ever carries it. The marks it writes are
/// `133;C;winter-<nonce>` as the line starts and `133;D;<status>;winter-<nonce>` when it ends.
///
/// - **zsh**: a ZDOTDIR shim. `ZDOTDIR` points at the folder, whose `.zshenv`, `.zprofile`, `.zshrc` and `.zlogin`
///   each source the user's real file of that name (from the user's own `ZDOTDIR`, or `$HOME`) at top level —
///   never inside a function, so their `typeset`s stay global — and point `ZDOTDIR` back at the shim between
///   files. `.zshenv` reads and deletes `line`; the last file restores the user's `ZDOTDIR` (and a `HISTFILE`
///   macOS's `/etc/zshrc` aimed at the shim) and registers a one-shot `zle-line-init` hook: at the FIRST prompt
///   the line is put in the editing buffer and accepted as if typed — job control, Ctrl-C, history, the user's
///   prompt and hooks all as usual — with HISTORY EXPANSION OFF for that one line (`histchars` emptied, so `!` is
///   never expanded: it runs exactly what was validated) and back on as it starts. Chosen over writing the line into the pty, which
///   would have to guess when the prompt is ready.
/// - **bash**: `--rcfile <shim> -i`; the shim does a login shell's files, then sources the run script.
/// - **sh / ksh / dash**: `-l -i` with `ENV` naming the shim, which sources the run script.
/// - **fish**: `-l -i --init-command "source <run.fish>"`.
///
/// The RUN SCRIPT (`run`, POSIX; `run.fish`) runs the line with `eval` — never history-expanded — once: it does
/// nothing when the line already started. When the shim was skipped (a `ZDOTDIR` set in `/etc/zshenv`) or its
/// prompt hook never fired (a plugin that rebinds `zle-line-init`), the app types `fallbackInput`
/// (`CommandRun`), which sources it.
func loginShellSessionInvocation(shell: String, line: String, shimDirectory: String,
                                 nonce: String) -> LoginShellSessionInvocation {
    let dialect = loginShellDialect(shell) ?? .zsh
    let target = loginShellDialect(shell) == nil ? "/bin/zsh" : shell
    let tag = loginShellMarkTag(nonce)
    let run = shimDirectory + "/run"
    var environment: [String: String] = [:]
    var files: [String: String] = [loginShellLineFile: line, "run": loginShellRunScript(shimDirectory: shimDirectory, tag: tag)]
    let shellArguments: [String]
    var fallback = " . " + loginShellSingleQuoted(run) + "\r"
    switch dialect {
    case .zsh:
        environment["ZDOTDIR"] = shimDirectory
        files.merge(loginShellZshShimFiles(tag: tag)) { _, new in new }
        shellArguments = ["-l", "-i"]
    case .bash:
        files["bashrc"] = loginShellBashShim(shimDirectory: shimDirectory, tag: tag)
        shellArguments = ["--rcfile", shimDirectory + "/bashrc", "-i"]
    case .posix:
        environment["ENV"] = shimDirectory + "/env.sh"
        files["env.sh"] = "unset ENV\n. " + loginShellSingleQuoted(run) + "\n"
        shellArguments = ["-l", "-i"]
    case .fish:
        files["run.fish"] = loginShellFishRunScript(shimDirectory: shimDirectory, tag: tag)
        let source = "source " + loginShellFishQuoted(shimDirectory + "/run.fish")
        fallback = " " + source + "\r"
        shellArguments = ["-l", "-i", "--init-command", source]
    }
    return LoginShellSessionInvocation(
        executable: "/bin/zsh",
        arguments: ["-f", "-c", loginShellRunTrampoline, "winter-run", target] + shellArguments,
        environment: environment, files: files, fallbackInput: fallback)
}

/// The POSIX run script (zsh, bash, sh): the line once, between its marks. `__winter_state` — 0 not started,
/// 1 accepted at the prompt (zsh), 2 running, 3 done — keeps it from running twice.
func loginShellRunScript(shimDirectory: String, tag: String) -> String {
    let file = loginShellSingleQuoted(shimDirectory + "/" + loginShellLineFile)
    return """
    # Winter: runs the line you typed into the Dispatch pill, once.
    if [ "${__winter_state:-0}" = 0 ]; then
      __winter_state=2
      if [ -f \(file) ]; then
        __winter_line=$(command cat -- \(file))
        command rm -f -- \(file)
      fi
      command printf '\\033]133;C;\(tag)\\007'
      eval "$__winter_line"
      __winter_status=$?
      __winter_state=3
      command printf '\\033]133;D;%d;\(tag)\\007' "$__winter_status"
      unset __winter_line __winter_status
    fi

    """
}

/// fish's run script.
func loginShellFishRunScript(shimDirectory: String, tag: String) -> String {
    let file = loginShellFishQuoted(shimDirectory + "/" + loginShellLineFile)
    return """
    # Winter: runs the line you typed into the Dispatch pill, once.
    if not set -q __winter_state
      set -g __winter_state 2
      set -g __winter_line (command cat -- \(file) | string collect)
      command rm -f -- \(file)
      printf '\\e]133;C;\(tag)\\a'
      eval $__winter_line
      set -g __winter_status $status
      set -g __winter_state 3
      printf '\\e]133;D;%d;\(tag)\\a' $__winter_status
      set -e __winter_line __winter_status
    end

    """
}

/// The zsh shim's four startup files (see `loginShellSessionInvocation`).
func loginShellZshShimFiles(tag: String) -> [String: String] {
    // Between files ZDOTDIR is the shim's; while a user's file runs it is the user's own (unset = $HOME).
    func source(_ name: String) -> String {
        """
        if [[ -n $__winter_zd ]]; then ZDOTDIR=$__winter_zd; else builtin unset ZDOTDIR; fi
        [[ -f ${ZDOTDIR:-$HOME}/\(name) ]] && builtin source ${ZDOTDIR:-$HOME}/\(name)
        __winter_zd=${ZDOTDIR-}
        ZDOTDIR=$__winter_shim

        """
    }
    let header = "# Winter: a run's one-time startup shim — it sources your own startup files.\n"
    let zshenv = header + """
        __winter_shim=$ZDOTDIR
        __winter_state=0
        if [[ -f $__winter_shim/\(loginShellLineFile) ]]; then
          __winter_line=$(<$__winter_shim/\(loginShellLineFile))
          command rm -f -- $__winter_shim/\(loginShellLineFile)
        fi
        __winter_zd=

        """ + source(".zshenv")
    let zlogin = header + source(".zlogin") + """
        if [[ -n $__winter_zd ]]; then builtin export ZDOTDIR=$__winter_zd; else builtin unset ZDOTDIR; fi
        [[ ${HISTFILE-} == $__winter_shim/* ]] && HISTFILE=${ZDOTDIR:-$HOME}/${HISTFILE##*/}
        builtin unset __winter_zd
        __winter_histchars=
        __winter_run_line() {
          (( __winter_state == 0 )) || return 0
          __winter_state=1
          # The line runs exactly as validated: no history expansion for it (`!` stays `!`). Emptying histchars is
          # what the lexer reads; toggling BANG_HIST here would be too late for this line.
          __winter_histchars=$histchars
          histchars=''
          BUFFER=$__winter_line
          CURSOR=${#BUFFER}
          zle .accept-line
        }
        __winter_preexec() {
          (( __winter_state == 1 )) || return 0
          __winter_state=2
          histchars=$__winter_histchars
          builtin printf '\\033]133;C;\(tag)\\007'
        }
        __winter_precmd() {
          local __winter_status=$?
          (( __winter_state == 2 )) || return $__winter_status
          __winter_state=3
          builtin printf '\\033]133;D;%d;\(tag)\\007' $__winter_status
          builtin unset __winter_line
          return $__winter_status
        }
        builtin autoload -Uz add-zle-hook-widget add-zsh-hook
        zle -N __winter_run_line
        add-zle-hook-widget line-init __winter_run_line
        add-zsh-hook preexec __winter_preexec
        precmd_functions=(__winter_precmd ${precmd_functions[@]})

        """
    return [".zshenv": zshenv, ".zprofile": header + source(".zprofile"), ".zshrc": header + source(".zshrc"),
            ".zlogin": zlogin]
}

/// The bash shim (`--rcfile`): a login shell's files, then the run script, then the prompt.
func loginShellBashShim(shimDirectory: String, tag: String) -> String {
    """
    # Winter: a run's one-time startup shim — it sources your own startup files.
    [ -f /etc/profile ] && builtin source /etc/profile
    if [ -f "$HOME/.bash_profile" ]; then builtin source "$HOME/.bash_profile"
    elif [ -f "$HOME/.bash_login" ]; then builtin source "$HOME/.bash_login"
    elif [ -f "$HOME/.profile" ]; then builtin source "$HOME/.profile"
    fi
    # A line interrupted before its own end mark still reports, at the first prompt.
    __winter_done() {
      local __winter_last=$?
      if [ "${__winter_state:-0}" = 2 ]; then
        __winter_state=3
        builtin printf '\\033]133;D;%d;\(tag)\\007' "$__winter_last"
      fi
      return $__winter_last
    }
    PROMPT_COMMAND="__winter_done${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
    builtin source \(loginShellSingleQuoted(shimDirectory + "/run"))

    """
}

/// PURE: the environment a run (and the probe) starts from. A Mac app's own environment is LaunchServices'
/// (thin, and it carries Winter's own variables), so this passes only what a login shell expects to inherit —
/// the shell's profile builds the rest. `SSH_AUTH_SOCK` rides along so `ssh`/`git` reach the user's agent.
func loginShellEnvironment(from processEnvironment: [String: String], home: String, user: String,
                           shell: String) -> [String: String] {
    var env: [String: String] = [
        "HOME": home,
        "USER": user,
        "LOGNAME": user,
        "SHELL": shell,
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "TERM": "xterm-256color",
        "COLORTERM": "truecolor",
        "TERM_PROGRAM": "Winter",
        "LANG": processEnvironment["LANG"] ?? "en_US.UTF-8",
        // oh-my-zsh never stops a login shell for an update prompt.
        "DISABLE_AUTO_UPDATE": "true",
    ]
    for key in ["TMPDIR", "SSH_AUTH_SOCK", "LC_ALL", "LC_CTYPE", "__CF_USER_TEXT_ENCODING"] {
        if let value = processEnvironment[key] { env[key] = value }
    }
    return env
}

// MARK: - The environment the validator reads

/// What command mode knows about the user's shell, safe to read from any thread. `inert` (tests, and every
/// pill built under unit tests) answers that nothing is a command; `fixed` is a synthetic one; `live()` runs
/// the login-shell probe — lazily, on the first `snapshot()`, off the main thread, again every
/// `refreshInterval`.
final class CommandLineEnvironment: @unchecked Sendable {
    struct Snapshot {
        /// False for the inert environment: nothing validates, nothing completes.
        var enabled: Bool
        var pathDirectories: [String]
        var aliases: Set<String>
        /// Every name the first word can complete to: PATH executables, builtins, reserved words, aliases.
        var commandNames: [String]
        var homeDirectory: String
        var fileSystem: ShellFileSystem
        /// Whole-command validation on zsh's completion system (`ZshCompletion.swift`).
        var wholeCommandCheck: Bool = false
        /// Who answers it — nil while the engine is not ready (or unavailable): the prose guard decides then.
        var completion: ShellCompletionSource?

        func context(workingDirectory: String) -> ShellCommandContext {
            ShellCommandContext(pathDirectories: pathDirectories, aliases: aliases, homeDirectory: homeDirectory,
                                workingDirectory: workingDirectory, fileSystem: fileSystem)
        }
    }

    static let refreshInterval: TimeInterval = 10 * 60
    static let probeTimeout: TimeInterval = 5

    private let lock = NSLock()
    private var current: Snapshot
    private let isLive: Bool
    private var probedAt: Date?
    private var probing = false
    /// The shell a run uses (live only).
    let shell: String
    let homeDirectory: String
    let runEnvironment: [String: String]

    private init(snapshot: Snapshot, isLive: Bool, shell: String, runEnvironment: [String: String]) {
        current = snapshot
        self.isLive = isLive
        self.shell = shell
        self.homeDirectory = snapshot.homeDirectory
        self.runEnvironment = runEnvironment
    }

    /// Nothing is a command — the pill in tests, and before anything is wired.
    static var inert: CommandLineEnvironment {
        CommandLineEnvironment(snapshot: Snapshot(enabled: false, pathDirectories: [], aliases: [], commandNames: [],
                                                  homeDirectory: "/tmp", fileSystem: LiveShellFileSystem()),
                               isLive: false, shell: "/bin/zsh", runEnvironment: [:])
    }

    /// A synthetic shell (tests). With no `completion`, only the structural rules apply. A test that starts a
    /// real run hands in a `runEnvironment` whose HOME is a throwaway folder — never the user's.
    static func fixed(pathDirectories: [String], commandNames: [String], aliases: Set<String> = [],
                      homeDirectory: String, fileSystem: ShellFileSystem,
                      completion: ShellCompletionSource? = nil, shell: String = "/bin/zsh",
                      runEnvironment: [String: String] = [:]) -> CommandLineEnvironment {
        CommandLineEnvironment(snapshot: Snapshot(enabled: true, pathDirectories: pathDirectories, aliases: aliases,
                                                  commandNames: commandNames.sorted(), homeDirectory: homeDirectory,
                                                  fileSystem: fileSystem, wholeCommandCheck: completion != nil,
                                                  completion: completion),
                               isLive: false, shell: shell, runEnvironment: runEnvironment)
    }

    /// The user's own shell. Until the first probe lands, the process PATH plus the standard Homebrew
    /// directories stand in (never wrong for what they find; the probe only adds).
    static func live() -> CommandLineEnvironment {
        let home = NSHomeDirectory()
        let account = getpwuid(getuid())
        let accountShell = account.flatMap { $0.pointee.pw_shell.map { String(cString: $0) } }
        let user = account.flatMap { $0.pointee.pw_name.map { String(cString: $0) } } ?? NSUserName()
        let processEnvironment = ProcessInfo.processInfo.environment
        let shell = loginShellPath(accountShell: accountShell, environmentShell: processEnvironment["SHELL"])
        let inherited = (processEnvironment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(separator: ":").map(String.init)
        var seen = Set<String>()
        let path = (inherited + ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"])
            .filter { seen.insert($0).inserted }
        let snapshot = Snapshot(enabled: true, pathDirectories: path, aliases: [], commandNames: [],
                                homeDirectory: home, fileSystem: LiveShellFileSystem(), wholeCommandCheck: true)
        return CommandLineEnvironment(snapshot: snapshot, isLive: true, shell: shell,
                                      runEnvironment: loginShellEnvironment(from: processEnvironment, home: home,
                                                                            user: user, shell: shell))
    }

    /// False for the inert environment (nothing is ever a command) — checked without starting a probe.
    var isEnabled: Bool {
        lock.lock(); defer { lock.unlock() }
        return current.enabled
    }

    /// The current view. On a live environment this also starts a probe when none has run, or the last is
    /// older than `refreshInterval` — in the background; the caller gets what is known now.
    func snapshot() -> Snapshot {
        lock.lock()
        let snapshot = current
        let due = isLive && !probing && (probedAt.map { Date().timeIntervalSince($0) > Self.refreshInterval } ?? true)
        if due { probing = true }
        lock.unlock()
        if due {
            DispatchQueue.global(qos: .utility).async { [weak self] in self?.probe() }
        }
        return snapshot
    }

    private func probe() {
        // `loginShellPath` only ever picks a shell of a known dialect.
        let result = runLoginShellProbe(shell: shell, arguments: loginShellProbeArguments(loginShellDialect(shell) ?? .zsh),
                                        environment: runEnvironment, timeout: Self.probeTimeout)
        let parsed = result.flatMap(loginShellParseProbe)
        var names: [String] = []
        if let parsed {
            names = commandNamesOnPath(parsed.path)
        }
        // The completion engine starts once the PATH its completion functions run tools from is known.
        var engineEnvironment = runEnvironment
        engineEnvironment["PATH"] = (parsed?.path ?? current.pathDirectories).joined(separator: ":")
        engineEnvironment["GIT_OPTIONAL_LOCKS"] = "0" // completing never takes a repository's index lock
        let engine = ZshCompletionEngine(environment: engineEnvironment)
        engine.warmUp()
        lock.lock()
        current.completion = engine
        if let parsed {
            current.pathDirectories = parsed.path
            current.aliases = parsed.aliases
            current.commandNames = Array(Set(names).union(shellBuiltins).union(shellReservedWords).union(parsed.aliases)).sorted()
        } else if current.commandNames.isEmpty {
            // The probe failed: complete from what the stand-in PATH holds, and try again next refresh.
            current.commandNames = Array(Set(commandNamesOnPath(current.pathDirectories)).union(shellBuiltins)).sorted()
        }
        probedAt = Date()
        probing = false
        lock.unlock()
        // The outcome only — never a PATH value or anything the shell printed.
        NSLog("[DispatchPill] login shell probe: %@", parsed == nil ? "failed (stand-in PATH kept)" : "ok (\(parsed!.path.count) PATH entries)")
    }

    /// The names in every PATH directory (not stat'ed one by one — the validator stats the one it needs).
    private func commandNamesOnPath(_ directories: [String]) -> [String] {
        var names = Set<String>()
        for directory in directories {
            for name in (try? FileManager.default.contentsOfDirectory(atPath: directory)) ?? [] where !name.hasPrefix(".") {
                names.insert(name)
            }
        }
        return Array(names)
    }
}

/// Runs the probe: its own process group, stdin /dev/null, stderr discarded, stdout read until the alias end
/// marker, EOF or the deadline — and at the deadline the whole group is SIGKILLed, whatever the profile left
/// running. Blocking; call off the main thread.
private func runLoginShellProbe(shell: String, arguments: [String], environment: [String: String],
                                timeout: TimeInterval) -> String? {
    var pipe: [Int32] = [0, 0]
    guard Darwin.pipe(&pipe) == 0 else { return nil }
    let readEnd = pipe[0], writeEnd = pipe[1]
    shellSetCloseOnExec(readEnd)
    shellSetCloseOnExec(writeEnd)

    var actions: posix_spawn_file_actions_t?
    posix_spawn_file_actions_init(&actions)
    defer { posix_spawn_file_actions_destroy(&actions) }
    posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
    posix_spawn_file_actions_adddup2(&actions, writeEnd, 1)
    posix_spawn_file_actions_addopen(&actions, 2, "/dev/null", O_WRONLY, 0)
    posix_spawn_file_actions_addclose(&actions, readEnd)
    posix_spawn_file_actions_addclose(&actions, writeEnd)

    var attributes: posix_spawnattr_t?
    posix_spawnattr_init(&attributes)
    defer { posix_spawnattr_destroy(&attributes) }
    posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT))
    posix_spawnattr_setpgroup(&attributes, 0)

    let argv = [shell] + arguments
    let envp = environment.map { "\($0.key)=\($0.value)" }
    var pid: pid_t = 0
    let spawned = withCStrings(argv) { cArgv in
        withCStrings(envp) { cEnv in posix_spawn(&pid, shell, &actions, &attributes, cArgv, cEnv) }
    }
    close(writeEnd)
    guard spawned == 0 else {
        close(readEnd)
        return nil
    }

    let deadline = Date().addingTimeInterval(timeout)
    var output = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    let endMarker = Data(loginShellAliasesEnd.utf8)
    var pollDescriptor = pollfd(fd: readEnd, events: Int16(POLLIN), revents: 0)
    while output.count < 1_048_576 {
        let remaining = deadline.timeIntervalSinceNow
        guard remaining > 0 else { break }
        let ready = poll(&pollDescriptor, 1, Int32(min(remaining, 1) * 1000))
        if ready < 0, errno == EINTR { continue }
        if ready <= 0 { continue }
        let count = read(readEnd, &buffer, buffer.count)
        if count <= 0 { break }
        output.append(buffer, count: count)
        if output.range(of: endMarker) != nil { break }
    }
    close(readEnd)
    // Reap the shell, and at the deadline take down whatever its group still runs.
    let group = pid
    DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + max(0, deadline.timeIntervalSinceNow)) {
        kill(-group, SIGKILL)
    }
    DispatchQueue.global(qos: .utility).async {
        var status: Int32 = 0
        waitpid(group, &status, 0)
    }
    return String(decoding: output, as: UTF8.self)
}

/// Hands `strings` to `body` as a NULL-terminated C string array.
private func withCStrings<R>(_ strings: [String], _ body: ([UnsafeMutablePointer<CChar>?]) -> R) -> R {
    var pointers: [UnsafeMutablePointer<CChar>?] = strings.map { strdup($0) }
    pointers.append(nil)
    defer { pointers.forEach { free($0) } }
    return body(pointers)
}
