import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runArgv } from "./exec.js";

const baseEnv = { PATH: process.env["PATH"] ?? "/usr/bin:/bin" };

describe("runArgv", () => {
  it("resolves with a non-zero exit code without throwing", async () => {
    const result = await runArgv("false", [], { env: baseEnv, timeoutMs: 5000, maxBuffer: 65536 });
    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it("captures stdout/stderr and passes only the given environment to the child", async () => {
    const result = await runArgv("sh", ["-c", "printenv FOO; echo err >&2"], {
      env: { ...baseEnv, FOO: "bar" },
      timeoutMs: 5000,
      maxBuffer: 65536,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("bar");
    expect(result.stderr.trim()).toBe("err");
  });

  it("times out a long-running command and kills it", async () => {
    const start = Date.now();
    const result = await runArgv("sleep", ["30"], { env: baseEnv, timeoutMs: 200, maxBuffer: 65536 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(Date.now() - start).toBeLessThan(3000);
  }, 10000);

  it("kills a backgrounded descendant process, not just the direct child", async () => {
    const marker = join(tmpdir(), `flowlathe-exec-desc-${randomBytes(4).toString("hex")}.pid`);
    // sh backgrounds a long sleep (which stays in the same process group — no setsid), records
    // its pid, then itself sleeps so the direct child is still alive when the timeout fires.
    const script = `sleep 30 & echo $! > ${marker}; sleep 30`;
    const result = await runArgv("sh", ["-c", script], { env: baseEnv, timeoutMs: 300, maxBuffer: 65536 });
    expect(result.timedOut).toBe(true);

    const grandchildPid = Number(readFileSync(marker, "utf-8").trim());
    // give the OS a moment to finish reaping the killed group
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(grandchildPid, 0)).toThrow();
  }, 10000);

  it("truncates when maxBuffer is exceeded, without throwing", async () => {
    const result = await runArgv("sh", ["-c", "yes x | head -c 200000"], { env: baseEnv, timeoutMs: 5000, maxBuffer: 1000 });
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(1000);
  }, 10000);

  it("kills the child promptly when the AbortSignal fires mid-run", async () => {
    const controller = new AbortController();
    const promise = runArgv("sleep", ["30"], { env: baseEnv, timeoutMs: 60000, maxBuffer: 65536, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const start = Date.now();
    const result = await promise;
    expect(Date.now() - start).toBeLessThan(3000);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);
  }, 10000);

  it("rejects when the executable cannot be found", async () => {
    await expect(runArgv("flowlathe-definitely-not-a-real-binary", [], { env: baseEnv, timeoutMs: 5000, maxBuffer: 1024 })).rejects.toThrow();
  });
});
