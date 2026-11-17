import { describe, expect, it } from "vitest";

import { doctorCommand } from "../src/commands/doctor.js";
import type { OrcaResolution } from "../src/orca-resolve.js";

function ok(): OrcaResolution {
  return {
    status: "ok",
    platform: "darwin",
    binary: {
      path: "/Users/test/.local/bin/orca",
      source: "shim",
      bundle: false,
      identity: "orca-runtime",
      version: "1.4.219",
    },
    brokenSymlinks: [],
    missingCandidates: [],
    sessionSignals: [],
    sessionActive: false,
    suggestions: [],
  };
}

function refused(): OrcaResolution {
  return {
    status: "refused",
    platform: "linux",
    binary: {
      path: "/usr/bin/orca",
      source: "path",
      bundle: false,
      identity: "screen-reader",
      version: "46.1",
    },
    brokenSymlinks: [],
    missingCandidates: [],
    sessionSignals: [],
    sessionActive: false,
    reason:
      "Resolved /usr/bin/orca (46.1) is the GNOME screen reader, not the Orca terminal/session runtime.",
    suggestions: ["Install the Orca 1.x runtime"],
  };
}

describe("doctor", () => {
  it("prints the contract on --help", async () => {
    const output = await doctorCommand(["--help"]);
    expect(output).toContain("usage: orca-axi doctor");
    expect(output).toContain("--json");
    expect(output).toContain("--full");
  });

  it("reports an ok binary as TOON with help lines", async () => {
    const output = await doctorCommand([], { resolve: ok });
    expect(output).toContain("status: ok");
    expect(output).toContain("1.4.219");
    expect(output).toContain("help[2]:");
  });

  it("reports a refusal with the reason and suggestions, not a crash", async () => {
    const output = await doctorCommand([], { resolve: refused });
    expect(output).toContain("status: refused");
    expect(output).toContain("screen reader");
    expect(output).toContain("help[");
  });

  it("emits the same report as JSON with --json", async () => {
    const output = await doctorCommand(["--json"], { resolve: refused });
    const parsed = JSON.parse(output) as { doctor: { status: string; reason: string } };
    expect(parsed.doctor.status).toBe("refused");
    expect(parsed.doctor.reason).toContain("screen reader");
  });

  it("hides candidate detail by default and shows it with --full", async () => {
    const resolution: OrcaResolution = {
      ...ok(),
      brokenSymlinks: [{ path: "/home/u/.local/bin/orca", target: "/nowhere" }],
      sessionSignals: ["AT_SPI_BUS_ADDRESS is set"],
    };
    const minimal = await doctorCommand([], { resolve: () => resolution });
    expect(minimal).not.toContain("brokenSymlinks");
    const full = await doctorCommand(["--full"], { resolve: () => resolution });
    expect(full).toContain("brokenSymlinks");
    expect(full).toContain("/nowhere");
    expect(full).toContain("AT_SPI_BUS_ADDRESS");
  });

  it("exits 2 on an unknown flag and names the valid flags", async () => {
    await expect(doctorCommand(["--bogus"])).rejects.toThrow("unknown flag --bogus");
  });
});
