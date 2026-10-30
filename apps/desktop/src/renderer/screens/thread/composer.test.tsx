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
import type { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { findResumeBlockedReason, queryKeys, TYPING_PAUSE_MS } from "@hercule/client-core";
import type {
  Attachment,
  ProviderInstance,
  Session,
  SessionRequest,
  SessionSkill,
} from "@hercule/contract";
import {
  buildErrorBody,
  CONTROLLER_URL,
  FIXTURE_INSTANCE,
  FIXTURE_SUBAGENT,
  holdAnswer,
  readFieldPlaceholder,
  readFieldText,
  SIDEBAR_FIXTURE,
  THREAD_FIXTURES,
  type Answer,
  type Call,
  type Handler,
  type ThreadRecords,
} from "../../app/testing";
import { readRecentModels } from "../../app/recent-models";
import { useRequestDraft } from "../../app/request-drafts";
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

/** The operation that uploads an image. */
const UPLOAD_OPERATION = "POST /api/v1/attachments";

/** The image the controller stores for "screen.png". */
const SCREEN_ATTACHMENT: Attachment = {
  id: "01a06d02-7700-7000-8000-0000000000a1",
  name: "screen.png",
  mimeType: "image/png",
  sizeBytes: 4,
};

/** `FIXTURE_INSTANCE` with models that take no images. */
const WITHOUT_IMAGES: ProviderInstance = {
  ...FIXTURE_INSTANCE,
  snapshots: FIXTURE_INSTANCE.snapshots.map((snapshot) => ({
    ...snapshot,
    models: snapshot.models.map((model) => ({ ...model, imageInput: null })),
  })),
};

/** Returns a small PNG file named `name`. */
const buildImage = (name: string): File =>
  new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: "image/png" });

/** Returns the card's hidden file picker. */
const readPicker = (): HTMLInputElement => document.querySelector("input[type=file]")!;

/** Returns the line in the composer's notice slot, or "" when there is none. */
const readNotice = (): string => document.querySelector(".composer-notice")?.textContent ?? "";

/** What the composer told the thread screen, oldest first. */
interface ScreenReports {
  /** Each `onFocusChange`. */
  readonly focus: boolean[];
  /** How many times the composer scrolled the transcript to its bottom. */
  scrolls: number;
}

/** Returns the requests that read the skills of `thread`. */
const readSkillReads = (calls: readonly Call[], thread: ThreadRecords): readonly Call[] =>
  calls.filter(
    (call) => call.method === "GET" && call.path === `/api/v1/sessions/${thread.session.id}/skills`,
  );

/**
 * Renders the composer for `thread`, as the thread screen does, and returns
 * the calls, the query cache, the pending submissions, and what the composer
 * reported to the screen.
 *
 * The controller offers `FIXTURE_INSTANCE`, and accepts every message and
 * interrupt unless `handlers` say otherwise.
 *
 * A thread that takes input makes the composer read its skills when it mounts.
 * This waits for that request, so a test that counts `calls` afterwards does
 * not see it arrive late.
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
  if (findResumeBlockedReason(thread.session) === null) {
    await waitFor(() => {
      expect(readSkillReads(rendered.calls, thread)).not.toHaveLength(0);
    });
  }
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
const readField = (): HTMLElement => screen.getByRole("textbox", { name: "Message" });

/** Returns the text in the composer's message field. */
const readText = (): string => readFieldText(readField());

/** Returns the text and the tooltip of each part of the lip, in order. */
const readLip = (): readonly (readonly [string | null, string | null])[] =>
  [...document.querySelector(".lip")!.children].map((part) => [
    part.textContent,
    part.getAttribute("title") ?? part.querySelector("[title]")?.getAttribute("title") ?? null,
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

/** A button that unfolds the async question `req-2`, as the dock's Answer button does. */
function UnfoldButton({ sessionId }: { readonly sessionId: string }) {
  const [, changeDraft] = useRequestDraft(sessionId, "req-2");
  return (
    <button
      type="button"
      onClick={() => {
        changeDraft((draft) => ({ ...draft, unfolded: true }));
      }}
    >
      Unfold
    </button>
  );
}

/** A button that shows the question at `index` of `req-2`, as the dock's own Previous and Next do. */
function ShowQuestionButton({
  sessionId,
  index,
}: {
  readonly sessionId: string;
  readonly index: number;
}) {
  const [, changeDraft] = useRequestDraft(sessionId, "req-2");
  return (
    <button
      type="button"
      onClick={() => {
        changeDraft((draft) => ({ ...draft, shownQuestionIndex: index }));
      }}
    >
      {`Show question ${String(index + 1)}`}
    </button>
  );
}

/**
 * Has the composer read the session again, as it does after a push from the
 * controller, and waits until the new Requests are drawn. The query library
 * hands a result to the components on a timer, so the wait covers one.
 */
const refreshSession = async (queryClient: QueryClient, sessionId: string): Promise<void> => {
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.session(sessionId) });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
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

    expect(readFieldPlaceholder(readField())).toBe(placeholder);
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
      expect(readText()).toBe("");
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
      expect(readText()).toBe("");
    });
    expect(readSent(calls, IDLE)).toEqual([{ text: "Ship it" }]);
  });

  it("starts a new line with ⇧⏎, and sends nothing for blank text", async () => {
    const user = userEvent.setup();
    const { calls } = await renderComposer(IDLE);
    const field = readField();

    await user.type(field, "   {Enter}");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.click(field);
    await user.keyboard("{Meta>}a{/Meta}{Backspace}");
    await user.type(field, "First line{Shift>}{Enter}{/Shift}second line");
    expect(readFieldText(field)).toBe("First line\nsecond line");

    await user.type(field, ".{Enter}");
    await waitFor(() => {
      expect(readText()).toBe("");
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
    expect(readText()).toBe("First, and more");
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
    expect(readText()).toBe("Ship it");
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
    expect(readText()).toBe("Ship it");
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
      expect(readText()).toBe("");
    });
    expect(readSent(calls, IDLE)).toEqual([{ text: "Ship it" }]);
  });

  it("draws Stop in Send's place while a turn runs, which stops everything once, and ⏎ still sends", async () => {
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
    // Without a subagent named, the interrupt stops the turn and every subagent.
    expect(
      calls.find((call) => `${call.method} ${call.path}` === buildInterruptOperation(BUSY))?.body,
    ).toEqual({});

    await user.type(readField(), "Also check the retry test.{Enter}");
    await waitFor(() => {
      expect(readSent(calls, BUSY)).toEqual([{ text: "Also check the retry test." }]);
    });
  });

  it("draws Stop while the turn waits on a question, the one way to turn the question down", async () => {
    const user = userEvent.setup();
    const asked = changeSession(THREAD_FIXTURES.waiting, {
      openRequests: [
        {
          requestId: "req-2",
          itemId: "tool-2",
          kind: "question",
          detail: {
            questions: [
              { question: "Which storage?", header: "Storage", options: [], multiSelect: false },
            ],
          },
        },
      ],
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

    // Not editable rather than disabled, so the browser keeps the book's
    // colours and the field can still take focus.
    const field = readField();
    expect(field.getAttribute("contenteditable")).toBe("false");
    expect(field.tabIndex).toBe(0);
    expect(field.getAttribute("aria-disabled")).toBe("true");
    await user.type(field, "Ship it{Enter}");
    expect(readFieldText(field)).toBe("");

    // The model options trigger shows the options in use: a medium effort.
    for (const name of ["Medium", "Claude Sonnet 5"]) {
      const trigger = screen.getByRole("button", { name });
      expect(trigger.getAttribute("aria-disabled")).toBe("true");
      expect(trigger.hasAttribute("popovertarget")).toBe(false);
    }
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(calls).toHaveLength(sent);
  });

  it("draws Dictate, which does nothing yet, and Attach, which takes images", async () => {
    const user = userEvent.setup();
    const { calls } = await renderComposer(IDLE);
    const sent = calls.length;

    const dictate = screen.getByRole("button", { name: "Dictate" });
    expect(dictate.getAttribute("aria-disabled")).toBe("true");
    await user.click(dictate);
    expect(calls).toHaveLength(sent);
    expect(screen.getByRole("button", { name: "Attach" }).hasAttribute("aria-disabled")).toBe(
      false,
    );
  });

  it("uploads a picked image, holds the send until it is uploaded, then sends it alone", async () => {
    const user = userEvent.setup();
    const held = holdAnswer();
    const { calls } = await renderComposer(IDLE, {
      handlers: { [UPLOAD_OPERATION]: held.handler },
    });

    await user.upload(readPicker(), buildImage("screen.png"));
    const tile = await screen.findByTitle(/^screen\.png/);
    expect(tile.textContent).toContain("Uploading…");
    const upload = calls.find((call) => `${call.method} ${call.path}` === UPLOAD_OPERATION);
    expect(upload?.search).toBe("?name=screen.png");
    expect(readNotice()).toBe("Wait for the image to finish uploading.");
    const send = screen.getByRole("button", { name: "Send" });
    expect(send.className).toBe("send send--off");

    await act(async () => {
      held.answer({ status: 201, body: SCREEN_ATTACHMENT });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(tile.textContent).not.toContain("Uploading…");
    });
    expect(readNotice()).toBe("");

    await user.click(send);
    await waitFor(() => {
      expect(readSent(calls, IDLE)).toHaveLength(1);
    });
    expect(readSent(calls, IDLE)[0]).toMatchObject({ attachments: [SCREEN_ATTACHMENT.id] });
    await waitFor(() => {
      expect(screen.queryByTitle(/^screen\.png/)).toBeNull();
    });
  });

  it("marks a failed upload, and retries it", async () => {
    const user = userEvent.setup();
    let attempts = 0;
    await renderComposer(IDLE, {
      handlers: {
        [UPLOAD_OPERATION]: () => {
          attempts += 1;
          return attempts === 1
            ? { status: 500, body: buildErrorBody("internal", "The disk is full.") }
            : { status: 201, body: SCREEN_ATTACHMENT };
        },
      },
    });

    await user.upload(readPicker(), buildImage("screen.png"));
    const tile = await screen.findByTitle(/^screen\.png/);
    await waitFor(() => {
      expect(tile.getAttribute("data-status")).toBe("failed");
    });
    expect(readNotice()).toBe("An image failed to upload. Retry it or remove it.");

    await user.click(screen.getByRole("button", { name: "Retry upload for screen.png" }));
    await waitFor(() => {
      expect(tile.getAttribute("data-status")).toBe("uploaded");
    });
    expect(attempts).toBe(2);
    expect(readNotice()).toBe("");
  });

  it("marks the images a send was refused for as expired, and keeps them on the shelf", async () => {
    const user = userEvent.setup();
    const { calls } = await renderComposer(IDLE, {
      handlers: {
        [UPLOAD_OPERATION]: { status: 201, body: SCREEN_ATTACHMENT },
        [buildInputOperation(IDLE)]: {
          status: 400,
          body: {
            error: {
              code: "validation",
              message: "screen.png expired; attach it again.",
              details: {
                issues: [{ path: ["attachments", "0"], message: "screen.png expired" }],
              },
            },
          },
        },
      },
    });

    await user.upload(readPicker(), buildImage("screen.png"));
    const tile = await screen.findByTitle(/^screen\.png/);
    await waitFor(() => {
      expect(tile.getAttribute("data-status")).toBe("uploaded");
    });
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(tile.getAttribute("data-status")).toBe("expired");
    });
    expect(readSent(calls, IDLE)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Send" }).className).toBe("send send--off");
  });

  it("keeps Attach off for a model that takes no images, and holds the images already attached", async () => {
    const user = userEvent.setup();
    const { calls, pendingSubmissions } = await renderComposer(IDLE, {
      handlers: { "GET /api/v1/providers": { body: [WITHOUT_IMAGES] } },
    });
    const sent = calls.length;

    const attach = screen.getByRole("button", { name: "Attach" });
    expect(attach.getAttribute("aria-disabled")).toBe("true");
    expect(attach.getAttribute("title")).toBe("Claude Sonnet 5 does not accept images");

    act(() => {
      pendingSubmissions.updateAttachments(IDLE.session.id, () => [
        {
          key: "image-kept",
          name: "screen.png",
          sizeBytes: 4,
          file: buildImage("screen.png"),
          status: "uploaded",
          attachment: SCREEN_ATTACHMENT,
        },
      ]);
    });
    const tile = await screen.findByTitle(/^screen\.png/);
    expect(tile.textContent).toContain("Unsupported");
    expect(readNotice()).toBe(
      "Claude Sonnet 5 does not accept images. Remove the image or pick a model that accepts them.",
    );
    await user.type(readField(), "Look{Enter}");
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

  it("remembers the model a message was sent with, and keeps a model picked while it was on its way", async () => {
    const user = userEvent.setup();
    const held = holdAnswer();
    const { calls, pendingSubmissions } = await renderComposer(IDLE, {
      handlers: { [buildInputOperation(IDLE)]: held.handler },
    });
    const sessionId = IDLE.session.id;

    act(() => {
      pendingSubmissions.writePicks(sessionId, { model: "claude-opus-5" });
    });
    await user.type(readField(), "Think harder{Enter}");
    await waitFor(() => {
      expect(readSent(calls, IDLE)).toHaveLength(1);
    });
    act(() => {
      pendingSubmissions.writePicks(sessionId, { model: "claude-sonnet-4" });
    });
    held.answer(OPENED);

    await waitFor(() => {
      expect(readText()).toBe("");
    });
    expect(readRecentModels(CONTROLLER_URL)).toEqual([
      { instanceId: FIXTURE_INSTANCE.id, model: "claude-opus-5" },
    ]);
    expect(pendingSubmissions.read(sessionId).picks).toEqual({ model: "claude-sonnet-4" });
    expect(readSent(calls, IDLE)).toEqual([{ text: "Think harder", model: "claude-opus-5" }]);
  });

  it("keeps the thread's unsent text in the pending submissions, so it outlives the composer", async () => {
    const user = userEvent.setup();
    const { pendingSubmissions } = await renderComposer(IDLE);
    const sessionId = IDLE.session.id;

    await user.type(readField(), "Half a thought");
    expect(pendingSubmissions.read(sessionId).message).toEqual({
      text: "Half a thought",
      attachments: [],
    });

    act(() => {
      pendingSubmissions.writeText(sessionId, "Written elsewhere");
    });
    expect(readText()).toBe("Written elsewhere");
  });

  it("draws a main workspace in the lip, then its branch in the UI face, then the machine", async () => {
    await renderComposer(IDLE);

    const workspaceLocked = "Create a new thread to change the workspace";
    expect(readLip()).toEqual([
      ["Main workspace", "Workspace details"],
      ["main", workspaceLocked],
      ["", null],
      ["moss", "Create a new thread to change the machine"],
    ]);
    // Monospace is kept for code, so a branch is never a `code` element.
    expect(document.querySelector(".lip code")).toBeNull();
    expect(document.querySelector(".lip .faint")).toBeNull();
  });

  it("draws an ephemeral workspace's actual branch without inferring an unrecorded starting revision", async () => {
    await renderComposer(BUSY);

    expect(readLip().map(([text]) => text)).toEqual(["hercule/thread-3f1", "", "moss"]);
    expect(document.querySelector(".lip code")).toBeNull();
    expect(document.querySelector(".lip .faint")).toBeNull();
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

  it("stacks the tally, the queued inputs, then the Request, above the card, without taking the focus", async () => {
    const approval = SIDEBAR_FIXTURE.threads[0]!.openRequests[0]!;
    await renderComposer(changeSession(THREAD_FIXTURES.queued, { openRequests: [approval] }));

    const stack = document.querySelector(".composer")!;
    expect([...stack.children].map((child) => child.className)).toEqual([
      "fold tally-fold",
      "fold",
      "dock",
      "composer-card",
      "fold",
    ]);
    // The thread has no subagent, so its tally draws nothing.
    expect(stack.children[0]!.children).toHaveLength(0);
    expect([...stack.children[1]!.children].map((child) => child.className)).toEqual([
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

  /** A command approval the waiting thread's subagent asks. */
  const SUBAGENT_REQUEST: SessionRequest = {
    requestId: "req-2",
    itemId: "tool-2",
    kind: "command_approval",
    decisions: ["allow", "deny"],
    detail: { command: "rm -rf tmp" },
    subagentId: FIXTURE_SUBAGENT.id,
  };

  /** The waiting thread with a second Request, which its subagent asks. */
  const TWO_REQUESTS: ThreadRecords = {
    ...WAITING,
    session: {
      ...WAITING.session,
      openRequests: [...WAITING.session.openRequests, SUBAGENT_REQUEST],
    },
    subagents: [{ ...FIXTURE_SUBAGENT, sessionId: WAITING.session.id }],
  };

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

  it("keeps the pager line, which pages without expanding, and dock-mini answers the Request it shows", async () => {
    const user = userEvent.setup();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const { calls, reports } = await renderComposer(TWO_REQUESTS, {
      shrunk: true,
      handlers: { [RESPOND]: { body: WAITING.session } },
    });
    const pager = document.querySelector<HTMLElement>(".request-pager")!;
    const mini = document.querySelector<HTMLElement>(".dock-mini")!;
    expect(pager.textContent).toBe("1 of 2The main agent asks");
    expect(mini.textContent).toBe("Run git push?AllowDeny");

    await user.click(within(pager).getByRole("button", { name: "Next Request" }));

    expect(pager.textContent).toBe(
      "2 of 2Find the flaky webhook test asks · subagent of the main agentOpen subagent ›",
    );
    // The dock is keyed by its Request, so the shown one has a dock-mini of its own.
    const shownMini = document.querySelector<HTMLElement>(".dock-mini")!;
    expect(shownMini.textContent).toBe("Run rm -rf tmp?AllowDeny");
    // Paging kept the composer shrunk: no focus it counts, and no scroll.
    expect(reports).toEqual({ focus: [false], scrolls: 0 });
    await user.click(pager.querySelector(".request-pager-who")!);
    expect(reports.scrolls).toBe(0);

    await user.click(within(shownMini).getByRole("button", { name: "Allow" }));
    await waitFor(() => {
      expect(
        calls.filter((call) => `${call.method} ${call.path}` === RESPOND).map((call) => call.body),
      ).toEqual([{ requestId: "req-2", decision: "allow" }]);
    });
    expect(reports.scrolls).toBe(0);
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

describe("the skills in the composer", () => {
  /** The skills the fixture thread has, as the controller lists them. */
  const SKILLS = [
    { source: "library", name: "implement", description: "Implement a locked SPEC" },
    { source: "library", name: "review", description: "Review a diff" },
  ] as unknown as readonly SessionSkill[];

  it("lists the skills of the thread when the user types $, and picks one as a chip", async () => {
    const user = userEvent.setup();
    const thread = { ...IDLE, skills: SKILLS };
    const { calls } = await renderComposer(thread);

    await user.type(readField(), "Please $rev");
    const rows = within(await screen.findByRole("listbox", { name: "Skills" })).getAllByRole(
      "option",
    );
    expect(rows.map((row) => row.textContent)).toEqual([expect.stringContaining("review")]);
    await user.keyboard("{Enter}");

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.querySelector("[data-skill='review']")).not.toBeNull();
    expect(readFieldText(document.querySelector(".composer-input")!)).toBe("Please $review ");
    // The composer reads the skills when it mounts, and again when the list opens.
    expect(readSkillReads(calls, thread).length).toBeGreaterThanOrEqual(1);
  });

  it("says the skills could not be read, with the reason, when reading them fails", async () => {
    const user = userEvent.setup();
    const thread = IDLE;
    await renderComposer(thread, {
      handlers: {
        [`GET /api/v1/sessions/${thread.session.id}/skills`]: {
          status: 500,
          body: buildErrorBody("internal", "The runner is gone."),
        },
      },
    });

    await user.type(readField(), "$");

    expect(await screen.findByText("Couldn't read this thread's skills")).toBeTruthy();
    expect(screen.getByText("The runner is gone.")).toBeTruthy();
    expect(screen.queryByText("This thread has no skills")).toBeNull();
  });

  it("does not read the skills of a thread that cannot take input", async () => {
    const thread = changeSession(IDLE, {
      status: "exited",
      resumable: false,
      nativeSessionId: null,
    });
    const { calls } = await renderComposer(thread);

    expect(readSkillReads(calls, thread)).toEqual([]);
  });
});

describe("the composer answering a question", () => {
  const STORAGE = {
    question: "Which storage should drafts use?",
    header: "Storage",
    options: [{ label: "localStorage", description: "small" }, { label: "IndexedDB" }],
    multiSelect: false,
  } as const;
  const NOTES = {
    question: "Anything else the agent should know?",
    header: "Notes",
    options: [],
    multiSelect: false,
  } as const;
  const ASK: SessionRequest = {
    requestId: "req-2",
    itemId: "tool-2",
    kind: "question",
    detail: { questions: [STORAGE, NOTES] },
  };

  /** The waiting thread, busy, whose only Request is the two questions. */
  const ASKED = changeSession(THREAD_FIXTURES.waiting, { openRequests: [ASK] });
  const RESPOND = `POST /api/v1/sessions/${ASKED.session.id}/respond-to-question`;

  /** Returns the bodies the composer sent with `session.respondToQuestion`, oldest first. */
  const readAnswers = (calls: readonly Call[]): readonly unknown[] =>
    calls.filter((call) => `${call.method} ${call.path}` === RESPOND).map((call) => call.body);

  /** Returns the clipboard that holds `text` and no files. */
  const buildTextClipboard = (text: string): object => ({
    files: [],
    types: ["text/plain"],
    getData: (type: string) => (type === "text/plain" ? text : ""),
  });

  /** Undoes as the browser's undo command does. */
  const undo = (): void => {
    fireEvent(
      readField(),
      new InputEvent("beforeinput", { inputType: "historyUndo", cancelable: true }),
    );
  };

  /**
   * Renders the composer for `thread` and returns `ask`, which changes the
   * Requests the controller reports as open and waits until the composer has
   * read them, as a push from the controller does.
   */
  const renderAsking = async (thread: ThreadRecords) => {
    let openRequests = thread.session.openRequests;
    const rendered = await renderComposer(thread, {
      handlers: {
        [`GET /api/v1/sessions/${thread.session.id}`]: () => ({
          body: { ...thread.session, openRequests },
        }),
        [RESPOND]: { body: thread.session },
      },
    });
    const ask = async (requests: Session["openRequests"]): Promise<void> => {
      openRequests = requests;
      await refreshSession(rendered.queryClient, thread.session.id);
    };
    return { ...rendered, ask };
  };

  it("types the answer in the field, steps with ⏎, and sends from the last question with Stop beside the step button", async () => {
    const user = userEvent.setup();
    const { calls } = await renderAsking(ASKED);
    expect(readFieldPlaceholder(readField())).toBe("Or type your own answer");
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Previous" })).toBeNull();
    expect(screen.getByRole("button", { name: "Next" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();

    await user.type(readField(), "Whatever is closest{Enter}");

    expect(readFieldPlaceholder(readField())).toBe("Type your answer");
    expect(readText()).toBe("");
    expect(screen.getByRole("button", { name: "Previous" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send answers" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    await user.type(readField(), "First line{Shift>}{Enter}{/Shift}second line{Enter}");

    await waitFor(() => {
      expect(readAnswers(calls)).toEqual([
        {
          requestId: "req-2",
          answers: { Storage: "Whatever is closest", Notes: "First line\nsecond line" },
        },
      ]);
    });
    // Locked until the controller closes the Request.
    expect(readField().getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("button", { name: "Send answers" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
  });

  it("does nothing on ⏎ or the step button for an unanswered question, and does not skip it", async () => {
    const user = userEvent.setup();
    const { calls } = await renderAsking(ASKED);
    await user.click(readField());

    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Next" }));

    expect(readFieldPlaceholder(readField())).toBe("Or type your own answer");
    expect(screen.getByRole("button", { name: "Next" }).getAttribute("aria-disabled")).toBe("true");
    // A key that does step proves the keys before did not send.
    await user.type(readField(), "IndexedDB{Enter}");
    await user.type(readField(), "Nothing{Enter}");
    await waitFor(() => {
      expect(readAnswers(calls)).toHaveLength(1);
    });
  });

  it("steps with the step button and the menu's Send, and goes back with Previous, keeping each answer", async () => {
    const user = userEvent.setup();
    const { calls, sendMenuCommand } = await renderAsking(ASKED);

    await user.type(readField(), "Postgres");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.type(readField(), "Mind the migration");
    await user.click(screen.getByRole("button", { name: "Previous" }));

    expect(readText()).toBe("Postgres");
    expect(screen.getByRole("button", { name: "Next" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(readText()).toBe("Mind the migration");

    act(() => {
      sendMenuCommand("send");
    });

    await waitFor(() => {
      expect(readAnswers(calls)).toEqual([
        { requestId: "req-2", answers: { Storage: "Postgres", Notes: "Mind the migration" } },
      ]);
    });
  });

  it("goes back from a blank question, and shows why the controller refused the answers on the error line", async () => {
    const user = userEvent.setup();
    const { calls } = await renderComposer(ASKED, {
      handlers: {
        [RESPOND]: { status: 409, body: buildErrorBody("invalid_state", "The request is closed.") },
      },
    });
    await user.type(readField(), "Postgres{Enter}");
    await user.click(screen.getByRole("button", { name: "Previous" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(readText()).toBe("");

    await user.type(readField(), "Mind the migration{Enter}");

    expect((await screen.findByRole("alert")).textContent).toBe("The request is closed.");
    expect(readAnswers(calls)).toHaveLength(1);
    // The failure unlocks the answers, so the user can send them again.
    expect(readField().getAttribute("aria-disabled")).toBeNull();
    expect(screen.getByRole("button", { name: "Send answers" }).getAttribute("aria-disabled")).toBe(
      "false",
    );
  });

  it("keeps the half-typed message as it was, and shows it again once the Request closes", async () => {
    const user = userEvent.setup();
    const { calls, pendingSubmissions, ask } = await renderAsking(ASKED);
    act(() => {
      pendingSubmissions.writeText(ASKED.session.id, "Half a mess");
    });
    expect(readText()).toBe("");

    await user.type(readField(), "Postgres{Enter}Mind the migration{Enter}");
    await waitFor(() => {
      expect(readAnswers(calls)).toHaveLength(1);
    });
    expect(pendingSubmissions.read(ASKED.session.id).message.text).toBe("Half a mess");
    await ask([]);

    expect(readText()).toBe("Half a mess");
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send answers" })).toBeNull();
  });

  it("starts a new undo history on the switch, so undo never brings the message back into the answer", async () => {
    const user = userEvent.setup();
    const { ask, pendingSubmissions } = await renderAsking(
      changeSession(ASKED, { openRequests: [] }),
    );
    act(() => {
      pendingSubmissions.writeText(ASKED.session.id, "Draft");
    });
    // The message is deleted again, so the answer starts empty as well: the
    // field has no text to replace, and only the undo history can leak it.
    readField().focus();
    await user.keyboard("{Backspace>5/}");
    expect(readText()).toBe("");
    fireEvent.blur(readField());
    await ask([ASK]);
    expect(screen.getByRole("button", { name: "Next" })).toBeTruthy();

    undo();

    expect(readText()).toBe("");
  });

  it("keeps the answer in the field while an IME composition starts and ends in it", async () => {
    const user = userEvent.setup();
    const { pendingSubmissions } = await renderAsking(ASKED);
    act(() => {
      pendingSubmissions.writeText(ASKED.session.id, "Half a mess");
    });
    await user.type(readField(), "Post");

    // A composition in the answer must not hold off the question that is
    // already answered, or the field would show the saved message.
    fireEvent.compositionStart(readField());
    expect(readText()).toBe("Post");
    expect(screen.getByRole("button", { name: "Next" })).toBeTruthy();
    fireEvent.compositionEnd(readField());
    expect(readText()).toBe("Post");
    expect(screen.getByRole("button", { name: "Next" })).toBeTruthy();
  });

  it("offers no skills and draws no chips in an answer", async () => {
    const user = userEvent.setup();
    const skills = [
      { source: "library", name: "review", description: "Review a diff" },
    ] as unknown as readonly SessionSkill[];
    await renderAsking({ ...ASKED, skills });

    await user.type(readField(), "Use $review");

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.querySelector("[data-skill]")).toBeNull();
    expect(readText()).toBe("Use $review");
  });

  it("refuses a pasted image with a notice, keeps Attach off with the reason, and puts nothing on the shelf", async () => {
    const user = userEvent.setup();
    const { calls, pendingSubmissions } = await renderAsking(ASKED);
    const attach = screen.getByRole("button", { name: "Attach" });
    expect(attach.getAttribute("aria-disabled")).toBe("true");
    expect(attach.title).toBe("An answer takes text only");

    fireEvent.paste(readField(), {
      clipboardData: {
        files: [buildImage("shot.png")],
        types: ["Files"],
        getData: () => "",
      },
    });

    expect(readNotice()).toBe("An answer takes text only. Images can be sent in a message.");
    expect(pendingSubmissions.read(ASKED.session.id).message.attachments).toEqual([]);
    expect(screen.queryByRole("list", { name: "Attached images" })).toBeNull();
    expect(calls.some((call) => call.path === "/api/v1/attachments")).toBe(false);
    // The notice goes with the next key.
    await user.type(readField(), "x");
    expect(readNotice()).toBe("");
  });

  it("shows a refused file's notice only on the question it happened on", async () => {
    const user = userEvent.setup();
    await renderThreadPart(
      ({ sessionId }) => (
        <>
          <ShowQuestionButton sessionId={sessionId} index={0} />
          <ShowQuestionButton sessionId={sessionId} index={1} />
          <ThreadComposer
            sessionId={sessionId}
            shrunk={false}
            onFocusChange={() => {}}
            scrollTranscriptToBottom={() => {}}
          />
        </>
      ),
      { thread: ASKED, handlers: { "GET /api/v1/providers": { body: [FIXTURE_INSTANCE] } } },
    );
    fireEvent.paste(readField(), {
      clipboardData: { files: [buildImage("shot.png")], types: ["Files"], getData: () => "" },
    });
    expect(readNotice()).toBe("An answer takes text only. Images can be sent in a message.");

    await user.click(screen.getByRole("button", { name: "Show question 2" }));
    expect(readNotice()).toBe("");

    await user.click(screen.getByRole("button", { name: "Show question 1" }));
    expect(readNotice()).toBe("");
  });

  it("shows the length notice and turns the step button off over the limit, and still goes back", async () => {
    const user = userEvent.setup();
    const { calls } = await renderAsking(ASKED);
    await user.type(readField(), "Postgres{Enter}");

    fireEvent.paste(readField(), { clipboardData: buildTextClipboard("x".repeat(4097)) });

    expect(readNotice()).toBe("This answer is longer than 4,096 characters.");
    expect(screen.getByRole("button", { name: "Send answers" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Previous" }));
    expect(readText()).toBe("Postgres");
    expect(readAnswers(calls)).toEqual([]);
  });

  it("answers an async question only once it is unfolded, and then draws no Stop while the session is idle", async () => {
    const user = userEvent.setup();
    const idle = changeSession(IDLE, { openRequests: [{ ...ASK, async: true }] });
    await renderThreadPart(
      ({ sessionId }) => (
        <>
          <UnfoldButton sessionId={sessionId} />
          <ThreadComposer
            sessionId={sessionId}
            shrunk={false}
            onFocusChange={() => {}}
            scrollTranscriptToBottom={() => {}}
          />
        </>
      ),
      { thread: idle, handlers: { "GET /api/v1/providers": { body: [FIXTURE_INSTANCE] } } },
    );
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
    expect(readFieldPlaceholder(readField())).toBe("Reply…");

    await user.click(screen.getByRole("button", { name: "Unfold" }));

    expect(readFieldPlaceholder(readField())).toBe("Or type your own answer");
    expect(screen.getByRole("button", { name: "Next" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });
});

describe("the typing guard in the composer", () => {
  const ASK: SessionRequest = {
    requestId: "req-2",
    itemId: "tool-2",
    kind: "question",
    detail: {
      questions: [
        { question: "Which storage?", header: "Storage", options: [], multiSelect: false },
      ],
    },
  };
  const THREAD = changeSession(IDLE, { openRequests: [] });

  /**
   * Renders the idle thread, types "Half a mes" as a message, and has the
   * controller report the question. Returns the user, the calls, and the
   * pending submissions.
   */
  const typeThenAsk = async () => {
    const user = userEvent.setup();
    let openRequests: Session["openRequests"] = [];
    const rendered = await renderComposer(THREAD, {
      handlers: {
        [`GET /api/v1/sessions/${THREAD.session.id}`]: () => ({
          body: { ...THREAD.session, openRequests },
        }),
      },
    });
    await user.type(readField(), "Half a mes");
    openRequests = [ASK];
    await refreshSession(rendered.queryClient, THREAD.session.id);
    return { ...rendered, user };
  };

  /** Checks that the composer still edits the message, and shows the message text. */
  const expectMessageMode = (): void => {
    expect(readText()).toBe("Half a mes");
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  };

  /** Checks that the composer answers the question, with an empty answer. */
  const expectAnswerMode = (): void => {
    expect(readText()).toBe("");
    expect(screen.getByRole("button", { name: "Send answers" })).toBeTruthy();
  };

  it("keeps a question from taking the composer while the user types, and gives it after a pause", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    try {
      await typeThenAsk();
      expectMessageMode();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(TYPING_PAUSE_MS - 100);
      });
      expectMessageMode();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TYPING_PAUSE_MS);
      });

      expectAnswerMode();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives the composer to the question when the field loses the focus", async () => {
    await typeThenAsk();
    expectMessageMode();

    fireEvent.blur(readField());

    expectAnswerMode();
  });

  it("gives the composer to the question when the user sends the message", async () => {
    const user = userEvent.setup();
    const { calls } = await typeThenAsk();

    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(readSent(calls, THREAD)).toEqual([{ text: "Half a mes" }]);
    });
    expectAnswerMode();
  });

  it("gives the composer to the question after a send that fails", async () => {
    const user = userEvent.setup();
    let openRequests: Session["openRequests"] = [];
    const rendered = await renderComposer(THREAD, {
      handlers: {
        [`GET /api/v1/sessions/${THREAD.session.id}`]: () => ({
          body: { ...THREAD.session, openRequests },
        }),
        [buildInputOperation(THREAD)]: {
          status: 409,
          body: buildErrorBody("invalid_state", "Not now."),
        },
      },
    });
    await user.type(readField(), "Half a mes");
    openRequests = [ASK];
    await refreshSession(rendered.queryClient, THREAD.session.id);
    expectMessageMode();

    await user.keyboard("{Enter}");

    // The failed message is kept for the user, and the question has the field.
    await waitFor(() => {
      expect(rendered.pendingSubmissions.read(THREAD.session.id).failure).toBe("Not now.");
    });
    expectAnswerMode();
  });

  it("keeps holding while an IME composition is open, however long the pause", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    try {
      await typeThenAsk();
      fireEvent.compositionStart(readField());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(TYPING_PAUSE_MS * 3);
      });
      expectMessageMode();
      fireEvent.compositionEnd(readField());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TYPING_PAUSE_MS);
      });

      expectAnswerMode();
    } finally {
      vi.useRealTimers();
    }
  });
});
