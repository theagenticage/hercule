/**
 * PROTOTYPE, throwaway. The Inbox's own state, in memory:
 *
 * - **Splits are the user's.** Each is a saved query with a name. The app
 *   seeds a few on first use; the user saves any search as a split, renames,
 *   reorders and deletes them. In real code they are a per-user record on the
 *   controller, like a saved view.
 * - **Pins**: facet values the user keeps in the rail, such as one Linear
 *   project.
 * - **Bundles are the user's grouping.** "These belong together", said by a
 *   person. In spec 20's terms each bundle is a set of `person` Relation
 *   Claims between its things, so a bundle survives a reload and Hercule's
 *   triage can learn from it.
 * - **Suggestions and Proposals are triage's.** A suggestion is a bundle
 *   Hercule thinks of (accept it, or say they are not related). A Proposal is a
 *   Task an agent prepared (Accept makes the Task; starting it is separate).
 * - The start-thread dialog's open state.
 */
import { useSyncExternalStore } from "react";
import type { Origin } from "./context";
import { EMPTY_QUERY, type Clause, type Query } from "./fields";
import type { KindId, Thing, World } from "./world";

export interface Split {
  readonly id: string;
  readonly name: string;
  readonly query: Query;
  /** The seeded "With Hercule" split shows only things that have a Task. */
  readonly withTask?: boolean;
}

export interface Pin {
  readonly id: string;
  readonly facetId: string;
  readonly value: string;
  /** The account, when the source has several. */
  readonly connection?: string | undefined;
}

export interface Bundle {
  readonly id: string;
  readonly name: string;
  readonly ids: readonly string[];
}

export interface Suggestion {
  readonly id: string;
  readonly why: string;
  readonly ids: readonly string[];
}

export interface Proposal {
  readonly id: string;
  readonly title: string;
  readonly why: string;
  readonly ids: readonly string[];
  readonly agent: string;
}

export interface ThreadDraft {
  readonly ids: readonly string[];
  readonly title: string;
  /** Where the things came from: the user's bundle, a Proposal, or a plain selection. */
  readonly origin?: Origin | undefined;
}

interface InboxState {
  readonly splits: readonly Split[];
  readonly pins: readonly Pin[];
  readonly bundles: readonly Bundle[];
  readonly suggestions: readonly Suggestion[];
  readonly proposals: readonly Proposal[];
  readonly draft: ThreadDraft | null;
}

const q = (kinds: readonly KindId[], clauses: readonly Clause[]): Query => ({
  kinds,
  clauses,
  text: "",
});

const SEEDED_SPLITS: readonly Split[] = [
  { id: "important", name: "Important", query: q([], [{ key: "waits", op: "is", value: true }]) },
  {
    id: "reviews",
    name: "Reviews",
    query: q(["github/pull-request"], [{ key: "review", op: "is", value: "Requested from me" }]),
  },
  {
    id: "errors",
    name: "Errors",
    query: q(["sentry/issue", "pagerduty/incident"], [{ key: "move", op: "is", value: "Mine" }]),
  },
  {
    id: "customers",
    name: "Customers",
    query: q(["intercom/conversation", "gmail/thread"], [{ key: "move", op: "is", value: "Mine" }]),
  },
  {
    id: "chat",
    name: "Team chat",
    query: q(["slack/thread", "discord/thread"], [{ key: "move", op: "is", value: "Mine" }]),
  },
  { id: "updates", name: "Updates", query: q([], [{ key: "move", op: "is", value: "Nobody's" }]) },
  { id: "hercule", name: "With Hercule", query: EMPTY_QUERY, withTask: true },
  { id: "all", name: "Everything", query: EMPTY_QUERY },
];

let state: InboxState = {
  splits: SEEDED_SPLITS,
  pins: [],
  bundles: [],
  suggestions: [],
  proposals: [],
  draft: null,
};
const listeners = new Set<() => void>();
const emit = (next: Partial<InboxState>): void => {
  state = { ...state, ...next };
  for (const l of listeners) l();
};
let counter = 0;
const newId = (prefix: string): string => `${prefix}-${String(++counter)}`;

export function useInbox(): InboxState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/** Starts the Inbox state over for a world: seeded splits, no bundles, and what triage made of the world. */
export function resetInbox(world: World): void {
  state = {
    splits: SEEDED_SPLITS,
    pins: [],
    bundles: [],
    suggestions: buildSuggestions(world),
    proposals: buildProposals(world),
    draft: null,
  };
  for (const l of listeners) l();
}

// Splits

export function saveSplit(name: string, query: Query): string {
  const id = newId("split");
  emit({ splits: [...state.splits, { id, name, query }] });
  return id;
}

export function renameSplit(id: string, name: string): void {
  emit({ splits: state.splits.map((s) => (s.id === id ? { ...s, name } : s)) });
}

export function deleteSplit(id: string): void {
  emit({ splits: state.splits.filter((s) => s.id !== id) });
}

export function moveSplit(id: string, before: string): void {
  if (id === before) return;
  const moving = state.splits.find((s) => s.id === id)!;
  const rest = state.splits.filter((s) => s.id !== id);
  const at = rest.findIndex((s) => s.id === before);
  emit({ splits: [...rest.slice(0, at), moving, ...rest.slice(at)] });
}

// Pins

export function togglePin(facetId: string, value: string, connection?: string): void {
  const has = state.pins.find(
    (p) => p.facetId === facetId && p.value === value && p.connection === connection,
  );
  emit({
    pins: has
      ? state.pins.filter((p) => p !== has)
      : [...state.pins, { id: newId("pin"), facetId, value, connection }],
  });
}

// Bundles

/** Makes a bundle of some things, or adds them to the bundle one of them is already in. Returns the bundle's id. */
export function bundleTogether(ids: readonly string[], name: string): string {
  const existing = state.bundles.find((b) => b.ids.some((id) => ids.includes(id)));
  const others = state.bundles
    .map((b) => (b === existing ? b : { ...b, ids: b.ids.filter((id) => !ids.includes(id)) }))
    .filter((b) => b.ids.length > 1 || b === existing);
  if (existing) {
    emit({
      bundles: others.map((b) =>
        b === existing ? { ...b, ids: [...new Set([...b.ids, ...ids])] } : b,
      ),
    });
    return existing.id;
  }
  const id = newId("bundle");
  emit({ bundles: [...others, { id, name, ids: [...new Set(ids)] }] });
  return id;
}

export function addToBundle(bundleId: string, id: string): void {
  emit({
    bundles: state.bundles
      .map((b) =>
        b.id === bundleId
          ? { ...b, ids: [...new Set([...b.ids, id])] }
          : { ...b, ids: b.ids.filter((x) => x !== id) },
      )
      .filter((b) => b.ids.length > 1),
  });
}

export function removeFromBundle(bundleId: string, id: string): void {
  emit({
    bundles: state.bundles
      .map((b) => (b.id === bundleId ? { ...b, ids: b.ids.filter((x) => x !== id) } : b))
      .filter((b) => b.ids.length > 1),
  });
}

export function renameBundle(bundleId: string, name: string): void {
  emit({ bundles: state.bundles.map((b) => (b.id === bundleId ? { ...b, name } : b)) });
}

export function ungroup(bundleId: string): void {
  emit({ bundles: state.bundles.filter((b) => b.id !== bundleId) });
}

// Triage

export function acceptSuggestion(id: string, name: string): void {
  const s = state.suggestions.find((x) => x.id === id);
  if (!s) return;
  emit({ suggestions: state.suggestions.filter((x) => x.id !== id) });
  bundleTogether(s.ids, name);
}

export function dismissSuggestion(id: string): void {
  emit({ suggestions: state.suggestions.filter((x) => x.id !== id) });
}

export function settleProposal(id: string): void {
  emit({ proposals: state.proposals.filter((x) => x.id !== id) });
}

// The start-thread dialog

export function openDraft(draft: ThreadDraft | null): void {
  emit({ draft });
}

/**
 * Builds what triage would suggest: things that share a phrase of three words
 * across sources, and are not already tied by a source. A real triage agent
 * reads far more; this only has to look plausible.
 */
function buildSuggestions(world: World): Suggestion[] {
  const loose = world.things.filter(
    (t) => t.subject === undefined && !t.settled && t.turn !== "none",
  );
  const STOP = new Set([
    "the",
    "and",
    "for",
    "can",
    "you",
    "who",
    "this",
    "that",
    "with",
    "any",
    "take",
    "look",
    "safe",
    "drop",
    "these",
    "days",
    "week",
    "quick",
    "sanity",
    "check",
    "objection",
    "merging",
    "today",
    "owns",
    "before",
  ]);
  const index = new Map<string, Thing[]>();
  for (const t of loose) {
    const words = t.title
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w));
    for (let i = 0; i + 2 < words.length; i++) {
      const key = words.slice(i, i + 3).join(" ");
      index.set(key, [...(index.get(key) ?? []), t]);
    }
  }
  const used = new Set<string>();
  const out: Suggestion[] = [];
  const groups = [...index.entries()]
    .map(([phrase, things]) => [phrase, [...new Set(things)]] as const)
    .filter(
      ([, things]) =>
        things.length >= 2 && things.length <= 6 && new Set(things.map((t) => t.source)).size >= 2,
    )
    .sort(
      (a, b) =>
        new Set(b[1].map((t) => t.source)).size - new Set(a[1].map((t) => t.source)).size ||
        b[1].length - a[1].length,
    );
  for (const [phrase, things] of groups) {
    const fresh = things.filter((t) => !used.has(t.id));
    if (fresh.length < 2) continue;
    for (const t of fresh) used.add(t.id);
    const sources = [
      ...new Set(fresh.map((t) => world.sources.find((s) => s.id === t.source)!.name)),
    ];
    out.push({
      id: newId("suggestion"),
      why: `All about “${phrase}”, in ${sources.join(" and ")}`,
      ids: fresh.map((t) => t.id),
    });
    if (out.length >= 4) break;
  }
  return out;
}

/** Builds two Proposals, as a triage agent would prepare them from what it read. */
function buildProposals(world: World): Proposal[] {
  const out: Proposal[] = [];
  const datadog = world.subjects.find((s) => s.title === "Datadog renewal");
  if (datadog) {
    out.push({
      id: newId("proposal"),
      title: "Decide on the Datadog renewal before the quote expires",
      why: "The quote waits on your reply for 4 days, the call already passed, and Hanna has not answered about APM.",
      ids: datadog.things.map((t) => t.id),
      agent: "Triager",
    });
  }
  const chunk = world.things.find((t) => t.title.startsWith("ChunkLoadError"));
  const related = world.things
    .filter((t) => t.kind.id === "slack/thread" && t.place.name === "#frontend" && t.turn === "you")
    .slice(0, 1);
  if (chunk) {
    out.push({
      id: newId("proposal"),
      title: "Stop ChunkLoadError on storefront-web",
      why: "140 events today and 1,204 users; it began with the last deploy, and nobody has it.",
      ids: [chunk.id, ...related.map((t) => t.id)],
      agent: "Triager",
    });
  }
  return out;
}
