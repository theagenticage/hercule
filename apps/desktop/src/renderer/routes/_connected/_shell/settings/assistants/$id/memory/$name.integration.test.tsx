/**
 * Tests the page of one memory document in Settings > Assistants: the text
 * and a topic's gist save when committed, with the version the page read, a
 * save refused because an agent wrote since shows the agent's text and can
 * be sent again over it, a save queued behind a refused one is refused
 * too, a refusal shows under its row and puts the field
 * back, a refused cut saves once a dialog confirms it, and Delete asks first.
 */
import { afterEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MEMORY_CORE, type MemoryDocument, type MemoryWriteInput } from "@hercule/contract";
import { forgetLastSettingsSection } from "../../../../../../../app/last-settings-section";
import {
  buildFixtureAssistant,
  buildMemoryDocument,
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  FIXTURE_INSTANCE,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  storeMemory,
  type Answer,
  type Call,
  type Handler,
} from "../../../../../../../app/testing";

afterEach(forgetLastSettingsSection);

const ADA = buildFixtureAssistant({
  id: "01a06d02-7700-7000-8000-000000000001",
  name: "Ada",
  mainConversationId: "01a06d02-7800-7000-8000-000000000001",
});

const CORE = buildMemoryDocument(MEMORY_CORE, "Rogier runs Acme alone. Be brief.");
const WEBSHOP = buildMemoryDocument("webshop", "Stripe checkout.", "Payments");
const MEMORY_PATH = `/api/v1/assistants/${ADA.id}/memory`;

/**
 * Opens the page of Ada's document `name`, with Ada's memory holding the
 * core note and the webshop topic, and `handlers` on top.
 */
const openDocument = async (name: string, handlers: Readonly<Record<string, Handler>> = {}) => {
  const calls = stubApi({
    ...buildSidebarHandlers({
      ...SIDEBAR_FIXTURE,
      providers: [FIXTURE_INSTANCE],
      assistants: [{ assistant: ADA, session: null }],
    }),
    ...storeMemory(ADA.id, [CORE, WEBSHOP]),
    ...handlers,
  });
  const fake = createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" });
  const app = await renderApp(fake, { path: `/settings/assistants/${ADA.id}/memory/${name}` });
  return { calls, ...app };
};

/** Returns the bodies of the writes among `calls` to Ada's document `name`, oldest first. */
const listWrites = (calls: readonly Call[], name: string): unknown[] =>
  calls
    .filter((call) => call.method === "PUT" && call.path === `${MEMORY_PATH}/${name}`)
    .map((call) => call.body);

/** Returns a promise and the function that resolves it, for holding a stubbed request. */
const createGate = () => {
  let open = (): void => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
};

const CONFLICT_MESSAGE = "webshop is at version 2, not 1; read it again";

/**
 * Returns handlers that keep Ada's webshop topic the way the controller does:
 * a write whose `expectedVersion` is not the stored version is refused with
 * `conflict`. A test writes `topic.stored` as an agent would, and holds the
 * reads, or the writes, until it resolves `topic.readsWait` or
 * `topic.writesWait`. `topic.refuse` answers the next write with
 * another error.
 */
const keepWebshop = () => {
  const topic: {
    stored: MemoryDocument;
    readsWait: Promise<void> | null;
    writesWait: Promise<void> | null;
    refuse: Answer | null;
  } = { stored: WEBSHOP, readsWait: null, writesWait: null, refuse: null };
  const handlers: Record<string, Handler> = {
    [`GET ${MEMORY_PATH}/webshop`]: async () => {
      await topic.readsWait;
      return { body: topic.stored };
    },
    [`PUT ${MEMORY_PATH}/webshop`]: async (call) => {
      const { body, gist, expectedVersion } = call.body as MemoryWriteInput;
      await topic.writesWait;
      if (topic.refuse !== null) {
        const answer = topic.refuse;
        topic.refuse = null;
        return answer;
      }
      if (expectedVersion !== topic.stored.version) {
        return { status: 409, body: { error: { code: "conflict", message: CONFLICT_MESSAGE } } };
      }
      const { stored } = topic;
      topic.stored = buildMemoryDocument("webshop", body, gist ?? stored.gist, stored.version + 1);
      return { body: topic.stored };
    },
  };
  return { topic, handlers };
};

describe("Settings > Assistants, a memory document's page", () => {
  it("names the document in the header, with Assistants linked back to the assistant", async () => {
    await openDocument("webshop");

    expect(await screen.findByRole("heading", { level: 1, name: "webshop" })).toBeTruthy();
    expect(
      within(screen.getByRole("banner"))
        .getByRole("link", { name: "Assistants" })
        .getAttribute("href"),
    ).toBe(`/settings/assistants?assistant=${ADA.id}`);
    expect(screen.getByRole("heading", { level: 2, name: "webshop 16 of 12,000" })).toBeTruthy();
  });

  it("saves the edited text when the field loses focus, and the column shows the new size", async () => {
    const { calls } = await openDocument(MEMORY_CORE);
    const text = await screen.findByRole("textbox", { name: "Text" });

    await userEvent.type(text, " Never deploy on Fridays.");
    await userEvent.tab();

    await waitFor(() => {
      expect(listWrites(calls, MEMORY_CORE)).toEqual([
        { body: "Rogier runs Acme alone. Be brief. Never deploy on Fridays.", expectedVersion: 1 },
      ]);
    });
    await userEvent.click(
      within(screen.getByRole("banner")).getByRole("link", { name: "Assistants" }),
    );
    const memory = await screen.findByRole("complementary", { name: "Memory" });
    expect(await within(memory).findByText("58 of 4,000")).toBeTruthy();
  });

  it("refuses a save over what an agent wrote since, shows the agent's text, and saves again over it", async () => {
    const newer = "Stripe checkout. Mollie for NL.";
    const message = "webshop is at version 2, not 1; read it again";
    let stored = WEBSHOP;
    const { calls } = await openDocument("webshop", {
      [`GET ${MEMORY_PATH}/webshop`]: () => ({ body: stored }),
      [`PUT ${MEMORY_PATH}/webshop`]: (call) => {
        const { body, gist, expectedVersion } = call.body as MemoryWriteInput;
        if (expectedVersion !== stored.version) {
          return { status: 409, body: { error: { code: "conflict", message } } };
        }
        stored = buildMemoryDocument("webshop", body, gist ?? stored.gist, stored.version + 1);
        return { body: stored };
      },
    });
    // An agent writes the topic after the page read it.
    stored = buildMemoryDocument("webshop", newer, WEBSHOP.gist, 2);
    const gist = await screen.findByRole("textbox", { name: "Gist" });

    await userEvent.clear(gist);
    await userEvent.type(gist, "Payments, EU{Enter}");

    expect((await screen.findByRole("alert")).textContent).toBe(`Could not save: ${message}`);
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "Text" })).toHaveProperty("value", newer);
    });
    await userEvent.click(screen.getByRole("button", { name: "Save my gist anyway" }));

    await waitFor(() => {
      expect(gist).toHaveProperty("value", "Payments, EU");
    });
    expect(listWrites(calls, "webshop")).toEqual([
      { body: WEBSHOP.body, gist: "Payments, EU", expectedVersion: 1 },
      { body: newer, gist: "Payments, EU", expectedVersion: 2 },
    ]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("refuses a save queued behind one an agent's write refused, and offers each field's text again", async () => {
    const { topic, handlers } = keepWebshop();
    const held = createGate();
    topic.writesWait = held.opened;
    const { calls } = await openDocument("webshop", handlers);
    const gist = await screen.findByRole("textbox", { name: "Gist" });
    const text = screen.getByRole("textbox", { name: "Text" });

    await userEvent.clear(gist);
    await userEvent.type(gist, "Payments, EU{Enter}");
    await userEvent.type(text, " Mollie for NL.");
    await userEvent.tab();
    // An agent writes the topic while the gist save is held.
    topic.stored = buildMemoryDocument("webshop", "Stripe only.", WEBSHOP.gist, 2);
    held.open();

    await waitFor(() => {
      expect(screen.getAllByRole("alert")).toHaveLength(2);
    });
    expect(text).toHaveProperty("value", "Stripe only.");
    expect(listWrites(calls, "webshop")).toEqual([
      { body: WEBSHOP.body, gist: "Payments, EU", expectedVersion: 1 },
      { body: "Stripe checkout. Mollie for NL.", expectedVersion: 1 },
    ]);
    await userEvent.click(screen.getByRole("button", { name: "Save my gist anyway" }));
    await waitFor(() => {
      expect(gist).toHaveProperty("value", "Payments, EU");
    });
    await userEvent.click(screen.getByRole("button", { name: "Save my text anyway" }));

    await waitFor(() => {
      expect(text).toHaveProperty("value", "Stripe checkout. Mollie for NL.");
    });
    expect(listWrites(calls, "webshop").slice(2)).toEqual([
      { body: "Stripe only.", gist: "Payments, EU", expectedVersion: 2 },
      { body: "Stripe checkout. Mollie for NL.", expectedVersion: 3 },
    ]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("refuses a save begun before a read brought an agent's text, and saves it over that text when asked", async () => {
    const { topic, handlers } = keepWebshop();
    const { calls, router } = await openDocument("webshop", handlers);
    await screen.findByRole("textbox", { name: "Text" });
    await router.navigate({ to: "/settings/assistants", search: { assistant: ADA.id } });
    // The agent writes while the page is closed, and the read the page makes
    // when it opens again is held, so the page shows the cached text first.
    topic.stored = buildMemoryDocument("webshop", "Stripe only.", WEBSHOP.gist, 2);
    const read = createGate();
    topic.readsWait = read.opened;
    await router.navigate({
      to: "/settings/assistants/$id/memory/$name",
      params: { id: ADA.id, name: "webshop" },
    });
    const text = await screen.findByRole("textbox", { name: "Text" });
    expect(text).toHaveProperty("value", WEBSHOP.body);

    await userEvent.type(text, " Mollie for NL.");
    read.open();
    expect(
      await screen.findByRole("heading", { level: 2, name: "webshop 12 of 12,000" }),
    ).toBeTruthy();
    await userEvent.tab();

    expect((await screen.findByRole("alert")).textContent).toBe(
      `Could not save: ${CONFLICT_MESSAGE}`,
    );
    expect(topic.stored.body).toBe("Stripe only.");
    await userEvent.click(screen.getByRole("button", { name: "Save my text anyway" }));

    await waitFor(() => {
      expect(topic.stored.body).toBe("Stripe checkout. Mollie for NL.");
    });
    expect(listWrites(calls, "webshop")).toEqual([
      { body: "Stripe checkout. Mollie for NL.", expectedVersion: 1 },
      { body: "Stripe checkout. Mollie for NL.", expectedVersion: 2 },
    ]);
  });

  it("saves an edit made on a page opened again while an earlier save of it ran", async () => {
    const { topic, handlers } = keepWebshop();
    const held = createGate();
    topic.writesWait = held.opened;
    const { calls, router } = await openDocument("webshop", handlers);
    const gist = await screen.findByRole("textbox", { name: "Gist" });

    await userEvent.clear(gist);
    await userEvent.type(gist, "Payments, EU{Enter}");
    await router.navigate({ to: "/settings/assistants", search: { assistant: ADA.id } });
    await router.navigate({
      to: "/settings/assistants/$id/memory/$name",
      params: { id: ADA.id, name: "webshop" },
    });
    const text = await screen.findByRole("textbox", { name: "Text" });
    await userEvent.type(text, " Mollie for NL.");
    await userEvent.tab();
    held.open();

    await waitFor(() => {
      expect(listWrites(calls, "webshop")).toHaveLength(2);
    });
    await waitFor(() => {
      expect(topic.stored.version).toBe(3);
    });
    expect(listWrites(calls, "webshop")).toEqual([
      { body: WEBSHOP.body, gist: "Payments, EU", expectedVersion: 1 },
      { body: "Stripe checkout. Mollie for NL.", expectedVersion: 2 },
    ]);
    expect(topic.stored.gist).toBe("Payments, EU");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("takes no typing in a field while its save runs, so no edit begins on text not stored yet", async () => {
    const { topic, handlers } = keepWebshop();
    const held = createGate();
    topic.writesWait = held.opened;
    await openDocument("webshop", handlers);
    const text = await screen.findByRole("textbox", { name: "Text" });

    await userEvent.type(text, " Mollie for NL.");
    await userEvent.tab();
    expect(text).toHaveProperty("readOnly", true);
    await userEvent.type(text, " Adyen too.");
    expect(text).toHaveProperty("value", "Stripe checkout. Mollie for NL.");
    held.open();

    await waitFor(() => {
      expect(text).toHaveProperty("readOnly", false);
    });
    expect(topic.stored.body).toBe("Stripe checkout. Mollie for NL.");
  });

  it("keeps a field's refused save on offer while the other field saves", async () => {
    const { topic, handlers } = keepWebshop();
    const { calls } = await openDocument("webshop", handlers);
    const gist = await screen.findByRole("textbox", { name: "Gist" });
    const text = screen.getByRole("textbox", { name: "Text" });
    // An agent writes the topic after the page read it.
    topic.stored = buildMemoryDocument("webshop", WEBSHOP.body, "Card payments", 2);

    await userEvent.clear(gist);
    await userEvent.type(gist, "Payments, EU{Enter}");
    await screen.findByRole("button", { name: "Save my gist anyway" });
    await userEvent.type(text, " Mollie for NL.");
    await userEvent.tab();

    await waitFor(() => {
      expect(topic.stored.version).toBe(3);
    });
    expect(screen.getByRole("button", { name: "Save my gist anyway" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Save my gist anyway" }));
    await waitFor(() => {
      expect(topic.stored.gist).toBe("Payments, EU");
    });
    expect(listWrites(calls, "webshop").at(-1)).toEqual({
      body: "Stripe checkout. Mollie for NL.",
      gist: "Payments, EU",
      expectedVersion: 3,
    });
  });

  it("shows a save's refusal on the page opened again while the save ran", async () => {
    const { topic, handlers } = keepWebshop();
    const held = createGate();
    topic.writesWait = held.opened;
    const { router } = await openDocument("webshop", handlers);
    const text = await screen.findByRole("textbox", { name: "Text" });

    await userEvent.type(text, " Mollie for NL.");
    await userEvent.tab();
    await router.navigate({ to: "/settings/assistants", search: { assistant: ADA.id } });
    await router.navigate({
      to: "/settings/assistants/$id/memory/$name",
      params: { id: ADA.id, name: "webshop" },
    });
    await screen.findByRole("textbox", { name: "Text" });
    topic.stored = buildMemoryDocument("webshop", "Stripe only.", WEBSHOP.gist, 2);
    held.open();

    expect((await screen.findByRole("alert")).textContent).toBe(
      `Could not save: ${CONFLICT_MESSAGE}`,
    );
    expect(screen.getByRole("button", { name: "Save my text anyway" })).toBeTruthy();
  });

  it("shows a refused save under its row, as the controller words it, and puts the text back", async () => {
    const message =
      'topic "webshop" is 12,009 chars; cap is 12,000. Move some of it to another topic.';
    await openDocument("webshop", {
      [`PUT ${MEMORY_PATH}/webshop`]: {
        status: 422,
        body: { error: { code: "cap_exceeded", message, details: { size: 12009, cap: 12000 } } },
      },
    });
    const text = await screen.findByRole("textbox", { name: "Text" });

    await userEvent.type(text, "!");
    await userEvent.tab();

    const error = await screen.findByRole("alert");
    expect(error.textContent).toBe(`Could not save: ${message}`);
    expect(error.previousElementSibling?.contains(text)).toBe(true);
    expect(text).toHaveProperty("value", WEBSHOP.body);
  });

  it("saves a refused cut once the dialog confirms it", async () => {
    const message = "this write would cut core from 1,284 to 3 characters; repeat it to confirm.";
    let refused = true;
    const { calls } = await openDocument(MEMORY_CORE, {
      [`PUT ${MEMORY_PATH}/core`]: (call) => {
        if (refused) {
          refused = false;
          return {
            status: 422,
            body: {
              error: {
                code: "shrink_rejected",
                message,
                details: { previousSize: 1284, size: 3 },
              },
            },
          };
        }
        return { body: buildMemoryDocument(MEMORY_CORE, (call.body as { body: string }).body) };
      },
    });
    const text = await screen.findByRole("textbox", { name: "Text" });

    await userEvent.clear(text);
    await userEvent.type(text, "Hi.");
    await userEvent.tab();
    expect((await screen.findByRole("alert")).textContent).toBe(`Could not save: ${message}`);
    await userEvent.click(screen.getByRole("button", { name: "Save the shorter text…" }));
    const dialog = screen.getByRole("dialog", { name: "Save the shorter text?" });
    expect(
      within(dialog).getByText(
        "This cuts the document from 1,284 to 3 characters. What it cuts cannot be brought back.",
      ),
    ).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(listWrites(calls, MEMORY_CORE)).toEqual([
        { body: "Hi.", expectedVersion: 1 },
        { body: "Hi.", expectedVersion: 1, confirmShrink: true },
      ]);
    });
    await waitFor(() => {
      expect(text).toHaveProperty("value", "Hi.");
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("deletes a topic once the dialog confirms it, then goes back to the assistant", async () => {
    const { calls } = await openDocument("webshop");

    await userEvent.click(await screen.findByRole("button", { name: "Delete topic" }));
    const dialog = screen.getByRole("dialog", { name: "Delete webshop?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    const memory = await screen.findByRole("complementary", { name: "Memory" });
    expect(within(memory).queryByText("webshop")).toBeNull();
    expect(calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual([
      `${MEMORY_PATH}/webshop`,
    ]);
  });

  it("has no gist and no Delete on the core note", async () => {
    await openDocument(MEMORY_CORE);

    expect(await screen.findByRole("heading", { level: 1, name: "Core note" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Gist" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete topic" })).toBeNull();
  });

  it("goes back to the assistant from a document that does not exist", async () => {
    const { router } = await openDocument("missing", {
      [`GET ${MEMORY_PATH}/missing`]: {
        status: 404,
        body: { error: { code: "not_found", message: "no document missing" } },
      },
    });

    expect(await screen.findByRole("heading", { level: 1, name: "Assistants" })).toBeTruthy();
    expect(router.state.location.href).toBe(`/settings/assistants?assistant=${ADA.id}`);
  });
});
