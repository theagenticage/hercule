/**
 * The kinds of External Entity the Linear plugin reports: an issue, and the
 * places an issue sits in (a project, a milestone, a team, an initiative).
 * The tables follow the shape the core renders from (`EntityKindDeclaration`):
 * the plugin reports raw `fields` and a status key, and these tables say how
 * a card shows them. `entity-reads.ts` builds the status keys written here.
 */
import type { EntityKindDeclaration } from "@hercule/plugin-host";
import {
  BACKLOG_ICON,
  CANCELED_ICON,
  DONE_COLOR,
  DONE_ICON,
  REVIEW_COLOR,
  REVIEW_ICON,
  STARTED_COLOR,
  STARTED_ICON,
  TODO_ICON,
} from "./status-icons";

/** The kinds' words, as the plugin writes them. The host adds the plugin's id. */
export const ISSUE_KIND = "issue";
export const PROJECT_KIND = "project";
export const MILESTONE_KIND = "milestone";
export const TEAM_KIND = "team";
export const INITIATIVE_KIND = "initiative";

/**
 * The status of an issue, by the state it is in. Linear's state types are
 * `triage`, `backlog`, `unstarted`, `started`, `completed` and `canceled`.
 * `review` is a `started` state that the team named "In Review": Linear has no
 * state type for it. `duplicate` is a state type the plugin treats like
 * `canceled`, in case a workspace has one.
 */
const ISSUE: EntityKindDeclaration = {
  word: ISSUE_KIND,
  connect: "Tickets, with their projects and milestones",
  card: "rich",
  noun: "Issue",
  refPrefix: "linear:issue:",
  pace: "slow",
  patience: 336,
  identifier: "{key}",
  person: "assignee",
  owner: "assignee",
  home: PROJECT_KIND,
  section: MILESTONE_KIND,
  status: {
    triage: {
      shape: "dashed",
      tone: "quiet",
      word: "Triage",
      norm: true,
      stage: "exploring",
      icon: BACKLOG_ICON,
    },
    backlog: {
      shape: "dashed",
      tone: "quiet",
      word: "Backlog",
      stage: "exploring",
      icon: BACKLOG_ICON,
    },
    todo: { shape: "ring", tone: "quiet", word: "Todo", stage: "planned", icon: TODO_ICON },
    started: {
      shape: "half",
      tone: "active",
      word: "In Progress",
      stage: "building",
      icon: STARTED_ICON,
      color: STARTED_COLOR,
    },
    review: {
      shape: "most",
      tone: "active",
      word: "In Review",
      stage: "in-review",
      icon: REVIEW_ICON,
      color: REVIEW_COLOR,
    },
    done: {
      shape: "check",
      tone: "good",
      word: "Done",
      stage: "landed",
      icon: DONE_ICON,
      color: DONE_COLOR,
    },
    canceled: { shape: "cross", tone: "quiet", word: "Canceled", icon: CANCELED_ICON },
    duplicate: { shape: "cross", tone: "quiet", word: "Duplicate", icon: CANCELED_ICON },
  },
  facts: [
    { field: "priority", form: "bars" },
    { field: "milestone", form: "word" },
    { field: "archived", form: "word" },
  ],
  // The keys are the words of the plugin's signal kinds (`mention`, `assigned`)
  // and the timeline's `moved`, so a card reads a signal or a change in the
  // plugin's own words.
  reasons: {
    assigned: { say: "Assigned to you", tone: "plain" },
    mention: { say: "{person} mentioned you", tone: "plain" },
    moved: { say: "Moved to {value}", tone: "plain" },
  },
};

/** Project and initiative health, as Linear reports it. */
const HEALTH_STATUS: NonNullable<EntityKindDeclaration["status"]> = {
  "on-track": { shape: "check", tone: "good", word: "On track" },
  "at-risk": { shape: "hold", tone: "attention", word: "At risk" },
  "off-track": { shape: "cross", tone: "bad", word: "Off track" },
};

/**
 * A place that issues belong to. It has no card, no clock and no person, and
 * its reasons are empty because nothing about a place concerns the user.
 */
const buildPlace = (
  word: string,
  noun: string,
  options: {
    readonly caption?: string;
    readonly status: EntityKindDeclaration["status"];
  },
): EntityKindDeclaration => ({
  word,
  noun,
  refPrefix: `linear:${word}:`,
  pace: "context",
  patience: 0,
  identifier: "{name}",
  person: null,
  owner: null,
  ...(options.caption === undefined ? {} : { groupable: { caption: options.caption } }),
  status: options.status,
  facts: [],
  reasons: {},
});

export const LINEAR_ENTITY_KINDS: ReadonlyArray<EntityKindDeclaration> = [
  ISSUE,
  buildPlace(PROJECT_KIND, "Project", { caption: "Linear project", status: HEALTH_STATUS }),
  buildPlace(MILESTONE_KIND, "Milestone", { status: null }),
  buildPlace(TEAM_KIND, "Team", { caption: "Linear team", status: null }),
  buildPlace(INITIATIVE_KIND, "Initiative", {
    caption: "Linear initiative",
    status: HEALTH_STATUS,
  }),
];
