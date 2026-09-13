/**
 * Connections: what the screen says about the accounts Hydra acts through, and
 * what setting one up sends.
 *
 * Everything the screen offers comes from the plugin catalog: the types, their
 * setup steps, their fields and their per-connection settings form. Nothing
 * about GitHub, Gmail or any other account is written into the web app, so the
 * fixtures below are types no plugin in this repository declares - a screen
 * that still shows something for them is a screen reading the catalog.
 *
 * A credential value goes out on a write and never comes back: the wire record
 * carries references only, so a row has no value to leak and the assertions
 * about writes below are about what went out, not what came back.
 */
import { describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp, stubApi, type Handler } from "../../app/testing";

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
  readonly pluginId: string;
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

/** A credentials flow: a checklist, one pasted field, and settings of its own. */
const PAPER_TYPE = {
  type: "paper",
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

/** A redirect flow: nothing to paste, and no settings of its own. */
const SKY_TYPE = {
  type: "skyline",
  displayName: "Skyline",
  setup: [{ kind: "oauth" }],
  oauth: {
    authorizationUrl: "https://skyline.test/oauth/authorize",
    tokenUrl: "https://skyline.test/oauth/token",
    scopes: ["mail.read"],
  },
};

/** A flow the core does not run yet. */
const CHATTER_TYPE = {
  type: "chatter",
  displayName: "Chatterbox",
  setup: [{ kind: "pairing" }],
};

const pluginFor = (id: string, definition: { type: string; displayName: string }): Plugin => ({
  id,
  displayName: definition.displayName,
  hostApi: 1,
  capabilities: ["connections"],
  enabled: true,
  status: { _tag: "active" },
  config: {},
  contributions: [{ extensionPoint: "connection-type", id: definition.type, definition }],
});

/** Installed, but contributing nothing a connection can be made of. */
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
  pluginFor("paper-trail", PAPER_TYPE),
  pluginFor("skyline", SKY_TYPE),
  pluginFor("chatterbox", CHATTER_TYPE),
  BYSTANDER,
];

const PAPER: Connection = {
  id: "0199c0ff-aaaa-7000-8000-000000000001",
  pluginId: "paper-trail",
  type: "paper",
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
  pluginId: "skyline",
  type: "skyline",
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

/** A controller holding `connections`, with the catalog above behind it. */
const controller = (
  connections: () => readonly Connection[],
  extra: Readonly<Record<string, Handler>> = {},
): Readonly<Record<string, Handler>> => ({
  "GET /api/v1/setup": { body: { complete: true } },
  "GET /api/v1/settings": {
    body: {
      controller: {},
      user: { "onboarding.completedSteps": ["timezone"], timezone: "Europe/Amsterdam" },
    },
  },
  "GET /api/v1/plugins": { body: CATALOG },
  "GET /api/v1/connections": () => ({ body: { items: connections() } }),
  ...extra,
});

const open = async (
  connections: readonly Connection[],
  extra: Readonly<Record<string, Handler>> = {},
  path = "/connections",
) => {
  const held = [...connections];
  const api = stubApi(controller(() => held, extra));
  const app = await renderApp({ path, api: api.fetch, token: "held" });
  return {
    ...app,
    api,
    /** What the controller answers with from now on, as a write would leave it. */
    hold: (next: readonly Connection[]) => {
      held.splice(0, held.length, ...next);
    },
  };
};

/** The page's text with its whitespace collapsed, the way a reader sees it. */
const reading = (element: HTMLElement | null = document.body): string =>
  (element?.textContent ?? "").replace(/\s+/g, " ").trim();

/**
 * The writes this screen made, in order. The shell opens a live connection on
 * every screen inside it, and the ticket it fetches is a POST nobody on this
 * screen asked for, so it is not one of them.
 */
const writes = (api: {
  readonly calls: readonly { method: string; path: string; body: unknown }[];
}) => api.calls.filter((call) => call.method !== "GET" && !call.path.endsWith("/auth/ws-ticket"));

const listings = (api: { readonly calls: readonly { path: string }[] }) =>
  api.calls.filter((call) => call.path === "/api/v1/connections").length;

/** The nearest thing around `inner` that is a whole one of `name`. */
const around = (inner: HTMLElement, name: string): HTMLElement => {
  let group: HTMLElement | null = inner.parentElement;
  while (group !== null && within(group).queryByRole("button", { name }) === null) {
    group = group.parentElement;
  }
  if (group === null) throw new Error(`nothing around ${reading(inner)} offers ${name}`);
  return group;
};

/** The row about one connection: what sits around the account it names. */
const rowFor = async (connection: Connection): Promise<HTMLElement> =>
  around(await screen.findByText(connection.displayName), "Delete");

/** The row about one catalogued type in the empty state. */
const offerFor = async (displayName: string): Promise<HTMLElement> =>
  around(await screen.findByText(displayName), "Connect");

/** The setup or settings form holding the field labelled `label`. */
const formWith = (label: string | RegExp): HTMLElement => {
  const form = screen.getByLabelText(label).closest("form");
  if (form === null) throw new Error(`the field ${String(label)} is in no form`);
  return form;
};

/** What the input labelled `label` offers as suggestions, through its datalist. */
const suggestionsFor = (label: string): readonly string[] => {
  const input = screen.getByLabelText<HTMLInputElement>(label);
  const id = input.getAttribute("list");
  const list = id === null ? null : document.getElementById(id);
  if (list === null) throw new Error(`${label} offers no suggestions`);
  return [...list.querySelectorAll("option")].map((option) => option.value);
};

/** Whether the message shown is about that field and no other. */
const messageIsAt = (message: string, field: HTMLElement, other: HTMLElement | null): void => {
  const shown = screen.getByText(new RegExp(message));
  let group: HTMLElement = shown;
  while (group.parentElement !== null && !group.contains(field)) {
    group = group.parentElement;
  }
  expect(group.contains(field)).toBe(true);
  if (other !== null) expect(group.contains(other)).toBe(false);
};

const refusal = (message: string, issues: readonly { path: string[]; message: string }[]) => ({
  status: 400,
  body: { error: { code: "validation", message, details: { issues } } },
});

describe("Connections", () => {
  it("offers every catalogued type when nothing is connected, and nothing else", async () => {
    await open([]);

    expect(reading()).toContain("Nothing connected yet.");

    for (const displayName of ["Paper Trail", "Skyline", "Chatterbox"]) {
      const offer = await offerFor(displayName);
      expect(within(offer).getByRole("button", { name: "Connect" }).hasAttribute("disabled")).toBe(
        false,
      );
    }
    // The rows are the catalog and nothing else: not a plugin contributing to
    // another extension point, and not a name the web app was once written to
    // know about. The lead above them still names GitHub, Gmail, Discord and
    // Slack - it is a sentence about what a connection is, not a row.
    const offered = screen
      .getAllByRole("button", { name: "Connect" })
      .map((connect) => reading(around(connect, "Connect").querySelector<HTMLElement>("b")));
    expect(offered).toEqual(["Paper Trail", "Skyline", "Chatterbox"]);
  });

  it("says which account each connection is, where it stands and where it files", async () => {
    await open([PAPER, SKY]);

    const paper = reading(await rowFor(PAPER));
    expect(paper).toContain("Paper Trail");
    expect(paper).toContain("work");
    expect(paper).toContain("acct:paper-work");
    expect(paper).toMatch(/connected/i);
    expect(paper).toContain("Code");

    const sky = reading(await rowFor(SKY));
    expect(sky).toContain("Skyline");
    expect(sky).toContain("personal");
    expect(sky).toContain("rogier@skyline.test");
    expect(sky).toMatch(/needs.reauth/i);
    expect(sky).toContain("the refresh token was rejected");
    expect(sky).toContain("Business");
  });

  it("still offers every type once something is connected", async () => {
    await open([PAPER, SKY]);

    await offerFor("Chatterbox");
    expect(screen.getAllByRole("button", { name: "Connect" })).toHaveLength(3);
  });

  it("reads the list again when a connection changes elsewhere", async () => {
    const { api, live, hold } = await open([PAPER]);
    await waitFor(() => {
      expect(live.topics()).toContain("connection");
    });
    const before = listings(api);

    hold([PAPER, SKY]);
    act(() => {
      live.push("connection", { _tag: "invalidate", ids: [SKY.id], kind: "created" });
    });

    expect(await screen.findByText(SKY.displayName)).toBeDefined();
    expect(listings(api)).toBeGreaterThan(before);
  });
});

describe("Connections > setting one up", () => {
  const created: Connection = { ...PAPER, id: "0199c0ff-cccc-7000-8000-000000000003" };

  const fill = async (user: ReturnType<typeof userEvent.setup>): Promise<void> => {
    await user.type(screen.getByLabelText("Access token"), "pt-secret-9931");
    await user.type(screen.getByLabelText("Label"), "work");
    await user.type(screen.getByLabelText("Default topic"), "Code");
  };

  it("shows what the type asks for, and asks for it in secret", async () => {
    const user = userEvent.setup();
    await open([]);

    await user.click(
      within(await offerFor("Paper Trail")).getByRole("button", { name: "Connect" }),
    );

    expect(reading()).toContain(CHECKLIST);
    expect(screen.getByLabelText<HTMLInputElement>("Access token").type).toBe("password");
    expect(screen.getByLabelText("Label")).toBeDefined();
    expect(suggestionsFor("Default topic")).toEqual(
      expect.arrayContaining(["Code", "Business", "Personal", "Ops"]),
    );
  });

  it("sends what was filled in, and shows the connection it made", async () => {
    const user = userEvent.setup();
    const { api, hold } = await open([], {
      "POST /api/v1/connections": { status: 201, body: created },
    });

    await user.click(
      within(await offerFor("Paper Trail")).getByRole("button", { name: "Connect" }),
    );
    await fill(user);
    hold([created]);
    await user.click(within(formWith("Label")).getByRole("button", { name: "Connect" }));

    await waitFor(() => {
      expect(writes(api)).toHaveLength(1);
    });
    expect(writes(api)[0]).toMatchObject({ method: "POST", path: "/api/v1/connections" });
    expect(writes(api)[0]?.body).toEqual({
      type: "paper",
      label: "work",
      labels: ["Code"],
      config: {},
      credentials: { token: "pt-secret-9931" },
    });

    // The setup is done with, and the row it made is on the page.
    await waitFor(() => {
      expect(screen.queryByLabelText("Access token")).toBeNull();
    });
    expect(reading(await rowFor(created))).toContain("acct:paper-work");
  });

  it("puts a refused credential's message under the field it was about", async () => {
    const user = userEvent.setup();
    const complaint = "Paper Trail rejected that token";
    await open([], {
      "POST /api/v1/connections": refusal("the credentials were refused", [
        { path: ["credentials", "token"], message: complaint },
      ]),
    });

    await user.click(
      within(await offerFor("Paper Trail")).getByRole("button", { name: "Connect" }),
    );
    await fill(user);
    await user.click(within(formWith("Label")).getByRole("button", { name: "Connect" }));

    await screen.findByText(new RegExp(complaint));
    messageIsAt(complaint, screen.getByLabelText("Access token"), screen.getByLabelText("Label"));
  });

  it("says pairing is not built yet rather than offering a form", async () => {
    const user = userEvent.setup();
    await open([]);

    await user.click(within(await offerFor("Chatterbox")).getByRole("button", { name: "Connect" }));

    expect(reading()).toContain("not built yet");
  });
});

describe("Connections > a redirect flow", () => {
  const AUTHORIZATION_URL =
    "https://skyline.test/oauth/authorize?client_id=sky&state=s-1&code_challenge=c-1";

  /** A window whose navigation a test can watch. jsdom performs none. */
  const watchNavigation = (): ReturnType<typeof vi.fn> => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, origin: window.location.origin, assign });
    return assign;
  };

  it("shows the redirect URI to register, and hands the browser to the provider", async () => {
    const user = userEvent.setup();
    const assign = watchNavigation();
    const { api } = await open([], {
      "POST /api/v1/oauth/start": { body: { authorizationUrl: AUTHORIZATION_URL } },
    });

    await user.click(within(await offerFor("Skyline")).getByRole("button", { name: "Connect" }));

    expect(reading()).toContain(`${window.location.origin}/oauth/callback`);

    await user.type(screen.getByLabelText("Label"), "personal");
    await user.type(screen.getByLabelText("Default topic"), "Business");
    await user.click(within(formWith("Label")).getByRole("button", { name: "Connect" }));

    await waitFor(() => {
      expect(writes(api)).toHaveLength(1);
    });
    expect(writes(api)[0]).toMatchObject({ method: "POST", path: "/api/v1/oauth/start" });
    expect(writes(api)[0]?.body).toEqual({
      type: "skyline",
      origin: window.location.origin,
      label: "personal",
      labels: ["Business"],
    });
    await waitFor(() => {
      expect(assign.mock.calls).toEqual([[AUTHORIZATION_URL]]);
    });
    vi.unstubAllGlobals();
  });

  it("says so on the way back from one that worked", async () => {
    await open([PAPER], {}, "/connections?oauth=ok");

    expect(reading(await screen.findByRole("status"))).toMatch(/connected/i);
  });

  it("says what went wrong on the way back from one that did not", async () => {
    await open([PAPER], {}, "/connections?oauth=denied");

    expect(reading(await screen.findByRole("alert"))).toContain("denied");
  });
});

describe("Connections > reconnecting and removing", () => {
  const STALE: Connection = { ...PAPER, status: "needs-reauth", statusDetail: "token revoked" };

  it("pastes a fresh credential into the connection that already exists", async () => {
    const user = userEvent.setup();
    const { api } = await open([STALE], {
      [`POST /api/v1/connections/${STALE.id}/credentials`]: { body: PAPER },
    });

    await user.click(within(await rowFor(STALE)).getByRole("button", { name: "Reconnect" }));
    await user.type(await screen.findByLabelText("Access token"), "pt-secret-fresh");
    await user.click(within(formWith("Access token")).getByRole("button", { name: "Connect" }));

    await waitFor(() => {
      expect(writes(api)).toHaveLength(1);
    });
    expect(writes(api)[0]).toMatchObject({
      method: "POST",
      path: `/api/v1/connections/${STALE.id}/credentials`,
    });
    expect(writes(api)[0]?.body).toEqual({
      credentials: { token: "pt-secret-fresh" },
    });
  });

  it("starts a redirect flow against the connection that already exists", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("location", {
      ...window.location,
      origin: window.location.origin,
      assign: vi.fn(),
    });
    const { api } = await open([SKY], {
      "POST /api/v1/oauth/start": { body: { authorizationUrl: "https://skyline.test/again" } },
    });

    await user.click(within(await rowFor(SKY)).getByRole("button", { name: "Reconnect" }));
    await user.click(within(formWith("Label")).getByRole("button", { name: "Connect" }));

    await waitFor(() => {
      expect(writes(api)).toHaveLength(1);
    });
    expect(writes(api)[0]).toMatchObject({ method: "POST", path: "/api/v1/oauth/start" });
    expect(writes(api)[0]?.body).toMatchObject({
      type: "skyline",
      connectionId: SKY.id,
    });
    vi.unstubAllGlobals();
  });

  it("asks before it removes a connection, then removes it", async () => {
    const user = userEvent.setup();
    const { api, hold } = await open([PAPER, SKY], {
      [`DELETE /api/v1/connections/${SKY.id}`]: { body: {} },
    });

    const row = await rowFor(SKY);
    await user.click(within(row).getByRole("button", { name: "Delete" }));

    expect(writes(api)).toEqual([]);

    hold([PAPER]);
    await user.click(within(row).getByRole("button", { name: "Confirm" }));

    await waitFor(() => {
      expect(writes(api).map((call) => `${call.method} ${call.path}`)).toEqual([
        `DELETE /api/v1/connections/${SKY.id}`,
      ]);
    });
    await waitFor(() => {
      expect(screen.queryByText(SKY.displayName)).toBeNull();
    });
    expect(screen.getByText(PAPER.displayName)).toBeDefined();
  });
});

describe("Connections > configuring one", () => {
  it("shows the type's own settings beside the label and the topic", async () => {
    const user = userEvent.setup();
    const { api } = await open([PAPER], {
      [`PATCH /api/v1/connections/${PAPER.id}`]: { body: PAPER },
    });

    await user.click(within(await rowFor(PAPER)).getByRole("button", { name: "Configure" }));

    expect(screen.getByLabelText<HTMLInputElement>(/folder/i).value).toBe("inbox");
    expect(screen.getByLabelText<HTMLInputElement>("Label").value).toBe("work");
    expect(screen.getByLabelText<HTMLInputElement>("Default topic").value).toBe("Code");

    await user.clear(screen.getByLabelText(/folder/i));
    await user.type(screen.getByLabelText(/folder/i), "archive");
    await user.click(within(formWith("Label")).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(writes(api)).toHaveLength(1);
    });
    expect(writes(api)[0]).toMatchObject({
      method: "PATCH",
      path: `/api/v1/connections/${PAPER.id}`,
    });
    expect(api.calls.find((call) => call.method === "PATCH")?.body).toEqual({
      label: "work",
      labels: ["Code"],
      config: { folder: "archive" },
    });
  });

  it("puts a refused setting's message under the setting it is about", async () => {
    const user = userEvent.setup();
    const complaint = "no such folder";
    await open([PAPER], {
      [`PATCH /api/v1/connections/${PAPER.id}`]: refusal("the settings were refused", [
        { path: ["config", "folder"], message: complaint },
      ]),
    });

    await user.click(within(await rowFor(PAPER)).getByRole("button", { name: "Configure" }));
    await user.click(within(formWith("Label")).getByRole("button", { name: "Save" }));

    await screen.findByText(new RegExp(complaint));
    messageIsAt(complaint, screen.getByLabelText(/folder/i), screen.getByLabelText("Label"));
  });

  it("shows only the label and the topic for a type with no settings of its own", async () => {
    const user = userEvent.setup();
    await open([SKY]);

    await user.click(within(await rowFor(SKY)).getByRole("button", { name: "Configure" }));

    expect(screen.getByLabelText<HTMLInputElement>("Label").value).toBe("personal");
    expect(screen.getByLabelText<HTMLInputElement>("Default topic").value).toBe("Business");
    expect(screen.queryByLabelText(/folder/i)).toBeNull();
  });
});
