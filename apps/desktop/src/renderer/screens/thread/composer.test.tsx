/**
 * Tests the composer against the stubbed controller: the placeholder in each
 * state of the thread, the controls that are drawn but take nothing yet, the
 * lip, the order of the stack above the card, and the element it hands the
 * thread screen to measure.
 */
import { createRef } from "react";
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Session } from "@hercule/contract";
import { SIDEBAR_FIXTURE, THREAD_FIXTURES, type ThreadRecords } from "../../app/testing";
import { ThreadComposer } from "./composer";
import { renderThreadPart } from "./testing";

/** Returns `thread` with `over` applied to its session. */
const changeSession = (thread: ThreadRecords, over: Partial<Session>): ThreadRecords => ({
  ...thread,
  session: { ...thread.session, ...over },
});

/** Returns the composer's message field. */
const readField = (): HTMLTextAreaElement =>
  screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });

/** Returns the text and the tooltip of each part of the lip, in order. */
const readLip = (): readonly (readonly [string | null, string | null])[] =>
  [...document.querySelector(".lip")!.children].map((part) => [
    part.textContent,
    part.getAttribute("title"),
  ]);

describe("the composer", () => {
  it.each([
    ["an idle thread", THREAD_FIXTURES.finished, "Reply…"],
    ["a working thread", THREAD_FIXTURES.running, "Queued until the turn finishes…"],
    [
      "an exited thread that cannot be resumed",
      changeSession(THREAD_FIXTURES.finished, {
        status: "exited",
        resumable: false,
        nativeSessionId: null,
        exitedAt: "2026-09-10T09:04:00.000Z",
      }),
      "This thread can't be resumed: its transcript is gone.",
    ],
  ])("shows %s its placeholder", async (_state, thread, placeholder) => {
    await renderThreadPart(ThreadComposer, { thread });

    expect(readField().placeholder).toBe(placeholder);
  });

  it("draws the card's controls, but takes no text and sends nothing", async () => {
    const user = userEvent.setup();
    const { calls } = await renderThreadPart(ThreadComposer, { thread: THREAD_FIXTURES.finished });
    const sent = calls.length;

    // Read-only rather than disabled, so the browser keeps the book's colours
    // and the field can still take focus.
    const field = readField();
    expect(field.readOnly).toBe(true);
    expect(field.disabled).toBe(false);
    expect(field.getAttribute("aria-disabled")).toBe("true");
    await user.type(field, "Ship it");
    expect(field.value).toBe("");

    for (const name of ["Attach", "Dictate", "Send"]) {
      const button = screen.getByRole("button", { name });
      expect(button.getAttribute("aria-disabled")).toBe("true");
      await user.click(button);
    }
    expect(calls).toHaveLength(sent);
  });

  it("draws the access mode and the model as buttons that open nothing yet", async () => {
    const user = userEvent.setup();
    const { calls } = await renderThreadPart(ThreadComposer, { thread: THREAD_FIXTURES.finished });
    const sent = calls.length;

    // The thread has started, so its access mode is fixed, and the tooltip
    // says how to get another one. The controller offers no provider
    // instance, so the model pill shows the thread's model as its slug.
    const accessMode = screen.getByRole("button", {
      name: "Approval required",
      description: "Create a new thread to change the access mode",
    });
    const model = screen.getByRole("button", { name: "claude-sonnet-5" });
    for (const pick of [accessMode, model]) {
      expect(pick.classList.contains("pick")).toBe(true);
      expect(pick.getAttribute("aria-disabled")).toBe("true");
      await user.click(pick);
    }
    expect(calls).toHaveLength(sent);
  });

  it("draws a main workspace in the lip, then its branch in mono, then the machine", async () => {
    await renderThreadPart(ThreadComposer, { thread: THREAD_FIXTURES.finished });

    const workspaceLocked = "Create a new thread to change the workspace";
    expect(readLip()).toEqual([
      ["Main workspace", workspaceLocked],
      ["main", workspaceLocked],
      ["", null],
      ["moss", "Create a new thread to change the machine"],
    ]);
    expect(document.querySelector(".lip .mono")?.textContent).toBe("main");
    expect(document.querySelector(".lip .faint")).toBeNull();
  });

  it("draws an ephemeral workspace in the lip once, by its branch in mono, with the branch it started from", async () => {
    await renderThreadPart(ThreadComposer, { thread: THREAD_FIXTURES.running });

    expect(readLip().map(([text]) => text)).toEqual(["hercule/thread-3f1 from main", "", "moss"]);
    expect(document.querySelector(".lip .mono")?.textContent).toBe("hercule/thread-3f1");
    expect(document.querySelector(".lip .faint")?.textContent).toBe("from main");
  });

  it("says in the lip that a thread with no project has no workspace", async () => {
    await renderThreadPart(ThreadComposer, { thread: THREAD_FIXTURES.failed });

    expect(readLip()[0]![0]).toBe("No workspace");
    expect(document.querySelector(".lip .mono")).toBeNull();
  });

  it("stacks the queued inputs, then the Request, above the card, without taking the focus", async () => {
    const approval = SIDEBAR_FIXTURE.threads[0]!.openRequest;
    await renderThreadPart(ThreadComposer, {
      thread: changeSession(THREAD_FIXTURES.queued, { openRequest: approval }),
    });

    const stack = document.querySelector(".composer")!;
    expect([...stack.children].map((child) => child.className)).toEqual([
      "queued",
      "queued",
      "dock",
      "composer-card",
      "lip",
    ]);
    expect(screen.getByRole("group", { name: "Run this command?" })).toBeTruthy();
    expect(document.activeElement).toBe(document.body);
  });

  it("hands its ref the stack, whose height the thread screen measures", async () => {
    const stack = createRef<HTMLDivElement>();
    await renderThreadPart(
      ({ sessionId }) => <ThreadComposer sessionId={sessionId} ref={stack} />,
      { thread: THREAD_FIXTURES.finished },
    );

    expect(stack.current?.className).toBe("composer");
  });
});
