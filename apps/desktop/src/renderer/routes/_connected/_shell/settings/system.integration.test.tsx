/**
 * Tests Settings > System: the controller's record, read each time the
 * section opens, the text generation model that saves when it is picked, and
 * the access-mode fallback chain.
 */
import { afterEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ControllerInfo, SettingsPatch } from "@hercule/contract";
import { forgetLastSettingsSection } from "../../../../app/last-settings-section";
import {
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  FIXTURE_ACCOUNT,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  type Call,
} from "../../../../app/testing";

afterEach(forgetLastSettingsSection);

const [MOSS] = SIDEBAR_FIXTURE.runners;
/** A runner the runners list does not hold, such as one removed since. */
const GONE_RUNNER_ID = "01a06d02-beff-7037-9f5b-0428220159ff";

const NO_TEXT_GENERATION: ControllerInfo["textGeneration"] = {
  model: null,
  lastFailure: null,
  unavailableReason: null,
};

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
          textGeneration: NO_TEXT_GENERATION,
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
          textGeneration: NO_TEXT_GENERATION,
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
    // The first pushes on the runner and provider topics read the record
    // again too, so only the reads from here on count.
    const countControllerReads = (): number =>
      calls.filter((call) => call.method === "GET" && call.path === "/api/v1/controller").length;
    const readsBefore = countControllerReads();
    await userEvent.click(screen.getByRole("link", { name: "System" }));

    await waitFor(() => {
      expect(readValue("Default runner")).toBe("moss");
    });
    expect(countControllerReads()).toBe(readsBefore + 1);
  });
});

describe("Settings > System, text generation", () => {
  const OPUS = { providerAccountId: FIXTURE_ACCOUNT.id, model: "claude-opus-5" };
  const SONNET = { providerAccountId: FIXTURE_ACCOUNT.id, model: "claude-sonnet-5" };

  /** Returns `model` as the controller reports it: with the harness it runs in. */
  const report = (model: { providerAccountId: string; model: string }) => ({
    ...model,
    harnessId: "claude-code/claude-code",
  });

  /**
   * Opens System on a controller that holds the Anthropic account, the
   * stored `setting` (none when undefined) and the text generation `status`.
   * A save is answered with the settings it stores. `status` is either fixed,
   * or worked out from the setting stored when the controller is read, as the
   * real controller does.
   */
  const openSystem = async (
    status:
      | ControllerInfo["textGeneration"]
      | ((stored: unknown) => ControllerInfo["textGeneration"]),
    setting?: unknown,
  ): Promise<readonly Call[]> => {
    // The stubbed controller keeps what a save stores, so the read after a save finds it.
    let stored = {
      controller: setting === undefined ? {} : { "textGeneration.model": setting },
      user: {},
    };
    const calls = stubApi({
      ...buildSidebarHandlers({ ...SIDEBAR_FIXTURE, accounts: [FIXTURE_ACCOUNT] }),
      "GET /api/v1/settings": () => ({ body: stored }),
      "PATCH /api/v1/settings": (call) => {
        stored = { controller: (call.body as SettingsPatch).controller ?? {}, user: {} };
        return { body: stored };
      },
      "GET /api/v1/controller": () => ({
        body: {
          id: "01a06d02-7800-7000-8000-000000000001",
          publicKey: "cHVibGljLWtleQ==",
          version: "0.4.2",
          defaultRunnerId: null,
          localRunnerId: null,
          textGeneration:
            typeof status === "function"
              ? status((stored.controller as Record<string, unknown>)["textGeneration.model"])
              : status,
        },
      }),
    });
    await renderApp(createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }), {
      path: "/settings/system",
    });
    await screen.findByRole("heading", { level: 1, name: "System" });
    return calls;
  };

  /**
   * Returns the status a controller reports for `stored`, as it works it out on
   * every read: nothing when text generation is off, the chosen model, or
   * Sonnet for Automatic.
   */
  const followSetting = (stored: unknown): ControllerInfo["textGeneration"] => {
    if (stored === "off") return NO_TEXT_GENERATION;
    if (typeof stored === "object")
      return { model: report(stored as typeof OPUS), lastFailure: null, unavailableReason: null };
    return { model: report(SONNET), lastFailure: null, unavailableReason: null };
  };

  const readSelect = (): HTMLSelectElement =>
    screen.getByRole<HTMLSelectElement>("combobox", { name: "Text generation" });

  const listPatches = (calls: readonly Call[]): unknown[] =>
    calls
      .filter((call) => call.method === "PATCH" && call.path === "/api/v1/settings")
      .map((call) => call.body);

  it("names the model that Automatic resolves to, and offers each model and Off", async () => {
    await openSystem({ model: report(SONNET), lastFailure: null, unavailableReason: null });

    const select = readSelect();
    expect(select.selectedOptions[0]?.textContent).toBe(
      "Automatic - currently Anthropic · Claude Sonnet 5",
    );
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "Automatic - currently Anthropic · Claude Sonnet 5",
      "Anthropic · Claude Sonnet 5",
      "Anthropic · Claude Opus 5",
      "Off",
    ]);
  });

  it("names the model Automatic resolves to after switching from Off, as the controller reports it", async () => {
    const calls = await openSystem(followSetting, "off");
    expect(readSelect().selectedOptions[0]?.textContent).toBe("Off");

    await userEvent.selectOptions(readSelect(), "automatic");

    await waitFor(() => {
      expect(readSelect().selectedOptions[0]?.textContent).toBe(
        "Automatic - currently Anthropic · Claude Sonnet 5",
      );
    });
    expect(listPatches(calls)).toEqual([{ controller: { "textGeneration.model": "automatic" } }]);
  });

  it("names the model Automatic resolves to after switching from a chosen model", async () => {
    await openSystem(followSetting, OPUS);
    expect(readSelect().selectedOptions[0]?.textContent).toBe("Anthropic · Claude Opus 5");

    await userEvent.selectOptions(readSelect(), "automatic");

    await waitFor(() => {
      expect(readSelect().selectedOptions[0]?.textContent).toBe(
        "Automatic - currently Anthropic · Claude Sonnet 5",
      );
    });
  });

  it("shows no model for Automatic when no model is available", async () => {
    await openSystem(NO_TEXT_GENERATION);

    expect(readSelect().selectedOptions[0]?.textContent).toBe("Automatic - no model available");
  });

  it("saves the picked model, and then Off", async () => {
    const calls = await openSystem({
      model: report(SONNET),
      lastFailure: null,
      unavailableReason: null,
    });

    await userEvent.selectOptions(readSelect(), "Anthropic · Claude Opus 5");
    await waitFor(() => {
      expect(listPatches(calls)).toEqual([{ controller: { "textGeneration.model": OPUS } }]);
    });
    await userEvent.selectOptions(readSelect(), "Off");

    await waitFor(() => {
      expect(listPatches(calls)).toEqual([
        { controller: { "textGeneration.model": OPUS } },
        { controller: { "textGeneration.model": "off" } },
      ]);
    });
    expect(readSelect().selectedOptions[0]?.textContent).toBe("Off");
  });

  it("shows the stored model", async () => {
    await openSystem({ model: report(OPUS), lastFailure: null, unavailableReason: null }, OPUS);

    expect(readSelect().selectedOptions[0]?.textContent).toBe("Anthropic · Claude Opus 5");
  });

  it("shows the last failure, with its age, its reason and the controller's message", async () => {
    await openSystem({
      model: report(SONNET),
      lastFailure: {
        reason: "timeout",
        message: "Claude Code did not answer within 60 seconds.",
        at: new Date(Date.now() - 5 * 60_000).toISOString(),
      },
      unavailableReason: null,
    });

    expect(document.querySelector(".set-note")?.textContent).toBe(
      "Last failure 5 minutes ago - timed out: Claude Code did not answer within 60 seconds.",
    );
  });

  it("reads a failure with the reason failed as a failed call, not as a missing model", async () => {
    await openSystem({
      model: report(SONNET),
      lastFailure: {
        reason: "failed",
        message: "The harness exited with code 1.",
        at: new Date(Date.now() - 2 * 60_000).toISOString(),
      },
      unavailableReason: null,
    });

    expect(document.querySelector(".set-note")?.textContent).toBe(
      "Last failure 2 minutes ago - failed: The harness exited with code 1.",
    );
  });

  it("shows no failure line when nothing has failed", async () => {
    await openSystem({ model: report(SONNET), lastFailure: null, unavailableReason: null });
    expect(document.querySelector(".set-note")).toBeNull();
  });

  it("hides the failure line while text generation is off", async () => {
    await openSystem(
      {
        model: null,
        lastFailure: { reason: "unavailable", message: "No runner.", at: new Date().toISOString() },
        unavailableReason: "Text generation is off.",
      },
      "off",
    );

    expect(readSelect().selectedOptions[0]?.textContent).toBe("Off");
    expect(document.querySelector(".set-note")).toBeNull();
  });
});
