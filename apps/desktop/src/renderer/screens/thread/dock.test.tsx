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
import { buildApprovalCard } from "@hercule/client-core";
import type { OpenRequest } from "@hercule/contract";
import {
  buildErrorBody,
  FIXTURE_THREAD_IDS,
  THREAD_FIXTURES,
  type Answer,
  type Call,
  type Handler,
} from "../../app/testing";
import { RequestDock } from "./dock";
import { renderThreadPart } from "./testing";

/** A command approval that offers every decision. */
const COMMAND: OpenRequest = {
  requestId: "req-1",
  itemId: "tool-1",
  kind: "command_approval",
  decisions: ["allow", "allow_always", "deny", "cancel"],
  detail: { command: "git push" },
};

/** The operation the dock answers with. */
const RESPOND = `POST /api/v1/sessions/${FIXTURE_THREAD_IDS.runbook}/respond`;

/** The controller's answer to a Request it accepts: the session, still waiting until the runner reports. */
const ACCEPTED: Answer = { body: THREAD_FIXTURES.waiting.session };

/**
 * Renders the dock for `request` on the waiting fixture thread, with a button
 * outside it, and returns the calls and the query cache. The controller
 * accepts every answer unless `respond` says otherwise.
 */
const renderDock = (request: OpenRequest, respond: Handler = ACCEPTED) =>
  renderThreadPart(
    ({ sessionId }) => (
      <>
        <button type="button">Outside</button>
        <RequestDock sessionId={sessionId} request={request} />
      </>
    ),
    { thread: THREAD_FIXTURES.waiting, handlers: { [RESPOND]: respond } },
  );

/** Returns the decisions the dock sent, oldest first. */
const readDecisions = (calls: readonly Call[]): readonly unknown[] =>
  calls
    .filter((call) => `${call.method} ${call.path}` === RESPOND)
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
        description: row.describe,
      });
      expect(answer.querySelector("kbd")?.textContent).toBe(keys[row.decision]);
    }
    expect(
      within(readDock())
        .getAllByRole("button")
        .map((answer) => answer.getAttribute("aria-label")),
    ).toEqual(["Allow", "Allow always", "Deny", "Cancel"]);
  });

  it("shows a question's questions and options read-only, with the note that answering is not built", async () => {
    const question: OpenRequest = {
      ...COMMAND,
      kind: "question",
      decisions: ["deny", "cancel"],
      detail: {
        questions: [
          {
            question: "Which database should it use?",
            header: "Database",
            options: [
              { label: "SQLite", description: "the one Hercule ships" },
              { label: "Postgres", description: "somebody else's server" },
            ],
            multiSelect: true,
          },
        ],
      },
    };
    await renderDock(question);

    const card = buildApprovalCard(question);
    const dock = readDock("The agent needs answers.");
    for (const text of [
      "Database",
      "Which database should it use?",
      "SQLite",
      "the one Hercule ships",
      "Postgres",
      "somebody else's server",
      card.questions[0]!.note!,
      card.note!,
    ]) {
      expect(within(dock).getByText(text)).toBeTruthy();
    }
    expect(
      within(dock)
        .getAllByRole("button")
        .map((answer) => answer.getAttribute("aria-label")),
    ).toEqual(["Deny", "Cancel"]);
  });

  it("allows on ↩ when the dock itself has the focus", async () => {
    const user = userEvent.setup();
    const { calls } = await renderDock(COMMAND);

    focus(readDock());
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(readDecisions(calls)).toEqual(["allow"]);
    });
    expect(calls.find((call) => `${call.method} ${call.path}` === RESPOND)?.body).toEqual({
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
    let fail = (): void => {};
    const answers: Answer[] = [];
    const { calls } = await renderDock(COMMAND, () =>
      answers.length > 0
        ? answers.shift()!
        : new Promise<Answer>((resolve) => {
            fail = () => {
              resolve({ status: 409, body: buildErrorBody("invalid_state", "Try again.") });
            };
          }),
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
    act(() => {
      fail();
    });
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

  it("never takes the focus when it opens", async () => {
    await renderDock(COMMAND);

    expect(readDock()).toBeTruthy();
    expect(document.activeElement).toBe(document.body);
  });
});
