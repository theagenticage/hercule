/**
 * Test support for this plugin:
 *
 * - a fake Linear: an `HttpClient` layer that serves one in-memory workspace
 *   over GraphQL, which a test changes between polls the way Linear's users
 *   do (move an issue, assign it, mark a notification done). It routes each
 *   request by its operation name, evaluates the parts of Linear's filters the
 *   plugin sends, and records every request it received;
 * - an ingest context that keeps its state in memory and records every event
 *   emitted, after checking it as the host would.
 *
 * Every value is invented: the workspace `Acme`, the team `ENG`, the users
 * Ada and Grace.
 */
import { Effect, Layer, Option, type Result, Schema } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import {
  checkEmittedEvent,
  PluginError,
  type EmittedEvent,
  type IngestContext,
  type KeyValueStore,
  type OpenSignal,
} from "@hercule/plugin-host";
import { LINEAR_EVENT_KINDS } from "./kinds";
import type { ApiIssue, ApiNotification } from "./linear-objects";

/** The personal API key every test's Connection holds. */
export const TEST_API_KEY = "lin_api_0123456789abcdef-invented";

/** The workspace of the test Connection. */
export const TEST_ORGANIZATION = { id: "org-acme", name: "Acme", urlKey: "acme" };

/** The user of the test Connection: Ada, the account the key belongs to. */
export const TEST_USER = { id: "user-ada", name: "Ada Lovelace" };

/** Another member of the workspace, who mentions and assigns Ada. */
export const OTHER_USER = { id: "user-grace", name: "Grace Hopper" };

/** One request the fake received: the GraphQL operation and what it was sent with. */
interface FakeRequest {
  readonly operationName: string;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly authorization: string | undefined;
}

/** One response the fake returns instead of answering, set through `override`. */
export interface StubResponse {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

/** A team of the fake workspace. */
interface FakeTeam {
  id: string;
  key: string;
  name: string;
}

/** A project of the fake workspace, and the teams it is shared with. */
interface FakeProject {
  id: string;
  name: string;
  url: string;
  teamIds: Array<string>;
}

/** A milestone of a project. */
interface FakeMilestone {
  id: string;
  name: string;
  projectId: string;
}

/** A label: the workspace's when `teamId` is null, or a team's. */
interface FakeLabel {
  id: string;
  name: string;
  isGroup: boolean;
  parentName: string | null;
  teamId: string | null;
}

/** An issue as the fake holds it: what the issue fragment selects, which a test edits in place. */
export type FakeIssue = { -readonly [K in keyof ApiIssue]: ApiIssue[K] };

/**
 * A notification as the fake holds it. It names its issue by id, so a
 * notification shows the issue as it is when the inbox is read.
 */
interface FakeNotification {
  id: string;
  type: string;
  category: string;
  createdAt: string;
  archivedAt: string | null;
  title: string;
  url: string;
  actor: { id: string; name: string } | null;
  issueId?: string;
  comment?: ApiNotification["comment"];
}

/**
 * The fake workspace and the knobs a test turns. The test changes it between
 * polls, and the fake answers from it as it is at each request.
 */
export interface FakeWorld {
  apiKey: string;
  organization: typeof TEST_ORGANIZATION;
  viewer: typeof TEST_USER;
  users: Array<{ id: string; name: string }>;
  teams: Array<FakeTeam>;
  projects: Array<FakeProject>;
  milestones: Array<FakeMilestone>;
  labels: Array<FakeLabel>;
  issues: Array<FakeIssue>;
  notifications: Array<FakeNotification>;
  /** The most items the fake puts on one page of a paged list, at most the `first` asked for. */
  pageSize: number;
  /**
   * Answers a request instead of the fake, when it returns a response. Use
   * it to refuse a request: a rate limit, a 401, a 500.
   */
  override: ((request: FakeRequest) => StubResponse | undefined) | undefined;
}

/** The fake's layer, the world it serves, and every request it received, in order. */
export interface FakeLinear {
  readonly layer: Layer.Layer<HttpClient.HttpClient>;
  readonly world: FakeWorld;
  readonly requests: Array<FakeRequest>;
}

/** Returns a timestamp `minutes` after now (or before, when negative), in the form Linear sends. */
export const stampAt = (minutes: number): string =>
  new Date(Date.now() + minutes * 60_000).toISOString();

/** The workflow states of the team `ENG`, by type. */
export const FAKE_STATES = {
  triage: { id: "state-triage", name: "Triage", type: "triage" },
  backlog: { id: "state-backlog", name: "Backlog", type: "backlog" },
  unstarted: { id: "state-todo", name: "Todo", type: "unstarted" },
  started: { id: "state-doing", name: "In Progress", type: "started" },
  completed: { id: "state-done", name: "Done", type: "completed" },
  canceled: { id: "state-canceled", name: "Canceled", type: "canceled" },
} as const;

/** Builds an issue of the team `ENG`, assigned to Ada, with the values a test does not care about filled in. */
export const buildFakeIssue = (number: number, overrides: Partial<FakeIssue> = {}): FakeIssue => ({
  id: `issue-${String(number)}`,
  identifier: `ENG-${String(number)}`,
  title: `Checkout button does nothing on Safari (${String(number)})`,
  url: `https://linear.app/acme/issue/ENG-${String(number)}`,
  description: "Pressing the button logs a TypeError and the order is not placed.",
  priority: 3,
  priorityLabel: "Medium",
  dueDate: null,
  estimate: null,
  createdAt: stampAt(-600),
  updatedAt: stampAt(-60),
  completedAt: null,
  canceledAt: null,
  archivedAt: null,
  trashed: null,
  state: { ...FAKE_STATES.unstarted },
  assignee: { ...TEST_USER },
  creator: { ...OTHER_USER },
  labels: { nodes: [] },
  project: null,
  projectMilestone: null,
  team: { id: "team-eng", key: "ENG", name: "Engineering" },
  ...overrides,
});

/** Builds a notification from Grace, created now, with the values a test does not care about filled in. */
export const buildFakeNotification = (
  id: string,
  overrides: Partial<FakeNotification> = {},
): FakeNotification => ({
  id,
  type: "issueNewComment",
  category: "commentsAndReplies",
  createdAt: stampAt(0),
  archivedAt: null,
  title: "Grace Hopper commented on an issue",
  url: `https://linear.app/acme/inbox/${id}`,
  actor: { ...OTHER_USER },
  ...overrides,
});

/** Builds a workspace with Ada and Grace, two teams, a project with a milestone, and labels. */
export const buildFakeWorld = (issues: Array<FakeIssue> = []): FakeWorld => ({
  apiKey: TEST_API_KEY,
  organization: TEST_ORGANIZATION,
  viewer: TEST_USER,
  users: [{ ...TEST_USER }, { ...OTHER_USER }],
  teams: [
    { id: "team-eng", key: "ENG", name: "Engineering" },
    { id: "team-ops", key: "OPS", name: "Operations" },
  ],
  projects: [
    {
      id: "project-checkout",
      name: "Checkout revamp",
      url: "https://linear.app/acme/project/checkout-revamp",
      teamIds: ["team-eng"],
    },
    {
      id: "project-oncall",
      name: "On-call tooling",
      url: "https://linear.app/acme/project/on-call-tooling",
      teamIds: ["team-ops"],
    },
  ],
  milestones: [{ id: "milestone-beta", name: "Beta", projectId: "project-checkout" }],
  labels: [
    { id: "label-bug", name: "Bug", isGroup: false, parentName: null, teamId: null },
    { id: "label-area", name: "Area", isGroup: true, parentName: null, teamId: "team-eng" },
    { id: "label-web", name: "Web", isGroup: false, parentName: "Area", teamId: "team-eng" },
    { id: "label-infra", name: "Infra", isGroup: false, parentName: null, teamId: "team-ops" },
  ],
  issues,
  notifications: [],
  pageSize: 250,
  override: undefined,
});

/** Reads the JSON body of a request. Returns undefined when it has none. */
const readRequestBody = (request: HttpClientRequest.HttpClientRequest): unknown =>
  request.body._tag === "Uint8Array"
    ? JSON.parse(new TextDecoder().decode(request.body.body))
    : undefined;

/** Reads a request as the fake records it. */
const readFakeRequest = (request: HttpClientRequest.HttpClientRequest): FakeRequest => {
  const body = (readRequestBody(request) ?? {}) as {
    operationName?: string;
    variables?: Record<string, unknown>;
  };
  return {
    operationName: body.operationName ?? "",
    variables: body.variables ?? {},
    authorization: request.headers["authorization"],
  };
};

/** Converts a `StubResponse` into the response the client returns for `request`. */
const buildResponse = (
  request: HttpClientRequest.HttpClientRequest,
  response: StubResponse,
): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(
    request,
    new Response(response.body === undefined ? null : JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json", ...response.headers },
    }),
  );

/**
 * Builds a stub client that answers each request with what `route` returns
 * for it, and records the requests. Use it for a test that needs one or two
 * fixed answers; use `buildFakeLinear` for a whole workspace.
 */
export const stubLinear = (
  route: (request: FakeRequest) => StubResponse,
): { layer: Layer.Layer<HttpClient.HttpClient>; requests: Array<FakeRequest> } => {
  const requests: Array<FakeRequest> = [];
  const client = HttpClient.make((request) => {
    const read = readFakeRequest(request);
    requests.push(read);
    return Effect.succeed(buildResponse(request, route(read)));
  });
  return { layer: Layer.succeed(HttpClient.HttpClient, client), requests };
};

/**
 * Runs an effect that calls Linear against a stub or fake client, and returns
 * its result: the value it succeeded with, or the error it failed with.
 */
export const runAgainstStub = <A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient>,
  stub: { readonly layer: Layer.Layer<HttpClient.HttpClient> },
): Promise<Result.Result<A, E>> =>
  Effect.runPromise(Effect.result(effect).pipe(Effect.provide(stub.layer)));

/**
 * Checks a value against an `IDComparator` or a `StringComparator`, the
 * subset the plugin sends: `eq`, `neq`, `in`, `nin`. Throws for anything
 * else, so a test fails when the plugin sends a filter the fake cannot judge.
 */
const matchComparator = (value: string | null, comparator: Record<string, unknown>): boolean =>
  Object.entries(comparator).every(([operator, operand]) => {
    switch (operator) {
      case "eq":
        return value === operand;
      case "neq":
        return value !== operand;
      case "in":
        return value !== null && (operand as Array<string>).includes(value);
      case "nin":
        return value === null || !(operand as Array<string>).includes(value);
      default:
        throw new Error(`The fake Linear does not support the comparator "${operator}".`);
    }
  });

/** Checks a nullable relation (`assignee`, `project`, `projectMilestone`) against its filter. */
const matchRelation = (
  related: { readonly id: string } | null,
  filter: Record<string, unknown>,
  viewerId: string,
): boolean =>
  Object.entries(filter).every(([key, operand]) => {
    switch (key) {
      case "null":
        return (related === null) === operand;
      case "isMe":
        return matchComparator(related?.id === viewerId ? "true" : "false", {
          eq: String((operand as { eq: boolean }).eq),
        });
      case "id":
        return matchComparator(related?.id ?? null, operand as Record<string, unknown>);
      default:
        throw new Error(`The fake Linear does not support the relation filter "${key}".`);
    }
  });

/**
 * Checks an issue against an `IssueFilter`, the subset the plugin sends.
 * Throws for any other key, so a test fails when the plugin sends a filter
 * the fake cannot judge.
 */
const matchIssue = (issue: FakeIssue, filter: Record<string, unknown>, viewerId: string): boolean =>
  Object.entries(filter).every(([key, operand]) => {
    const sub = operand as Record<string, unknown>;
    switch (key) {
      case "and":
        return (operand as Array<Record<string, unknown>>).every((part) =>
          matchIssue(issue, part, viewerId),
        );
      case "or":
        return (operand as Array<Record<string, unknown>>).some((part) =>
          matchIssue(issue, part, viewerId),
        );
      case "id":
        return matchComparator(issue.id, sub);
      case "team":
        return matchRelation(issue.team, sub, viewerId);
      case "assignee":
        return matchRelation(issue.assignee, sub, viewerId);
      case "project":
        return matchRelation(issue.project, sub, viewerId);
      case "projectMilestone":
        return matchRelation(issue.projectMilestone, sub, viewerId);
      case "state":
        return matchComparator(issue.state.type, sub["type"] as Record<string, unknown>);
      case "labels": {
        const some = sub["some"] as { id: Record<string, unknown> };
        return issue.labels.nodes.some((label) => matchComparator(label.id, some.id));
      }
      default:
        throw new Error(`The fake Linear does not support the issue filter "${key}".`);
    }
  });

/**
 * Checks a label against an `IssueLabelFilter`, the subset the plugin sends:
 * `isGroup: { eq }`, and `team` as an `or` of `id: { in }` and `null`.
 * Throws for any other key, so a test fails when the plugin sends a filter
 * the fake cannot judge.
 */
const matchLabel = (label: FakeLabel, filter: Record<string, unknown>): boolean =>
  Object.entries(filter).every(([key, operand]) => {
    switch (key) {
      case "isGroup":
        return label.isGroup === (operand as { eq: boolean }).eq;
      case "team":
        return (operand as { or: Array<Record<string, unknown>> }).or.some((part) =>
          matchRelation(label.teamId === null ? null : { id: label.teamId }, part, ""),
        );
      default:
        throw new Error(`The fake Linear does not support the label filter "${key}".`);
    }
  });

/** Returns the `{ id: { in } }` filter's ids, or undefined when the filter has none. */
const readIdIn = (filter: unknown): ReadonlyArray<string> | undefined =>
  (filter as { id?: { in?: Array<string> } } | null | undefined)?.id?.in;

/**
 * Returns one page of `items` for `first` and `after`, as a GraphQL
 * connection. The cursor is the index of the next item.
 */
const buildPage = <A>(
  items: ReadonlyArray<A>,
  variables: Readonly<Record<string, unknown>>,
  pageSize: number,
) => {
  const start = typeof variables["after"] === "string" ? Number(variables["after"]) : 0;
  const first = typeof variables["first"] === "number" ? variables["first"] : 50;
  const end = Math.min(items.length, start + Math.min(first, pageSize));
  return {
    nodes: items.slice(start, end),
    pageInfo: {
      hasNextPage: end < items.length,
      endCursor: end < items.length ? String(end) : null,
    },
  };
};

/** Returns a notification as the API returns it, with its issue as it is now. */
const answerNotification = (world: FakeWorld, notification: FakeNotification) => {
  const { issueId, comment, ...fields } = notification;
  if (issueId === undefined) return fields;
  const issue = world.issues.find((candidate) => candidate.id === issueId);
  return { ...fields, ...(issue === undefined ? {} : { issue }), comment: comment ?? null };
};

/** Returns the `data` the fake answers an operation with, from the world as it is now. */
const answerOperation = (world: FakeWorld, request: FakeRequest): unknown => {
  const { variables } = request;
  const viewerFields = { viewer: { id: world.viewer.id }, organization: world.organization };
  const filter = (variables["filter"] ?? null) as Record<string, unknown> | null;
  const pick = <A extends { readonly id: string }>(items: ReadonlyArray<A>, ids: unknown) => ({
    nodes: items
      .filter((item) => (ids as Array<string>).includes(item.id))
      .map(({ id }) => ({ id })),
  });
  switch (request.operationName) {
    case "LinearViewer":
      return {
        viewer: { ...world.viewer, displayName: "ada" },
        organization: { id: world.organization.id, name: world.organization.name },
      };
    case "LinearConfigCheck":
      return {
        ...viewerFields,
        teams: pick(world.teams, variables["teams"]),
        projects: pick(world.projects, variables["projects"]),
        projectMilestones: pick(world.milestones, variables["milestones"]),
        issueLabels: pick(world.labels, variables["labels"]),
        users: pick(world.users, variables["users"]),
      };
    case "LinearWatchedIssues": {
      // Without `includeArchived`, Linear leaves archived and trashed issues out.
      const listed = world.issues.filter(
        (issue) =>
          issue.archivedAt === null &&
          issue.trashed !== true &&
          (filter === null || matchIssue(issue, filter, world.viewer.id)),
      );
      return { issues: buildPage(listed, variables, world.pageSize) };
    }
    case "LinearIssueLookup": {
      const ids = readIdIn(filter) ?? [];
      const found = world.issues.filter((issue) => ids.includes(issue.id));
      return { issues: buildPage(found, variables, world.pageSize) };
    }
    case "LinearIdentity":
      return viewerFields;
    case "LinearInboxStart":
    case "LinearInbox": {
      if (variables["last"] !== undefined || variables["before"] !== undefined) {
        throw new Error("The fake Linear pages the inbox only by `first` and `after`.");
      }
      const since = (filter as { createdAt?: { gte: string } } | null)?.createdAt?.gte;
      // Linear lists the inbox newest first and leaves archived notifications out.
      const listed = world.notifications
        .filter(
          (notification) =>
            notification.archivedAt === null &&
            (since === undefined || Date.parse(notification.createdAt) >= Date.parse(since)),
        )
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .map((notification) => answerNotification(world, notification));
      return { notifications: buildPage(listed, variables, world.pageSize) };
    }
    case "LinearMentionLookup": {
      const ids = readIdIn(filter) ?? [];
      const found = world.notifications.filter((notification) => ids.includes(notification.id));
      return {
        notifications: buildPage(
          found.map((n) => answerNotification(world, n)),
          variables,
          world.pageSize,
        ),
      };
    }
    case "LinearTeamChoices":
      return { teams: buildPage(world.teams, variables, world.pageSize) };
    case "LinearProjectChoices": {
      const teamIds = (
        filter as { accessibleTeams?: { some: { id: { in: Array<string> } } } } | null
      )?.accessibleTeams?.some.id.in;
      const projects = world.projects
        .filter(
          (project) =>
            teamIds === undefined || project.teamIds.some((teamId) => teamIds.includes(teamId)),
        )
        .map(({ id, name }) => ({ id, name }));
      return { projects: buildPage(projects, variables, world.pageSize) };
    }
    case "LinearMilestoneChoices": {
      const projectIds = readIdIn((filter as { project?: unknown } | null)?.project) ?? [];
      const milestones = world.milestones
        .filter((milestone) => projectIds.includes(milestone.projectId))
        .map((milestone) => ({
          id: milestone.id,
          name: milestone.name,
          project: {
            name: world.projects.find((project) => project.id === milestone.projectId)?.name ?? "",
          },
        }));
      return { projectMilestones: buildPage(milestones, variables, world.pageSize) };
    }
    case "LinearLabelChoices": {
      const labels = world.labels
        .filter((label) => matchLabel(label, filter ?? {}))
        .map((label) => ({
          id: label.id,
          name: label.name,
          isGroup: label.isGroup,
          parent: label.parentName === null ? null : { name: label.parentName },
          team: label.teamId === null ? null : { id: label.teamId },
        }));
      return { issueLabels: buildPage(labels, variables, world.pageSize) };
    }
    case "LinearUserChoices":
      return { users: buildPage(world.users, variables, world.pageSize) };
    default:
      throw new Error(`The fake Linear does not know the operation "${request.operationName}".`);
  }
};

/**
 * Builds a fake Linear that serves `world`. A request with another key than
 * the world's gets the 401 Linear sends for a refused credential.
 */
export const buildFakeLinear = (world: FakeWorld = buildFakeWorld()): FakeLinear => {
  const requests: Array<FakeRequest> = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const read = readFakeRequest(request);
      requests.push(read);
      const overridden = world.override?.(read);
      if (overridden !== undefined) return buildResponse(request, overridden);
      if (read.authorization !== world.apiKey) {
        return buildResponse(request, {
          status: 401,
          body: {
            errors: [
              {
                message: "Authentication required, not authenticated",
                extensions: { code: "AUTHENTICATION_ERROR" },
              },
            ],
          },
        });
      }
      return buildResponse(request, { status: 200, body: { data: answerOperation(world, read) } });
    }),
  );
  return { layer: Layer.succeed(HttpClient.HttpClient, client), world, requests };
};

/** An ingest context for tests, and what it recorded. */
export interface IngestHarness {
  readonly context: IngestContext;
  /** Every event emitted, in order, without the ones the host would drop as duplicates. */
  readonly events: Array<EmittedEvent>;
  /** The Connection's key-value store. */
  readonly state: Map<string, Schema.Json>;
  /** The Connection's open signals, which a test raises and ends. */
  readonly openSignals: Array<OpenSignal>;
}

/**
 * Decodes an event's payload against its kind's schema as the core does when
 * it stores the event, a key the schema does not name included. Fails with a
 * `PluginError` naming the kind and the issues.
 */
const decodePayload = (event: EmittedEvent): Effect.Effect<void, PluginError> => {
  const declaration = LINEAR_EVENT_KINDS[event.kind];
  if (declaration === undefined) {
    return Effect.fail(new PluginError({ message: `The kind ${event.kind} is not declared.` }));
  }
  return Schema.decodeUnknownEffect(declaration.schema as Schema.Codec<unknown>, {
    errors: "all",
    onExcessProperty: "error",
  })(event.payload).pipe(
    Effect.asVoid,
    Effect.mapError(
      (error) =>
        new PluginError({ message: `The payload of ${event.kind} is invalid: ${error.message}` }),
    ),
  );
};

/**
 * Builds an ingest context that keeps its state in memory. `emit` checks each
 * event as the host does, fails as the host does for an event that breaks its
 * limits or whose payload does not match its kind, and drops an event whose
 * dedup key it has seen, as the host does.
 */
export const buildIngestHarness = (
  credentials: Readonly<Record<string, string>> = { apiKey: TEST_API_KEY },
): IngestHarness => {
  const events: Array<EmittedEvent> = [];
  const state = new Map<string, Schema.Json>();
  const openSignals: Array<OpenSignal> = [];
  const store: KeyValueStore = {
    get: (key) => Effect.sync(() => Option.fromUndefinedOr(state.get(key))),
    set: (key, value) => Effect.sync(() => void state.set(key, value)),
    delete: (key) => Effect.sync(() => void state.delete(key)),
    list: () => Effect.sync(() => [...state.keys()]),
  };
  const seenDedupKeys = new Set<string>();
  const emit = (event: EmittedEvent): Effect.Effect<void, PluginError> =>
    Effect.andThen(
      Effect.andThen(checkEmittedEvent(LINEAR_EVENT_KINDS, event), decodePayload(event)),
      Effect.sync(() => {
        if (seenDedupKeys.has(event.dedupKey)) return;
        seenDedupKeys.add(event.dedupKey);
        events.push(event);
      }),
    );
  return {
    context: {
      emit,
      state: store,
      credentials: () => Effect.succeed({ ...credentials }),
      openSignals: () => Effect.sync(() => [...openSignals]),
    },
    events,
    state,
    openSignals,
  };
};
