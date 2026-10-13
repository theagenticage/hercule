/**
 * Test support for this plugin:
 *
 * - a fake Sentry: an `HttpClient` layer that serves one in-memory
 *   organization, which a test changes between polls the way Sentry's users
 *   do (resolve an issue, assign it, rename a team). It answers the requests
 *   the plugin sends the way the real API was recorded to answer them
 *   (`docs/research/sentry-api.md`), and records every request it received;
 * - an ingest context that keeps its state in memory and records every event
 *   emitted, after checking it as the host would.
 *
 * Every value is invented: the organization `acme`, the project `webshop`,
 * the user `ada`.
 */
import { Effect, Layer, Option, type Result, Schema } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import {
  PluginError,
  type EmittedEvent,
  type IngestContext,
  type KeyValueStore,
  type OpenSignal,
} from "@hercule/plugin-host";
import { checkEmittedEvent } from "./ingest/check-event";
import type { SentryOrganization } from "./organization";

/** The token every test's Connection holds. */
export const TEST_TOKEN = "sntryu_0123456789abcdef-invented";

/** The organization of the test Connection. */
export const TEST_ORGANIZATION: SentryOrganization = {
  id: "4501",
  slug: "acme",
  name: "Acme",
  regionUrl: "https://us.sentry.io",
};

/** The user of the test Connection: Ada, the account the token belongs to. */
export const TEST_USER = { id: "88", username: "ada", name: "Ada Lovelace" };

/** The account the host passes an event source: `<organization id>:<user id>`. */
export const TEST_ACCOUNT_ID = `${TEST_ORGANIZATION.id}:${TEST_USER.id}`;

/** The `displayName` the Connection's `validate` returned. */
export const TEST_DISPLAY_NAME = `${TEST_ORGANIZATION.name} · ${TEST_USER.name}`;

/** The stub's layer, and every request it received, in order. */
export interface HttpStub<Request> {
  readonly layer: Layer.Layer<HttpClient.HttpClient>;
  readonly requests: Array<Request>;
}

/** One response the fake returns. A missing body is an empty body. */
export interface StubResponse {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

/** Converts a `StubResponse` into the response the client returns for `request`. */
const buildStubResponse = (
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
 * for it. Use it for a test that needs one or two fixed answers; use
 * `buildFakeSentry` for a whole organization.
 */
export const stubSentry = (
  route: (request: HttpClientRequest.HttpClientRequest) => StubResponse,
): HttpStub<HttpClientRequest.HttpClientRequest> =>
  stubHttpClient((request) => Effect.succeed(buildStubResponse(request, route(request))));

/** Builds a stub client that answers each request with `answer`. Use it to fail a request. */
export const stubHttpClient = (
  answer: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>,
): HttpStub<HttpClientRequest.HttpClientRequest> => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const client = HttpClient.make((request) => {
    requests.push(request);
    return answer(request);
  });
  return { layer: Layer.succeed(HttpClient.HttpClient, client), requests };
};

/**
 * Runs an effect that calls Sentry against a stub client, and returns its
 * result: the value it succeeded with, or the error it failed with.
 */
export const runAgainstStub = <A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient>,
  stub: { readonly layer: Layer.Layer<HttpClient.HttpClient> },
): Promise<Result.Result<A, E>> =>
  Effect.runPromise(Effect.result(effect).pipe(Effect.provide(stub.layer)));

/** The path, host and query parameters of a request the fake received. */
export interface FakeRequest {
  readonly method: string;
  /** The host, such as `https://us.sentry.io`. */
  readonly origin: string;
  /** The path below the host, such as `/api/0/organizations/acme/issues/`. */
  readonly path: string;
  /** Every parameter, in the order sent. A repeated name appears once per value. */
  readonly params: URLSearchParams;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

/** Reads the JSON body of a request. Returns undefined when it has none. */
export const readRequestBody = (request: HttpClientRequest.HttpClientRequest): unknown =>
  request.body._tag === "Uint8Array"
    ? JSON.parse(new TextDecoder().decode(request.body.body))
    : undefined;

/** Reads a request as the fake records it. The parameters may be in the URL or passed beside it. */
export const readFakeRequest = (request: HttpClientRequest.HttpClientRequest): FakeRequest => {
  const url = new URL(request.url);
  for (const [name, value] of request.urlParams) url.searchParams.append(name, value);
  return {
    method: request.method,
    origin: url.origin,
    path: url.pathname,
    params: url.searchParams,
    authorization: request.headers["authorization"],
    body: readRequestBody(request),
  };
};

/** An issue as the fake organization holds it. Field names follow Sentry's. */
export interface FakeIssue {
  id: string;
  shortId: string;
  title: string;
  culprit: string;
  level: string;
  status: string;
  substatus: string | null;
  priority: string;
  assignedTo: { type: "user" | "team"; id: string; name: string } | null;
  projectId: string;
  /** The environment its events came from; a request for other environments does not list it. */
  environment: string;
  firstSeen: string;
  lastSeen: string;
  count: string;
  userCount: number;
  errorType: string | null;
  /** The user who resolved or archived it, when Sentry names one. */
  actorId: string | null;
  activity: Array<FakeActivity>;
  latestEvent: FakeEvent | null;
}

/** One entry of an issue's activity. */
export interface FakeActivity {
  id: string;
  type: string;
  dateCreated: string;
  data: { version?: string };
}

/** The newest event of an issue. */
export interface FakeEvent {
  eventID: string;
  dateCreated: string;
  release: string | null;
  environment: string | null;
  frames: ReadonlyArray<{
    filename: string;
    function: string;
    lineNo: number;
    inApp: boolean;
  }>;
  type: string;
  value: string;
}

/** A team of the fake organization. */
export interface FakeTeam {
  id: string;
  slug: string;
}

/** A project of the fake organization, and the teams that own it. */
export interface FakeProject {
  id: string;
  slug: string;
  name: string;
  teamIds: Array<string>;
}

/** A member of the fake organization. `userId` is null for an invitation nobody accepted. */
export interface FakeMember {
  id: string;
  name: string;
  email: string;
  userId: string | null;
  username: string;
}

/**
 * The fake organization and the knobs a test turns. The test changes it
 * between polls, and the fake answers from it as it is at each request.
 */
export interface FakeWorld {
  token: string;
  organization: SentryOrganization;
  /** The teams the user is a member of, for `assigned:my_teams`. */
  userTeamIds: Array<string>;
  teams: Array<FakeTeam>;
  projects: Array<FakeProject>;
  environments: Array<string>;
  members: Array<FakeMember>;
  issues: Array<FakeIssue>;
  /** How many items the fake puts on a page of a list other than the issue list. */
  pageSize: number;
  /**
   * Answers a request instead of the fake, when it returns a response. Use
   * it to refuse a request: a 429, a 401, a 500.
   */
  override: ((request: FakeRequest) => StubResponse | undefined) | undefined;
}

/** The fake, and the world it serves. */
export interface FakeSentry extends HttpStub<FakeRequest> {
  readonly world: FakeWorld;
}

/** Returns a timestamp `minutes` after now (or before, when negative), in the form Sentry sends. */
export const stampAt = (minutes: number): string =>
  new Date(Date.now() + minutes * 60_000).toISOString();

/** Builds an issue with the values a test does not care about filled in. */
export const buildFakeIssue = (id: string, overrides: Partial<FakeIssue> = {}): FakeIssue => ({
  id,
  shortId: `WEBSHOP-${id}`,
  title: `TypeError: cannot read properties of undefined (issue ${id})`,
  culprit: "app/checkout.ts in submitOrder",
  level: "error",
  status: "unresolved",
  substatus: "ongoing",
  priority: "medium",
  assignedTo: null,
  projectId: "11",
  environment: "production",
  firstSeen: stampAt(-600),
  lastSeen: stampAt(-10),
  count: "12",
  userCount: 3,
  errorType: "TypeError",
  actorId: null,
  activity: [],
  latestEvent: null,
  ...overrides,
});

/** Builds an organization with Ada, two teams, two projects and two environments. */
export const buildFakeWorld = (issues: Array<FakeIssue> = []): FakeWorld => ({
  token: TEST_TOKEN,
  organization: TEST_ORGANIZATION,
  userTeamIds: ["31"],
  teams: [
    { id: "31", slug: "platform" },
    { id: "32", slug: "payments" },
  ],
  projects: [
    { id: "11", slug: "webshop", name: "Webshop", teamIds: ["31"] },
    { id: "12", slug: "billing", name: "Billing", teamIds: ["32"] },
  ],
  environments: ["production", "staging"],
  members: [
    { id: "501", name: "Ada Lovelace", email: "ada@acme.test", userId: "88", username: "ada" },
    { id: "502", name: "Grace Hopper", email: "grace@acme.test", userId: "89", username: "grace" },
    { id: "503", name: "Pending Person", email: "pending@acme.test", userId: null, username: "" },
  ],
  issues,
  pageSize: 100,
  override: undefined,
});

/** Returns the numeric part of an id as a number, to sort ids the way Sentry does. */
const toNumber = (id: string): number => Number(id);

/** The fields of an issue that Sentry's list leaves out when it is asked for `collapse=stats`. */
const SEEN_STATS: ReadonlyArray<string> = ["firstSeen", "lastSeen", "count", "userCount"];

/** Renders an issue as the list and the detail endpoint do. */
export const renderFakeIssue = (world: FakeWorld, issue: FakeIssue): Record<string, unknown> => {
  const project = world.projects.find((candidate) => candidate.id === issue.projectId);
  const actor = world.members.find((member) => member.userId === issue.actorId);
  return {
    id: issue.id,
    shortId: issue.shortId,
    title: issue.title,
    culprit: issue.culprit,
    permalink: `https://${world.organization.slug}.sentry.io/issues/${issue.id}/`,
    level: issue.level,
    status: issue.status,
    ...(issue.substatus === null ? {} : { substatus: issue.substatus }),
    priority: issue.priority,
    assignedTo: issue.assignedTo,
    project: { id: issue.projectId, slug: project?.slug, name: project?.name, platform: "node" },
    firstSeen: issue.firstSeen,
    lastSeen: issue.lastSeen,
    count: issue.count,
    userCount: issue.userCount,
    isUnhandled: true,
    metadata: issue.errorType === null ? {} : { type: issue.errorType },
    statusDetails:
      actor === undefined || issue.actorId === null
        ? {}
        : {
            actor: {
              id: issue.actorId,
              username: actor.username,
              name: actor.name,
              email: actor.email,
            },
          },
  };
};

/** Renders the newest event of an issue as `events/latest/` does. */
const renderLatestEvent = (event: FakeEvent): Record<string, unknown> => ({
  eventID: event.eventID,
  id: event.eventID,
  dateCreated: event.dateCreated,
  release: event.release === null ? null : { version: event.release },
  tags: [
    ...(event.environment === null ? [] : [{ key: "environment", value: event.environment }]),
    ...(event.release === null ? [] : [{ key: "release", value: event.release }]),
  ],
  entries: [
    {
      type: "exception",
      data: {
        values: [
          {
            type: event.type,
            value: event.value,
            stacktrace: { frames: event.frames },
          },
        ],
      },
    },
    { type: "breadcrumbs", data: { values: [] } },
  ],
});

/**
 * Evaluates the part of Sentry's search the plugin sends: `is:unresolved`,
 * `lastSeen:-<n>d` and `assigned:` with one value or a bracketed list. A
 * value that matches nothing matches nothing, without an error, as recorded.
 */
const matchesQuery = (world: FakeWorld, issue: FakeIssue, query: string): boolean => {
  if (/\bis:unresolved\b/.test(query) && issue.status !== "unresolved") return false;
  const days = /\blastSeen:-(\d+)d\b/.exec(query)?.[1];
  if (days !== undefined && Date.parse(issue.lastSeen) < Date.now() - Number(days) * 86_400_000) {
    return false;
  }
  const assigned = /\bassigned:(\[[^\]]*\]|\S+)/.exec(query)?.[1];
  if (assigned === undefined) return true;
  const wanted = assigned
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((value) => value.trim());
  return wanted.some((value) => {
    const assignee = issue.assignedTo;
    if (value === "none") return assignee === null;
    if (assignee === null) return false;
    if (value === "me") return assignee.type === "user" && assignee.id === TEST_USER.id;
    if (value === "my_teams")
      return assignee.type === "team" && world.userTeamIds.includes(assignee.id);
    if (value.startsWith("#")) {
      return (
        assignee.type === "team" &&
        world.teams.some((team) => team.id === assignee.id && `#${team.slug}` === value)
      );
    }
    return (
      assignee.type === "user" &&
      world.members.some((member) => member.userId === assignee.id && member.username === value)
    );
  });
};

/**
 * Cuts a list into the page the request asks for. The cursor is the offset of
 * the page's first item. Like Sentry, the answer always carries a
 * `rel="next"` link and marks it `results="false"` on the last page.
 */
const buildPage = (
  request: FakeRequest,
  items: ReadonlyArray<unknown>,
  limit: number,
): StubResponse => {
  const offset = Number(request.params.get("cursor") ?? "0");
  const page = items.slice(offset, offset + limit);
  const more = offset + limit < items.length;
  const link = (rel: string, results: boolean, cursor: number): string =>
    `<${request.origin}${request.path}?cursor=${String(cursor)}>; rel="${rel}"; results="${String(results)}"; cursor="${String(cursor)}"`;
  return {
    status: 200,
    body: page,
    headers: {
      link: `${link("previous", offset > 0, Math.max(0, offset - limit))}, ${link("next", more, offset + limit)}`,
    },
  };
};

/** Applies a `PUT` body to an issue the way Sentry does. */
const applyIssueUpdate = (world: FakeWorld, issue: FakeIssue, body: unknown): void => {
  const update = body as {
    status?: string;
    substatus?: string;
    assignedTo?: string;
  };
  if (update.status === "resolved") {
    issue.status = "resolved";
    issue.substatus = null;
    issue.actorId = TEST_USER.id;
  } else if (update.status === "ignored") {
    issue.status = "ignored";
    issue.substatus = update.substatus ?? "archived_forever";
    issue.actorId = TEST_USER.id;
  }
  if (update.assignedTo !== undefined) {
    if (update.assignedTo.startsWith("team:")) {
      const team = world.teams.find((candidate) => `team:${candidate.id}` === update.assignedTo);
      issue.assignedTo = team === undefined ? null : { type: "team", id: team.id, name: team.slug };
    } else {
      const member = world.members.find(
        (candidate) => `user:${candidate.userId ?? ""}` === update.assignedTo,
      );
      issue.assignedTo =
        member?.userId == null ? null : { type: "user", id: member.userId, name: member.username };
    }
  }
};

/** Answers one request from the world. */
const answerFromWorld = (world: FakeWorld, request: FakeRequest): StubResponse => {
  if (request.authorization !== `Bearer ${world.token}`) {
    return { status: 401, body: { detail: "Invalid token" } };
  }
  const { slug } = world.organization;
  const base = `/api/0/organizations/${slug}`;
  if (request.method === "GET" && request.path === "/api/0/organizations/") {
    return buildPage(
      request,
      [
        {
          id: world.organization.id,
          slug,
          name: world.organization.name,
          links: {
            organizationUrl: `https://${slug}.sentry.io`,
            regionUrl: world.organization.regionUrl,
          },
        },
      ],
      100,
    );
  }
  if (request.method === "GET" && request.path === `${base}/members/me/`) {
    const me = world.members.find((member) => member.userId === TEST_USER.id);
    return {
      status: 200,
      body: {
        id: me?.id,
        email: me?.email,
        name: me?.name,
        user: { id: TEST_USER.id, username: TEST_USER.username },
      },
    };
  }
  if (request.method === "GET" && request.path === `${base}/teams/`) {
    return buildPage(
      request,
      world.teams.map((team) => ({ id: team.id, slug: team.slug, name: team.slug })),
      world.pageSize,
    );
  }
  if (request.method === "GET" && request.path === `${base}/projects/`) {
    return buildPage(
      request,
      world.projects.map((project) => ({
        id: project.id,
        slug: project.slug,
        name: project.name,
        teams: world.teams.filter((team) => project.teamIds.includes(team.id)),
      })),
      world.pageSize,
    );
  }
  if (request.method === "GET" && request.path === `${base}/environments/`) {
    return buildPage(
      request,
      world.environments.map((name, index) => ({ id: String(index + 1), name })),
      world.pageSize,
    );
  }
  if (request.method === "GET" && request.path === `${base}/members/`) {
    return buildPage(
      request,
      world.members.map((member) => ({
        id: member.id,
        email: member.email,
        name: member.name,
        user: member.userId === null ? null : { id: member.userId, username: member.username },
      })),
      world.pageSize,
    );
  }
  if (request.method === "GET" && request.path === `${base}/issues/`) {
    const groups = request.params.getAll("group");
    const projectIds = request.params.getAll("project");
    if (projectIds.some((id) => !world.projects.some((project) => project.id === id))) {
      return {
        status: 403,
        body: { detail: "You do not have permission to perform this action." },
      };
    }
    const environments = request.params.getAll("environment");
    const query = request.params.get("query") ?? "";
    const matching = (
      groups.length > 0
        ? world.issues.filter((issue) => groups.includes(issue.id))
        : world.issues.filter(
            (issue) =>
              matchesQuery(world, issue, query) &&
              (projectIds.length === 0 || projectIds.includes(issue.projectId)) &&
              (environments.length === 0 || environments.includes(issue.environment)),
          )
    )
      // `sort=new` lists the newest first seen first; the id breaks ties.
      .sort(
        (first, second) =>
          Date.parse(second.firstSeen) - Date.parse(first.firstSeen) ||
          toNumber(second.id) - toNumber(first.id),
      );
    // Like Sentry, `collapse=stats` drops the seen stats along with the graphs.
    const dropped = request.params.getAll("collapse").includes("stats") ? SEEN_STATS : [];
    return buildPage(
      request,
      matching.map((issue) =>
        Object.fromEntries(
          Object.entries(renderFakeIssue(world, issue)).filter(([key]) => !dropped.includes(key)),
        ),
      ),
      Number(request.params.get("limit") ?? "25"),
    );
  }
  const issueMatch = new RegExp(`^${base}/issues/(\\d+)/(events/latest/)?$`).exec(request.path);
  if (issueMatch !== null) {
    const issue = world.issues.find((candidate) => candidate.id === issueMatch[1]);
    if (issue === undefined)
      return { status: 404, body: { detail: "The requested resource does not exist" } };
    if (issueMatch[2] !== undefined) {
      return issue.latestEvent === null
        ? { status: 404, body: { detail: "Event not found" } }
        : { status: 200, body: renderLatestEvent(issue.latestEvent) };
    }
    if (request.method === "PUT") {
      applyIssueUpdate(world, issue, request.body);
      return { status: 200, body: renderFakeIssue(world, issue) };
    }
    return { status: 200, body: { ...renderFakeIssue(world, issue), activity: issue.activity } };
  }
  return {
    status: 404,
    body: { detail: `The fake has no route for ${request.method} ${request.path}` },
  };
};

/**
 * Builds a fake Sentry that serves `world`. Every response carries the
 * rate-limit headers Sentry sends: 40 requests a window, which ends 30
 * seconds from now.
 */
export const buildFakeSentry = (world: FakeWorld): FakeSentry => {
  const requests: Array<FakeRequest> = [];
  const stub = stubSentry((raw) => {
    const request = readFakeRequest(raw);
    requests.push(request);
    const response = world.override?.(request) ?? answerFromWorld(world, request);
    return {
      ...response,
      headers: {
        "x-sentry-rate-limit-limit": "40",
        "x-sentry-rate-limit-remaining": "39",
        "x-sentry-rate-limit-reset": String(Math.floor(Date.now() / 1000) + 30),
        ...response.headers,
      },
    };
  });
  return { layer: stub.layer, requests, world };
};

/** An ingest context for tests, and what was done through it. */
export interface IngestHarness {
  readonly context: IngestContext;
  /**
   * Every event the host would have stored, in order. An event whose dedup key
   * was emitted before is not here: the host drops it, permanently and silently.
   */
  readonly events: Array<EmittedEvent>;
  /** The Connection's state, by key. */
  readonly state: Map<string, Schema.Json>;
  /** The open signals `openSignals` returns; a test may change them between polls. */
  readonly openSignals: Array<OpenSignal>;
}

/**
 * Builds an ingest context whose credentials hold `credentials`, whose state
 * lives in a `Map`, and whose `emit` records each event. Like the host's,
 * `emit` fails with a `PluginError` when the event fails the checks
 * `checkEmittedEvent` describes, and drops an event whose dedup key it has
 * recorded before, so a test sees a key that two events share.
 */
export const buildIngestHarness = (
  credentials: Readonly<Record<string, string>> = { token: TEST_TOKEN },
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
      checkEmittedEvent(event),
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
