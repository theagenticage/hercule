/**
 * Tests the two states of the Replace dialog that the refusal tests do not
 * reach: the button while the write runs, and the way to read the list again
 * when the write went through and the list could not be read. The words come
 * from client-core; these tests check that this app draws them.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Handler } from "@hercule/client-core/testing";
import { buildErrorBody } from "@hercule/client-core/testing";
import { forgetLastSettingsSection } from "../../../../../app/last-settings-section";
import {
  buildUrlServer,
  SENTRY_WORK,
} from "../../../../../screens/settings/mcp-servers/mcp-servers.testing";
import {
  findCalls,
  findRow,
  openList,
  SERVER_LIST_PATH,
} from "../../../../../screens/settings/mcp-servers/mcp-world.testing";

// The Office draws a 3D scene, which jsdom cannot, so a stub stands in for it.
vi.mock("../../../../../office/office-screen", () => ({ OfficeScreen: () => <p>The Office</p> }));

afterEach(forgetLastSettingsSection);

const SENTRY_DOCS_ID = "01a06d02-8200-7000-8000-000000000013";
const SENTRY_DOCS = buildUrlServer(SENTRY_DOCS_ID, "sentrydocs", "https://mcp.sentry.example/mcp");
const PATCH_PATH = `PATCH ${SERVER_LIST_PATH}/${SENTRY_DOCS_ID}`;

/** Presses the switch that opens the Replace dialog and returns the dialog. */
const openReplaceDialog = async (): Promise<HTMLElement> => {
  await userEvent.click(
    within(findRow("sentry hobby")).getByRole("switch", { name: "Offer sentry hobby to threads" }),
  );
  return screen.findByRole("dialog", { name: "Replace the sentrydocs server you added?" });
};

describe("the Replace dialog while it writes and when it cannot read the result", () => {
  it("shows the button as busy while the controller has not answered the write", async () => {
    await openList({
      servers: [SENTRY_WORK, SENTRY_DOCS],
      handlers: { [PATCH_PATH]: () => new Promise(() => undefined) },
    });
    const dialog = await openReplaceDialog();

    await userEvent.click(within(dialog).getByRole("button", { name: "Replace" }));

    const busy = await within(dialog).findByRole("button", { name: "Replacing…" });
    expect(busy.getAttribute("aria-disabled")).toBe("true");
  });

  it("offers to read the list again when the write went through and the list cannot be read", async () => {
    let written = false;
    const unreadable: Handler = () => ({
      status: 500,
      body: buildErrorBody("internal", "The list could not be read."),
    });
    const app = await openList({
      servers: [SENTRY_WORK, SENTRY_DOCS],
      handlers: {
        [PATCH_PATH]: () => {
          written = true;
          return { body: SENTRY_DOCS };
        },
        [`GET ${SERVER_LIST_PATH}`]: (call) =>
          written ? unreadable(call) : { body: { items: [SENTRY_WORK, SENTRY_DOCS] } },
      },
    });
    const dialog = await openReplaceDialog();
    await userEvent.click(within(dialog).getByRole("button", { name: "Replace" }));

    const readAgain = await within(dialog).findByRole("button", { name: "Read again" });
    const readsBefore = findCalls(app.calls, "GET", SERVER_LIST_PATH).length;
    await userEvent.click(readAgain);

    await vi.waitFor(() => {
      expect(findCalls(app.calls, "GET", SERVER_LIST_PATH).length).toBeGreaterThan(readsBefore);
    });
  });
});
