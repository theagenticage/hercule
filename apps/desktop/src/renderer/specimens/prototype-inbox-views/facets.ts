/**
 * PROTOTYPE, throwaway. Browsing without knowing names: the facets a plugin
 * declares, so the Inbox's rail can list a source's own structure (Linear's
 * projects and teams, Sentry's teams, Gmail's accounts and labels) with
 * counts, and a click filters by it.
 *
 * A facet names one of the fields of fields.ts and the source it browses.
 * The core knows nothing else about it:
 *
 * - the values come from the things themselves, with their counts;
 * - a facet may also list the places the source knows of, such as every Linear
 *   project, so a project with nothing of yours in it is still there to open
 *   (spec 20 keeps places as context records, so the core already holds them);
 * - a facet may describe a value in a few words, such as a project's health
 *   and target, which the rail shows beside it.
 *
 * Clicking a value adds the same clause the search bar would, so the two never
 * disagree.
 */
import { countValues, findField, type Clause, type Field } from "./fields";
import type { SourceId, Thing, World } from "./world";

export interface Facet {
  readonly id: string;
  readonly source: SourceId;
  /** The field it browses, from fields.ts. */
  readonly field: string;
  /** What the rail calls the list, plural: "Projects", "Teams". */
  readonly label: string;
  /** Every value the source knows of, even with nothing in it. */
  readonly known?: (world: World) => readonly string[];
  /** A few words beside a value, such as "at risk · target in 9d". */
  readonly describe?: (
    value: string,
    world: World,
  ) => { readonly note: string; readonly tone?: "good" | "warn" | "bad" } | undefined;
}

const HEALTH_TONE = { "on track": "good", "at risk": "warn", "off track": "bad" } as const;

export const FACETS: readonly Facet[] = [
  {
    id: "linear-project",
    source: "linear",
    field: "project",
    label: "Projects",
    known: (w) => w.projects.map((p) => p.name),
    describe: (value, w) => {
      const p = w.projects.find((x) => x.name === value);
      return p ? { note: p.health, tone: HEALTH_TONE[p.health] } : undefined;
    },
  },
  { id: "linear-team", source: "linear", field: "team", label: "Teams" },
  { id: "linear-status", source: "linear", field: "status", label: "Statuses" },
  { id: "github-repo", source: "github", field: "repo", label: "Repositories" },
  { id: "github-checks", source: "github", field: "checks", label: "Checks" },
  { id: "sentry-team", source: "sentry", field: "team", label: "Teams" },
  { id: "sentry-project", source: "sentry", field: "project-sentry", label: "Projects" },
  { id: "sentry-level", source: "sentry", field: "level", label: "Levels" },
  { id: "gmail-label", source: "gmail", field: "gmail-label", label: "Labels" },
  { id: "slack-channel", source: "slack", field: "channel", label: "Channels" },
  { id: "discord-channel", source: "discord", field: "channel", label: "Servers and channels" },
  { id: "intercom-company", source: "intercom", field: "company", label: "Companies" },
  { id: "pagerduty-service", source: "pagerduty", field: "service", label: "Services" },
];

/**
 * Lists a facet's values: those its things have, with counts, then the known
 * ones with none, then "No ..." last. With `connection`, only that account's
 * things count: a source with several accounts browses each on its own, so
 * one team name in two Sentry orgs stays two values.
 */
export function listFacetValues(
  facet: Facet,
  things: readonly Thing[],
  world: World,
  connection?: string,
): { value: string; n: number }[] {
  const field = findField(facet.field) as Field;
  const ofSource = things.filter(
    (t) => t.source === facet.source && (connection === undefined || t.connection === connection),
  );
  const counted = countValues(field, ofSource, world).map(([value, n]) => ({ value, n }));
  const seen = new Set(counted.map((c) => c.value));
  const known =
    connection === undefined || facet.source !== "linear"
      ? (facet.known?.(world) ?? []).filter((v) => !seen.has(v)).map((value) => ({ value, n: 0 }))
      : [];
  // "No project" and the like are a fact, not a place to browse: they go last.
  const isNone = (v: string): boolean => v.startsWith("No ");
  return [
    ...counted.filter((c) => !isNone(c.value)),
    ...known,
    ...counted.filter((c) => isNone(c.value)),
  ];
}

/** Returns the clauses that select one value of a facet: its source, the account when one is given, and the value. */
export function buildFacetClauses(
  facet: Facet,
  value: string,
  world: World,
  connection?: string,
): Clause[] {
  const source = world.sources.find((s) => s.id === facet.source)!;
  const account =
    connection === undefined
      ? undefined
      : source.connections.find((c) => c.id === connection)?.label;
  return [
    { key: "source", op: "is", value: source.name },
    ...(account === undefined ? [] : [{ key: "account", op: "is" as const, value: account }]),
    { key: facet.field, op: "is", value },
  ];
}

/** Lists the accounts of a source that hold any of `things`, so Browse adds an account level only when there are several. */
export function listAccounts(
  source: SourceId,
  things: readonly Thing[],
  world: World,
): { id: string; label: string; n: number }[] {
  const src = world.sources.find((s) => s.id === source)!;
  return src.connections
    .map((c) => ({
      id: c.id,
      label: c.label,
      n: things.filter((t) => t.connection === c.id).length,
    }))
    .filter((c) => c.n > 0);
}
