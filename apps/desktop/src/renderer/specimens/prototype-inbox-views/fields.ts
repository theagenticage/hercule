/**
 * PROTOTYPE, throwaway. The second plugin hook: the fields a plugin declares
 * for its kinds, so the core can search, filter, group and sort by what the
 * source knows (a Sentry issue's team, level and events; a pull request's
 * checks and size) without naming a plugin anywhere.
 *
 * A field has a key, a label, a type and a reader. The core owns the fields
 * every thing has (source, whose move, waiting, opened, person, place); a
 * plugin adds the rest. The Inbox's search tokens (`team:checkout
 * events:>1000`) and the Dashboard's filter controls are both drawn from this
 * one list, and `runQuery` is the one place that applies them.
 */
import type { KindId, Thing, World } from "./world";

export type FieldType = "enum" | "number" | "age" | "bool";

export interface Field {
  readonly key: string;
  readonly label: string;
  readonly type: FieldType;
  /** The kinds the field belongs to; empty for a core field every thing has. */
  readonly kinds: readonly KindId[];
  /** Who declares it: "core", or the plugin's name. */
  readonly owner: string;
  readonly read: (t: Thing, world: World) => string | number | boolean | undefined;
}

const SENTRY_TEAM: Record<string, string> = {
  "checkout-api": "Checkout",
  "storefront-web": "Storefront",
  "finance-worker": "Finance",
  "mobile-ios": "Mobile",
  "mobile-android": "Mobile",
  "search-api": "Search",
  "media-worker": "Platform",
  "catalog-service": "Catalog",
  "payouts-worker": "Finance",
  // The open source org has a Platform team too, so one team name lives in two accounts.
  "ferrule-cli": "Platform",
  "ferrule-registry": "Registry",
};

/** Picks a stable release for an error from its id, as Sentry would report the release it first appeared in. */
function readRelease(t: Thing): string {
  const n = [...t.id].reduce((h, c) => h + c.charCodeAt(0), 0);
  return `2026.${String(9 + (n % 2))}.${String(n % 9)}`;
}

const PR: readonly KindId[] = ["github/pull-request"];
const LINEAR: readonly KindId[] = ["linear/issue"];
const SENTRY: readonly KindId[] = ["sentry/issue"];
const MAIL: readonly KindId[] = ["gmail/thread"];
const CHAT: readonly KindId[] = ["slack/thread", "discord/thread"];
const SUPPORT: readonly KindId[] = ["intercom/conversation"];
const INCIDENT: readonly KindId[] = ["pagerduty/incident"];

export const FIELDS: readonly Field[] = [
  // The core's fields: every thing has them.
  {
    key: "source",
    label: "Source",
    type: "enum",
    kinds: [],
    owner: "core",
    read: (t, w) => w.sources.find((s) => s.id === t.source)!.name,
  },
  { key: "type", label: "Type", type: "enum", kinds: [], owner: "core", read: (t) => t.kind.noun },
  {
    key: "move",
    label: "Whose move",
    type: "enum",
    kinds: [],
    owner: "core",
    read: (t) => (t.turn === "you" ? "Mine" : t.turn === "them" ? "Someone else's" : "Nobody's"),
  },
  {
    key: "waits",
    label: "Someone waits on me",
    type: "bool",
    kinds: [],
    owner: "core",
    read: (t) => t.asksYou && t.turn === "you" && !t.settled,
  },
  {
    key: "waiting",
    label: "Waiting",
    type: "age",
    kinds: [],
    owner: "core",
    read: (t) => t.waitMin,
  },
  {
    key: "opened",
    label: "Opened",
    type: "age",
    kinds: [],
    owner: "core",
    read: (t) => t.openedMin,
  },
  {
    key: "from",
    label: "Person",
    type: "enum",
    kinds: [],
    owner: "core",
    read: (t) => t.face.sender ?? t.face.company ?? t.person,
  },
  {
    key: "place",
    label: "Place",
    type: "enum",
    kinds: [],
    owner: "core",
    read: (t) => t.place.name,
  },
  {
    key: "new",
    label: "New since I looked",
    type: "bool",
    kinds: [],
    owner: "core",
    read: (t) => t.isNew,
  },
  {
    key: "linked",
    label: "Part of a subject",
    type: "bool",
    kinds: [],
    owner: "core",
    read: (t) => t.subject !== undefined,
  },
  {
    key: "account",
    label: "Account",
    type: "enum",
    kinds: [],
    owner: "core",
    read: (t, w) =>
      w.sources.flatMap((s) => s.connections).find((c) => c.id === t.connection)?.label,
  },
  // Across sources: the core knows what is tied to what, so it can ask questions no single source can.
  {
    key: "my-pr",
    label: "Tied to my open pull request",
    type: "bool",
    kinds: [],
    owner: "core",
    read: (t, w) =>
      t.links.some((id) => {
        const o = w.byId.get(id);
        return (
          o !== undefined && o.kind.id === "github/pull-request" && o.person === "You" && !o.settled
        );
      }),
  },
  {
    key: "ticket",
    label: "Tied to a ticket",
    type: "bool",
    kinds: [],
    owner: "core",
    read: (t, w) => t.links.some((id) => w.byId.get(id)?.kind.id === "linear/issue"),
  },

  // Linear
  {
    key: "status",
    label: "Status",
    type: "enum",
    kinds: LINEAR,
    owner: "Linear",
    read: (t) => t.stage,
  },
  {
    key: "priority",
    label: "Priority",
    type: "enum",
    kinds: LINEAR,
    owner: "Linear",
    read: (t) => ["No priority", "Urgent", "High", "Medium", "Low"][t.face.priority ?? 0],
  },
  {
    key: "assignee",
    label: "Assignee",
    type: "enum",
    kinds: LINEAR,
    owner: "Linear",
    read: (t) => t.face.assignee,
  },
  {
    key: "team",
    label: "Team",
    type: "enum",
    kinds: [...LINEAR, ...SENTRY],
    owner: "Linear, Sentry",
    read: (t) => (t.kind.id === "sentry/issue" ? SENTRY_TEAM[t.place.name] : t.place.name),
  },
  {
    key: "project",
    label: "Project",
    type: "enum",
    kinds: LINEAR,
    owner: "Linear",
    read: (t, w) => w.projects.find((p) => p.id === t.projectId)?.name ?? "No project",
  },
  {
    key: "label",
    label: "Label",
    type: "enum",
    kinds: LINEAR,
    owner: "Linear",
    read: (t) => t.face.labels?.[0],
  },

  // GitHub
  {
    key: "repo",
    label: "Repository",
    type: "enum",
    kinds: PR,
    owner: "GitHub",
    read: (t) => t.place.name,
  },
  { key: "state", label: "State", type: "enum", kinds: PR, owner: "GitHub", read: (t) => t.stage },
  {
    key: "checks",
    label: "Checks",
    type: "enum",
    kinds: PR,
    owner: "GitHub",
    read: (t) =>
      t.face.checks
        ? t.face.checks.failed > 0
          ? "Failing"
          : t.face.checks.pending > 0
            ? "Running"
            : "Passing"
        : undefined,
  },
  {
    key: "review",
    label: "Review",
    type: "enum",
    kinds: PR,
    owner: "GitHub",
    read: (t) =>
      t.flags.includes("Changes requested")
        ? "Changes requested"
        : t.stage === "Approved"
          ? "Approved"
          : t.person === "You"
            ? "Waiting on reviewers"
            : "Requested from me",
  },
  {
    key: "author",
    label: "Author",
    type: "enum",
    kinds: PR,
    owner: "GitHub",
    read: (t) => t.person,
  },
  {
    key: "size",
    label: "Lines changed",
    type: "number",
    kinds: PR,
    owner: "GitHub",
    read: (t) => (t.face.diff ? t.face.diff.add + t.face.diff.del : undefined),
  },

  // Sentry
  {
    key: "level",
    label: "Level",
    type: "enum",
    kinds: SENTRY,
    owner: "Sentry",
    read: (t) => t.face.level,
  },
  {
    key: "issue",
    label: "Issue state",
    type: "enum",
    kinds: SENTRY,
    owner: "Sentry",
    read: (t) => t.stage,
  },
  {
    key: "events",
    label: "Events",
    type: "number",
    kinds: SENTRY,
    owner: "Sentry",
    read: (t) => t.face.events,
  },
  {
    key: "users",
    label: "Users affected",
    type: "number",
    kinds: SENTRY,
    owner: "Sentry",
    read: (t) => t.face.users,
  },
  {
    key: "release",
    label: "First release",
    type: "enum",
    kinds: SENTRY,
    owner: "Sentry",
    read: readRelease,
  },
  {
    key: "project-sentry",
    label: "Sentry project",
    type: "enum",
    kinds: SENTRY,
    owner: "Sentry",
    read: (t) => t.place.name,
  },

  // Gmail
  {
    key: "unread",
    label: "Unread",
    type: "bool",
    kinds: MAIL,
    owner: "Gmail",
    read: (t) => t.face.unread ?? false,
  },
  {
    key: "attachment",
    label: "Has attachment",
    type: "bool",
    kinds: MAIL,
    owner: "Gmail",
    read: (t) => (t.face.attachments ?? 0) > 0,
  },
  {
    key: "gmail-label",
    label: "Gmail label",
    type: "enum",
    kinds: MAIL,
    owner: "Gmail",
    read: (t) => t.place.name,
  },

  // Slack and Discord
  {
    key: "channel",
    label: "Channel",
    type: "enum",
    kinds: CHAT,
    owner: "Slack, Discord",
    read: (t) => t.place.name,
  },
  {
    key: "replies",
    label: "Replies",
    type: "number",
    kinds: CHAT,
    owner: "Slack, Discord",
    read: (t) => t.face.replies,
  },

  // Intercom
  {
    key: "company",
    label: "Company",
    type: "enum",
    kinds: SUPPORT,
    owner: "Intercom",
    read: (t) => t.face.company,
  },
  {
    key: "plan",
    label: "Plan",
    type: "enum",
    kinds: SUPPORT,
    owner: "Intercom",
    read: (t) => t.face.plan,
  },

  // PagerDuty
  {
    key: "urgency",
    label: "Urgency",
    type: "enum",
    kinds: INCIDENT,
    owner: "PagerDuty",
    read: (t) => t.face.urgency,
  },
  {
    key: "service",
    label: "Service",
    type: "enum",
    kinds: INCIDENT,
    owner: "PagerDuty",
    read: (t) => t.place.name,
  },
];

export interface Clause {
  readonly key: string;
  readonly op: "is" | "not" | "gt" | "lt";
  readonly value: string | number | boolean;
}

export interface Query {
  /** Kinds to look in; empty for all. */
  readonly kinds: readonly KindId[];
  readonly clauses: readonly Clause[];
  /** Free text, matched against title, person and place. */
  readonly text: string;
}

export const EMPTY_QUERY: Query = { kinds: [], clauses: [], text: "" };

/** Returns the fields that apply to every kind in `kinds`, the core's first. */
export function listFields(kinds: readonly KindId[]): Field[] {
  return FIELDS.filter(
    (f) => f.kinds.length === 0 || (kinds.length > 0 && kinds.every((k) => f.kinds.includes(k))),
  );
}

export function findField(key: string): Field | undefined {
  return FIELDS.find((f) => f.key === key);
}

/** Checks whether a thing passes one clause. A field the thing's kind does not have fails the clause. */
function passes(t: Thing, c: Clause, world: World): boolean {
  const field = findField(c.key);
  if (!field || (field.kinds.length > 0 && !field.kinds.includes(t.kind.id))) return false;
  const v = field.read(t, world);
  if (v === undefined) return c.op === "not";
  switch (c.op) {
    case "is":
      return typeof v === "string" && typeof c.value === "string"
        ? v.toLowerCase() === c.value.toLowerCase()
        : v === c.value;
    case "not":
      return typeof v === "string" && typeof c.value === "string"
        ? v.toLowerCase() !== c.value.toLowerCase()
        : v !== c.value;
    case "gt":
      return typeof v === "number" && v > Number(c.value);
    case "lt":
      return typeof v === "number" && v < Number(c.value);
  }
}

/**
 * Returns the things that match a query: in its kinds, passing every clause
 * (clauses on one field are alternatives, on different fields all apply), and
 * containing its text.
 */
export function runQuery(things: readonly Thing[], query: Query, world: World): Thing[] {
  const byField = new Map<string, Clause[]>();
  for (const c of query.clauses) byField.set(c.key, [...(byField.get(c.key) ?? []), c]);
  const text = query.text.trim().toLowerCase();
  return things.filter((t) => {
    if (query.kinds.length > 0 && !query.kinds.includes(t.kind.id)) return false;
    for (const clauses of byField.values()) {
      const positive = clauses.filter((c) => c.op === "is");
      const rest = clauses.filter((c) => c.op !== "is");
      if (positive.length > 0 && !positive.some((c) => passes(t, c, world))) return false;
      if (!rest.every((c) => passes(t, c, world))) return false;
    }
    if (
      text &&
      !`${t.title} ${t.person} ${t.place.name} ${t.identifier}`.toLowerCase().includes(text)
    )
      return false;
    return true;
  });
}

/** Counts the values an enum or bool field takes over some things, most common first. */
export function countValues(
  field: Field,
  things: readonly Thing[],
  world: World,
): [string, number][] {
  const counts = new Map<string, number>();
  for (const t of things) {
    if (field.kinds.length > 0 && !field.kinds.includes(t.kind.id)) continue;
    const v = field.read(t, world);
    if (v === undefined) continue;
    const key = typeof v === "boolean" ? (v ? "Yes" : "No") : String(v);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/** Parses an age such as "2h", "3d" or "1w" into minutes. */
export function parseAge(text: string): number | undefined {
  const m = text.match(/^(\d+(?:\.\d+)?)\s*(m|h|d|w)$/);
  if (!m) return undefined;
  return (
    parseFloat(m[1]!) * { m: 1, h: 60, d: 24 * 60, w: 7 * 24 * 60 }[m[2] as "m" | "h" | "d" | "w"]
  );
}

/** Says a clause in words, for a chip: "Team is Checkout", "Events over 1,000", "Waiting over 1d". */
export function describeClause(c: Clause): string {
  const field = findField(c.key);
  const label = field?.label ?? c.key;
  const value =
    typeof c.value === "number" && field?.type === "age"
      ? formatAgeValue(c.value)
      : typeof c.value === "number"
        ? c.value.toLocaleString("en")
        : String(c.value);
  if (field?.type === "bool")
    return c.value === true || c.value === "Yes" ? label : `Not ${label.toLowerCase()}`;
  return `${label} ${c.op === "is" ? "is" : c.op === "not" ? "is not" : c.op === "gt" ? "over" : "under"} ${value}`;
}

function formatAgeValue(min: number): string {
  if (min >= 7 * 24 * 60 && min % (7 * 24 * 60) === 0) return `${String(min / (7 * 24 * 60))}w`;
  if (min >= 24 * 60) return `${String(Math.round(min / (24 * 60)))}d`;
  if (min >= 60) return `${String(Math.round(min / 60))}h`;
  return `${String(min)}m`;
}
