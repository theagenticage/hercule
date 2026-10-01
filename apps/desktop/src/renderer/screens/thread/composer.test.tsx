/**
 * Tests the composer against the stubbed controller: the placeholder in each
 * state of the thread, sending with ⏎ and the menu's Send, Stop, the picks a message carries,
 * the text and a failed send kept per thread, the shrunk composer, the lip, and the order of
 * the stack above the card.
 *
 * The menus are the browser's popovers, which jsdom does not implement, so
 * their content is tested on its own and opening them in the e2e tests. Here
 * a pick is written into the pending submissions, where a menu writes it.
 *
 * A test that checks a key sends nothing sends a message afterwards, and
 * checks that the controller received only that one. So a key that wrongly
 * sent a message shows up however late its request would have arrived.
 */
import { createRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Session } from "@hercule/contract";
import {
  buildErrorBody,
  CONTROLLER_URL,
  FIXTURE_INSTANCE,
  holdAnswer,
  SIDEBAR_FIXTURE,
  THREAD_FIXTURES,
  type Answer,
  type Call,
  type Handler,
  type ThreadRecords,
} from "../../app/testing";
import { readRecentModels } from "../../app/recent-models";
import { ThreadComposer } from "./composer";
import { renderThreadPart } from "./testing";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Returns `thread` with `over` applied to its session. */
const changeSession = (thread: ThreadRecords, over: Partial<Session>): ThreadRecords => ({
  ...thread,
  session: { ...thread.session, ...over },
});

/** The idle fixture thread, which takes a message and opens a turn with it. */
const IDLE = THREAD_FIXTURES.finished;

/** The fixture thread whose turn is running. */
const BUSY = THREAD_FIXTURES.running;

/** Returns the operation that sends `thread` a message. */
const buildInputOperation = (thread: ThreadRecords): string =>
  `POST /api/v1/sessions/${thread.session.id}/input`;

/** Returns the operation that interrupts `thread`'s turn. */
const buildInterruptOperation = (thread: ThreadRecords): string =>
  `POST /api/v1/sessions/${thread.session.id}/interrupt`;

/** The controller's answer to a message it accepts. */
const OPENED: Answer = {
  body: { inputId: "01a06d02-7700-7000-8000-000000000099", result: "opened" },
};

/** What the composer told the thread screen, oldest first. */
interface ScreenReports {
  /** Each `onFocusChange`. */
  readonly focus: boolean[];
  /** How many times the composer scrolled the transcript to its bottom. */
  scrolls: number;
}

/**
 * Renders the composer for `thread`, as the thread screen does, and returns
 * the calls, the query cache, the pending submissions, and what the composer
 * reported to the screen.
 *
 * The controller offers `FIXTURE_INSTANCE`, and accepts every message and
 * interrupt unless `handlers` say otherwise.
 */
const renderComposer = async (
  thread: ThreadRecords,
  {
    shrunk = false,
    handlers = {},
  }: { readonly shrunk?: boolean; readonly handlers?: Readonly<Record<string, Handler>> } = {},
) => {
  const reports: ScreenReports = { focus: [], scrolls: 0 };
  const rendered = await renderThreadPart(
    ({ sessionId }) => (
      <ThreadComposer
        sessionId={sessionId}
        shrunk={shrunk}
        onFocusChange={(focused) => {
          reports.focus.push(focused);
        }}
        scrollTranscriptToBottom={() => {
          reports.scrolls += 1;
        }}
      />
    ),
    {
      thread,
      handlers: {
        "GET /api/v1/providers": { body: [FIXTURE_INSTANCE] },
        [buildInputOperation(thread)]: OPENED,
        [buildInterruptOperation(thread)]: { body: thread.session },
        ...handlers,
      },
    },
  );
  return { ...rendered, reports };
};

/** Returns the bodies of the messages the composer sent `thread`, oldest first. */
const readSent = (calls: readonly Call[], thread: ThreadRecords): readonly unknown[] =>
  calls
    .filter((call) => `${call.method} ${call.path}` === buildInputOperation(thread))
    .map((call) => call.body);

/** Returns how many times the composer interrupted `thread`'s turn. */
const countInterrupts = (calls: readonly Call[], thread: ThreadRecords): number =>
  calls.filter((call) => `${call.method} ${call.path}` === buildInterruptOperation(thread)).length;

/** Returns the composer's message field. */
const readField = (): HTMLTextAreaElement =>
  screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });

/** Returns the text and the tooltip of each part of the lip, in order. */
const readLip = (): readonly (readonly [string | null, string | null])[] =>
  [...document.querySelector(".lip")!.children].map((part) => [
    part.textContent,
    part.getAttribute("title"),
  ]);

/**
 * Renders the composer for `thread` with a "Leave" button beside it, which
 * unmounts the composer as leaving the thread does, and mounts it again on
 * the next click, as coming back does. The controller holds each message
 * until the test calls the returned `answer`.
 */
const renderLeavableComposer = async (thread: ThreadRecords) => {
  const held = holdAnswer();
  const rendered = await renderThreadPart(
    function LeavableComposer({ sessionId }) {
      const [shown, setShown] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setShown(!shown)}>
            Leave
          </button>
          {shown ? (
            <ThreadComposer
              sessionId={sessionId}
              shrunk={false}
              onFocusChange={() => {}}
              scrollTranscriptToBottom={() => {}}
            />
          ) : null}
        </>
      );
    },
    {
      thread,
      handlers: {
        "GET /api/v1/providers": { body: [FIXTURE_INSTANCE] },
        [buildInputOperation(thread)]: held.handler,
      },
    },
  );
  return { ...rendered, answer: held.answer };
};

describe("the composer", () => {
  it.each([
    ["an idle thread", IDLE, "Reply…"],
    ["a working thread", BUSY, "Queued until the turn finishes…"],
    [
      "an exited thread that cannot be resumed",
      changeSession(IDLE, {
        status: "exited",
        resumable: false,
        nativeSessionId: null,
        exitedAt: "2026-09-10T09:04:00.000Z",
      }),
      "This thread can't be resumed: its transcript is gone.",
    ],
  ])("shows %s its placeholder", async (_state, thread, placeholder) => {
    await renderComposer(thread);

    expect(readField().placeholder).toBe(placeholder);
  });

  it("sends the message with ⏎, then empties the field and scrolls the transcript to its bottom", async () => {
    const user = userEvent.setup();
    const { calls, reports } = await renderComposer(IDLE);
    const send = screen.getByRole("button", { name: "Send" });
    expect(send.className).toBe("send send--off");

    await user.type(readField(), "Ship it");
    expect(send.className).toBe("send");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(readField().value).toBe("");
    });
    expect(readSent(calls, IDLE)).toEqual([{ text: "Ship it" }]);
    expect(reports.scrolls).toBe(1);
    expect(send.className).toBe("send send--off");
  });

  it("sends the message with Send", async () => {
    const user = userEvent.setup();
    const { calls } = await renderComposer(IDLE);

    await user.type(readField(), "Ship it");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(readSent(calls, IDLE)).toEqual([{ text: "Ship it" }]);
    });
  });

  it("sends the message with Thread > Send in the menu, and nothing when the field is blank", async () => {
    const user = userEvent.setup();
    const { calls, sendMenuCommand } = await renderComposer(IDLE);

    sendMenuCommand("send");
    await user.type(readField(), "Ship it");
    sendMenuCommand("send");

    await waitFor(() => {
      expect(readField().value).toBe("");
    });
    expect(readSent(calls, IDLE)).toEqual([{ text: "Ship it" }]);
  });

  it("starts a new line with ⇧⏎, and sends nothing for blank text or the ⏎ that ends a composition", async () => {
    const user = userEvent.setup();
    const { calls } = await renderComposer(IDLE);
    const field = readField();

    await user.type(field, "   {Enter}");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.clear(field);
    await user.type(field, "First line{Shift>}{Enter}{/Shift}second line");
    expect(field.value).toBe("First line\nsecond line");
    fireEvent.keyDown(field, { key: "Enter", isComposing: true });
    fireEvent.keyDown(field, { key: "Enter", keyCode: 229 });

    await user.type(field, ".{Enter}");
    await waitFor(() => {
      expect(readField().value).toBe("");
    });
    expect(readSent(calls, IDLE)).toEqual([{ text: "First line\nsecond line." }]);
  });

  it("sends once however often ⏎ is pressed, and keeps what is typed meanwhile for the next message", async () => {
    const user = userEvent.setup();
    const held = holdAnswer();
    const { calls } = await renderComposer(IDLE, {
      handlers: { [buildInputOperation(IDLE)]: held.handler },
    });

    await user.type(readField(), "First");
    // Both in one task, before React renders the send as running.
    fireEvent.keyDown(readField(), { key: "Enter" });
    fireEvent.keyDown(readField(), { key: "Enter" });
    await user.keyboard("{Enter}");
    await user.type(readField(), ", and more");
    await user.keyboard("{Enter}");
    held.answer(OPENED);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Send" }).className).toBe("send");
    });
    expect(readField().value).toBe("First, and more");
    expect(readSent(calls, IDLE)).toEqual([{ text: "First" }]);
  });

  it("shows why the controller refused a message, keeps its text, and sends it again", async () => {
    const user = userEvent.setup();
    const answers: Answer[] = [
      { status: 409, body: buildErrorBody("invalid_state", "The session has exited.") },
      OPENED,
    ];
    const { calls } = await renderComposer(IDLE, {
      handlers: { [buildInputOperation(IDLE)]: () => answers.shift()! },
    });

    await user.type(readField(), "Ship it{Enter}");

    expect((await screen.findByRole("alert")).textContent).toBe("The session has exited.");
    expect(readField().value).toBe("Ship it");
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(screen.queryByRole("alert")).toBeNull();
    });
    expect(readSent(calls, IDLE)).toEqual([{ text: "Ship it" }, { text: "Ship it" }]);
  });

  it("shows why a message failed when the user left while it was on its way and came back", async () => {
    const user = userEvent.setup();
    const { answer } = await renderLeavableComposer(IDLE);
    await user.type(readField(), "Ship it{Enter}");

    await user.click(screen.getByRole("button", { name: "Leave" }));
    answer({ status: 409, body: buildErrorBody("invalid_state", "The session has exited.") });
    await user.click(screen.getByRole("button", { name: "Leave" }));

    expect((await screen.findByRole("alert")).textContent).toBe("The session has exited.");
    expect(readField().value).toBe("Ship it");
  });

  it("does not send a message twice when the user leaves and comes back while it is on its way", async () => {
    const user = userEvent.setup();
    const { answer, calls } = await renderLeavableComposer(IDLE);
    await user.type(readField(), "Ship it{Enter}");

    await user.click(screen.getByRole("button", { name: "Leave" }));
    await user.click(screen.getByRole("button", { name: "Leave" }));
    expect(screen.getByRole("button", { name: "Send" }).getAttribute("aria-disabled")).toBe("true");
    await user.type(readField(), "{Enter}");
    answer(OPENED);

    await waitFor(() => {
      expect(readField().value).toBe("");
    });
    expect(readSent(calls, IDLE)).toEqual([{ text: "Ship it" }]);
  });

  it("draws Stop in Send's place while a turn runs, which interrupts the turn once, and ⏎ still sends", async () => {
    const user = userEvent.setup();
    const held = holdAnswer();
    const { calls } = await renderComposer(BUSY, {
      handlers: { [buildInterruptOperation(BUSY)]: held.handler },
    });
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    const stop = screen.getByRole("button", { name: "Stop" });

    await user.click(stop);
    await waitFor(() => {
      expect(stop.getAttribute("aria-disabled")).toBe("true");
    });
    await user.click(stop);
    held.answer({ body: BUSY.session });
    await waitFor(() => {
      expect(stop.getAttribute("aria-disabled")).toBeNull();
    });
    expect(countInterrupts(calls, BUSY)).toBe(1);

    await user.type(readField(), "Also check the retry test.{Enter}");
    await waitFor(() => {
      expect(readSent(calls, BUSY)).toEqual([{ text: "Also check the retry test." }]);
    });
  });

  it("draws Stop while the turn waits on a question, the one way to turn the question down", async () => {
    const user = userEvent.setup();
    const asked = changeSession(THREAD_FIXTURES.waiting, {
      openRequest: {
        requestId: "req-2",
        itemId: "tool-2",
        kind: "question",
        detail: {
          questions: [
            { question: "Which storage?", header: "Storage", options: [], multiSelect: false },
          ],
        },
      },
    });
    const { calls } = await renderComposer(asked);

    await user.click(screen.getByRole("button", { name: "Stop" }));

    await waitFor(() => {
      expect(countInterrupts(calls, asked)).toBe(1);
    });
  });

  it("shows why the controller refused to stop the turn", async () => {
    const user = userEvent.setup();
    await renderComposer(BUSY, {
      handlers: {
        [buildInterruptOperation(BUSY)]: {
          status: 409,
          body: buildErrorBody("invalid_state", "The turn has already ended."),
        },
      },
    });

    await user.click(screen.getByRole("button", { name: "Stop" }));

    expect((await screen.findByRole("alert")).textContent).toBe("The turn has already ended.");
  });

  it("takes no text on a thread that cannot be resumed, and opens no menu", async () => {
    const user = userEvent.setup();
    const exited = changeSession(IDLE, {
      status: "exited",
      resumable: false,
      nativeSessionId: null,
      exitedAt: "2026-09-10T09:04:00.000Z",
    });
    const { calls } = await renderComposer(exited);
    const sent = calls.length;

    // Read-only rather than disabled, so the browser keeps the book's colours
    // and the field can still take focus.
    const field = readField();
    expect(field.readOnly).toBe(true);
    expect(field.disabled).toBe(false);
    expect(field.getAttribute("aria-disabled")).toBe("true");
    await user.type(field, "Ship it{Enter}");
    expect(field.value).toBe("");

    // The model options trigger shows the options in use: a medium effort.
    for (const name of ["Medium", "Claude Sonnet 5"]) {
      const trigger = screen.getByRole("button", { name });
      expect(trigger.getAttribute("aria-disabled")).toBe("true");
      expect(trigger.hasAttribute("popovertarget")).toBe(false);
    }
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(calls).toHaveLength(sent);
  });

  it("draws Attach and Dictate, which do nothing yet", async () => {
    const user = userEvent.setup();
    const { calls } = await renderComposer(IDLE);
    const sent = calls.length;

    for (const name of ["Attach", "Dictate"]) {
      const button = screen.getByRole("button", { name });
      expect(button.getAttribute("aria-disabled")).toBe("true");
      await user.click(button);
    }
    expect(calls).toHaveLength(sent);
  });

  it("draws the fixed access mode as text, and the model and its options as menus", async () => {
    await renderComposer(IDLE);

    // The thread has started, so its access mode is fixed, and the tooltip
    // says how to get another one.
    const accessMode = screen.getByTitle("Create a new thread to change the access mode");
    expect(accessMode.tagName).toBe("SPAN");
    expect(accessMode.textContent).toBe("Approval required");
    for (const [name, menu] of [
      ["Medium", "Model options"],
      ["Claude Sonnet 5", "Model"],
    ] as const) {
      const trigger = screen.getByRole("button", { name });
      expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      // A closed menu is hidden, and a hidden element has no accessible
      // name, so the menu is found by the id its trigger targets.
      const target = document.getElementById(trigger.getAttribute("popovertarget")!);
      expect(target?.getAttribute("role")).toBe("dialog");
      expect(target?.getAttribute("aria-label")).toBe(menu);
    }
    expect(document.querySelector(".composer-note")?.textContent).toBe("");
  });

  it("shows a picked model and option at once, sends them with the next message, and remembers the model", async () => {
    const user = userEvent.setup();
    const { calls, pendingSubmissions } = await renderComposer(IDLE);
    const sessionId = IDLE.session.id;

    act(() => {
      pendingSubmissions.writePicks(sessionId, {
        model: "claude-opus-5",
        options: { effort: "high" },
      });
    });
    expect(screen.getByRole("button", { name: "Claude Opus 5" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "High" })).toBeTruthy();
    expect(document.querySelector(".composer-note")?.textContent).toBe(
      "model change applies on send",
    );

    await user.type(readField(), "Think harder{Enter}");
    await waitFor(() => {
      expect(pendingSubmissions.read(sessionId).picks).toEqual({});
    });
    expect(readSent(calls, IDLE)).toEqual([
      { text: "Think harder", model: "claude-opus-5", options: { effort: "high" } },
    ]);
    expect(document.querySelector(".composer-note")?.textContent).toBe("");
    expect(readRecentModels(CONTROLLER_URL)).toEqual([
      { instanceId: FIXTURE_INSTANCE.id, model: "claude-opus-5" },
    ]);
  });

  it("keeps the thread's unsent text in the pending submissions, so it outlives the composer", async () => {
    const user = userEvent.setup();
    const { pendingSubmissions } = await renderComposer(IDLE);
    const sessionId = IDLE.session.id;

    await user.type(readField(), "Half a thought");
    expect(pendingSubmissions.read(sessionId).message).toEqual({ text: "Half a thought" });

    act(() => {
      pendingSubmissions.writeText(sessionId, "Written elsewhere");
    });
    expect(readField().value).toBe("Written elsewhere");
  });

  it("draws a main workspace in the lip, then its branch in the UI face, then the machine", async () => {
    await renderComposer(IDLE);

    const workspaceLocked = "Create a new thread to change the workspace";
    expect(readLip()).toEqual([
      ["Main workspace", workspaceLocked],
      ["main", workspaceLocked],
      ["", null],
      ["moss", "Create a new thread to change the machine"],
    ]);
    // Monospace is kept for code, so a branch is never a `code` element.
    expect(document.querySelector(".lip code")).toBeNull();
    expect(document.querySelector(".lip .faint")).toBeNull();
  });

  it("draws an ephemeral workspace in the lip once, by its branch in the UI face, with the branch it started from", async () => {
    await renderComposer(BUSY);

    expect(readLip().map(([text]) => text)).toEqual(["hercule/thread-3f1 from main", "", "moss"]);
    expect(document.querySelector(".lip code")).toBeNull();
    expect(document.querySelector(".lip .faint")?.textContent).toBe("from main");
  });

  it("says in the lip that a thread with no project has no workspace", async () => {
    await renderComposer(THREAD_FIXTURES.failed);

    // The spacer follows at once: there is no branch to draw.
    expect(
      readLip()
        .map(([text]) => text)
        .slice(0, 2),
    ).toEqual(["No workspace", ""]);
  });

  it("stacks the queued inputs, then the Request, above the card, without taking the focus", async () => {
    const approval = SIDEBAR_FIXTURE.threads[0]!.openRequest;
    await renderComposer(changeSession(THREAD_FIXTURES.queued, { openRequest: approval }));

    const stack = document.querySelector(".composer")!;
    expect([...stack.children].map((child) => child.className)).toEqual([
      "fold",
      "dock",
      "composer-card",
      "fold",
    ]);
    expect([...stack.firstElementChild!.children].map((child) => child.className)).toEqual([
      "queued",
      "queued",
    ]);
    expect(screen.getByRole("group", { name: "Run this command?" })).toBeTruthy();
    expect(document.activeElement).toBe(document.body);
  });

  it("hands its ref the stack, whose height the thread screen measures", async () => {
    const stack = createRef<HTMLDivElement>();
    await renderThreadPart(
      ({ sessionId }) => (
        <ThreadComposer
          sessionId={sessionId}
          shrunk={false}
          onFocusChange={() => {}}
          scrollTranscriptToBottom={() => {}}
          ref={stack}
        />
      ),
      { thread: IDLE },
    );

    expect(stack.current?.className).toBe("composer");
  });
});

describe("the shrunk composer", () => {
  /** The waiting fixture thread, whose Request `dock-mini` answers. */
  const WAITING = THREAD_FIXTURES.waiting;

  /** The operation `dock-mini` answers the Request with. */
  const RESPOND = `POST /api/v1/sessions/${WAITING.session.id}/respond-to-approval-request`;

  it("keeps only the field and the Request's one line, with its answers", async () => {
    await renderComposer(WAITING, {
      shrunk: true,
      handlers: { [RESPOND]: { body: WAITING.session } },
    });

    expect(document.querySelector(".composer")?.className).toBe("composer is-scrolled");
    const mini = document.querySelector<HTMLElement>(".dock-mini")!;
    expect(mini.textContent).toBe("Run git push?AllowDeny");
    expect(
      within(mini)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Allow", "Deny"]);
  });

  it("answers the Request from dock-mini without expanding, and expands on a click anywhere else", async () => {
    const user = userEvent.setup();
    // jsdom reports no focus in the document while an element loses it,
    // where a browser reports whether the window has it.
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const { calls, reports } = await renderComposer(WAITING, {
      shrunk: true,
      handlers: { [RESPOND]: { body: WAITING.session } },
    });
    const mini = document.querySelector<HTMLElement>(".dock-mini")!;

    await user.click(within(mini).getByRole("button", { name: "Allow" }));
    await waitFor(() => {
      expect(
        calls.filter((call) => `${call.method} ${call.path}` === RESPOND).map((call) => call.body),
      ).toEqual([{ requestId: "req-1", decision: "allow" }]);
    });
    expect(reports).toEqual({ focus: [false], scrolls: 0 });

    await user.click(mini.querySelector(".dock-mini-q")!);
    expect(document.activeElement).toBe(readField());
    expect(reports.scrolls).toBe(1);
    expect(reports.focus.at(-1)).toBe(true);
  });

  it("reports focus in the composer, and none when the focus leaves it", async () => {
    const user = userEvent.setup();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const { reports } = await renderComposer(IDLE);

    await user.click(readField());
    expect(reports.focus).toEqual([true]);
    // Moving within the composer reports the blur and the focus, both in it.
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Attach" }));
    expect(reports.focus).toEqual([true, true, true]);
    act(() => {
      (document.activeElement as HTMLElement).blur();
    });
    expect(reports.focus).toEqual([true, true, true, false]);
  });

  it("keeps its size while the window is away", async () => {
    const user = userEvent.setup();
    const { reports } = await renderComposer(IDLE);
    await user.click(readField());

    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    act(() => {
      readField().blur();
    });

    expect(reports.focus).toEqual([true]);
  });
});
