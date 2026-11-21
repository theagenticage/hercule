/**
 * Tests for Settings > MCP servers: the list with its switches and the default
 * list, one server's page, and the picker. What the words and the buttons
 * mean is decided in `@hercule/client-core/mcp-servers`, which has its own
 * tests. These tests drive the screens through the real app and check what the
 * user sees and what is sent to the controller.
 *
 * Two Sentry servers are both named `sentry` (a work and a hobby account), the
 * case the screens exist to handle: a list holds only one of them.
 */
import { describe, expect, it } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  buildErrorBody,
  readPageText,
  renderApp,
  stubApi,
  type Handler,
} from "../../../../app/testing";

const makeId = (kind: string, n: number): string =>
  `0199c0ff-${kind.repeat(4)}-7000-8000-${String(n).padStart(12, "0")}`;

const AT = "2026-11-20T09:00:00.000Z";

interface ServerFixture {
  readonly id: string;
  readonly name: string;
  readonly source: { kind: "plugin"; contributionId: string; connectionId: string };
  readonly enabled: boolean;
  readonly status: string;
  readonly statusDetail: string | null;
  readonly tools: readonly { name: string; description: string }[];
  readonly checkedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ProjectFixture {
  readonly id: string;
  readonly name: string;
  readonly mcpServerIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A plugin that declares the Connection type and the MCP server `<slug>/<slug>`. */
const buildPlugin = (slug: string, displayName: string) => ({
  id: slug,
  displayName,
  hostApi: 1,
  capabilities: ["connections", "mcp-servers"],
  enabled: true,
  status: { _tag: "active" },
  config: {},
  contributions: [
    {
      extensionPoint: "connection-type",
      id: `${slug}/${slug}`,
      definition: { type: `${slug}/${slug}`, displayName, setup: [] },
    },
    {
      extensionPoint: "mcp-server",
      id: `${slug}/${slug}`,
      definition: {
        displayName,
        description: `The ${displayName} MCP server.`,
        connectionType: `${slug}/${slug}`,
        origin: `https://mcp.${slug}.example`,
      },
    },
  ],
  intake: { eventKinds: [], signalKinds: [] },
  entityKinds: [],
});

const PLUGINS = [
  buildPlugin("sentry", "Sentry"),
  buildPlugin("linear", "Linear"),
  buildPlugin("notion", "Notion"),
  buildPlugin("github", "GitHub"),
  buildPlugin("grafana", "Grafana"),
  buildPlugin("context7", "Context7"),
];

const buildConnection = (id: string, slug: string, label: string) => ({
  id,
  type: `${slug}/${slug}`,
  label,
  displayName: `acct:${label}`,
  status: "connected",
  labels: [],
  config: {},
  feedIntervals: {},
  credentials: [],
  createdAt: AT,
  updatedAt: AT,
});

const C_WORK = makeId("c", 1);
const C_HOBBY = makeId("c", 2);
const C_LINEAR = makeId("c", 3);
const C_NOTION = makeId("c", 4);
const C_GITHUB = makeId("c", 5);
const C_GRAFANA = makeId("c", 6);
const C_CONTEXT = makeId("c", 7);

const CONNECTIONS = [
  buildConnection(C_WORK, "sentry", "work"),
  buildConnection(C_HOBBY, "sentry", "hobby"),
  buildConnection(C_LINEAR, "linear", "acme"),
  buildConnection(C_NOTION, "notion", "wiki"),
  buildConnection(C_GITHUB, "github", "rogier"),
  buildConnection(C_GRAFANA, "grafana", "ops"),
  buildConnection(C_CONTEXT, "context7", "docs"),
];

const buildServer = (
  n: number,
  slug: string,
  connectionId: string,
  overrides: Partial<ServerFixture> = {},
): ServerFixture => ({
  id: makeId("5", n),
  name: slug,
  source: { kind: "plugin", contributionId: `${slug}/${slug}`, connectionId },
  enabled: true,
  status: "ready",
  statusDetail: null,
  tools: [
    { name: "search_issues", description: "Search issues in plain words." },
    { name: "whoami", description: "Who the Connection is signed in as." },
  ],
  checkedAt: AT,
  createdAt: AT,
  updatedAt: AT,
  ...overrides,
});

const S_WORK = buildServer(1, "sentry", C_WORK);
const S_HOBBY = buildServer(2, "sentry", C_HOBBY, { enabled: false });
const S_LINEAR = buildServer(3, "linear", C_LINEAR, {
  status: "needs-sign-in",
  statusDetail: "Linear revoked the token",
});
const S_NOTION = buildServer(4, "notion", C_NOTION, {
  status: "unreachable",
  statusDetail: "mcp.notion.example did not answer",
});
const S_GITHUB = buildServer(5, "github", C_GITHUB, {
  status: "error",
  statusDetail: "GitHub's MCP server refused the Connection's token",
});
const S_CONTEXT = buildServer(6, "context7", C_CONTEXT, {
  status: "checking",
  checkedAt: null,
  tools: [],
});
/** Every server a test may read by id. A server a test removes from `world` answers `not_found`. */
const ALL_SERVERS = [S_WORK, S_HOBBY, S_LINEAR, S_NOTION, S_GITHUB, S_CONTEXT];
const NEW_SERVER_ID = makeId("5", 90);

/** Returns the server the controller creates when a Connection's switch is turned on: Grafana, still checking. */
const buildCreatedServer = (source: ServerFixture["source"]): ServerFixture =>
  buildServer(90, "grafana", source.connectionId, {
    id: NEW_SERVER_ID,
    status: "checking",
    checkedAt: null,
    tools: [],
  });

const P_WEBSHOP = makeId("a", 1);
const P_PAYMENTS = makeId("a", 2);
const P_OPS = makeId("a", 3);
const buildProject = (
  id: string,
  name: string,
  mcpServerIds: readonly string[],
): ProjectFixture => ({
  id,
  name,
  mcpServerIds,
  createdAt: AT,
  updatedAt: AT,
});

/** What the stub controller holds. A test changes it to play a change made elsewhere. */
interface World {
  servers: ServerFixture[];
  projects: ProjectFixture[];
  defaultIds: string[];
}

const buildWorld = (): World => ({
  servers: [S_WORK, S_HOBBY, S_LINEAR, S_NOTION, S_GITHUB, S_CONTEXT],
  // The webshop project also names Linear, so a change to its Sentry choice
  // must keep it.
  projects: [
    buildProject(P_WEBSHOP, "webshop", [S_WORK.id, S_LINEAR.id]),
    buildProject(P_PAYMENTS, "payments", []),
    buildProject(P_OPS, "ops", [S_HOBBY.id]),
  ],
  defaultIds: [S_GITHUB.id],
});

const readSettings = (world: World) => ({
  controller: {},
  user: {
    "onboarding.completedSteps": ["timezone", "assistant"],
    timezone: "Europe/Amsterdam",
    "thread.mcpServerIds": world.defaultIds,
  },
});

/** Builds a stub controller over `world` that accepts every write and applies it to `world`. */
const buildController = (
  world: World,
  extra: Readonly<Record<string, Handler>> = {},
): Readonly<Record<string, Handler>> => {
  const handlers: Record<string, Handler> = {
    "GET /api/v1/setup": { body: { complete: true } },
    "GET /api/v1/settings": () => ({ body: readSettings(world) }),
    "PATCH /api/v1/settings": (call) => {
      const patch = call.body as { user: { "thread.mcpServerIds": string[] } };
      world.defaultIds = patch.user["thread.mcpServerIds"];
      return { body: readSettings(world) };
    },
    "GET /api/v1/plugins": { body: PLUGINS },
    "GET /api/v1/connections": { body: { items: CONNECTIONS } },
    "GET /api/v1/projects": () => ({ body: { items: world.projects } }),
    "GET /api/v1/mcp-servers": () => ({ body: { items: world.servers } }),
    "POST /api/v1/mcp-servers": (call) => {
      const created = buildCreatedServer((call.body as { source: ServerFixture["source"] }).source);
      world.servers.push(created);
      return { body: created };
    },
  };
  for (const project of world.projects) {
    handlers[`PATCH /api/v1/projects/${project.id}`] = (call) => {
      const { mcpServerIds } = call.body as { mcpServerIds: string[] };
      const index = world.projects.findIndex((each) => each.id === project.id);
      world.projects[index] = { ...world.projects[index]!, mcpServerIds };
      return { body: world.projects[index] };
    };
  }
  for (const server of ALL_SERVERS) {
    const path = `/api/v1/mcp-servers/${server.id}`;
    handlers[`GET ${path}`] = () => {
      const found = world.servers.find((each) => each.id === server.id);
      return found === undefined
        ? { status: 404, body: buildErrorBody("not_found", "no such server") }
        : { body: found };
    };
    handlers[`PATCH ${path}`] = (call) => {
      const { enabled } = call.body as { enabled: boolean };
      const index = world.servers.findIndex((each) => each.id === server.id);
      world.servers[index] = { ...world.servers[index]!, enabled };
      return { body: world.servers[index] };
    };
    handlers[`POST ${path}/check`] = { body: {} };
    handlers[`DELETE ${path}`] = () => {
      world.servers = world.servers.filter((each) => each.id !== server.id);
      world.projects = world.projects.map((project) => ({
        ...project,
        mcpServerIds: project.mcpServerIds.filter((id) => id !== server.id),
      }));
      return { body: {} };
    };
  }
  return { ...handlers, ...extra };
};

const openApp = async (
  path: string,
  { world = buildWorld(), extra = {} }: { world?: World; extra?: Record<string, Handler> } = {},
) => {
  const api = stubApi(buildController(world, extra));
  const app = await renderApp({ path, api: api.fetch, token: "held" });
  return { ...app, api, world };
};

const openList = (options?: Parameters<typeof openApp>[1]) =>
  openApp("/settings/mcp-servers", options);
const openPage = (server: ServerFixture, options?: Parameters<typeof openApp>[1]) =>
  openApp(`/settings/mcp-servers/${server.id}`, options);

/** Returns the writes the screen made, in order. The live connection's ticket request is not one. */
const listWrites = (api: {
  readonly calls: readonly { method: string; path: string; body: unknown }[];
}) => api.calls.filter((call) => call.method !== "GET" && !call.path.endsWith("/auth/ws-ticket"));

const readCalls = (api: { readonly calls: readonly { path: string }[] }, path: string) =>
  api.calls.filter((call) => call.path === path).length;

/** Finds the row of "From your Connections" whose switch is named `name`. */
const findRow = async (name: string): Promise<HTMLElement> => {
  const row = (await screen.findByRole("switch", { name })).closest("li");
  if (row === null) throw new Error(`${name} has no row`);
  return row;
};

/** Returns the answer of a controller that refuses the write because the token lacks `mcp.manage`. */
const refuseForMissingGrant = (message: string) => ({
  status: 403,
  body: { error: { code: "forbidden", message, details: { grant: "mcp.manage" } } },
});

/** Returns a promise a test settles by hand, to hold a request pending. */
const buildGate = () => {
  let release: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { opened, release };
};

describe("Settings > MCP servers > the list", () => {
  it("opens with the lead and one row for every Connection a plugin offers a server on", async () => {
    await openList();

    await findRow("Offer sentry work to threads");
    const text = readPageText();
    expect(text).toContain(
      "An MCP server gives agents tools from another service. Set one up here once and every runner has it: the sign-in stays on the controller. A project names the servers its threads start with.",
    );
    expect(text).toContain("From your Connections");
    expect(text).toContain("No second sign-in: the server is reached with the Connection");
    // Rows follow the Connection type's name, then the account's label.
    const switches = screen.getAllByRole("switch").map((each) => each.getAttribute("aria-label"));
    expect(switches).toEqual([
      "Offer context7 docs to threads",
      "Offer github rogier to threads",
      "Offer grafana ops to threads",
      "Offer linear acme to threads",
      "Offer notion wiki to threads",
      "Offer sentry hobby to threads",
      "Offer sentry work to threads",
    ]);
  });

  it("shows each server's second line, status and the projects that name it", async () => {
    await openList();

    const work = readPageText(await findRow("Offer sentry work to threads"));
    expect(work).toContain("sentry work");
    expect(work).toContain("Sentry Connection · 2 tools");
    expect(work).toContain("ready");
    expect(work).toContain("webshop");
    expect(readPageText(await findRow("Offer sentry hobby to threads"))).toMatch(/off.*ops/);
    expect(readPageText(await findRow("Offer github rogier to threads"))).toContain("None");

    const checking = await findRow("Offer context7 docs to threads");
    expect(readPageText(checking)).toContain("checking");
    expect(checking.querySelector("[data-mark=working]")).not.toBeNull();
  });

  it("draws a failing status in the failure colour, with the server's reason as its tooltip", async () => {
    await openList();

    for (const [name, word, detail] of [
      ["Offer linear acme to threads", "needs sign-in", "Linear revoked the token"],
      ["Offer notion wiki to threads", "unreachable", "mcp.notion.example did not answer"],
      [
        "Offer github rogier to threads",
        "error",
        "GitHub's MCP server refused the Connection's token",
      ],
    ] as const) {
      const status = within(await findRow(name)).getByText(word);
      expect(status.className).toContain("text-fail");
      expect(status.getAttribute("title")).toBe(detail);
    }
    expect(
      within(await findRow("Offer sentry work to threads")).getByText("ready").className,
    ).not.toContain("text-fail");
  });

  it("opens the page of a server that has a record, and gives a Connection with none no page", async () => {
    const user = userEvent.setup();
    const { router } = await openList();

    const grafana = await findRow("Offer grafana ops to threads");
    expect(within(grafana).queryByRole("link")).toBeNull();
    expect(readPageText(grafana)).toContain("Grafana Connection · switch it on to see its tools");
    expect(readPageText(grafana)).toContain("off");
    expect(readPageText(grafana)).toContain("grafana");

    await user.click(
      within(await findRow("Offer sentry work to threads")).getByRole("link", { name: /sentry/ }),
    );

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/settings/mcp-servers/${S_WORK.id}`);
    });
  });

  it("creates the server when a Connection's switch is turned on, and keeps the switch still while it writes", async () => {
    const user = userEvent.setup();
    const gate = buildGate();
    const world = buildWorld();
    const { api } = await openList({
      world,
      extra: {
        "POST /api/v1/mcp-servers": async (call) => {
          await gate.opened;
          const created = buildCreatedServer(
            (call.body as { source: ServerFixture["source"] }).source,
          );
          world.servers.push(created);
          return { body: created };
        },
      },
    });

    const toggle = within(await findRow("Offer grafana ops to threads")).getByRole("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await user.click(toggle);

    await waitFor(() => {
      expect(toggle.getAttribute("aria-disabled")).toBe("true");
    });
    // A second press while the write runs sends nothing.
    await user.click(toggle);
    expect(listWrites(api)).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/api/v1/mcp-servers",
        body: {
          source: { kind: "plugin", contributionId: "grafana/grafana", connectionId: C_GRAFANA },
        },
      }),
    ]);

    gate.release();
    // The row now has a record: it is on, checking, and has a page.
    await waitFor(() => {
      expect(toggle.getAttribute("aria-disabled")).not.toBe("true");
    });
    const row = await findRow("Offer grafana ops to threads");
    expect(within(row).getByRole("switch").getAttribute("aria-checked")).toBe("true");
    expect(readPageText(row)).toContain("checking");
    expect(within(row).getByRole("link").getAttribute("href")).toBe(
      `/settings/mcp-servers/${NEW_SERVER_ID}`,
    );
  });

  it("writes `enabled` when a server that has a record is switched off", async () => {
    const user = userEvent.setup();
    const { api } = await openList();

    await user.click(within(await findRow("Offer sentry work to threads")).getByRole("switch"));

    await waitFor(() => {
      expect(listWrites(api)).toEqual([
        expect.objectContaining({
          method: "PATCH",
          path: `/api/v1/mcp-servers/${S_WORK.id}`,
          body: { enabled: false },
        }),
      ]);
    });
    // The row shows the server as the controller holds it once the list is read again.
    await waitFor(() => {
      expect(
        screen
          .getByRole("switch", { name: "Offer sentry work to threads" })
          .getAttribute("aria-checked"),
      ).toBe("false");
    });
    expect(readPageText(await findRow("Offer sentry work to threads"))).toContain("off");
  });

  it("shows a refusal under the row that made it, and reads the list again", async () => {
    const user = userEvent.setup();
    const message = "Another server already reaches this account.";
    const { api } = await openList({
      extra: {
        "POST /api/v1/mcp-servers": {
          status: 409,
          body: buildErrorBody("conflict", message),
        },
      },
    });
    const reads = () => readCalls(api, "/api/v1/mcp-servers");
    await findRow("Offer grafana ops to threads");
    const before = reads();

    await user.click(within(await findRow("Offer grafana ops to threads")).getByRole("switch"));

    const row = await findRow("Offer grafana ops to threads");
    await waitFor(() => {
      expect(within(row).getByRole("alert").textContent).toBe(message);
    });
    expect(reads()).toBeGreaterThan(before);
    // No other row carries the refusal.
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("shows a status that changes elsewhere, and holds the mcpServer topic only while it is open", async () => {
    const { world, live, router, api } = await openList();
    const status = async () => within(await findRow("Offer context7 docs to threads"));
    expect((await status()).getByText("checking")).toBeTruthy();
    await waitFor(() => {
      expect(live.topics()).toContain("mcpServer");
    });

    world.servers = world.servers.map((server) =>
      server.id === S_CONTEXT.id
        ? { ...server, status: "ready", checkedAt: AT, tools: S_WORK.tools }
        : server,
    );
    act(() => {
      live.push("mcpServer", { _tag: "invalidate", ids: [S_CONTEXT.id], kind: "updated" });
    });
    await waitFor(async () => {
      expect(readPageText((await status()).getByText("ready").closest("li"))).toContain(
        "Context7 Connection · 2 tools",
      );
    });
    expect(readCalls(api, "/api/v1/mcp-servers")).toBeGreaterThan(1);

    await act(() => router.navigate({ to: "/settings/plugins" }));
    await waitFor(() => {
      expect(live.topics()).not.toContain("mcpServer");
    });
  });
});

describe("Settings > MCP servers > threads without a project", () => {
  it("shows the default list as chips and its group's line", async () => {
    await openList();

    const group = (await screen.findByText("Threads without a project")).closest("section")!;
    expect(readPageText(group)).toContain("A thread in no project starts with these servers");
    expect(readPageText(group)).toContain("github");
    expect(readPageText(group)).toContain("rogier");
  });

  it("shows None for an empty default list", async () => {
    const world = buildWorld();
    world.defaultIds = [];
    await openList({ world });

    const group = (await screen.findByText("Threads without a project")).closest("section")!;
    expect(readPageText(group)).toContain("None");
  });

  it("opens the picker from Change… and writes each change at once", async () => {
    const user = userEvent.setup();
    const { api, world } = await openList();

    await user.click(await screen.findByRole("button", { name: "Change…" }));

    const dialog = await screen.findByRole("dialog", {
      name: "MCP servers of threads without a project",
    });
    expect(readPageText(dialog)).toContain("1 chosen");
    expect(readPageText(dialog)).toContain(
      "Threads started in no project from now on. A thread can still change its own.",
    );
    // Two Sentry accounts are one row, with a choice of account.
    const sentry = within(dialog).getByRole("checkbox", { name: "sentry" });
    expect(readPageText(dialog)).toContain("Sentry Connection, 2 accounts");
    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(5);

    await user.click(sentry);

    await waitFor(() => {
      expect(listWrites(api)).toEqual([
        expect.objectContaining({
          method: "PATCH",
          path: "/api/v1/settings",
          body: { user: { "thread.mcpServerIds": [S_GITHUB.id, S_HOBBY.id] } },
        }),
      ]);
    });
    // The first account of the name, by its label, is the one a tick picks.
    expect(world.defaultIds).toEqual([S_GITHUB.id, S_HOBBY.id]);
    await waitFor(() => {
      expect(readPageText(dialog)).toContain("2 chosen");
    });

    // The choice of account swaps the server in one write.
    await user.selectOptions(within(dialog).getByLabelText("Account of sentry"), "work");
    await waitFor(() => {
      expect(world.defaultIds).toEqual([S_GITHUB.id, S_WORK.id]);
    });
    expect(listWrites(api)).toHaveLength(2);

    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    const group = screen.getByText("Threads without a project").closest("section")!;
    await waitFor(() => {
      expect(readPageText(group)).toContain("sentry");
    });
  });

  it("shows a refusal of the default list in the picker", async () => {
    const user = userEvent.setup();
    await openList({
      extra: {
        "PATCH /api/v1/settings": refuseForMissingGrant(
          "Changing the default list needs mcp.manage.",
        ),
      },
    });

    await user.click(await screen.findByRole("button", { name: "Change…" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("checkbox", { name: "linear" }));

    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "Changing the default list needs mcp.manage.",
    );
    // The list stays as the controller holds it.
    expect(readPageText(dialog)).toContain("1 chosen");
  });

  it("closes the picker with Escape", async () => {
    const user = userEvent.setup();
    await openList();

    await user.click(await screen.findByRole("button", { name: "Change…" }));
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Settings > MCP servers > one server's page", () => {
  it("shows a ready server's heading, chips, sections and tools, with no band", async () => {
    await openPage(S_WORK);

    expect(await screen.findByRole("heading", { name: "sentry work" })).toBeTruthy();
    const text = readPageText();
    expect(text).toContain("From the Sentry plugin");
    expect(text).toContain("mcp.sentry.example");
    expect(screen.queryByRole("status")).toBeNull();
    expect(text).toContain("Off keeps the name, the sign-in and the projects that name it.");
    expect(text).toContain("Agents see its tools as mcp__tools__sentry__<tool>.");
    expect(text).toContain("The sign-in it acts through. No token leaves the controller.");
    expect(text).toContain("Sentry · work");
    expect(text).toContain(
      "Hercule lists the tools again once a day, and when the Connection or the sign-in changes.",
    );
    expect(text).toContain("search_issues");
    expect(text).toContain("Who the Connection is signed in as.");
    expect(screen.getByRole("link", { name: "Open" }).getAttribute("href")).toBe("/connections");
    expect(
      screen.getByRole("switch", { name: "Offered to threads" }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("shows the Tools placeholder while a server has none", async () => {
    await openPage(S_CONTEXT);

    expect(await screen.findByText("The tools show here once the check is done.")).toBeTruthy();
    expect(readPageText()).toContain("Not checked yet");
  });

  it("shows the band of a server that is checking, with no button", async () => {
    await openPage(S_CONTEXT);

    const band = await screen.findByRole("status");
    expect(readPageText(band)).toBe("Checking: asking the server for its tools.");
    expect(within(band).queryByRole("button")).toBeNull();
  });

  it("shows the band of a server that is off", async () => {
    await openPage(S_HOBBY);

    expect(readPageText(await screen.findByRole("status"))).toBe(
      "Off. No thread gets this server. Its name, its sign-in and the projects that name it are kept.",
    );
    // Check now has nothing to ask while the server is off.
    expect(screen.getByRole("button", { name: "Check now" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
  });

  it("sends a server that needs sign-in to its Connection's Reconnect", async () => {
    const user = userEvent.setup();
    const { router } = await openPage(S_LINEAR);

    const band = await screen.findByRole("status");
    expect(readPageText(band)).toContain("Needs sign-in.");
    expect(readPageText(band)).toContain("Linear revoked the token");
    const reconnect = within(band).getByRole("link", { name: "Reconnect Linear · acme" });
    expect(reconnect.getAttribute("href")).toBe(`/connections?reconnect=${C_LINEAR}`);
    // The Connection row says what is wrong and has no second button.
    expect(screen.getAllByText("Linear revoked the token").length).toBeGreaterThan(1);
    expect(screen.queryByRole("link", { name: "Open" })).toBeNull();

    await user.click(reconnect);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/connections");
    });
  });

  it("shows an unreachable server's band and asks for a check", async () => {
    const user = userEvent.setup();
    const { api } = await openPage(S_NOTION);

    const band = await screen.findByRole("status");
    expect(readPageText(band)).toContain("Unreachable.");
    expect(readPageText(band)).toContain("Hercule asks again, with a longer wait each time.");
    expect(readPageText(band)).toContain("mcp.notion.example did not answer");

    await user.click(within(band).getByRole("button", { name: "Check now" }));

    await waitFor(() => {
      expect(listWrites(api)).toEqual([
        expect.objectContaining({
          method: "POST",
          path: `/api/v1/mcp-servers/${S_NOTION.id}/check`,
        }),
      ]);
    });
  });

  it("shows the reason of a server in error and asks for a check from the last checked row", async () => {
    const user = userEvent.setup();
    const { api } = await openPage(S_GITHUB);

    const band = await screen.findByRole("status");
    expect(readPageText(band)).toContain("Error.");
    expect(readPageText(band)).toContain("GitHub's MCP server refused the Connection's token");

    const lastChecked = screen.getByText("Last checked").closest("div")!;
    await user.click(within(lastChecked).getByRole("button", { name: "Check now" }));

    await waitFor(() => {
      expect(listWrites(api).map((call) => call.path)).toEqual([
        `/api/v1/mcp-servers/${S_GITHUB.id}/check`,
      ]);
    });
  });

  it("shows why a check was refused", async () => {
    const user = userEvent.setup();
    await openPage(S_NOTION, {
      extra: {
        [`POST /api/v1/mcp-servers/${S_NOTION.id}/check`]: {
          status: 409,
          body: buildErrorBody("invalid_state", "The server is switched off."),
        },
      },
    });

    await user.click(
      within(await screen.findByRole("status")).getByRole("button", { name: "Check now" }),
    );

    expect((await screen.findByText("The server is switched off.")).getAttribute("role")).toBe(
      "alert",
    );
  });

  it("writes `enabled` from the Offered to threads switch", async () => {
    const user = userEvent.setup();
    const { api } = await openPage(S_WORK);

    await user.click(await screen.findByRole("switch", { name: "Offered to threads" }));

    await waitFor(() => {
      expect(listWrites(api)).toEqual([
        expect.objectContaining({
          method: "PATCH",
          path: `/api/v1/mcp-servers/${S_WORK.id}`,
          body: { enabled: false },
        }),
      ]);
    });
    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: "Offered to threads" }).getAttribute("aria-checked"),
      ).toBe("false");
    });
    expect(readPageText(await screen.findByRole("status"))).toContain("Off.");
  });

  it("holds the mcpServer topic only while the page is open", async () => {
    const { live, router } = await openPage(S_WORK);
    await screen.findByRole("heading", { name: /sentry/ });
    await waitFor(() => {
      expect(live.topics()).toContain("mcpServer");
    });

    await act(() => router.navigate({ to: "/settings/plugins" }));

    await waitFor(() => {
      expect(live.topics()).not.toContain("mcpServer");
    });
  });

  it("goes to the list for an id that names no server, replacing its entry", async () => {
    const { router } = await openApp(`/settings/mcp-servers/${makeId("5", 77)}`);

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/settings/mcp-servers");
    });
    expect(await screen.findByText("From your Connections")).toBeTruthy();
    expect(router.history.length).toBe(1);
  });

  it("goes back to the list when the server is deleted while the page is open", async () => {
    const { world, live, router } = await openPage(S_WORK);
    await screen.findByRole("heading", { name: /sentry/ });
    await waitFor(() => {
      expect(live.topics()).toContain("mcpServer");
    });

    world.servers = world.servers.filter((server) => server.id !== S_WORK.id);
    act(() => {
      live.push("mcpServer", { _tag: "invalidate", ids: [S_WORK.id], kind: "deleted" });
    });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/settings/mcp-servers");
    });
    expect(await screen.findByText("From your Connections")).toBeTruthy();
  });
});

describe("Settings > MCP servers > one server's page > Projects", () => {
  /** Returns the box of one project, or of the threads without a project, as its list item. */
  const findBox = async (name: string): Promise<HTMLElement> => {
    const heading = await screen.findByText(name, { selector: "span.font-emph" });
    const box = heading.closest("li");
    if (box === null) throw new Error(`${name} has no box`);
    return box;
  };

  it("draws a box for every project and for the threads without a project, ticked while the list names the server", async () => {
    await openPage(S_WORK);

    const webshop = await findBox("webshop");
    const payments = await findBox("payments");
    expect(within(webshop).getByRole("checkbox")).toHaveProperty("checked", true);
    expect(within(payments).getByRole("checkbox")).toHaveProperty("checked", false);
    expect(readPageText(payments)).not.toContain("uses");
    // The default list names the GitHub server, not this one.
    expect(within(await findBox("Threads without a project")).getByRole("checkbox")).toHaveProperty(
      "checked",
      false,
    );
    const card = webshop.closest("section")!;
    expect(readPageText(card)).toContain("1 of 4");
    expect(readPageText(card)).toContain(
      "A thread starts with this server when its project names it. A thread can still change its own list, under the plus of its composer.",
    );
  });

  it("names the server in a free project with one project.update", async () => {
    const user = userEvent.setup();
    const { api } = await openPage(S_WORK);

    await user.click(within(await findBox("payments")).getByRole("checkbox"));

    await waitFor(() => {
      expect(listWrites(api)).toEqual([
        expect.objectContaining({
          method: "PATCH",
          path: `/api/v1/projects/${P_PAYMENTS}`,
          body: { mcpServerIds: [S_WORK.id] },
        }),
      ]);
    });
    await waitFor(() => {
      expect(
        within(
          screen.getByText("payments", { selector: "span.font-emph" }).closest("li")!,
        ).getByRole("checkbox"),
      ).toHaveProperty("checked", true);
    });
  });

  it("removes only this server from a project's list", async () => {
    const user = userEvent.setup();
    const { api } = await openPage(S_WORK);

    await user.click(within(await findBox("webshop")).getByRole("checkbox"));

    // The webshop project also names Linear, which the write keeps.
    await waitFor(() => {
      expect(listWrites(api)).toEqual([
        expect.objectContaining({
          path: `/api/v1/projects/${P_WEBSHOP}`,
          body: { mcpServerIds: [S_LINEAR.id] },
        }),
      ]);
    });
  });

  it("keeps a box still while its write runs, and sends one write", async () => {
    const user = userEvent.setup();
    const gate = buildGate();
    const { api } = await openPage(S_WORK, {
      extra: {
        [`PATCH /api/v1/projects/${P_PAYMENTS}`]: async () => {
          await gate.opened;
          return { body: buildProject(P_PAYMENTS, "payments", [S_WORK.id]) };
        },
      },
    });

    const checkbox = within(await findBox("payments")).getByRole("checkbox");
    await user.click(checkbox);
    await waitFor(() => {
      expect(checkbox.getAttribute("aria-disabled")).toBe("true");
    });
    await user.click(checkbox);
    expect(listWrites(api)).toHaveLength(1);
    // The box shows the list as the controller still holds it.
    expect(checkbox).toHaveProperty("checked", false);

    gate.release();
    await waitFor(() => {
      expect(checkbox.getAttribute("aria-disabled")).not.toBe("true");
    });
  });

  it("shows a refusal from the controller under its box", async () => {
    const user = userEvent.setup();
    await openPage(S_WORK, {
      extra: {
        [`PATCH /api/v1/projects/${P_PAYMENTS}`]: refuseForMissingGrant(
          "Changing a project's servers needs mcp.manage.",
        ),
      },
    });

    await user.click(within(await findBox("payments")).getByRole("checkbox"));

    const box = await findBox("payments");
    expect((await within(box).findByRole("alert")).textContent).toBe(
      "Changing a project's servers needs mcp.manage.",
    );
    expect(within(box).getByRole("checkbox")).toHaveProperty("checked", false);
  });

  it("writes the default list from the box of the threads without a project", async () => {
    const user = userEvent.setup();
    const { api } = await openPage(S_WORK);

    await user.click(within(await findBox("Threads without a project")).getByRole("checkbox"));

    await waitFor(() => {
      expect(listWrites(api)).toEqual([
        expect.objectContaining({
          method: "PATCH",
          path: "/api/v1/settings",
          body: { user: { "thread.mcpServerIds": [S_GITHUB.id, S_WORK.id] } },
        }),
      ]);
    });
  });

  describe("a project that names the other server of the name", () => {
    it("says so at rest, and shows the refusal instead of writing when its box is ticked", async () => {
      const user = userEvent.setup();
      const { api } = await openPage(S_HOBBY);

      const webshop = await findBox("webshop");
      expect(readPageText(webshop)).toMatch(/^webshop ?uses sentry work$/);

      await user.click(within(webshop).getByRole("checkbox"));

      expect(readPageText(webshop)).toContain(
        "webshop already uses sentry work. One project cannot name both: their tools would get the same names.",
      );
      expect(within(webshop).getByRole("button", { name: "Use sentry hobby" })).toBeTruthy();
      expect(within(webshop).getByRole("button", { name: "Keep sentry work" })).toBeTruthy();
      // The refusal replaces the "uses" note.
      expect(readPageText(webshop)).not.toMatch(/^webshop uses/);
      expect(within(webshop).getByRole("checkbox")).toHaveProperty("checked", false);
      expect(listWrites(api)).toEqual([]);
    });

    it("swaps the two servers in one project.update with Use", async () => {
      const user = userEvent.setup();
      const { api } = await openPage(S_HOBBY);

      await user.click(within(await findBox("webshop")).getByRole("checkbox"));
      await user.click(
        within(await findBox("webshop")).getByRole("button", { name: "Use sentry hobby" }),
      );

      // The swap puts the new server where the old one was and keeps Linear.
      await waitFor(() => {
        expect(listWrites(api)).toEqual([
          expect.objectContaining({
            method: "PATCH",
            path: `/api/v1/projects/${P_WEBSHOP}`,
            body: { mcpServerIds: [S_HOBBY.id, S_LINEAR.id] },
          }),
        ]);
      });
      await waitFor(() => {
        expect(
          within(
            screen.getByText("webshop", { selector: "span.font-emph" }).closest("li")!,
          ).getByRole("checkbox"),
        ).toHaveProperty("checked", true);
      });
      expect(screen.queryByRole("button", { name: "Use sentry hobby" })).toBeNull();
    });

    it("closes the refusal and writes nothing with Keep", async () => {
      const user = userEvent.setup();
      const { api } = await openPage(S_HOBBY);

      await user.click(within(await findBox("webshop")).getByRole("checkbox"));
      await user.click(
        within(await findBox("webshop")).getByRole("button", { name: "Keep sentry work" }),
      );

      const webshop = await findBox("webshop");
      expect(within(webshop).queryByRole("button")).toBeNull();
      expect(readPageText(webshop)).toMatch(/^webshop ?uses sentry work$/);
      expect(listWrites(api)).toEqual([]);
    });
  });
});

describe("Settings > MCP servers > one server's page > Remove", () => {
  it("asks first, naming the projects that name the server, and does nothing on Cancel", async () => {
    const user = userEvent.setup();
    const { api } = await openPage(S_WORK);

    expect(
      await screen.findByText(
        "Deletes the server. Projects that name it stop naming it. The Connection Sentry · work stays.",
      ),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Remove server…" }));

    const question = screen.getByRole("group", { name: "Remove sentry work?" });
    expect(readPageText(question)).toContain("webshop names it.");
    expect(readPageText(question)).toContain(
      "Every project's list and every thread's list drops it, and a running thread loses its tools at once.",
    );

    await user.click(within(question).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("group", { name: "Remove sentry work?" })).toBeNull();
    expect(listWrites(api)).toEqual([]);
  });

  it("deletes the server and goes back to the list", async () => {
    const user = userEvent.setup();
    const { api, router } = await openPage(S_WORK);

    await user.click(await screen.findByRole("button", { name: "Remove server…" }));
    await user.click(
      within(screen.getByRole("group", { name: "Remove sentry work?" })).getByRole("button", {
        name: "Remove",
      }),
    );

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/settings/mcp-servers");
    });
    expect(listWrites(api).map((call) => `${call.method} ${call.path}`)).toEqual([
      `DELETE /api/v1/mcp-servers/${S_WORK.id}`,
    ]);
    // The row is back to a Connection with no server.
    const row = await findRow("Offer sentry work to threads");
    expect(readPageText(row)).toContain("switch it on to see its tools");
  });

  it("shows why the controller refused the removal, and stays on the page", async () => {
    const user = userEvent.setup();
    const { router } = await openPage(S_WORK, {
      extra: {
        [`DELETE /api/v1/mcp-servers/${S_WORK.id}`]: refuseForMissingGrant(
          "Removing a server needs mcp.manage.",
        ),
      },
    });

    await user.click(await screen.findByRole("button", { name: "Remove server…" }));
    await user.click(
      within(screen.getByRole("group", { name: "Remove sentry work?" })).getByRole("button", {
        name: "Remove",
      }),
    );

    expect(
      (await screen.findByText("Removing a server needs mcp.manage.")).getAttribute("role"),
    ).toBe("alert");
    expect(router.state.location.pathname).toBe(`/settings/mcp-servers/${S_WORK.id}`);
  });
});
