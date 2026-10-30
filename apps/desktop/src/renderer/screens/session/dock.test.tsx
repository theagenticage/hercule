/**
 * Tests the dock against the stubbed controller: what it asks for each kind
 * of Request, the answers it offers, the keys that send them, and what it
 * shows while an answer is sent, once it is, and when it fails.
 *
 * A test that checks a key sends nothing presses a key that does send
 * something afterwards, and checks that the controller received only that
 * answer. So a key that wrongly sent an answer shows up however late its
 * request would have arrived.
 */
import { describe, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { buildApprovalCard, formatDescribeLine, queryKeys } from "@hercule/client-core";
import type { OpenRequest, QuestionAnswers } from "@hercule/contract";
import {
  buildErrorBody,
  FIXTURE_THREAD_IDS,
  holdAnswer,
  THREAD_FIXTURES,
  type Answer,
  type Call,
  type Handler,
} from "../../app/testing";
import { buildLook } from "../../faces";
import { renderThreadPart } from "../thread/testing";
import { useRequestDraft, useSendAnswers } from "../../app/request-drafts";
import { RequestDock } from "./dock";

/** A command approval that offers every decision. */
const COMMAND: OpenRequest = {
  requestId: "req-1",
  itemId: "tool-1",
  kind: "command_approval",
  decisions: ["allow", "allow_always", "deny", "cancel"],
  detail: { command: "git push" },
};

/** The operation the dock sends a decision with. */
const RESPOND_TO_APPROVAL_REQUEST = `POST /api/v1/sessions/${FIXTURE_THREAD_IDS.runbook}/respond-to-approval-request`;

/** The operation the dock sends answers with. */
const RESPOND_TO_QUESTION = `POST /api/v1/sessions/${FIXTURE_THREAD_IDS.runbook}/respond-to-question`;

/** The controller's answer to a Request it accepts: the session, still waiting until the runner reports. */
const ACCEPTED: Answer = { body: THREAD_FIXTURES.waiting.session };

/** Where the dock stands: whether a composer is below it, and where a pick moves displaced text. */
interface DockPlace {
  readonly composerBelow?: boolean;
  /** The Message Draft key; the thread's session id when absent. */
  readonly messageDraftKey?: string;
}

/**
 * Renders the dock for `request` on the waiting fixture thread, with a button
 * outside it, and returns the calls and the query cache. The controller
 * accepts every answer unless `respond` says otherwise. `composerBelow` says
 * whether the dock stands on a composer, as on a thread's page; the default
 * is the dock of a subagent's page, which has none.
 */
const renderDock = (
  request: OpenRequest,
  respond: Handler = ACCEPTED,
  { composerBelow = false, messageDraftKey }: DockPlace = {},
) =>
  renderThreadPart(
    ({ sessionId }) => (
      <>
        <button type="button">Outside</button>
        <RequestDock
          sessionId={sessionId}
          look={buildLook(sessionId)}
          request={request}
          composerBelow={composerBelow}
          messageDraftKey={messageDraftKey ?? sessionId}
        />
      </>
    ),
    {
      thread: THREAD_FIXTURES.waiting,
      handlers: { [RESPOND_TO_APPROVAL_REQUEST]: respond, [RESPOND_TO_QUESTION]: respond },
    },
  );

/** Returns the decisions the dock sent, oldest first. */
const readDecisions = (calls: readonly Call[]): readonly unknown[] =>
  calls
    .filter((call) => `${call.method} ${call.path}` === RESPOND_TO_APPROVAL_REQUEST)
    .map((call) => (call.body as { readonly decision: unknown }).decision);

/** Returns the dock, which is a group named by its title. */
const readDock = (title = "Run this command?"): HTMLElement =>
  screen.getByRole("group", { name: title });

/** Moves the focus to `element`, as a click or Tab would. */
const focus = (element: HTMLElement): void => {
  act(() => {
    element.focus();
  });
};

describe("the dock", () => {
  it.each<readonly [string, OpenRequest, string, readonly string[]]>([
    ["a command", COMMAND, "Run this command?", ["git push"]],
    [
      "a change to one file",
      { ...COMMAND, kind: "file_change_approval", detail: { paths: ["src/auth.ts"] } },
      "Change this file?",
      ["src/auth.ts"],
    ],
    [
      "a change to several files",
      {
        ...COMMAND,
        kind: "file_change_approval",
        detail: { paths: ["src/auth.ts", "src/auth.test.ts"] },
      },
      "Change these files?",
      ["src/auth.ts", "src/auth.test.ts"],
    ],
    [
      "a read",
      { ...COMMAND, kind: "file_read_approval", detail: { paths: ["docs/"] } },
      "Read this file?",
      ["docs/"],
    ],
    [
      "a read that names no file",
      { ...COMMAND, kind: "file_read_approval", detail: { paths: [] } },
      "Read files?",
      [],
    ],
    [
      "a tool call",
      { ...COMMAND, kind: "tool_approval", detail: { toolName: "WebFetch" } },
      "Run WebFetch?",
      [],
    ],
  ])("asks about %s by the card's title and subject", async (_kind, request, title, subject) => {
    await renderDock(request);

    const dock = readDock(title);
    expect([...dock.querySelectorAll("code")].map((code) => code.textContent)).toEqual(subject);
  });

  it("offers each decision as a ledger row that says what it does, with its key", async () => {
    await renderDock(COMMAND);

    const rows = buildApprovalCard(COMMAND).rows;
    const keys = { allow: "↩", allow_always: "⌥↩", deny: "esc", cancel: undefined };
    for (const row of rows) {
      const answer = within(readDock()).getByRole("button", {
        name: row.label,
        description: formatDescribeLine(row.describeLine),
      });
      expect(answer.querySelector("kbd")?.textContent).toBe(keys[row.id]);
    }
    expect(
      within(readDock())
        .getAllByRole("button")
        .map((answer) => answer.getAttribute("aria-label")),
    ).toEqual(["Allow", "Allow always", "Deny", "Cancel"]);
  });

  it("allows on ↩ when the dock itself has the focus", async () => {
    const user = userEvent.setup();
    const { calls } = await renderDock(COMMAND);

    focus(readDock());
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(readDecisions(calls)).toEqual(["allow"]);
    });
    expect(
      calls.find((call) => `${call.method} ${call.path}` === RESPOND_TO_APPROVAL_REQUEST)?.body,
    ).toEqual({
      requestId: "req-1",
      decision: "allow",
    });
  });

  it("allows always on ⌥↩ from the dock", async () => {
    const user = userEvent.setup();
    const { calls } = await renderDock(COMMAND);

    focus(readDock());
    await user.keyboard("{Alt>}{Enter}{/Alt}");

    await waitFor(() => {
      expect(readDecisions(calls)).toEqual(["allow_always"]);
    });
  });

  it("denies on esc from an answer inside the dock", async () => {
    const user = userEvent.setup();
    const { calls } = await renderDock(COMMAND);

    focus(within(readDock()).getByRole("button", { name: "Allow always" }));
    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(readDecisions(calls)).toEqual(["deny"]);
    });
  });

  it("presses the focused answer on ↩, so a focused Deny denies", async () => {
    const user = userEvent.setup();
    const { calls, queryClient } = await renderDock(COMMAND);

    focus(within(readDock()).getByRole("button", { name: "Deny" }));
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(queryClient.isMutating()).toBe(0);
    });
    expect(readDecisions(calls)).toEqual(["deny"]);
  });

  it("sends only allow always on ⌥↩ with Deny focused", async () => {
    const { calls, queryClient } = await renderDock(COMMAND);

    const deny = within(readDock()).getByRole("button", { name: "Deny" });
    focus(deny);
    // A browser presses a focused button on ↩ even with ⌥ held, which
    // user-event does not copy. So the test checks the key's default action,
    // the press, is cancelled.
    const pressed = fireEvent.keyDown(deny, { key: "Enter", altKey: true });

    expect(pressed).toBe(false);
    await waitFor(() => {
      expect(queryClient.isMutating()).toBe(0);
    });
    expect(readDecisions(calls)).toEqual(["allow_always"]);
  });

  it("ignores a key whose decision the Request does not offer", async () => {
    const user = userEvent.setup();
    const { calls } = await renderDock({ ...COMMAND, decisions: ["allow", "deny"] });

    focus(readDock());
    await user.keyboard("{Alt>}{Enter}{/Alt}");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(readDecisions(calls)).toEqual(["allow"]);
    });
  });

  it("ignores the keys pressed outside the dock", async () => {
    const user = userEvent.setup();
    const { calls } = await renderDock(COMMAND);

    focus(screen.getByRole("button", { name: "Outside" }));
    await user.keyboard("{Enter}{Escape}{Alt>}{Enter}{/Alt}");
    focus(readDock());
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(readDecisions(calls)).toEqual(["allow"]);
    });
  });

  it("ignores every answer while one is sent, and takes answers again when it fails", async () => {
    const user = userEvent.setup();
    const held = holdAnswer();
    const answers: Answer[] = [];
    const { calls } = await renderDock(COMMAND, () =>
      answers.length > 0 ? answers.shift()! : held.handler(),
    );

    focus(readDock());
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(readDecisions(calls)).toEqual(["allow"]);
    });
    for (const answer of within(readDock()).getAllByRole("button")) {
      expect(answer.getAttribute("aria-disabled")).toBe("true");
    }
    await user.keyboard("{Escape}{Alt>}{Enter}{/Alt}");
    await user.click(within(readDock()).getByRole("button", { name: "Deny" }));

    answers.push(ACCEPTED);
    held.answer({ status: 409, body: buildErrorBody("invalid_state", "Try again.") });
    await screen.findByRole("alert");
    focus(readDock());
    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(readDecisions(calls)).toEqual(["allow", "deny"]);
    });
  });

  it("keeps every answer disabled once the controller accepts one", async () => {
    const user = userEvent.setup();
    const { calls, queryClient } = await renderDock(COMMAND);

    await user.click(within(readDock()).getByRole("button", { name: "Allow" }));
    await waitFor(() => {
      expect(queryClient.isMutating()).toBe(0);
    });

    for (const answer of within(readDock()).getAllByRole("button")) {
      expect(answer.getAttribute("aria-disabled")).toBe("true");
    }
    await user.click(within(readDock()).getByRole("button", { name: "Deny" }));
    focus(readDock());
    await user.keyboard("{Escape}");
    expect(queryClient.isMutating()).toBe(0);
    expect(readDecisions(calls)).toEqual(["allow"]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows why the controller refused an answer, and lets the user answer again", async () => {
    const user = userEvent.setup();
    await renderDock(COMMAND, {
      status: 409,
      body: buildErrorBody("invalid_state", "The request is no longer open."),
    });

    await user.click(within(readDock()).getByRole("button", { name: "Allow" }));

    expect((await screen.findByRole("alert")).textContent).toBe("The request is no longer open.");
    for (const answer of within(readDock()).getAllByRole("button")) {
      expect(answer.getAttribute("aria-disabled")).toBeNull();
    }
  });

  it("lets the user answer again after a failed send, with no session in the cache", async () => {
    // The Office's dossier card draws the dock from the thread list, before
    // the session's own read lands, and that read can fail.
    const user = userEvent.setup();
    const held = holdAnswer();
    const { queryClient } = await renderDock(COMMAND, held.handler);
    queryClient.removeQueries({ queryKey: queryKeys.session(FIXTURE_THREAD_IDS.runbook) });

    await user.click(within(readDock()).getByRole("button", { name: "Allow" }));
    held.answer({ status: 409, body: buildErrorBody("invalid_state", "Try again.") });

    await screen.findByRole("alert");
    for (const answer of within(readDock()).getAllByRole("button")) {
      expect(answer.getAttribute("aria-disabled")).toBeNull();
    }
  });

  it("never takes the focus when it opens", async () => {
    await renderDock(COMMAND);

    expect(readDock()).toBeTruthy();
    expect(document.activeElement).toBe(document.body);
  });
});

/** One question of a `question` request, as the contract types it. */
type Question = Extract<OpenRequest, { kind: "question" }>["detail"]["questions"][number];

/** A single-select question. */
const STORAGE: Question = {
  question: "Which storage should drafts use?",
  header: "Storage",
  options: [
    { label: "localStorage", description: "small and synchronous" },
    { label: "IndexedDB", description: "large and asynchronous" },
  ],
  multiSelect: false,
};

/** A multiSelect question. */
const FEATURES: Question = {
  question: "Which features should ship?",
  header: "Features",
  options: [
    { label: "Sync", description: "" },
    { label: "Search", description: "" },
  ],
  multiSelect: true,
};

/** A question request with a single-select question, then a multiSelect one. */
const QUESTIONS: OpenRequest = {
  requestId: "req-2",
  itemId: "tool-2",
  kind: "question",
  detail: { questions: [STORAGE, FEATURES] },
};

/** A question request with only the single-select question. */
const ONE_QUESTION: OpenRequest = { ...QUESTIONS, detail: { questions: [STORAGE] } };

/**
 * Returns the bodies the dock sent with `session.respondToQuestion` and
 * `session.respondToApprovalRequest`, oldest first, so a decision sent by
 * mistake would show up too.
 */
const readBodies = (calls: readonly Call[]): readonly unknown[] =>
  calls
    .filter((call) =>
      [RESPOND_TO_QUESTION, RESPOND_TO_APPROVAL_REQUEST].includes(`${call.method} ${call.path}`),
    )
    .map((call) => call.body);

/** Returns the dock of a question request, named by the card's title. */
const readQuestionDock = (): HTMLElement => readDock(buildApprovalCard(QUESTIONS).title);

/**
 * Returns the choice for the option `label`: a radio on a single-select
 * question, a checkbox on a multiSelect one. Its accessible name starts with
 * the label and may go on with the option's description.
 */
const findChoice = (role: "radio" | "checkbox", label: string): HTMLElement =>
  within(readQuestionDock()).getByRole(role, { name: (name) => name.startsWith(label) });

/**
 * Returns the field the user types their own answer in. It is found by its
 * label rather than its role, because a masked field has no role.
 */
const readOwnAnswer = (): HTMLElement =>
  within(readQuestionDock()).getByLabelText("Your own answer");

/** Returns the button that sends the answers. */
const readSend = (): HTMLElement =>
  within(readQuestionDock()).getByRole("button", { name: "Send answers" });

/** Checks whether `element` takes no input, through `disabled` or `aria-disabled`. */
const isLocked = (element: HTMLElement): boolean =>
  (element as HTMLInputElement | HTMLButtonElement).disabled === true ||
  element.getAttribute("aria-disabled") === "true";

/**
 * Finds `text` in the question dock, outside `dock-mini`, which repeats the
 * first question on one line and shows only while the composer is shrunk.
 */
const queryDockText = (text: string | RegExp): HTMLElement | null =>
  within(readQuestionDock()).queryByText(text, { ignore: ".dock-mini *" });

/** The body `sendBothAnswers` sends. */
const BOTH_ANSWERS = { requestId: "req-2", answers: { Storage: "IndexedDB", Features: ["Sync"] } };

/** Answers both questions of `QUESTIONS` with a click each, and sends the answers. */
const sendBothAnswers = async (user: ReturnType<typeof userEvent.setup>): Promise<void> => {
  await user.click(findChoice("radio", "IndexedDB"));
  await user.click(within(readQuestionDock()).getByRole("button", { name: "Next" }));
  await user.click(findChoice("checkbox", "Sync"));
  await user.click(readSend());
};

describe("the dock for a question", () => {
  it("shows one question at a time with its place among them, its options as single choices, and a field for an own answer", async () => {
    const user = userEvent.setup();
    await renderDock(QUESTIONS);

    expect(queryDockText("Which storage should drafts use?")).not.toBeNull();
    expect(queryDockText("Which features should ship?")).toBeNull();
    expect(queryDockText("Question 1 of 2")).not.toBeNull();
    expect(findChoice("radio", "localStorage")).toBeTruthy();
    expect(findChoice("radio", "IndexedDB")).toBeTruthy();
    expect(within(readQuestionDock()).queryAllByRole("checkbox")).toEqual([]);
    expect(readOwnAnswer()).toBeTruthy();

    await user.click(findChoice("radio", "localStorage"));
    await user.click(within(readQuestionDock()).getByRole("button", { name: "Next" }));

    expect(queryDockText("Which storage should drafts use?")).toBeNull();
    expect(queryDockText("Which features should ship?")).not.toBeNull();
    expect(queryDockText("Question 2 of 2")).not.toBeNull();
    expect(findChoice("checkbox", "Sync")).toBeTruthy();
    expect(findChoice("checkbox", "Search")).toBeTruthy();
    expect(within(readQuestionDock()).queryAllByRole("radio")).toEqual([]);
    expect(readOwnAnswer()).toBeTruthy();
    expect(readSend()).toBeTruthy();
  });

  it("shows a lone question without its place, and with Send rather than Next", async () => {
    await renderDock(ONE_QUESTION);

    expect(queryDockText("Which storage should drafts use?")).not.toBeNull();
    expect(queryDockText(/\b1 of 1\b/)).toBeNull();
    expect(within(readQuestionDock()).queryByRole("button", { name: "Next" })).toBeNull();
    expect(readSend()).toBeTruthy();
  });

  it("warns that an answer the agent asked to keep secret is stored like any other", async () => {
    await renderDock({ ...QUESTIONS, detail: { questions: [{ ...STORAGE, secret: true }] } });

    expect(
      queryDockText(
        "The agent asked to keep this answer secret. It is stored in the thread like any other answer.",
      ),
    ).not.toBeNull();
  });

  it("enables Send only once the question is answered with a pick or non-blank text", async () => {
    const user = userEvent.setup();
    await renderDock(ONE_QUESTION);

    expect(isLocked(readSend())).toBe(true);
    await user.type(readOwnAnswer(), "   ");
    expect(isLocked(readSend())).toBe(true);
    await user.click(findChoice("radio", "IndexedDB"));
    expect(isLocked(readSend())).toBe(false);
  });

  it("sends the answers of every question with session.respondToQuestion", async () => {
    const user = userEvent.setup();
    const { calls } = await renderDock(QUESTIONS);

    await user.click(findChoice("radio", "localStorage"));
    await user.click(within(readQuestionDock()).getByRole("button", { name: "Next" }));
    await user.click(findChoice("checkbox", "Sync"));
    await user.click(findChoice("checkbox", "Search"));
    await user.type(readOwnAnswer(), " Offline mode ");
    await user.click(readSend());

    await waitFor(() => {
      expect(readBodies(calls)).toEqual([
        {
          requestId: "req-2",
          answers: { Storage: "localStorage", Features: ["Sync", "Search", "Offline mode"] },
        },
      ]);
    });
    expect(
      calls.filter((call) => `${call.method} ${call.path}` === RESPOND_TO_QUESTION),
    ).toHaveLength(1);
  });

  it("locks the choices, the field and Send once the answers are sent", async () => {
    const user = userEvent.setup();
    const { calls, queryClient } = await renderDock(ONE_QUESTION);

    await user.click(findChoice("radio", "IndexedDB"));
    await user.click(readSend());
    await waitFor(() => {
      expect(queryClient.isMutating()).toBe(0);
    });

    expect(isLocked(findChoice("radio", "localStorage"))).toBe(true);
    expect(isLocked(findChoice("radio", "IndexedDB"))).toBe(true);
    expect(isLocked(readOwnAnswer())).toBe(true);
    expect(isLocked(readSend())).toBe(true);
    await user.click(readSend());
    expect(queryClient.isMutating()).toBe(0);
    expect(readBodies(calls)).toEqual([{ requestId: "req-2", answers: { Storage: "IndexedDB" } }]);
  });

  it("shows the controller's error as it is and keeps every answer when sending fails", async () => {
    const user = userEvent.setup();
    const replies: Answer[] = [
      {
        status: 409,
        body: buildErrorBody("invalid_state", "The harness did not take the answer."),
      },
      ACCEPTED,
    ];
    const { calls } = await renderDock(QUESTIONS, () => replies.shift()!);

    await user.click(findChoice("radio", "IndexedDB"));
    await user.click(within(readQuestionDock()).getByRole("button", { name: "Next" }));
    await user.click(findChoice("checkbox", "Sync"));
    await user.type(readOwnAnswer(), "Offline mode");
    await user.click(readSend());

    expect((await screen.findByRole("alert")).textContent).toBe(
      "The harness did not take the answer.",
    );
    expect(isLocked(readSend())).toBe(false);
    expect(isLocked(readOwnAnswer())).toBe(false);
    expect((findChoice("checkbox", "Sync") as HTMLInputElement).checked).toBe(true);
    expect((readOwnAnswer() as HTMLInputElement).value).toBe("Offline mode");

    // The first question's pick is kept too: sending again sends all of it.
    await user.click(readSend());
    await waitFor(() => {
      expect(readBodies(calls)).toHaveLength(2);
    });
    expect(readBodies(calls)[1]).toEqual({
      requestId: "req-2",
      answers: { Storage: "IndexedDB", Features: ["Sync", "Offline mode"] },
    });
  });

  it("offers no decision, since the user turns a question down by stopping the turn", async () => {
    await renderDock(QUESTIONS);

    for (const name of ["Allow", "Deny", "Cancel"]) {
      expect(within(readQuestionDock()).queryByRole("button", { name })).toBeNull();
    }
  });

  it("goes to the next question on ↩ from the dock once the shown question is answered", async () => {
    const user = userEvent.setup();
    const { calls } = await renderDock(QUESTIONS);

    await user.click(findChoice("radio", "IndexedDB"));
    focus(readQuestionDock());
    await user.keyboard("{Enter}");

    expect(queryDockText("Question 2 of 2")).not.toBeNull();
    expect(queryDockText("Which features should ship?")).not.toBeNull();
    expect(readBodies(calls)).toEqual([]);
  });

  it("goes to the next question on ↩ right after a choice is clicked", async () => {
    const user = userEvent.setup();
    const { calls } = await renderDock(QUESTIONS);

    // The click leaves the focus on the choice, not on the dock.
    await user.click(findChoice("radio", "IndexedDB"));
    await user.keyboard("{Enter}");

    expect(queryDockText("Question 2 of 2")).not.toBeNull();
    expect(readBodies(calls)).toEqual([]);
  });

  it("does nothing on ↩ from the dock while the shown question is unanswered", async () => {
    const user = userEvent.setup();
    const { calls } = await renderDock(QUESTIONS);

    focus(readQuestionDock());
    await user.keyboard("{Enter}");
    expect(queryDockText("Question 1 of 2")).not.toBeNull();

    // Answering both questions sends one body, so a stray body sent by the ↩
    // above would show up before it.
    await sendBothAnswers(user);
    await waitFor(() => {
      expect(readBodies(calls)).toEqual([BOTH_ANSWERS]);
    });
  });

  it("sends the answers on ↩ from the dock on the last question once it is answered", async () => {
    const user = userEvent.setup();
    const { calls } = await renderDock(ONE_QUESTION);

    await user.click(findChoice("radio", "IndexedDB"));
    focus(readQuestionDock());
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(readBodies(calls)).toEqual([
        { requestId: "req-2", answers: { Storage: "IndexedDB" } },
      ]);
    });
  });

  it("sends nothing on esc, from a choice, the own-answer field or the dock", async () => {
    const user = userEvent.setup();
    const { calls } = await renderDock(QUESTIONS);

    focus(findChoice("radio", "localStorage"));
    await user.keyboard("{Escape}");
    await user.type(readOwnAnswer(), "a sqlite file");
    await user.keyboard("{Escape}");
    focus(readQuestionDock());
    await user.keyboard("{Escape}");

    // A body sent by an esc above would show up before the answers.
    await sendBothAnswers(user);
    await waitFor(() => {
      expect(readBodies(calls)).toEqual([BOTH_ANSWERS]);
    });
  });

  it("goes to the next question on ↩ in the own-answer field, as ↩ on the dock does", async () => {
    const user = userEvent.setup();
    const { calls } = await renderDock(QUESTIONS);

    await user.type(readOwnAnswer(), "a sqlite file");
    await user.keyboard("{Enter}");

    expect(queryDockText("Question 2 of 2")).not.toBeNull();
    expect(readBodies(calls)).toEqual([]);
  });

  it("stays on the question on the ↩ that ends an IME composition in the own-answer field", async () => {
    const user = userEvent.setup();
    const { calls } = await renderDock(QUESTIONS);

    await user.type(readOwnAnswer(), "にほんご");
    const pressed = fireEvent.keyDown(readOwnAnswer(), { key: "Enter", isComposing: true });

    expect(pressed).toBe(true);
    expect(queryDockText("Question 1 of 2")).not.toBeNull();
    expect(readBodies(calls)).toEqual([]);
  });

  it("goes to the next question on ⌘↵ in the own-answer field, and keeps the key from the menu's Send", async () => {
    const user = userEvent.setup();
    const { calls } = await renderDock(QUESTIONS);

    await user.type(readOwnAnswer(), "a sqlite file");
    const pressed = fireEvent.keyDown(readOwnAnswer(), { key: "Enter", metaKey: true });

    // A prevented key press is what keeps the menu's Send from firing.
    expect(pressed).toBe(false);
    expect(queryDockText("Question 2 of 2")).not.toBeNull();
    expect(readBodies(calls)).toEqual([]);
  });

  it("keeps ⌘↵ on a focused button from the menu's Send, which would send the composer's message", async () => {
    const user = userEvent.setup();
    const { calls } = await renderDock(QUESTIONS);

    await user.type(readOwnAnswer(), "a sqlite file");
    const next = within(readQuestionDock()).getByRole("button", { name: "Next" });
    const pressed = fireEvent.keyDown(next, { key: "Enter", metaKey: true });

    expect(pressed).toBe(false);
    expect(queryDockText("Question 2 of 2")).not.toBeNull();
    expect(readBodies(calls)).toEqual([]);
  });

  it("answers a question with no options with the user's own text", async () => {
    const user = userEvent.setup();
    const { calls } = await renderDock({
      ...QUESTIONS,
      detail: { questions: [{ ...STORAGE, options: [] }] },
    });

    expect(within(readQuestionDock()).queryAllByRole("radio")).toEqual([]);
    await user.type(readOwnAnswer(), "a sqlite file");
    await user.click(readSend());

    await waitFor(() => {
      expect(readBodies(calls)).toEqual([
        { requestId: "req-2", answers: { Storage: "a sqlite file" } },
      ]);
    });
  });

  it("sends the trimmed own answer on ↩ in the field on the last question", async () => {
    const user = userEvent.setup();
    const { calls } = await renderDock(ONE_QUESTION);

    await user.type(readOwnAnswer(), "  a sqlite file ");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(readBodies(calls)).toEqual([
        { requestId: "req-2", answers: { Storage: "a sqlite file" } },
      ]);
    });
  });
});

/** A question request whose one question the agent asked to keep secret. */
const SECRET_QUESTION: OpenRequest = {
  ...QUESTIONS,
  detail: { questions: [{ ...STORAGE, header: "Token", options: [], secret: true }] },
};

/** The folded row's words for `QUESTIONS`, which asks two questions. */
const FOLDED_ROW = "The agent asked 2 questions. It keeps working.";

/** A question request the agent does not wait on. */
const ASYNC_QUESTIONS: OpenRequest = { ...QUESTIONS, async: true };

/** Returns the dock while it is folded, named by its one row. */
const readFoldedDock = (row = FOLDED_ROW): HTMLElement => readDock(row);

/** Returns the dock's button named `name`. */
const readButton = (name: string): HTMLElement =>
  within(readQuestionDock()).getByRole("button", { name });

/**
 * Renders `QuestionsDock` with a stand-in for the composer: a button that
 * sends `answers` to the Request `requestId` through the hook the composer
 * uses, and the Request's draft failure in an output. Returns what
 * `renderDock` does.
 */
const renderDockWithComposerSender = (
  request: OpenRequest,
  respond: Handler,
  answers: QuestionAnswers,
  place: DockPlace,
) =>
  renderThreadPart(
    ({ sessionId }) => {
      const send = useSendAnswers(sessionId);
      const [draft] = useRequestDraft(sessionId, request.requestId);
      return (
        <>
          <button
            type="button"
            onClick={() => {
              send(request.requestId, answers);
            }}
          >
            Send from the composer
          </button>
          <output aria-label="Failure in the draft">{draft.failure}</output>
          <RequestDock
            sessionId={sessionId}
            look={buildLook(sessionId)}
            request={request}
            composerBelow={place.composerBelow ?? false}
            messageDraftKey={sessionId}
          />
        </>
      );
    },
    {
      thread: THREAD_FIXTURES.waiting,
      handlers: { [RESPOND_TO_QUESTION]: respond },
    },
  );

describe("the dock for a question, with a composer below", () => {
  it("draws no field and no step button for a question the composer answers, and still takes picks", async () => {
    const user = userEvent.setup();
    await renderDock(QUESTIONS, ACCEPTED, { composerBelow: true });

    expect(within(readQuestionDock()).queryByLabelText("Your own answer")).toBeNull();
    for (const name of ["Next", "Send answers", "Previous"]) {
      expect(within(readQuestionDock()).queryByRole("button", { name })).toBeNull();
    }
    await user.click(findChoice("radio", "IndexedDB"));
    expect((findChoice("radio", "IndexedDB") as HTMLInputElement).checked).toBe(true);
  });

  it("keeps a masked field and a step button for a secret question, and sends its answer", async () => {
    const user = userEvent.setup();
    const { calls } = await renderDock(SECRET_QUESTION, ACCEPTED, { composerBelow: true });

    const field = readOwnAnswer();
    expect(field.getAttribute("type")).toBe("password");
    await user.type(field, "hunter2");
    await user.click(readSend());

    await waitFor(() => {
      expect(readBodies(calls)).toEqual([{ requestId: "req-2", answers: { Token: "hunter2" } }]);
    });
  });

  it("masks a secret answer also where no composer is below", async () => {
    await renderDock(SECRET_QUESTION);

    expect(readOwnAnswer().getAttribute("type")).toBe("password");
  });

  it("keeps a field that shows the typed text for a question that is not secret", async () => {
    await renderDock(ONE_QUESTION);

    expect(readOwnAnswer().getAttribute("type")).toBe("text");
  });

  it("leaves a failed send to the composer when the dock has no field", async () => {
    const user = userEvent.setup();
    const { queryClient } = await renderDockWithComposerSender(
      ONE_QUESTION,
      {
        status: 409,
        body: buildErrorBody("invalid_state", "The harness did not take the answer."),
      },
      { Storage: "IndexedDB" },
      { composerBelow: true },
    );

    await user.click(screen.getByRole("button", { name: "Send from the composer" }));
    await waitFor(() => {
      expect(queryClient.isMutating()).toBe(0);
    });

    expect(screen.getByLabelText("Failure in the draft").textContent).toBe(
      "The harness did not take the answer.",
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the failure of a send the composer made when the dock has its own field", async () => {
    const user = userEvent.setup();
    const { queryClient } = await renderDockWithComposerSender(
      ONE_QUESTION,
      {
        status: 409,
        body: buildErrorBody("invalid_state", "The harness did not take the answer."),
      },
      { Storage: "IndexedDB" },
      { composerBelow: false },
    );

    await user.click(screen.getByRole("button", { name: "Send from the composer" }));
    await waitFor(() => {
      expect(queryClient.isMutating()).toBe(0);
    });

    expect((await screen.findByRole("alert")).textContent).toBe(
      "The harness did not take the answer.",
    );
  });
});

describe("Previous in the dock", () => {
  it("is drawn from the second question on, goes back from a blank one, and keeps every answer", async () => {
    const user = userEvent.setup();
    const { calls } = await renderDock(QUESTIONS);

    expect(within(readQuestionDock()).queryByRole("button", { name: "Previous" })).toBeNull();
    await user.click(findChoice("radio", "IndexedDB"));
    await user.click(readButton("Next"));
    // The second question is blank, so Send answers is off, but Previous works.
    expect(isLocked(readSend())).toBe(true);
    expect(isLocked(readButton("Previous"))).toBe(false);
    await user.click(readButton("Previous"));

    expect(queryDockText("Question 1 of 2")).not.toBeNull();
    expect((findChoice("radio", "IndexedDB") as HTMLInputElement).checked).toBe(true);
    await user.click(readButton("Next"));
    await user.click(findChoice("checkbox", "Sync"));
    await user.click(readSend());
    await waitFor(() => {
      expect(readBodies(calls)).toEqual([BOTH_ANSWERS]);
    });
    expect(isLocked(readButton("Previous"))).toBe(true);
  });
});

describe("an async question in the dock", () => {
  it("docks folded, as one row with the agent's face and an Answer button", async () => {
    await renderDock(ASYNC_QUESTIONS);

    const dock = readFoldedDock();
    expect(within(dock).getByRole("button", { name: "Answer" })).toBeTruthy();
    expect(within(dock).queryAllByRole("radio")).toEqual([]);
    expect(within(dock).queryByLabelText("Your own answer")).toBeNull();
    expect(
      within(dock).queryByText("Which storage should drafts use?", { ignore: ".dock-mini *" }),
    ).toBeNull();
    expect(dock.querySelector(".dock-q .cr")).not.toBeNull();
  });

  it("opens the card with Answer, and folds it back with Later, keeping the answers", async () => {
    const user = userEvent.setup();
    await renderDock(ASYNC_QUESTIONS);

    await user.click(within(readFoldedDock()).getByRole("button", { name: "Answer" }));
    expect(queryDockText("Which storage should drafts use?")).not.toBeNull();
    await user.click(findChoice("radio", "IndexedDB"));
    await user.click(readButton("Next"));
    await user.click(findChoice("checkbox", "Sync"));
    await user.click(readButton("Later"));

    expect(within(readFoldedDock()).queryAllByRole("checkbox")).toEqual([]);
    await user.click(within(readFoldedDock()).getByRole("button", { name: "Answer" }));
    // The card opens on the question it was folded on, with its pick.
    expect(queryDockText("Question 2 of 2")).not.toBeNull();
    expect((findChoice("checkbox", "Sync") as HTMLInputElement).checked).toBe(true);
    await user.click(readButton("Previous"));
    expect((findChoice("radio", "IndexedDB") as HTMLInputElement).checked).toBe(true);
  });

  it("offers no Later on a question the agent waits on", async () => {
    await renderDock(QUESTIONS);

    expect(within(readQuestionDock()).queryByRole("button", { name: "Later" })).toBeNull();
    expect(within(readQuestionDock()).queryByRole("button", { name: "Answer" })).toBeNull();
  });

  it("steps and sends nothing on ↩ or ⌘↵ while it is folded", async () => {
    const user = userEvent.setup();
    const { calls } = await renderDock(ASYNC_QUESTIONS);

    focus(readFoldedDock());
    await user.keyboard("{Enter}");
    const pressed = fireEvent.keyDown(readFoldedDock(), { key: "Enter", metaKey: true });

    // ⌘↵ is still kept from the menu's Send, which would send the composer's message.
    expect(pressed).toBe(false);
    await user.click(within(readFoldedDock()).getByRole("button", { name: "Answer" }));
    expect(queryDockText("Question 1 of 2")).not.toBeNull();
    await sendBothAnswers(user);
    await waitFor(() => {
      expect(readBodies(calls)).toEqual([BOTH_ANSWERS]);
    });
  });

  it("answers in the card also with a composer below, when the question is secret", async () => {
    const user = userEvent.setup();
    const { calls } = await renderDock({ ...SECRET_QUESTION, async: true }, ACCEPTED, {
      composerBelow: true,
    });

    await user.click(
      within(readFoldedDock("The agent asked a question. It keeps working.")).getByRole("button", {
        name: "Answer",
      }),
    );
    await user.type(readOwnAnswer(), "hunter2");
    await user.click(readSend());

    await waitFor(() => {
      expect(readBodies(calls)).toEqual([{ requestId: "req-2", answers: { Token: "hunter2" } }]);
    });
  });
});

describe("picking an option in the dock", () => {
  it("moves the text typed as an answer to the end of the Message Draft it is given", async () => {
    const user = userEvent.setup();
    const { pendingSubmissions } = await renderDock(QUESTIONS, ACCEPTED, {
      messageDraftKey: "assistant:a-1",
    });
    pendingSubmissions.writeText("assistant:a-1", "Half a message  ");

    await user.type(readOwnAnswer(), "a sqlite file");
    await user.click(findChoice("radio", "IndexedDB"));

    expect((readOwnAnswer() as HTMLInputElement).value).toBe("");
    expect(pendingSubmissions.read("assistant:a-1").message.text).toBe(
      "Half a message  \n\na sqlite file",
    );
    expect(pendingSubmissions.read(FIXTURE_THREAD_IDS.runbook).message.text).toBe("");
  });
});

describe("the length of an answer in the dock", () => {
  it("shows a notice and turns the step button off over 4,096 characters", async () => {
    await renderDock(ONE_QUESTION);

    fireEvent.change(readOwnAnswer(), { target: { value: "x".repeat(4097) } });

    expect(screen.getByText(/longer than 4,096 characters/)).toBeTruthy();
    expect(isLocked(readSend())).toBe(true);
  });
});

describe("sending answers once", () => {
  it("sends once when two calls arrive before the next render", async () => {
    const user = userEvent.setup();
    const held = holdAnswer();
    const { calls } = await renderThreadPart(
      ({ sessionId }) => {
        const send = useSendAnswers(sessionId);
        return (
          <button
            type="button"
            onClick={() => {
              send("req-2", { Storage: "IndexedDB" });
              send("req-2", { Storage: "IndexedDB" });
            }}
          >
            Send twice
          </button>
        );
      },
      { thread: THREAD_FIXTURES.waiting, handlers: { [RESPOND_TO_QUESTION]: held.handler } },
    );

    await user.click(screen.getByRole("button", { name: "Send twice" }));
    held.answer(ACCEPTED);
    await user.click(screen.getByRole("button", { name: "Send twice" }));

    expect(readBodies(calls)).toEqual([{ requestId: "req-2", answers: { Storage: "IndexedDB" } }]);
  });

  it("sends the answers of two Requests independently", async () => {
    const user = userEvent.setup();
    const { calls } = await renderThreadPart(
      ({ sessionId }) => {
        const send = useSendAnswers(sessionId);
        return (
          <button
            type="button"
            onClick={() => {
              send("req-2", { Storage: "IndexedDB" });
              send("req-3", { Storage: "localStorage" });
            }}
          >
            Send both
          </button>
        );
      },
      { thread: THREAD_FIXTURES.waiting, handlers: { [RESPOND_TO_QUESTION]: ACCEPTED } },
    );

    await user.click(screen.getByRole("button", { name: "Send both" }));

    await waitFor(() => {
      expect(readBodies(calls)).toEqual([
        { requestId: "req-2", answers: { Storage: "IndexedDB" } },
        { requestId: "req-3", answers: { Storage: "localStorage" } },
      ]);
    });
  });
});
