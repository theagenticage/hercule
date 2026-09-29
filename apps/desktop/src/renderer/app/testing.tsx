/**
 * Test helpers that run the real renderer against a fake bridge and a stubbed
 * controller.
 *
 * Only the edges are replaced: `window.bridge`, which main provides, and the
 * global `fetch` and `WebSocket`, which reach the controller. Boot's context,
 * the client, the live connection, the router, the entry guard and the
 * screens are the ones that ship, so a change to any of them shows up in the
 * tests.
 */
import { afterEach, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { RouterProvider } from "@tanstack/react-router";
import type { Live } from "@hercule/client-core";
import { stubWebSocketInto, type StubSocket } from "@hercule/client-core/testing";
import { buildSession, buildThreadsWorld } from "@hercule/client-core/threads/testing";
import type {
  MutableLiveTopic,
  OpenRequest,
  Project,
  ProviderInstance,
  Resource,
  Runner,
  Session,
  Workspace,
} from "@hercule/contract";
import type { Bridge, EncodedIpcPayload } from "../../ipc/bridge";
import type { ControllerUrlSaveOutcome } from "../../ipc/contract";
import { buildRouterContext, type RouterContext } from "./context";
import { createAppRouter } from "./router";

/** A menu command main sends the page, such as `signOut`. */
export type MenuCommand = EncodedIpcPayload<"menu.command">;

/** The address of the stubbed controller. */
export const CONTROLLER_URL = "http://controller.test";

/** The bridge a test passes to the app, and what the app did with it. */
export interface FakeBridge {
  readonly bridge: Bridge;
  /** The tokens the app sent main to store, oldest first. `null` is a removal. */
  readonly tokenWrites: readonly (string | null)[];
  /** The addresses the app asked main to check and save, oldest first. */
  readonly savedUrls: readonly string[];
  /** Sends a menu command, as main does when the user picks the menu item. */
  readonly sendMenuCommand: (command: MenuCommand) => void;
}

/**
 * Creates a bridge that answers as main would for a user whose settings hold
 * `controllerUrl` and whose Keychain holds `token`. `save` answers each
 * Connect; by default the controller checks out and the URL is saved.
 */
export const createFakeBridge = ({
  controllerUrl = null,
  token = null,
  save = (url) => Promise.resolve({ _tag: "Saved", origin: url }),
}: {
  readonly controllerUrl?: string | null;
  readonly token?: string | null;
  readonly save?: (url: string) => Promise<ControllerUrlSaveOutcome>;
} = {}): FakeBridge => {
  const tokenWrites: (string | null)[] = [];
  const savedUrls: string[] = [];
  const menuListeners = new Set<(command: MenuCommand) => void>();
  return {
    bridge: {
      controllerUrl: {
        read: () => Promise.resolve(controllerUrl),
        save: (url) => {
          savedUrls.push(url);
          return save(url);
        },
      },
      token: {
        read: () => Promise.resolve(token),
        write: (next) => {
          tokenWrites.push(next);
          return Promise.resolve(undefined);
        },
      },
      firstScreen: {
        report: () => Promise.resolve(undefined),
      },
      menu: {
        onCommand: (listener) => {
          menuListeners.add(listener);
          return () => menuListeners.delete(listener);
        },
      },
    },
    tokenWrites,
    savedUrls,
    sendMenuCommand: (command) => {
      // Main sends the command from outside React, so the updates it causes
      // are wrapped in `act`, which applies them before the test goes on.
      act(() => {
        for (const listener of menuListeners) listener(command);
      });
    },
  };
};

/** One request the app sent the controller, as the stub received it. */
export interface Call {
  readonly method: string;
  readonly path: string;
  /** The URL's query parameters, such as `{ cursor: "…" }` for a list's next page. */
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
  /** The `authorization` header, or `null` when the request had none. */
  readonly authorization: string | null;
}

/** The response a stubbed operation returns. */
export interface Answer {
  readonly status?: number;
  readonly body: unknown;
}

/**
 * The response for one operation, or a function that builds it. A function
 * that throws or rejects makes `fetch` reject, as it does when the controller
 * cannot be reached.
 */
export type Handler = Answer | ((call: Call) => Answer | Promise<Answer>);

/** Builds the error body the API sends. */
export const buildErrorBody = (code: string, message: string): { error: unknown } => ({
  error: { code, message },
});

/** The error `fetch` rejects with when nothing answers at the address. */
export const refuseConnection = (): never => {
  throw new TypeError("Failed to fetch");
};

/**
 * Answers never, like a controller that accepts the connection and then
 * hangs. The request still ends when its signal aborts, as a real one does.
 */
export const neverAnswer = (): Promise<Answer> => new Promise(() => {});

/** Returns a promise that rejects with the signal's reason when `signal` aborts, as `fetch` does. */
const rejectOnAbort = (signal: AbortSignal | null | undefined): Promise<never> =>
  new Promise((_resolve, reject) => {
    signal?.addEventListener(
      "abort",
      () => {
        // Every abort in the app passes an Error as its reason, such as the
        // TimeoutError of `fetchWithTimeout`.
        reject(signal.reason as Error);
      },
      { once: true },
    );
  });

/** The records the sidebar reads, as the stubbed controller holds them. */
export interface SidebarRecords {
  readonly threads: readonly Session[];
  readonly projects: readonly Project[];
  readonly workspaces: readonly Workspace[];
  readonly resources: readonly Resource[];
  readonly runners: readonly Runner[];
  readonly providers: readonly ProviderInstance[];
  /** The signed-in user's name. */
  readonly username: string;
}

/** A controller that holds no threads, projects, workspaces, resources, runners or providers. */
export const NO_SIDEBAR_RECORDS: SidebarRecords = {
  threads: [],
  projects: [],
  workspaces: [],
  resources: [],
  runners: [],
  providers: [],
  username: "rogier",
};

/**
 * Returns the handlers that answer the sidebar's seven reads from `records`.
 * Each list comes back as one page, with no cursor to a next one.
 */
export const buildSidebarHandlers = (
  records: SidebarRecords,
): Readonly<Record<string, Handler>> => ({
  "GET /api/v1/sessions": { body: { items: records.threads } },
  "GET /api/v1/projects": { body: { items: records.projects } },
  "GET /api/v1/workspaces": { body: { items: records.workspaces } },
  "GET /api/v1/resources": { body: { items: records.resources } },
  "GET /api/v1/runners": { body: { items: records.runners } },
  "GET /api/v1/providers": { body: records.providers },
  "GET /api/v1/user": { body: { username: records.username } },
});

/**
 * The ids of client-core's shared fixture world, in the UUIDv7 format the
 * contract accepts, so the records decode when the stubbed controller sends
 * them.
 */
const WORLD_IDS = {
  moss: "01a06d02-beff-7037-9f5b-042822015952",
  cove: "01a06d02-beff-7037-9f5b-042822015953",
  webshopProject: "01a06d02-7000-7000-8000-000000000001",
  opsProject: "01a06d02-7000-7000-8000-000000000002",
  webshop: "01a06d02-7100-7000-8000-000000000001",
  infra: "01a06d02-7100-7000-8000-000000000002",
  runbooks: "01a06d02-7100-7000-8000-000000000003",
  primary: "01a06d02-7200-7000-8000-000000000001",
  primaryCheckout: "01a06d02-7300-7000-8000-000000000001",
  thread3f1: "01a06d02-7200-7000-8000-000000000002",
  thread3f1Checkout: "01a06d02-7300-7000-8000-000000000002",
  flakyThread: "01a06d02-7400-7000-8000-000000000001",
  runbookThread: "01a06d02-7400-7000-8000-000000000002",
};

/** The ids of the threads in `SIDEBAR_FIXTURE`, for a test that opens one. */
export const FIXTURE_THREAD_IDS = {
  /** "Write the retry runbook": waiting on a command approval, in the `hercule/thread-3f1` worktree. */
  runbook: WORLD_IDS.runbookThread,
  /** "Fix flaky webhook tests": working, in the same worktree. */
  flaky: WORLD_IDS.flakyThread,
  /** "Bump the Bun pin": idle, in webshop's main workspace. */
  bunPin: "01a06d02-7400-7000-8000-000000000003",
  /** "Rotate the backups key": exited, in the ops project, with no workspace. */
  backupsKey: "01a06d02-7400-7000-8000-000000000004",
  /** "Sketch the pricing page": idle, in no project. */
  pricingPage: "01a06d02-7400-7000-8000-000000000005",
} as const;

const WORLD = buildThreadsWorld(WORLD_IDS);

/** The permission profile and provider instance every fixture thread names. */
const PROFILE_ID = "01a06d02-7500-7000-8000-000000000001";
const INSTANCE_ID = "01a06d02-7600-7000-8000-000000000001";

/** Returns a fixture thread on moss, with ids the contract accepts. */
const buildFixtureThread = (
  over: Partial<Session> & { readonly id: string; readonly title: string },
): Session =>
  buildSession({
    runnerId: WORLD.MOSS.id,
    permissionProfileId: PROFILE_ID,
    instanceId: INSTANCE_ID,
    ...over,
  });

const APPROVAL_REQUEST: OpenRequest = {
  requestId: "req-1",
  itemId: "tool-1",
  kind: "command_approval",
  decisions: ["allow", "deny"],
  detail: { command: "git push" },
};

/**
 * A sidebar with something in every place: two projects, a worktree two
 * threads share, a main workspace, a thread with no workspace, and a thread
 * in no project. One thread waits on an approval, one works, two are idle and
 * one has exited. The threads are listed most recent first, as the controller
 * lists them.
 */
export const SIDEBAR_FIXTURE: SidebarRecords = {
  threads: [
    buildFixtureThread({
      id: FIXTURE_THREAD_IDS.runbook,
      title: "Write the retry runbook",
      status: "busy",
      openRequest: APPROVAL_REQUEST,
      projectId: WORLD.WEBSHOP_PROJECT.id,
      workspaceId: WORLD.THREAD_3F1.id,
      lastActivityAt: "2026-09-10T09:05:00.000Z",
    }),
    buildFixtureThread({
      id: FIXTURE_THREAD_IDS.flaky,
      title: "Fix flaky webhook tests",
      status: "busy",
      projectId: WORLD.WEBSHOP_PROJECT.id,
      workspaceId: WORLD.THREAD_3F1.id,
      lastActivityAt: "2026-09-10T09:04:00.000Z",
    }),
    buildFixtureThread({
      id: FIXTURE_THREAD_IDS.bunPin,
      title: "Bump the Bun pin",
      projectId: WORLD.WEBSHOP_PROJECT.id,
      workspaceId: WORLD.PRIMARY.id,
      lastActivityAt: "2026-09-10T09:03:00.000Z",
    }),
    buildFixtureThread({
      id: FIXTURE_THREAD_IDS.backupsKey,
      title: "Rotate the backups key",
      status: "exited",
      projectId: WORLD.OPS_PROJECT.id,
      exitedAt: "2026-09-10T09:02:00.000Z",
      lastActivityAt: "2026-09-10T09:02:00.000Z",
    }),
    buildFixtureThread({
      id: FIXTURE_THREAD_IDS.pricingPage,
      title: "Sketch the pricing page",
      lastActivityAt: "2026-09-10T09:01:00.000Z",
    }),
  ],
  projects: [WORLD.WEBSHOP_PROJECT, WORLD.OPS_PROJECT],
  workspaces: [{ ...WORLD.PRIMARY, sessionIds: [FIXTURE_THREAD_IDS.bunPin] }, WORLD.THREAD_3F1],
  resources: [WORLD.WEBSHOP, WORLD.INFRA, WORLD.RUNBOOKS],
  runners: [WORLD.MOSS],
  providers: [],
  username: "rogier",
};

/**
 * Stubs the global `fetch` for this test with one that responds from
 * `handlers`, keyed `METHOD /path`, and returns the calls it receives.
 *
 * Some reads answer by default, unless a handler says otherwise, because
 * every signed-in start makes them:
 *
 * - `GET /api/v1/setup` answers that setup is complete; the entry guard reads
 *   it on every start.
 * - `POST /api/v1/auth/ws-ticket` answers with a ticket, so the live
 *   connection opens.
 * - The sidebar's reads answer from `NO_SIDEBAR_RECORDS`.
 *
 * Any other unstubbed path returns 404, so a test that forgot a route notices.
 */
export const stubApi = (handlers: Readonly<Record<string, Handler>> = {}): readonly Call[] => {
  const calls: Call[] = [];
  const withDefaults: Readonly<Record<string, Handler>> = {
    "GET /api/v1/setup": { body: { complete: true } },
    "POST /api/v1/auth/ws-ticket": { body: { ticket: "ws-ticket" } },
    ...buildSidebarHandlers(NO_SIDEBAR_RECORDS),
    ...handlers,
  };
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit): Promise<Response> => {
    const request = new Request(url, init);
    const sent = await request.text();
    const address = new URL(url);
    const call: Call = {
      method: request.method,
      path: address.pathname,
      query: Object.fromEntries(address.searchParams),
      body: sent.length === 0 ? undefined : JSON.parse(sent),
      authorization: request.headers.get("authorization"),
    };
    calls.push(call);
    const handler = withDefaults[`${call.method} ${call.path}`];
    const answer: Answer =
      handler === undefined
        ? {
            status: 404,
            body: buildErrorBody("not_found", `no stub for ${call.method} ${call.path}`),
          }
        : typeof handler === "function"
          ? await Promise.race([handler(call), rejectOnAbort(init?.signal)])
          : handler;
    return new Response(JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  return calls;
};

/** The live connection of a rendered app, with the controller's end played by the test. */
export interface LiveStub {
  /** Returns the topics the app is subscribed to on its current socket, oldest first. */
  readonly readTopics: () => readonly string[];
  /** Checks whether the app's current socket is open. `false` before the app opens one. */
  readonly isConnected: () => boolean;
  /**
   * Sends the app an invalidation on its subscription to `topic`, naming `ids`
   * as updated. Throws when the app has no socket or no subscription to
   * `topic`.
   */
  readonly pushInvalidation: (topic: MutableLiveTopic, ids?: readonly string[]) => void;
  /** Closes the app's current socket from the controller's end, as a restart or a sleep does. */
  readonly drop: () => void;
}

/**
 * The live connections the current test's app built. A connection keeps its
 * keepalive and its reconnects running even after the app that started it
 * unmounts, so one left behind would still act during the next test.
 */
const started: Live[] = [];

afterEach(async () => {
  // Unmount the app first. Otherwise a navigation still in flight could mount
  // the shell after the stop and start a connection that nothing stops.
  cleanup();
  await Promise.all(started.splice(0).map((live) => live.stop()));
  vi.unstubAllGlobals();
});

/**
 * Stubs the global `WebSocket` for this test, builds the router context the
 * way `main.tsx` does with `fake` as the bridge, and returns the context with
 * a `LiveStub` for its live connection. The app builds its live connection
 * with no socket factory of its own, so the stub has to replace the global.
 */
const buildTestContext = async (
  fake: FakeBridge,
): Promise<{ readonly context: RouterContext; readonly live: LiveStub }> => {
  const sockets: StubSocket[] = [];
  const dial = stubWebSocketInto(sockets);
  // A function called with `new` that returns an object gives that object,
  // so `new WebSocket(url)` returns the stub.
  vi.stubGlobal("WebSocket", function (url: string) {
    return dial(url);
  });
  const context = await buildRouterContext(fake.bridge);
  if (context.controller !== null) started.push(context.controller.live);

  const readSocket = (): StubSocket => {
    const socket = sockets.at(-1);
    if (socket === undefined) throw new Error("the app has not opened a socket");
    return socket;
  };
  const live: LiveStub = {
    readTopics: () =>
      sockets
        .at(-1)
        ?.subscriptions()
        .map((each) => each.topic) ?? [],
    isConnected: () => sockets.at(-1)?.readyState === 1,
    pushInvalidation: (topic, ids = []) => {
      readSocket().push(topic, { _tag: "invalidate", ids, kind: "updated" });
    },
    drop: () => {
      readSocket().drop();
    },
  };
  return { context, live };
};

/** What `startApp` and `renderApp` return. */
export interface RenderedApp {
  readonly router: ReturnType<typeof createAppRouter>;
  readonly context: RouterContext;
  readonly live: LiveStub;
}

/**
 * Boots the app the way `main.tsx` does, with `fake` as the bridge, and
 * renders it at once, while the first navigation is still running. For a test
 * of what the window shows while the entry guard waits. Stub the API with
 * `stubApi` first.
 */
export const startApp = async (fake: FakeBridge): Promise<RenderedApp> => {
  const { context, live } = await buildTestContext(fake);
  const router = createAppRouter(context);
  render(<RouterProvider router={router} />);
  return { router, context, live };
};

/**
 * Boots the app the way `main.tsx` does, with `fake` as the bridge, and
 * renders it once the first navigation, entry guard included, has settled.
 * Stub the API with `stubApi` first.
 *
 * The app starts at `path`, `/` by default. A desktop window always starts at
 * `/`; another path lets a test open a screen, such as a thread at
 * `/threads/<id>`, without clicking its way there.
 */
export const renderApp = async (
  fake: FakeBridge,
  { path = "/" }: { readonly path?: string } = {},
): Promise<RenderedApp> => {
  const { context, live } = await buildTestContext(fake);
  const router = createAppRouter(context);
  if (path !== "/") router.history.replace(path);
  await router.load();
  render(<RouterProvider router={router} />);
  return { router, context, live };
};
