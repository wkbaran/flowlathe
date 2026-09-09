import { spawn } from "node:child_process";

/**
 * A bounded, cancellable, descendant-killing subprocess runner (PLAN-GIT.md §4.2). There is no
 * existing exemplar in this repo to copy — `packages/server/src/git-history.ts` is a bare
 * `execFileSync` with no timeout and no bounds. This is the runner `PLAN-SHELL-TOOL.md` §4.3
 * would otherwise have authored; that plan is deferred and will *inherit* this one rather than
 * writing its own (`documentation/handoff/C5-git-shared-plumbing.md`).
 *
 * Uses `child_process.spawn`, not `execFile`, deliberately: `spawn`'s `detached: true` starts the
 * child as the leader of its own process group, which is what makes `process.kill(-pid)` reach a
 * command's descendants (`ssh` for a push, a credential helper, a pager, a hook) rather than only
 * the direct child — `execFile` does not forward `detached` to the underlying spawn call. Neither
 * function ever invokes a shell; `shell` is simply never set (Node's default is already `false`).
 */

export interface ExecOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

export interface RunArgvOptions {
  env: Record<string, string>;
  timeoutMs: number;
  maxBuffer: number;
  signal?: AbortSignal | undefined;
}

/**
 * Runs `file` with literal argv `args` — never a shell, never a string command line. Resolves
 * once the child has actually exited, never earlier (a timeout/abort only requests a kill; the
 * promise still waits for the resulting `exit` event) — a plugin author racing the callback
 * against a timer here is exactly the bug class this function exists to close off.
 */
export function runArgv(file: string, args: readonly string[], opts: RunArgvOptions): Promise<ExecOutcome> {
  return new Promise((resolvePromise, rejectPromise) => {
    const start = Date.now();
    const child = spawn(file, args, {
      env: opts.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const killGroup = (): void => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        process.kill(-pid, "SIGKILL");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ESRCH") {
          try {
            child.kill("SIGKILL");
          } catch {
            // already gone — nothing left to kill
          }
        }
      }
    };

    const clearTimer = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, opts.timeoutMs);

    const onAbort = (): void => {
      killGroup();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const cleanupListeners = (): void => {
      clearTimer();
      opts.signal?.removeEventListener("abort", onAbort);
    };

    const consume = (chunk: Buffer, current: number): { text: string; bytes: number; overflowed: boolean } => {
      if (current >= opts.maxBuffer) {
        return { text: "", bytes: current, overflowed: true };
      }
      const remaining = opts.maxBuffer - current;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      const overflowed = slice.length < chunk.length;
      return { text: slice.toString("utf-8"), bytes: current + slice.length, overflowed };
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      const { text, bytes, overflowed } = consume(chunk, stdoutBytes);
      stdout += text;
      stdoutBytes = bytes;
      if (overflowed) {
        truncated = true;
        killGroup();
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const { text, bytes, overflowed } = consume(chunk, stderrBytes);
      stderr += text;
      stderrBytes = bytes;
      if (overflowed) {
        truncated = true;
        killGroup();
      }
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      rejectPromise(err);
    });

    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      resolvePromise({
        exitCode: code,
        signal,
        stdout,
        stderr,
        truncated,
        timedOut,
        durationMs: Date.now() - start,
      });
    });
  });
}
