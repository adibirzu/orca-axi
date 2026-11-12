import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  evaluateCustodyFence,
  guardDispatch,
  loadPaperclipOrgsConfig,
  resolveProjectGovernance,
} from "../src/paperclip/policy.js";

const CONFIG_PATH = fileURLToPath(new URL("../config/paperclip-orgs.json", import.meta.url));

describe("paperclip governance config & policy", () => {
  it("loads config/paperclip-orgs.json and maps all 6 initiatives (I-3..I-8) and 29 projects 1:1", () => {
    const config = loadPaperclipOrgsConfig({ configPath: CONFIG_PATH });
    expect(config.schemaVersion).toBe("paperclip-orgs.v1");
    expect(config.organizations).toHaveLength(6);

    const slugs = config.organizations.map((o) => o.slug);
    expect(slugs).toEqual([
      "cyb-01-fleet-harness",
      "cyb-02-pentforge-sec",
      "cyb-03-erp-finance",
      "cyb-04-ai-voice-apps",
      "cyb-05-cloud-infra",
      "cyb-06-labs-research",
    ]);

    const initiatives = config.organizations.map((o) => o.initiativeId);
    expect(initiatives).toEqual(["I-3", "I-4", "I-5", "I-6", "I-7", "I-8"]);

    const projectIds = config.organizations.flatMap((o) => o.projects.map((p) => p.id));
    expect(projectIds).toHaveLength(29);
    expect(new Set(projectIds).size).toBe(29);
    expect(projectIds).toContain("P-OCD-70");
    expect(projectIds).toContain("P-CYB-2");
    expect(projectIds).toContain("P-CYB-72");
    expect(projectIds).toContain("P-CYB-73");

    for (const org of config.organizations) {
      expect(org.governance.executionTarget).toBe("adi0-firstmate");
      expect(org.governance.vpsLocalCodeExec).toBe(false);
      expect(org.governance.mcpGovernance).toEqual({
        githubMergePr: false,
        secretsRawExport: false,
      });
      expect(org.governance.custodyFences).toEqual({
        reviewforgeHost: "adrians-macbook-pro",
        linearTeamFence: "OCD",
      });
    }
  });

  it("resolves project governance by slug, Linear project ID, or repo slug without mutating config", () => {
    const config = loadPaperclipOrgsConfig({ configPath: CONFIG_PATH });
    const bySlug = resolveProjectGovernance(config, "aetherops");
    expect(bySlug?.org.slug).toBe("cyb-05-cloud-infra");
    expect(bySlug?.project.id).toBe("P-CYB-2");

    const byId = resolveProjectGovernance(config, "P-OCD-70");
    expect(byId?.org.slug).toBe("cyb-01-fleet-harness");
    expect(byId?.project.slug).toBe("reviewforge");

    const byRepo = resolveProjectGovernance(config, "Pentforge-io/documentum");
    expect(byRepo?.org.slug).toBe("cyb-02-pentforge-sec");
    expect(byRepo?.project.id).toBe("P-CYB-71");

    const unknown = resolveProjectGovernance(config, "nonexistent-proj");
    expect(unknown).toBeNull();
  });

  it("enforces adi0-only coding execution and rejects adi4, adi5, and adrians-macbook-pro", () => {
    const config = loadPaperclipOrgsConfig({ configPath: CONFIG_PATH });

    for (const forbiddenHost of ["adi4", "adihost4", "adi5", "adrians-macbook-pro", "vps-node"]) {
      const decision = guardDispatch(config, {
        project: "orca-axi",
        host: forbiddenHost,
        harness: "codex",
      });
      expect(decision.allowed).toBe(false);
      expect(decision.code).toBe("FORBIDDEN_EXECUTION_HOST");
      expect(decision.executionTarget).toBe("adi0-firstmate");
    }

    const allowed = guardDispatch(config, {
      project: "orca-axi",
      host: "adi0",
      harness: "codex",
    });
    expect(allowed.allowed).toBe(true);
    expect(allowed.code).toBe("ALLOWED");
    expect(allowed.orgSlug).toBe("cyb-01-fleet-harness");
  });

  it("enforces aetherops / cyb-05-cloud-infra model ban: rejects agy & cursor, allows grok, codex, claude", () => {
    const config = loadPaperclipOrgsConfig({ configPath: CONFIG_PATH });

    for (const blocked of ["agy", "cursor", "AGY", "Cursor"]) {
      const decision = guardDispatch(config, {
        project: "aetherops",
        host: "adi0",
        harness: blocked,
      });
      expect(decision.allowed).toBe(false);
      expect(decision.code).toBe("FORBIDDEN_HARNESS");
      expect(decision.reason.toLowerCase()).toContain("blocked");
    }

    for (const permitted of ["grok", "codex", "claude"]) {
      const decision = guardDispatch(config, {
        project: "aetherops",
        host: "adi0",
        harness: permitted,
      });
      expect(decision.allowed).toBe(true);
      expect(decision.code).toBe("ALLOWED");
      expect(decision.orgSlug).toBe("cyb-05-cloud-infra");
    }
  });

  it("enforces adrians-macbook-pro custody fencing on OCD-* issues and wip/adrians-macbook-pro/* branches", () => {
    const config = loadPaperclipOrgsConfig({ configPath: CONFIG_PATH });

    const fencedIssue = evaluateCustodyFence(config, { issueId: "OCD-498" });
    expect(fencedIssue).toEqual({
      fenced: true,
      fencedBy: "adrians-macbook-pro",
      reason: expect.stringContaining("OCD-498"),
    });

    const rfPrefixed = evaluateCustodyFence(config, { issueId: "RF03/OCD-498" });
    expect(rfPrefixed.fenced).toBe(true);
    expect(rfPrefixed.fencedBy).toBe("adrians-macbook-pro");

    const arbitraryOcd = evaluateCustodyFence(config, { issueId: "OCD-612" });
    expect(arbitraryOcd.fenced).toBe(true);

    const fencedBranch = evaluateCustodyFence(config, {
      issueId: "CYB-101",
      branchName: "wip/adrians-macbook-pro/rf05",
    });
    expect(fencedBranch.fenced).toBe(true);
    expect(fencedBranch.fencedBy).toBe("adrians-macbook-pro");

    const companion = evaluateCustodyFence(config, { issueId: "OCD-497" });
    expect(companion.fenced).toBe(false);

    const blockedDispatch = guardDispatch(config, {
      project: "reviewforge",
      host: "adi0",
      harness: "codex",
      issueId: "OCD-501",
    });
    expect(blockedDispatch.allowed).toBe(false);
    expect(blockedDispatch.code).toBe("CUSTODY_FENCED");
    expect(blockedDispatch.fencedBy).toBe("adrians-macbook-pro");

    const allowedCompanion = guardDispatch(config, {
      project: "reviewforge",
      host: "adi0",
      harness: "codex",
      issueId: "OCD-497",
    });
    expect(allowedCompanion.allowed).toBe(true);
  });

  it("blocks forbidden MCP actions github.merge_pr and secrets.raw_export", () => {
    const config = loadPaperclipOrgsConfig({ configPath: CONFIG_PATH });

    const mergeDecision = guardDispatch(config, {
      project: "firstmate",
      host: "adi0",
      harness: "claude",
      mcpAction: "github.merge_pr",
    });
    expect(mergeDecision.allowed).toBe(false);
    expect(mergeDecision.code).toBe("FORBIDDEN_MCP_ACTION");

    const secretDecision = guardDispatch(config, {
      project: "firstmate",
      host: "adi0",
      harness: "claude",
      mcpAction: "secrets.raw_export",
    });
    expect(secretDecision.allowed).toBe(false);
    expect(secretDecision.code).toBe("FORBIDDEN_MCP_ACTION");
  });
});
