/**
 * Tests the page of one memory document in Settings > Assistants: the text
 * and a topic's gist save when committed, with the version the page read, a
 * save refused because an agent wrote since shows the agent's text and can
 * be sent again over it, a refusal shows under its row and puts the field
 * back, a refused cut saves once a dialog confirms it, and Delete asks first.
 */
import { afterEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MEMORY_CORE, type MemoryWriteInput } from "@hercule/contract";
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
