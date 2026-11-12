import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { extractIssueIdentifiers } from "./local-state.js";
import type {
  CustodySnapshot,
  GitHubPrRollup,
  LinearIssueSnapshot,
  PaperclipOrgsConfig,
} from "./types.js";

export {
  extractIssueIdentifiers,
  loadFirstMateTasks,
  loadInstanceMap,
  normalizeInstanceMap,
  parseFirstMateBacklog,
  saveInstanceMapAtomic,
} from "./local-state.js";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const REPO_SLUG_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export type ExecCommandFn = (cmd: string, args: readonly string[]) => Promise<string>;

function defaultExecCommand(cmd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      cmd,
      [...args],
      { shell: false, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) rejectPromise(err);
        else resolvePromise(String(stdout));
      },
    );
  });
}

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

export async function fetchGitHubPrsLive(
  repos: readonly string[],
  execFn: ExecCommandFn = defaultExecCommand,
): Promise<GitHubPrRollup[]> {
  const results: GitHubPrRollup[] = [];
  const uniqueRepos = Array.from(new Set(repos.filter((r) => REPO_SLUG_RE.test(r))));

  for (const repo of uniqueRepos) {
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
        results.push({
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
    } catch {
      // Skip inaccessible repos during non-blocking audit
    }
  }
  return results;
}

export async function fetchLinearIssuesLive(
  config: PaperclipOrgsConfig,
  options: { readonly apiKey?: string; readonly fetchImpl?: typeof fetch } = {},
): Promise<LinearIssueSnapshot[]> {
  const apiKey = (options.apiKey ?? process.env.LINEAR_API_KEY ?? "").trim();
  if (!apiKey) return [];
  const fetchFn = options.fetchImpl ?? fetch;

  const query = `
    query TeamIssues($teamId: ID!) {
      issues(first: 250, filter: { team: { id: { eq: $teamId } } }) {
        nodes {
          id identifier title description url priority branchName
          state { name type }
          project { id name }
          inverseRelations { nodes { type issue { identifier state { type } } } }
        }
      }
    }
  `;
  const res = await fetchFn(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: apiKey },
    body: JSON.stringify({
      query,
      variables: { teamId: config.controlPlane.linearTeam.uuid },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Linear GraphQL HTTP ${res.status}`);

  const body = (await res.json()) as Record<string, unknown>;
  const data = (body.data ?? {}) as Record<string, unknown>;
  const issuesWrap = (data.issues ?? {}) as Record<string, unknown>;
  const nodes = (Array.isArray(issuesWrap.nodes) ? issuesWrap.nodes : []) as Array<
    Record<string, unknown>
  >;

  const uuidToSpec = new Map<string, { id: string; name: string; team: "CYB" | "OCD" }>();
  for (const org of config.organizations) {
    for (const p of org.projects) {
      uuidToSpec.set(p.linearUuid, { id: p.id, name: p.name, team: p.linearTeam });
    }
  }

  const out: LinearIssueSnapshot[] = [];
  for (const node of nodes) {
    const proj = node.project as Record<string, unknown> | null | undefined;
    const projUuid = String(proj?.id ?? "");
    const mapped = uuidToSpec.get(projUuid);
    if (!mapped) continue;
    const invWrap = node.inverseRelations as Record<string, unknown> | undefined;
    const inv = (Array.isArray(invWrap?.nodes) ? invWrap.nodes : []) as Array<
      Record<string, unknown>
    >;
    const blockedBy = inv
      .filter((rel) => {
        const relIssue = rel.issue as Record<string, unknown> | undefined;
        const st = relIssue?.state as Record<string, unknown> | undefined;
        return (
          rel.type === "blocks" && !["completed", "canceled"].includes(String(st?.type ?? ""))
        );
      })
      .map((rel) => String((rel.issue as Record<string, unknown> | undefined)?.identifier ?? ""))
      .filter(Boolean);
    const stObj = node.state as Record<string, unknown> | undefined;
    const rawType = String(stObj?.type ?? "unstarted");
    const stateType = ["backlog", "unstarted", "started", "completed", "canceled"].includes(
      rawType,
    )
      ? (rawType as LinearIssueSnapshot["stateType"])
      : "unstarted";
    out.push({
      id: String(node.id),
      identifier: String(node.identifier),
      title: String(node.title),
      description: String(node.description ?? ""),
      url: String(node.url),
      stateType,
      stateName: String(stObj?.name ?? "Todo"),
      priority: Number(node.priority ?? 0),
      projectId: mapped.id,
      projectUuid: projUuid,
      projectName: mapped.name,
      teamKey: mapped.team,
      blockedBy,
      ...(typeof node.branchName === "string" && node.branchName
        ? { branchName: node.branchName }
        : {}),
    });
  }
  return out;
}

export async function updateLinearIssueStateLive(
  issueUuid: string,
  targetStateName: string,
  teamUuid: string,
  options: { readonly apiKey?: string; readonly fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const apiKey = (options.apiKey ?? process.env.LINEAR_API_KEY ?? "").trim();
  if (!apiKey) throw new Error("LINEAR_API_KEY is required to mutate Linear issue states");
  const fetchFn = options.fetchImpl ?? fetch;

  const statesQuery = `
    query WorkflowStates($teamId: ID!) {
      workflowStates(filter: { team: { id: { eq: $teamId } } }) {
        nodes { id name type }
      }
    }
  `;
  const sRes = await fetchFn(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: apiKey },
    body: JSON.stringify({ query: statesQuery, variables: { teamId: teamUuid } }),
    signal: AbortSignal.timeout(15_000),
  });
  const sBody = (await sRes.json()) as Record<string, unknown>;
  const wf = ((sBody.data as Record<string, unknown> | undefined)?.workflowStates ??
    {}) as Record<string, unknown>;
  const states = (Array.isArray(wf.nodes) ? wf.nodes : []) as Array<Record<string, string>>;
  const match = states.find(
    (s) => s.name?.trim().toLowerCase() === targetStateName.trim().toLowerCase(),
  );
  if (!match?.id) return;

  const mutation = `
    mutation UpdateState($id: String!, $stateId: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) { success }
    }
  `;
  await fetchFn(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: apiKey },
    body: JSON.stringify({ query: mutation, variables: { id: issueUuid, stateId: match.id } }),
    signal: AbortSignal.timeout(15_000),
  });
}
