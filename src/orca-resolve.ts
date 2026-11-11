/**
 * Orca binary resolution.
 *
 * `orca` is two unrelated programs sharing one name: the Orca
 * terminal/session runtime (this tool's subject, currently 1.x) and the
 * GNOME screen reader that ships as `/usr/bin/orca` on most Linux desktops
 * (currently 4x.x). Resolution must never mis-invoke the screen reader as
 * the runtime, so every candidate is identified by a `--version` probe
 * before it is accepted, and a Linux accessibility session without an
 * explicit `ORCA_CLI_COMMAND` override refuses with a structured report.
 *
 * All host access goes through {@link ResolveDeps} so tests can exercise
 * every case without touching the real filesystem, PATH, or processes.
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const ORCA_CLI_COMMAND_ENV = "ORCA_CLI_COMMAND";
/** Test/diagnostic hook: pretend to run on another platform. */
export const ORCA_AXI_PLATFORM_ENV = "ORCA_AXI_PLATFORM";
/** Test/diagnostic hook: pretend HOME is elsewhere. */
export const ORCA_AXI_HOME_ENV = "ORCA_AXI_HOME";

export type BinaryIdentity = "orca-runtime" | "screen-reader" | "unknown";

export type CandidateSource =
  | "env:ORCA_CLI_COMMAND"
  | "shim"
  | "bundle"
  | "system"
  | "path";

export interface PathProbe {
  /** Nothing at this path, not even a dangling link. */
  missing: boolean;
  isSymlink: boolean;
  /** readlink target when `isSymlink`; null when unreadable. */
  linkTarget: string | null;
  /** False when a symlink's target does not exist. */
  targetExists: boolean;
}

export interface ResolveDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  probePath?: (path: string) => PathProbe;
  /** Run `<executable> --version`; the ONLY execution of a candidate. */
  probeVersion?: (executable: string) => { ok: boolean; output: string };
  /** `which orca`-equivalent PATH lookup; null when absent from PATH. */
  searchPath?: () => string | null;
}

export interface BrokenSymlink {
  path: string;
  target: string | null;
}

export interface ResolvedBinary {
  path: string;
  source: CandidateSource;
  /** True when the binary lives inside a macOS `.app` bundle layout. */
  bundle: boolean;
  identity: BinaryIdentity;
  /** First line of the `--version` probe; absent when the probe failed. */
  version?: string;
}

export type ResolutionStatus = "ok" | "refused" | "error";

export interface OrcaResolution {
  status: ResolutionStatus;
  platform: string;
  binary?: ResolvedBinary;
  /** Every symlink-to-nowhere met while walking the candidate list. */
  brokenSymlinks: BrokenSymlink[];
  /** Candidate paths that simply did not exist (default output omits). */
  missingCandidates: string[];
  /** Accessibility-session signals seen in the environment. */
  sessionSignals: string[];
  /** True when a strong signal means a screen-reader session is active. */
  sessionActive: boolean;
  /** Why `refused`/`error`; absent on `ok`. */
  reason?: string;
  suggestions: string[];
}

/** Strong signals: the session declares assistive technology is on. */
const STRONG_SESSION_VARS = ["ACCESSIBILITY_ENABLED", "GNOME_ACCESSIBILITY"] as const;
/** Weak signal: AT-SPI is present. Common on GNOME desktops; hint only. */
const HINT_SESSION_VARS = ["AT_SPI_BUS_ADDRESS"] as const;

function isOn(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function defaultProbePath(path: string): PathProbe {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    return { missing: true, isSymlink: false, linkTarget: null, targetExists: false };
  }
  if (!stat.isSymbolicLink()) {
    return { missing: false, isSymlink: false, linkTarget: null, targetExists: true };
  }
  let linkTarget: string | null;
  try {
    linkTarget = readlinkSync(path);
  } catch {
    linkTarget = null;
  }
  return {
    missing: false,
    isSymlink: true,
    linkTarget,
    targetExists: existsSync(path),
  };
}

function defaultProbeVersion(executable: string): { ok: boolean; output: string } {
  try {
    const output = execFileSync(executable, ["--version"], {
      timeout: 8000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output: String(output ?? "") };
  } catch {
    return { ok: false, output: "" };
  }
}

function defaultSearchPath(): string | null {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(":")) {
    if (!dir) continue;
    const candidate = join(dir, "orca");
    try {
      if (existsSync(candidate) && !lstatSync(candidate).isDirectory()) return candidate;
    } catch {
      // Unreadable dir entry: keep walking PATH.
    }
  }
  return null;
}

/**
 * Classify a `--version` probe. The runtime reports 1.x (`1.4.219`); the
 * GNOME screen reader reports its desktop version (`46.1`) and names
 * itself a screen reader in `--help`. Anything else is `unknown`, and on
 * Linux `unknown` at a system path still refuses rather than risk a
 * mis-invocation.
 */
export function classifyIdentity(output: string): BinaryIdentity {
  if (/screen reader/i.test(output)) return "screen-reader";
  const match = /v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(output);
  if (!match) return "unknown";
  const major = Number(match[1]);
  if (major >= 20) return "screen-reader";
  if (major === 1) return "orca-runtime";
  return "unknown";
}

function firstLine(output: string): string | undefined {
  const line = output.split("\n", 1)[0]?.trim();
  return line ? line : undefined;
}

function bundleCandidates(home: string): string[] {
  return [
    "/Applications/Orca.app/Contents/Resources/bin/orca",
    "/Applications/Orca.app/Contents/MacOS/orca",
    join(home, "Applications/Orca.app/Contents/Resources/bin/orca"),
    join(home, "Applications/Orca.app/Contents/MacOS/orca"),
  ];
}

function systemCandidates(): string[] {
  return ["/usr/local/bin/orca", "/opt/orca/bin/orca"];
}

export function resolveOrca(deps: ResolveDeps = {}): OrcaResolution {
  const env = deps.env ?? process.env;
  const platform: string = deps.platform ?? env[ORCA_AXI_PLATFORM_ENV] ?? process.platform;
  const home: string = deps.home ?? env[ORCA_AXI_HOME_ENV] ?? homedir();
  const probePath = deps.probePath ?? defaultProbePath;
  const probeVersion = deps.probeVersion ?? defaultProbeVersion;
  const searchPath = deps.searchPath ?? defaultSearchPath;

  const sessionSignals: string[] = [];
  for (const name of STRONG_SESSION_VARS) {
    if (isOn(env[name])) sessionSignals.push(`${name}=${env[name]}`);
  }
  const hintSignals: string[] = [];
  for (const name of HINT_SESSION_VARS) {
    if (env[name]) hintSignals.push(`${name} is set`);
  }
  const sessionActive = sessionSignals.length > 0;
  const brokenSymlinks: BrokenSymlink[] = [];
  const missingCandidates: string[] = [];
  const suggestions: string[] = [];

  // 1. Explicit override always wins the search; it never wins the guard.
  const override = env[ORCA_CLI_COMMAND_ENV]?.trim();
  if (override) {
    const probe = probeVersion(override);
    const version = probe.ok ? firstLine(probe.output) : undefined;
    const identity = probe.ok ? classifyIdentity(probe.output) : "unknown";
    if (identity === "screen-reader") {
      return {
        status: "refused",
        platform,
        brokenSymlinks,
        missingCandidates,
        sessionSignals: [...sessionSignals, ...hintSignals],
        sessionActive,
        reason:
          `${ORCA_CLI_COMMAND_ENV} points at the GNOME screen reader (${version ?? override}), ` +
          `not the Orca terminal/session runtime. Refusing to mis-invoke it.`,
        suggestions: [
          `Point ${ORCA_CLI_COMMAND_ENV} at the Orca 1.x runtime binary instead`,
          "Run `orca-axi doctor --full` to see the probed version",
        ],
      };
    }
    if (!probe.ok) {
      return {
        status: "error",
        platform,
        brokenSymlinks,
        missingCandidates,
        sessionSignals: [...sessionSignals, ...hintSignals],
        sessionActive,
        reason: `${ORCA_CLI_COMMAND_ENV} points at ${override}, which failed its --version probe.`,
        suggestions: [
          `Check that ${override} exists and is executable`,
          "Unset the override to fall back to automatic resolution",
        ],
      };
    }
    const binary: ResolvedBinary = {
      path: override,
      source: "env:ORCA_CLI_COMMAND",
      bundle: override.includes(".app/Contents/"),
      identity,
      ...(version ? { version } : {}),
    };
    if (platform === "linux" && (sessionActive || hintSignals.length > 0)) {
      suggestions.push(
        "A Linux accessibility session is active; the runtime takes over the terminal while it runs",
      );
    }
    return {
      status: "ok",
      platform,
      binary,
      brokenSymlinks,
      missingCandidates,
      sessionSignals: [...sessionSignals, ...hintSignals],
      sessionActive,
      suggestions,
    };
  }

  // 2. Walk the candidate list; dangling symlinks are reported, not fatal.
  const shim = join(home, ".local/bin/orca");
  const ordered: Array<{ path: string; source: CandidateSource; bundle: boolean }> = [
    { path: shim, source: "shim", bundle: false },
    ...bundleCandidates(home).map((path) => ({
      path,
      source: "bundle" as CandidateSource,
      bundle: true,
    })),
    ...systemCandidates().map((path) => ({
      path,
      source: "system" as CandidateSource,
      bundle: false,
    })),
  ];
  let found: { path: string; source: CandidateSource; bundle: boolean } | null = null;
  for (const candidate of ordered) {
    const probe = probePath(candidate.path);
    if (probe.missing) {
      missingCandidates.push(candidate.path);
      continue;
    }
    if (probe.isSymlink && !probe.targetExists) {
      brokenSymlinks.push({ path: candidate.path, target: probe.linkTarget });
      continue;
    }
    found = candidate;
    break;
  }
  if (!found) {
    const viaPath = searchPath();
    if (viaPath) {
      found = { path: viaPath, source: "path", bundle: viaPath.includes(".app/Contents/") };
    }
  }
  if (!found) {
    if (platform === "linux" && (sessionActive || hintSignals.length > 0)) {
      suggestions.push(
        "No Orca runtime binary was found, and this Linux session shows accessibility signals: " +
          "do not mistake /usr/bin/orca (the GNOME screen reader) for the runtime",
      );
    }
    return {
      status: "error",
      platform,
      brokenSymlinks,
      missingCandidates,
      sessionSignals: [...sessionSignals, ...hintSignals],
      sessionActive,
      reason: "No Orca terminal/session runtime binary was found.",
      suggestions: [
        "Install the Orca 1.x runtime and ensure ~/.local/bin/orca resolves to it",
        `Or set ${ORCA_CLI_COMMAND_ENV} to the runtime binary path`,
        "Run `orca-axi doctor --full` to see every candidate path tried",
        ...suggestions,
      ],
    };
  }

  // 3. Identify before accepting; on Linux, doubt refuses.
  const versionProbe = probeVersion(found.path);
  const version = versionProbe.ok ? firstLine(versionProbe.output) : undefined;
  const identity = versionProbe.ok ? classifyIdentity(versionProbe.output) : "unknown";
  const binary: ResolvedBinary = {
    path: found.path,
    source: found.source,
    bundle: found.bundle,
    identity,
    ...(version ? { version } : {}),
  };
  const atSystemPath =
    found.path === "/usr/bin/orca" ||
    found.path === "/bin/orca" ||
    found.source === "path";

  if (identity === "screen-reader") {
    return {
      status: "refused",
      platform,
      binary,
      brokenSymlinks,
      missingCandidates,
      sessionSignals: [...sessionSignals, ...hintSignals],
      sessionActive,
      reason:
        `Resolved ${found.path} (${version ?? "unprobed"}) is the GNOME screen reader, ` +
        `not the Orca terminal/session runtime. Refusing to mis-invoke it.`,
      suggestions: [
        "Install the Orca 1.x runtime (the screen reader at /usr/bin/orca is a different program with the same name)",
        `Or set ${ORCA_CLI_COMMAND_ENV} to the runtime binary path`,
      ],
    };
  }
  if (platform === "linux" && sessionActive && identity !== "orca-runtime") {
    return {
      status: "refused",
      platform,
      binary,
      brokenSymlinks,
      missingCandidates,
      sessionSignals: [...sessionSignals, ...hintSignals],
      sessionActive,
      reason:
        "A Linux screen-reader/accessibility session is active and the resolved binary " +
        "could not be positively identified as the Orca runtime. Refusing to take over the terminal.",
      suggestions: [
        `Set ${ORCA_CLI_COMMAND_ENV} to the runtime binary path to declare explicit intent`,
        "Run `orca-axi doctor --full` to see the identity probe",
      ],
    };
  }
  if (platform === "linux" && atSystemPath && identity === "unknown") {
    return {
      status: "refused",
      platform,
      binary,
      brokenSymlinks,
      missingCandidates,
      sessionSignals: [...sessionSignals, ...hintSignals],
      sessionActive,
      reason:
        `Resolved ${found.path} could not be identified as the Orca runtime, and on Linux ` +
        `a system ` +
        `path named orca is usually the GNOME screen reader. Refusing to mis-invoke it.`,
      suggestions: [
        `Set ${ORCA_CLI_COMMAND_ENV} to the real Orca 1.x runtime binary`,
        "Run `orca-axi doctor --full` to see the identity probe",
      ],
    };
  }
  if (!versionProbe.ok) {
    return {
      status: "error",
      platform,
      binary,
      brokenSymlinks,
      missingCandidates,
      sessionSignals: [...sessionSignals, ...hintSignals],
      sessionActive,
      reason: `Resolved ${found.path}, but its --version probe failed.`,
      suggestions: [
        `Check that ${found.path} is executable`,
        `Or set ${ORCA_CLI_COMMAND_ENV} to a working runtime binary`,
      ],
    };
  }
  if (platform === "linux" && (sessionActive || hintSignals.length > 0)) {
    suggestions.push(
      "A Linux accessibility session is active; the runtime takes over the terminal while it runs",
    );
  }
  return {
    status: "ok",
    platform,
    binary,
    brokenSymlinks,
    missingCandidates,
    sessionSignals: [...sessionSignals, ...hintSignals],
    sessionActive,
    suggestions,
  };
}
