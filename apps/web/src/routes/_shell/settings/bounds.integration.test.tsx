/**
 * Tests for Settings > Bounds: the default spawn bound's form, and the table
 * of start triggers with what each resume button sends.
 */
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Trigger, WorkflowSummary } from "@hercule/contract";
import { readPageText, renderApp, stubApi, type Call, type Handler } from "../../../app/testing";

const WORKFLOW_ID = "01a06d02-beff-7037-9f5b-0428220159aa";

/** An active start trigger under the default bound, near its limit. */
const NEW_ISSUE: Trigger = {
  workflowId: WORKFLOW_ID,
  workflowName: "GitHub work",
  triggerId: "new_issue",
  kind: "start",
  on: { kind: "github.issue.opened", connectionId: "any" },
  status: "active",
  spawnBound: { maxRuns: 30, windowSeconds: 3600, isDefault: true },
  runsInWindow: 24,
  heldCount: 0,
  createdAt: "2026-09-01T08:00:00.000Z",
  updatedAt: "2026-09-01T08:00:00.000Z",
};

/** A start trigger its source bounds, paused by the breaker with held events. */
const ON_PUSH: Trigger = {
  ...NEW_ISSUE,
  triggerId: "on_push",
  on: { kind: "github.push", connectionId: "any" },
  status: "paused",
  pausedBy: "breaker",
  spawnBound: { maxRuns: 100, windowSeconds: 3600, isDefault: false },
  runsInWindow: 100,
  heldCount: 45,
};

/** A start trigger paused manually, holding nothing. */
const TICK: Trigger = {
  ...NEW_ISSUE,
  workflowId: "01a06d02-beff-7037-9f5b-0428220159bb",
  workflowName: "Screener",
  triggerId: "tick",
  on: { schedule: "*/5 * * * *" },
  status: "paused",
  pausedBy: "manual",
  runsInWindow: 0,
  heldCount: 0,
};

const SETTINGS = {
  controller: {},
  user: { "onboarding.completedSteps": ["timezone", "assistant"], timezone: "Europe/Amsterdam" },
};

/** The workflows of the triggers above: enabled and valid. */
const WORKFLOWS: readonly WorkflowSummary[] = [
  { id: NEW_ISSUE.workflowId, name: "GitHub work", enabled: true, updatedAt: NEW_ISSUE.updatedAt },
  { id: TICK.workflowId, name: "Screener", enabled: true, updatedAt: TICK.updatedAt },
];

const buildResumePath = (trigger: Trigger): string =>
  `/api/v1/workflows/${trigger.workflowId}/triggers/${trigger.triggerId}/resume`;

/**
 * Builds a stub controller that lists `triggers` and `workflows`, and accepts
 * every write.
 */
const buildController = (
  triggers: readonly Trigger[],
  workflows: readonly WorkflowSummary[],
): Readonly<Record<string, Handler>> => ({
  "GET /api/v1/setup": { body: { complete: true } },
  "GET /api/v1/settings": { body: SETTINGS },
  "PATCH /api/v1/settings": (call: Call) => ({
    body: {
      ...SETTINGS,
      controller: (call.body as { controller: Record<string, unknown> }).controller,
    },
  }),
  "GET /api/v1/triggers": { body: { items: triggers } },
  "GET /api/v1/workflows": { body: { items: workflows } },
  "GET /api/v1/notifications": { body: { items: [] } },
  ...Object.fromEntries(
    triggers.map((trigger) => [
      `POST ${buildResumePath(trigger)}`,
      { body: { ...trigger, status: "active" } },
    ]),
  ),
});

const openApp = async (
  triggers: readonly Trigger[],
  workflows: readonly WorkflowSummary[] = WORKFLOWS,
) => {
  const api = stubApi(buildController(triggers, workflows));
  await renderApp({ path: "/settings/bounds", api: api.fetch, token: "held" });
  return api;
};

/**
 * Returns the writes this screen made, in order. The shell opens a live
 * connection on every screen and fetches a ticket for it with a POST. This
 * screen did not make that request, so it is left out.
 */
const listWrites = (api: { readonly calls: readonly Call[] }): readonly Call[] =>
  api.calls.filter((call) => call.method !== "GET" && !call.path.endsWith("/auth/ws-ticket"));

/**
 * Returns the rows that hold a trigger, leaving out the rows under them that
 * hold its discard offer or its error, which have one cell.
 */
const listTriggerRows = (): readonly HTMLElement[] =>
  screen
    .getAllByRole("row")
    .slice(1)
    .filter((row) => within(row).getAllByRole("cell").length > 1);

/** Finds the table row of one trigger: the row that holds its id. */
const findTriggerRow = async (triggerId: string): Promise<HTMLElement> => {
  await screen.findByText(triggerId);
  const row = screen
    .getAllByRole("row")
    .find((candidate) => within(candidate).queryByText(triggerId) !== null);
  if (row === undefined) throw new Error(`no row for ${triggerId}`);
  return row;
};

describe("Settings > Bounds", () => {
  describe("the default bound", () => {
    it("shows the built-in default while no default is set, and saves a new one", async () => {
      const user = userEvent.setup();
      const api = await openApp([NEW_ISSUE]);

      const runs = await screen.findByLabelText("Runs");
      const window = screen.getByLabelText("Window");
      expect(runs).toHaveProperty("value", "30");
      expect(window).toHaveProperty("value", "3600");
      expect(readPageText()).toContain("starts at most 30 per hour");
      const save = screen.getByRole("button", { name: "Save" });
      expect(save).toHaveProperty("disabled", true);

      await user.clear(runs);
      await user.type(runs, "10");
      await user.clear(window);
      await user.type(window, "600");
      expect(readPageText()).toContain("starts at most 10 per 10 minutes");
      await user.click(save);

      await waitFor(() => {
        expect(listWrites(api)).toHaveLength(1);
      });
      const [patch] = listWrites(api);
      expect(patch?.method).toBe("PATCH");
      expect(patch?.body).toEqual({
        controller: { "spawnBound.default": { maxRuns: 10, windowSeconds: 600 } },
      });
      expect((await screen.findByRole("status")).textContent).toBe("Saved.");
    });

    it("refuses a field that holds no whole number in range, and sends nothing", async () => {
      const user = userEvent.setup();
      const api = await openApp([NEW_ISSUE]);

      const runs = await screen.findByLabelText("Runs");
      const window = screen.getByLabelText("Window");
      await user.clear(runs);
      await user.type(runs, "0");
      await user.clear(window);
      await user.type(window, "1.5");
      await user.click(screen.getByRole("button", { name: "Save" }));

      expect(screen.getAllByRole("alert").map((alert) => alert.textContent)).toEqual([
        "Enter a whole number of runs from 1 to 10,000.",
        "Enter a whole number of seconds from 1 to 2,592,000, which is 30 days.",
      ]);
      expect(listWrites(api)).toEqual([]);

      // Editing a field clears its error only.
      await user.type(runs, "5");
      expect(screen.getAllByRole("alert").map((alert) => alert.textContent)).toEqual([
        "Enter a whole number of seconds from 1 to 2,592,000, which is 30 days.",
      ]);
    });
  });

  describe("the triggers", () => {
    it("shows each start trigger's use of its bound, its status and its held count", async () => {
      await openApp([TICK, ON_PUSH, NEW_ISSUE]);

      const readCells = async (triggerId: string) =>
        within(await findTriggerRow(triggerId))
          .getAllByRole("cell")
          .map((cell) => cell.textContent);
      expect(await readCells("new_issue")).toEqual([
        "GitHub work",
        "new_issue",
        "24 of 30 per hour default",
        "active",
        "0",
        "",
      ]);
      expect(await readCells("on_push")).toEqual([
        "GitHub work",
        "on_push",
        "100 of 100 per hour override",
        "paused by the breaker",
        "45",
        "Resume",
      ]);
      expect(await readCells("tick")).toEqual([
        "Screener",
        "tick",
        "0 of 30 per hour default",
        "paused manually",
        "0",
        "Resume",
      ]);
      // The same tooltip as on the workflow's page says what the numbers count.
      expect(screen.getByText("24 of 30 per hour").closest("td")?.getAttribute("title")).toBe(
        "24 runs started in the last hour, or about to start. The bound is the default from Settings > Bounds.",
      );

      // Ordered by workflow name, then trigger id.
      const ids = listTriggerRows().map((row) => within(row).getAllByRole("cell")[1]?.textContent);
      expect(ids).toEqual(["new_issue", "on_push", "tick"]);
    });

    it("shows an active trigger's workflow as invalid or disabled, and a pause before either", async () => {
      const [gitHubWork, screener] = WORKFLOWS as [WorkflowSummary, WorkflowSummary];
      await openApp(
        [NEW_ISSUE, ON_PUSH, TICK],
        [
          { ...gitHubWork, invalidSince: "2026-10-01T08:00:00.000Z" },
          { ...screener, enabled: false },
        ],
      );

      const invalid = within(await findTriggerRow("new_issue")).getByText("workflow invalid");
      expect(invalid.className).toContain("text-fail");
      // A paused trigger shows its pause, because only a resume starts it again.
      expect(readPageText(await findTriggerRow("on_push"))).toContain("paused by the breaker");
      expect(readPageText(await findTriggerRow("tick"))).toContain("paused manually");
    });

    it("shows an active trigger of a disabled workflow as disabled", async () => {
      const [gitHubWork] = WORKFLOWS as [WorkflowSummary];
      await openApp([NEW_ISSUE], [{ ...gitHubWork, enabled: false }]);

      expect(readPageText(await findTriggerRow("new_issue"))).toContain("workflow disabled");
    });

    it("reads every page of workflows, so a trigger's workflow on a later page still shows as disabled", async () => {
      const [gitHubWork] = WORKFLOWS as [WorkflowSummary];
      const api = stubApi({
        ...buildController([NEW_ISSUE], []),
        "GET /api/v1/workflows": (call: Call) =>
          call.search.includes("cursor=")
            ? { body: { items: [{ ...gitHubWork, enabled: false }] } }
            : { body: { items: [], nextCursor: "second-page" } },
      });
      await renderApp({ path: "/settings/bounds", api: api.fetch, token: "held" });

      expect(readPageText(await findTriggerRow("new_issue"))).toContain("workflow disabled");
    });

    it("links each trigger's workflow to the workflow's page", async () => {
      await openApp([NEW_ISSUE]);

      const row = await findTriggerRow("new_issue");
      expect(within(row).getByRole("link", { name: "GitHub work" }).getAttribute("href")).toBe(
        `/workflows/${WORKFLOW_ID}`,
      );
    });

    it("offers to resume only a paused trigger, and to discard only what one holds", async () => {
      await openApp([TICK, ON_PUSH, NEW_ISSUE]);

      const buttonNames = async (triggerId: string) =>
        within(await findTriggerRow(triggerId))
          .queryAllByRole("button")
          .map((button) => button.textContent);
      expect(await buttonNames("new_issue")).toEqual([]);
      expect(await buttonNames("tick")).toEqual(["Resume"]);
      expect(await buttonNames("on_push")).toEqual(["Resume"]);
      // The offer to discard sits on its own row, under the row of on_push.
      const discards = screen.getAllByRole("button", { name: "Resume and discard held events" });
      expect(discards).toHaveLength(1);
      expect(discards[0]?.closest("tr")?.previousElementSibling).toBe(
        await findTriggerRow("on_push"),
      );
    });

    it("resumes a trigger, keeps what it holds, and reads the notifications again", async () => {
      const user = userEvent.setup();
      const api = await openApp([ON_PUSH]);

      const row = await findTriggerRow("on_push");
      await user.click(within(row).getByRole("button", { name: "Resume" }));

      await waitFor(() => {
        expect(listWrites(api)).toHaveLength(1);
      });
      const [resume] = listWrites(api);
      expect(resume?.path).toBe(buildResumePath(ON_PUSH));
      expect(resume?.body).toEqual({});
      // The resume answers the breaker's decision, so the sidebar's count of
      // notifications is read again.
      const resumeIndex = api.calls.findIndex((call) => call === resume);
      await waitFor(() => {
        expect(
          api.calls.slice(resumeIndex).some((call) => call.path === "/api/v1/notifications"),
        ).toBe(true);
      });
    });

    it("asks before it resumes a trigger and discards its held events", async () => {
      const user = userEvent.setup();
      const api = await openApp([ON_PUSH]);

      await findTriggerRow("on_push");
      const discard = screen.getByRole("button", { name: "Resume and discard held events" });
      await user.click(discard);
      const question = screen.getByRole("group", {
        name: "Discard the 45 held events and resume? They stay in the event log, but start no runs.",
      });

      // Cancel sends nothing and gives the focus back to the button that asked.
      await user.click(within(question).getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("group")).toBeNull();
      expect(document.activeElement).toBe(discard);
      expect(listWrites(api)).toEqual([]);

      await user.click(discard);
      await user.click(
        within(screen.getByRole("group", { name: /^Discard the 45 held events/ })).getByRole(
          "button",
          { name: "Resume and discard held events" },
        ),
      );

      await waitFor(() => {
        expect(listWrites(api)).toHaveLength(1);
      });
      const [resume] = listWrites(api);
      expect(resume?.path).toBe(buildResumePath(ON_PUSH));
      expect(resume?.body).toEqual({ discardHeld: true });
    });
  });

  it("shows the empty state, under the default bound, when no workflow has a start trigger", async () => {
    await openApp([]);

    expect(await screen.findByText("No trigger has a bound to show yet.")).toBeTruthy();
    expect(readPageText()).toContain(
      "A spawn bound caps how often a trigger may start runs. Every start trigger is listed here with its bound, its current window, and whether it is paused.",
    );
    expect(screen.getByLabelText("Runs")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
