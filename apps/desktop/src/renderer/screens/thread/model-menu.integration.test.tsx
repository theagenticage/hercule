/**
 * Tests the composer's model menu opened from the pill, against the stubbed
 * controller: that opening it and unfolding a profile make no request, that a
 * clicked head leaves the draft's model alone and is remembered for the next
 * time the menu opens, and that the menu starts afresh when it closes.
 *
 * jsdom has no popover API, so the test sends the `toggle` event the browser
 * sends when the popover opens or closes.
 */
import { describe, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ModelProfile } from "@hercule/contract";
import {
  buildSidebarHandlers,
  buildThreadHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  FIXTURE_ACCOUNT,
  FIXTURE_MODEL_PROFILE,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  THREAD_FIXTURES,
} from "../../app/testing";
import { readLastOpenProfileId } from "../../app/recent-models";

/** A second profile with the first one's entries, so the entry in use is in both. */
const WORK: ModelProfile = {
  ...FIXTURE_MODEL_PROFILE,
  id: "01a06d02-7800-7000-8000-000000000002",
  name: "Work",
};

/**
 * Opens the app on a new thread, with two Model Profiles, and returns the
 * requests sent so far once the message field shows.
 */
const openDraft = async () => {
  const calls = stubApi({
    ...buildSidebarHandlers({
      ...SIDEBAR_FIXTURE,
      accounts: [FIXTURE_ACCOUNT],
      modelProfiles: [FIXTURE_MODEL_PROFILE, WORK],
    }),
    ...buildThreadHandlers(THREAD_FIXTURES.finished),
  });
  const fake = createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" });
  await renderApp(fake, { path: "/" });
  await screen.findByRole("textbox", { name: "Message" });
  // The app goes on with its other reads after the draft shows. Wait until
  // no request has come for half a second, so a request counted later is the
  // menu's.
  let seen = calls.length;
  let quietSince = Date.now();
  await waitFor(
    () => {
      if (calls.length !== seen) {
        seen = calls.length;
        quietSince = Date.now();
      }
      expect(Date.now() - quietSince).toBeGreaterThanOrEqual(500);
    },
    { interval: 50, timeout: 5000 },
  );
  return calls;
};

/** Sends the popover of the model menu the `toggle` event of the browser. */
const toggleModelMenu = (newState: "open" | "closed"): void => {
  const popover = document.querySelector<HTMLElement>("[popover][aria-label='Model']")!;
  act(() => {
    fireEvent(popover, Object.assign(new Event("toggle"), { newState }));
  });
};

/** Returns the heads of the accordion and whether each is unfolded. */
const readHeads = (): readonly (readonly [string, string | null])[] =>
  [...document.querySelectorAll<HTMLElement>("button[aria-expanded]")]
    .filter((head) => head.closest("[popover]") !== null)
    .map((head) => [head.firstElementChild!.textContent, head.getAttribute("aria-expanded")]);

describe("the composer's model menu", () => {
  it("opens with a head per profile and reads nothing, and a clicked head leaves the model alone", async () => {
    const calls = await openDraft();
    const sent = calls.length;
    const pill = document.querySelector(".pick--pill")!;

    toggleModelMenu("open");

    expect(readHeads()).toEqual([
      ["Main", "true"],
      ["Work", "false"],
    ]);
    // A real click also focuses the window's field, and the focus makes the
    // query cache read everything again, so the click is sent without focus.
    fireEvent.click(screen.getByRole("button", { name: /^Work/, hidden: true }));
    expect(readHeads()).toEqual([
      ["Main", "false"],
      ["Work", "true"],
    ]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(calls).toHaveLength(sent);
    expect(pill.textContent).toContain("Claude Sonnet 5");
    expect(readLastOpenProfileId(CONTROLLER_URL)).toBe(WORK.id);
  });

  it("forgets the opened head when it closes, and opens on the profile open last", async () => {
    const user = userEvent.setup();
    await openDraft();

    toggleModelMenu("open");
    await user.click(screen.getByRole("button", { name: /^Work/, hidden: true }));
    toggleModelMenu("closed");
    toggleModelMenu("open");

    // The entry in use is in both profiles, so the profile open last decides.
    expect(readHeads()).toEqual([
      ["Main", "false"],
      ["Work", "true"],
    ]);
  });
});
