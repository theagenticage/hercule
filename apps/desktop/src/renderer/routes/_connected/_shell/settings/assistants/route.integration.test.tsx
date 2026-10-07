/**
 * Tests Settings > Assistants: New assistant creates one and picks it, a
 * changed field saves only that field, built onto the stored assistant,
 * Delete asks first, and a failed save puts the field back and shows why
 * under its row.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Assistant, AssistantUpdateInput, Profile } from "@hercule/contract";
import { forgetLastSettingsSection } from "../../../../../app/last-settings-section";
import {
  buildErrorBody,
  buildFixtureAssistant,
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  FIXTURE_INSTANCE,
  holdAnswer,
  neverAnswer,
  type Answer,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  type Call,
  type Handler,
} from "../../../../../app/testing";

afterEach(forgetLastSettingsSection);

const ADA = buildFixtureAssistant({
  id: "01a06d02-7700-7000-8000-000000000001",
  name: "Ada",
  mainConversationId: "01a06d02-7800-7000-8000-000000000001",
});
const MILO = buildFixtureAssistant({
  id: "01a06d02-7700-7000-8000-000000000002",
  name: "Milo",
  mainConversationId: "01a06d02-7800-7000-8000-000000000002",
});

const buildProfile = (id: string, name: string): Profile => ({
  id,
  name,
  grants: [],
  shipped: true,
  createdAt: "2026-09-01T09:00:00.000Z",
  updatedAt: "2026-09-01T09:00:00.000Z",
});

/** The profile every fixture assistant names, and a second one to pick. */
const PROFILES = [
  buildProfile(ADA.permissionProfileId, "Standard"),
  buildProfile("01a06d02-7500-7000-8000-000000000002", "Read only"),
];

/** The assistant New assistant creates in these tests. */
const CREATED = buildFixtureAssistant({
  id: "01a06d02-7700-7000-8000-000000000003",
  name: "Hercule",
  mainConversationId: "01a06d02-7800-7000-8000-000000000003",
});

/**
 * Returns handlers that play the controller's assistants, Ada and Milo, on
 * one stored list: reading it, creating `CREATED`, updating Ada and deleting
 * Ada. A read after a save answers with what the save stored, as the
 * controller's does.
 */
const storeAssistants = (): Readonly<Record<string, Handler>> => {
  let stored = [ADA, MILO];
  return {
    "GET /api/v1/assistants": () => ({ body: { items: stored } }),
    "POST /api/v1/assistants": () => {
      stored = [...stored, CREATED];
      return { body: CREATED };
    },
    [`PATCH /api/v1/assistants/${ADA.id}`]: (call) => {
      const { model, ...rest } = call.body as AssistantUpdateInput;
      const updated: Assistant = {
        ...stored.find(({ id }) => id === ADA.id)!,
        ...rest,
        ...(model !== undefined && { model: model === null ? null : { model, options: {} } }),
      };
      stored = stored.map((each) => (each.id === ADA.id ? updated : each));
      return { body: updated };
    },
    [`DELETE /api/v1/assistants/${ADA.id}`]: () => {
      stored = stored.filter(({ id }) => id !== ADA.id);
      return { body: {} };
    },
  };
};

/**
 * Opens Settings > Assistants with Ada and Milo, the fixture provider
 * instance and two permission profiles, and `handlers` on top.
 */
const openAssistants = async (handlers: Readonly<Record<string, Handler>> = {}) => {
  const calls = stubApi({
    ...buildSidebarHandlers({
      ...SIDEBAR_FIXTURE,
      providers: [FIXTURE_INSTANCE],
      assistants: [
        { assistant: ADA, session: null },
        { assistant: MILO, session: null },
      ],
    }),
    "GET /api/v1/profiles": { body: { items: PROFILES } },
    ...storeAssistants(),
    ...handlers,
  });
  const fake = createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" });
  const app = await renderApp(fake, { path: "/settings/assistants" });
  await screen.findByRole("heading", { level: 1, name: "Assistants" });
  return { calls, ...app };
};

/** Returns the bodies of the calls among `calls` that update `assistant`, oldest first. */
const listUpdates = (calls: readonly Call[], assistant: Assistant): unknown[] =>
  calls
    .filter((call) => call.method === "PATCH" && call.path === `/api/v1/assistants/${assistant.id}`)
    .map((call) => call.body);

describe("Settings > Assistants", () => {
  it("picks the first assistant, and another one from its tab", async () => {
    await openAssistants();

    expect(screen.getByRole("heading", { level: 2, name: "Ada" })).toBeTruthy();
    const tabs = screen.getByRole("navigation", { name: "Choose an assistant" });
    await userEvent.click(within(tabs).getByRole("link", { name: "Milo" }));

    expect(await screen.findByRole("heading", { level: 2, name: "Milo" })).toBeTruthy();
    expect(within(tabs).getByRole("link", { name: "Milo" }).getAttribute("aria-current")).toBe(
      "page",
    );
  });

  it("creates an assistant from the header's button and picks it", async () => {
    const { calls } = await openAssistants();

    await userEvent.click(await screen.findByRole("button", { name: "New assistant" }));

    expect(await screen.findByRole("heading", { level: 2, name: "Hercule" })).toBeTruthy();
    expect(
      calls.filter((call) => call.method === "POST" && call.path === "/api/v1/assistants"),
    ).toEqual([expect.objectContaining({ body: { name: "Hercule" } })]);
    const tabs = screen.getByRole("navigation", { name: "Choose an assistant" });
    expect(within(tabs).getByRole("link", { name: "Hercule" }).getAttribute("aria-current")).toBe(
      "page",
    );
  });

  it("adds a created assistant once, when the live connection listed it first", async () => {
    const created = CREATED;
    let listed = [ADA, MILO];
    let listAnswer = (): Answer | Promise<Answer> => ({ body: { items: listed } });
    const create = holdAnswer();
    const { live } = await openAssistants({
      "GET /api/v1/assistants": () => listAnswer(),
      "POST /api/v1/assistants": create.handler,
    });

    await userEvent.click(await screen.findByRole("button", { name: "New assistant" }));
    // The controller announces the new assistant before the create answers.
    listed = [ADA, MILO, created];
    act(() => {
      live.pushInvalidation("assistant", [created.id]);
    });
    const tabs = screen.getByRole("navigation", { name: "Choose an assistant" });
    await within(tabs).findByRole("link", { name: "Hercule" });
    // The read after the create never answers, so the tabs show what the
    // create put in the cache.
    listAnswer = neverAnswer;
    create.answer({ body: created });

    expect(await screen.findByRole("heading", { level: 2, name: "Hercule" })).toBeTruthy();
    expect(within(tabs).getAllByRole("link", { name: "Hercule" })).toHaveLength(1);
  });

  it("saves only the heartbeat's changed field, onto the heartbeat the last save stored", async () => {
    const { calls } = await openAssistants();

    await userEvent.click(screen.getByRole("switch", { name: "Heartbeat" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Interval" }), "3 h");

    await waitFor(() => {
      expect(listUpdates(calls, ADA)).toEqual([
        { heartbeat: { ...ADA.heartbeat, enabled: true } },
        { heartbeat: { ...ADA.heartbeat, enabled: true, schedule: "0 7-22/3 * * *" } },
      ]);
    });
  });

  it("saves the rotation's and the disallowed tools' changes onto the stored values", async () => {
    const { calls } = await openAssistants();

    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Share of the context" }),
      "80%",
    );
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Add a disallowed tool" }),
      "shell",
    );
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Add a disallowed tool" }),
      "edit",
    );

    await waitFor(() => {
      expect(listUpdates(calls, ADA)).toEqual([
        { rotation: { ...ADA.rotation, contextFraction: 0.8 } },
        { disallowedTools: ["shell"] },
        { disallowedTools: ["shell", "edit"] },
      ]);
    });
  });

  it("saves only the field that changed", async () => {
    const { calls } = await openAssistants();

    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Access mode" }),
      "Full access",
    );
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Provider" }),
      "Claude Code · Claude Opus 5",
    );
    const persona = screen.getByRole("textbox", { name: "Persona" });
    await userEvent.clear(persona);
    await userEvent.type(persona, "Be brief.");
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}");

    await waitFor(() => {
      expect(listUpdates(calls, ADA)).toEqual([
        { accessMode: "full-access" },
        { model: "claude-opus-5" },
        { systemPrompt: "Be brief." },
      ]);
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("deletes an assistant only once the dialog confirms it, then picks another", async () => {
    const { calls } = await openAssistants();

    await userEvent.click(screen.getByRole("button", { name: "Delete assistant" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Ada?" });
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(await screen.findByRole("heading", { level: 2, name: "Milo" })).toBeTruthy();
    expect(calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual([
      `/api/v1/assistants/${ADA.id}`,
    ]);
    const tabs = screen.getByRole("navigation", { name: "Choose an assistant" });
    expect(within(tabs).queryByRole("link", { name: "Ada" })).toBeNull();
  });

  it("puts a field back and shows why under its row when the save fails", async () => {
    await openAssistants({
      [`PATCH /api/v1/assistants/${ADA.id}`]: {
        status: 500,
        body: buildErrorBody("internal", "The database is locked."),
      },
    });
    const segments = screen.getByRole("button", { name: "Segments" });

    await userEvent.click(segments);

    const error = await screen.findByRole("alert");
    expect(error.textContent).toBe("Could not save: The database is locked.");
    expect(segments.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Turn end" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    // The error sits right under the reply mode's row.
    expect(error.previousElementSibling?.contains(segments)).toBe(true);
  });
});
