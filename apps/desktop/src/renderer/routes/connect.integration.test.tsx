import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ControllerUrlSaveOutcome } from "../../ipc/contract";
import { createFakeBridge, renderApp } from "../app/testing";

/** What the user types: a controller's address, with capitals and a trailing `/`. */
const TYPED_URL = "HTTP://10.0.0.2:4937/";
/** The origin main parses from `TYPED_URL` and checks. */
const CHECKED_ORIGIN = "http://10.0.0.2:4937";

/** Opens the connect screen, types `TYPED_URL` and presses Connect, with `save` as main's answer. */
const connectWith = async (
  save: (url: string) => Promise<ControllerUrlSaveOutcome>,
): Promise<ReturnType<typeof createFakeBridge>> => {
  const user = userEvent.setup();
  const fake = createFakeBridge({ save });
  await renderApp(fake);
  const field = screen.getByRole("textbox", { name: "Controller address" });
  await user.clear(field);
  await user.type(field, TYPED_URL);
  await user.click(screen.getByRole("button", { name: "Connect" }));
  return fake;
};

describe("the connect screen", () => {
  it("offers a controller on this Mac when none is saved", async () => {
    await renderApp(createFakeBridge());
    expect(
      screen.getByRole<HTMLInputElement>("textbox", { name: "Controller address" }).value,
    ).toBe("http://127.0.0.1:4937");
  });

  it("asks main to check and save the address the user typed", async () => {
    const fake = await connectWith(() =>
      Promise.resolve({ _tag: "Saved", origin: CHECKED_ORIGIN }),
    );
    expect(fake.savedUrls).toEqual([TYPED_URL]);
    // Main reloads the window after a save, so the screen shows nothing more.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each<[string, ControllerUrlSaveOutcome, string]>([
    [
      "InvalidUrl",
      { _tag: "InvalidUrl" },
      "Enter the controller's address, such as http://127.0.0.1:4937.",
    ],
    [
      "Unreachable",
      { _tag: "Unreachable", origin: CHECKED_ORIGIN },
      `Could not reach ${CHECKED_ORIGIN}. Check that the controller is running.`,
    ],
    [
      "Redirected",
      { _tag: "Redirected", origin: CHECKED_ORIGIN, targetOrigin: "https://hercule.example" },
      `${CHECKED_ORIGIN} redirects to https://hercule.example. Connect to that address instead.`,
    ],
    [
      "NotController",
      { _tag: "NotController", origin: CHECKED_ORIGIN },
      `${CHECKED_ORIGIN} answered, but it is not a Hercule controller.`,
    ],
    [
      "OriginNotAllowed",
      { _tag: "OriginNotAllowed", origin: CHECKED_ORIGIN },
      `${CHECKED_ORIGIN} does not accept the desktop app yet. Update the controller.`,
    ],
    [
      "PreflightRefused",
      { _tag: "PreflightRefused", origin: CHECKED_ORIGIN, methods: ["DELETE", "PATCH", "PUT"] },
      `${CHECKED_ORIGIN} does not accept the desktop app's DELETE, PATCH, and PUT requests. Update the controller, or check any proxy in front of it.`,
    ],
    [
      "SetupIncomplete",
      { _tag: "SetupIncomplete", origin: CHECKED_ORIGIN },
      "This controller is not set up yet. Finish setup in the browser window that just opened, then connect again.",
    ],
  ])("explains the outcome %s with the origin main checked", async (_tag, outcome, line) => {
    await connectWith(() => Promise.resolve(outcome));
    expect((await screen.findByRole("alert")).textContent).toBe(line);
  });

  it("shows Connecting… while main checks the controller, and keeps focus on the button", async () => {
    let answer: (outcome: ControllerUrlSaveOutcome) => void = () => {};
    await connectWith(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const connect = screen.getByRole("button", { name: "Connecting…" });
    expect(connect.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(connect);
    answer({ _tag: "Unreachable", origin: CHECKED_ORIGIN });
    await waitFor(() => {
      expect(connect.textContent).toBe("Connect");
    });
    expect(connect.hasAttribute("aria-disabled")).toBe(false);
  });

  it("asks main once when Enter is pressed twice", async () => {
    // No delay between the presses, so the second arrives before React renders again.
    const user = userEvent.setup({ delay: null });
    const fake = createFakeBridge({ save: () => new Promise(() => {}) });
    await renderApp(fake);
    await user.keyboard("{Enter}{Enter}");
    expect(fake.savedUrls).toEqual(["http://127.0.0.1:4937"]);
    expect(document.activeElement).toBe(
      screen.getByRole("textbox", { name: "Controller address" }),
    );
  });

  it("logs a save main refuses, and shows no line for it", async () => {
    const refusal = new Error("refused");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await connectWith(() => Promise.reject(refusal));
    await waitFor(() => {
      expect(logged).toHaveBeenCalledWith("Could not save the controller URL:", refusal);
    });
    expect(screen.queryByRole("alert")).toBeNull();
    logged.mockRestore();
  });
});
