/**
 * `mirror`: read-only projection of Firstmate fleet state into Orca UI cards.
 *
 * This module is deliberately pure: it imports nothing that can touch the
 * filesystem, spawn processes, or reach the network. It shapes an already
 * observed `fm-fleet-snapshot.v1` document (the kind of data
 * `fm-fleet-snapshot.sh --json` / `fm-fleet-view.sh --json` expose on the
 * Firstmate side) into Orca-model cards, and nothing else.
 *
 * Orca model alignment (from the installed Orca CLI's own docs):
 * - `orca project list --json` lists durable projects known to Orca;
 *   `orca project setups --json` lists project host setups (project
 *   available on a host at a concrete path);
 * - `orca host list --json` lists targetable machines (`local`, SSH
 *   targets, paired servers selected with `--environment <name>`);
 * - `orca environment list --json` lists saved remote Orca runtimes.
 * There is no `orca card` command: a "card" here is a read-only view-model
 * row carrying its Orca placement (`orca.host` / `orca.environment` /
 * `orca.project`) so the Orca desktop UI (Mac) can render one card per
 * Firstmate task without any control-plane binding.
 *
 * Read-only guarantees (enforced by tests in `test/mirror.test.ts`):
 * - the input snapshot is never mutated;
 * - every card and the top-level view carry `readOnly: true` and an empty
 *   `controls: []` (there is no mutation verb to call);
 * - the projection never invokes an Orca mutating command
 *   (`project setup-*`, `terminal *`, `orchestration *`, ...) and never
 *   writes Firstmate state: rendering is the only effect, which lives in
 *   `src/commands/mirror.ts`, not here.
 *
 * Orca-runtime end-to-end rendering (whether a card actually paints inside
 * the real Orca app) can only be verified on the Mac where the Orca desktop
 * UI runs. This module is the unit-testable half: data shaping, card
 * schema, and read-only guarantees, with fixtures standing in for both the
 * Firstmate source and the Orca sink.
 */

import { AxiError } from "axi-sdk-js";

/** Schema id stamped on every mirror view this module produces. */
export const MIRROR_SCHEMA = "orca-axi-mirror.v1";

/** The only Firstmate snapshot schema this projection accepts. */
export const FLEET_SNAPSHOT_SCHEMA = "fm-fleet-snapshot.v1";

/** Orca placement for one card. `local` names this machine's runtime. */
export interface MirrorOrcaPlacement {
  /** Card kind for the Orca UI; always `fleet-card`. */
  cardKind: "fleet-card";
  /** Orca host selector; always `local` (snapshot is observed here). */
  host: "local";
  /** Paired-server environment id; null (no remote routing). */
  environment: null;
  /** Durable-project hint, derived from the Firstmate repo when known. */
  project: string;
}

export interface MirrorCard {
  id: string;
  title: string;
  /** `in_flight` | `queued` | `done` | `unknown` (never blank). */
  state: string;
  /** Task repo, or `-` when the snapshot does not carry one. */
  repo: string;
  /** Current worker role, or `-` when unknown. */
  role: string;
  /** PR URL, or null when the snapshot carries none. */
  prUrl: string | null;
  /** Hard read-only marker: always true. */
  readOnly: true;
  /** Control-plane verbs this card exposes: always empty. */
  controls: [];
  /** Orca project/host/environment placement (render hint only). */
  orca: MirrorOrcaPlacement;
  /** Full-schema extras; present only with `--full`. */
  detail?: {
    kind: string;
    since: string;
    links: string[];
    blockedBy: string[];
    holdKind: string | null;
    holdReason: string | null;
  };
}

export interface MirrorView {
  schema: typeof MIRROR_SCHEMA;
  source: {
    schema: typeof FLEET_SNAPSHOT_SCHEMA;
    generated: string;
    fmHome: string;
  };
  summary: {
    total: number;
    inFlight: number;
    queued: number;
    done: number;
  };
  cards: MirrorCard[];
  /** Hard read-only marker: always true. */
  readOnly: true;
  /** Control-plane verbs this view exposes: always empty. */
  controls: [];
  note: string;
}

interface BacklogRecord {
  id?: unknown;
  title?: unknown;
  state?: unknown;
  kind?: unknown;
  repo?: unknown;
  current_role?: unknown;
  since?: unknown;
  pr_url?: unknown;
  links?: unknown;
  blocked_by_ids?: unknown;
  hold_kind?: unknown;
  hold_reason?: unknown;
}

function text(value: unknown, fallback = "-"): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed === "" ? fallback : trimmed;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry !== "");
}

function stateOf(value: unknown): string {
  return value === "in_flight" || value === "queued" || value === "done"
    ? value
    : "unknown";
}

function prUrlOf(record: BacklogRecord): string | null {
  if (typeof record.pr_url === "string" && record.pr_url.trim() !== "") {
    return record.pr_url.trim();
  }
  const links = stringArray(record.links);
  return links.length > 0 ? (links[0] ?? null) : null;
}

/**
 * Project an `fm-fleet-snapshot.v1` document into an `orca-axi-mirror.v1`
 * view. Pure: never mutates `snapshot`, never touches I/O. Throws an
 * `AxiError` (VALIDATION_ERROR) when the document is not a snapshot.
 */
export function projectSnapshotToMirror(snapshot: unknown, full = false): MirrorView {
  if (typeof snapshot !== "object" || snapshot === null) {
    throw new AxiError("mirror needs an fm-fleet-snapshot.v1 document, got none", "VALIDATION_ERROR", [
      "Pass a snapshot file: orca-axi mirror --from <path-to-snapshot.json>",
      "Or capture one on the Firstmate side: fm-fleet-snapshot.sh --json > snapshot.json",
    ]);
  }
  const doc = snapshot as Record<string, unknown>;
  if (doc["schema"] !== FLEET_SNAPSHOT_SCHEMA) {
    throw new AxiError(
      `mirror needs schema ${FLEET_SNAPSHOT_SCHEMA}, got ${text(doc["schema"], "none")}`,
      "VALIDATION_ERROR",
      [
        "The source must be fm-fleet-snapshot.sh --json output (schema fm-fleet-snapshot.v1)",
        "Pass the right file: orca-axi mirror --from <snapshot.json>",
      ],
    );
  }
  const backlog = doc["backlog"];
  const records: unknown =
    typeof backlog === "object" && backlog !== null
      ? (backlog as Record<string, unknown>)["records"]
      : undefined;
  if (!Array.isArray(records)) {
    throw new AxiError("snapshot has no backlog.records[] to project", "VALIDATION_ERROR", [
      "The source must be fm-fleet-snapshot.sh --json output (schema fm-fleet-snapshot.v1)",
      "Re-capture the snapshot and retry with --from <snapshot.json>",
    ]);
  }

  const cards: MirrorCard[] = (records as BacklogRecord[])
    .filter((record) => typeof record === "object" && record !== null)
    .map((record) => {
      const id = text(record.id, "");
      const repo = text(record.repo, "-");
      const card: MirrorCard = {
        id: id === "" ? "-" : id,
        title: text(record.title, "-"),
        state: stateOf(record.state),
        repo,
        role: text(record.current_role, "-"),
        prUrl: prUrlOf(record),
        readOnly: true,
        controls: [],
        orca: {
          cardKind: "fleet-card",
          host: "local",
          environment: null,
          project: repo === "-" ? "firstmate-fleet" : `firstmate/${repo}`,
        },
      };
      if (full) {
        card.detail = {
          kind: text(record.kind, "-"),
          since: text(record.since, "-"),
          links: stringArray(record.links),
          blockedBy: stringArray(record.blocked_by_ids),
          holdKind: typeof record.hold_kind === "string" ? record.hold_kind : null,
          holdReason: typeof record.hold_reason === "string" ? record.hold_reason : null,
        };
      }
      return card;
    });

  let inFlight = 0;
  let queued = 0;
  let done = 0;
  for (const card of cards) {
    if (card.state === "in_flight") inFlight += 1;
    else if (card.state === "queued") queued += 1;
    else if (card.state === "done") done += 1;
  }

  return {
    schema: MIRROR_SCHEMA,
    source: {
      schema: FLEET_SNAPSHOT_SCHEMA,
      generated: text(doc["generated"], "-"),
      fmHome: text(doc["fm_home"], "-"),
    },
    summary: { total: cards.length, inFlight, queued, done },
    cards,
    readOnly: true,
    controls: [],
    note: "Read-only projection of Firstmate fleet state for the Orca UI; not a control plane. Orca-runtime rendering is verified separately on the Mac.",
  };
}

/**
 * Shape a mirror view's cards for an Orca card sink (the Mac-side step that
 * feeds rendered cards into the Orca UI). Pure pass-through that keeps the
 * Orca placement up front; the sink fixture in tests validates this shape.
 */
export function toOrcaSinkCards(view: MirrorView): Array<Record<string, unknown>> {
  return view.cards.map((card) => ({
    project: card.orca.project,
    host: card.orca.host,
    environment: card.orca.environment,
    cardKind: card.orca.cardKind,
    id: card.id,
    title: card.title,
    state: card.state,
    repo: card.repo,
    role: card.role,
    prUrl: card.prUrl,
    readOnly: card.readOnly,
    controls: card.controls,
    ...(card.detail ? { detail: card.detail } : {}),
  }));
}
