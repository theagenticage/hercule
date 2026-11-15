/**
 * The kind of External Entity the Sentry plugin reports: an issue, which the
 * Inbox calls an Error. The tables follow the shape the core renders from
 * (`EntityKindDeclaration`): the plugin reports raw `fields` and a status key,
 * and these tables say how a card shows them. `entity-reads.ts` builds the
 * status keys and reason keys written here.
 */
import type {
  EntityFieldDeclaration,
  EntityKindDeclaration,
  SavedQuery,
} from "@hercule/plugin-host";
import { NEW_ICON, REGRESSED_ICON, SENTRY_HUE } from "./status-icons";

/** The kind's word, as the plugin writes it. The host adds the plugin's id. */
export const ISSUE_KIND = "issue";

/** The levels Sentry gives an issue, most severe first. `entity-reads.ts` reports `level` only when it is one of these. */
export const SEVERITY_VALUES = [
  { value: "fatal", label: "fatal" },
  { value: "error", label: "error" },
  { value: "warning", label: "warning" },
  { value: "info", label: "info" },
  { value: "debug", label: "debug" },
] as const;

/**
 * The fields of an issue. `team` and `project` hold names, not refs, because
 * Sentry's teams and projects are not kinds of this plugin.
 */
const ISSUE_FIELDS: ReadonlyArray<EntityFieldDeclaration> = [
  { key: "team", label: "Team", type: "text", facet: { plural: "Teams" } },
  { key: "project", label: "Project", type: "text", facet: { plural: "Projects" } },
  {
    key: "severity",
    label: "Severity",
    type: "enum",
    values: [...SEVERITY_VALUES],
    facet: { plural: "Severities" },
  },
  { key: "events", label: "Events", type: "number" },
  { key: "users", label: "Users", type: "number" },
  { key: "firstSeen", label: "First seen", type: "age" },
  { key: "lastSeen", label: "Last seen", type: "age" },
  { key: "assignee", label: "Assignee", type: "person" },
];

const ISSUE: EntityKindDeclaration = {
  word: ISSUE_KIND,
  connect: "Errors assigned to you or your teams",
  card: "rich",
  noun: "Error",
  plural: "Errors",
  lasting: 2,
  refPrefix: "sentry:issue:",
  pace: "fast",
  patience: 24,
  identifier: "{shortId}",
  person: "assignee",
  owner: "assignee",
  status: {
    new: { shape: "alert", tone: "active", word: "New", icon: NEW_ICON, hue: SENTRY_HUE },
    escalating: { shape: "alert", tone: "bad", word: "Escalating" },
    ongoing: { shape: "alert", tone: "quiet", word: "Ongoing" },
    // No colour: an icon with no colour is drawn in its status's tone.
    regressed: { shape: "alert", tone: "bad", word: "Regressed", icon: REGRESSED_ICON },
    resolved: { shape: "check", tone: "good", word: "Resolved" },
    archived: { shape: "hold", tone: "quiet", word: "Archived" },
  },
  fields: [...ISSUE_FIELDS],
  face: { place: "project", fact: "events" },
  facts: [],
  // `assigned` and `team-assigned` are reasons the plugin's entity feed gives.
  // `issue`, `regressed` and `escalating` are the words of the plugin's Signal
  // kinds, so a card reads a Signal in the plugin's own words. `{team}` is
  // filled from the observation's `team` field, which is the assigning team
  // when a team holds the issue.
  reasons: {
    assigned: { say: "Assigned to you", tone: "plain" },
    "team-assigned": { say: "Assigned to {team}", tone: "plain" },
    issue: { say: "New", tone: "plain" },
    regressed: { say: "Came back after it was resolved", tone: "bad" },
    escalating: { say: "Escalating", tone: "bad" },
  },
};

export const SENTRY_ENTITY_KINDS: ReadonlyArray<EntityKindDeclaration> = [ISSUE];

export const SENTRY_SAVED_QUERIES: ReadonlyArray<SavedQuery> = [
  {
    word: "errors-on-me",
    name: "Errors on me",
    order: "waiting",
    clauses: [
      { key: "kind", op: "is", value: ISSUE_KIND },
      { key: "mine", op: "is", value: true },
    ],
  },
];
