import {
  type PaperclipCliDeps,
  runClaimOp,
  runDoctorOp,
  runGuardDispatchOp,
  runOrgsBootstrapOp,
  runReportPrOp,
  runSyncOp,
  runWatchEventsOp,
} from "./ops.js";

const HELP_TEXT = `paperclip-cyb — 4-Way Paperclip <-> Linear CYB <-> GitHub <-> FirstMate Sync & Governance CLI

Usage:
  paperclip-cyb doctor [--json]
  paperclip-cyb orgs bootstrap [--dry-run|--apply] [--json]
  paperclip-cyb sync [--project <slug>] [--initiative <I-3..I-8>] [--limit <n>] [--dry-run|--apply] [--json]
  paperclip-cyb guard-dispatch --project <slug> --host <host> --harness <harness> [--issue <id>] [--branch <ref>] [--mcp-action <act>] [--json]
  paperclip-cyb claim <linear-id> --fm-task <id> --worktree <path> [--harness <h>] [--json]
  paperclip-cyb report-pr <linear-id> --pr <url> [--ci <state>] [--json]
  paperclip-cyb watch-events [--once|--timeout-sec <n>] [--json]
`;

interface ParsedArgs {
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
}

function parseArgv(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "-h" || token === "--help") {
      flags.help = true;
      continue;
    }
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq > 2) {
        flags[token.slice(2, eq)] = token.slice(eq + 1);
      } else {
        const key = token.slice(2);
        const next = argv[i + 1];
        if (
          next !== undefined &&
          !next.startsWith("-") &&
          [
            "project",
            "initiative",
            "limit",
            "host",
            "harness",
            "issue",
            "branch",
            "mcp-action",
            "fm-task",
            "worktree",
            "pr",
            "ci",
            "timeout-sec",
          ].includes(key)
        ) {
          flags[key] = next;
          i += 1;
        } else {
          flags[key] = true;
        }
      }
      continue;
    }
    positionals.push(token);
  }
  return { positionals, flags };
}

function stringFlag(flags: Readonly<Record<string, string | boolean>>, key: string): string | null {
  const val = flags[key];
  return typeof val === "string" && val.trim().length > 0 ? val.trim() : null;
}

function emitEnvelope(
  write: (s: string) => void,
  asJson: boolean,
  envelope: {
    readonly success: boolean;
    readonly data: unknown;
    readonly error: string | null;
    readonly meta?: Record<string, unknown>;
  },
  humanSummary?: string,
): void {
  if (asJson) {
    write(`${JSON.stringify(envelope, null, 2)}\n`);
    return;
  }
  if (!envelope.success) {
    write(`ERROR: ${envelope.error}\n`);
    return;
  }
  write(`${humanSummary ?? JSON.stringify(envelope.data, null, 2)}\n`);
}

export async function runPaperclipCybCli(
  argv: readonly string[],
  deps: PaperclipCliDeps = {},
): Promise<number> {
  const writeOut = deps.writeStdout ?? ((s: string) => process.stdout.write(s));
  const parsed = parseArgv(argv);
  const asJson = Boolean(parsed.flags.json);

  if (parsed.flags.help || parsed.positionals.length === 0) {
    writeOut(HELP_TEXT);
    return 0;
  }

  const cmd = parsed.positionals[0]!;

  try {
    if (cmd === "doctor") {
      const report = await runDoctorOp(deps);
      emitEnvelope(
        writeOut,
        asJson,
        { success: true, data: report, error: null },
        `paperclip-cyb doctor: orgs=${String(report.organizationsCount)} projects=${String(report.projectsCount)} target=${String(report.executionTarget)} api=${String((report.apiHealth as Record<string, unknown>).status)}`,
      );
      return 0;
    }

    if (cmd === "orgs" && parsed.positionals[1] === "bootstrap") {
      const apply = Boolean(parsed.flags.apply) && !parsed.flags["dry-run"];
      const res = await runOrgsBootstrapOp(deps, { apply });
      emitEnvelope(
        writeOut,
        asJson,
        { success: true, data: res, error: null },
        `paperclip-cyb orgs bootstrap [${String(res.mode)}]: plannedOrgsToCreate=${String(res.plannedOrgsToCreate)} plannedProjectsToCreate=${String(res.plannedProjectsToCreate)}`,
      );
      return 0;
    }

    if (cmd === "sync") {
      const apply = Boolean(parsed.flags.apply) && !parsed.flags["dry-run"];
      const limitStr = stringFlag(parsed.flags, "limit");
      const limit = limitStr ? Number.parseInt(limitStr, 10) : null;
      if (limitStr && (Number.isNaN(limit!) || limit! <= 0)) {
        throw new Error(`Invalid --limit value: ${limitStr}`);
      }
      const res = await runSyncOp(deps, {
        apply,
        project: stringFlag(parsed.flags, "project"),
        initiative: stringFlag(parsed.flags, "initiative"),
        limit,
      });
      emitEnvelope(
        writeOut,
        asJson,
        { success: true, data: res, error: null },
        `paperclip-cyb sync [${res.mode}]: mutations=${res.mutations.length} readyQueue=${res.readyQueue.length} fenced=${res.fencedItems.length} fleetSyncRepos=${res.fleetSyncRepos.length}`,
      );
      return 0;
    }

    if (cmd === "guard-dispatch") {
      const project = stringFlag(parsed.flags, "project");
      const host = stringFlag(parsed.flags, "host");
      const harness = stringFlag(parsed.flags, "harness");
      if (!project || !host || !harness) {
        throw new Error("guard-dispatch requires --project <slug> --host <host> --harness <harness>");
      }
      const mcpRaw = stringFlag(parsed.flags, "mcp-action");
      const mcpAction =
        mcpRaw === "github.merge_pr" || mcpRaw === "secrets.raw_export" ? mcpRaw : null;
      const decision = await runGuardDispatchOp(deps, {
        project,
        host,
        harness,
        issueId: stringFlag(parsed.flags, "issue"),
        branchName: stringFlag(parsed.flags, "branch"),
        mcpAction,
      });
      emitEnvelope(
        writeOut,
        asJson,
        {
          success: decision.allowed,
          data: decision,
          error: decision.allowed ? null : decision.reason,
        },
        `${decision.allowed ? "ALLOW" : "BLOCK"} [${decision.code}]: ${decision.reason}`,
      );
      return decision.allowed ? 0 : 2;
    }

    if (cmd === "claim") {
      const linearId = parsed.positionals[1];
      const fmTaskId = stringFlag(parsed.flags, "fm-task");
      const worktree = stringFlag(parsed.flags, "worktree");
      if (!linearId || !fmTaskId || !worktree) {
        throw new Error("claim requires <linear-id> --fm-task <id> --worktree <path>");
      }
      const res = await runClaimOp(deps, {
        linearId,
        fmTaskId,
        worktree,
        harness: stringFlag(parsed.flags, "harness") ?? undefined,
      });
      emitEnvelope(
        writeOut,
        asJson,
        { success: true, data: res, error: null },
        `Claimed ${res.entry.linearIdentifier} -> FirstMate ${res.entry.fmTaskId} (${res.entry.worktree})`,
      );
      return 0;
    }

    if (cmd === "report-pr") {
      const linearId = parsed.positionals[1];
      const prUrl = stringFlag(parsed.flags, "pr");
      if (!linearId || !prUrl) {
        throw new Error("report-pr requires <linear-id> --pr <url>");
      }
      const res = await runReportPrOp(deps, {
        linearId,
        prUrl,
        ciState: stringFlag(parsed.flags, "ci") ?? undefined,
      });
      emitEnvelope(
        writeOut,
        asJson,
        { success: true, data: res, error: null },
        `Reported PR for ${res.entry.linearIdentifier}: ${prUrl} (status=${res.entry.lastPaperclipStatus})`,
      );
      return 0;
    }

    if (cmd === "watch-events") {
      const once = Boolean(parsed.flags.once);
      const timeoutStr = stringFlag(parsed.flags, "timeout-sec");
      const timeoutSec = timeoutStr ? Number.parseInt(timeoutStr, 10) : 30;
      const res = await runWatchEventsOp(deps, { once, timeoutSec });
      // Always emit structured JSON wake payload for FirstMate's fm-procevent.sh
      writeOut(
        `${JSON.stringify({ success: true, data: res, error: null }, null, 2)}\n`,
      );
      return 0;
    }

    throw new Error(`Unknown subcommand '${cmd}'. Run 'paperclip-cyb --help' for usage.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitEnvelope(writeOut, asJson, { success: false, data: null, error: message });
    return 1;
  }
}
