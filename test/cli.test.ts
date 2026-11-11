import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../src/cli.js";

let dir: string;
let savedExitCode: number | undefined;
const savedEnv: Record<string, string | undefined> = {};

const PROXIED_ENV = ["ORCA_CLI_COMMAND", "ORCA_AXI_PLATFORM", "ORCA_AXI_HOME", "PATH"];

async function run(argv: string[]): Promise<{ output: string; exitCode: number }> {
  process.exitCode = 0;
  let output = "";
  await main({
    argv,
    stdout: {
      write: (chunk: string) => {
        output += chunk;
        return true;
      },
    },
  });
  return { output, exitCode: process.exitCode ?? 0 };
}

/** A fake `orca` executable that answers `--version` with the given text. */
function fakeOrca(version: string): string {
  const path = join(dir, `orca-${version.replace(/[^0-9a-z]/gi, "_")}`);
  writeFileSync(path, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; fi\n`);
  chmodSync(path, 0o755);
  return path;
}

beforeEach(() => {
  savedExitCode = process.exitCode;
  process.exitCode = 0;
  for (const name of PROXIED_ENV) savedEnv[name] = process.env[name];
  dir = mkdtempSync(join(tmpdir(), "orca-axi-test-"));
  delete process.env.ORCA_CLI_COMMAND;
  delete process.env.ORCA_AXI_PLATFORM;
  delete process.env.ORCA_AXI_HOME;
});

afterEach(() => {
  process.exitCode = savedExitCode ?? 0;
  for (const name of PROXIED_ENV) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("top-level surface", () => {
  it("prints the version", async () => {
    const { output, exitCode } = await run(["--version"]);
    expect(exitCode).toBe(0);
    expect(output.trim()).toBe("0.1.0");
  });

  it("prints top-level help", async () => {
    const { output, exitCode } = await run(["--help"]);
    expect(exitCode).toBe(0);
    expect(output).toContain("orca-axi");
    expect(output).toContain("doctor");
  });

  it("exits 2 on an unknown command", async () => {
    const { output, exitCode } = await run(["frobnicate"]);
    expect(exitCode).toBe(2);
    expect(output).toContain("Unknown command");
  });

  it("answers update --help offline via the SDK built-in", async () => {
    const { output, exitCode } = await run(["update", "--help"]);
    expect(exitCode).toBe(0);
    expect(output).toContain("update");
  });
});

describe("fleet view", () => {
  it("shows the resolved runtime on the no-arg dashboard", async () => {
    process.env.ORCA_CLI_COMMAND = fakeOrca("1.4.219");
    const { output, exitCode } = await run([]);
    expect(exitCode).toBe(0);
    expect(output).toContain("status: ok");
    expect(output).toContain("1.4.219");
    expect(output).toContain("help[");
  });

  it("accepts a leading --json onto the fleet view", async () => {
    process.env.ORCA_CLI_COMMAND = fakeOrca("1.4.219");
    const { output, exitCode } = await run(["--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output) as { fleet: { status: string } };
    expect(parsed.fleet.status).toBe("ok");
  });

  it("reports the screen-reader guard on the dashboard instead of invoking it", async () => {
    process.env.ORCA_CLI_COMMAND = fakeOrca("46.1");
    process.env.ORCA_AXI_PLATFORM = "linux";
    const { output, exitCode } = await run([]);
    expect(exitCode).toBe(0);
    expect(output).toContain("status: refused");
    expect(output).toContain("screen reader");
  });
});

describe("doctor end to end", () => {
  it("runs green against a runtime binary via the override", async () => {
    process.env.ORCA_CLI_COMMAND = fakeOrca("1.4.219");
    const { output, exitCode } = await run(["doctor"]);
    expect(exitCode).toBe(0);
    expect(output).toContain("status: ok");
  });

  it("reports the guard as a structured refusal with exit 0", async () => {
    process.env.ORCA_CLI_COMMAND = fakeOrca("46.1");
    process.env.ORCA_AXI_PLATFORM = "linux";
    const { output, exitCode } = await run(["doctor"]);
    expect(exitCode).toBe(0);
    expect(output).toContain("status: refused");
  });

  it("prints per-subcommand help", async () => {
    const { output, exitCode } = await run(["doctor", "--help"]);
    expect(exitCode).toBe(0);
    expect(output).toContain("ORCA_CLI_COMMAND");
  });

  it("exits 2 on an unknown doctor flag", async () => {
    const { output, exitCode } = await run(["doctor", "--bogus"]);
    expect(exitCode).toBe(2);
    expect(output).toContain("unknown flag --bogus");
  });
});
