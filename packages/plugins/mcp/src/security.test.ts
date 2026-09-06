import { describe, expect, it } from "vitest";
import { McpConfigError, validateStdioServerConfig } from "./security.js";

describe("validateStdioServerConfig", () => {
  it("rejects a command not on the allowlist", () => {
    expect(() => validateStdioServerConfig({ command: "rm" }, "node,npx")).toThrow(McpConfigError);
  });

  it("rejects when no allowlist is configured at all (secure default)", () => {
    expect(() => validateStdioServerConfig({ command: "node" }, undefined)).toThrow(McpConfigError);
  });

  it("accepts an allowed command with no dangerous args", () => {
    expect(() => validateStdioServerConfig({ command: "node", args: ["server.js"] }, "node")).not.toThrow();
  });

  it("rejects a cwd override", () => {
    expect(() => validateStdioServerConfig({ command: "node", cwd: "/tmp" }, "node")).toThrow(/cwd/);
  });

  it("rejects shell metacharacters in an argument", () => {
    expect(() => validateStdioServerConfig({ command: "node", args: ["a; rm -rf /"] }, "node")).toThrow(McpConfigError);
  });

  it("rejects a code-execution flag for a known command", () => {
    expect(() => validateStdioServerConfig({ command: "node", args: ["-e", "process.exit(1)"] }, "node")).toThrow(
      McpConfigError,
    );
    expect(() => validateStdioServerConfig({ command: "npx", args: ["-y", "some-package"] }, "npx")).toThrow(
      McpConfigError,
    );
  });

  it("rejects a combined short flag hiding a dangerous one", () => {
    expect(() => validateStdioServerConfig({ command: "npx", args: ["-cy"] }, "npx")).toThrow(McpConfigError);
  });

  it("does not flag dangerous flags for a command with no known flag table", () => {
    expect(() => validateStdioServerConfig({ command: "node", args: ["--some-custom-flag"] }, "node")).not.toThrow();
  });

  it("rejects a null byte in an env value", () => {
    expect(() => validateStdioServerConfig({ command: "node", env: { KEY: "a\0b" } }, "node")).toThrow(McpConfigError);
  });
});
