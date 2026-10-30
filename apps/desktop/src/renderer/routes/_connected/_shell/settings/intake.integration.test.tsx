/**
 * Tests Settings > Intake: a section for each plugin that has intake kinds
 * or Ignore Rules, the control that picks all its Connections or one, the
 * toggles that save as they are pressed, Reset, the line that says where a
 * value comes from, the links from a signal that open a kind or a
 * Connection, and the Ignore Rules list.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  GITHUB_CONNECTION_TYPE,
  type Connection,
  type ConnectionDetail,
  type IgnoreRuleWithCatches,
  type IntakeOverrides,
  type IntakeSettings,
  type IntakeSettingLevel,
  type PluginDetail,
} from "@hercule/contract";
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

const scrollIntoView = vi.fn();

beforeEach(() => {
  // jsdom lays nothing out, so it has no `scrollIntoView`.
  Element.prototype.scrollIntoView = scrollIntoView;
});

afterEach(() => {
  forgetLastSettingsSection();
  scrollIntoView.mockReset();
});

const REVIEW = "github/review-requested";
const MENTIONED = "github/mentioned";
const CHECKS = "github/checks-failed";
const NOTIFICATION = "github.notification";
const PUSH = "github.push";

/** What GitHub declares for each kind, and the value it has by default. */
const DECLARED_SIGNALS = [
  { kind: REVIEW, label: "Review requested", description: "Someone asks you to review", on: true },
  { kind: MENTIONED, label: "Mentioned", description: "Someone mentions you", on: true },
  { kind: CHECKS, label: "Checks failed", description: "Checks fail on your branch", on: false },
];
const DECLARED_EVENTS = [
  { kind: NOTIFICATION, description: "A notification from GitHub", on: true },
  { kind: PUSH, description: "A push to a branch", on: false },
];

const CONNECTION_A: Connection = {
  ...FIXTURE_GITHUB_CONNECTION,
  id: "01a06d02-7700-7000-8000-0000000000a1",
  label: "rogier",
};
const CONNECTION_B: Connection = {
  ...FIXTURE_GITHUB_CONNECTION,
  id: "01a06d02-7700-7000-8000-0000000000b2",
  label: "acme-bot",
};

/** The choices a level stores, which a toggle or Reset replaces whole. */
const NO_CHOICES: IntakeOverrides = { eventKinds: {}, signalKinds: {} };

/** A plugin that raises one signal kind, and has no Connection. */
const LINEAR: PluginDetail = {
  id: "linear",
  displayName: "Linear",
  hostApi: 2,
  capabilities: [],
  enabled: true,
  status: { _tag: "active" },
  config: {},
  contributions: [],
  intake: {
    eventKinds: [],
    signalKinds: [
      {
        kind: "linear/assigned",
        label: "Assigned",
        description: "An issue is assigned to you",
        matchFields: [],
        on: true,
        level: "default",
      },
    ],
  },
};

/** A plugin with no signal kind and no event kind, which gets a section only when it has Ignore Rules. */
const QUIET: PluginDetail = {
  ...LINEAR,
  id: "quiet",
  displayName: "Quiet",
  intake: { eventKinds: [], signalKinds: [] },
};

/**
 * The controller's records of GitHub's Intake settings: the choices stored
 * at the plugin's level and at each Connection's, from which it works out
 * the value in effect for every kind, as the real controller does.
 */
interface IntakeRecords {
  plugin: IntakeOverrides;
  connections: Record<string, IntakeOverrides>;
  /** The plugins other than GitHub. */
  others: PluginDetail[];
  /** The Connections the controller holds. */
  connectionList: Connection[];
  /** When set, the next write fails with this message. */
  failNextWrite: string | null;
  /** When set, the next write answers only after this promise settles. */
  holdNextWrite: Promise<void> | null;
}

const readLevel = (
  kind: string,
  list: keyof IntakeOverrides,
  plugin: IntakeOverrides,
  connection: IntakeOverrides,
): { on: boolean | undefined; level: IntakeSettingLevel } => {
  if (kind in connection[list]) return { on: connection[list][kind], level: "connection" };
  if (kind in plugin[list]) return { on: plugin[list][kind], level: "plugin" };
  return { on: undefined, level: "default" };
};

/** Returns the settings in effect for GitHub's kinds, given the choices at the plugin's level and, if any, a Connection's. */
const resolveSettings = (
  plugin: IntakeOverrides,
  connection: IntakeOverrides = NO_CHOICES,
): IntakeSettings => ({
  signalKinds: DECLARED_SIGNALS.map(({ kind, label, description, on }) => {
    const chosen = readLevel(kind, "signalKinds", plugin, connection);
    return { kind, label, description, matchFields: [], on: chosen.on ?? on, level: chosen.level };
  }),
  eventKinds: DECLARED_EVENTS.map(({ kind, description, on }) => {
    const chosen = readLevel(kind, "eventKinds", plugin, connection);
    return { kind, description, on: chosen.on ?? on, level: chosen.level };
  }),
});

const buildGithub = (records: IntakeRecords): PluginDetail => ({
  id: "github",
  displayName: "GitHub",
  hostApi: 2,
  capabilities: [],
  enabled: true,
  status: { _tag: "active" },
  config: {},
  contributions: [
    {
      extensionPoint: "connection-type",
      id: GITHUB_CONNECTION_TYPE,
      definition: { type: GITHUB_CONNECTION_TYPE, displayName: "GitHub" },
    },
  ],
  intake: resolveSettings(records.plugin),
});

/**
 * Returns the handlers of a controller that holds GitHub with two Connections,
 * Linear and a plugin with no intake, and the records behind them. A write
 * stores the choices it sends and answers with the settings in effect.
 */
const buildIntakeHandlers = (
  initial: Partial<Omit<IntakeRecords, "failNextWrite" | "holdNextWrite">> = {},
): { readonly records: IntakeRecords; readonly handlers: Record<string, Handler> } => {
  const records: IntakeRecords = {
    plugin: NO_CHOICES,
    connections: {},
    others: [LINEAR, QUIET],
    connectionList: [CONNECTION_A, CONNECTION_B],
    failNextWrite: null,
    holdNextWrite: null,
    ...initial,
  };
  // Takes the failure and the hold meant for this write when it arrives, so a
  // write that comes later is not affected by them.
  const settleWrite = async (): Promise<{ status: number; body: unknown } | null> => {
    const { failNextWrite: message, holdNextWrite: hold } = records;
    records.failNextWrite = null;
    records.holdNextWrite = null;
    await hold;
    return message === null ? null : { status: 500, body: buildErrorBody("internal", message) };
  };
  const readDetail = (connection: Connection): ConnectionDetail => ({
    ...connection,
    intake: resolveSettings(records.plugin, records.connections[connection.id]),
  });
  const handlers: Record<string, Handler> = {
    "GET /api/v1/plugins": () => ({ body: [buildGithub(records), ...records.others] }),
    "GET /api/v1/connections": () => ({ body: { items: records.connectionList } }),
    "PUT /api/v1/plugins/github/intake": async (call) => {
      const failed = await settleWrite();
      if (failed !== null) return failed;
      records.plugin = (call.body as { intake: IntakeOverrides }).intake;
      return { body: resolveSettings(records.plugin) };
    },
  };
  for (const connection of records.connectionList) {
    handlers[`GET /api/v1/connections/${connection.id}`] = () => ({ body: readDetail(connection) });
    handlers[`PATCH /api/v1/connections/${connection.id}`] = async (call) => {
      const failed = await settleWrite();
      if (failed !== null) return failed;
      records.connections[connection.id] = (call.body as { intake: IntakeOverrides }).intake;
      return { body: readDetail(connection) };
    };
  }
  return { records, handlers };
};

/** Opens Settings at `path` on a controller that serves `handlers`, and returns the calls it receives. */
const openIntake = async (
  path: string,
  handlers: Readonly<Record<string, Handler>>,
): Promise<readonly Call[]> => {
  const calls = stubApi({ ...buildSidebarHandlers(SIDEBAR_FIXTURE), ...handlers });
  await renderApp(createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }), { path });
  await screen.findByRole("heading", { level: 1, name: "Intake" });
  return calls;
};

/** Returns the section of the plugin `name`. */
const getSection = (name: string): HTMLElement =>
  screen.getByRole("heading", { level: 2, name }).closest<HTMLElement>(".set-sec")!;

/** Returns the row of the kind whose switch is named `label`. */
const getRow = (label: string): HTMLElement =>
  screen.getByRole("switch", { name: label }).closest<HTMLElement>(".set-row")!;

const getSwitch = (label: string): HTMLElement => screen.getByRole("switch", { name: label });

/** Returns the line under a row's hint that says where its value comes from, or null. */
const readSource = (label: string): string | null =>
  getRow(label).querySelector(".intake-source")?.textContent ?? null;

/** Returns the calls that wrote Intake settings, plugin level or Connection. */
const listWrites = (calls: readonly Call[]): readonly Call[] =>
  calls.filter(
    (call) =>
      (call.method === "PUT" && call.path === "/api/v1/plugins/github/intake") ||
      (call.method === "PATCH" && call.path.startsWith("/api/v1/connections/")),
  );

const pickSegment = (name: string): Promise<void> =>
  userEvent.click(within(getSection("GitHub")).getByRole("button", { name }));

/** Builds a promise that stays pending until `open` is called, to hold a write while the test acts. */
const buildGate = (): { readonly promise: Promise<void>; readonly open: () => void } => {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

describe("Settings > Intake", () => {
  it("is the row after Threads in the Settings list, and opens the section", async () => {
    await openIntake("/settings/intake", buildIntakeHandlers().handlers);

    const list = screen.getByRole("navigation", { name: "Settings" });
    const rows = [...list.querySelectorAll(".nav-row")].map((row) => row.textContent);
    expect(rows.slice(rows.indexOf("Threads"), rows.indexOf("Threads") + 2)).toEqual([
      "Threads",
      "Intake",
    ]);
    expect(within(list).getByRole("link", { name: "Intake" }).getAttribute("href")).toBe(
      "/settings/intake",
    );
    expect(
      screen.getByText(
        "Workflows and subscriptions receive every event, whatever you choose here.",
      ),
    ).toBeTruthy();
  });

  it("draws a section for each plugin that has kinds, with its signals and its events in two lists", async () => {
    await openIntake("/settings/intake", buildIntakeHandlers().handlers);

    // Quiet declares no kind, so it has no section. The mark is hidden from
    // assistive technology, so a heading is found by the name alone.
    expect(screen.getAllByRole("heading", { level: 2 })).toEqual([
      screen.getByRole("heading", { level: 2, name: "GitHub" }),
      screen.getByRole("heading", { level: 2, name: "Linear" }),
    ]);

    const github = within(getSection("GitHub"));
    expect(github.getAllByRole("heading", { level: 3 }).map((each) => each.textContent)).toEqual([
      "Signals",
      "Events available to triage",
    ]);
    // A signal row says what it is and what it means; an event row says what it is and its kind.
    const review = getRow("Review requested");
    expect(review.querySelector(".set-label span")!.textContent).toBe("Someone asks you to review");
    const notification = getRow("A notification from GitHub");
    const kind = notification.querySelector(".set-label span")!;
    expect(kind.textContent).toBe(NOTIFICATION);
    expect(kind.classList.contains("mono")).toBe(true);
    expect(getSwitch("Review requested").getAttribute("aria-checked")).toBe("true");
    expect(getSwitch("Checks failed").getAttribute("aria-checked")).toBe("false");
    // Linear raises signals only, so it has no events list.
    expect(
      within(getSection("Linear"))
        .getAllByRole("heading", { level: 3 })
        .map((each) => each.textContent),
    ).toEqual(["Signals"]);
  });

  it("picks between all of a plugin's Connections and one of them, and has no control for a plugin with none", async () => {
    await openIntake("/settings/intake", buildIntakeHandlers().handlers);

    const control = within(getSection("GitHub")).getByRole("group", { name: "GitHub connections" });
    expect(
      within(control)
        .getAllByRole("button")
        .map((segment) => [segment.textContent, segment.getAttribute("aria-pressed")]),
    ).toEqual([
      ["All GitHub connections", "true"],
      ["rogier", "false"],
      ["acme-bot", "false"],
    ]);
    expect(within(getSection("Linear")).queryByRole("group")).toBeNull();
  });

  it("reads a Connection only when its segment is picked, and shows that Connection's own values", async () => {
    const { handlers } = buildIntakeHandlers({
      connections: { [CONNECTION_A.id]: { eventKinds: {}, signalKinds: { [CHECKS]: true } } },
    });
    const calls = await openIntake("/settings/intake", handlers);
    const readsOfConnection = (): number =>
      calls.filter((call) => call.method === "GET" && /\/connections\/[^/]+$/.test(call.path))
        .length;
    expect(readsOfConnection()).toBe(0);
    expect(getSwitch("Checks failed").getAttribute("aria-checked")).toBe("false");

    await pickSegment("rogier");

    await waitFor(() => {
      expect(getSwitch("Checks failed").getAttribute("aria-checked")).toBe("true");
    });
    expect(readsOfConnection()).toBe(1);
    expect(calls.some((call) => call.path === `/api/v1/connections/${CONNECTION_A.id}`)).toBe(true);
    expect(readSource("Checks failed")).toBe("On · this connection");

    await pickSegment("All GitHub connections");
    expect(getSwitch("Checks failed").getAttribute("aria-checked")).toBe("false");
  });

  it("names a Connection's whole label in its segment's title, for a label the control cuts short", async () => {
    const label = "x".repeat(128);
    const { handlers } = buildIntakeHandlers({
      connectionList: [{ ...CONNECTION_A, label }, CONNECTION_B],
    });
    await openIntake("/settings/intake", handlers);

    const segment = within(getSection("GitHub")).getByRole("button", { name: label });
    expect(segment.getAttribute("title")).toBe(label);
  });

  it("keeps each plugin's own segment", async () => {
    const second: PluginDetail = {
      ...LINEAR,
      id: "gitlab",
      displayName: "GitLab",
      contributions: [
        {
          extensionPoint: "connection-type",
          id: "gitlab/gitlab",
          definition: { type: "gitlab/gitlab", displayName: "GitLab" },
        },
      ],
    };
    const lab: Connection = {
      ...CONNECTION_A,
      id: "01a06d02-7700-7000-8000-0000000000c3",
      type: "gitlab/gitlab",
      label: "lab-user",
    };
    const { handlers } = buildIntakeHandlers({
      others: [second],
      connectionList: [CONNECTION_A, lab],
    });
    await openIntake("/settings/intake", handlers);

    await pickSegment("rogier");

    const labControl = within(getSection("GitLab")).getByRole("group", {
      name: "GitLab connections",
    });
    expect(
      within(labControl)
        .getByRole("button", { name: "All GitLab connections" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      within(getSection("GitHub"))
        .getByRole("button", { name: "rogier" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });
});

describe("Settings > Intake, saving", () => {
  it("sends the plugin level's choices with the toggle, to the plugin, when all Connections are shown", async () => {
    const { handlers } = buildIntakeHandlers({
      plugin: { eventKinds: {}, signalKinds: { [MENTIONED]: false } },
    });
    const calls = await openIntake("/settings/intake", handlers);

    await userEvent.click(getSwitch("Review requested"));

    // The optimistic value shows at once.
    expect(getSwitch("Review requested").getAttribute("aria-checked")).toBe("false");
    await waitFor(() => {
      expect(listWrites(calls)).toHaveLength(1);
    });
    expect(listWrites(calls)[0]).toMatchObject({
      method: "PUT",
      path: "/api/v1/plugins/github/intake",
      body: {
        intake: { eventKinds: {}, signalKinds: { [MENTIONED]: false, [REVIEW]: false } },
      },
    });
    await waitFor(() => {
      expect(readSource("Review requested")).toBe("Off · all GitHub connections");
    });
    expect(getSwitch("Review requested").getAttribute("aria-checked")).toBe("false");
  });

  it("sends an event kind's choice in the events list", async () => {
    const { handlers } = buildIntakeHandlers();
    const calls = await openIntake("/settings/intake", handlers);

    await userEvent.click(getSwitch("A push to a branch"));

    await waitFor(() => {
      expect(listWrites(calls)).toHaveLength(1);
    });
    expect(listWrites(calls)[0]!.body).toEqual({
      intake: { eventKinds: { [PUSH]: true }, signalKinds: {} },
    });
  });

  it("sends the Connection's own choices, to the Connection, when its segment is shown", async () => {
    const { handlers } = buildIntakeHandlers({
      plugin: { eventKinds: {}, signalKinds: { [MENTIONED]: false } },
      connections: { [CONNECTION_B.id]: { eventKinds: {}, signalKinds: { [CHECKS]: true } } },
    });
    const calls = await openIntake("/settings/intake", handlers);
    await pickSegment("acme-bot");
    await waitFor(() => {
      expect(readSource("Checks failed")).toBe("On · this connection");
    });

    await userEvent.click(getSwitch("Review requested"));

    await waitFor(() => {
      expect(listWrites(calls)).toHaveLength(1);
    });
    // The plugin's choice for Mentioned is not the Connection's to send back.
    expect(listWrites(calls)[0]).toMatchObject({
      method: "PATCH",
      path: `/api/v1/connections/${CONNECTION_B.id}`,
      body: { intake: { eventKinds: {}, signalKinds: { [CHECKS]: true, [REVIEW]: false } } },
    });
  });

  it("puts the toggle back and shows why under that row only, when the save fails", async () => {
    const { handlers, records } = buildIntakeHandlers();
    records.failNextWrite = "The database is locked.";
    await openIntake("/settings/intake", handlers);

    await userEvent.click(getSwitch("Review requested"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Could not save: The database is locked.");
    expect(getSwitch("Review requested").getAttribute("aria-checked")).toBe("true");
    // The error sits right under the row that failed, and no other row has one.
    expect(getRow("Review requested").nextElementSibling).toBe(alert);
    expect(screen.getAllByRole("alert")).toHaveLength(1);

    // The next change of that row clears the error.
    await userEvent.click(getSwitch("Review requested"));
    await waitFor(() => {
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });
});

describe("Settings > Intake, a save that fails", () => {
  it("still shows its error when the section is left while the save runs and opened again", async () => {
    const { handlers, records } = buildIntakeHandlers();
    const gate = buildGate();
    records.holdNextWrite = gate.promise;
    records.failNextWrite = "The database is locked.";
    await openIntake("/settings/intake", handlers);

    await userEvent.click(getSwitch("Review requested"));
    await pickSegment("rogier");
    gate.open();
    await waitFor(() => {
      expect(screen.queryByRole("alert")).toBeNull();
    });
    await pickSegment("All GitHub connections");

    // The failed save is the plugin level's, so it shows there and nowhere else.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Could not save: The database is locked.");
    expect(getRow("Review requested").nextElementSibling).toBe(alert);
    expect(getSwitch("Review requested").getAttribute("aria-checked")).toBe("true");
  });

  it("shows no error for a row whose later save went through", async () => {
    const { handlers, records } = buildIntakeHandlers();
    const calls = await openIntake("/settings/intake", handlers);
    const gate = buildGate();
    records.holdNextWrite = gate.promise;
    records.failNextWrite = "The database is locked.";

    // The second save waits for the first, which fails after it was queued.
    await userEvent.click(getSwitch("Review requested"));
    await userEvent.click(getSwitch("Review requested"));
    gate.open();

    await waitFor(() => {
      expect(listWrites(calls)).toHaveLength(2);
    });
    expect(listWrites(calls)[1]!.body).toEqual({
      intake: { eventKinds: {}, signalKinds: { [REVIEW]: true } },
    });
    await waitFor(() => {
      expect(readSource("Review requested")).toBe("On · all GitHub connections");
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps one row's error while another row is saved", async () => {
    const { handlers, records } = buildIntakeHandlers();
    records.failNextWrite = "The database is locked.";
    await openIntake("/settings/intake", handlers);
    await userEvent.click(getSwitch("Review requested"));
    await screen.findByRole("alert");

    await userEvent.click(getSwitch("Mentioned"));

    await waitFor(() => {
      expect(readSource("Mentioned")).toBe("Off · all GitHub connections");
    });
    expect(getRow("Review requested").nextElementSibling).toBe(screen.getByRole("alert"));
  });
});

describe("Settings > Intake, where a value comes from", () => {
  it("says nothing under a value that is the plugin's default", async () => {
    await openIntake("/settings/intake", buildIntakeHandlers().handlers);

    expect(readSource("Review requested")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Reset/ })).toBeNull();
  });

  it("names the plugin level on a value set for all Connections, and offers Reset there only", async () => {
    const { handlers } = buildIntakeHandlers({
      plugin: { eventKinds: {}, signalKinds: { [MENTIONED]: false, [CHECKS]: true } },
    });
    await openIntake("/settings/intake", handlers);

    expect(readSource("Mentioned")).toBe("Off · all GitHub connections");
    expect(readSource("Checks failed")).toBe("On · all GitHub connections");
    expect(
      screen
        .getAllByRole("button", { name: /^Reset/ })
        .map((each) => each.getAttribute("aria-label")),
    ).toEqual(["Reset Mentioned", "Reset Checks failed"]);
  });

  it("names the Connection level, and offers no Reset on a value that comes from the plugin's level", async () => {
    const { handlers } = buildIntakeHandlers({
      plugin: { eventKinds: {}, signalKinds: { [MENTIONED]: false } },
      connections: { [CONNECTION_A.id]: { eventKinds: {}, signalKinds: { [CHECKS]: true } } },
    });
    await openIntake("/settings/intake", handlers);
    await pickSegment("rogier");
    await waitFor(() => {
      expect(readSource("Checks failed")).toBe("On · this connection");
    });

    // The value of Mentioned comes from the plugin's level, which this segment does not edit.
    expect(readSource("Mentioned")).toBe("Off · all GitHub connections");
    expect(
      screen
        .getAllByRole("button", { name: /^Reset/ })
        .map((each) => each.getAttribute("aria-label")),
    ).toEqual(["Reset Checks failed"]);
  });

  it("describes the switch by the hint and by the line that says where its value comes from", async () => {
    const { handlers } = buildIntakeHandlers({
      plugin: { eventKinds: {}, signalKinds: { [MENTIONED]: false } },
    });
    await openIntake("/settings/intake", handlers);

    const describedBy = (label: string): string[] =>
      getSwitch(label)
        .getAttribute("aria-describedby")!
        .split(" ")
        .map((id) => document.getElementById(id)!.textContent);
    expect(describedBy("Mentioned")).toEqual([
      "Someone mentions you",
      "Off · all GitHub connections",
    ]);
    expect(describedBy("Review requested")).toEqual(["Someone asks you to review"]);
  });

  it("dims Reset and sends nothing more while the reset is saving", async () => {
    const { handlers, records } = buildIntakeHandlers({
      plugin: { eventKinds: {}, signalKinds: { [MENTIONED]: false } },
    });
    const calls = await openIntake("/settings/intake", handlers);
    const gate = buildGate();
    records.holdNextWrite = gate.promise;
    const reset = screen.getByRole("button", { name: "Reset Mentioned" });

    await userEvent.click(reset);
    expect(reset.getAttribute("aria-disabled")).toBe("true");
    expect(reset.hasAttribute("data-unready")).toBe(true);
    await userEvent.click(reset);
    gate.open();

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Reset Mentioned" })).toBeNull();
    });
    expect(listWrites(calls)).toHaveLength(1);
  });

  it("writes the level's choices without the kind when Reset is pressed", async () => {
    const { handlers } = buildIntakeHandlers({
      plugin: { eventKinds: {}, signalKinds: { [MENTIONED]: false, [CHECKS]: true } },
    });
    const calls = await openIntake("/settings/intake", handlers);

    await userEvent.click(screen.getByRole("button", { name: "Reset Mentioned" }));

    await waitFor(() => {
      expect(listWrites(calls)).toHaveLength(1);
    });
    expect(listWrites(calls)[0]!.body).toEqual({
      intake: { eventKinds: {}, signalKinds: { [CHECKS]: true } },
    });
    await waitFor(() => {
      expect(readSource("Mentioned")).toBeNull();
    });
    expect(getSwitch("Mentioned").getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("button", { name: "Reset Mentioned" })).toBeNull();
  });
});

describe("Settings > Intake, opened from a signal", () => {
  it("picks the Connection's segment and highlights the kind's row, once", async () => {
    const { handlers } = buildIntakeHandlers();
    await openIntake(`/settings/intake?kind=${CHECKS}&connection=${CONNECTION_B.id}`, handlers);

    await waitFor(() => {
      expect(
        within(getSection("GitHub"))
          .getByRole("button", { name: "acme-bot" })
          .getAttribute("aria-pressed"),
      ).toBe("true");
    });
    const row = await waitFor(() => {
      const found = getRow("Checks failed");
      expect(found.classList.contains("is-pointed")).toBe(true);
      return found;
    });
    expect(scrollIntoView).toHaveBeenCalled();
    expect(scrollIntoView.mock.contexts).toContain(row);
    // The tint is a transition, so the row loses the class and fades by itself.
    await waitFor(() => {
      expect(getRow("Checks failed").classList.contains("is-pointed")).toBe(false);
    });
    // No other row was highlighted.
    expect(document.querySelectorAll(".is-pointed")).toHaveLength(0);
  });

  it("highlights a kind on the plugin's level when the link names no Connection", async () => {
    await openIntake(`/settings/intake?kind=${NOTIFICATION}`, buildIntakeHandlers().handlers);

    expect(getRow("A notification from GitHub").classList.contains("is-pointed")).toBe(true);
    expect(
      within(getSection("GitHub"))
        .getByRole("button", { name: "All GitHub connections" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("ignores a kind no plugin has and a Connection that does not exist", async () => {
    const calls = await openIntake(
      "/settings/intake?kind=github/nothing&connection=01a06d02-7700-7000-8000-0000000000ff",
      buildIntakeHandlers().handlers,
    );

    expect(document.querySelectorAll(".is-pointed")).toHaveLength(0);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(
      within(getSection("GitHub"))
        .getByRole("button", { name: "All GitHub connections" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(calls.some((call) => /\/connections\/[^/]+$/.test(call.path))).toBe(false);
  });

  it("drops a connection that is not an id", async () => {
    await openIntake("/settings/intake?connection=not-an-id", buildIntakeHandlers().handlers);

    expect(
      within(getSection("GitHub"))
        .getByRole("button", { name: "All GitHub connections" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });
});

describe("Settings > Intake, keeping saved choices", () => {
  it("builds the next save on a finished save, not on a read that started before it", async () => {
    const { handlers, records } = buildIntakeHandlers();
    let holdReads = false;
    let heldReads = 0;
    const staleRead = buildGate();
    const freshRead = buildGate();
    const write = buildGate();
    handlers["GET /api/v1/plugins"] = async () => {
      const body = [buildGithub(records), ...records.others];
      if (holdReads) {
        heldReads++;
        await (heldReads === 1 ? staleRead.promise : freshRead.promise);
      }
      return { body };
    };
    const calls = stubApi({ ...buildSidebarHandlers(SIDEBAR_FIXTURE), ...handlers });
    const app = await renderApp(
      createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
      { path: "/settings/intake" },
    );
    await screen.findByRole("heading", { level: 1, name: "Intake" });
    await app.live.waitForFirstPushes();
    records.holdNextWrite = write.promise;
    await userEvent.click(getSwitch("Review requested"));
    await waitFor(() => expect(listWrites(calls)).toHaveLength(1));
    // A read starts while the write runs, so it holds the old settings.
    holdReads = true;
    app.live.pushInvalidation("plugin", ["github"]);
    await waitFor(() => expect(heldReads).toBe(1));
    write.open();
    await waitFor(() =>
      expect(readSource("Review requested")).toBe("Off · all GitHub connections"),
    );
    app.live.pushInvalidation("plugin", ["github"]);
    staleRead.open();
    await waitFor(() => expect(heldReads).toBe(2));
    expect(getSwitch("Review requested").getAttribute("aria-checked")).toBe("false");
    await userEvent.click(getSwitch("Mentioned"));
    await waitFor(() => expect(listWrites(calls)).toHaveLength(2));
    freshRead.open();
    expect(listWrites(calls)[1]!.body).toMatchObject({
      intake: { signalKinds: { [REVIEW]: false, [MENTIONED]: false } },
    });
  });

  it("shows a Connection what it now takes from the plugin's level, with no push from the controller", async () => {
    const { handlers, records } = buildIntakeHandlers();
    stubApi({ ...buildSidebarHandlers(SIDEBAR_FIXTURE), ...handlers });
    const app = await renderApp(
      createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
      { path: "/settings/intake" },
    );
    await screen.findByRole("heading", { level: 1, name: "Intake" });
    await app.live.waitForFirstPushes();
    await app.context.controller!.live.stop();
    await pickSegment("rogier");
    await waitFor(() =>
      expect(getSwitch("Review requested").getAttribute("aria-checked")).toBe("true"),
    );
    await pickSegment("All GitHub connections");
    await userEvent.click(getSwitch("Review requested"));
    await waitFor(() => expect(records.plugin.signalKinds[REVIEW]).toBe(false));
    await pickSegment("rogier");
    await waitFor(() =>
      expect(getSwitch("Review requested").getAttribute("aria-checked")).toBe("false"),
    );
  });
});

/** An Ignore Rule of GitHub's that has caught events. */
const DEPENDABOT_RULE: IgnoreRuleWithCatches = {
  id: "01a06d02-7f00-7000-8000-000000000001",
  kind: REVIEW,
  match: { repo: "acme/webshop", author: "dependabot[bot]" },
  text: "Review requested · Repository acme/webshop · Author dependabot[bot]",
  createdAt: "2026-10-01T09:00:00.000Z",
  actor: "user",
  caughtCount: 14,
  lastCaughtAt: "2026-10-02T09:00:00.000Z",
};

/** An Ignore Rule of Linear's, which lists in Linear's section only. */
const LINEAR_RULE: IgnoreRuleWithCatches = {
  id: "01a06d02-7f00-7000-8000-000000000002",
  kind: "linear/assigned",
  match: { team: "Payments" },
  text: "Assigned · Team Payments",
  createdAt: "2026-10-01T09:00:00.000Z",
  actor: "user",
  caughtCount: 0,
};

/** An Ignore Rule of Jira's, a plugin that is no longer installed. */
const JIRA_RULE: IgnoreRuleWithCatches = {
  id: "01a06d02-7f00-7000-8000-000000000003",
  kind: "jira/assigned",
  match: { project: "PAY" },
  text: "Assigned · Project PAY",
  createdAt: "2026-10-01T09:00:00.000Z",
  actor: "user",
  caughtCount: 2,
};

/** An Ignore Rule of Quiet's, a plugin that declares no kind since an update removed it. */
const QUIET_RULE: IgnoreRuleWithCatches = {
  id: "01a06d02-7f00-7000-8000-000000000004",
  kind: "quiet/pinged",
  match: { room: "ops" },
  text: "Pinged · Room ops",
  createdAt: "2026-10-01T09:00:00.000Z",
  actor: "user",
  caughtCount: 0,
};

/**
 * Returns the handlers of a controller that holds the Ignore Rules `rules`:
 * a delete takes the rule out of `rules`, and the rules read next leave it
 * out. When `failDelete` is set, the delete fails with that message instead.
 */
const buildIgnoreRuleHandlers = (
  rules: IgnoreRuleWithCatches[],
  failDelete: string | null = null,
): Record<string, Handler> => ({
  ...buildIntakeHandlers().handlers,
  "GET /api/v1/ignore-rules": () => ({ body: rules }),
  ...Object.fromEntries(
    rules.map((rule) => [
      `DELETE /api/v1/ignore-rules/${rule.id}`,
      () => {
        if (failDelete !== null)
          return { status: 500, body: buildErrorBody("internal", failDelete) };
        rules.splice(rules.indexOf(rule), 1);
        return { body: {} };
      },
    ]),
  ),
});

describe("Settings > Intake, Ignore Rules", () => {
  it("lists each plugin's rules in its own section, with what each caught", async () => {
    await openIntake("/settings/intake", buildIgnoreRuleHandlers([DEPENDABOT_RULE, LINEAR_RULE]));

    const github = getSection("GitHub");
    const row = within(github).getByText(DEPENDABOT_RULE.text).closest<HTMLElement>(".intake-row")!;
    expect(within(github).getByRole("heading", { level: 3, name: "Ignore Rules" })).toBeTruthy();
    expect(row.querySelector(".set-label span")!.textContent).toBe("Caught 14 in the last 90 days");
    expect(within(github).queryByText(LINEAR_RULE.text)).toBeNull();
    expect(within(getSection("Linear")).getByText(LINEAR_RULE.text)).toBeTruthy();
  });

  it("draws no rules heading for a plugin with no rule", async () => {
    await openIntake("/settings/intake", buildIgnoreRuleHandlers([LINEAR_RULE]));

    expect(
      within(getSection("GitHub")).queryByRole("heading", { level: 3, name: "Ignore Rules" }),
    ).toBeNull();
  });

  it("keeps a section, with its rules only, for a plugin that no longer declares a kind", async () => {
    await openIntake("/settings/intake", buildIgnoreRuleHandlers([QUIET_RULE]));

    const quiet = within(getSection("Quiet"));
    expect(quiet.getAllByRole("heading", { level: 3 }).map((each) => each.textContent)).toEqual([
      "Ignore Rules",
    ]);
    expect(quiet.getByText(QUIET_RULE.text)).toBeTruthy();
    expect(quiet.queryByRole("switch")).toBeNull();
  });

  it("lists the rules of a plugin that is not installed, under its id, after the installed plugins, and deletes them", async () => {
    const calls = await openIntake("/settings/intake", buildIgnoreRuleHandlers([JIRA_RULE]));

    // The mark is hidden from assistive technology, so a heading is found by the name alone.
    expect(screen.getAllByRole("heading", { level: 2 })).toEqual(
      ["GitHub", "Linear", "jira"].map((name) => screen.getByRole("heading", { level: 2, name })),
    );
    const jira = within(getSection("jira"));
    expect(jira.getAllByRole("heading", { level: 3 }).map((each) => each.textContent)).toEqual([
      "Ignore Rules",
    ]);
    expect(jira.queryByRole("switch")).toBeNull();

    await userEvent.click(jira.getByRole("button", { name: `Delete the rule ${JIRA_RULE.text}` }));
    const dialog = await screen.findByRole("dialog", { name: "Delete this Ignore Rule?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(screen.queryByRole("heading", { level: 2, name: "jira" })).toBeNull(),
    );
    expect(calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual([
      `/api/v1/ignore-rules/${JIRA_RULE.id}`,
    ]);
  });

  it("asks before it deletes a rule, with Cancel focused, and sends nothing on Cancel", async () => {
    const calls = await openIntake("/settings/intake", buildIgnoreRuleHandlers([DEPENDABOT_RULE]));

    await userEvent.click(
      screen.getByRole("button", { name: `Delete the rule ${DEPENDABOT_RULE.text}` }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Delete this Ignore Rule?" });
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("deletes the rule on Delete, and reads the rules again", async () => {
    const calls = await openIntake("/settings/intake", buildIgnoreRuleHandlers([DEPENDABOT_RULE]));

    await userEvent.click(
      screen.getByRole("button", { name: `Delete the rule ${DEPENDABOT_RULE.text}` }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Delete this Ignore Rule?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByText(DEPENDABOT_RULE.text)).toBeNull());
    expect(calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual([
      `/api/v1/ignore-rules/${DEPENDABOT_RULE.id}`,
    ]);
    expect(
      calls.filter((call) => call.method === "GET" && call.path === "/api/v1/ignore-rules"),
    ).toHaveLength(2);
  });

  it("keeps the dialog open and shows why when the delete fails", async () => {
    await openIntake(
      "/settings/intake",
      buildIgnoreRuleHandlers([DEPENDABOT_RULE], "the database is locked"),
    );

    await userEvent.click(
      screen.getByRole("button", { name: `Delete the rule ${DEPENDABOT_RULE.text}` }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Delete this Ignore Rule?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(
      await within(dialog).findByText("Could not delete: the database is locked"),
    ).toBeTruthy();
    expect(screen.getByText(DEPENDABOT_RULE.text, { selector: ".set-label b" })).toBeTruthy();
  });
});
