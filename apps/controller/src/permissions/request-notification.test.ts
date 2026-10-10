/**
 * Tests the `core.permission-request` notification: how its title names the
 * asking session, what its body shows, and the three answers it offers.
 */
import { describe, expect, it } from "vitest";
import { MAX_NOTIFICATION_BODY_LENGTH } from "@hercule/contract";
import {
  buildPermissionRequestNotification,
  type PermissionRequestNotificationInput,
} from "./request-notification";

const REQUEST_ID = "0199e0e7-0000-7000-8000-000000000001";
const SESSION_ID = "0199e0e7-0000-7000-8000-000000000002";

const INPUT: PermissionRequestNotificationInput = {
  requestId: REQUEST_ID,
  sessionId: SESSION_ID,
  sessionTitle: "Fix the build",
  agentName: "triager",
  profileName: "worker",
  grant: "task.delete",
  reason: "It duplicates another task.",
  operation: undefined,
};

describe("buildPermissionRequestNotification", () => {
  it("names the session by its title, then its Agent, then neither", () => {
    expect(buildPermissionRequestNotification(INPUT).title).toBe(
      "` Fix the build ` asks for `task.delete`",
    );
    expect(buildPermissionRequestNotification({ ...INPUT, sessionTitle: "" }).title).toBe(
      "` triager ` asks for `task.delete`",
    );
    expect(
      buildPermissionRequestNotification({ ...INPUT, sessionTitle: "", agentName: undefined })
        .title,
    ).toBe("A session asks for `task.delete`");
  });

  it("shortens a long title to one line", () => {
    const { title } = buildPermissionRequestNotification({
      ...INPUT,
      sessionTitle: `${"x".repeat(100)}\nsecond line`,
    });
    expect(title).toBe(`\` ${"x".repeat(79)}… \` asks for \`task.delete\``);
  });

  it("shows the reason and the refused call as code blocks, so neither can format the body", () => {
    const { body } = buildPermissionRequestNotification({
      ...INPUT,
      reason: "See ```this``` and [a link](https://example.com).",
      operation: { op: "task.delete", input: { id: "t-1" } },
    });
    expect(body).toBe(
      [
        "The session ` Fix the build ` of ` triager ` asks for `task.delete`, which its " +
          "permission profile ` worker ` does not grant. Its reason:",
        "````\nSee ```this``` and [a link](https://example.com).\n````",
        "It wants to run `task.delete` with:",
        '```\n{"id":"t-1"}\n```',
      ].join("\n\n"),
    );
  });

  it("shows a hostile session title as inline code in the title and the body", () => {
    const hostile = "[Renew](https://evil.example)";
    const notification = buildPermissionRequestNotification({ ...INPUT, sessionTitle: hostile });
    expect(notification.title).toBe(`\` ${hostile} \` asks for \`task.delete\``);
    expect(notification.body).toMatch(/^The session ` \[Renew\]\(https:\/\/evil\.example\) ` of/);
  });

  it("keeps a multiline agent name on one line, so a blank line cannot end its code span", () => {
    const hostile = "Ada\n\n[Renew credentials](https://evil.example)";
    const body =
      buildPermissionRequestNotification({ ...INPUT, sessionTitle: "", agentName: hostile }).body ??
      "";
    expect(body).toContain("of ` Ada [Renew credentials](https://evil.example) ` asks");
  });

  it("shows a deeply nested input whole, closing fence included", () => {
    // About 4 KB of JSON. Indented, it would grow past the 64 KB body limit.
    const input = JSON.parse(`${"[".repeat(1000)}"end"${"]".repeat(1000)}`) as unknown;
    const body =
      buildPermissionRequestNotification({ ...INPUT, operation: { op: "task.delete", input } })
        .body ?? "";
    expect(body.endsWith(`\`\`\`\n${JSON.stringify(input)}\n\`\`\``)).toBe(true);
    expect(body.length).toBeLessThan(MAX_NOTIFICATION_BODY_LENGTH);
  });

  it("is about the session and the request, and offers the three outcomes bound to permission.decide", () => {
    const notification = buildPermissionRequestNotification(INPUT);
    expect(notification.kind).toBe("core.permission-request");
    expect(notification.subject).toEqual([
      { kind: "session", id: SESSION_ID },
      { kind: "permissionRequest", id: REQUEST_ID },
    ]);
    expect(notification.actions).toEqual([
      {
        id: "session",
        label: "This session only",
        description: "Lets this session use task.delete; other sessions still ask.",
        operation: {
          op: "permission.decide",
          input: { requestId: REQUEST_ID, outcome: "session" },
        },
      },
      {
        id: "profile",
        label: "Add to profile",
        description: "Adds task.delete to the profile worker; every session on it gains the grant.",
        operation: {
          op: "permission.decide",
          input: { requestId: REQUEST_ID, outcome: "profile" },
        },
      },
      {
        id: "deny",
        label: "Deny",
        description: "Refuses task.delete; the agent is told and continues.",
        operation: { op: "permission.decide", input: { requestId: REQUEST_ID, outcome: "deny" } },
      },
    ]);
  });
});
