/**
 * What every GitHub event says about the thing it is about: the `subject`
 * block of its payload, its External Refs, and the web URL a person opens.
 *
 * A repository is always written as `owner/repo` in lowercase, in the subject
 * and in the refs. GitHub treats repository names case-insensitively, and a
 * repo Resource's canonical remote is lowercase too, so one repository has
 * one spelling everywhere: a filter on `subject.repo` and a `task.query` on a
 * ref both match whatever case GitHub reported.
 */
import type { EmittedEvent } from "@hercule/plugin-host";
import type { Schema } from "effect";
import type { GithubSubject } from "./kinds";

/** The root of every web URL this plugin builds. */
const GITHUB_WEB_URL = "https://github.com";

/** An issue or a pull request inside one repository. */
export interface GithubItem {
  /** `owner/repo`, in any case; it is lowercased wherever it is written. */
  readonly repo: string;
  readonly kind: "issue" | "pr";
  readonly number: number;
  readonly title?: string;
  /** The login of the account that opened it. */
  readonly author?: string;
  /** GitHub's own word, such as `open` or `closed`. */
  readonly state?: string;
}

/** Returns the web URL of a repository. */
export const buildRepoUrl = (repo: string): string => `${GITHUB_WEB_URL}/${repo.toLowerCase()}`;

/**
 * Returns the web URL of an issue or a pull request. GitHub's web paths say
 * `issues` for one and `pull`, singular, for the other.
 */
export const buildItemUrl = (item: GithubItem): string =>
  `${buildRepoUrl(item.repo)}/${item.kind === "pr" ? "pull" : "issues"}/${String(item.number)}`;

/** Returns the External Ref of a repository, such as `github:repo:owner/repo`. */
export const buildRepoRef = (repo: string): string => `github:repo:${repo.toLowerCase()}`;

/**
 * Returns the External Refs of an issue or a pull request: its own, such as
 * `github:issue:owner/repo#42` or `github:pr:owner/repo#87`, then its
 * repository's, so a filter can match either.
 */
export const buildItemRefs = (item: GithubItem): ReadonlyArray<string> => [
  `github:${item.kind}:${item.repo.toLowerCase()}#${String(item.number)}`,
  buildRepoRef(item.repo),
];

/** Returns the `subject` block of an event about an issue or a pull request. */
export const buildItemSubject = (item: GithubItem): GithubSubject => ({
  repo: item.repo.toLowerCase(),
  number: item.number,
  ...(item.title === undefined ? {} : { title: item.title }),
  ...(item.author === undefined ? {} : { author: item.author }),
  ...(item.state === undefined ? {} : { state: item.state }),
  url: buildItemUrl(item),
});

/**
 * Returns the `subject` block of an event about a repository as a whole, or
 * about something inside it this plugin has no ref for, such as a release.
 */
export const buildRepoSubject = (repo: string, title?: string): GithubSubject => ({
  repo: repo.toLowerCase(),
  ...(title === undefined ? {} : { title }),
  url: buildRepoUrl(repo),
});

/** What a feed knows about one event before the subject, refs and URL are added. */
export interface ItemEventFacts {
  readonly kind: string;
  readonly dedupKey: string;
  readonly occurredAt: string;
  /** The payload's fields beside `subject`, such as `added` and `removed` for a label kind. */
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly raw: Schema.JsonObject;
}

/**
 * Builds the event a feed emits about an issue or a pull request: the payload
 * is the item's subject block plus the kind's own fields, and the refs and
 * URL are the item's.
 */
export const buildItemEvent = (item: GithubItem, facts: ItemEventFacts): EmittedEvent => {
  const subject = buildItemSubject(item);
  return {
    kind: facts.kind,
    dedupKey: facts.dedupKey,
    occurredAt: facts.occurredAt,
    payload: { subject, ...facts.fields },
    refs: buildItemRefs(item),
    url: subject.url,
    raw: facts.raw,
  };
};
