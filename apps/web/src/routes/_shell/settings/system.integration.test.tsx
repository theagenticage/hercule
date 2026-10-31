/**
 * Tests for Settings > System. The access-mode fallback policy is fixed, not
 * configurable: a thread only ever falls back to a less permissive mode, so
 * there is nothing for a setting to choose. The screen therefore describes the
 * policy as read-only text. The retention, backup and HTTPS settings the screen
 * will hold are still an empty state. Spec 06 §8.4 and spec 13 §7 own the
 * policy.
 *
 * The one setting the screen does hold is the text generation model.
 *
 * The tests render the whole app with `renderApp` over a stubbed `fetch`,
 * rather than importing the screen's own modules.
 */
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ControllerInfo, ProviderAccount } from "@hercule/contract";
import {
  buildErrorBody,
  readPageText,
  renderApp,
  stubApi,
  type Call,
  type Handler,
} from "../../../app/testing";

const RUNNER_ID = "01a06d02-beff-7037-9f5b-042822015952";

const CODEX: ProviderAccount = {
  id: "01a06d02-1000-7000-8000-000000000001",
  harnessId: "codex/codex",
  name: "Codex",
  config: {},
  displayName: "Codex",
  binaryName: "codex",
  declared: {
    steering: "native",
    fork: "native",
    modelSwitch: "in-session",
    accessModes: {
      "approval-required": "native",
      "auto-accept-edits": "native",
      auto: "native",
      "full-access": "native",
    },
    mcpPassthrough: "native",
    disallowedTools: "native",
    structuredOutput: "supported",
  },
  secretFields: [],
  snapshots: [
    {
      runnerId: RUNNER_ID,
      probedAt: "2026-09-05T09:14:00.000Z",
      harnessVersion: "1.0.0",
      versionVerdict: "ok",
      auth: { status: "ok", identity: "rogier@example.com", planLabel: "Plus" },
      models: [
        { slug: "gpt-6-luna", name: "GPT-6 Luna", imageInput: { maxBytes: null }, options: [] },
        { slug: "gpt-6", name: "GPT-6", imageInput: { maxBytes: null }, options: [] },
      ],
    },
  ],
  createdAt: "2026-09-05T09:00:00.000Z",
  updatedAt: "2026-09-05T09:00:00.000Z",
};

const AUTOMATIC_PICK: ControllerInfo["textGeneration"] = {
  model: { providerAccountId: CODEX.id, model: "gpt-6-luna" },
  lastFailure: null,
  unavailableReason: null,
};

const buildController = (
  options: {
    readonly stored?: unknown;
    readonly textGeneration?: ControllerInfo["textGeneration"];
  } = {},
): Readonly<Record<string, Handler>> => {
  const settings = {
    controller: options.stored === undefined ? {} : { "textGeneration.model": options.stored },
    user: {
      "onboarding.completedSteps": ["timezone", "assistant"],
      timezone: "Europe/Amsterdam",
    },
  };
  return {
    "GET /api/v1/setup": { body: { complete: true } },
    "GET /api/v1/settings": { body: settings },
    "PATCH /api/v1/settings": (call: Call) => ({
      body: {
        ...settings,
        controller: {
          ...settings.controller,
          ...(call.body as { controller: Record<string, unknown> }).controller,
        },
      },
    }),
    "GET /api/v1/provider-accounts": { body: [CODEX] },
    "GET /api/v1/controller": {
      body: {
        id: "01a06d02-a000-7000-8000-000000000001",
        publicKey: "bm90LWEta2V5",
        version: "0.4.2",
        defaultRunnerId: null,
        localRunnerId: null,
        textGeneration: options.textGeneration ?? AUTOMATIC_PICK,
      },
    },
  };
};

const openApp = async (options: Parameters<typeof buildController>[0] = {}) => {
  const api = stubApi(buildController(options));
  const app = await renderApp({ path: "/settings/system", api: api.fetch, token: "held" });
  return { ...app, api };
};

/**
 * Matches the chain of access modes, least permissive first, by the names the
 * user reads, with any whitespace between the parts.
 */
const CHAIN = /Approval required\s*<\s*Auto-accept edits\s*<\s*Auto\s*<\s*Full access/;

describe("Settings > System: the access-mode fallback policy", () => {
  it("describes the ordered chain, the downward substitution, and that it is fixed", async () => {
    await openApp();

    const text = readPageText();

    // The chain, in order, least permissive first.
    expect(text).toMatch(CHAIN);

    // What the chain does, and that it is a property of the system rather
    // than a setting. Both are checked as whole sentences, so half a sentence
    // cannot pass.
    expect(text).toContain(
      "A thread asking for a mode its harness does not support runs at the nearest less permissive mode that harness does support.",
    );
    expect(text).toContain(
      "The substitution never goes the other way: a thread never runs more permissively than it asked for.",
    );
    expect(text).toMatch(/fixed|not configurable/i);
  });

  it("offers no control that changes the policy", async () => {
    await openApp();

    // The chain is plain text: it is not a control and is not inside one.
    expect(
      screen.getByText(CHAIN).closest("button, input, select, textarea, [role=radio]"),
    ).toBeNull();

    // No other control on the screen changes it either.
    const controls = [
      ...screen.queryAllByRole("button"),
      ...screen.queryAllByRole("radio"),
      ...screen.queryAllByRole("checkbox"),
      ...screen.queryAllByRole("combobox"),
      ...screen.queryAllByRole("textbox"),
    ];
    for (const control of controls) {
      const name = `${readPageText(control)} ${control.getAttribute("aria-label") ?? ""}`;
      expect(name, "a control offers to change the fallback policy").not.toMatch(
        /fallback|access mode|approval required|auto-accept edits|full access/i,
      );
    }
  });

  it("names the retention, backup and HTTPS settings as not editable yet, without claiming they are set here", async () => {
    await openApp();

    const headline = await screen.findByRole("heading", {
      name: "The rest of the controller's settings are not editable yet.",
    });
    const empty = readPageText(headline.parentElement);
    expect(empty).toContain("Retention windows, the daily backup and HTTPS will appear here.");
    // The empty state does not claim the fallback policy is set here, because
    // the screen describes the policy above as read-only text.
    expect(empty).not.toMatch(/fallback/i);
  });
});

const listWrites = (api: { readonly calls: readonly Call[] }) =>
  api.calls.filter((call) => call.method === "PATCH");

const findModelField = () => screen.findByLabelText<HTMLSelectElement>("Model");

describe("Settings > System: text generation", () => {
  it("offers Automatic with the model it resolves to, every logged-in model, and Off", async () => {
    await openApp();

    const field = await findModelField();

    expect([...field.options].map((option) => option.textContent)).toEqual([
      "Automatic - currently Codex · GPT-6 Luna",
      "Codex · GPT-6 Luna",
      "Codex · GPT-6",
      "Off",
    ]);
    expect(field.selectedOptions[0]?.textContent).toBe("Automatic - currently Codex · GPT-6 Luna");
  });

  it("shows Automatic with no model when none is available", async () => {
    await openApp({ textGeneration: { model: null, lastFailure: null, unavailableReason: null } });

    const field = await findModelField();

    expect(field.selectedOptions[0]?.textContent).toBe("Automatic - no model available");
  });

  it("explains what the setting is for", async () => {
    await openApp();

    await findModelField();

    expect(readPageText()).toContain(
      "The model that does short jobs for Hercule, such as naming a thread.",
    );
  });

  it("writes the chosen instance and model to textGeneration.model", async () => {
    const user = userEvent.setup();
    const { api } = await openApp();

    await user.selectOptions(await findModelField(), "Codex · GPT-6");

    expect(await screen.findByRole("status")).toBeDefined();
    expect(listWrites(api)).toHaveLength(1);
    expect(listWrites(api)[0]?.body).toEqual({
      controller: { "textGeneration.model": { providerAccountId: CODEX.id, model: "gpt-6" } },
    });
  });

  it("writes off, and automatic again", async () => {
    const user = userEvent.setup();
    const { api } = await openApp();

    await user.selectOptions(await findModelField(), "Off");
    await screen.findByRole("status");
    // With Off stored, Automatic no longer names a model.
    await user.selectOptions(await findModelField(), "Automatic");

    expect(listWrites(api).map((call) => call.body)).toEqual([
      { controller: { "textGeneration.model": "off" } },
      { controller: { "textGeneration.model": "automatic" } },
    ]);
  });

  it("shows the stored choice as selected", async () => {
    await openApp({
      stored: { providerAccountId: CODEX.id, model: "gpt-6" },
      textGeneration: {
        model: { providerAccountId: CODEX.id, model: "gpt-6" },
        lastFailure: null,
        unavailableReason: null,
      },
    });

    const field = await findModelField();

    expect(field.selectedOptions[0]?.textContent).toBe("Codex · GPT-6");
  });

  it("reads the model that was picked from the controller again after a save", async () => {
    const user = userEvent.setup();
    const { api } = await openApp();
    const readsBefore = api.calls.filter((call) => call.path === "/api/v1/controller").length;

    await user.selectOptions(await findModelField(), "Off");
    await screen.findByRole("status");

    const readsAfter = api.calls.filter((call) => call.path === "/api/v1/controller").length;
    expect(readsAfter).toBeGreaterThan(readsBefore);
  });

  it("shows a failed write's error message as the API sent it", async () => {
    const user = userEvent.setup();
    const stub = buildController();
    const api = stubApi({
      ...stub,
      "PATCH /api/v1/settings": {
        status: 500,
        body: buildErrorBody("internal", "the settings table is locked"),
      },
    });
    await renderApp({ path: "/settings/system", api: api.fetch, token: "held" });

    await user.selectOptions(await findModelField(), "Off");

    expect((await screen.findByRole("alert")).textContent).toBe("the settings table is locked");
  });

  describe("the last failure", () => {
    const FAILED: ControllerInfo["textGeneration"] = {
      model: AUTOMATIC_PICK.model,
      lastFailure: {
        reason: "timeout",
        message: "The model did not answer within 60 seconds.",
        at: new Date(Date.now() - 5 * 60_000).toISOString(),
      },
      unavailableReason: null,
    };

    it("shows the reason, the message and how long ago it happened", async () => {
      await openApp({ textGeneration: FAILED });

      await findModelField();

      expect(readPageText()).toContain(
        "Last failure 5 minutes ago - timed out: The model did not answer within 60 seconds.",
      );
    });

    it("reads the reason failed as a failed call, not as a missing model", async () => {
      await openApp({
        textGeneration: {
          ...FAILED,
          lastFailure: {
            reason: "failed",
            message: "The harness exited with code 1.",
            at: new Date(Date.now() - 2 * 60_000).toISOString(),
          },
        },
      });

      await findModelField();

      expect(readPageText()).toContain(
        "Last failure 2 minutes ago - failed: The harness exited with code 1.",
      );
    });

    it("shows nothing when there has been no failure", async () => {
      await openApp();

      await findModelField();

      expect(readPageText()).not.toContain("Last failure");
    });

    it("hides a failure while text generation is off", async () => {
      await openApp({ stored: "off", textGeneration: { ...FAILED, model: null } });

      await findModelField();

      expect(readPageText()).not.toContain("Last failure");
    });
  });
});
