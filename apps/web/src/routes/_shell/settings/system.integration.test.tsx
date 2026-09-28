/**
 * Tests for Settings > System. The access-mode fallback policy is fixed, not
 * configurable: a thread only ever falls back to a less permissive mode, so
 * there is nothing for a setting to choose. The screen therefore describes the
 * policy as read-only text. The retention, backup and HTTPS settings the screen
 * will hold are still an empty state. Spec 06 §8.4 and spec 13 §7 own the
 * policy.
 *
 * The tests render the whole app with `renderApp` over a stubbed `fetch`,
 * rather than importing the screen's own modules.
 */
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { readPageText, renderApp, stubApi, type Handler } from "../../../app/testing";

const buildController = (): Readonly<Record<string, Handler>> => ({
  "GET /api/v1/setup": { body: { complete: true } },
  "GET /api/v1/settings": {
    body: {
      controller: {},
      user: {
        "onboarding.completedSteps": ["timezone", "assistant"],
        timezone: "Europe/Amsterdam",
      },
    },
  },
});

const openApp = async () => {
  const api = stubApi(buildController());
  const app = await renderApp({ path: "/settings/system", api: api.fetch, token: "held" });
  return { ...app, api };
};

/** Matches the chain of access modes, least permissive first, with any whitespace between the parts. */
const CHAIN = /approval-required\s*<\s*auto-accept-edits\s*<\s*auto\s*<\s*full-access/;

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
      "A thread asking for a mode its provider does not support runs at the nearest less permissive mode that provider does support.",
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
        /fallback|access mode|approval-required|auto-accept-edits|full-access/i,
      );
    }
  });

  it("shows the retention, backup and HTTPS settings as an empty state that does not mention the policy", async () => {
    await openApp();

    const headline = await screen.findByRole("heading", {
      name: "The controller's settings are not editable yet.",
    });
    const empty = readPageText(headline.parentElement);
    expect(empty).toContain("Retention");
    expect(empty).toContain("HTTPS");
    // The empty state does not say the fallback policy is set here, because
    // the screen describes the policy above as read-only text.
    expect(empty).not.toMatch(/fallback/i);
  });
});
