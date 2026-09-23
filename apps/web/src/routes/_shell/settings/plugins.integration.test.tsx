/**
 * Settings > Plugins: what the screen says about each plugin, and what a click
 * sends to the controller. The form is generated from the plugin's own schema
 * and validated by the controller alone, which is why the refused write below
 * is a stubbed answer rather than something the screen could have known.
 */
import { describe, expect, it } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  expectInDocumentOrder,
  readPageText,
  renderApp,
  stubApi,
  type Handler,
} from "../../../app/testing";

interface Contribution {
  readonly extensionPoint: string;
  readonly id: string;
  readonly definition: unknown;
}

interface Fixture {
  readonly id: string;
  readonly displayName: string;
  readonly hostApi: number;
  readonly capabilities: readonly string[];
  readonly enabled: boolean;
  readonly status: unknown;
  readonly configSchema?: Record<string, unknown>;
  readonly config: unknown;
  readonly contributions: readonly Contribution[];
}

const EMPTY_SCHEMA = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
};

/** Running, with one thing in the catalog, and nothing to configure. */
const ACTIVE: Fixture = {
  id: "quiet-sink",
  displayName: "Quiet Sink",
  hostApi: 1,
  capabilities: ["providers"],
  enabled: true,
  status: { _tag: "active" },
  configSchema: EMPTY_SCHEMA,
  config: {},
  contributions: [{ extensionPoint: "provider", id: "acme", definition: {} }],
};

const ACTIVATION_FAILURE = "the socket at /var/run/borked.sock refused the connection";

/** Enabled, but this boot could not start it. */
const ERRORED: Fixture = {
  id: "borked-relay",
  displayName: "Borked Relay",
  hostApi: 1,
  capabilities: ["providers"],
  enabled: true,
  status: { _tag: "errored", message: ACTIVATION_FAILURE },
  configSchema: EMPTY_SCHEMA,
  config: {},
  contributions: [{ extensionPoint: "channel", id: "chatter", definition: {} }],
};

/** Built against a host API this controller does not speak; never loaded. */
const REFUSED: Fixture = {
  id: "ancient-source",
  displayName: "Ancient Source",
  hostApi: 2,
  capabilities: ["providers"],
  enabled: true,
  status: { _tag: "refused", reason: { kind: "hostApi", expected: 1, actual: 2 } },
  config: {},
  contributions: [],
};

/** One of every field kind the generated form renders, with values set. */
const CONFIGURABLE: Fixture = {
  id: "notes-sink",
  displayName: "Notes Sink",
  hostApi: 1,
  capabilities: ["providers", "kv"],
  enabled: true,
  status: { _tag: "active" },
  configSchema: {
    type: "object",
    properties: {
      endpoint: { type: "string", title: "Endpoint" },
      retries: { type: "integer", title: "Retries" },
      verbose: { type: "boolean", title: "Verbose" },
      mode: { type: "string", enum: ["fast", "slow"], title: "Mode" },
      tags: { type: "array", items: { type: "string" }, title: "Tags" },
    },
    required: ["endpoint"],
    additionalProperties: false,
  },
  config: {
    endpoint: "https://notes.test/ingest",
    retries: 3,
    verbose: true,
    mode: "fast",
    tags: ["alpha", "beta"],
  },
  contributions: [{ extensionPoint: "provider", id: "notes", definition: {} }],
};

const buildWriteRoutes = (plugin: Fixture): Readonly<Record<string, Handler>> => ({
  [`POST /api/v1/plugins/${plugin.id}/enable`]: { body: { ...plugin, enabled: true } },
  [`POST /api/v1/plugins/${plugin.id}/disable`]: {
    body: { ...plugin, enabled: false, status: { _tag: "inactive" } },
  },
  [`POST /api/v1/plugins/${plugin.id}/retry`]: { body: { ...plugin, status: { _tag: "active" } } },
  [`POST /api/v1/plugins/${plugin.id}/reset-state`]: { body: plugin },
  [`PUT /api/v1/plugins/${plugin.id}/config`]: { body: plugin },
});

/** A controller holding the plugins given, with every write answered. */
const buildController = (
  plugins: readonly Fixture[],
  extra: Readonly<Record<string, Handler>> = {},
): Readonly<Record<string, Handler>> => ({
  "GET /api/v1/setup": { body: { complete: true } },
  "GET /api/v1/settings": {
    body: {
      controller: {},
      user: { "onboarding.completedSteps": ["timezone"], timezone: "Europe/Amsterdam" },
    },
  },
  "GET /api/v1/plugins": { body: plugins },
  ...plugins.reduce<Record<string, Handler>>(
    (all, plugin) => ({ ...all, ...buildWriteRoutes(plugin) }),
    {},
  ),
  ...extra,
});

const openApp = async (
  plugins: readonly Fixture[],
  extra: Readonly<Record<string, Handler>> = {},
) => {
  const api = stubApi(buildController(plugins, extra));
  const app = await renderApp({ path: "/settings/plugins", api: api.fetch, token: "held" });
  return { ...app, api };
};

/** The writes that went out to one plugin, in order. */
const listWritesTo = (
  api: { readonly calls: readonly { method: string; path: string; body: unknown }[] },
  id: string,
) =>
  api.calls.filter(
    (call) => call.method !== "GET" && call.path.startsWith(`/api/v1/plugins/${id}`),
  );

/** The card about one plugin: the section its display name heads. */
const findPluginCard = async (plugin: Fixture): Promise<HTMLElement> => {
  const heading = await screen.findByText(plugin.displayName);
  const card = heading.closest("section");
  if (card === null) throw new Error(`no card around ${plugin.displayName}`);
  return card;
};

describe("Settings > Plugins", () => {
  it("says what each plugin is, how it is doing, and what it contributes", async () => {
    await openApp([ACTIVE, ERRORED, REFUSED]);

    const active = readPageText(await findPluginCard(ACTIVE));
    expect(active).toMatch(/active/i);
    expect(active).toMatch(/provider/i);
    expect(active).toContain("acme");

    const errored = readPageText(await findPluginCard(ERRORED));
    expect(errored).toMatch(/error/i);
    expect(errored).toMatch(/channel/i);
    expect(errored).toContain("chatter");

    const refused = readPageText(await findPluginCard(REFUSED));
    expect(refused).toMatch(/refused|not loaded|turned away/i);
  });

  it("shows what an activation failed with, and retries it on the spot", async () => {
    const user = userEvent.setup();
    const { api } = await openApp([ACTIVE, ERRORED, REFUSED]);

    const card = await findPluginCard(ERRORED);
    expect(readPageText(card)).toContain(ACTIVATION_FAILURE);

    await user.click(within(card).getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(listWritesTo(api, ERRORED.id).map((call) => call.path)).toEqual([
        `/api/v1/plugins/${ERRORED.id}/retry`,
      ]);
    });

    for (const plugin of [ACTIVE, REFUSED]) {
      const other = within(await findPluginCard(plugin));
      expect(other.queryByRole("button", { name: "Retry" })).toBeNull();
    }
  });

  it("turns a plugin the user had switched off back on", async () => {
    const user = userEvent.setup();
    const off: Fixture = { ...ACTIVE, enabled: false, status: { _tag: "inactive" } };
    const { api } = await openApp([off]);

    const card = await findPluginCard(off);

    await user.click(within(card).getByRole("button", { name: "Enable" }));

    await waitFor(() => {
      expect(listWritesTo(api, off.id).map((call) => call.path)).toEqual([
        `/api/v1/plugins/${off.id}/enable`,
      ]);
    });
  });

  it("says so when a move the card offered was refused", async () => {
    const user = userEvent.setup();
    const complaint = "the plugin is not errored";
    const { api } = await openApp([ERRORED], {
      [`POST /api/v1/plugins/${ERRORED.id}/retry`]: {
        status: 400,
        body: { error: { code: "validation", message: complaint, details: { issues: [] } } },
      },
    });

    const card = await findPluginCard(ERRORED);
    await user.click(within(card).getByRole("button", { name: "Retry" }));

    expect((await within(card).findByRole("alert")).textContent).toBe(complaint);
    expect(listWritesTo(api, ERRORED.id)).toHaveLength(1);
  });

  it("says why a refused plugin was turned away and offers nothing to switch", async () => {
    const user = userEvent.setup();
    const { api } = await openApp([ACTIVE, ERRORED, REFUSED]);

    const card = await findPluginCard(REFUSED);
    expect(readPageText(card)).toMatch(/host api/i);
    expect(readPageText(card)).toContain("2");

    // A refused plugin is enabled as far as the stored flag goes, so the
    // control it offers is the one that would turn it off - and it is dead.
    const toggle = within(card).getByRole("button", { name: "Disable" });
    expect(toggle.hasAttribute("disabled")).toBe(true);
    await user.click(toggle);
    expect(listWritesTo(api, REFUSED.id)).toEqual([]);
  });

  it("turns a running plugin off", async () => {
    const user = userEvent.setup();
    const { api } = await openApp([ACTIVE, ERRORED, REFUSED]);

    const card = await findPluginCard(ACTIVE);

    await user.click(within(card).getByRole("button", { name: "Disable" }));

    await waitFor(() => {
      expect(listWritesTo(api, ACTIVE.id).map((call) => call.path)).toEqual([
        `/api/v1/plugins/${ACTIVE.id}/disable`,
      ]);
    });
  });
});

/** Every value the form is holding right now, whatever widget holds it. */
const readFormValues = (): string =>
  [...document.querySelectorAll("input, select, textarea")]
    .map((element) => (element as HTMLInputElement).value)
    .join(" | ");

describe("Settings > Plugins > configuration", () => {
  it("shows a field per configurable setting, holding what is stored", async () => {
    await openApp([CONFIGURABLE]);

    expect(screen.getByLabelText<HTMLInputElement>(/endpoint/i).value).toBe(
      "https://notes.test/ingest",
    );
    expect(screen.getByLabelText<HTMLInputElement>(/retries/i).value).toBe("3");
    expect(screen.getByLabelText<HTMLInputElement>(/verbose/i).checked).toBe(true);
    expect(screen.getByLabelText<HTMLSelectElement>(/mode/i).value).toBe("fast");
    // A list of strings has no one widget, so only the values have to be there.
    expect(readFormValues()).toContain("alpha");
    expect(readFormValues()).toContain("beta");
  });

  it("leaves a setting nobody answered out of the write, rather than storing a default", async () => {
    const user = userEvent.setup();
    const unset: Fixture = {
      ...CONFIGURABLE,
      id: "fresh-sink",
      displayName: "Fresh Sink",
      config: {},
    };
    const { api } = await openApp([unset]);

    await user.type(screen.getByLabelText(/endpoint/i), "https://notes.test/ingest");
    await user.type(screen.getByLabelText(/retries/i), "5");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(listWritesTo(api, unset.id)).toHaveLength(1);
    });
    expect(listWritesTo(api, unset.id)[0]?.body).toEqual({
      config: { endpoint: "https://notes.test/ingest", retries: 5 },
    });
  });

  it("puts a refused setting's message under the setting it is about", async () => {
    const user = userEvent.setup();
    const complaint = "must be an https URL";
    await openApp([CONFIGURABLE], {
      [`PUT /api/v1/plugins/${CONFIGURABLE.id}/config`]: {
        status: 400,
        body: {
          error: {
            code: "validation",
            message: "the config does not match the plugin's schema",
            details: { issues: [{ path: ["endpoint"], message: complaint }] },
          },
        },
      },
    });

    await user.click(screen.getByRole("button", { name: "Save" }));

    const shown = await screen.findByText(new RegExp(complaint));
    let group: HTMLElement = shown;
    const endpoint = screen.getByLabelText(/endpoint/i);
    while (group.parentElement !== null && !group.contains(endpoint)) {
      group = group.parentElement;
    }
    expect(group.contains(endpoint)).toBe(true);
    expect(group.contains(screen.getByLabelText(/retries/i))).toBe(false);
  });

  it("says the write landed, and cannot be sent twice while it is in flight", async () => {
    const user = userEvent.setup();
    let answer = () => {};
    const held = new Promise<void>((resolve) => {
      answer = resolve;
    });
    await openApp([CONFIGURABLE], {
      [`PUT /api/v1/plugins/${CONFIGURABLE.id}/config`]: async () => {
        await held;
        return { body: CONFIGURABLE };
      },
    });

    const save = screen.getByRole("button", { name: "Save" });
    await user.click(save);
    await waitFor(() => {
      expect(save.hasAttribute("disabled")).toBe(true);
    });

    answer();
    expect((await screen.findByRole("status")).textContent).toContain("Saved");

    await user.type(screen.getByLabelText(/endpoint/i), "!");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("says a refusal that blamed no field of this form, rather than swallowing it", async () => {
    const user = userEvent.setup();
    const complaint = "the plugin refused its own configuration";
    await openApp([CONFIGURABLE], {
      [`PUT /api/v1/plugins/${CONFIGURABLE.id}/config`]: {
        status: 400,
        body: {
          error: {
            code: "validation",
            message: complaint,
            details: { issues: [{ path: ["nowhere"], message: "no such setting" }] },
          },
        },
      },
    });

    await user.click(screen.getByRole("button", { name: "Save" }));

    expect((await screen.findByRole("alert")).textContent).toBe(complaint);
  });

  it("shows a config changed elsewhere instead of holding the values it opened on", async () => {
    let held: readonly Fixture[] = [CONFIGURABLE];
    const { live } = await openApp(held, {
      "GET /api/v1/plugins": () => ({ body: held }),
    });
    await waitFor(() => {
      expect(live.topics()).toContain("plugin");
    });
    expect(screen.getByLabelText<HTMLInputElement>(/endpoint/i).value).toBe(
      "https://notes.test/ingest",
    );

    held = [
      {
        ...CONFIGURABLE,
        config: { ...(CONFIGURABLE.config as object), endpoint: "https://elsewhere.test" },
      },
    ];
    act(() => {
      live.push("plugin", { _tag: "invalidate", ids: [CONFIGURABLE.id], kind: "updated" });
    });

    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>(/endpoint/i).value).toBe(
        "https://elsewhere.test",
      );
    });
  });
});

describe("Settings > Plugins > reset", () => {
  it("asks before it wipes a plugin's state, then wipes it", async () => {
    const user = userEvent.setup();
    const { api } = await openApp([CONFIGURABLE]);

    await user.click(await screen.findByRole("button", { name: "Reset plugin state" }));

    expect(listWritesTo(api, CONFIGURABLE.id)).toEqual([]);
    // Cancel comes before Confirm.
    const confirm = screen.getByRole("button", { name: "Confirm" });
    expectInDocumentOrder([screen.getByRole("button", { name: "Cancel" }), confirm]);

    await user.click(confirm);

    await waitFor(() => {
      expect(listWritesTo(api, CONFIGURABLE.id).map((call) => call.path)).toEqual([
        `/api/v1/plugins/${CONFIGURABLE.id}/reset-state`,
      ]);
    });
  });
});

describe("Settings > Plugins > nothing installed", () => {
  it("says what plugins would bring", async () => {
    await openApp([]);

    expect(readPageText()).toContain("No plugins are installed.");
    expect(readPageText()).toContain(
      "Plugins bring channels, event sources, providers and workflow actions. Each one declares what it contributes, and Hercule generates its configuration form from that.",
    );
  });
});

describe("Settings > Plugins > live", () => {
  it("shows a plugin's new status when it changes elsewhere", async () => {
    let held: readonly Fixture[] = [ACTIVE, ERRORED];
    const { api, live } = await openApp(held, {
      "GET /api/v1/plugins": () => ({ body: held }),
    });

    expect(readPageText(await findPluginCard(ERRORED))).toMatch(/error/i);
    await waitFor(() => {
      expect(live.topics()).toContain("plugin");
    });
    const before = api.calls.filter((call) => call.path === "/api/v1/plugins").length;

    held = [ACTIVE, { ...ERRORED, status: { _tag: "active" } }];
    act(() => {
      live.push("plugin", { _tag: "invalidate", ids: [ERRORED.id], kind: "updated" });
    });

    await waitFor(async () => {
      expect(readPageText(await findPluginCard(ERRORED))).toMatch(/active/i);
    });
    // The card came from a fresh listing, not from the push itself.
    expect(api.calls.filter((call) => call.path === "/api/v1/plugins").length).toBeGreaterThan(
      before,
    );
  });
});
