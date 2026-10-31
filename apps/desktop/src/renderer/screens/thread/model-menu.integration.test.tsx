/**
 * Tests the composer's model menu opened from the pill, against the stubbed
 * controller: that opening it and unfolding a profile make no request, that a
 * clicked head leaves the draft's model alone and is remembered for the next
 * time the menu opens, and that the menu starts afresh when it closes. Also
 * the "New" rows: Add and "Not now" each send one `modelProfile.update`, leave
 * the menu open, and a refusal shows under the row's lane.
 *
 * jsdom has no popover API, so the test sends the `toggle` event the browser
 * sends when the popover opens or closes.
 */
import { describe, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ModelProfile, ModelProfileUpdateInput } from "@hercule/contract";
import {
  buildErrorBody,
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
  type Call,
  type Handler,
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
const openDraft = async (
  modelProfiles: readonly ModelProfile[] = [FIXTURE_MODEL_PROFILE, WORK],
  handlers: Readonly<Record<string, Handler>> = {},
) => {
  const calls = stubApi({
    ...buildSidebarHandlers({
      ...SIDEBAR_FIXTURE,
      accounts: [FIXTURE_ACCOUNT],
      modelProfiles,
    }),
    ...buildThreadHandlers(THREAD_FIXTURES.finished),
    ...handlers,
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
    .map((head) => [
      head.querySelector(".ac-name")!.textContent,
      head.getAttribute("aria-expanded"),
    ]);

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

/** The profile "Main" whose one section announces "Claude Opus 5.6", which arrived on 26 Oct of this year. */
const WITH_NEW_MODEL: ModelProfile = {
  ...FIXTURE_MODEL_PROFILE,
  accounts: FIXTURE_MODEL_PROFILE.accounts.map((section) => ({
    ...section,
    newModels: [
      {
        model: "claude-opus-5-6",
        name: "Claude Opus 5.6",
        firstSeenAt: `${String(new Date().getUTCFullYear())}-10-26T12:00:00.000Z`,
      },
    ],
  })),
};
const MAIN_PATH = `/api/v1/model-profiles/${FIXTURE_MODEL_PROFILE.id}`;

/** Returns the `modelProfile.update` requests among `calls`. */
const readUpdates = (calls: readonly Call[]): readonly Call[] =>
  calls.filter((call) => call.method === "PATCH" && call.path === MAIN_PATH);

describe("the New rows of the composer's model menu", () => {
  it("draws the row first in its lane with its date, and Add saves one entry and leaves the menu open", async () => {
    let stored = WITH_NEW_MODEL;
    const calls = await openDraft([WITH_NEW_MODEL], {
      [`PATCH ${MAIN_PATH}`]: (call) => {
        const input = call.body as ModelProfileUpdateInput;
        stored = {
          ...stored,
          revision: stored.revision + 1,
          accounts: stored.accounts.map((section) => ({ ...section, newModels: [] })),
        };
        expect(input.expectedRevision).toBe(WITH_NEW_MODEL.revision);
        return { body: stored };
      },
    });
    toggleModelMenu("open");

    const lane = document.querySelector<HTMLElement>(".line--new")!.closest(".pop-sec")!;
    expect(lane.children[1]!.textContent).toBe("NewClaude Opus 5.6 · arrived 26 OctAdd");
    expect(lane.children[2]!.textContent).toContain("Claude Sonnet 5");

    fireEvent.click(screen.getByRole("button", { name: "Add Claude Opus 5.6", hidden: true }));

    await waitFor(() => {
      expect(document.querySelector(".line--new")).toBeNull();
    });
    const updates = readUpdates(calls);
    expect(updates).toHaveLength(1);
    const sent = updates[0]!.body as ModelProfileUpdateInput;
    expect(sent.accounts[0]!.entries!.filter((entry) => entry.model === "claude-opus-5-6")).toEqual(
      [{ providerAccountId: FIXTURE_ACCOUNT.id, model: "claude-opus-5-6", harnessId: null }],
    );
    expect(sent.dismissedNewModels).toEqual([]);
    // The menu is still open and the draft's model is the one it had.
    expect(readHeads()).toEqual([]);
    expect(document.querySelector("[popover][aria-label='Model'] .model-menu-list")).not.toBeNull();
    expect(document.querySelector(".pick--pill")!.textContent).toContain("Claude Sonnet 5");
  });

  it("dismisses a row with one update that lists the model as dismissed", async () => {
    const calls = await openDraft([WITH_NEW_MODEL], {
      [`PATCH ${MAIN_PATH}`]: (call) => {
        const input = call.body as ModelProfileUpdateInput;
        return {
          body: {
            ...WITH_NEW_MODEL,
            revision: WITH_NEW_MODEL.revision + 1,
            dismissedNewModels: input.dismissedNewModels,
            accounts: WITH_NEW_MODEL.accounts.map((section) => ({ ...section, newModels: [] })),
          },
        };
      },
    });
    toggleModelMenu("open");

    fireEvent.click(screen.getByRole("button", { name: "Not now: Claude Opus 5.6", hidden: true }));

    await waitFor(() => {
      expect(document.querySelector(".line--new")).toBeNull();
    });
    const updates = readUpdates(calls);
    expect(updates).toHaveLength(1);
    expect((updates[0]!.body as ModelProfileUpdateInput).dismissedNewModels).toEqual([
      { providerAccountId: FIXTURE_ACCOUNT.id, model: "claude-opus-5-6" },
    ]);
  });

  it("shows a refusal under the lane and keeps the row", async () => {
    const calls = await openDraft([WITH_NEW_MODEL], {
      [`PATCH ${MAIN_PATH}`]: {
        status: 400,
        body: buildErrorBody("validation", "claude-code does not list Claude Opus 5.6."),
      },
    });
    toggleModelMenu("open");

    fireEvent.click(screen.getByRole("button", { name: "Add Claude Opus 5.6", hidden: true }));

    const alert = await screen.findByRole("alert", { hidden: true });
    expect(alert.textContent).toBe(
      "The change was not saved. claude-code does not list Claude Opus 5.6.",
    );
    expect(alert.closest(".pop-sec")).toBe(
      document.querySelector(".line--new")!.closest(".pop-sec"),
    );
    expect(readUpdates(calls)).toHaveLength(1);
  });
});
