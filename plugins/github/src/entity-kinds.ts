/**
 * The kinds of External Entity the GitHub plugin reports: a pull request, an
 * issue and the repository they belong to. The tables follow the shape the
 * core renders from (`EntityKindDeclaration`): the plugin reports raw
 * `fields` and a status key, and these tables say how a card shows them.
 * `ingest/entities.ts` reports the status keys and reason keys written here.
 */
import type { EntityKindDeclaration } from "@hercule/plugin-host";

/** The kinds' words, as the plugin writes them. The host adds the plugin's id. */
export const PULL_REQUEST_KIND = "pull-request";
export const ISSUE_KIND = "issue";
export const REPOSITORY_KIND = "repository";

const PULL_REQUEST: EntityKindDeclaration = {
  word: PULL_REQUEST_KIND,
  connect: "Reviews people ask of you",
  card: "compact",
  noun: "Pull request",
  refPrefix: "github:pr:",
  pace: "fast",
  patience: 24,
  identifier: "#{number}",
  person: "author",
  owner: "author",
  home: REPOSITORY_KIND,
  status: {
    open: { shape: "fork", tone: "quiet", word: "Open", norm: true, stage: "in-review" },
    failing: { shape: "cross", tone: "bad", word: "Checks failed", stage: "in-review" },
    changes: { shape: "hold", tone: "attention", word: "Changes requested", stage: "in-review" },
    approved: { shape: "check", tone: "good", word: "Approved", stage: "in-review" },
    draft: { shape: "dashed", tone: "quiet", word: "Draft", stage: "building" },
    merged: { shape: "join", tone: "quiet", word: "Merged", stage: "landed" },
    closed: { shape: "cross", tone: "quiet", word: "Closed" },
  },
  facts: [
    { field: "diff", form: "delta" },
    { field: "files", form: "count", unit: "file" },
  ],
  reasons: {
    "review-requested": { say: "{person} asked for your review", tone: "plain" },
    opened: { say: "You opened it", tone: "plain" },
    "checks-failed": { say: "Checks failed", tone: "bad" },
    "changes-requested": { say: "Changes requested", tone: "attention" },
    approved: { say: "Approved, ready to merge", tone: "good" },
    waiting: { say: "With reviewers", tone: "plain" },
    merged: { say: "Merged", tone: "plain" },
  },
};

const ISSUE: EntityKindDeclaration = {
  word: ISSUE_KIND,
  connect: "Issues assigned to you",
  card: "rich",
  noun: "Issue",
  refPrefix: "github:issue:",
  pace: "slow",
  patience: 336,
  identifier: "#{number}",
  person: "assignee",
  owner: "assignee",
  home: REPOSITORY_KIND,
  status: {
    open: { shape: "ring", tone: "quiet", word: "Open", norm: true },
    closed: { shape: "check", tone: "good", word: "Closed" },
  },
  facts: [{ field: "labels", form: "word" }],
  reasons: {
    assigned: { say: "Assigned to you", tone: "plain" },
  },
};

/** A repository is a place that things belong to, so it has no card, no status and no clock. */
const REPOSITORY: EntityKindDeclaration = {
  word: REPOSITORY_KIND,
  noun: "Repository",
  refPrefix: "github:repo:",
  pace: "context",
  patience: 0,
  identifier: "{name}",
  person: null,
  owner: null,
  groupable: { caption: "GitHub repository" },
  status: null,
  facts: [],
  reasons: {},
};

export const GITHUB_ENTITY_KINDS: ReadonlyArray<EntityKindDeclaration> = [
  PULL_REQUEST,
  ISSUE,
  REPOSITORY,
];
