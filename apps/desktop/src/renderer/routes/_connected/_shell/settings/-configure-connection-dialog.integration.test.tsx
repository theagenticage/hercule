/**
 * Tests Configure of Settings > Connections, opened from a row's ⋯ menu:
 * what Save sends and that it closes the dialog, where the controller's
 * errors land, the refusals made before anything is sent, a type whose
 * plugin is gone, and the settings whose choices load from the account.
 */
import { afterEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Connection, PluginDetail } from "@hercule/contract";
import { forgetLastSettingsSection } from "../../../../app/last-settings-section";
import {
  buildErrorBody,
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  FIXTURE_GITHUB_CONNECTION,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  type Call,
  type Handler,
} from "../../../../app/testing";

afterEach(forgetLastSettingsSection);

/**
 * The Linear plugin: its Connection type declares a Team whose choices load
 * from the account and a Limit, and its event source polls one feed.
 */
const LINEAR: PluginDetail = {
  id: "linear",
  displayName: "Linear",
  hostApi: 2,
  capabilities: [],
  enabled: true,
  status: { _tag: "active" },
  config: {},
  intake: { eventKinds: [], signalKinds: [] },
  contributions: [
    {
      extensionPoint: "connection-type",
      id: "linear/linear",
      definition: {
        type: "linear/linear",
        displayName: "Linear",
        setup: [{ kind: "credentials", fields: [{ name: "key", label: "API key" }] }],
        configSchema: {
          type: "object",
          title: "Watching",
          properties: {
            team: { type: "string", title: "Team", "x-choices": true },
            limit: { type: "integer", title: "Limit" },
          },
          required: ["team"],
        },
      },
    },
    {
      extensionPoint: "event-source",
      id: "linear/issues",
      definition: {
        connectionType: "linear/linear",
        kinds: {},
        feeds: { issues: { defaultIntervalSeconds: 300, minIntervalSeconds: 60 } },
      },
    },
  ],
};

const WORK: Connection = {
  ...FIXTURE_GITHUB_CONNECTION,
  type: "linear/linear",
  label: "work",
  displayName: "work",
  labels: ["Code", "triage"],
  config: { team: "t-1", limit: 20 },
  feedIntervals: { issues: 600 },
};

const CHOICES_PATH = `GET /api/v1/connections/${WORK.id}/choices/team`;
const UPDATE_PATH = `PATCH /api/v1/connections/${WORK.id}`;
const TEAMS = {
  body: {
    choices: [
      { value: "t-1", label: "Platform" },
      { value: "t-2", label: "Web" },
    ],
  },
};

/**
 * Opens Settings > Connections holding `connection`, then its Configure
 * dialog through the row's ⋯ menu. Returns the dialog and the calls sent.
 */
const openConfigure = async ({
  connection = WORK,
  handlers = {},
}: {
  readonly connection?: Connection;
  readonly handlers?: Readonly<Record<string, Handler>>;
} = {}): Promise<{ readonly dialog: HTMLElement; readonly calls: readonly Call[] }> => {
  const calls = stubApi({
    ...buildSidebarHandlers({ ...SIDEBAR_FIXTURE, plugins: [LINEAR] }),
    "GET /api/v1/connections": { body: { items: [connection] } },
    [CHOICES_PATH]: TEAMS,
    ...handlers,
  });
  await renderApp(createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }), {
    path: "/settings/connections",
  });
  await screen.findByRole("heading", { level: 1, name: "Connections" });
  const typeName = connection.type === "linear/linear" ? "Linear" : connection.type;
  const name = `${typeName} · ${connection.label}`;
  const more = screen.getByRole("button", { name: `More for ${name}` });
  await userEvent.click(more);
  // jsdom has no popover API, so the menu is found through the button's
  // `popovertarget` rather than by its role.
  const menu = document.getElementById(more.getAttribute("popovertarget")!)!;
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Configure…", hidden: true }), {
    pointerEventsCheck: 0,
  });
  const dialog = screen.getByRole("dialog", { name: `Configure ${name}` });
  return { dialog, calls };
};

/** Answers `connection.update` with `connection` holding what the call sent. */
const answerUpdate =
  (connection: Connection): Handler =>
  (call) => ({
    body: {
      ...connection,
      ...(call.body as object),
      intake: { eventKinds: [], signalKinds: [] },
    },
  });

/** Returns the calls that saved the Connection. */
const listUpdates = (calls: readonly Call[]): readonly Call[] =>
  calls.filter((call) => `${call.method} ${call.path}` === UPDATE_PATH);

/** Returns the error shown under the field labelled `label`, or `null` when it has none. */
const readFieldError = (dialog: HTMLElement, label: string): string | null =>
  within(dialog).getByText(label, { selector: "label" }).closest(".fl")?.querySelector(".fl-err")
    ?.textContent ?? null;

describe("Configure a Connection", () => {
  it("sends every field on Save, keeps the topics after the first, closes and reads the list again", async () => {
    const { dialog, calls } = await openConfigure({
      handlers: {
        [UPDATE_PATH]: answerUpdate(WORK),
      },
    });
    const team = await within(dialog).findByRole<HTMLSelectElement>("combobox", { name: "Team" });
    expect(team.selectedOptions[0]?.textContent).toBe("Platform");

    const name = within(dialog).getByRole("textbox", { name: "Name" });
    await userEvent.clear(name);
    await userEvent.type(name, "  work bot ");
    const topic = within(dialog).getByRole("combobox", { name: "Topic" });
    await userEvent.clear(topic);
    await userEvent.type(topic, "Ops");
    await userEvent.selectOptions(team, "Web");
    const limit = within(dialog).getByRole("textbox", { name: "Limit" });
    await userEvent.clear(limit);
    await userEvent.type(limit, "50");
    const issues = within(dialog).getByRole("textbox", { name: "Issues" });
    await userEvent.clear(issues);
    const listsBefore = calls.filter((call) => call.path === "/api/v1/connections").length;
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(listUpdates(calls).map((call) => call.body)).toEqual([
      {
        label: "work bot",
        labels: ["Ops", "triage"],
        config: { team: "t-2", limit: 50 },
        // The emptied field polls at its default, so it is left out.
        feedIntervals: {},
      },
    ]);
    await waitFor(() => {
      expect(calls.filter((call) => call.path === "/api/v1/connections").length).toBe(
        listsBefore + 1,
      );
    });
  });

  it("shows the controller's error about a setting under that setting, and keeps the dialog open", async () => {
    const { dialog } = await openConfigure({
      handlers: {
        [UPDATE_PATH]: {
          status: 400,
          body: {
            error: {
              code: "validation",
              message: "The config is not valid.",
              details: { issues: [{ path: ["config", "limit"], message: "At most 100." }] },
            },
          },
        },
      },
    });
    await within(dialog).findByRole("combobox", { name: "Team" });

    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(readFieldError(dialog, "Limit")).toBe("At most 100.");
    });
    expect(readFieldError(dialog, "Name")).toBeNull();
    expect(dialog.querySelector(".configure-connection-foot .fl-err")).toBeNull();
    expect(screen.getByRole("dialog")).toBe(dialog);
  });

  it("shows an error that belongs to no field at the foot of the dialog", async () => {
    const { dialog } = await openConfigure({
      handlers: {
        [UPDATE_PATH]: { status: 409, body: buildErrorBody("invalid_state", "Taken.") },
      },
    });
    await within(dialog).findByRole("combobox", { name: "Team" });

    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(dialog.querySelector(".configure-connection-foot .fl-err")?.textContent).toBe(
        "Could not save: Taken.",
      );
    });
  });

  it("sends nothing while a number, an interval or the name cannot be saved, and says why under each", async () => {
    const { dialog, calls } = await openConfigure();
    await within(dialog).findByRole("combobox", { name: "Team" });

    await userEvent.clear(within(dialog).getByRole("textbox", { name: "Name" }));
    const limit = within(dialog).getByRole("textbox", { name: "Limit" });
    await userEvent.clear(limit);
    await userEvent.type(limit, "lots");
    const issues = within(dialog).getByRole("textbox", { name: "Issues" });
    await userEvent.clear(issues);
    await userEvent.type(issues, "1.5");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(readFieldError(dialog, "Name")).toBe("Name the Connection.");
    expect(readFieldError(dialog, "Limit")).toBe("Enter an integer.");
    expect(readFieldError(dialog, "Issues")).toBe("Enter a whole number of seconds.");
    expect(listUpdates(calls)).toEqual([]);
    expect(screen.getByRole("dialog")).toBe(dialog);
  });

  it("keeps the settings and intervals of a type whose plugin is gone, and says why", async () => {
    const orphan: Connection = { ...WORK, type: "acme/widgets" };
    const { dialog, calls } = await openConfigure({
      connection: orphan,
      handlers: {
        [UPDATE_PATH]: answerUpdate(orphan),
      },
    });

    expect(
      within(dialog).getByText(/The plugin that declared acme\/widgets is not installed/),
    ).toBeTruthy();
    expect(within(dialog).queryByRole("heading", { name: "Polling" })).toBeNull();
    expect(within(dialog).queryByRole("textbox", { name: "Limit" })).toBeNull();
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    await userEvent.type(name, "s");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    // Neither `config` nor `feedIntervals` is sent, so the stored ones stay.
    expect(listUpdates(calls).map((call) => call.body)).toEqual([{ label: "works" }]);
  });

  it("falls back to a plain field when the account's choices cannot be read, and still saves", async () => {
    const { dialog, calls } = await openConfigure({
      handlers: {
        [CHOICES_PATH]: { status: 409, body: buildErrorBody("invalid_state", "Linear is down.") },
        [UPDATE_PATH]: answerUpdate(WORK),
      },
    });

    const failure = await within(dialog).findByText(/^Could not load the choices:/);
    expect(failure.textContent).toBe("Could not load the choices: Linear is down.");
    const team = within(dialog).getByRole("textbox", { name: "Team" });
    await userEvent.clear(team);
    await userEvent.type(team, "t-9");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(listUpdates(calls)).toHaveLength(1);
    });
    expect(listUpdates(calls)[0]?.body).toMatchObject({ config: { team: "t-9", limit: 20 } });
  });
});
