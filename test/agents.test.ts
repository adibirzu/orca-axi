import { describe, expect, it } from "vitest";

import {
  classifyProcessLine,
  extractLinearIssue,
  inferProjectFromPath,
  parsePsOutput,
  sanitizeCommandPreview,
} from "../src/agents/classify.js";
import {
  buildProjectSummaries,
  correlateHostAgents,
  mergeFleetReport,
} from "../src/agents/correlate.js";
import {
  checkDocPresence,
  collectFleetAgents,
  collectRemoteMachine,
  normalizeLocalHostName,
  parseLsofAgyLocks,
  parseLsofCwds,
  parseTmuxPaneLines,
} from "../src/agents/collect.js";
import { main } from "../src/cli.js";
import { agentsCommand } from "../src/commands/agents.js";
import { fleetCommand } from "../src/commands/fleet.js";

describe("process classification & noise filtering", () => {
  it("recognizes all supported agent harnesses and extracts session ids", () => {
    const samplePs = [
      "  PID  PPID TTY      STAT  %CPU     ELAPSED COMMAND",
      "57264  5982 ttys000  S+     2.4       15:20 agy --dangerously-skip-permissions",
      "60001  5982 ttys001  S+     0.1       05:10 agy --conversation bff46a10-19ee-4d69-950c-42301d69c5ca",
      "91393 91011 ttys046  R+    14.5       42:00 /Users/adrianb/.bun/install/global/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex",
      "91491 91205 ttys047  S+     0.0    01:12:00 claude --resume ba82ff95-94cb-4c56-bc96-7cc9184b0ea3",
      "57926 57904 ?        Sl     0.8    08:31:56 /opt/Grok Bot/grok-bot --no-sandbox",
      "41002 41000 ttys010  S+     1.1       09:00 opencode --project /Users/adrianb/dev/tms",
      "41003 41000 ttys011  S+     0.5       04:00 /Users/adrianb/.local/share/cursor-agent/versions/2026.08.11/cursor-agent",
      "41004 41000 ttys012  S+     3.2       02:15 node /opt/homebrew/lib/node_modules/@google/gemini-cli/dist/index.js -y",
      "41005 41000 ttys013  S+     0.4       01:10 node /Users/adrianb/.nvm/versions/node/v22/lib/node_modules/cline/bin/.cline",
      "743002 743001 ?      Ssl    2.1  1-09:20:15 /opt/hermes/.venv/bin/python -P -c import sys; sys.argv[0]='hermes'; from hermes_cli.main import main; main() gateway run --replace",
    ].join("\n");

    const parsed = parsePsOutput(samplePs);
    expect(parsed.map((p) => p.harness)).toEqual([
      "agy",
      "agy",
      "codex",
      "claude",
      "grok",
      "opencode",
      "cursor",
      "gemini",
      "cline",
      "hermes",
    ]);
    expect(parsed[1]?.sessionId).toBe("bff46a10-19ee-4d69-950c-42301d69c5ca");
    expect(parsed[3]?.sessionId).toBe("ba82ff95-94cb-4c56-bc96-7cc9184b0ea3");
  });

  it("filters out helper subprocesses, daemons, Electron renderers, and grep noise", () => {
    const noisyLines = [
      " 1830     1 ??       S      0.0 06:56:28 /System/Library/PrivateFrameworks/TextInputUIMacHelper.framework/CursorUIViewService",
      " 3908  3822 ??       S      0.0 06:51:09 /Applications/ChatGPT.app/Contents/Frameworks/Codex (Aperitif) --type=gpu-process",
      "92395 91393 ??       Ss     0.0    10:00 /Users/adrianb/.codex/packages/app-server-daemon/bin/codex app-server --listen unix://",
      "48077     1 ??       Ss     0.0    20:00 /Users/adrianb/.opencode/bin/opencode serve --service",
      "36063 92080 ??       Ss     0.0    00:02 /bin/bash /Users/adrianb/.claude/PAI/statusline-command.sh",
      "44001 91491 ??       S      0.0    00:10 claude --claude-in-chrome-mcp",
      "58019 57932 ?        Sl     8.3 08:31:56 /opt/Grok Bot/grok-bot --type=renderer --no-sandbox",
      "57953 57860 ?        Sl     0.0 08:31:56 /opt/Grok Bot/chrome_crashpad_handler --database=/tmp",
      "742982 742762 ?      Ssl    0.2  1-09:20 /opt/hermes/.venv/bin/python -c sys.argv[0]='hermes' dashboard --port 9119",
      "88001 88000 ttys020  S+     0.0    00:01 grep -Ei claude|codex|agy",
      "88002 88000 ttys021  S+     0.0    00:01 node /Users/adrianb/.local/bin/orca-axi agents --json",
    ];

    for (const line of noisyLines) {
      expect(classifyProcessLine(line)).toBeNull();
    }
  });

  it("sanitizes sensitive tokens and API keys in command previews", () => {
    const fakeKey = ["sk", "ant", "TESTKEY123456789"].join("-");
    const fakePat = ["ghp", "TESTTOKEN1234567890"].join("_");
    const fakeJwt = ["eyJhbGciOiJIUzI1NiJ9", "payload", "sig"].join(".");
    const raw = `claude --api-key ${fakeKey} --token ${fakePat} Authorization: Bearer ${fakeJwt}`;
    const sanitized = sanitizeCommandPreview(raw);
    expect(sanitized).not.toContain("TESTKEY123456789");
    expect(sanitized).not.toContain("TESTTOKEN1234567890");
    expect(sanitized).not.toContain("eyJhbGci");
    expect(sanitized).toContain("[REDACTED]");
  });

  it("extracts Linear issues and canonical project names cleanly", () => {
    expect(extractLinearIssue("CYB-421", "refs/heads/main")).toBe("CYB-421");
    expect(extractLinearIssue(null, "refs/heads/feat/cyb-108-agent-radar")).toBe("CYB-108");
    expect(extractLinearIssue("https://linear.app/cyber-sec/issue/CYB-77/fleet", null)).toBe("CYB-77");
    expect(extractLinearIssue(null, "refs/heads/main")).toBeNull();

    expect(inferProjectFromPath("/Users/adrianb/orca/workspaces/orca-axi/fleet-agent-radar")).toBe(
      "orca-axi",
    );
    expect(
      inferProjectFromPath(
        "/Volumes/ExternalNVME/.fm-pools/firstmate-3730267688/.treehouse/firstmate-92a512/10/firstmate",
      ),
    ).toBe("firstmate");
    expect(inferProjectFromPath("/Users/adrianb/dev/accountingapp")).toBe("accountingapp");
  });
});

describe("surface correlation & project organization", () => {
  it("correlates OS processes with Antigravity lock, Orca, Herdr, tmux, and git/docs", () => {
    const psText = [
      "  PID  PPID TTY      STAT  %CPU     ELAPSED COMMAND",
      "57264  5982 ttys000  S+     1.8       25:00 agy --dangerously-skip-permissions",
      "59010  5900 ttys005  S+     0.1       02:00 python3 /Users/adrianb/.local/bin/agy-session-bridge.py --conversation bff46a10-19ee-4d69-950c-42301d69c5ca --watch-pid 57264",
      "91393 91011 ttys046  S+     3.2       45:00 /opt/codex/bin/codex",
      "91491 91205 ttys047  S+     0.0    01:10:00 claude --resume ba82ff95-94cb-4c56-bc96-7cc9184b0ea3",
    ].join("\n");

    const agents = correlateHostAgents({
      host: "adi0",
      nowMs: 1794436600000,
      psText,
      cwdsByPid: new Map([
        [57264, "/Users/adrianb/dev/firstmate"],
        [91393, "/Users/adrianb/orca/workspaces/orca-axi/fleet-agent-radar"],
        [91491, "/Volumes/ExternalNVME/.fm-pools/firstmate-3730267688/.treehouse/firstmate-92a512/10/firstmate"],
      ]),
      agyLocksByPid: new Map([[57264, "bff46a10-19ee-4d69-950c-42301d69c5ca"]]),
      agyTranscriptMtimeByConv: new Map([["bff46a10-19ee-4d69-950c-42301d69c5ca", 1794436595000]]),
      orcaWorktrees: [
        {
          id: "wt-firstmate",
          path: "/Users/adrianb/dev/firstmate",
          projectId: "github:adibirzu/firstmate",
          branch: "refs/heads/main",
          linkedLinearIssue: null,
          lastActivityAt: 1794436500000,
        },
        {
          id: "wt-orca-axi",
          path: "/Users/adrianb/orca/workspaces/orca-axi/fleet-agent-radar",
          projectId: "github:adibirzu/orca-axi",
          branch: "refs/heads/feat/cyb-901-fleet-agent-radar",
          linkedLinearIssue: "CYB-901",
          lastActivityAt: 1794436580000,
        },
      ],
      orcaTerminals: [
        {
          handle: "term_orca_1",
          worktreePath: "/Users/adrianb/dev/firstmate",
          title: "agy-captain (bff46a10)",
          lastOutputAt: 1794436590000,
        },
      ],
      herdrAgents: [
        {
          session: "default",
          agent: "agy",
          agentStatus: "working",
          cwd: "/Users/adrianb/dev/firstmate",
          paneId: "wG0:p1",
          workspaceId: "wG0",
          workspaceLabel: "agy-captain (admiral)",
          sessionId: "bff46a10-19ee-4d69-950c-42301d69c5ca",
          title: "Antigravity captain (bff46a10)",
        },
        {
          session: "default",
          agent: "claude",
          agentStatus: "idle",
          cwd: "/Volumes/ExternalNVME/.fm-pools/firstmate-3730267688/.treehouse/firstmate-92a512/10/firstmate",
          paneId: "wE2:p8",
          workspaceId: "wE2",
          workspaceLabel: "2m-lifeos-captain",
          sessionId: "ba82ff95-94cb-4c56-bc96-7cc9184b0ea3",
          title: "Firstmate operational inbox message",
        },
      ],
      tmuxPanes: [
        {
          paneRef: "admiral:0.0",
          panePid: 59010,
          paneTty: "ttys005",
          panePath: "/Users/adrianb",
          windowName: "agy-captain",
        },
      ],
      gitInfoByDir: new Map([
        [
          "/Users/adrianb/dev/firstmate",
          {
            repoPath: "/Users/adrianb/dev/firstmate",
            branch: "main",
            docs: { readme: true, roadmap: true, plans: false },
          },
        ],
        [
          "/Users/adrianb/orca/workspaces/orca-axi/fleet-agent-radar",
          {
            repoPath: "/Users/adrianb/dev/orca-axi",
            branch: "feat/cyb-901-fleet-agent-radar",
            docs: { readme: true, roadmap: false, plans: false },
          },
        ],
      ]),
    });

    expect(agents).toHaveLength(3);

    const agyCaptain = agents.find((a) => a.harness === "agy");
    expect(agyCaptain).toBeDefined();
    expect(agyCaptain?.sessionId).toBe("bff46a10-19ee-4d69-950c-42301d69c5ca");
    expect(agyCaptain?.surfaces).toEqual(expect.arrayContaining(["terminal", "tmux", "herdr", "orca"]));
    expect(agyCaptain?.state).toBe("bridged");
    expect(agyCaptain?.project).toBe("firstmate");

    const codexWorker = agents.find((a) => a.harness === "codex");
    expect(codexWorker?.project).toBe("orca-axi");
    expect(codexWorker?.linearIssue).toBe("CYB-901");
    expect(codexWorker?.surface).toBe("orca");
    expect(codexWorker?.state).toBe("working");

    const claudeCaptain = agents.find((a) => a.harness === "claude");
    expect(claudeCaptain?.surface).toBe("herdr");
    expect(claudeCaptain?.state).toBe("idle");
    expect(claudeCaptain?.title).toContain("2m-lifeos-captain");

    const projects = buildProjectSummaries(
      agents,
      new Map([
        ["firstmate", { readme: true, roadmap: true, plans: false }],
        ["orca-axi", { readme: true, roadmap: false, plans: false }],
      ]),
    );
    expect(projects.map((p) => p.project)).toEqual(["firstmate", "orca-axi"]);
    expect(projects[0]?.activeAgentCount).toBe(2);
    expect(projects[1]?.linearIssues).toEqual(["CYB-901"]);
  });
});

describe("remote SSH fleet probing & CLI commands", () => {
  it("tries fallback SSH alias (adi2-ts) and reports unreachable gracefully on failure", async () => {
    const tried: string[] = [];
    const okResult = await collectRemoteMachine(
      { host: "adi2", sshTargets: ["adi2", "adi2-ts"] },
      async (sshTarget) => {
        tried.push(sshTarget);
        if (sshTarget === "adi2") {
          throw new Error("Could not resolve hostname edgexpert-33b0.local");
        }
        return JSON.stringify({
          psText: "  PID PPID TTY STAT %CPU ELAPSED COMMAND\n 4200 4100 pts/1 S+ 4.5 10:00 codex\n",
          cwds: { "4200": "/home/adi/dev/aetherops" },
          tmuxLines: ["work:0.0 4100 /dev/pts/1 /home/adi/dev/aetherops main"],
          herdrAgents: [],
          gitByDir: {
            "/home/adi/dev/aetherops": {
              repoPath: "/home/adi/dev/aetherops",
              branch: "feat/cyb-300-telemetry",
              docs: { readme: true, roadmap: true, plans: true },
            },
          },
        });
      },
    );

    expect(tried).toEqual(["adi2", "adi2-ts"]);
    expect(okResult.status.reachable).toBe(true);
    expect(okResult.agents).toHaveLength(1);
    expect(okResult.agents[0]?.host).toBe("adi2");
    expect(okResult.agents[0]?.project).toBe("aetherops");
    expect(okResult.agents[0]?.linearIssue).toBe("CYB-300");

    const offlineResult = await collectRemoteMachine(
      { host: "adi9", sshTargets: ["adi9"] },
      async () => {
        throw new Error("Operation timed out");
      },
    );
    expect(offlineResult.status.reachable).toBe(false);
    expect(offlineResult.status.error).toContain("Operation timed out");
    expect(offlineResult.agents).toEqual([]);
  });

  it("supports filtering by --project, --active-only, --summary-by-project, and --json", async () => {
    const cannedReport = mergeFleetReport("adi0", "2026-11-11T22:35:00.000Z", [
      {
        status: { host: "adi0", reachable: true, agentCount: 2, workingCount: 1, durationMs: 12 },
        agents: [
          {
            id: "adi0:57264",
            host: "adi0",
            pid: 57264,
            ppid: 5982,
            tty: "ttys000",
            harness: "agy",
            surface: "orca",
            surfaces: ["terminal", "tmux", "herdr", "orca"],
            state: "bridged",
            cpuPercent: 1.5,
            elapsed: "20:00",
            sessionId: "bff46a10-19ee-4d69-950c-42301d69c5ca",
            title: "agy-captain (bff46a10)",
            cwd: "/Users/adrianb/dev/firstmate",
            project: "firstmate",
            repoPath: "/Users/adrianb/dev/firstmate",
            worktreePath: "/Users/adrianb/dev/firstmate",
            branch: "main",
            linearIssue: null,
            lastActivityAt: 1794436595000,
            command: "agy --dangerously-skip-permissions",
          },
          {
            id: "adi0:91491",
            host: "adi0",
            pid: 91491,
            ppid: 91205,
            tty: "ttys047",
            harness: "claude",
            surface: "herdr",
            surfaces: ["herdr"],
            state: "idle",
            cpuPercent: 0.0,
            elapsed: "01:10:00",
            sessionId: "ba82ff95-94cb-4c56-bc96-7cc9184b0ea3",
            title: "2m-tms-captain",
            cwd: "/Users/adrianb/dev/tms",
            project: "tms",
            repoPath: "/Users/adrianb/dev/tms",
            worktreePath: "/Users/adrianb/dev/tms",
            branch: "feat/cyb-55",
            linearIssue: "CYB-55",
            lastActivityAt: 1794436000000,
            command: "claude --resume ba82ff95",
          },
        ],
        docsByProject: new Map([
          ["firstmate", { readme: true, roadmap: true, plans: false }],
          ["tms", { readme: true, roadmap: true, plans: true }],
        ]),
      },
    ]);

    const jsonOut = await agentsCommand(["--all-machines", "--active-only", "--json"], {
      collect: async () => cannedReport,
    });
    const parsed = JSON.parse(jsonOut) as {
      agents: { totals: { agents: number }; items: Array<{ harness: string }> };
    };
    expect(parsed.agents.totals.agents).toBe(1);
    expect(parsed.agents.items[0]?.harness).toBe("agy");

    const projToon = await agentsCommand(["--project", "tms", "--summary-by-project"], {
      collect: async () => cannedReport,
    });
    expect(projToon).toContain("tms");
    expect(projToon).toContain("CYB-55");

    const helpOut = await agentsCommand(["--help"]);
    expect(helpOut).toContain("--all-machines");

    const fleetWithAgents = await fleetCommand(["--agents", "--json"], {
      resolve: () => ({
        status: "ok",
        platform: "darwin",
        binary: {
          path: "/usr/local/bin/orca",
          source: "system",
          version: "1.4.256",
          identity: "orca-runtime",
        },
        brokenSymlinks: [],
        missingCandidates: [],
        sessionSignals: [],
        sessionActive: false,
        suggestions: [],
      }),
      collectAgents: async () => cannedReport,
    });
    const parsedFleet = JSON.parse(fleetWithAgents) as {
      fleet: { status: string; agentsSummary: { total: number } };
    };
    expect(parsedFleet.fleet.status).toBe("ok");
    expect(parsedFleet.fleet.agentsSummary.total).toBe(2);
  });

  it("parses lsof CWDs, Antigravity lock files, tmux panes, hostnames, and CLI help", async () => {
    const cwds = parseLsofCwds("p57264\nn/Users/adrianb\np91393\nn/Users/adrianb/dev/orca-axi\n");
    expect(cwds.get(57264)).toBe("/Users/adrianb");
    expect(cwds.get(91393)).toBe("/Users/adrianb/dev/orca-axi");

    const locks = parseLsofAgyLocks(
      "p57264\nn/Users/adrianb/.gemini/antigravity-cli/presence/bff46a10-19ee-4d69-950c-42301d69c5ca.lock\n",
    );
    expect(locks.get(57264)).toBe("bff46a10-19ee-4d69-950c-42301d69c5ca");

    const panes = parseTmuxPaneLines([
      "admiral:0.0\t59010\t/dev/ttys005\t/Users/adrianb\tagy-captain",
      "work:1.0 4200 /dev/pts/2 /home/adi/dev/tms server",
    ]);
    expect(panes).toHaveLength(2);
    expect(panes[0]?.paneTty).toBe("ttys005");
    expect(panes[1]?.windowName).toBe("server");

    expect(normalizeLocalHostName("Adi0.local")).toBe("adi0");
    expect(normalizeLocalHostName("Adrians-Mini.cyber-sec.ro")).toBe("macmini");
    expect(normalizeLocalHostName("srv2083966")).toBe("adi4");

    const docs = checkDocPresence(process.cwd());
    expect(docs.readme).toBe(true);

    let helpStdout = "";
    await main({
      argv: ["projects", "--help"],
      stdout: {
        write: (chunk) => {
          helpStdout += chunk;
          return true;
        },
      },
    });
    expect(helpStdout).toContain("--all-machines");

    // Exercise collectFleetAgents with mocked remote runner + plain TOON output
    const liveReport = await collectFleetAgents({
      allMachines: true,
      remoteSpecs: [{ host: "mock-remote", sshTargets: ["mock-remote"] }],
      sshRunner: async () =>
        JSON.stringify({
          psText: "  PID PPID TTY STAT %CPU ELAPSED COMMAND\n 1010 1000 pts/0 R+ 5.0 01:00 claude\n",
          cwds: { "1010": "/home/adi/dev/firstmate" },
          tmuxLines: [],
          herdrAgents: [],
          gitByDir: {},
        }),
    });
    expect(liveReport.machines.some((m) => m.host === "mock-remote" && m.reachable)).toBe(true);

    const plainToon = await agentsCommand([], { collect: async () => liveReport });
    expect(plainToon).toContain("agents:");
  });
});
