/**
 * The kinds of External Entity the GitHub plugin reports: a pull request, an
 * issue and the repository they belong to. The tables follow the shape the
 * core renders from (`EntityKindDeclaration`): the plugin reports raw
 * `fields` and a status key, and these tables say how a card shows them.
 * `entity-reads.ts` builds the status keys and reason keys written here.
 */
import type { EntityFieldDeclaration, EntityKindDeclaration } from "@hercule/plugin-host";
import {
  CLOSED_COLOR,
  DONE_COLOR,
  ISSUE_CLOSED_ICON,
  ISSUE_OPEN_ICON,
  MUTED_COLOR,
  OPEN_COLOR,
  PULL_REQUEST_CLOSED_ICON,
  PULL_REQUEST_DRAFT_ICON,
  PULL_REQUEST_MERGED_ICON,
  PULL_REQUEST_OPEN_ICON,
} from "./status-icons";

/** The kinds' words, as the plugin writes them. The host adds the plugin's id. */
export const PULL_REQUEST_KIND = "pull-request";
export const ISSUE_KIND = "issue";
export const REPOSITORY_KIND = "repository";

/**
 * What every state of an open pull request shares. GitHub draws an open pull
 * request with one icon whatever its checks and reviews say, so these states
 * do too, and the status word tells them apart. The shape and tone keep what
 * each state means to Hercule.
 */
const OPEN_PULL_REQUEST = {
  stage: "in-review",
  icon: PULL_REQUEST_OPEN_ICON,
  color: OPEN_COLOR,
} as const;

/**
 * The repository an item belongs to. It holds the ref of the repository's
 * record, so Browse lists the repositories the Connection knows, and a
 * renamed repository changes no item. Both kinds declare it identically.
 */
const REPO_FIELD: EntityFieldDeclaration = {
  key: "repo",
  label: "Repository",
  type: "text",
  facet: { plural: "Repositories", values: REPOSITORY_KIND },
};

const PULL_REQUEST: EntityKindDeclaration = {
  word: PULL_REQUEST_KIND,
  connect: "Reviews people ask of you",
  card: "compact",
  noun: "Pull request",
  plural: "Pull requests",
  lasting: 1,
  refPrefix: "github:pr:",
  pace: "fast",
  patience: 24,
  identifier: "#{number}",
  person: "author",
  owner: "author",
  home: REPOSITORY_KIND,
  status: {
    open: { ...OPEN_PULL_REQUEST, shape: "fork", tone: "quiet", word: "Open", norm: true },
    failing: { ...OPEN_PULL_REQUEST, shape: "cross", tone: "bad", word: "Checks failed" },
    changes: { ...OPEN_PULL_REQUEST, shape: "hold", tone: "attention", word: "Changes requested" },
    approved: { ...OPEN_PULL_REQUEST, shape: "check", tone: "good", word: "Approved" },
    draft: {
      shape: "dashed",
      tone: "quiet",
      word: "Draft",
      stage: "building",
      icon: PULL_REQUEST_DRAFT_ICON,
      color: MUTED_COLOR,
    },
    merged: {
      shape: "join",
      tone: "quiet",
      word: "Merged",
      stage: "landed",
      icon: PULL_REQUEST_MERGED_ICON,
      color: DONE_COLOR,
    },
    closed: {
      shape: "cross",
      tone: "quiet",
      word: "Closed",
      icon: PULL_REQUEST_CLOSED_ICON,
      color: CLOSED_COLOR,
    },
  },
  fields: [
    REPO_FIELD,
    { key: "author", label: "Author", type: "person" },
    {
      key: "checks",
      label: "Checks",
      type: "enum",
      facet: { plural: "Checks" },
      values: [
        { value: "passing", label: "Passing" },
        { value: "failing", label: "Failing" },
        { value: "pending", label: "Pending" },
      ],
    },
    {
      key: "review",
      label: "Review",
      type: "enum",
      values: [
        { value: "approved", label: "Approved" },
        { value: "changes", label: "Changes requested" },
        { value: "required", label: "Review required" },
      ],
    },
  ],
  face: { place: "repo" },
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
  plural: "Issues",
  lasting: 1,
  refPrefix: "github:issue:",
  pace: "slow",
  patience: 336,
  identifier: "#{number}",
  person: "assignee",
  owner: "assignee",
  home: REPOSITORY_KIND,
  status: {
    open: {
      shape: "ring",
      tone: "quiet",
      word: "Open",
      norm: true,
      icon: ISSUE_OPEN_ICON,
      color: OPEN_COLOR,
    },
    closed: {
      shape: "check",
      tone: "good",
      word: "Closed",
      icon: ISSUE_CLOSED_ICON,
      color: DONE_COLOR,
    },
  },
  fields: [
    REPO_FIELD,
    { key: "assignee", label: "Assignee", type: "person" },
    { key: "labels", label: "Labels", type: "text" },
  ],
  face: { place: "repo" },
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
