/**
 * Settings > Plugins: what the screen says about each plugin the binary was
 * built with, and what a click on it sends to the controller.
 *
 * A plugin is the one thing on this screen the user cannot install, move or
 * delete; all they can do is turn it on, configure it, and pick up the pieces
 * when it failed. So the assertions here are about those four readings - what
 * it contributes, whether it is running, why it is not, and what its settings
 * are - and about the write each affordance actually sends.
 *
 * The form is generated from the plugin's own schema and validated by the
 * controller alone, which is why the refused write below is a stubbed answer
 * rather than something the screen could have known.
 */
import { describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp, stubApi, type Handler } from "../../../app/testing";

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

const writeRoutes = (plugin: Fixture): Readonly<Record<string, Handler>> => ({
  [`POST /api/v1/plugins/${plugin.id}/enable`]: { body: { ...plugin, enabled: true } },
  [`POST /api/v1/plugins/${plugin.id}/disable`]: {
    body: { ...plugin, enabled: false, status: { _tag: "inactive" } },
  },
  [`POST /api/v1/plugins/${plugin.id}/retry`]: { body: { ...plugin, status: { _tag: "active" } } },
  [`POST /api/v1/plugins/${plugin.id}/reset-state`]: { body: plugin },
  [`PUT /api/v1/plugins/${plugin.id}/config`]: { body: plugin },
});

/** A controller holding the plugins given, with every write answered. */
const controller = (
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
    (all, plugin) => ({ ...all, ...writeRoutes(plugin) }),
    {},
  ),
  ...extra,
});

const open = async (plugins: readonly Fixture[], extra: Readonly<Record<string, Handler>> = {}) => {
  const api = stubApi(controller(plugins, extra));
  const app = await renderApp({ path: "/settings/plugins", api: api.fetch, token: "held" });
  return { ...app, api };
};

/** The writes that went out to one plugin, in order. */
const writesTo = (
  api: { readonly calls: readonly { method: string; path: string; body: unknown }[] },
  id: string,
) =>
  api.calls.filter(
    (call) => call.method !== "GET" && call.path.startsWith(`/api/v1/plugins/${id}`),
  );

/** The page's text with its whitespace collapsed, the way a reader sees it. */
const reading = (element: HTMLElement | null = document.body): string =>
  (element?.textContent ?? "").replace(/\s+/g, " ").trim();

/**
 * The part of the page that is about one plugin and no other.
 *
 * A card has no shape this test is entitled to know, so it is found rather
 * than assumed: start at the element carrying the display name and climb while
 * the parent still says nothing about any other plugin.
 */
const cardFor = async (name: string, others: readonly string[]): Promise<HTMLElement> => {
  const found = await screen.findAllByText(new RegExp(name));
  let card = found.reduce((left, right) =>
    (left.textContent ?? "").length <= (right.textContent ?? "").length ? left : right,
  );
  while (
    card.parentElement !== null &&
    !others.some((other) => (card.parentElement?.textContent ?? "").includes(other))
  ) {
    card = card.parentElement;
  }
  return card;
};

/**
 * The control that turns a plugin on and off: whatever names the state it
 * moves to. A settings checkbox on the card is a setting, not the switch.
 */
const toggleIn = (card: HTMLElement): HTMLElement => {
  const control = within(card)
    .queryAllByRole("button")
    .find((button) => /^(enable|disable)$/i.test((button.textContent ?? "").trim()));
  if (control === undefined) throw new Error(`no on/off control in: ${reading(card)}`);
  return control;
};

const isDisabled = (control: HTMLElement): boolean =>
  control.hasAttribute("disabled") || control.getAttribute("aria-disabled") === "true";

const OTHERS = [ACTIVE, ERRORED, REFUSED].map((plugin) => plugin.displayName);
const besides = (plugin: Fixture) => OTHERS.filter((name) => name !== plugin.displayName);

describe("Settings > Plugins", () => {
  it("says what each plugin is, how it is doing, and what it contributes", async () => {
    await open([ACTIVE, ERRORED, REFUSED]);

    const active = reading(await cardFor(ACTIVE.displayName, besides(ACTIVE)));
    expect(active).toMatch(/active/i);
    expect(active).toMatch(/provider/i);
    expect(active).toContain("acme");

    const errored = reading(await cardFor(ERRORED.displayName, besides(ERRORED)));
    expect(errored).toMatch(/error/i);
    expect(errored).toMatch(/channel/i);
    expect(errored).toContain("chatter");

    const refused = reading(await cardFor(REFUSED.displayName, besides(REFUSED)));
    expect(refused).toMatch(/refused|not loaded|turned away/i);
  });

  it("shows what an activation failed with, and retries it on the spot", async () => {
    const user = userEvent.setup();
    const { api } = await open([ACTIVE, ERRORED, REFUSED]);

    const card = await cardFor(ERRORED.displayName, besides(ERRORED));
    expect(reading(card)).toContain(ACTIVATION_FAILURE);

    await user.click(within(card).getByRole("button", { name: /retry/i }));

    await waitFor(() => {
      expect(writesTo(api, ERRORED.id).map((call) => call.path)).toEqual([
        `/api/v1/plugins/${ERRORED.id}/retry`,
      ]);
    });

    // Retry is what an errored plugin offers and nothing else does: on a
    // running one it would be a second spelling of enable, and on a refused
    // one there is nothing loaded to run.
    for (const plugin of [ACTIVE, REFUSED]) {
      const other = within(await cardFor(plugin.displayName, besides(plugin)));
      expect(other.queryByRole("button", { name: /retry/i })).toBeNull();
    }
  });

  it("turns a plugin the user had switched off back on", async () => {
    const user = userEvent.setup();
    const off: Fixture = { ...ACTIVE, enabled: false, status: { _tag: "inactive" } };
    const { api } = await open([off]);

    const toggle = toggleIn(await cardFor(off.displayName, []));
    expect(toggle.textContent).toMatch(/enable/i);

    await user.click(toggle);

    await waitFor(() => {
      expect(writesTo(api, off.id).map((call) => call.path)).toEqual([
        `/api/v1/plugins/${off.id}/enable`,
      ]);
    });
  });

  it("says so when a move the card offered was refused", async () => {
    const user = userEvent.setup();
    const complaint = "the plugin is not errored";
    const { api } = await open([ERRORED], {
      [`POST /api/v1/plugins/${ERRORED.id}/retry`]: {
        status: 400,
        body: { error: { code: "validation", message: complaint, details: { issues: [] } } },
      },
    });

    const card = await cardFor(ERRORED.displayName, []);
    await user.click(within(card).getByRole("button", { name: /retry/i }));

    expect((await within(card).findByRole("alert")).textContent).toBe(complaint);
    expect(writesTo(api, ERRORED.id)).toHaveLength(1);
  });

  it("says why a refused plugin was turned away and offers nothing to switch", async () => {
    const user = userEvent.setup();
    const { api } = await open([ACTIVE, ERRORED, REFUSED]);

    const card = await cardFor(REFUSED.displayName, besides(REFUSED));
    // The reason is a mismatch between two numbers; a card that named neither
    // would leave the user with nothing to act on.
    expect(reading(card)).toMatch(/host api/i);
    expect(reading(card)).toContain("2");

    const toggle = toggleIn(card);
    expect(isDisabled(toggle)).toBe(true);
    await user.click(toggle);
    expect(writesTo(api, REFUSED.id)).toEqual([]);
  });

  it("turns a running plugin off", async () => {
    const user = userEvent.setup();
    const { api } = await open([ACTIVE, ERRORED, REFUSED]);

    await user.click(toggleIn(await cardFor(ACTIVE.displayName, besides(ACTIVE))));

    await waitFor(() => {
      expect(writesTo(api, ACTIVE.id).map((call) => call.path)).toEqual([
        `/api/v1/plugins/${ACTIVE.id}/disable`,
      ]);
    });
  });
});

/**
 * The form may sit behind a disclosure on a list of plugins, which is the
 * screen's business; what matters is that the fields are reachable without
 * leaving the screen.
 */
const configForm = async (user: ReturnType<typeof userEvent.setup>): Promise<void> => {
  if (screen.queryByLabelText(/endpoint/i) !== null) return;
  const opener = screen
    .queryAllByRole("button")
    .find((button) => /config|settings|edit|show|open/i.test(button.textContent ?? ""));
  if (opener !== undefined) await user.click(opener);
  await screen.findByLabelText(/endpoint/i);
};

/** Every value the form is holding right now, whatever widget holds it. */
const values = (): string =>
  [...document.querySelectorAll("input, select, textarea")]
    .map((element) => (element as HTMLInputElement).value)
    .join(" | ");

describe("Settings > Plugins > configuration", () => {
  it("shows a field per configurable setting, holding what is stored", async () => {
    const user = userEvent.setup();
    await open([CONFIGURABLE]);
    await configForm(user);

    expect(screen.getByLabelText<HTMLInputElement>(/endpoint/i).value).toBe(
      "https://notes.test/ingest",
    );
    expect(screen.getByLabelText<HTMLInputElement>(/retries/i).value).toBe("3");
    expect(screen.getByLabelText<HTMLInputElement>(/verbose/i).checked).toBe(true);
    expect(screen.getByLabelText<HTMLSelectElement>(/mode/i).value).toBe("fast");
    // A list of strings has no one widget, so only the values have to be there.
    expect(values()).toContain("alpha");
    expect(values()).toContain("beta");
  });

  it("sends each setting as the type its schema names", async () => {
    const user = userEvent.setup();
    const { api } = await open([CONFIGURABLE]);
    await configForm(user);

    const endpoint = screen.getByLabelText(/endpoint/i);
    await user.clear(endpoint);
    await user.type(endpoint, "https://notes.test/other");
    const retries = screen.getByLabelText(/retries/i);
    await user.clear(retries);
    await user.type(retries, "5");
    await user.click(screen.getByLabelText(/verbose/i));
    await user.selectOptions(screen.getByLabelText(/mode/i), "slow");

    await user.click(screen.getByRole("button", { name: /save|apply/i }));

    await waitFor(() => {
      expect(writesTo(api, CONFIGURABLE.id)).toHaveLength(1);
    });
    expect(writesTo(api, CONFIGURABLE.id)[0]?.body).toEqual({
      config: {
        endpoint: "https://notes.test/other",
        retries: 5,
        verbose: false,
        mode: "slow",
        tags: ["alpha", "beta"],
      },
    });
  });

  it("puts a refused setting's message under the setting it is about", async () => {
    const user = userEvent.setup();
    const complaint = "must be an https URL";
    await open([CONFIGURABLE], {
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
    await configForm(user);

    await user.click(screen.getByRole("button", { name: /save|apply/i }));

    const shown = await screen.findByText(new RegExp(complaint));
    // "Under the field named by the path" means beside that field and no
    // other: a message floating over the whole form names nothing.
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
    await open([CONFIGURABLE], {
      [`PUT /api/v1/plugins/${CONFIGURABLE.id}/config`]: async () => {
        await held;
        return { body: CONFIGURABLE };
      },
    });
    await configForm(user);

    const save = screen.getByRole("button", { name: /save|apply/i });
    await user.click(save);
    await waitFor(() => {
      expect(save.hasAttribute("disabled")).toBe(true);
    });

    answer();
    expect((await screen.findByRole("status")).textContent).toContain("Saved");

    // What the last write said is about the values it was given, so it goes
    // the moment they are no longer those values.
    await user.type(screen.getByLabelText(/endpoint/i), "!");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("says a refusal that blamed no field of this form, rather than swallowing it", async () => {
    const user = userEvent.setup();
    const complaint = "the plugin refused its own configuration";
    await open([CONFIGURABLE], {
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
    await configForm(user);

    await user.click(screen.getByRole("button", { name: /save|apply/i }));

    expect((await screen.findByRole("alert")).textContent).toBe(complaint);
  });

  it("shows a config changed elsewhere instead of holding the values it opened on", async () => {
    let held: readonly Fixture[] = [CONFIGURABLE];
    const { live } = await open(held, {
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
    const asked = vi.spyOn(window, "confirm").mockReturnValue(true);
    try {
      const { api } = await open([CONFIGURABLE]);

      await user.click(await screen.findByRole("button", { name: /reset plugin state/i }));

      // The confirmation is the screen's to design: a browser prompt, or a
      // step the user takes in the page. Either way it comes before the write.
      let confirmedInPage = false;
      if (writesTo(api, CONFIGURABLE.id).length === 0 && asked.mock.calls.length === 0) {
        const confirming = screen
          .getAllByRole("button")
          .filter((button) => /reset|confirm|yes|wipe/i.test(button.textContent ?? ""));
        await user.click(confirming[confirming.length - 1]!);
        confirmedInPage = true;
      }
      expect(asked.mock.calls.length > 0 || confirmedInPage).toBe(true);

      await waitFor(() => {
        expect(writesTo(api, CONFIGURABLE.id).map((call) => call.path)).toEqual([
          `/api/v1/plugins/${CONFIGURABLE.id}/reset-state`,
        ]);
      });
    } finally {
      asked.mockRestore();
    }
  });
});

describe("Settings > Plugins > nothing installed", () => {
  it("says what plugins would bring", async () => {
    await open([]);

    expect(reading()).toContain("No plugins are installed.");
    expect(reading()).toContain(
      "Plugins bring channels, event sources, providers and workflow actions. Each one declares what it contributes, and Hydra generates its configuration form from that.",
    );
  });
});

describe("Settings > Plugins > live", () => {
  it("shows a plugin's new status when it changes elsewhere", async () => {
    let held: readonly Fixture[] = [ACTIVE, ERRORED];
    const { api, live } = await open(held, {
      "GET /api/v1/plugins": () => ({ body: held }),
    });

    expect(reading(await cardFor(ERRORED.displayName, [ACTIVE.displayName]))).toMatch(/error/i);
    await waitFor(() => {
      expect(live.topics()).toContain("plugin");
    });
    const before = api.calls.filter((call) => call.path === "/api/v1/plugins").length;

    held = [ACTIVE, { ...ERRORED, status: { _tag: "active" } }];
    act(() => {
      live.push("plugin", { _tag: "invalidate", ids: [ERRORED.id], kind: "updated" });
    });

    await waitFor(async () => {
      expect(reading(await cardFor(ERRORED.displayName, [ACTIVE.displayName]))).toMatch(/active/i);
    });
    // The card came from a fresh listing, not from the push itself.
    expect(api.calls.filter((call) => call.path === "/api/v1/plugins").length).toBeGreaterThan(
      before,
    );
  });
});
