/**
 * The setup the tests of `url-server-attempt.ts` share: the shared fake
 * controller (`buildMcpControllerHandlers`) behind the real client, a real
 * query client, and a way to hold or refuse the next answer of one route, so a
 * test controls when and how a reply arrives. No app code imports this.
 */
import { QueryClient } from "@tanstack/query-core";
import { vi, type Mock } from "vitest";
import { ERROR_STATUS, readAuthorizationState, type McpServer } from "@hercule/contract";
import { createApiStub, type Answer, type Call } from "../api-stub";
import { createClient, type HerculeClient } from "../client";
import { invalidateWithoutCancelling } from "../live/invalidation";
import type { BrowserSignInPort } from "./browser-sign-in";
import { buildMcpListQuery } from "./list-edits";
import type { McpServerQueries } from "./reconcile";
import { buildMcpControllerHandlers, buildMcpWorld, buildServer } from "./testing";
import {
  openUrlServerAttempt,
  type AttemptTarget,
  type UrlServerAttempt,
  type UrlServerAttemptState,
} from "./url-server-attempt";

/** The address of the server the tests add. */
export const ADDRESS = "https://mcp.docs.example/mcp";
/** The id the fake controller gives the server a test creates. Ids in conflicts are decoded, so it is a real one. */
export const DOCS_ID = "01a1fbc5-06ef-74bd-8d5f-998d787ac50e";
/** The id of another server, which holds an address a test adds again. */
export const OTHER_ID = "01a1fbc5-06ef-74bd-8d5f-998d787ac50f";
/** The id of a Connection of a plugin's server. */
export const CONNECTION_ID = "01a1fbc5-06ef-74bd-8d5f-998d787ac510";
export const AUTHORIZATION_HOST = "auth.mcp.docs.example";

const SERVERS_KEY = ["mcp-servers"];
export const detailKey = (id: string): readonly string[] => ["mcp-server", id];

/** Returns a server added by URL, named `docs`, that is being checked, as the fake controller creates it. */
export const urlServer = (overrides: Partial<McpServer> = {}, id = DOCS_ID): McpServer =>
  buildServer(id, "docs", "unused", {
    source: { kind: "url", url: ADDRESS, signIn: "none", signInOffered: null },
    status: "checking",
    tools: [],
    checkedAt: null,
    ...overrides,
  });

/** Returns a server added by URL that offers a sign-in through the browser and asks for it. */
export const oauthServer = (overrides: Partial<McpServer> = {}): McpServer =>
  urlServer({
    source: { kind: "url", url: ADDRESS, signIn: "none", signInOffered: "oauth" },
    status: "needs-sign-in",
    statusDetail: "The server asks for a sign-in",
    ...overrides,
  });

/** A promise the test settles by hand. */
export const hold = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

/** Returns the controller's refusal `code` as an answer, with `details` when the refusal has them. */
export const buildRefusal = (
  code: keyof typeof ERROR_STATUS,
  message: string,
  details?: unknown,
): Answer => ({
  status: ERROR_STATUS[code],
  body: { error: { code, message, ...(details === undefined ? {} : { details }) } },
});

/** Returns what the browser sends back to the sign-in at `authorizationUrl`: the code, and the `state` the sign-in carries. */
export const buildCallbackQuery = (authorizationUrl: string): string =>
  `code=the-code&state=${readAuthorizationState(authorizationUrl) ?? ""}`;

/** Waits until everything that is waiting on a promise that already settled has run. No time passes. */
export const flush = (): Promise<void> => new Promise((done) => setImmediate(done));

/** Runs in place of the controller for one call. `run` is the controller's own answer, which the hook may wait for, change, or never ask for. */
export type Hook = (run: () => Promise<Answer>) => Promise<Answer>;
type WaitOutcome = Awaited<ReturnType<BrowserSignInPort["wait"]>>;

export interface UrlServerSetup {
  /** What the fake controller holds. Change it, then `push`, to play the controller or another client. */
  readonly world: ReturnType<typeof buildMcpWorld>;
  readonly queryClient: QueryClient;
  readonly client: HerculeClient;
  /** Records each call the attempts make on the client, as the call is made. */
  readonly spies: ReturnType<typeof buildSpies>;
  readonly queries: McpServerQueries;
  /** The listener of the browser's return, which the test settles. Has the calls of each port function. */
  readonly port: {
    readonly browser: BrowserSignInPort;
    readonly listen: Mock<BrowserSignInPort["listen"]>;
    readonly cancel: Mock<BrowserSignInPort["cancel"]>;
    readonly open: Mock<BrowserSignInPort["open"]>;
    /** One entry for each `wait`, in order, to settle by hand. */
    readonly waits: ReturnType<typeof hold<WaitOutcome>>[];
  };
  /** Opens the attempt of a dialog for `target`. */
  readonly open: (target: AttemptTarget) => UrlServerAttempt;
  /** Changes a server of the world (`null` deletes it) and plays the live push that makes active reads of its page start again. */
  readonly change: (id: string, change: Partial<McpServer> | null) => void;
  /** Reads the list of servers from the controller, as a live push of the list does. */
  readonly readList: () => Promise<unknown>;
  /**
   * Makes the next call of `route` run the controller, then answer only when
   * `release` is called. `answered` settles once the controller has run, so
   * the test knows the change is committed while the reply is still on its way.
   */
  readonly holdAnswer: (route: string) => {
    readonly release: () => void;
    readonly answered: Promise<void>;
  };
  /** Makes the next call of `route` wait for `release`, then run the controller. */
  readonly holdRequest: (route: string) => { readonly release: () => void };
  /** Runs `hook` for the next call of `route`, in place of the controller. */
  readonly onNext: (route: string, hook: Hook) => void;
  /** Makes the next call of `route` answer with the controller's refusal `code`, without running the controller. */
  readonly refuse: (
    route: string,
    code: keyof typeof ERROR_STATUS,
    message: string,
    details?: unknown,
  ) => void;
  /** Makes the next call of `route` fail as a lost connection does, without running the controller. */
  readonly lose: (route: string) => void;
  /** Counts the calls of `route` the client sent. */
  readonly count: (route: string) => number;
  /** Waits until the fake controller holds the server a test created, which is when the create is committed, whatever the reply does. */
  readonly waitForCreated: () => Promise<void>;
  /** Waits until no read of the query cache runs. After a `change` it proves no active read was started, or that all finished. */
  readonly settled: () => Promise<void>;
  /** Waits until the attempt shows a state of `kind`, and returns it. */
  readonly waitForKind: <K extends UrlServerAttemptState["kind"]>(
    attempt: UrlServerAttempt,
    kind: K,
  ) => Promise<Extract<UrlServerAttemptState, { kind: K }>>;
  /** Waits until the attempt follows a server with an outcome of `kind`, and returns the state. */
  readonly waitForOutcome: (
    attempt: UrlServerAttempt,
    kind: string,
  ) => Promise<Extract<UrlServerAttemptState, { kind: "following" }>>;
  /** Waits until the attempt shows a sign-in step of `kind`, and returns the state. */
  readonly waitForStep: (
    attempt: UrlServerAttempt,
    kind: string,
  ) => Promise<Extract<UrlServerAttemptState, { kind: "signing-in" }>>;
}

/** Returns spies on the client's calls that the attempts make. */
const buildSpies = (client: HerculeClient) => ({
  create: vi.spyOn(client.mcpServer, "create"),
  setToken: vi.spyOn(client.mcpServer, "setToken"),
  startSignIn: vi.spyOn(client.mcpServer, "startSignIn"),
  finishSignIn: vi.spyOn(client.mcpServer, "finishSignIn"),
  check: vi.spyOn(client.mcpServer, "check"),
  read: vi.spyOn(client.mcpServer, "read"),
});

export const ROUTES = {
  create: "POST /api/v1/mcp-servers",
  list: "GET /api/v1/mcp-servers",
  read: (id: string) => `GET /api/v1/mcp-servers/${id}`,
  setToken: (id: string) => `POST /api/v1/mcp-servers/${id}/token`,
  startSignIn: (id: string) => `POST /api/v1/mcp-servers/${id}/sign-in`,
  finishSignIn: (id: string) => `POST /api/v1/mcp-servers/${id}/sign-in/finish`,
  check: (id: string) => `POST /api/v1/mcp-servers/${id}/check`,
} as const;

/**
 * Sets up the fake controller holding `servers`, the client over it, a real
 * query client with the list of servers read once, and a port for the
 * browser's return. With `withPort: false` the attempts have no port, as in
 * the web app; with `listens: false` the port cannot listen.
 */
export const setupUrlServers = async ({
  servers = [],
  withPort = true,
  listens = true,
  returnsAtOnce = false,
}: {
  readonly servers?: readonly McpServer[];
  readonly withPort?: boolean;
  readonly listens?: boolean;
  /** The browser answers the moment the wait starts, as a fast redirect does. */
  readonly returnsAtOnce?: boolean;
} = {}): Promise<UrlServerSetup> => {
  const world = buildMcpWorld({ servers, projects: [] });
  const hooks = new Map<string, Hook[]>();
  const sent = new Map<string, number>();
  const api = createApiStub(
    new Proxy(
      {},
      {
        get: (_target, route) => {
          if (typeof route !== "string") return undefined;
          // The controller's handlers are built from the world as it is now, so a server added later has its routes.
          const base = buildMcpControllerHandlers(world, { createdIds: [DOCS_ID] })[route];
          if (base === undefined) return undefined;
          return async (call: Call): Promise<Answer> => {
            sent.set(route, (sent.get(route) ?? 0) + 1);
            const run = async (): Promise<Answer> =>
              typeof base === "function" ? base(call) : base;
            const hook = hooks.get(route)?.shift();
            return hook === undefined ? run() : hook(run);
          };
        },
      },
    ),
  );
  const client = createClient({ baseUrl: "http://controller.test", fetch: api.fetch });
  const spies = buildSpies(client);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const catalogue = buildMcpListQuery(queryClient, {
    queryKey: SERVERS_KEY,
    queryFn: async () => (await client.mcpServer.query()).items,
  });
  await catalogue.fetch();
  const queries: McpServerQueries = {
    readServers: () => queryClient.getQueryData<McpServer[]>(SERVERS_KEY),
    readCatalogue: () => catalogue,
    readServerQuery: (id) => ({
      queryKey: detailKey(id),
      queryFn: () => client.mcpServer.read({ params: { id } }),
    }),
  };

  const waits: ReturnType<typeof hold<WaitOutcome>>[] = [];
  const listen = vi.fn<BrowserSignInPort["listen"]>(() =>
    Promise.resolve(
      listens
        ? {
            kind: "listening",
            listenerId: "l-1",
            redirectUri: "http://127.0.0.1:4937/callback",
          }
        : { kind: "unavailable" },
    ),
  );
  const cancel = vi.fn<BrowserSignInPort["cancel"]>(() => Promise.resolve());
  const open = vi.fn<BrowserSignInPort["open"]>(() => Promise.resolve());
  const browser: BrowserSignInPort = {
    listen,
    wait: (_listenerId, authorizationUrl) => {
      if (returnsAtOnce) {
        return Promise.resolve({
          kind: "received" as const,
          callbackQuery: buildCallbackQuery(authorizationUrl),
        });
      }
      const held = hold<WaitOutcome>();
      waits.push(held);
      return held.promise;
    },
    cancel,
    open,
  };

  const addHook = (route: string, hook: Hook): void => {
    hooks.set(route, [...(hooks.get(route) ?? []), hook]);
  };
  const waitUntil = async (
    predicate: (state: UrlServerAttemptState) => boolean,
    attempt: UrlServerAttempt,
  ) => {
    await vi.waitFor(() => {
      if (!predicate(attempt.read())) throw new Error("the attempt does not show it yet");
    });
    return attempt.read();
  };

  return {
    world,
    queryClient,
    client,
    spies,
    queries,
    port: { browser: withPort ? browser : (undefined as never), listen, cancel, open, waits },
    open: (target) =>
      openUrlServerAttempt(
        { queryClient, client, queries, browserSignIn: withPort ? browser : undefined },
        target,
      ),
    change: (id, change) => {
      world.servers =
        change === null
          ? world.servers.filter((server) => server.id !== id)
          : world.servers.map((server) => (server.id === id ? { ...server, ...change } : server));
      invalidateWithoutCancelling(queryClient, detailKey(id));
    },
    readList: () => catalogue.fetch(),
    holdAnswer: (route) => {
      const gate = hold();
      const answered = hold();
      addHook(route, async (run) => {
        const answer = await run();
        answered.resolve();
        await gate.promise;
        return answer;
      });
      return { release: gate.resolve, answered: answered.promise };
    },
    holdRequest: (route) => {
      const gate = hold();
      addHook(route, async (run) => {
        await gate.promise;
        return run();
      });
      return { release: gate.resolve };
    },
    onNext: addHook,
    refuse: (route, code, message, details) => {
      addHook(route, () => Promise.resolve(buildRefusal(code, message, details)));
    },
    lose: (route) => {
      addHook(route, () => Promise.reject(new Error("offline")));
    },
    count: (route) => sent.get(route) ?? 0,
    waitForCreated: () =>
      vi.waitFor(() => {
        if (!world.servers.some((server) => server.id === DOCS_ID)) throw new Error("not created");
      }),
    settled: () =>
      vi.waitFor(() => {
        if (queryClient.isFetching() !== 0) throw new Error("a read still runs");
      }),
    waitForKind: (async (attempt: UrlServerAttempt, kind: string) =>
      waitUntil((state) => state.kind === kind, attempt)) as UrlServerSetup["waitForKind"],
    waitForOutcome: (async (attempt: UrlServerAttempt, kind: string) =>
      waitUntil(
        (state) => state.kind === "following" && state.outcome.kind === kind,
        attempt,
      )) as UrlServerSetup["waitForOutcome"],
    waitForStep: (async (attempt: UrlServerAttempt, kind: string) =>
      waitUntil(
        (state) => state.kind === "signing-in" && state.step.kind === kind,
        attempt,
      )) as UrlServerSetup["waitForStep"],
  };
};
