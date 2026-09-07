import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { format } from "@flowlathe/dsl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cmdFmt } from "./fmt.js";

const MANGLED = 'flow "f" {\n     node a: prompt @(0, 0) {\n    template="hi"\nproviderId="mock"\nmodelId="m"\n}\n}\n';
const CANONICAL = format(MANGLED);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "flowlathe-cli-fmt-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("cmdFmt", () => {
  it("rewrites a non-canonical file in place and exits 0", async () => {
    const file = join(dir, "a.flow");
    await writeFile(file, MANGLED);
    const code = await cmdFmt([file]);
    expect(code).toBe(0);
    expect(await readFile(file, "utf8")).toBe(CANONICAL);
  });

  it("leaves an already-canonical file untouched", async () => {
    const file = join(dir, "a.flow");
    await writeFile(file, CANONICAL);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await cmdFmt([file]);
    expect(code).toBe(0);
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("--check reports drift without writing, and exits 1", async () => {
    const file = join(dir, "a.flow");
    await writeFile(file, MANGLED);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await cmdFmt(["--check", file]);
    expect(code).toBe(1);
    expect(await readFile(file, "utf8")).toBe(MANGLED);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("not formatted"));
    errSpy.mockRestore();
  });

  it("--check exits 0 for an already-canonical file", async () => {
    const file = join(dir, "a.flow");
    await writeFile(file, CANONICAL);
    const code = await cmdFmt(["--check", file]);
    expect(code).toBe(0);
  });

  it("reports a parse error without crashing the whole run", async () => {
    const file = join(dir, "bad.flow");
    await writeFile(file, "flow ??? {");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await cmdFmt([file]);
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
