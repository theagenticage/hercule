/**
 * Tests the queued inputs against the stubbed controller: one row per input,
 * which one runs next, Steer and Cancel, what a row shows when one of them
 * fails, and the row of an input another session's agent queued.
 */
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Input } from "@hercule/contract";
import {
  buildErrorBody,
  FIXTURE_THREAD_IDS,
  SIDEBAR_FIXTURE,
  THREAD_FIXTURES,
} from "../../app/testing";
import { QueuedInputs } from "./queued-inputs";
import { renderThreadPart } from "./testing";

const { queued } = THREAD_FIXTURES;
const OLDER = queued.inputs[0]!;
const NEWER = queued.inputs[1]!;

/** The path of the session's inputs, and of each input under it. */
const INPUTS = `/api/v1/sessions/${FIXTURE_THREAD_IDS.flaky}/inputs`;

/** Returns the row that shows `input`. */
const readRow = (input: Input): HTMLElement => screen.getByText(input.text).closest(".queued")!;

/** Returns the text of every row, in order. */
const readRows = (): readonly (string | null)[] =>
  [...document.querySelectorAll(".queued-text")].map((text) => text.textContent);

/**
 * Renders the queued fixture thread. The controller lists the inputs in
 * `remaining`, newest first as it does, so a test that steers or cancels one
 * can take it out of the list.
 */
const renderQueue = (
  handlers: Parameters<typeof renderThreadPart>[1]["handlers"] = {},
  remaining: Input[] = [OLDER, NEWER],
) =>
  renderThreadPart(QueuedInputs, {
    thread: queued,
    handlers: {
      [`GET ${INPUTS}`]: () => ({ body: { items: [...remaining].reverse() } }),
      ...handlers,
    },
  });

describe("the queued inputs", () => {
  it("draws one row per input, oldest first, and says the first runs next", async () => {
    await renderQueue();

    expect(readRows()).toEqual([OLDER.text, NEWER.text]);
    expect(within(readRow(OLDER)).getByText("queued · runs next")).toBeTruthy();
    expect(within(readRow(NEWER)).getByText("queued")).toBeTruthy();
  });

  it("draws an input's images as small tiles before its text, read from the controller", async () => {
    const image = {
      id: "01a06d02-7700-7000-8000-0000000000a1",
      name: "screen.png",
      mimeType: "image/png",
      sizeBytes: 4,
    } as const;
    const { calls } = await renderQueue({}, [{ ...OLDER, attachments: [image] }, NEWER]);

    const tile = within(readRow(OLDER)).getByTitle("screen.png");
    expect(tile.className).toBe("queued-image");
    expect(within(readRow(NEWER)).queryByTitle("screen.png")).toBeNull();
    await waitFor(() => {
      expect(calls.map((call) => call.path)).toContain(`/api/v1/attachments/${image.id}/content`);
    });
  });

  it("steers an input into the running turn, then reads the queue again", async () => {
    const user = userEvent.setup();
    const remaining = [OLDER, NEWER];
    const { calls } = await renderQueue(
      {
        [`POST ${INPUTS}/${OLDER.id}/steer`]: () => {
          remaining.shift();
          return { body: { inputId: OLDER.id, result: "steered" } };
        },
      },
      remaining,
    );

    await user.click(within(readRow(OLDER)).getByRole("button", { name: "Steer" }));

    await waitFor(() => {
      expect(readRows()).toEqual([NEWER.text]);
    });
    expect(calls.filter((call) => call.path === INPUTS).map((call) => call.method)).toEqual([
      "GET",
      "GET",
    ]);
    // The input that runs next is now the one that was second.
    expect(within(readRow(NEWER)).getByText("queued · runs next")).toBeTruthy();
  });

  it("cancels an input, then reads the queue again", async () => {
    const user = userEvent.setup();
    const remaining = [OLDER, NEWER];
    await renderQueue(
      {
        [`DELETE ${INPUTS}/${NEWER.id}`]: () => {
          remaining.pop();
          return { body: { ...NEWER, status: "cancelled" } };
        },
      },
      remaining,
    );

    await user.click(within(readRow(NEWER)).getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(readRows()).toEqual([OLDER.text]);
    });
  });

  it("shows in the row why Steer failed, and keeps the input", async () => {
    const user = userEvent.setup();
    await renderQueue({
      [`POST ${INPUTS}/${OLDER.id}/steer`]: {
        status: 409,
        body: buildErrorBody("invalid_state", "The turn has already finished."),
      },
    });

    await user.click(within(readRow(OLDER)).getByRole("button", { name: "Steer" }));

    expect((await within(readRow(OLDER)).findByRole("alert")).textContent).toBe(
      "The turn has already finished.",
    );
    expect(readRows()).toEqual([OLDER.text, NEWER.text]);
  });

  it("shows why an input's last delivery failed", async () => {
    await renderQueue({}, [{ ...OLDER, reason: "The runner went offline." }, NEWER]);

    expect(within(readRow(OLDER)).getByText("The runner went offline.")).toBeTruthy();
  });

  it("offers no Steer or Cancel for an assistant's conversation", async () => {
    await renderThreadPart(QueuedInputs, {
      thread: {
        ...queued,
        session: { ...queued.session, conversationId: "01a06d02-7800-7000-8000-000000000001" },
      },
    });

    expect(readRows()).toEqual([OLDER.text, NEWER.text]);
    expect(screen.queryAllByRole("button")).toEqual([]);
  });
});

describe("an input another session's agent queued", () => {
  /** "Write the retry runbook", whose agent queued the input. */
  const RUNBOOK = SIDEBAR_FIXTURE.threads[0]!;
  const FROM_RUNBOOK: Input = {
    ...OLDER,
    actor: `session:${RUNBOOK.id}`,
    reason: "The runner went offline.",
  };

  /** Renders the queue with the runbook's input first, and the runbook readable. */
  const renderAgentQueue = (
    handlers: Parameters<typeof renderThreadPart>[1]["handlers"] = {},
    remaining: Input[] = [FROM_RUNBOOK, NEWER],
  ) =>
    renderQueue(
      { [`GET /api/v1/sessions/${RUNBOOK.id}`]: { body: RUNBOOK }, ...handlers },
      remaining,
    );

  it("names the agent in place of the clock, linked to its thread", async () => {
    await renderAgentQueue();

    const row = await screen.findByRole("group", {
      name: `Queued message from ${RUNBOOK.title}`,
    });
    expect(row.className).toBe("queued queued--agent");
    const chip = within(row).getByRole("link", { name: RUNBOOK.title });
    expect(chip.getAttribute("href")).toBe(`/threads/${RUNBOOK.id}`);
    expect(row.querySelector(".queued-lead > svg")).toBeNull();
    // The owner's row keeps its clock and is no group.
    expect(readRow(NEWER).className).toBe("queued");
    expect(readRow(NEWER).querySelector(".queued-lead > svg")).not.toBeNull();
    expect(readRow(NEWER).getAttribute("role")).toBeNull();
  });

  it("puts a note in the text's column, under the text rather than the chip", async () => {
    await renderAgentQueue();

    const row = await screen.findByRole("group", {
      name: `Queued message from ${RUNBOOK.title}`,
    });
    const note = within(row).getByText("The runner went offline.");
    expect(note.parentElement).toBe(row);
    expect(note.classList.contains("queued-note")).toBe(true);
  });

  it("steers and cancels the agent's input as the owner's", async () => {
    const user = userEvent.setup();
    const remaining = [FROM_RUNBOOK, NEWER];
    const { calls } = await renderAgentQueue(
      {
        [`POST ${INPUTS}/${OLDER.id}/steer`]: () => {
          remaining.shift();
          return { body: { inputId: OLDER.id, result: "steered" } };
        },
      },
      remaining,
    );
    const row = await screen.findByRole("group", {
      name: `Queued message from ${RUNBOOK.title}`,
    });

    expect(within(row).getByRole("button", { name: "Cancel" })).toBeTruthy();
    await user.click(within(row).getByRole("button", { name: "Steer" }));

    await waitFor(() => {
      expect(readRows()).toEqual([NEWER.text]);
    });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toContain(
      `POST ${INPUTS}/${OLDER.id}/steer`,
    );
  });

  it("cancels the agent's input", async () => {
    const user = userEvent.setup();
    const remaining = [FROM_RUNBOOK, NEWER];
    await renderAgentQueue(
      {
        [`DELETE ${INPUTS}/${OLDER.id}`]: () => {
          remaining.shift();
          return { body: { ...FROM_RUNBOOK, status: "cancelled" } };
        },
      },
      remaining,
    );
    const row = await screen.findByRole("group", {
      name: `Queued message from ${RUNBOOK.title}`,
    });

    await user.click(within(row).getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(readRows()).toEqual([NEWER.text]);
    });
  });
});
