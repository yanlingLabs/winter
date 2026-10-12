import { GitPublicationError, type GitCommand, type GitExecutor } from "../../../src/cowork/git/types";

/** Test-owned effects must settle before their disposable directories are removed.
 * Observing rejection here does not change the promise/error returned to a test. */
export class GitFixtureLifetime {
  private readonly controller = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private closed = false;
  get signal(): AbortSignal { return this.controller.signal; }
  track<T>(start: () => Promise<T>): Promise<T> {
    const task = Promise.resolve().then(() => {
      if (this.closed) throw new GitPublicationError("cancelled");
      return start();
    });
    this.pending.add(task);
    // Use both handlers: an ignored finally() would create another rejected promise.
    void task.then(() => this.pending.delete(task), () => this.pending.delete(task));
    return task;
  }
  executor(executor: GitExecutor): GitExecutor {
    return { run: (command: GitCommand) => this.track(() => executor.run({ ...command,
      signal: command.signal ? AbortSignal.any([this.signal, command.signal]) : this.signal,
    })) };
  }
  async close(): Promise<void> {
    this.closed = true;
    this.controller.abort();
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}
