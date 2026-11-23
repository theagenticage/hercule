/**
 * Tests for the servers added by URL in Settings > MCP servers: the group
 * "Added by URL", the Add by URL dialog (the check, the token step and the
 * refusals), the Replace dialog a plugin's switch opens, and a URL server's
 * page with its sign-in. The words and the rules are decided in
 * `@hercule/client-core/mcp-servers`, which has its own tests. These tests
 * drive the screens through the real app and check what the user sees and
 * what is sent to the controller.
 */
import { describe, expect, it } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { McpServer } from "@hercule/contract";
import { buildConnection, buildPlugin } from "@hercule/client-core/mcp-servers/testing";
import {
  buildErrorBody,
  readPageText,
  renderApp,
  stubApi,
  type Call,
  type Handler,
} from "../../../../app/testing";
import { buildUrlServer } from "../../../../app/testing-mcp-servers";

const makeId = (kind: string, n: number): string =>
  `0199c0ff-${kind.repeat(4)}-7000-8000-${String(n).padStart(12, "0")}`;

const AT = "2026-11-20T09:00:00.000Z";
const TOOLS = [
  { name: "search_docs", description: "Search the documentation." },
  { name: "read_page", description: "Read one page." },
];

const SENTRY = buildPlugin("sentry", "Sentry");
const C_WORK = makeId("c", 1);
const CONNECTIONS = [buildConnection(C_WORK, "sentry/sentry", "work", "acct:work")];
const SENTRY_CONTRIBUTION = "sentry/sentry";

const S_DOCS = buildUrlServer(makeId("5", 1), "docs", "https://docs.acme.example/mcp");
const S_WIKI = buildUrlServer(makeId("5", 2), "wiki", "https://mcp.wiki.example/mcp", {
  status: "needs-sign-in",
  statusDetail: "The server asked for a sign-in",
  source: {
    kind: "url",
    url: "https://mcp.wiki.example/mcp",
    signIn: "none",
    signInOffered: "oauth",
  },
});
/** Two servers added by hand on the address the Sentry plugin offers. */
const S_HAND = buildUrlServer(makeId("5", 3), "sentry_hand", "https://mcp.sentry.example/mcp");
const S_HAND_TWO = buildUrlServer(
  makeId("5", 4),
  "sentry_two",
  "https://mcp.sentry.example/v2/mcp",
);
/** The server the stub controller creates for Add by URL. */
const NEW_ID = makeId("5", 90);
/** A server another client puts on the Sentry Connection while the user decides. */
const WINNER_ID = makeId("5", 91);

const P_WEBSHOP = makeId("a", 1);

/** What the stub controller holds. A test changes it to play a change made elsewhere. */
interface World {
  servers: McpServer[];
  plugins: unknown[];
  connections: unknown[];
}

const buildWorld = (servers: readonly McpServer[], overrides: Partial<World> = {}): World => ({
  servers: [...servers],
  plugins: [SENTRY],
  connections: CONNECTIONS,
  ...overrides,
});

const conflict = (message: string, details: unknown) => ({
  status: 409,
  body: { error: { code: "conflict", message, details } },
});

const replaceInWorld = (world: World, id: string, change: (server: McpServer) => McpServer) => {
  const index = world.servers.findIndex((server) => server.id === id);
  world.servers[index] = change(world.servers[index]!);
  return world.servers[index];
};

/** Builds the record `mcpServer.create` makes for `url`: still being checked. */
const buildCreated = (url: string, name: string): McpServer =>
  buildUrlServer(NEW_ID, name, url, { status: "checking", checkedAt: null, tools: [] });

/** Builds a stub controller over `world` that accepts the writes of these screens and applies them to `world`. */
const buildController = (
  world: World,
  extra: Readonly<Record<string, Handler>> = {},
): Readonly<Record<string, Handler>> => {
  const handlers: Record<string, Handler> = {
    "GET /api/v1/setup": { body: { complete: true } },
    "GET /api/v1/settings": {
      body: {
        controller: {},
        user: { "onboarding.completedSteps": ["timezone", "assistant"], "thread.mcpServerIds": [] },
      },
    },
    "GET /api/v1/plugins": () => ({ body: world.plugins }),
    "GET /api/v1/connections": () => ({ body: { items: world.connections } }),
    "GET /api/v1/projects": {
      body: {
        items: [
          {
            id: P_WEBSHOP,
            name: "webshop",
            mcpServerIds: [S_DOCS.id],
            createdAt: AT,
            updatedAt: AT,
          },
        ],
      },
    },
    "GET /api/v1/mcp-servers": () => ({ body: { items: world.servers } }),
    "POST /api/v1/mcp-servers": (call) => {
      const { source } = call.body as { source: { url: string } };
      const created = buildCreated(source.url, "created");
      world.servers.push(created);
      return { body: created };
    },
  };
  for (const id of [S_DOCS.id, S_WIKI.id, S_HAND.id, S_HAND_TWO.id, NEW_ID, WINNER_ID]) {
    const path = `/api/v1/mcp-servers/${id}`;
    handlers[`GET ${path}`] = () => {
      const found = world.servers.find((each) => each.id === id);
      return found === undefined
        ? { status: 404, body: buildErrorBody("not_found", "no such server") }
        : { body: found };
    };
    handlers[`PATCH ${path}`] = (call) => ({
      body: replaceInWorld(world, id, (server) => ({
        ...server,
        ...(call.body as Partial<McpServer>),
      })),
    });
    handlers[`POST ${path}/token`] = () => ({
      body: replaceInWorld(world, id, (server) => ({
        ...server,
        status: "checking",
        statusDetail: null,
      })),
    });
    handlers[`POST ${path}/check`] = { body: {} };
  }
  return { ...handlers, ...extra };
};

const openApp = async (
  path: string,
  world: World,
  extra: Readonly<Record<string, Handler>> = {},
) => {
  const api = stubApi(buildController(world, extra));
  const app = await renderApp({ path, api: api.fetch, token: "held" });
  return { ...app, api, world };
};

const openList = (world: World, extra?: Readonly<Record<string, Handler>>) =>
  openApp("/settings/mcp-servers", world, extra);

const listWrites = (api: { readonly calls: readonly Call[] }) =>
  api.calls.filter((call) => call.method !== "GET" && !call.path.endsWith("/auth/ws-ticket"));

/** Finds the row of the group "Added by URL" or "From your Connections" whose switch is named `name`. */
const findRow = async (name: string): Promise<HTMLElement> =>
  (await screen.findByRole("switch", { name })).closest("li")!;

/** Pushes that the server `id` changed, once the screen holds the live topic. */
const pushChange = async (
  live: { topics(): readonly string[]; push(topic: string, message: unknown): void },
  id: string,
): Promise<void> => {
  await waitFor(() => {
    expect(live.topics()).toContain("mcpServer");
  });
  act(() => {
    live.push("mcpServer", { _tag: "invalidate", ids: [id], kind: "updated" });
  });
};

/** Opens the Add by URL dialog and returns it. */
const openAddDialog = async (user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> => {
  await user.click(await screen.findByRole("button", { name: "Add by URL" }));
  return screen.findByRole("dialog", { name: "Add an MCP server by URL" });
};

describe("Settings > MCP servers > Added by URL", () => {
  it("lists each server with its whole address and tool count, its status and the projects that name it", async () => {
    await openList(buildWorld([S_WIKI, S_DOCS]));

    const docs = await findRow("Offer docs to threads");
    expect(readPageText(docs)).toContain("docs");
    expect(readPageText(docs)).toContain("https://docs.acme.example/mcp · 2 tools");
    expect(readPageText(docs)).toContain("ready");
    expect(readPageText(docs)).toContain("webshop");
    // The account of a server added by URL is its address: it is not printed beside the name.
    expect(readPageText(docs)).not.toMatch(/docs https:/);
    expect(docs.querySelector("svg")).not.toBeNull();

    const wiki = readPageText(await findRow("Offer wiki to threads"));
    expect(wiki).toContain("needs sign-in");
    expect(wiki).toContain("None");
    // Rows are ordered by name.
    expect(screen.getAllByRole("switch").map((each) => each.getAttribute("aria-label"))).toEqual([
      "Offer sentry work to threads",
      "Offer docs to threads",
      "Offer wiki to threads",
    ]);
    expect(readPageText()).toContain("Any remote MCP server, signed in once on the controller");
    expect(screen.getByRole("button", { name: "Add by URL" })).toBeTruthy();
  });

  it("shows the empty block when no server was added", async () => {
    await openList(buildWorld([]));

    expect(await screen.findByText("None added")).toBeTruthy();
    expect(readPageText()).toContain("Add any remote MCP server by its address.");
  });

  it("switches a server added by URL with an update of its own", async () => {
    const user = userEvent.setup();
    const { api } = await openList(buildWorld([S_DOCS]));

    await user.click(within(await findRow("Offer docs to threads")).getByRole("switch"));

    await waitFor(() => {
      expect(listWrites(api).map((call) => [call.method, call.path, call.body])).toEqual([
        ["PATCH", `/api/v1/mcp-servers/${S_DOCS.id}`, { enabled: false }],
      ]);
    });
  });
});

describe("Settings > MCP servers > Add by URL", () => {
  it("suggests the name, sends only the address, and ends with the tools when no sign-in is needed", async () => {
    const user = userEvent.setup();
    const world = buildWorld([]);
    const { api, live } = await openList(world);

    const dialog = await openAddDialog(user);
    await user.type(within(dialog).getByLabelText("Address"), "https://mcp.deepwiki.example/mcp");
    expect(within(dialog).getByLabelText<HTMLInputElement>("Name").value).toBe("deepwiki");
    expect(readPageText(dialog)).toContain("Agents see its tools as mcp__tools__deepwiki__<tool>");
    // The address is shown whole everywhere, so the form says where a key goes before it is typed.
    expect(readPageText(dialog)).toContain(
      "If it needs a key, leave it out of the address: the next step asks for it in a token field.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Check server" }));

    // The user did not change the suggestion, so the controller chooses the name.
    await waitFor(() => {
      expect(listWrites(api).map((call) => [call.method, call.path, call.body])).toEqual([
        [
          "POST",
          "/api/v1/mcp-servers",
          { source: { kind: "url", url: "https://mcp.deepwiki.example/mcp" } },
        ],
      ]);
    });
    await within(dialog).findByText("Checking: asking the server for its tools.");

    replaceInWorld(world, NEW_ID, (server) => ({
      ...server,
      name: "deepwiki",
      status: "ready",
      checkedAt: AT,
      tools: TOOLS,
    }));
    await pushChange(live, NEW_ID);

    await within(dialog).findByText(/ready · 2 tools/);
    expect(readPageText(dialog)).toContain("search_docs");
    expect(readPageText(dialog)).toContain("No project names it yet.");
    expect(within(dialog).getByRole("link", { name: "Open deepwiki" }).getAttribute("href")).toBe(
      `/settings/mcp-servers/${NEW_ID}`,
    );

    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await findRow("Offer deepwiki to threads")).toBeTruthy();
  });

  it.each([
    ["unreachable", "slow.example could not be reached."],
    ["error", "slow.example answered in a way Hercule could not use."],
  ] as const)(
    "words a check that ended %s from the server's host, and checks again without waiting for a push",
    async (status, headline) => {
      const user = userEvent.setup();
      const world = buildWorld([]);
      const { api, live } = await openList(world, {
        [`POST /api/v1/mcp-servers/${NEW_ID}/check`]: () => {
          replaceInWorld(world, NEW_ID, (server) => ({
            ...server,
            status: "checking",
            statusDetail: null,
          }));
          return { body: {} };
        },
      });
      const dialog = await openAddDialog(user);
      await user.type(within(dialog).getByLabelText("Address"), "https://slow.example/mcp");
      await user.click(within(dialog).getByRole("button", { name: "Check server" }));
      await within(dialog).findByText("Checking: asking the server for its tools.");
      replaceInWorld(world, NEW_ID, (server) => ({
        ...server,
        status,
        statusDetail: "connection refused",
      }));
      await pushChange(live, NEW_ID);

      const failure = await within(dialog).findByRole("alert");
      expect(readPageText(failure)).toBe(`${headline} connection refused`);
      // A failed check leads to the server's page as well: it is a new server in the list.
      expect(within(dialog).getByRole("link", { name: "Open created" })).toBeTruthy();

      // The push is held: the dialog shows the new check from its own reads.
      await user.click(within(dialog).getByRole("button", { name: "Check now" }));
      await within(dialog).findByText("Checking: asking the server for its tools.");
      expect(api.calls.filter((call) => call.path.endsWith(`${NEW_ID}/check`))).toHaveLength(1);
    },
  );

  it("sends the name the user typed, and keeps it when the address changes", async () => {
    const user = userEvent.setup();
    const { api } = await openList(buildWorld([]));

    const dialog = await openAddDialog(user);
    await user.type(within(dialog).getByLabelText("Address"), "https://a.example/mcp");
    const name = within(dialog).getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "mine");
    await user.type(within(dialog).getByLabelText("Address"), "x");
    expect((name as HTMLInputElement).value).toBe("mine");
    await user.click(within(dialog).getByRole("button", { name: "Check server" }));

    await waitFor(() => {
      expect(listWrites(api)[0]?.body).toEqual({
        source: { kind: "url", url: "https://a.example/mcp" + "x", name: "mine" },
      });
    });
  });

  it("asks for a token, refuses one that is too short before sending, and saves a good one", async () => {
    const user = userEvent.setup();
    const world = buildWorld([]);
    const { api, live } = await openList(world, {
      "POST /api/v1/mcp-servers": () => {
        const created = {
          ...buildCreated("https://docs.acme.example/mcp", "acme"),
          status: "needs-sign-in" as const,
          statusDetail: "The server wants a token",
          source: {
            kind: "url" as const,
            url: "https://docs.acme.example/mcp",
            signIn: "none" as const,
            signInOffered: "token" as const,
          },
        };
        world.servers.push(created);
        return { body: created };
      },
    });

    const dialog = await openAddDialog(user);
    await user.type(within(dialog).getByLabelText("Address"), "https://docs.acme.example/mcp");
    await user.click(within(dialog).getByRole("button", { name: "Check server" }));

    const field = await within(dialog).findByLabelText("Token");
    expect(readPageText(dialog)).toContain("This server needs a token.");
    expect(readPageText(dialog)).toContain("Kept on the controller. It never reaches a runner.");
    expect(field.getAttribute("type")).toBe("password");

    await user.type(field, "short");
    await user.click(within(dialog).getByRole("button", { name: "Save token" }));
    expect(await within(dialog).findByText(/at least 8 printable characters/)).toBeTruthy();
    expect(listWrites(api).filter((call) => call.path.endsWith("/token"))).toHaveLength(0);

    await user.clear(field);
    await user.type(field, "abc12345-xyz");
    await user.click(within(dialog).getByRole("button", { name: "Save token" }));
    await waitFor(() => {
      expect(
        listWrites(api)
          .filter((call) => call.path.endsWith("/token"))
          .map((call) => call.body),
      ).toEqual([{ token: "abc12345-xyz" }]);
    });

    replaceInWorld(world, NEW_ID, (server) => ({
      ...server,
      status: "ready",
      statusDetail: null,
      checkedAt: AT,
      tools: TOOLS,
    }));
    await pushChange(live, NEW_ID);
    await within(dialog).findByText(/ready · 2 tools/);
    // The token lives in the form alone: it is not on the page any more.
    expect(readPageText()).not.toContain("abc12345-xyz");
    expect(within(dialog).queryByLabelText("Token")).toBeNull();
  });

  it("shows the token form again, with the server's reason, when the server refuses the token", async () => {
    const user = userEvent.setup();
    const world = buildWorld([
      { ...S_DOCS, status: "needs-sign-in", statusDetail: "No token yet" },
    ]);
    const { api, live } = await openApp(`/settings/mcp-servers/${S_DOCS.id}`, world);

    await user.click(await screen.findByRole("button", { name: "Sign in…" }));
    const dialog = await screen.findByRole("dialog", { name: "Sign in to docs" });
    await user.type(within(dialog).getByLabelText("Token"), "wrong-token-1");
    await user.click(within(dialog).getByRole("button", { name: "Save token" }));
    await waitFor(() => {
      expect(api.calls.some((call) => call.path.endsWith("/token"))).toBe(true);
    });

    replaceInWorld(world, S_DOCS.id, (server) => ({
      ...server,
      status: "needs-sign-in",
      statusDetail: "The server refused the token",
    }));
    await pushChange(live, S_DOCS.id);

    expect(await within(dialog).findByText("The server refused the token")).toBeTruthy();
    expect(within(dialog).getByLabelText<HTMLInputElement>("Token").value).toBe("");
    expect(readPageText(dialog)).toContain("The server refused its token. Paste a new one.");
  });

  it("keeps the heading the sign-in dialog opened with when the server moves onto a Connection meanwhile", async () => {
    const user = userEvent.setup();
    const world = buildWorld([
      { ...S_DOCS, status: "needs-sign-in", statusDetail: "No token yet" },
    ]);
    const { live } = await openApp(`/settings/mcp-servers/${S_DOCS.id}`, world);
    await user.click(await screen.findByRole("button", { name: "Sign in…" }));
    await screen.findByRole("dialog", { name: "Sign in to docs" });

    replaceInWorld(world, S_DOCS.id, (server) => ({
      ...server,
      enabled: true,
      status: "ready",
      statusDetail: null,
      source: { kind: "plugin", contributionId: SENTRY_CONTRIBUTION, connectionId: C_WORK },
    }));
    await pushChange(live, S_DOCS.id);

    expect(
      await within(screen.getByRole("dialog")).findByText(/is reached with a Connection now/),
    ).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Sign in to docs" })).toBeTruthy();
  });

  it("opens 'Replace token…' on the token field, also when the server offers the browser", async () => {
    const user = userEvent.setup();
    const holdsToken = buildUrlServer(S_DOCS.id, "docs", "https://docs.acme.example/mcp", {
      source: {
        kind: "url",
        url: "https://docs.acme.example/mcp",
        signIn: "token",
        signInOffered: "oauth",
      },
    });
    await openApp(`/settings/mcp-servers/${S_DOCS.id}`, buildWorld([holdsToken]));

    await user.click(await screen.findByRole("button", { name: "Replace token…" }));

    const dialog = await screen.findByRole("dialog", { name: "Sign in to docs" });
    expect(within(dialog).getByLabelText<HTMLInputElement>("Token").value).toBe("");
    expect(readPageText(dialog)).toContain(
      "Paste a new token. It replaces the one this server holds.",
    );
    expect(within(dialog).queryByText("This server signs in through your browser.")).toBeNull();
  });

  it("asks for the token again, not for the browser, when the server refuses a pasted token and still offers the browser", async () => {
    const user = userEvent.setup();
    const world = buildWorld([S_WIKI]);
    const { live } = await openApp(`/settings/mcp-servers/${S_WIKI.id}`, world, {
      [`POST /api/v1/mcp-servers/${S_WIKI.id}/token`]: () => ({
        body: replaceInWorld(world, S_WIKI.id, (server) => ({
          ...server,
          status: "checking",
          statusDetail: null,
          source: { ...server.source, signIn: "token" } as McpServer["source"],
        })),
      }),
    });
    await user.click(await screen.findByRole("button", { name: "Sign in…" }));
    const dialog = await screen.findByRole("dialog", { name: "Sign in to wiki" });
    await user.click(within(dialog).getByRole("button", { name: "Paste a token instead" }));
    await user.type(within(dialog).getByLabelText("Token"), "wrong-token-1");
    await user.click(within(dialog).getByRole("button", { name: "Save token" }));
    await within(dialog).findByText("Checking: asking the server for its tools.");

    replaceInWorld(world, S_WIKI.id, (server) => ({
      ...server,
      status: "needs-sign-in",
      statusDetail: "The server refused the token",
    }));
    await pushChange(live, S_WIKI.id);

    expect(await within(dialog).findByText("The server refused the token")).toBeTruthy();
    expect(within(dialog).getByLabelText<HTMLInputElement>("Token").value).toBe("");
    expect(readPageText(dialog)).toContain("The server refused its token. Paste a new one.");
  });

  it("goes back to the browser choice when a sign-in through the browser is refused by the check", async () => {
    const user = userEvent.setup();
    const world = buildWorld([S_WIKI]);
    const { live } = await openApp(`/settings/mcp-servers/${S_WIKI.id}`, world, {
      [`POST /api/v1/mcp-servers/${S_WIKI.id}/sign-in`]: {
        body: {
          authorizationUrl: "https://auth.wiki.example/authorize?state=abc123",
          expiresAt: "2026-11-23T10:10:00.000Z",
        },
      },
      [`POST /api/v1/mcp-servers/${S_WIKI.id}/sign-in/finish`]: () => ({
        body: replaceInWorld(world, S_WIKI.id, (server) => ({
          ...server,
          status: "checking",
          source: { ...server.source, signIn: "oauth" } as McpServer["source"],
        })),
      }),
    });
    await user.click(await screen.findByRole("button", { name: "Sign in…" }));
    const dialog = await screen.findByRole("dialog", { name: "Sign in to wiki" });
    await user.click(within(dialog).getByRole("button", { name: "Sign in with your browser" }));
    await user.type(
      await within(dialog).findByLabelText("Address the browser ended on"),
      "http://127.0.0.1:50000/callback?code=the-code&state=abc123",
    );
    await user.click(within(dialog).getByRole("button", { name: "Finish sign-in" }));
    await within(dialog).findByText("Checking: asking the server for its tools.");

    replaceInWorld(world, S_WIKI.id, (server) => ({
      ...server,
      status: "needs-sign-in",
      statusDetail: "The server did not accept the sign-in",
    }));
    await pushChange(live, S_WIKI.id);

    expect(
      await within(dialog).findByRole("button", { name: "Sign in with your browser" }),
    ).toBeTruthy();
    expect(within(dialog).queryByLabelText("Token")).toBeNull();
  });

  it("offers the browser first for a server that signs in through it, and the pasted token as the quieter other way", async () => {
    const user = userEvent.setup();
    const world = buildWorld([S_WIKI]);
    await openApp(`/settings/mcp-servers/${S_WIKI.id}`, world);

    expect(readPageText(await screen.findByRole("status"))).toContain(
      "Sign in through your browser, or paste a token, and this server comes back with it.",
    );
    await user.click(screen.getByRole("button", { name: "Sign in…" }));
    const dialog = await screen.findByRole("dialog", { name: "Sign in to wiki" });

    expect(readPageText(dialog)).toContain("This server signs in through your browser.");
    expect(within(dialog).getByRole("button", { name: "Sign in with your browser" })).toBeTruthy();
    expect(within(dialog).queryByLabelText("Token")).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Paste a token instead" }));
    expect(readPageText(dialog)).toContain("Paste a token, if the service gives you one.");
    expect(within(dialog).getByLabelText("Token")).toBeTruthy();
  });

  describe("the sign-in through the browser", () => {
    const SIGN_IN_URL = "https://auth.wiki.example/authorize?state=abc123&client_id=x";
    const WIKI_PATH = `/api/v1/mcp-servers/${S_WIKI.id}`;
    const invalidState = (reason: string, message: string) => ({
      status: 409,
      body: { error: { code: "invalid_state", message, details: { reason } } },
    });
    const startsSignIn: Readonly<Record<string, Handler>> = {
      [`POST ${WIKI_PATH}/sign-in`]: {
        body: { authorizationUrl: SIGN_IN_URL, expiresAt: "2026-11-23T10:10:00.000Z" },
      },
    };
    const signInCalls = (api: { readonly calls: readonly Call[] }, suffix: string) =>
      listWrites(api).filter((call) => call.path.endsWith(suffix));

    /** Opens the wiki page's dialog and starts the sign-in, and returns the dialog. */
    const startSignIn = async (
      user: ReturnType<typeof userEvent.setup>,
      extra: Readonly<Record<string, Handler>> = {},
      world = buildWorld([S_WIKI]),
    ) => {
      const opened = await openApp(`/settings/mcp-servers/${S_WIKI.id}`, world, {
        ...startsSignIn,
        ...extra,
      });
      await user.click(await screen.findByRole("button", { name: "Sign in…" }));
      const dialog = await screen.findByRole("dialog", { name: "Sign in to wiki" });
      await user.click(within(dialog).getByRole("button", { name: "Sign in with your browser" }));
      await within(dialog).findByText("Finish in your browser");
      return { ...opened, dialog };
    };

    it("starts with an address nothing listens on, names who approves, links the sign-in page, and finishes with the pasted address", async () => {
      const user = userEvent.setup();
      const world = buildWorld([S_WIKI]);
      const { api, dialog, live } = await startSignIn(
        user,
        {
          [`POST ${WIKI_PATH}/sign-in/finish`]: () => ({
            body: replaceInWorld(world, S_WIKI.id, (server) => ({
              ...server,
              status: "checking",
              source: { ...server.source, signIn: "oauth" } as McpServer["source"],
            })),
          }),
        },
        world,
      );

      const [start] = signInCalls(api, "/sign-in");
      expect((start!.body as { redirectUri: string }).redirectUri).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
      );
      expect(readPageText(dialog)).toContain("You will approve on auth.wiki.example.");
      const link = within(dialog).getByRole("link", { name: "Open the sign-in page" });
      expect(link.getAttribute("href")).toBe(SIGN_IN_URL);
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toContain("noopener");

      const field = within(dialog).getByLabelText("Address the browser ended on");
      await user.type(field, "https://example.com/nothing");
      await user.click(within(dialog).getByRole("button", { name: "Finish sign-in" }));
      expect(await within(dialog).findByText(/That is not what the browser ended on/)).toBeTruthy();
      expect(signInCalls(api, "/sign-in/finish")).toHaveLength(0);

      await user.clear(field);
      await user.type(field, "http://127.0.0.1:50000/callback?code=the-code&state=abc123");
      await user.click(within(dialog).getByRole("button", { name: "Finish sign-in" }));
      await waitFor(() => {
        expect(signInCalls(api, "/sign-in/finish").map((call) => call.body)).toEqual([
          { callbackQuery: "http://127.0.0.1:50000/callback?code=the-code&state=abc123" },
        ]);
      });

      replaceInWorld(world, S_WIKI.id, (server) => ({
        ...server,
        status: "ready",
        statusDetail: null,
        checkedAt: AT,
        tools: TOOLS,
      }));
      await pushChange(live, S_WIKI.id);
      expect(await within(dialog).findByText(/ready · 2 tools/)).toBeTruthy();
      // Nothing of the sign-in stays on the page: not the code, and not the pasted address.
      expect(readPageText()).not.toContain("the-code");
    });

    it("draws who approves in the same render as the link to the sign-in page, so the host is there before the link can be followed", async () => {
      const user = userEvent.setup();
      const world = buildWorld([S_WIKI]);
      await openApp(`/settings/mcp-servers/${S_WIKI.id}`, world, startsSignIn);
      await user.click(await screen.findByRole("button", { name: "Sign in…" }));
      const dialog = await screen.findByRole("dialog", { name: "Sign in to wiki" });

      // Records, at every change of the page, whether the link is there and the host with it.
      const seen: { link: boolean; host: boolean }[] = [];
      const observer = new MutationObserver(() => {
        seen.push({
          link: document.querySelector(`a[href="${SIGN_IN_URL}"]`) !== null,
          host: readPageText(dialog).includes("You will approve on auth.wiki.example."),
        });
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      await user.click(within(dialog).getByRole("button", { name: "Sign in with your browser" }));
      await within(dialog).findByRole("link", { name: "Open the sign-in page" });
      observer.disconnect();

      expect(seen.some((each) => each.link)).toBe(true);
      expect(seen.filter((each) => each.link && !each.host)).toEqual([]);
    });

    it("keeps waiting, with the controller's words, when it finds the pasted address is for another redirect", async () => {
      const user = userEvent.setup();
      const { dialog } = await startSignIn(user, {
        [`POST ${WIKI_PATH}/sign-in/finish`]: {
          status: 400,
          body: buildErrorBody("validation", "The address is for another sign-in."),
        },
      });

      await user.type(
        within(dialog).getByLabelText("Address the browser ended on"),
        "code=the-code&state=abc123",
      );
      await user.click(within(dialog).getByRole("button", { name: "Finish sign-in" }));

      expect(await within(dialog).findByText("The address is for another sign-in.")).toBeTruthy();
      expect(within(dialog).getByText("Finish in your browser")).toBeTruthy();
    });

    it.each([
      [
        "sign-in-expired",
        "This sign-in ran out, or another one for this server replaced it. Start again.",
      ],
      [
        "sign-in-refused",
        "The browser or the provider refused the sign-in. Nothing was changed. You can start again.",
      ],
      [
        "source-unreadable",
        "The server or its sign-in service could not be reached. Try again later.",
      ],
    ])("says %s, and starts again from the refusal", async (reason, message) => {
      const user = userEvent.setup();
      const { api, dialog } = await startSignIn(user, {
        [`POST ${WIKI_PATH}/sign-in/finish`]: invalidState(reason, "The controller's words."),
      });

      await user.type(
        within(dialog).getByLabelText("Address the browser ended on"),
        "code=the-code&state=abc123",
      );
      await user.click(within(dialog).getByRole("button", { name: "Finish sign-in" }));

      expect((await within(dialog).findByRole("alert")).textContent).toBe(message);
      await user.click(within(dialog).getByRole("button", { name: "Start again" }));
      await within(dialog).findByText("Finish in your browser");
      expect(signInCalls(api, "/sign-in")).toHaveLength(2);
    });

    it("goes back to the token field, saying only a token works, when the server allows no sign-in through the browser", async () => {
      const user = userEvent.setup();
      const { dialog } = await startSignIn(user, {
        [`POST ${WIKI_PATH}/sign-in/finish`]: invalidState("sign-in-unsupported", "No."),
      });

      await user.type(
        within(dialog).getByLabelText("Address the browser ended on"),
        "code=the-code&state=abc123",
      );
      await user.click(within(dialog).getByRole("button", { name: "Finish sign-in" }));

      expect(await within(dialog).findByLabelText("Token")).toBeTruthy();
      expect(readPageText(dialog)).toContain(
        "This server does not allow a sign-in through the browser. Paste a token instead.",
      );
      expect(
        within(dialog).queryByRole("button", { name: "Sign in with your browser" }),
      ).toBeNull();
    });

    it("returns to the form on Cancel, and a refused start says why", async () => {
      const user = userEvent.setup();
      const { dialog } = await startSignIn(user);

      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

      expect(
        within(dialog).getByRole("button", { name: "Sign in with your browser" }),
      ).toBeTruthy();
    });

    it("says a start the controller refused, and offers Start again", async () => {
      const user = userEvent.setup();
      const world = buildWorld([S_WIKI]);
      await openApp(`/settings/mcp-servers/${S_WIKI.id}`, world, {
        [`POST ${WIKI_PATH}/sign-in`]: invalidState("source-unreadable", "unreachable"),
      });
      await user.click(await screen.findByRole("button", { name: "Sign in…" }));
      const dialog = await screen.findByRole("dialog", { name: "Sign in to wiki" });

      await user.click(within(dialog).getByRole("button", { name: "Sign in with your browser" }));

      expect((await within(dialog).findByRole("alert")).textContent).toContain("Try again later.");
      expect(within(dialog).getByRole("button", { name: "Start again" })).toBeTruthy();
    });

    it("offers 'Sign in again…' on the page of a server that holds an OAuth sign-in, and opens the same dialog", async () => {
      const user = userEvent.setup();
      const oauth = buildUrlServer(S_WIKI.id, "wiki", "https://mcp.wiki.example/mcp", {
        source: {
          kind: "url",
          url: "https://mcp.wiki.example/mcp",
          signIn: "oauth",
          signInOffered: "oauth",
        },
      });
      await openApp(`/settings/mcp-servers/${S_WIKI.id}`, buildWorld([oauth]));

      await user.click(await screen.findByRole("button", { name: "Sign in again…" }));

      const dialog = await screen.findByRole("dialog", { name: "Sign in to wiki" });
      expect(
        within(dialog).getByRole("button", { name: "Sign in with your browser" }),
      ).toBeTruthy();
    });
  });

  it("keeps a server the check created when the dialog is closed", async () => {
    const user = userEvent.setup();
    const world = buildWorld([]);
    await openList(world);

    const dialog = await openAddDialog(user);
    await user.type(within(dialog).getByLabelText("Address"), "https://slow.example/mcp");
    await user.click(within(dialog).getByRole("button", { name: "Check server" }));
    await within(dialog).findByText(/The server stays in the list\./);
    await user.click(within(dialog).getByRole("button", { name: "Close" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await findRow("Offer created to threads")).toBeTruthy();
  });

  it("refuses an address that was added before, and leads to that server", async () => {
    const user = userEvent.setup();
    await openList(buildWorld([S_DOCS]), {
      "POST /api/v1/mcp-servers": conflict("That address is added already.", {
        reason: "mcp-server-exists",
        mcpServerId: S_DOCS.id,
      }),
    });

    const dialog = await openAddDialog(user);
    await user.type(within(dialog).getByLabelText("Address"), "https://docs.acme.example/mcp");
    await user.click(within(dialog).getByRole("button", { name: "Check server" }));

    const refusal = await within(dialog).findByRole("alert");
    await waitFor(() => {
      expect(readPageText(refusal)).toContain(
        "You added this server before, as docs. One address is one server.",
      );
    });
    const open = within(refusal).getByRole("link", { name: "Open docs" });
    expect(open.getAttribute("href")).toBe(`/settings/mcp-servers/${S_DOCS.id}`);

    // The refusal belongs to the address that was sent: another address clears it.
    await user.type(within(dialog).getByLabelText("Address"), "2");
    expect(within(dialog).queryByRole("alert")).toBeNull();
  });

  it("takes the button away from a duplicate refusal once that server is deleted", async () => {
    const user = userEvent.setup();
    const world = buildWorld([S_DOCS]);
    const { live } = await openList(world, {
      "POST /api/v1/mcp-servers": conflict("That address is added already.", {
        reason: "mcp-server-exists",
        mcpServerId: S_DOCS.id,
      }),
    });
    const dialog = await openAddDialog(user);
    await user.type(within(dialog).getByLabelText("Address"), "https://docs.acme.example/mcp");
    await user.click(within(dialog).getByRole("button", { name: "Check server" }));
    const refusal = await within(dialog).findByRole("alert");
    await within(refusal).findByRole("link", { name: "Open docs" });

    world.servers = world.servers.filter((server) => server.id !== S_DOCS.id);
    await pushChange(live, S_DOCS.id);

    await waitFor(() => {
      expect(within(dialog).queryByRole("link", { name: "Open docs" })).toBeNull();
    });
    expect(within(dialog).getByRole("alert")).toBeTruthy();
  });

  it("refuses an address a plugin offers, and shows the row of that offer in the list", async () => {
    const user = userEvent.setup();
    await openList(buildWorld([]), {
      "POST /api/v1/mcp-servers": conflict("A plugin offers it.", {
        reason: "mcp-server-on-plugin-origin",
        contributionId: SENTRY_CONTRIBUTION,
        connectionId: C_WORK,
        pluginState: "active",
      }),
    });

    const dialog = await openAddDialog(user);
    await user.type(within(dialog).getByLabelText("Address"), "https://mcp.sentry.example/mcp");
    await user.click(within(dialog).getByRole("button", { name: "Check server" }));

    const refusal = await within(dialog).findByRole("alert");
    expect(readPageText(refusal)).toContain(
      "The Sentry plugin already offers this server. It is reached with a Sentry Connection, with no second sign-in, so it is not added by hand.",
    );
    await user.click(within(refusal).getByRole("button", { name: "Show Sentry · work" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(
      (await findRow("Offer sentry work to threads")).querySelector("[role=switch]"),
    );
  });

  it.each([
    {
      case: "the user has no Connection of the plugin's type",
      world: () => buildWorld([], { connections: [] }),
      pluginState: "active",
      button: "Open Connections",
      href: "/connections",
    },
    {
      case: "the plugin is switched off",
      world: () => buildWorld([], { plugins: [{ ...SENTRY, enabled: false }] }),
      pluginState: "switched-off",
      button: "Open Plugins",
      href: "/settings/plugins",
    },
  ])("sends the user to $href for a plugin refusal when $case", async (scenario) => {
    const user = userEvent.setup();
    await openList(scenario.world(), {
      "POST /api/v1/mcp-servers": conflict("A plugin offers it.", {
        reason: "mcp-server-on-plugin-origin",
        contributionId: SENTRY_CONTRIBUTION,
        connectionId: null,
        pluginState: scenario.pluginState,
      }),
    });

    const dialog = await openAddDialog(user);
    await user.type(within(dialog).getByLabelText("Address"), "https://mcp.sentry.example/mcp");
    await user.click(within(dialog).getByRole("button", { name: "Check server" }));

    const refusal = await within(dialog).findByRole("alert");
    expect(within(refusal).getByRole("link", { name: scenario.button }).getAttribute("href")).toBe(
      scenario.href,
    );
  });
});

describe("Settings > MCP servers > Replace", () => {
  const SENTRY_SOURCE = {
    kind: "plugin",
    contributionId: SENTRY_CONTRIBUTION,
    connectionId: C_WORK,
  };

  it("asks before it replaces the one server added by hand, then moves it onto the Connection in one write", async () => {
    const user = userEvent.setup();
    const world = buildWorld([S_HAND]);
    const { api } = await openList(world);

    await user.click(within(await findRow("Offer sentry work to threads")).getByRole("switch"));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading").textContent).toBe(
      "Replace the sentry_hand server you added?",
    );
    expect(readPageText(dialog)).toContain(
      "You added https://mcp.sentry.example/mcp by hand, with a sign-in of its own. Sentry · work reaches the same server, and one address and account is one server.",
    );
    expect(readPageText(dialog)).toContain("Stays: the name and the projects that name it.");
    expect(readPageText(dialog)).toContain("Changes: it acts through the Connection.");
    expect(readPageText(dialog)).toContain("Goes: the sign-in made by hand.");
    // Asking writes nothing.
    expect(listWrites(api)).toHaveLength(0);

    await user.click(within(dialog).getByRole("button", { name: "Replace" }));

    await waitFor(() => {
      expect(listWrites(api).map((call) => [call.method, call.path, call.body])).toEqual([
        ["PATCH", `/api/v1/mcp-servers/${S_HAND.id}`, { source: SENTRY_SOURCE, enabled: true }],
      ]);
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    // The server keeps its name and is the Connection's now: its row is switched on and the group of servers added by hand is empty.
    expect(
      (await findRow("Offer sentry_hand work to threads"))
        .querySelector("[role=switch]")!
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(await screen.findByText("None added")).toBeTruthy();
  });

  it("asks which server to replace when several sit on the address, and writes to the chosen one", async () => {
    const user = userEvent.setup();
    const { api } = await openList(buildWorld([S_HAND, S_HAND_TWO]));

    await user.click(within(await findRow("Offer sentry work to threads")).getByRole("switch"));

    const dialog = await screen.findByRole("dialog");
    const choices = within(dialog).getAllByRole("radio");
    expect(choices).toHaveLength(2);
    expect(readPageText(dialog)).toContain("https://mcp.sentry.example/v2/mcp");
    await user.click(within(dialog).getByRole("radio", { name: /sentry_two/ }));
    expect(readPageText(dialog)).toContain("Replace the sentry_two server you added?");
    await user.click(within(dialog).getByRole("button", { name: "Replace" }));

    await waitFor(() => {
      expect(listWrites(api).map((call) => call.path)).toEqual([
        `/api/v1/mcp-servers/${S_HAND_TWO.id}`,
      ]);
    });
  });

  it("shows the refusal and a link to the winner when the controller says the Connection's server exists", async () => {
    const user = userEvent.setup();
    const { api } = await openList(buildWorld([S_HAND, S_DOCS]), {
      [`PATCH /api/v1/mcp-servers/${S_HAND.id}`]: conflict("Another server holds it.", {
        reason: "mcp-server-exists",
        mcpServerId: S_DOCS.id,
      }),
    });

    await user.click(within(await findRow("Offer sentry work to threads")).getByRole("switch"));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Replace" }));

    const alert = await within(dialog).findByRole("alert");
    expect(readPageText(alert)).toContain("Nothing was replaced.");
    expect(within(alert).getByRole("link", { name: "Open docs" }).getAttribute("href")).toBe(
      `/settings/mcp-servers/${S_DOCS.id}`,
    );
    expect(listWrites(api)).toHaveLength(1);
  });

  /** The server another client put on the Sentry Connection. */
  const buildWinner = (): McpServer =>
    buildUrlServer(WINNER_ID, "sentry_win", "https://mcp.sentry.example/mcp", {
      source: SENTRY_SOURCE as McpServer["source"],
    });

  it("stays with the refusal and a link when another server takes the Connection while the user is choosing", async () => {
    const user = userEvent.setup();
    const world = buildWorld([S_HAND, S_HAND_TWO]);
    const { api, live } = await openList(world);
    await user.click(within(await findRow("Offer sentry work to threads")).getByRole("switch"));
    const dialog = await screen.findByRole("dialog");

    world.servers.push(buildWinner());
    await pushChange(live, WINNER_ID);

    const alert = await within(dialog).findByRole("alert");
    expect(readPageText(alert)).toContain("Nothing was replaced.");
    expect(within(alert).getByRole("link", { name: "Open sentry_win" }).getAttribute("href")).toBe(
      `/settings/mcp-servers/${WINNER_ID}`,
    );
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(listWrites(api)).toHaveLength(0);
  });

  it("keeps the confirmed server selected and the dialog open when another server wins while the write is held", async () => {
    const user = userEvent.setup();
    const world = buildWorld([S_HAND, S_HAND_TWO]);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { api, live } = await openList(world, {
      [`PATCH /api/v1/mcp-servers/${S_HAND_TWO.id}`]: async () => {
        await held;
        return conflict("Another server holds it.", {
          reason: "mcp-server-exists",
          mcpServerId: WINNER_ID,
        });
      },
    });
    await user.click(within(await findRow("Offer sentry work to threads")).getByRole("switch"));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("radio", { name: /sentry_two/ }));
    await user.click(within(dialog).getByRole("button", { name: "Replace" }));
    await waitFor(() => {
      expect(listWrites(api)).toHaveLength(1);
    });

    world.servers.push(buildWinner());
    await pushChange(live, WINNER_ID);
    const alert = await within(dialog).findByRole("alert");
    expect(within(alert).getByRole("link", { name: "Open sentry_win" })).toBeTruthy();
    // The choice the user confirmed does not move to the other server while the write is held.
    expect(
      within(dialog).getByRole<HTMLInputElement>("radio", { name: /sentry_two/ }).checked,
    ).toBe(true);
    expect(
      within(dialog)
        .getByRole("radio", { name: /sentry_hand/ })
        .hasAttribute("disabled"),
    ).toBe(true);

    release();
    await waitFor(() => {
      expect(readPageText(dialog)).toContain("Another server holds it.");
    });
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(listWrites(api).map((call) => call.path)).toEqual([
      `/api/v1/mcp-servers/${S_HAND_TWO.id}`,
    ]);
  });

  it("stops when the chosen server is deleted meanwhile, and asks again before it uses another", async () => {
    const user = userEvent.setup();
    const world = buildWorld([S_HAND, S_HAND_TWO]);
    const { api, live } = await openList(world);

    await user.click(within(await findRow("Offer sentry work to threads")).getByRole("switch"));
    const dialog = await screen.findByRole("dialog");
    world.servers = world.servers.filter((server) => server.id !== S_HAND.id);
    await pushChange(live, S_HAND.id);

    await within(dialog).findByText(/The server you chose is gone/);
    expect(within(dialog).getByRole("button", { name: "Replace" }).hasAttribute("disabled")).toBe(
      true,
    );
    await user.click(within(dialog).getByRole("radio", { name: /sentry_two/ }));
    await user.click(within(dialog).getByRole("button", { name: "Replace" }));

    await waitFor(() => {
      expect(listWrites(api).map((call) => call.path)).toEqual([
        `/api/v1/mcp-servers/${S_HAND_TWO.id}`,
      ]);
    });
  });
});

describe("Settings > MCP servers > the page of a server added by URL", () => {
  it("shows the chips, the sign-in row and the remove words of a server added by URL", async () => {
    await openApp(`/settings/mcp-servers/${S_DOCS.id}`, buildWorld([S_DOCS]));

    const heading = await screen.findByRole("heading", { level: 2, name: /docs/ });
    // The heading names the server alone: its address is on the chip.
    expect(readPageText(heading)).toBe("docs");
    const text = readPageText();
    expect(text).toContain("Added by URL");
    expect(text).toContain("https://docs.acme.example/mcp");
    expect(text).not.toContain("plugin");
    expect(text).toContain("Sign-inA token");
    expect(screen.getByRole("button", { name: "Replace token…" })).toBeTruthy();
    expect(text).not.toContain("The sign-in it acts through");
    expect(text).toContain(
      "Deletes the server and its sign-in. Projects that name it stop naming it.",
    );
    expect(heading.querySelector("svg")).not.toBeNull();
  });

  it("replaces the token from the Sign-in row, and shows one button only while the server needs sign-in", async () => {
    const user = userEvent.setup();
    const world = buildWorld([S_DOCS]);
    const { api } = await openApp(`/settings/mcp-servers/${S_DOCS.id}`, world);

    await user.click(await screen.findByRole("button", { name: "Replace token…" }));
    const dialog = await screen.findByRole("dialog", { name: "Replace the token of docs" });
    expect(readPageText(dialog)).toContain(
      "Paste a new token. It replaces the one this server holds.",
    );
    await user.type(within(dialog).getByLabelText("Token"), "new-token-123");
    await user.click(within(dialog).getByRole("button", { name: "Save token" }));

    await waitFor(() => {
      expect(
        listWrites(api)
          .filter((call) => call.path.endsWith("/token"))
          .map((call) => call.body),
      ).toEqual([{ token: "new-token-123" }]);
    });
  });

  it("offers 'Sign in…' in the band of a server that needs a token, and not 'Replace token…'", async () => {
    const user = userEvent.setup();
    const world = buildWorld([{ ...S_DOCS, status: "needs-sign-in", statusDetail: "No token" }]);
    await openApp(`/settings/mcp-servers/${S_DOCS.id}`, world);

    const band = await screen.findByRole("status");
    expect(readPageText(band)).toContain("Needs sign-in.");
    expect(readPageText(band)).toContain("No token");
    expect(screen.queryByRole("button", { name: "Replace token…" })).toBeNull();
    await user.click(within(band).getByRole("button", { name: "Sign in…" }));

    expect(await screen.findByRole("dialog", { name: "Sign in to docs" })).toBeTruthy();
  });
});
