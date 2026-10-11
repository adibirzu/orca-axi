import { describe, expect, it, vi } from "vitest";

import {
  classifyIdentity,
  resolveOrca,
  type PathProbe,
  type ResolveDeps,
} from "../src/orca-resolve.js";

const HOME = "/home/testuser";
const SHIM = `${HOME}/.local/bin/orca`;
const BUNDLE = "/Applications/Orca.app/Contents/Resources/bin/orca";

function files(
  entries: Record<string, "file" | { symlinkTo: string; targetExists: boolean }>,
): (path: string) => PathProbe {
  return (path: string) => {
    const entry = entries[path];
    if (entry === undefined) {
      return { missing: true, isSymlink: false, linkTarget: null, targetExists: false };
    }
    if (entry === "file") {
      return { missing: false, isSymlink: false, linkTarget: null, targetExists: true };
    }
    return {
      missing: false,
      isSymlink: true,
      linkTarget: entry.symlinkTo,
      targetExists: entry.targetExists,
    };
  };
}

function versions(outputs: Record<string, string>): ResolveDeps["probeVersion"] {
  return (executable: string) => {
    const output = outputs[executable];
    return output === undefined ? { ok: false, output: "" } : { ok: true, output };
  };
}

function base(overrides: ResolveDeps = {}): ResolveDeps {
  return {
    platform: "darwin",
    env: {},
    home: HOME,
    probePath: files({}),
    probeVersion: versions({}),
    searchPath: () => null,
    ...overrides,
  };
}

describe("classifyIdentity", () => {
  it("recognises the 1.x runtime", () => {
    expect(classifyIdentity("1.4.219")).toBe("orca-runtime");
    expect(classifyIdentity("orca version 1.4.219\n")).toBe("orca-runtime");
  });

  it("recognises the GNOME screen reader by desktop version", () => {
    expect(classifyIdentity("46.1")).toBe("screen-reader");
  });

  it("recognises the GNOME screen reader by name", () => {
    expect(classifyIdentity("orca - screen reader\n46.1")).toBe("screen-reader");
  });

  it("reports unknown when the probe says nothing useful", () => {
    expect(classifyIdentity("")).toBe("unknown");
    expect(classifyIdentity("garbage")).toBe("unknown");
  });
});

describe("broken symlink at the expected binary path", () => {
  it("reports the dangling shim and keeps resolving instead of crashing", () => {
    const probeVersion = vi.fn(versions({}));
    const resolution = resolveOrca(
      base({
        probePath: files({
          [SHIM]: { symlinkTo: "/opt/orca-1.4.219/bin/orca", targetExists: false },
        }),
        probeVersion,
        searchPath: () => null,
      }),
    );
    expect(resolution.brokenSymlinks).toEqual([
      { path: SHIM, target: "/opt/orca-1.4.219/bin/orca" },
    ]);
    // Nothing else exists, so the outcome is "not found" — never a crash,
    // and the dead link was never executed.
    expect(resolution.status).toBe("error");
    expect(resolution.reason).toContain("No Orca");
    expect(probeVersion).not.toHaveBeenCalled();
  });

  it("skips the dangling shim when a later candidate is healthy", () => {
    const resolution = resolveOrca(
      base({
        probePath: files({
          [SHIM]: { symlinkTo: "/opt/orca-1.4.219/bin/orca", targetExists: false },
          [BUNDLE]: "file",
        }),
        probeVersion: versions({ [BUNDLE]: "1.4.219" }),
      }),
    );
    expect(resolution.status).toBe("ok");
    expect(resolution.binary?.path).toBe(BUNDLE);
    expect(resolution.brokenSymlinks).toEqual([
      { path: SHIM, target: "/opt/orca-1.4.219/bin/orca" },
    ]);
  });
});

describe("binary inside an app bundle path", () => {
  it("resolves the Resources/bin layout and marks it as a bundle", () => {
    const resolution = resolveOrca(
      base({
        probePath: files({ [BUNDLE]: "file" }),
        probeVersion: versions({ [BUNDLE]: "1.4.219" }),
      }),
    );
    expect(resolution.status).toBe("ok");
    expect(resolution.binary).toMatchObject({
      path: BUNDLE,
      source: "bundle",
      bundle: true,
      identity: "orca-runtime",
      version: "1.4.219",
    });
  });
});

describe("ORCA_CLI_COMMAND override", () => {
  it("treats the whole override as one path, spaces included", () => {
    const path = "/Users/John Smith/Applications/Orca.app/Contents/MacOS/orca";
    const probeVersion = vi.fn(versions({ [path]: "1.4.219" }));
    const resolution = resolveOrca(base({ env: { ORCA_CLI_COMMAND: path }, probeVersion }));
    expect(resolution.status).toBe("ok");
    expect(resolution.binary).toMatchObject({ path, bundle: true });
    expect(probeVersion).toHaveBeenCalledWith(path);
  });

  it("wins over every candidate including a broken shim", () => {
    const probeVersion = vi.fn(versions({ "/opt/custom/orca": "1.4.219" }));
    const resolution = resolveOrca(
      base({
        env: { ORCA_CLI_COMMAND: "/opt/custom/orca" },
        probePath: files({
          [SHIM]: { symlinkTo: "/nowhere/orca", targetExists: false },
        }),
        probeVersion,
      }),
    );
    expect(resolution.status).toBe("ok");
    expect(resolution.binary).toMatchObject({
      path: "/opt/custom/orca",
      source: "env:ORCA_CLI_COMMAND",
      identity: "orca-runtime",
    });
    expect(probeVersion).toHaveBeenCalledTimes(1);
    expect(probeVersion).toHaveBeenCalledWith("/opt/custom/orca");
  });

  it("refuses when the override itself points at the screen reader", () => {
    const resolution = resolveOrca(
      base({
        platform: "linux",
        env: { ORCA_CLI_COMMAND: "/usr/bin/orca" },
        probeVersion: versions({ "/usr/bin/orca": "46.1" }),
      }),
    );
    expect(resolution.status).toBe("refused");
    expect(resolution.reason).toContain("ORCA_CLI_COMMAND");
    expect(resolution.reason).toContain("screen reader");
  });

  it("errors when the override target fails its version probe", () => {
    const resolution = resolveOrca(
      base({
        env: { ORCA_CLI_COMMAND: "/opt/custom/orca" },
        probeVersion: versions({}),
      }),
    );
    expect(resolution.status).toBe("error");
    expect(resolution.reason).toContain("ORCA_CLI_COMMAND");
  });
});

describe("Linux screen-reader guard", () => {
  function linuxScreenReader(): ResolveDeps {
    return base({
      platform: "linux",
      probeVersion: versions({ "/usr/bin/orca": "46.1" }),
      searchPath: () => "/usr/bin/orca",
    });
  }

  it("refuses the GNOME screen reader found on PATH", () => {
    const probeVersion = vi.fn(versions({ "/usr/bin/orca": "46.1" }));
    const resolution = resolveOrca(
      base({
        platform: "linux",
        probeVersion,
        searchPath: () => "/usr/bin/orca",
      }),
    );
    expect(resolution.status).toBe("refused");
    expect(resolution.binary).toMatchObject({
      path: "/usr/bin/orca",
      identity: "screen-reader",
      version: "46.1",
    });
    expect(resolution.reason).toContain("screen reader");
    // Identified by the --version probe alone: nothing else was invoked.
    expect(probeVersion).toHaveBeenCalledTimes(1);
    expect(probeVersion).toHaveBeenCalledWith("/usr/bin/orca");
  });

  it("refuses on a strong accessibility session when identity is unknown", () => {
    const resolution = resolveOrca(
      base({
        platform: "linux",
        env: { ACCESSIBILITY_ENABLED: "1" },
        probeVersion: versions({ "/usr/bin/orca": "screen control panel" }),
        searchPath: () => "/usr/bin/orca",
      }),
    );
    expect(classifyIdentity("screen control panel")).toBe("unknown");
    expect(resolution.status).toBe("refused");
    expect(resolution.sessionActive).toBe(true);
  });

  it("still resolves a positively identified runtime under a session hint", () => {
    const resolution = resolveOrca(
      base({
        platform: "linux",
        env: { AT_SPI_BUS_ADDRESS: "unix:path=/run/bus" },
        probePath: files({ "/usr/local/bin/orca": "file" }),
        probeVersion: versions({ "/usr/local/bin/orca": "1.4.219" }),
      }),
    );
    expect(resolution.status).toBe("ok");
    expect(resolution.binary?.identity).toBe("orca-runtime");
  });

  it("does not mistake the runtime for the reader on macOS", () => {
    expect(linuxScreenReader().platform).toBe("linux");
    const mac = resolveOrca(
      base({
        probePath: files({ [SHIM]: "file" }),
        probeVersion: versions({ [SHIM]: "1.4.219" }),
      }),
    );
    expect(mac.status).toBe("ok");
  });
});

describe("nothing found", () => {
  it("errors with install guidance", () => {
    const resolution = resolveOrca(base());
    expect(resolution.status).toBe("error");
    expect(resolution.reason).toContain("No Orca");
    expect(resolution.suggestions.join("\n")).toContain("ORCA_CLI_COMMAND");
  });
});
