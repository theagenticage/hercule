/**
 * Tests Settings > Assistants: New assistant creates one and picks it, a
 * changed field saves only that field, built onto the stored assistant,
 * Delete asks first, and a failed save puts the field back and shows why
 * under its row. The Memory column shows the picked assistant's memory, and
 * New topic creates a topic and opens its page.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describeWhenAssistantChangesApply } from "@hercule/client-core";
import {
  MEMORY_CORE,
  type Assistant,
  type AssistantUpdateInput,
  type Profile,
} from "@hercule/contract";
import { forgetLastSettingsSection } from "../../../../../app/last-settings-section";
import {
  buildErrorBody,
  buildFixtureAssistant,
  buildMemoryDocument,
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  FIXTURE_ACCOUNT,
  holdAnswer,
  neverAnswer,
  type Answer,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  storeMemory,
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
const storeAssistants = (): Readonly<Record<string, (call: Call) => Answer>> => {
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
 * Opens Settings > Assistants at `path` with Ada and Milo, the fixture
 * provider instance and two permission profiles, and `handlers` on top.
 */
const openAssistants = async (
  handlers: Readonly<Record<string, Handler>> = {},
  path = "/settings/assistants",
) => {
  const calls = stubApi({
    ...buildSidebarHandlers({
      ...SIDEBAR_FIXTURE,
      accounts: [FIXTURE_ACCOUNT],
      assistants: [
        { assistant: ADA, session: null },
        { assistant: MILO, session: null },
      ],
    }),
    "GET /api/v1/profiles": { body: { items: PROFILES } },
    ...storeAssistants(),
    ...storeMemory(CREATED.id, [buildMemoryDocument(MEMORY_CORE, "")]),
    ...handlers,
  });
  const fake = createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" });
  const app = await renderApp(fake, { path });
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

  it("says under How it works when a saved change reaches the session", async () => {
    await openAssistants();

    const heading = screen.getByRole("heading", { level: 2, name: "How Ada works" });
    expect(heading.nextElementSibling?.textContent).toBe(describeWhenAssistantChangesApply("Ada"));
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

  it("shows every heartbeat change still saving, and builds the next one on all of them", async () => {
    const store = storeAssistants();
    const patch = `PATCH /api/v1/assistants/${ADA.id}`;
    const saveToStore = store[patch]!;
    const first = holdAnswer();
    let held = false;
    const { calls } = await openAssistants({
      ...store,
      // The first save waits until the test lets it answer; the rest answer at once.
      [patch]: async (call) => {
        if (held) return saveToStore(call);
        held = true;
        await first.handler();
        return saveToStore(call);
      },
    });
    const interval = screen.getByRole("combobox", { name: "Interval" });

    await userEvent.selectOptions(interval, "3 h");
    await userEvent.click(screen.getByRole("switch", { name: "Heartbeat" }));
    const from = screen.getByRole("textbox", { name: "From" });
    await userEvent.clear(from);
    await userEvent.type(from, "10:00{Enter}");

    expect((interval as HTMLSelectElement).value).toBe("3");
    first.answer({ body: {} });
    await waitFor(() => {
      expect(listUpdates(calls, ADA)).toEqual([
        { heartbeat: { ...ADA.heartbeat, schedule: "0 7-22/3 * * *" } },
        { heartbeat: { ...ADA.heartbeat, enabled: true, schedule: "0 7-22/3 * * *" } },
        { heartbeat: { ...ADA.heartbeat, enabled: true, schedule: "0 10-22/3 * * *" } },
      ]);
    });
    expect((interval as HTMLSelectElement).value).toBe("3");
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

  it("keeps the assistant picked while a delete was still running", async () => {
    const store = storeAssistants();
    const remove = `DELETE /api/v1/assistants/${ADA.id}`;
    const deleteFromStore = store[remove]!;
    const held = holdAnswer();
    await openAssistants({
      ...store,
      [remove]: async (call) => {
        await held.handler();
        return deleteFromStore(call);
      },
    });
    // Hercule sorts before Milo, so it is the one picked once Ada is gone,
    // unless the pick of Milo stays.
    await userEvent.click(screen.getByRole("button", { name: "New assistant" }));
    await screen.findByRole("heading", { level: 2, name: "Hercule" });
    const tabs = screen.getByRole("navigation", { name: "Choose an assistant" });
    await userEvent.click(within(tabs).getByRole("link", { name: "Ada" }));

    await userEvent.click(await screen.findByRole("button", { name: "Delete assistant" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Ada?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await userEvent.click(within(tabs).getByRole("link", { name: "Milo" }));
    await screen.findByRole("heading", { level: 2, name: "Milo" });
    held.answer({ body: {} });

    await waitFor(() => {
      expect(within(tabs).queryByRole("link", { name: "Ada" })).toBeNull();
    });
    // The reset would come after the cache drops Ada, in the same answer.
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(screen.getByRole("heading", { level: 2, name: "Milo" })).toBeTruthy();
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

  it("saves nothing for a name that is empty or only spaces, and shows the saved name again", async () => {
    const { calls } = await openAssistants();
    const name = screen.getByRole("textbox", { name: "Name" });

    await userEvent.clear(name);
    await userEvent.type(name, "   {Enter}");

    expect(name).toHaveProperty("value", "Ada");
    expect(listUpdates(calls, ADA)).toEqual([]);
  });

  it("shows a failed prompt save under the Prompt row", async () => {
    await openAssistants({
      [`PATCH /api/v1/assistants/${ADA.id}`]: {
        status: 500,
        body: buildErrorBody("internal", "The database is locked."),
      },
    });
    const prompt = screen.getByRole("textbox", { name: "Prompt" });

    await userEvent.type(prompt, "!");
    await userEvent.tab();

    const error = await screen.findByRole("alert");
    expect(error.textContent).toBe("Could not save: The database is locked.");
    expect(error.previousElementSibling?.contains(prompt)).toBe(true);
    expect(prompt).toHaveProperty("value", ADA.heartbeat.prompt);
  });
});

/** Ada's memory in these tests: a short core note and two topics. */
const ADA_MEMORY = [
  buildMemoryDocument(MEMORY_CORE, "Rogier runs Acme alone. Be brief."),
  buildMemoryDocument("webshop", "Stripe checkout.\n".repeat(80), "Stripe checkout, EU customers"),
  buildMemoryDocument("family", "School run Tue/Thu."),
];

describe("Settings > Assistants, Memory", () => {
  it("shows the picked assistant's core note against its cap, and each topic", async () => {
    await openAssistants(storeMemory(ADA.id, ADA_MEMORY));

    const memory = screen.getByRole("complementary", { name: "Memory" });
    expect(within(memory).getByText("33 of 4,000")).toBeTruthy();
    expect(within(memory).getByText("Rogier runs Acme alone. Be brief.")).toBeTruthy();
    // The topics are listed by name, as the controller lists them.
    expect(
      within(memory)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Edit", "family19", "webshop1.4kStripe checkout, EU customers"]);
    expect(within(memory).getByText("2 of 24 topics · up to 12,000 characters each")).toBeTruthy();
  });

  it("reads the memory of the assistant picked from its tab", async () => {
    const { calls } = await openAssistants(storeMemory(ADA.id, ADA_MEMORY));
    const tabs = screen.getByRole("navigation", { name: "Choose an assistant" });

    await userEvent.click(within(tabs).getByRole("link", { name: "Milo" }));

    const memory = await screen.findByRole("complementary", { name: "Memory" });
    expect(await within(memory).findByText("Milo’s core note is empty.")).toBeTruthy();
    expect(
      calls
        .filter((call) => call.path.startsWith(`/api/v1/assistants/${MILO.id}/memory`))
        .map((call) => call.path),
    ).toEqual([
      `/api/v1/assistants/${MILO.id}/memory`,
      `/api/v1/assistants/${MILO.id}/memory/core`,
    ]);
  });

  it("creates a topic from New topic and opens its page", async () => {
    const { calls } = await openAssistants(storeMemory(ADA.id, ADA_MEMORY, ["decisions"]));

    await userEvent.click(screen.getByRole("button", { name: "New topic" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Topic name" }), " decisions {Enter}");

    expect(await screen.findByRole("heading", { level: 1, name: "decisions" })).toBeTruthy();
    expect(
      calls.filter((call) => call.method === "PUT").map((call) => [call.path, call.body]),
    ).toEqual([
      [`/api/v1/assistants/${ADA.id}/memory/decisions`, { body: "", gist: "", expectedVersion: 0 }],
    ]);
  });

  it("refuses a new topic the assistant created since the index was read, and lists it", async () => {
    const store = storeMemory(ADA.id, ADA_MEMORY, ["decisions"]);
    const path = `/api/v1/assistants/${ADA.id}/memory/decisions`;
    await openAssistants(store);
    const memory = await screen.findByRole("complementary", { name: "Memory" });
    // The assistant creates the topic after the column read the index.
    const createdByAssistant = store[`PUT ${path}`];
    if (typeof createdByAssistant !== "function") throw new Error("no write handler");
    await createdByAssistant({
      method: "PUT",
      path,
      search: "",
      body: { body: "Use SQLite." },
      authorization: null,
    });

    await userEvent.click(screen.getByRole("button", { name: "New topic" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Topic name" }), "decisions{Enter}");

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not create: decisions is at version 1, not 0",
    );
    expect(await within(memory).findByText("decisions")).toBeTruthy();
  });

  it("refuses a new topic named like a stored one, or core, and sends nothing", async () => {
    const { calls } = await openAssistants(storeMemory(ADA.id, ADA_MEMORY));

    await userEvent.click(screen.getByRole("button", { name: "New topic" }));
    const name = screen.getByRole("textbox", { name: "Topic name" });
    await userEvent.type(name, "webshop{Enter}");
    expect((await screen.findByRole("alert")).textContent).toBe(
      'A topic named "webshop" already exists; open it to edit it.',
    );
    await userEvent.clear(name);
    await userEvent.type(name, "core{Enter}");
    expect(screen.getByRole("alert").textContent).toBe(
      '"core" is the core note; choose another name.',
    );

    expect(calls.filter((call) => call.method === "PUT")).toEqual([]);
  });

  it("shows the controller's refusal of a new topic in the dialog, which stays open", async () => {
    const message =
      "this would be topic 25; an assistant has at most 24 topics. Delete a topic first.";
    await openAssistants({
      ...storeMemory(ADA.id, ADA_MEMORY),
      [`PUT /api/v1/assistants/${ADA.id}/memory/decisions`]: {
        status: 422,
        body: { error: { code: "cap_exceeded", message, details: { count: 25, cap: 24 } } },
      },
    });

    await userEvent.click(screen.getByRole("button", { name: "New topic" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Topic name" }), "decisions{Enter}");

    expect((await screen.findByRole("alert")).textContent).toBe(`Could not create: ${message}`);
    expect(screen.getByRole("dialog", { name: "New topic" })).toBeTruthy();
  });
});

describe("Settings > Assistants' search params", () => {
  it("drops an assistant that is not an id", async () => {
    const { router } = await openAssistants({}, "/settings/assistants?assistant=not-an-id");

    expect(router.state.matches.at(-1)!.search).toEqual({});
  });
});
