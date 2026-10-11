import { describe, expect, it } from "vitest";
import { MAX_NOTIFICATION_BODY_LENGTH } from "@hercule/contract";
import type { OpenRequest } from "@hercule/protocol";
import {
  buildApprovalNotification,
  buildWaitEndedWithdrawReason,
  buildWithdrawReason,
} from "./approval-notification";

const SESSION = { id: "0199e0e7-1111-7000-8000-000000000000", title: "Fix the login" };

const COMMAND: OpenRequest = {
  requestId: "req-1",
  itemId: "i1",
  kind: "command_approval",
  decisions: ["allow", "allow_always", "deny", "cancel"],
  detail: { command: "pnpm test" },
};

describe("buildApprovalNotification", () => {
  it("offers every decision the request accepts, each bound to session.respondToApprovalRequest", () => {
    const notification = buildApprovalNotification(SESSION, COMMAND);

    expect(notification).toEqual({
      kind: "core.approval",
      title: "Run `pnpm test`?",
      body: "The session ` Fix the login ` is waiting for your answer.\n\n```\npnpm test\n```",
      subject: [
        { kind: "session", id: SESSION.id },
        { kind: "request", sessionId: SESSION.id, requestId: "req-1" },
      ],
      actions: [
        ["allow", "Allow", "Runs the command this once; the agent asks again next time.", "allow"],
        [
          "allow-always",
          "Allow always",
          "Runs the command and stops asking for it while this thread keeps running.",
          "allow_always",
        ],
        ["deny", "Deny", "Denies the command; the agent is told and continues.", "deny"],
        ["cancel", "Cancel", "Denies the command and stops the turn.", "cancel"],
      ].map(([id, label, description, sent]) => ({
        id,
        label,
        description,
        operation: {
          op: "session.respondToApprovalRequest",
          input: { sessionId: SESSION.id, requestId: "req-1", decision: sent },
        },
      })),
    });
  });

  it("shows a hostile session title as inline code, so it cannot add a link", () => {
    const hostile = { ...SESSION, title: "[Renew](https://evil.example)" };
    expect(buildApprovalNotification(hostile, COMMAND)?.body).toMatch(
      /^The session ` \[Renew\]\(https:\/\/evil\.example\) ` is waiting/,
    );
  });

  it("starts the body with the subagent that asked, or with a subagent when it has no name", () => {
    const asked = { ...COMMAND, subagentId: "a1" };
    expect(buildApprovalNotification(SESSION, asked, "Review the diff")?.body).toMatch(
      /^Asked by ` Review the diff `\n\nThe session ` Fix the login ` is waiting/,
    );
    expect(buildApprovalNotification(SESSION, asked)?.body).toMatch(
      /^Asked by a subagent\n\nThe session/,
    );
    // A name is the parent agent's text, so it cannot format the body.
    const hostile = "# Fix [it](https://x.example) `now` *please*";
    expect(buildApprovalNotification(SESSION, asked, hostile)?.body?.split("\n\n")[0]).toBe(
      "Asked by `` # Fix [it](https://x.example) `now` *please* ``",
    );
    // The main agent's own Request names no asker, whatever is passed.
    expect(buildApprovalNotification(SESSION, COMMAND, "ignored")?.body).toMatch(/^The session/);
  });

  it("offers only the decisions the request accepts, in the request's order", () => {
    const notification = buildApprovalNotification(SESSION, {
      ...COMMAND,
      decisions: ["deny", "allow"],
    });

    expect(notification?.actions?.map((action) => action.id)).toEqual(["deny", "allow"]);
  });

  it("raises nothing for a question, which no answer could be bound to", () => {
    const question: OpenRequest = {
      requestId: "req-2",
      itemId: "i2",
      kind: "question",
      detail: {
        questions: [{ question: "Which one?", header: "Pick", options: [], multiSelect: false }],
      },
    };

    expect(buildApprovalNotification(SESSION, question)).toBeUndefined();
  });

  it("names a single path in the title and lists the paths in the body", () => {
    const one = buildApprovalNotification(SESSION, {
      requestId: "req-3",
      itemId: "i3",
      kind: "file_change_approval",
      decisions: ["allow", "deny"],
      detail: { paths: ["src/app.ts"] },
    });
    const two = buildApprovalNotification(SESSION, {
      requestId: "req-4",
      itemId: "i4",
      kind: "file_read_approval",
      decisions: ["allow", "deny"],
      detail: { paths: ["a.ts", "b.ts"] },
    });

    expect(one?.title).toBe("Change src/app.ts?");
    expect(one?.body).toContain("- ` src/app.ts `");
    expect(two?.title).toBe("Read 2 files?");
    expect(two?.body).toContain("- ` a.ts `\n- ` b.ts `");
  });

  it("names the tool of a tool approval", () => {
    const notification = buildApprovalNotification(
      { ...SESSION, title: "" },
      {
        requestId: "req-5",
        itemId: "i5",
        kind: "tool_approval",
        decisions: ["allow", "deny"],
        detail: { toolName: "WebFetch" },
      },
    );

    expect(notification?.title).toBe("Run WebFetch?");
    expect(notification?.body).toBe("A session is waiting for your answer.");
  });

  it("keeps the title to the first line of a long command, and the whole command in the body", () => {
    const command = `${"x".repeat(100)}\nsecond line`;

    const notification = buildApprovalNotification(SESSION, { ...COMMAND, detail: { command } });

    expect(notification?.title).toBe(`Run \`${"x".repeat(79)}…\`?`);
    expect(notification?.body).toContain(command);
  });

  it("fences a command that contains a code fence with a longer fence", () => {
    const command = "echo '```'";

    const notification = buildApprovalNotification(SESSION, { ...COMMAND, detail: { command } });

    expect(notification?.body).toContain(`\`\`\`\`\n${command}\n\`\`\`\``);
  });

  it("lists at most twenty paths, so a long list stays whole under the body limit", () => {
    // The longest paths a runner may report, each a run of backticks, so each
    // needs the longest fence.
    const paths = Array.from(
      { length: 300 },
      (_, index) => `${String(index).padStart(3, "0")}${"`".repeat(509)}`,
    );

    const notification = buildApprovalNotification(SESSION, {
      requestId: "req-6",
      itemId: "i6",
      kind: "file_change_approval",
      decisions: ["allow", "deny"],
      detail: { paths },
    });

    const body = notification?.body ?? "";
    expect(body.length).toBeLessThanOrEqual(MAX_NOTIFICATION_BODY_LENGTH);
    const fence = "`".repeat(510);
    const listed = body.split("\n").filter((line) => line.startsWith("- "));
    expect(listed).toEqual([
      ...paths.slice(0, 20).map((path) => `- ${fence} ${path} ${fence}`),
      "- and 280 more",
    ]);
  });
});

describe("buildWithdrawReason", () => {
  it("returns why the notification is withdrawn, for each event that closes a request", () => {
    const base = { eventId: "e1", sessionId: SESSION.id, at: "2026-09-28T10:00:00.000Z" };

    expect(
      buildWithdrawReason({
        ...base,
        _tag: "request.resolved",
        requestId: "r",
        decision: "deny",
      }),
    ).toBe("The harness settled the request without this answer.");
    expect(
      buildWithdrawReason({ ...base, _tag: "turn.completed", turnId: "t", state: "completed" }),
    ).toBe("The turn ended before the request was answered.");
    expect(buildWithdrawReason({ ...base, _tag: "session.exited", reason: "stopped" })).toBe(
      "The session ended before the request was answered.",
    );
  });
});

describe("buildWaitEndedWithdrawReason", () => {
  it("returns why the notification is withdrawn, for each way the user ends the wait", () => {
    expect(buildWaitEndedWithdrawReason("interrupted")).toBe(
      "The turn was interrupted before the request was answered.",
    );
    expect(buildWaitEndedWithdrawReason("stopped")).toBe(
      "The session was stopped before the request was answered.",
    );
  });
});
