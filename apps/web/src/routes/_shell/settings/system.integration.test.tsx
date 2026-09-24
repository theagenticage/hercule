/**
 * Settings > System (ticket #70). The access-mode fallback policy is fixed
 * rather than configurable (spec 06 §8.4, spec 13 §7), so the screen states
 * it as read-only text; the retention, backup and HTTPS settings of spec 14's
 * Screens row are still an empty state.
 *
 * Driven through `renderApp` over a stubbed `fetch`, never by reaching into
 * the screen's own modules.
 */
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { readPageText, renderApp, stubApi, type Handler } from "../../../app/testing";

const buildController = (): Readonly<Record<string, Handler>> => ({
  "GET /api/v1/setup": { body: { complete: true } },
  "GET /api/v1/settings": {
    body: {
      controller: {},
      user: { "onboarding.completedSteps": ["timezone"], timezone: "Europe/Amsterdam" },
    },
  },
});

const openApp = async () => {
  const api = stubApi(buildController());
  const app = await renderApp({ path: "/settings/system", api: api.fetch, token: "held" });
  return { ...app, api };
};

/** The chain as spec 06 §8.4 pins it, tolerant of how the markup breaks it up. */
const CHAIN = /approval-required\s*<\s*auto-accept-edits\s*<\s*auto\s*<\s*full-access/;

describe("Settings > System: the access-mode fallback policy", () => {
  it("states the ordered chain, the downward substitution, and that it is fixed", async () => {
    await openApp();

    const text = readPageText();

    // The chain, in order, least permissive first.
    expect(text).toMatch(CHAIN);

    // What the chain does, and that it is a statement about the system rather
    // than a setting - both as whole sentences, so half of one cannot pass.
    expect(text).toContain(
      "A thread asking for a mode its provider does not support runs at the nearest less permissive mode that provider does support.",
    );
    expect(text).toContain(
      "The substitution never goes the other way: a thread never runs more permissively than it asked for.",
    );
    expect(text).toMatch(/fixed|not configurable/i);
  });

  it("offers nothing to change the policy with", async () => {
    await openApp();

    // The statement is text: it is not itself a control and sits in none.
    expect(
      screen.getByText(CHAIN).closest("button, input, select, textarea, [role=radio]"),
    ).toBeNull();

    // And nothing else on the screen offers to change it either.
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

  it("keeps the retention, backup and HTTPS settings an empty state that no longer promises the policy", async () => {
    await openApp();

    const headline = await screen.findByRole("heading", {
      name: "The controller's settings are not editable yet.",
    });
    const empty = readPageText(headline.parentElement);
    expect(empty).toContain("Retention");
    expect(empty).toContain("HTTPS");
    // The empty state no longer says the fallback policy is set here: the
    // screen states it above as read-only text instead.
    expect(empty).not.toMatch(/fallback/i);
  });
});
