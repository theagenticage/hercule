/**
 * Tests that the Replace dialog's attempt belongs to the row that opened it:
 * leaving Settings with the dialog open releases the attempt and its refusal.
 * The dialog's words and rules are tested in `url-servers.integration.test.tsx`
 * and in client-core.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { findOrCreateMcpServerSwitches } from "@hercule/client-core/mcp-servers";
import { forgetLastSettingsSection } from "../../../../../app/last-settings-section";
import {
  buildUrlServer,
  SENTRY_HOBBY_CONNECTION,
  SENTRY_WORK,
  SENTRY_WORK_ID,
} from "../../../../../screens/settings/mcp-servers/mcp-servers.testing";
import {
  findRow,
  openList,
  SERVER_LIST_PATH,
} from "../../../../../screens/settings/mcp-servers/mcp-world.testing";

// The Office draws a 3D scene, which jsdom cannot, so a stub stands in for it.
vi.mock("../../../../../office/office-screen", () => ({ OfficeScreen: () => <p>The Office</p> }));

afterEach(forgetLastSettingsSection);

const SENTRY_DOCS_ID = "01a06d02-8200-7000-8000-000000000013";
const SENTRY_DOCS = buildUrlServer(SENTRY_DOCS_ID, "sentrydocs", "https://mcp.sentry.example/mcp");

describe("the Replace dialog of a row", () => {
  it("forgets the dialog and its refusal when the user leaves Settings with the dialog open", async () => {
    const app = await openList({
      servers: [SENTRY_WORK, SENTRY_DOCS],
      handlers: {
        [`PATCH ${SERVER_LIST_PATH}/${SENTRY_DOCS_ID}`]: {
          status: 409,
          body: {
            error: {
              code: "conflict",
              message: "This Connection has a server already.",
              details: { reason: "mcp-server-exists", mcpServerId: SENTRY_WORK_ID },
            },
          },
        },
      },
    });
    await userEvent.click(
      within(findRow("sentry hobby")).getByRole("switch", {
        name: "Offer sentry hobby to threads",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Replace the sentrydocs server you added?",
    });
    await userEvent.click(within(dialog).getByRole("button", { name: "Replace" }));
    await within(dialog).findByRole("alert");

    await act(() => app.router.navigate({ to: "/fleet" }));

    // The app's switches are one instance for its query client, so this call returns the app's own.
    const switches = findOrCreateMcpServerSwitches({
      queryClient: app.context.queryClient,
      client: undefined as never,
      cache: undefined as never,
    });
    expect(
      switches.readReplaceDialog({
        kind: "plugin",
        contributionId: "sentry/sentry",
        connectionId: SENTRY_HOBBY_CONNECTION.id,
      }),
    ).toBeNull();
  });
});
