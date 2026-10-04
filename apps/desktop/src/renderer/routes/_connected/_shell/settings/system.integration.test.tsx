/**
 * Tests Settings > System: the controller's record, read each time the
 * section opens, and the access-mode fallback chain.
 */
import { afterEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { forgetLastSettingsSection } from "../../../../app/last-settings-section";
import {
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
} from "../../../../app/testing";

afterEach(forgetLastSettingsSection);

const [MOSS] = SIDEBAR_FIXTURE.runners;
/** A runner the runners list does not hold, such as one removed since. */
const GONE_RUNNER_ID = "01a06d02-beff-7037-9f5b-0428220159ff";

/** Returns the value shown in the System section's row whose label is `label`. */
const readValue = (label: string): string | null =>
  screen
    .getByText(label, { selector: ".set-label b" })
    .closest(".set-row")!
    .querySelector(".set-value")!.textContent;

describe("Settings > System", () => {
  it("shows the controller's record, naming the runners it holds", async () => {
    stubApi({
      ...buildSidebarHandlers(SIDEBAR_FIXTURE),
      "GET /api/v1/controller": {
        body: {
          id: "01a06d02-7800-7000-8000-000000000001",
          publicKey: "cHVibGljLWtleQ==",
          version: "0.4.2",
          defaultRunnerId: MOSS!.id,
          localRunnerId: GONE_RUNNER_ID,
        },
      },
    });
    await renderApp(createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }), {
      path: "/settings/system",
    });
    await screen.findByRole("heading", { level: 1, name: "System" });

    expect(readValue("Version")).toBe("0.4.2");
    expect(readValue("Controller id")).toBe("01a06d02-7800-7000-8000-000000000001");
    expect(readValue("Default runner")).toBe("moss");
    // A runner the list does not hold shows the tail of its id.
    expect(readValue("Local runner")).toBe("220159ff");
    expect(document.querySelector(".set-chain")?.textContent).toBe(
      "Approval required < Auto-accept edits < Auto < Full access",
    );
  });

  it("shows None for a runner that is not set, and reads the record again each time the section opens", async () => {
    let defaultRunnerId: string | null = null;
    const calls = stubApi({
      ...buildSidebarHandlers(SIDEBAR_FIXTURE),
      "GET /api/v1/controller": () => ({
        body: {
          id: "01a06d02-7800-7000-8000-000000000001",
          publicKey: "cHVibGljLWtleQ==",
          version: "0.4.2",
          defaultRunnerId,
          localRunnerId: null,
        },
      }),
    });
    await renderApp(createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }), {
      path: "/settings/system",
    });
    await screen.findByRole("heading", { level: 1, name: "System" });
    expect(readValue("Default runner")).toBe("None");
    expect(readValue("Local runner")).toBe("None");

    // The default runner changes from the CLI while Profile is open.
    await userEvent.click(screen.getByRole("link", { name: "Profile" }));
    await screen.findByRole("heading", { level: 1, name: "Profile" });
    defaultRunnerId = MOSS!.id;
    await userEvent.click(screen.getByRole("link", { name: "System" }));

    await waitFor(() => {
      expect(readValue("Default runner")).toBe("moss");
    });
    expect(
      calls.filter((call) => call.method === "GET" && call.path === "/api/v1/controller"),
    ).toHaveLength(2);
  });
});
