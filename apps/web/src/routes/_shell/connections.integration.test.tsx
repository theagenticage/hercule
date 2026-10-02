/**
 * Tests for the Connections screen: what it shows about the accounts Hercule
 * acts through, and what it sends when the user sets one up.
 *
 * Everything the screen offers comes from the plugin catalog: the types, their
 * setup steps, their fields and their per-connection settings form. Nothing
 * about GitHub, Gmail or any other account is hard-coded in the web app, so the
 * fixtures below are types that no plugin in this repository declares. If the
 * screen still shows them, it must be reading the catalog.
 *
 * A credential value is sent in a request and never returned: the connection
 * record holds only references to it. So a row has no value to leak, and the
 * assertions below check what was sent, not what came back.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  buildErrorBody,
  expectInDocumentOrder,
  readPageText,
  renderApp,
  stubApi,
  type Answer,
  type Handler,
} from "../../app/testing";

interface Contribution {
  readonly extensionPoint: string;
  readonly id: string;
  readonly definition: unknown;
}

interface Plugin {
  readonly id: string;
  readonly displayName: string;
  readonly hostApi: number;
  readonly capabilities: readonly string[];
  readonly enabled: boolean;
  readonly status: unknown;
  readonly config: unknown;
  readonly contributions: readonly Contribution[];
}

interface Connection {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  readonly displayName: string;
  readonly status: string;
  readonly statusDetail?: string;
  readonly labels: readonly string[];
  readonly config: Record<string, unknown>;
  readonly credentials: readonly { readonly name: string; readonly rotatedAt?: string }[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

const CHECKLIST = "Make a token with the repo scope, then paste it below.";

/** A type with a credentials flow: a checklist, one pasted field, and its own settings. */
const PAPER_TYPE = {
  type: "paper-trail/paper",
  displayName: "Paper Trail",
  setup: [
    { kind: "checklist", markdown: CHECKLIST },
    {
      kind: "credentials",
      fields: [
        { name: "token", label: "Access token", help: "Paper Trail calls this an API key." },
      ],
    },
  ],
  configSchema: {
    type: "object",
    properties: { folder: { type: "string", title: "Folder" } },
    required: [],
    additionalProperties: false,
  },
};

/** A type with a redirect flow: nothing to paste, and no settings of its own. */
const SKY_TYPE = {
  type: "skyline/mail",
  displayName: "Skyline",
  setup: [{ kind: "oauth" }],
  oauth: {
    authorizationUrl: "https://skyline.test/oauth/authorize",
    tokenUrl: "https://skyline.test/oauth/token",
    scopes: ["mail.read"],
  },
};

/** A type with a pairing flow, which the web app does not support yet. */
const CHATTER_TYPE = {
  type: "chatterbox/chatter",
  displayName: "Chatterbox",
  setup: [{ kind: "pairing" }],
};

/**
 * A type with two flows: a device flow first, which it prefers, and a pasted
 * token as the alternative.
 */
const GLASS_TYPE = {
  type: "glasshouse/glass",
  displayName: "Glasshouse",
  setup: [
    { kind: "device" },
    { kind: "credentials", fields: [{ name: "token", label: "Personal access token" }] },
  ],
  device: {
    clientId: "glass-client",
    deviceCodeUrl: "https://glasshouse.test/login/device/code",
    tokenUrl: "https://glasshouse.test/login/oauth/access_token",
    scopes: ["repo"],
  },
};

const buildPlugin = (id: string, definition: { type: string; displayName: string }): Plugin => ({
  id,
  // The plugin's name differs from its type's name, so a row shows both: the
  // type's display name, and the plugin under it. A plugin named like its type
  // is left out, which one test below checks.
  displayName: `${id} plugin`,
  hostApi: 1,
  capabilities: ["connections"],
  enabled: true,
  status: { _tag: "active" },
  config: {},
  contributions: [{ extensionPoint: "connection-type", id: definition.type, definition }],
});

/** A plugin that is installed but contributes no connection type. */
const BYSTANDER: Plugin = {
  id: "quiet-sink",
  displayName: "Quiet Sink",
  hostApi: 1,
  capabilities: ["providers"],
  enabled: true,
  status: { _tag: "active" },
  config: {},
  contributions: [{ extensionPoint: "provider", id: "acme", definition: {} }],
};

const CATALOG: readonly Plugin[] = [
  buildPlugin("paper-trail", PAPER_TYPE),
  buildPlugin("skyline", SKY_TYPE),
  buildPlugin("chatterbox", CHATTER_TYPE),
  buildPlugin("glasshouse", GLASS_TYPE),
  BYSTANDER,
];

const PAPER: Connection = {
  id: "0199c0ff-aaaa-7000-8000-000000000001",
  type: "paper-trail/paper",
  label: "work",
  displayName: "acct:paper-work",
  status: "connected",
  labels: ["Code", "Ops"],
  config: { folder: "inbox" },
  credentials: [{ name: "token", rotatedAt: "2026-09-11T17:21:00.000Z" }],
  createdAt: "2026-09-01T08:15:00.000Z",
  updatedAt: "2026-09-11T17:21:00.000Z",
};

const SKY: Connection = {
  id: "0199c0ff-bbbb-7000-8000-000000000002",
  type: "skyline/mail",
  label: "personal",
  displayName: "rogier@skyline.test",
  status: "needs-reauth",
  statusDetail: "the refresh token was rejected",
  labels: ["Business"],
  config: {},
  credentials: [{ name: "oauth.tokens" }],
  createdAt: "2026-09-02T09:30:00.000Z",
  updatedAt: "2026-09-12T07:05:00.000Z",
};

const GLASS: Connection = {
  id: "0199c0ff-dddd-7000-8000-000000000004",
  type: "glasshouse/glass",
  label: "work",
  displayName: "octo-glass",
  status: "connected",
  labels: ["Code"],
  config: {},
  credentials: [{ name: "oauth.tokens" }],
  createdAt: "2026-10-02T08:15:00.000Z",
  updatedAt: "2026-10-02T08:15:00.000Z",
};

/** A connection the user never named or gave a topic, so it is named after its account. */
const UNNAMED: Connection = {
  id: "0199c0ff-eeee-7000-8000-000000000005",
  type: "glasshouse/glass",
  label: "octo-glass",
  displayName: "octo-glass",
  status: "connected",
  labels: [],
  config: {},
  credentials: [{ name: "oauth.tokens" }],
  createdAt: "2026-10-02T08:15:00.000Z",
  updatedAt: "2026-10-02T08:15:00.000Z",
};

/** Builds a stub controller that returns `connections` and the catalog above. */
const buildController = (
  connections: () => readonly Connection[],
  extra: Readonly<Record<string, Handler>> = {},
): Readonly<Record<string, Handler>> => ({
  "GET /api/v1/setup": { body: { complete: true } },
  "GET /api/v1/settings": {
    body: {
      controller: {},
      user: {
        "onboarding.completedSteps": ["timezone", "assistant"],
        timezone: "Europe/Amsterdam",
      },
    },
  },
  "GET /api/v1/plugins": { body: CATALOG },
  "GET /api/v1/connections": () => ({ body: { items: connections() } }),
  ...extra,
});

const openApp = async (
  connections: readonly Connection[],
  extra: Readonly<Record<string, Handler>> = {},
  path = "/connections",
) => {
  const held = [...connections];
  const api = stubApi(buildController(() => held, extra));
  const app = await renderApp({ path, api: api.fetch, token: "held" });
  return {
    ...app,
    api,
    /** Replaces the connections the controller returns from now on, as a write would. */
    hold: (next: readonly Connection[]) => {
      held.splice(0, held.length, ...next);
    },
  };
};

/**
 * Returns the writes this screen made, in order. The shell opens a live
 * connection on every screen and fetches a ticket for it with a POST. This
 * screen did not make that request, so it is left out.
 */
const listWrites = (api: {
  readonly calls: readonly { method: string; path: string; body: unknown }[];
}) => api.calls.filter((call) => call.method !== "GET" && !call.path.endsWith("/auth/ws-ticket"));

const countConnectionReads = (api: { readonly calls: readonly { path: string }[] }) =>
  api.calls.filter((call) => call.path === "/api/v1/connections").length;

/** Returns the nearest ancestor of `inner` that contains a button named `name`. */
const findGroupOffering = (inner: HTMLElement, name: string): HTMLElement => {
  let group: HTMLElement | null = inner.parentElement;
  while (group !== null && within(group).queryByRole("button", { name }) === null) {
    group = group.parentElement;
  }
  if (group === null) throw new Error(`nothing around ${readPageText(inner)} offers ${name}`);
  return group;
};

/**
 * Finds the row of one connection, starting from its account name. The
 * account is on the line under the name, or is the name itself when the
 * connection is named after it, so the row is found as the list item around it.
 */
const findConnectionRow = async (connection: Connection): Promise<HTMLElement> => {
  const row = (await screen.findByText(connection.displayName)).closest("li");
  if (row === null) throw new Error(`${connection.displayName} is in no row`);
  return row;
};

/** Finds the offer row of one catalogued type. */
const findTypeOffer = async (displayName: string): Promise<HTMLElement> =>
  findGroupOffering(await screen.findByText(displayName), "Connect");

/** Returns the setup or settings form that holds the field labelled `label`. */
const getFormWithField = (label: string | RegExp): HTMLElement => {
  const form = screen.getByLabelText(label).closest("form");
  if (form === null) throw new Error(`the field ${String(label)} is in no form`);
  return form;
};

/** Returns the suggestions in the datalist of the input labelled `label`. */
const readSuggestions = (label: string): readonly string[] => {
  const input = screen.getByLabelText<HTMLInputElement>(label);
  const id = input.getAttribute("list");
  const list = id === null ? null : document.getElementById(id);
  if (list === null) throw new Error(`${label} offers no suggestions`);
  return [...list.querySelectorAll("option")].map((option) => option.value);
};

/** Checks that the open setup form asks for neither a name nor a topic. */
const expectNoNameOrTopic = (): void => {
  expect(screen.queryByLabelText("Name")).toBeNull();
  expect(screen.queryByLabelText("Topic")).toBeNull();
};

/**
 * Checks that `message` is shown in the same group as `field`, and not in a
 * group that also holds `other`.
 */
const expectMessageAtField = (
  message: string,
  field: HTMLElement,
  other: HTMLElement | null,
): void => {
  const shown = screen.getByText(new RegExp(message));
  let group: HTMLElement = shown;
  while (group.parentElement !== null && !group.contains(field)) {
    group = group.parentElement;
  }
  expect(group.contains(field)).toBe(true);
  if (other !== null) expect(group.contains(other)).toBe(false);
};

const buildRefusal = (message: string, issues: readonly { path: string[]; message: string }[]) => ({
  status: 400,
  body: { error: { code: "validation", message, details: { issues } } },
});

describe("Connections", () => {
  it("offers every catalogued type when nothing is connected, and nothing else", async () => {
    await openApp([]);

    expect(readPageText()).toContain("Nothing connected yet.");

    for (const displayName of ["Paper Trail", "Skyline", "Chatterbox", "Glasshouse"]) {
      const offer = await findTypeOffer(displayName);
      expect(within(offer).getByRole("button", { name: "Connect" }).hasAttribute("disabled")).toBe(
        false,
      );
    }
    // The rows come only from the catalog: no row for a plugin that contributes
    // to another extension point, and no hard-coded account name. The lead text
    // above them still mentions GitHub, Gmail, Discord and Slack, but that text
    // explains what a connection is and is not a row.
    const offered = screen
      .getAllByRole("button", { name: "Connect" })
      .map((connect) =>
        readPageText(findGroupOffering(connect, "Connect").querySelector<HTMLElement>("b")),
      );
    expect(offered).toEqual(["Paper Trail", "Skyline", "Chatterbox", "Glasshouse"]);
    // Each name has the plugin that declares the type under it, because two
    // plugins may declare the same type name.
    expect(readPageText(await findTypeOffer("Paper Trail"))).toContain("paper-trail plugin");
    expect(readPageText(await findTypeOffer("Skyline"))).toContain("skyline plugin");
  });

  it("shows two plugins that declare the same type name as two rows, each with its plugin", async () => {
    const buildGmailPlugin = (id: string): Plugin => ({
      ...buildPlugin(id, { type: `${id}/gmail`, displayName: "Gmail" }),
      contributions: [
        {
          extensionPoint: "connection-type",
          id: `${id}/gmail`,
          definition: {
            type: `${id}/gmail`,
            displayName: "Gmail",
            setup: [{ kind: "credentials", fields: [{ name: "token", label: "Access token" }] }],
          },
        },
      ],
    });
    const api = stubApi({
      ...buildController(() => []),
      "GET /api/v1/plugins": { body: [buildGmailPlugin("first"), buildGmailPlugin("second")] },
    });
    await renderApp({ path: "/connections", api: api.fetch, token: "held" });

    const rows = (await screen.findAllByRole("button", { name: "Connect" })).map((connect) =>
      readPageText(findGroupOffering(connect, "Connect")),
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("Gmail");
    expect(rows[1]).toContain("Gmail");
    expect(rows[0]).toContain("first plugin");
    expect(rows[1]).toContain("second plugin");
  });

  it("shows each connection's account, status and topic", async () => {
    await openApp([PAPER, SKY]);

    const paper = readPageText(await findConnectionRow(PAPER));
    expect(paper).toContain("Paper Trail");
    expect(paper).toContain("work");
    expect(paper).toContain("acct:paper-work");
    expect(paper).toMatch(/connected/i);
    expect(paper).toContain("Code");
    expect(paper).toContain("paper-trail plugin");

    const sky = readPageText(await findConnectionRow(SKY));
    expect(sky).toContain("Skyline");
    expect(sky).toContain("personal");
    expect(sky).toContain("rogier@skyline.test");
    expect(sky).toMatch(/needs.reauth/i);
    expect(sky).toContain("the refresh token was rejected");
    expect(sky).toContain("Business");
  });

  it("shows the account once when the connection is named after it, and no topic when it has none", async () => {
    await openApp([UNNAMED]);

    const row = await findConnectionRow(UNNAMED);
    expect(within(row).getAllByText(UNNAMED.displayName)).toHaveLength(1);
    // The line under the name holds only the plugin: no account, no topic, no separator.
    expect(readPageText(row)).toContain("glasshouse plugin");
    expect(readPageText(row)).not.toContain("·");
  });

  it("shows no account for an account with no name, which the type's name stands in for", async () => {
    await openApp([{ ...UNNAMED, label: "Glasshouse", displayName: "" }]);

    // The row has no account text to find it by, and it is the only row.
    const row = (await screen.findByRole("button", { name: "Configure" })).closest("li");
    if (row === null) throw new Error("Configure is in no row");
    // The line under the name holds only the plugin: no empty account after a separator.
    expect(readPageText(row)).toContain("glasshouse plugin");
    expect(readPageText(row)).not.toContain("·");
  });

  it("leaves out a plugin named like its type, on its row and on its offer", async () => {
    const api = stubApi({
      ...buildController(() => [UNNAMED]),
      "GET /api/v1/plugins": {
        body: [{ ...buildPlugin("glasshouse", GLASS_TYPE), displayName: "Glasshouse" }],
      },
    });
    await renderApp({ path: "/connections", api: api.fetch, token: "held" });

    // The row shows the type's name once, and has no line under it.
    const row = await findConnectionRow(UNNAMED);
    expect(within(row).getAllByText("Glasshouse")).toHaveLength(1);
    expect(readPageText(row)).not.toContain("·");
    // The offer's line under the name holds only what setting the type up takes.
    const offer = findGroupOffering(screen.getByRole("button", { name: "Connect" }), "Connect");
    expect(readPageText(offer.querySelector<HTMLElement>("small"))).toBe(
      "sign in with Glasshouse or paste a token",
    );
  });

  it("shows both the name and the account once the connection is renamed", async () => {
    await openApp([{ ...UNNAMED, label: "personal" }]);

    const row = readPageText(await findConnectionRow(UNNAMED));
    expect(row).toContain("personal");
    expect(row).toContain("octo-glass");
  });

  it("still offers every type once something is connected", async () => {
    await openApp([PAPER, SKY]);

    await findTypeOffer("Chatterbox");
    expect(screen.getAllByRole("button", { name: "Connect" })).toHaveLength(4);
  });

  it("fetches the list again when a connection changes elsewhere", async () => {
    const { api, live, hold } = await openApp([PAPER]);
    await waitFor(() => {
      expect(live.topics()).toContain("connection");
    });
    const before = countConnectionReads(api);

    hold([PAPER, SKY]);
    act(() => {
      live.push("connection", { _tag: "invalidate", ids: [SKY.id], kind: "created" });
    });

    expect(await screen.findByText(SKY.displayName)).toBeDefined();
    expect(countConnectionReads(api)).toBeGreaterThan(before);
  });
});

describe("Connections > setting up a connection", () => {
  const created: Connection = { ...PAPER, id: "0199c0ff-cccc-7000-8000-000000000003" };

  it("shows the fields the type asks for, as password inputs, and nothing else", async () => {
    const user = userEvent.setup();
    await openApp([]);

    await user.click(
      within(await findTypeOffer("Paper Trail")).getByRole("button", { name: "Connect" }),
    );

    // The form replaces the offers, so it has a heading naming what is set up.
    expect(readPageText()).toContain("Connect Paper Trail");
    expect(readPageText()).toContain(CHECKLIST);
    expect(screen.getByLabelText<HTMLInputElement>("Access token").type).toBe("password");
    // The new connection is named after its account and has no topic, so
    // setup asks for neither.
    expectNoNameOrTopic();
  });

  it("sends only the credential, and shows the new connection", async () => {
    const user = userEvent.setup();
    const { api, hold } = await openApp([], {
      "POST /api/v1/connections": { status: 201, body: created },
    });

    await user.click(
      within(await findTypeOffer("Paper Trail")).getByRole("button", { name: "Connect" }),
    );
    await user.type(screen.getByLabelText("Access token"), "pt-secret-9931");
    hold([created]);
    // Cancel comes before Connect.
    const form = getFormWithField("Access token");
    const connect = within(form).getByRole("button", { name: "Connect" });
    expectInDocumentOrder([within(form).getByRole("button", { name: "Cancel" }), connect]);
    await user.click(connect);

    await waitFor(() => {
      expect(listWrites(api)).toHaveLength(1);
    });
    expect(listWrites(api)[0]).toMatchObject({ method: "POST", path: "/api/v1/connections" });
    expect(listWrites(api)[0]?.body).toEqual({
      type: "paper-trail/paper",
      credentials: { token: "pt-secret-9931" },
    });

    // The setup form is closed, and the new connection's row is on the page.
    await waitFor(() => {
      expect(screen.queryByLabelText("Access token")).toBeNull();
    });
    expect(readPageText(await findConnectionRow(created))).toContain("acct:paper-work");
  });

  it("shows a rejected credential's error under that field", async () => {
    const user = userEvent.setup();
    const complaint = "Paper Trail rejected that token";
    await openApp([], {
      "POST /api/v1/connections": buildRefusal("the credentials were refused", [
        { path: ["credentials", "token"], message: complaint },
      ]),
    });

    await user.click(
      within(await findTypeOffer("Paper Trail")).getByRole("button", { name: "Connect" }),
    );
    await user.type(screen.getByLabelText("Access token"), "pt-secret-9931");
    await user.click(
      within(getFormWithField("Access token")).getByRole("button", { name: "Connect" }),
    );

    await screen.findByText(new RegExp(complaint));
    expectMessageAtField(
      complaint,
      screen.getByLabelText("Access token"),
      screen.getByRole("button", { name: "Connect" }),
    );
  });

  it("says pairing is not built yet instead of showing a form", async () => {
    const user = userEvent.setup();
    await openApp([]);

    await user.click(
      within(await findTypeOffer("Chatterbox")).getByRole("button", { name: "Connect" }),
    );

    expect(readPageText()).toContain("not built yet");
  });
});

describe("Connections > a redirect flow", () => {
  const AUTHORIZATION_URL =
    "https://skyline.test/oauth/authorize?client_id=sky&state=s-1&code_challenge=c-1";

  /**
   * Replaces `window.location` with one whose `assign` is a mock, and returns
   * that mock. jsdom does not navigate.
   */
  const watchNavigation = (): ReturnType<typeof vi.fn> => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, origin: window.location.origin, assign });
    return assign;
  };

  it("shows the redirect URI to register, and sends the browser to the provider", async () => {
    const user = userEvent.setup();
    const assign = watchNavigation();
    const { api } = await openApp([], {
      "POST /api/v1/oauth/start": { body: { authorizationUrl: AUTHORIZATION_URL } },
    });

    await user.click(
      within(await findTypeOffer("Skyline")).getByRole("button", { name: "Connect" }),
    );

    expect(readPageText()).toContain(`${window.location.origin}/oauth/callback`);
    expectNoNameOrTopic();

    // The offers are gone while the form is open, so its button is the only Connect.
    await user.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => {
      expect(listWrites(api)).toHaveLength(1);
    });
    expect(listWrites(api)[0]).toMatchObject({ method: "POST", path: "/api/v1/oauth/start" });
    expect(listWrites(api)[0]?.body).toEqual({
      type: "skyline/mail",
      origin: window.location.origin,
    });
    await waitFor(() => {
      expect(assign.mock.calls).toEqual([[AUTHORIZATION_URL]]);
    });
    vi.unstubAllGlobals();
  });

  it("shows a success notice after a redirect that worked", async () => {
    await openApp([PAPER], {}, "/connections?oauth=ok");

    expect(readPageText(await screen.findByRole("status"))).toMatch(/connected/i);
  });

  it("shows what went wrong after a redirect that failed", async () => {
    await openApp([PAPER], {}, "/connections?oauth=denied");

    expect(readPageText(await screen.findByRole("alert"))).toContain("denied");
  });

  it("does not show an unknown outcome value from the address", async () => {
    await openApp([PAPER], {}, "/connections?oauth=%3Cscript%3Eboom%3C%2Fscript%3E");

    const alert = readPageText(await screen.findByRole("alert"));
    expect(alert).toBe("The setup did not finish.");
    expect(alert).not.toContain("boom");
  });
});

describe("Connections > reconnecting and removing", () => {
  const STALE: Connection = { ...PAPER, status: "needs-reauth", statusDetail: "token revoked" };

  it("sends a fresh pasted credential for an existing connection", async () => {
    const user = userEvent.setup();
    const { api } = await openApp([STALE], {
      [`POST /api/v1/connections/${STALE.id}/credentials`]: { body: PAPER },
    });

    await user.click(
      within(await findConnectionRow(STALE)).getByRole("button", { name: "Reconnect" }),
    );
    expect(readPageText()).toContain("Reconnect Paper Trail");
    expectNoNameOrTopic();
    await user.type(await screen.findByLabelText("Access token"), "pt-secret-fresh");
    await user.click(
      within(getFormWithField("Access token")).getByRole("button", { name: "Connect" }),
    );

    await waitFor(() => {
      expect(listWrites(api)).toHaveLength(1);
    });
    expect(listWrites(api)[0]).toMatchObject({
      method: "POST",
      path: `/api/v1/connections/${STALE.id}/credentials`,
    });
    expect(listWrites(api)[0]?.body).toEqual({
      credentials: { token: "pt-secret-fresh" },
    });
  });

  it("starts a redirect flow for an existing connection", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("location", {
      ...window.location,
      origin: window.location.origin,
      assign: vi.fn(),
    });
    const { api } = await openApp([SKY], {
      "POST /api/v1/oauth/start": { body: { authorizationUrl: "https://skyline.test/again" } },
    });

    const row = await findConnectionRow(SKY);
    await user.click(within(row).getByRole("button", { name: "Reconnect" }));
    // The connection keeps its name and topic, so a reconnect does not ask for them.
    expectNoNameOrTopic();
    await user.click(within(row).getByRole("button", { name: "Connect" }));

    await waitFor(() => {
      expect(listWrites(api)).toHaveLength(1);
    });
    expect(listWrites(api)[0]).toMatchObject({ method: "POST", path: "/api/v1/oauth/start" });
    expect(listWrites(api)[0]?.body).toEqual({
      type: "skyline/mail",
      origin: window.location.origin,
      connectionId: SKY.id,
    });
    vi.unstubAllGlobals();
  });

  it("asks for confirmation, then removes the connection", async () => {
    const user = userEvent.setup();
    const { api, hold } = await openApp([PAPER, SKY], {
      [`DELETE /api/v1/connections/${SKY.id}`]: { body: {} },
    });

    const row = await findConnectionRow(SKY);
    await user.click(within(row).getByRole("button", { name: "Delete" }));

    expect(listWrites(api)).toEqual([]);
    // Hercule cannot take back a credential it was given, so the user is told.
    expect(readPageText(row)).toContain(
      "Hercule forgets its credentials but does not revoke them at Skyline.",
    );
    // Cancel comes before Confirm.
    const confirm = within(row).getByRole("button", { name: "Confirm" });
    expectInDocumentOrder([within(row).getByRole("button", { name: "Cancel" }), confirm]);

    hold([PAPER]);
    await user.click(confirm);

    await waitFor(() => {
      expect(listWrites(api).map((call) => `${call.method} ${call.path}`)).toEqual([
        `DELETE /api/v1/connections/${SKY.id}`,
      ]);
    });
    await waitFor(() => {
      expect(screen.queryByText(SKY.displayName)).toBeNull();
    });
    expect(screen.getByText(PAPER.displayName)).toBeDefined();
  });
});

describe("Connections > configuring a connection", () => {
  it("shows the type's own settings beside the name and the topic", async () => {
    const user = userEvent.setup();
    const { api } = await openApp([PAPER], {
      [`PATCH /api/v1/connections/${PAPER.id}`]: { body: PAPER },
    });

    await user.click(
      within(await findConnectionRow(PAPER)).getByRole("button", { name: "Configure" }),
    );

    expect(screen.getByLabelText<HTMLInputElement>(/folder/i).value).toBe("inbox");
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("work");
    expect(screen.getByLabelText<HTMLInputElement>("Topic").value).toBe("Code");
    expect(readSuggestions("Topic")).toEqual(
      expect.arrayContaining(["Code", "Business", "Personal", "Ops"]),
    );

    await user.clear(screen.getByLabelText(/folder/i));
    await user.type(screen.getByLabelText(/folder/i), "archive");
    const form = getFormWithField("Name");
    const save = within(form).getByRole("button", { name: "Save" });
    expectInDocumentOrder([within(form).getByRole("button", { name: "Cancel" }), save]);
    await user.click(save);

    await waitFor(() => {
      expect(listWrites(api)).toHaveLength(1);
    });
    expect(listWrites(api)[0]).toMatchObject({
      method: "PATCH",
      path: `/api/v1/connections/${PAPER.id}`,
    });
    // The topic was not touched, so no topics are sent, and the connection
    // keeps both `Code` and `Ops`.
    expect(api.calls.find((call) => call.method === "PATCH")?.body).toEqual({
      label: "work",
      config: { folder: "archive" },
    });
  });

  it("renames a connection named after its account and gives it a topic", async () => {
    const user = userEvent.setup();
    const { api } = await openApp([UNNAMED], {
      [`PATCH /api/v1/connections/${UNNAMED.id}`]: { body: UNNAMED },
    });

    await user.click(
      within(await findConnectionRow(UNNAMED)).getByRole("button", { name: "Configure" }),
    );
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("octo-glass");
    expect(screen.getByLabelText<HTMLInputElement>("Topic").value).toBe("");

    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "personal");
    await user.type(screen.getByLabelText("Topic"), "Code");
    await user.click(within(getFormWithField("Name")).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(listWrites(api)).toHaveLength(1);
    });
    expect(listWrites(api)[0]?.body).toEqual({
      label: "personal",
      labels: ["Code"],
      config: {},
    });
  });

  it("keeps the other topics when the first one changes", async () => {
    const user = userEvent.setup();
    const { api } = await openApp([PAPER], {
      [`PATCH /api/v1/connections/${PAPER.id}`]: { body: PAPER },
    });

    await user.click(
      within(await findConnectionRow(PAPER)).getByRole("button", { name: "Configure" }),
    );
    await user.clear(screen.getByLabelText("Topic"));
    await user.type(screen.getByLabelText("Topic"), "Business");
    await user.click(within(getFormWithField("Name")).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(listWrites(api)).toHaveLength(1);
    });
    // The form shows only `Code`; `Ops` was set elsewhere and stays.
    expect(listWrites(api)[0]?.body).toEqual({
      label: "work",
      labels: ["Business", "Ops"],
      config: { folder: "inbox" },
    });
  });

  it("removes only the first topic once the user clears it", async () => {
    const user = userEvent.setup();
    const { api } = await openApp([PAPER], {
      [`PATCH /api/v1/connections/${PAPER.id}`]: { body: PAPER },
    });

    await user.click(
      within(await findConnectionRow(PAPER)).getByRole("button", { name: "Configure" }),
    );
    await user.clear(screen.getByLabelText("Topic"));
    await user.click(within(getFormWithField("Name")).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(listWrites(api)).toHaveLength(1);
    });
    expect(listWrites(api)[0]?.body).toEqual({
      label: "work",
      labels: ["Ops"],
      config: { folder: "inbox" },
    });
  });

  it("shows a rejected setting's error under that setting", async () => {
    const user = userEvent.setup();
    const complaint = "no such folder";
    await openApp([PAPER], {
      [`PATCH /api/v1/connections/${PAPER.id}`]: buildRefusal("the settings were refused", [
        { path: ["config", "folder"], message: complaint },
      ]),
    });

    await user.click(
      within(await findConnectionRow(PAPER)).getByRole("button", { name: "Configure" }),
    );
    await user.click(within(getFormWithField("Name")).getByRole("button", { name: "Save" }));

    await screen.findByText(new RegExp(complaint));
    expectMessageAtField(
      complaint,
      screen.getByLabelText(/folder/i),
      screen.getByLabelText("Name"),
    );
  });

  it("shows only the name and the topic for a type with no settings of its own", async () => {
    const user = userEvent.setup();
    await openApp([SKY]);

    await user.click(
      within(await findConnectionRow(SKY)).getByRole("button", { name: "Configure" }),
    );

    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("personal");
    expect(screen.getByLabelText<HTMLInputElement>("Topic").value).toBe("Business");
    expect(screen.queryByLabelText(/folder/i)).toBeNull();
  });
});

describe("Connections > a device flow", () => {
  const START = {
    setupId: "setup-1",
    userCode: "WDJB-MJHT",
    verificationUri: "https://glasshouse.test/login/device",
    expiresAt: "2026-10-02T09:00:00.000Z",
    interval: 5,
  };
  const START_PATH = "/api/v1/oauth/device/start";
  const POLL_PATH = "/api/v1/oauth/device/poll";

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Returns a handler that answers each poll with the next outcome, then repeats the last. */
  const answerPolls = (...outcomes: readonly unknown[]): Handler => {
    let index = 0;
    return () => ({ body: outcomes[Math.min(index++, outcomes.length - 1)] });
  };

  const countPolls = (api: { readonly calls: readonly { path: string }[] }) =>
    api.calls.filter((call) => call.path === POLL_PATH).length;

  /** Advances the fake clock, and lets React and the promises it resolves catch up. */
  const advanceClock = (milliseconds: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(milliseconds);
    });

  /**
   * Advances the fake clock a millisecond at a time until `predicate` returns
   * true. A response reaches the screen through a few promises and a timer or
   * two, and `findBy*` never fires while the clock is fake.
   */
  const pumpUntil = async (predicate: () => boolean): Promise<void> => {
    for (let step = 0; step < 50; step++) {
      if (predicate()) return;
      await advanceClock(1);
    }
    throw new Error("the condition never became true");
  };

  const isCodeShown = (code: string) => () => screen.queryByText(code) !== null;

  /**
   * Opens the Glasshouse setup and starts the device flow under a fake clock.
   * The clock is faked only now, because user-event waits on timers that a
   * fake clock never fires.
   */
  const startSignIn = async (extra: Readonly<Record<string, Handler>>) => {
    const user = userEvent.setup();
    const app = await openApp([], { [`POST ${START_PATH}`]: { body: START }, ...extra });
    await user.click(
      within(await findTypeOffer("Glasshouse")).getByRole("button", { name: "Connect" }),
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(screen.getByRole("button", { name: "Sign in with Glasshouse" }));
    await pumpUntil(isCodeShown(START.userCode));
    return app;
  };

  it("offers the device flow first, and pasting a token as the alternative", async () => {
    const user = userEvent.setup();
    await openApp([]);

    expect(readPageText(await findTypeOffer("Glasshouse"))).toContain(
      "sign in with Glasshouse or paste a token",
    );
    await user.click(
      within(await findTypeOffer("Glasshouse")).getByRole("button", { name: "Connect" }),
    );

    const signIn = screen.getByRole("button", { name: "Sign in with Glasshouse" });
    const paste = screen.getByRole("button", { name: "Paste a token instead" });
    expectInDocumentOrder([screen.getByRole("button", { name: "Cancel" }), signIn, paste]);
    expect(screen.queryByLabelText("Personal access token")).toBeNull();
    // The sign-in is the whole setup: no name, no topic.
    expectNoNameOrTopic();
  });

  it("does not offer a choice for a type with one flow", async () => {
    const user = userEvent.setup();
    await openApp([]);

    await user.click(
      within(await findTypeOffer("Paper Trail")).getByRole("button", { name: "Connect" }),
    );

    expect(screen.queryByRole("button", { name: /instead/ })).toBeNull();
  });

  it("shows the code, waits for the approval, and then shows the new connection", async () => {
    const { api, hold } = await startSignIn({
      [`POST ${POLL_PATH}`]: answerPolls(
        { status: "pending", interval: 5 },
        { status: "unreachable", interval: 5 },
        { status: "done", connection: GLASS },
      ),
    });

    expect(listWrites(api)[0]).toMatchObject({ method: "POST", path: START_PATH });
    expect(listWrites(api)[0]?.body).toEqual({ type: "glasshouse/glass" });
    expect(readPageText()).toContain("Connect Glasshouse");
    expect(screen.getByRole("button", { name: "Copy code" })).toBeDefined();
    const open = screen.getByRole("link", { name: "Open Glasshouse" });
    expect(open.getAttribute("href")).toBe(START.verificationUri);
    expect(open.getAttribute("target")).toBe("_blank");
    expect(open.getAttribute("rel")).toBe("noopener noreferrer");
    expectInDocumentOrder([screen.getByRole("button", { name: "Cancel" }), open]);
    expect(readPageText(screen.getByRole("status"))).toContain("Waiting for you to approve");

    // The first poll waits for the interval the start returned.
    await advanceClock(4000);
    expect(countPolls(api)).toBe(0);
    await advanceClock(1500);
    expect(countPolls(api)).toBe(1);

    // A provider that cannot be reached leaves the flow open.
    await advanceClock(6000);
    expect(countPolls(api)).toBe(2);
    expect(readPageText(screen.getByRole("status"))).toContain("Cannot reach Glasshouse");

    hold([GLASS]);
    await advanceClock(6000);
    expect(countPolls(api)).toBe(3);
    await pumpUntil(() => screen.queryByText(START.userCode) === null);

    vi.useRealTimers();
    expect(readPageText(await findConnectionRow(GLASS))).toContain("octo-glass");
  });

  it("polls more slowly once the provider asks it to", async () => {
    const { api } = await startSignIn({
      [`POST ${POLL_PATH}`]: answerPolls({ status: "slow-down", interval: 10 }),
    });

    await advanceClock(5500);
    expect(countPolls(api)).toBe(1);
    await advanceClock(8000);
    expect(countPolls(api)).toBe(1);
    await advanceClock(3000);
    expect(countPolls(api)).toBe(2);
  });

  it("says why the flow ended, stops polling, and starts again with a new code", async () => {
    // The controller's own words when the provider answers `expired_token`.
    const message = "the code expired before it was approved";
    let starts = 0;
    const { api } = await startSignIn({
      [`POST ${START_PATH}`]: () => {
        starts++;
        return {
          body: starts === 1 ? START : { ...START, setupId: "setup-2", userCode: "KQRT-ZXPV" },
        };
      },
      [`POST ${POLL_PATH}`]: answerPolls({ status: "expired", message }),
    });

    await advanceClock(5500);
    const alert = readPageText(screen.getByRole("alert"));
    expect(alert).toContain("The sign-in expired before it was approved.");
    expect(alert).toContain(message);
    expect(screen.queryByText(START.userCode)).toBeNull();
    await advanceClock(30_000);
    expect(countPolls(api)).toBe(1);

    const again = screen.getByRole("button", { name: "Start again" });
    expectInDocumentOrder([screen.getByRole("button", { name: "Cancel" }), again]);
    fireEvent.click(again);
    await pumpUntil(isCodeShown("KQRT-ZXPV"));

    expect(starts).toBe(2);
    expect(listWrites(api).filter((call) => call.path === START_PATH)[1]?.body).toEqual({
      type: "glasshouse/glass",
    });
  });

  // The controller's own words for each ending, beside the line the screen shows.
  it.each([
    {
      status: "denied",
      message: "the request was declined at the provider",
      line: "The sign-in was declined, so nothing was connected.",
    },
    {
      status: "failed",
      message: "the provider refused the device flow with the error device_flow_disabled",
      line: "The sign-in failed, so nothing was connected.",
    },
  ])("shows a short line and the controller's reason when the flow is $status", async (ending) => {
    await startSignIn({
      [`POST ${POLL_PATH}`]: answerPolls({ status: ending.status, message: ending.message }),
    });

    await advanceClock(5500);
    const alert = readPageText(screen.getByRole("alert"));
    expect(alert).toContain(ending.line);
    expect(alert).toContain(ending.message);
  });

  it("keeps polling at the last interval after a poll request fails", async () => {
    let polls = 0;
    const { api, hold } = await startSignIn({
      [`POST ${POLL_PATH}`]: () => {
        polls++;
        if (polls === 1) return { body: { status: "slow-down", interval: 10 } };
        if (polls === 2) {
          return { status: 500, body: buildErrorBody("internal", "the database is locked") };
        }
        return { body: { status: "done", connection: GLASS } };
      },
    });

    await advanceClock(5500);
    expect(countPolls(api)).toBe(1);
    await advanceClock(10_000);
    expect(countPolls(api)).toBe(2);

    // The flow is still open, so the code stays on screen with a note under it.
    expect(screen.getByText(START.userCode)).toBeDefined();
    const status = readPageText(screen.getByRole("status"));
    expect(status).toContain("The last check did not go through. Still trying.");
    expect(status).toContain("the database is locked");

    // The next poll follows at the interval the last reply named, not the start's.
    hold([GLASS]);
    await advanceClock(9000);
    expect(countPolls(api)).toBe(2);
    await advanceClock(1500);
    expect(countPolls(api)).toBe(3);
    await pumpUntil(() => screen.queryByText(START.userCode) === null);

    vi.useRealTimers();
    expect(readPageText(await findConnectionRow(GLASS))).toContain("octo-glass");
  });

  it("shows why the code could not be fetched, and lets the user try again", async () => {
    const user = userEvent.setup();
    let starts = 0;
    const { api } = await openApp([], {
      [`POST ${START_PATH}`]: () => {
        starts++;
        return starts === 1
          ? { status: 500, body: buildErrorBody("internal", "the database is locked") }
          : { body: START };
      },
    });
    await user.click(
      within(await findTypeOffer("Glasshouse")).getByRole("button", { name: "Connect" }),
    );

    await user.click(screen.getByRole("button", { name: "Sign in with Glasshouse" }));

    expect(readPageText(await screen.findByRole("alert"))).toContain("the database is locked");

    await user.click(screen.getByRole("button", { name: "Sign in with Glasshouse" }));

    expect(await screen.findByText(START.userCode)).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(listWrites(api).filter((call) => call.path === START_PATH)).toHaveLength(2);
  });

  it("does not let a reply that arrives after Cancel close the next setup", async () => {
    let answerPoll: (answer: Answer) => void = () => undefined;
    const { api, hold } = await startSignIn({
      [`POST ${POLL_PATH}`]: () =>
        new Promise<Answer>((resolve) => {
          answerPoll = resolve;
        }),
    });
    await advanceClock(5500);
    expect(countPolls(api)).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    // `findBy*` never fires while the clock is fake, and the offers are back at once.
    const offer = findGroupOffering(screen.getByText("Paper Trail"), "Connect");
    fireEvent.click(within(offer).getByRole("button", { name: "Connect" }));
    expect(screen.getByLabelText("Access token")).toBeDefined();

    // The user approved just before cancelling, so the controller wrote the connection.
    hold([GLASS]);
    answerPoll({ body: { status: "done", connection: GLASS } });
    await pumpUntil(() => screen.queryByText(GLASS.displayName) !== null);

    expect(screen.getByLabelText("Access token")).toBeDefined();
  });

  it("stops polling once the user cancels", async () => {
    const { api } = await startSignIn({
      [`POST ${POLL_PATH}`]: answerPolls({ status: "pending", interval: 5 }),
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await advanceClock(30_000);

    expect(screen.queryByText(START.userCode)).toBeNull();
    expect(countPolls(api)).toBe(0);
  });

  it("still lets the user paste a token instead", async () => {
    const user = userEvent.setup();
    const { api } = await openApp([], {
      "POST /api/v1/connections": { status: 201, body: GLASS },
    });

    await user.click(
      within(await findTypeOffer("Glasshouse")).getByRole("button", { name: "Connect" }),
    );
    await user.click(screen.getByRole("button", { name: "Paste a token instead" }));

    // The way back to the preferred flow stays on offer.
    expect(screen.getByRole("button", { name: "Sign in with Glasshouse instead" })).toBeDefined();
    expectNoNameOrTopic();
    await user.type(screen.getByLabelText("Personal access token"), "ghp-glass-1");
    await user.click(
      within(getFormWithField("Personal access token")).getByRole("button", { name: "Connect" }),
    );

    await waitFor(() => {
      expect(listWrites(api)).toHaveLength(1);
    });
    expect(listWrites(api)[0]).toMatchObject({ method: "POST", path: "/api/v1/connections" });
    expect(listWrites(api)[0]?.body).toEqual({
      type: "glasshouse/glass",
      credentials: { token: "ghp-glass-1" },
    });
  });

  it("reconnects an existing connection through the device flow", async () => {
    const user = userEvent.setup();
    const stale: Connection = { ...GLASS, status: "needs-reauth" };
    const { api } = await openApp([stale], {
      [`POST ${START_PATH}`]: { body: START },
      [`POST ${POLL_PATH}`]: answerPolls({ status: "done", connection: GLASS }),
    });

    await user.click(
      within(await findConnectionRow(stale)).getByRole("button", { name: "Reconnect" }),
    );
    expect(readPageText()).toContain("Reconnect Glasshouse");
    // The connection keeps its name and topic, so a reconnect does not ask for them.
    expectNoNameOrTopic();

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(screen.getByRole("button", { name: "Sign in with Glasshouse" }));
    await pumpUntil(isCodeShown(START.userCode));

    expect(listWrites(api)[0]?.body).toEqual({ type: "glasshouse/glass", connectionId: GLASS.id });

    await advanceClock(5500);
    expect(countPolls(api)).toBe(1);
    await pumpUntil(() => screen.queryByText(START.userCode) === null);
  });
});
