/**
 * OB-4 mirror tests.
 *
 * Fixtures stand in for both sides the real deployment wires together:
 * - the Firstmate state source is a minimal `fm-fleet-snapshot.v1` document
 *   (the shape `fm-fleet-snapshot.sh --json` emits), built inline and via
 *   temp `--from` files — never the live Firstmate home;
 * - the Orca card sink is a validating fixture (`acceptSinkCards`) that
 *   checks the placement/shape the Mac-side step needs before it feeds
 *   cards into the real Orca UI.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../src/cli.js";
import { mirrorCommand } from "../src/commands/mirror.js";
import {
  FLEET_SNAPSHOT_SCHEMA,
  MIRROR_SCHEMA,
  projectSnapshotToMirror,
  toOrcaSinkCards,
  type MirrorView,
} from "../src/mirror.js";

/** Minimal Firstmate-source fixture: three backlog rows, mixed states. */
function snapshotFixture() {
  return {
    schema: FLEET_SNAPSHOT_SCHEMA,
    generated: "2026-10-07T00:00:00Z",
    fm_home: "/home/test/.firstmate-axi",
    backlog: {
      records: [
        {
          id: "ob-4-orca-axi-mirror",
          title: "Orca-axi mirror cards",
          state: "in_flight",
          kind: "ship",
          repo: "orca-axi",
          current_role: "worker",
          since: "2026-10-07",
          pr_url: null,
          links: ["https://example.invalid/pr/1"],
          blocked_by_ids: [],
          hold_kind: null,
          hold_reason: null,
        },
        {
          id: "queued-thing",
          title: "Queued work",
          state: "queued",
          kind: "captain",
          repo: null,
          current_role: "queued",
          since: "2026-10-01",
          pr_url: "https://example.invalid/pr/9",
          links: [],
          blocked_by_ids: ["ob-4-orca-axi-mirror"],
          hold_kind: "captain",
          hold_reason: "needs a decision",
        },
        {
          // Sparse row: missing data must render explicit, never blank.
          id: "sparse",
          state: "weird-state",
        },
      ],
    },
  };
}

/**
 * Orca-sink fixture: validates the card shape the Mac-side step feeds into
 * the Orca UI (project/host/environment placement + read-only markers).
 */
function acceptSinkCards(cards: Array<Record<string, unknown>>): void {
  expect(cards.length).toBeGreaterThan(0);
  for (const card of cards) {
    expect(card["cardKind"]).toBe("fleet-card");
    expect(card["host"]).toBe("local");
    expect(card["environment"]).toBeNull();
    expect(typeof card["project"]).toBe("string");
    expect((card["project"] as string).length).toBeGreaterThan(0);
    expect(typeof card["id"]).toBe("string");
    expect(typeof card["title"]).toBe("string");
    expect(card["readOnly"]).toBe(true);
    expect(card["controls"]).toEqual([]);
  }
}

let dir: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const name of ["FM_FLEET_SNAPSHOT_BIN"] as const) savedEnv[name] = process.env[name];
  delete process.env.FM_FLEET_SNAPSHOT_BIN;
  dir = mkdtempSync(join(tmpdir(), "orca-axi-mirror-test-"));
});

afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("projection", () => {
  it("shapes snapshot rows into Orca-model cards", () => {
    const view = projectSnapshotToMirror(snapshotFixture());
    expect(view.schema).toBe(MIRROR_SCHEMA);
    expect(view.summary).toEqual({ total: 3, inFlight: 1, queued: 1, done: 0 });
    expect(view.source).toMatchObject({
      schema: FLEET_SNAPSHOT_SCHEMA,
      fmHome: "/home/test/.firstmate-axi",
    });
    const [first] = view.cards;
    expect(first).toMatchObject({
      id: "ob-4-orca-axi-mirror",
      state: "in_flight",
      repo: "orca-axi",
      role: "worker",
      readOnly: true,
      controls: [],
      orca: {
        cardKind: "fleet-card",
        host: "local",
        environment: null,
        project: "firstmate/orca-axi",
      },
    });
    expect(first?.prUrl).toBe("https://example.invalid/pr/1");
  });

  it("renders missing data explicit, never blank", () => {
    const view = projectSnapshotToMirror(snapshotFixture());
    const sparse = view.cards.find((card) => card.id === "sparse");
    expect(sparse).toMatchObject({ title: "-", state: "unknown", repo: "-", role: "-" });
    expect(sparse?.orca.project).toBe("firstmate-fleet");
    for (const card of view.cards) {
      for (const field of [card.id, card.title, card.state, card.repo, card.role]) {
        expect(field.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("hides detail by default and shows it with --full", () => {
    const minimal = projectSnapshotToMirror(snapshotFixture(), false);
    expect(minimal.cards[0]).not.toHaveProperty("detail");
    const full = projectSnapshotToMirror(snapshotFixture(), true);
    expect(full.cards[0]?.detail).toMatchObject({
      kind: "ship",
      since: "2026-10-07",
      links: ["https://example.invalid/pr/1"],
      blockedBy: [],
    });
    expect(full.cards[1]?.detail).toMatchObject({
      blockedBy: ["ob-4-orca-axi-mirror"],
      holdKind: "captain",
    });
  });

  it("is pure: never mutates the input and is idempotent", () => {
    const fixture = snapshotFixture();
    Object.freeze(fixture);
    Object.freeze(fixture.backlog);
    Object.freeze(fixture.backlog.records);
    const before = JSON.stringify(fixture);
    const first = projectSnapshotToMirror(fixture);
    const second = projectSnapshotToMirror(JSON.parse(before) as unknown, false);
    expect(JSON.stringify(fixture)).toBe(before);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("marks every card and the view read-only with no controls", () => {
    const view = projectSnapshotToMirror(snapshotFixture(), true);
    expect(view.readOnly).toBe(true);
    expect(view.controls).toEqual([]);
    for (const card of view.cards) {
      expect(card.readOnly).toBe(true);
      expect(card.controls).toEqual([]);
    }
    expect(JSON.stringify(view)).not.toContain("setup-create");
    expect(JSON.stringify(view)).not.toContain("setup-update");
  });

  it("passes the Orca sink fixture", () => {
    const view = projectSnapshotToMirror(snapshotFixture(), true);
    acceptSinkCards(toOrcaSinkCards(view));
  });

  it("refuses a non-snapshot document with a structured error", () => {
    expect(() => projectSnapshotToMirror({ schema: "other.v1" })).toThrow(
      /fm-fleet-snapshot\.v1/,
    );
    expect(() => projectSnapshotToMirror({ schema: FLEET_SNAPSHOT_SCHEMA })).toThrow(
      /backlog\.records/,
    );
    expect(() => projectSnapshotToMirror(null)).toThrow(/snapshot/i);
  });
});

describe("mirror command", () => {
  function fromFile(doc: unknown): string {
    const path = join(dir, "snapshot.json");
    writeFileSync(path, JSON.stringify(doc));
    return path;
  }

  it("prints the contract on --help", async () => {
    const output = await mirrorCommand(["--help"]);
    expect(output).toContain("usage: orca-axi mirror");
    expect(output).toContain("--from");
    expect(output).toContain("--json");
    expect(output).toContain("--full");
    expect(output).toContain("read-only");
  });

  it("renders a --from file as TOON with help lines", async () => {
    const output = await mirrorCommand(["--from", fromFile(snapshotFixture())]);
    expect(output).toContain("ob-4-orca-axi-mirror");
    expect(output).toContain("in_flight");
    expect(output).toContain("help[3]:");
    expect(output).toContain("read-only");
  });

  it("emits the same view as JSON with --json", async () => {
    const output = await mirrorCommand(["--from", fromFile(snapshotFixture()), "--json"]);
    const parsed = JSON.parse(output) as { mirror: MirrorView };
    expect(parsed.mirror.schema).toBe(MIRROR_SCHEMA);
    expect(parsed.mirror.summary.total).toBe(3);
    acceptSinkCards(toOrcaSinkCards(parsed.mirror));
  });

  it("never modifies the --from file", async () => {
    const path = fromFile(snapshotFixture());
    const before = readFileSync(path, "utf8");
    await mirrorCommand(["--from", path]);
    await mirrorCommand(["--from", path, "--json"]);
    await mirrorCommand(["--from", path, "--full"]);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("uses the injected snapshot without touching the filesystem", async () => {
    const output = await mirrorCommand([], {
      loadSnapshot: () => snapshotFixture(),
    });
    expect(output).toContain("ob-4-orca-axi-mirror");
  });

  it("runs the snapshot CLI on the default path (read-only --json)", async () => {
    let seen: string | undefined;
    const output = await mirrorCommand([], {
      runSnapshotBin: (bin: string) => {
        seen = bin;
        return JSON.stringify(snapshotFixture());
      },
    });
    expect(seen).toBe("fm-fleet-snapshot.sh");
    expect(output).toContain("ob-4-orca-axi-mirror");
  });

  it("honours FM_FLEET_SNAPSHOT_BIN and guides when the CLI is missing", async () => {
    process.env.FM_FLEET_SNAPSHOT_BIN = "/nonexistent/fm-fleet-snapshot.sh";
    const first = await mirrorCommand([]).catch((error: unknown) => error);
    expect(String((first as Error).message)).toMatch(/snapshot CLI/);
    expect((first as { suggestions: string[] }).suggestions.join("\n")).toContain("--from");
    await expect(
      mirrorCommand([], {
        runSnapshotBin: () => {
          throw new Error("ENOENT");
        },
      }),
    ).rejects.toThrow(/snapshot CLI/);
  });

  it("exits 2 on unknown flags and names the valid flags", async () => {
    await expect(mirrorCommand(["--bogus"])).rejects.toThrow("unknown flag --bogus");
  });

  it("reports unreadable and unparseable sources as usage errors", async () => {
    await expect(mirrorCommand(["--from", join(dir, "missing.json")])).rejects.toThrow(
      /cannot read snapshot file/,
    );
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{not json");
    await expect(mirrorCommand(["--from", bad])).rejects.toThrow(/not valid JSON/);
  });
});

describe("mirror through main", () => {
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

  it("routes the mirror subcommand and honours --help", async () => {
    const { output, exitCode } = await run(["mirror", "--help"]);
    expect(exitCode).toBe(0);
    expect(output).toContain("usage: orca-axi mirror");
  });

  it("renders --from files end to end with exit 0", async () => {
    const path = join(dir, "snapshot.json");
    writeFileSync(path, JSON.stringify(snapshotFixture()));
    const { output, exitCode } = await run(["mirror", "--from", path, "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output) as { mirror: MirrorView };
    expect(parsed.mirror.summary.total).toBe(3);
  });

  it("exits 2 on an unknown mirror flag", async () => {
    const { output, exitCode } = await run(["mirror", "--bogus"]);
    expect(exitCode).toBe(2);
    expect(output).toContain("unknown flag --bogus");
  });
});
