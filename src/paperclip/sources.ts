import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  defaultExecCommand,
  type ExecCommandFn,
  fetchLinearIssuesLive,
  type LinearFetchOptions,
  runWithConcurrency,
  updateLinearIssueStateLive,
} from "./linear-loader.js";
import { extractIssueIdentifiers } from "./local-state.js";
import type {
  CustodySnapshot,
  GitHubPrRollup,
  PaperclipOrgsConfig,
} from "./types.js";

export {
  type ExecCommandFn,
  fetchLinearIssuesLive,
  type LinearFetchOptions,
  runWithConcurrency,
  updateLinearIssueStateLive,
};
export {
  extractIssueIdentifiers,
  loadFirstMateTasks,
  loadInstanceMap,
  normalizeInstanceMap,
  parseFirstMateBacklog,
  saveInstanceMapAtomic,
} from "./local-state.js";

const REPO_SLUG_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
export const DEFAULT_GITHUB_PR_CONCURRENCY = 6;

export async function loadCustodySnapshotLive(
  config: PaperclipOrgsConfig,
  options: {
    readonly rfMacSyncBin?: string;
    readonly execFn?: ExecCommandFn;
  } = {},
): Promise<CustodySnapshot> {
  const base = config.globalGovernance.custodyFences;
  const bin = options.rfMacSyncBin ?? join(homedir(), ".local", "bin", "rf-mac-sync");
  if (!options.execFn && !existsSync(bin)) {
    return {
      reviewforgeHost: base.reviewforgeHost,
      fencedIssues: [...base.fencedIssues],
      adi0CompanionIssues: [...base.adi0CompanionIssues],
      activeBranches: [],
    };
  }
  try {
    const runner = options.execFn ?? defaultExecCommand;
    const out = await runner(bin, ["status", "--json"]);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    const hosts = Array.isArray(parsed.hosts) ? parsed.hosts : [];
    const primaryHost = hosts.find(
      (h) => (h as Record<string, unknown>)?.host === base.reviewforgeHost,
    ) as Record<string, unknown> | undefined;
    const dynamicIssues = Array.isArray(primaryHost?.active_issues)
      ? (primaryHost.active_issues as string[])
      : [];
    const cloneBranch = String(
      (parsed.primary_clone as Record<string, unknown> | undefined)?.branch ?? "",
    );
    return {
      reviewforgeHost: base.reviewforgeHost,
      fencedIssues: Array.from(new Set([...base.fencedIssues, ...dynamicIssues])),
      adi0CompanionIssues: [...base.adi0CompanionIssues],
      activeBranches: cloneBranch && cloneBranch !== "none" ? [cloneBranch] : [],
    };
  } catch {
    return {
      reviewforgeHost: base.reviewforgeHost,
      fencedIssues: [...base.fencedIssues],
      adi0CompanionIssues: [...base.adi0CompanionIssues],
      activeBranches: [],
    };
  }
}

function parseRepoPrRollups(repo: string, stdout: string): GitHubPrRollup[] {
  const rollups: GitHubPrRollup[] = [];
  const items = JSON.parse(stdout || "[]") as Array<Record<string, unknown>>;
  for (const item of items) {
    const text = `${String(item.title ?? "")}\n${String(item.headRefName ?? "")}\n${String(item.body ?? "")}`;
    const linearIdentifiers = extractIssueIdentifiers(text);
    if (linearIdentifiers.length === 0) continue;
    const checks = Array.isArray(item.statusCheckRollup)
      ? (item.statusCheckRollup as Array<Record<string, unknown>>)
      : [];
    const hasFail = checks.some((c) =>
      ["FAILURE", "ERROR", "TIMED_OUT"].includes(String(c.conclusion ?? c.state ?? "")),
    );
    const hasPending = checks.some((c) =>
      ["PENDING", "IN_PROGRESS", "QUEUED"].includes(String(c.status ?? c.state ?? "")),
    );
    const ciState = hasFail
      ? "FAILURE"
      : hasPending
        ? "PENDING"
        : checks.length > 0
          ? "SUCCESS"
          : "UNKNOWN";
    const stateRaw = String(item.state ?? "OPEN").toUpperCase();
    if (stateRaw !== "OPEN" && stateRaw !== "MERGED" && stateRaw !== "CLOSED") continue;
    rollups.push({
      repo,
      number: Number(item.number),
      title: String(item.title ?? ""),
      url: String(item.url ?? ""),
      state: stateRaw,
      headRefName: String(item.headRefName ?? "unknown"),
      ciState,
      linearIdentifiers,
      ...(typeof item.mergedAt === "string" ? { mergedAt: item.mergedAt } : {}),
    });
  }
  return rollups;
}

export async function fetchGitHubPrsLive(
  repos: readonly string[],
  execFn: ExecCommandFn = defaultExecCommand,
  concurrency: number = DEFAULT_GITHUB_PR_CONCURRENCY,
): Promise<GitHubPrRollup[]> {
  const uniqueRepos = Array.from(new Set(repos.filter((r) => REPO_SLUG_RE.test(r))));
  const perRepo = await runWithConcurrency(uniqueRepos, concurrency, async (repo) => {
    try {
      const stdout = await execFn("gh", [
        "pr",
        "list",
        "-R",
        repo,
        "--state",
        "all",
        "--limit",
        "25",
        "--json",
        "number,title,url,state,headRefName,statusCheckRollup,mergedAt,body",
      ]);
      return parseRepoPrRollups(repo, stdout);
    } catch {
      return [];
    }
  });
  return perRepo.flat();
}
