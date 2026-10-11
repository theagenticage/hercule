/**
 * Builds the events the `issues` feed emits. Every kind has the same envelope:
 * the issue's short id and title, the issue's and the project's refs, and the
 * issue's link. Nothing here reads Sentry.
 */
import { MAX_EVENT_TITLE_LENGTH, type EmittedEvent } from "@hercule/plugin-host";
import type { IssueBlock } from "../kinds";
import type { SentryOrganization } from "../organization";
import { cutText } from "../text";

/** The `system` of every event this plugin emits. */
export const SENTRY_SYSTEM = "sentry";

/** What one event is built from. */
export interface IssueEventInput {
  /** The kind without the plugin's prefix: `entered`, `regressed`, `escalating`, `resolved`, `archived` or `left`. */
  readonly kind: "entered" | "regressed" | "escalating" | "resolved" | "archived" | "left";
  readonly organization: Pick<SentryOrganization, "id" | "slug">;
  readonly issue: IssueBlock;
  /** The payload fields the kind has beside `org` and `issue`. */
  readonly fields: Readonly<Record<string, unknown>>;
  readonly dedupKey: string;
  /** A time in any form `Date` parses. An unreadable time becomes `fallbackTime`. */
  readonly occurredAt: string;
  /** An ISO time that stands in for an `occurredAt` that cannot be read. */
  readonly fallbackTime: string;
}

/** Returns the time as an ISO string with a zone, which the host requires, or `fallback` when it is not a time. */
export const normalizeTimestamp = (time: string, fallback: string): string => {
  const millis = Date.parse(time);
  return Number.isNaN(millis) ? fallback : new Date(millis).toISOString();
};

/** Builds the event of one kind about one issue. */
export const buildIssueEvent = (input: IssueEventInput): EmittedEvent => {
  const { organization, issue } = input;
  return {
    kind: `sentry.issue.${input.kind}`,
    dedupKey: input.dedupKey,
    occurredAt: normalizeTimestamp(input.occurredAt, input.fallbackTime),
    refs: [
      `sentry:issue:${organization.id}/${issue.id}`,
      `sentry:project:${organization.id}/${issue.project.id}`,
    ],
    url: issue.permalink,
    system: SENTRY_SYSTEM,
    title: cutText(`${issue.shortId} ${issue.title}`, MAX_EVENT_TITLE_LENGTH),
    author: null,
    payload: {
      org: { id: organization.id, slug: organization.slug },
      issue,
      ...input.fields,
    },
  };
};
