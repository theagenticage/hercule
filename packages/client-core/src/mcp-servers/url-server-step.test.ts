import { describe, expect, it } from "vitest";
import type { McpServer } from "@hercule/contract";
import { buildServer, OFFERING_PLUGINS, CONNECTIONS } from "./testing";
import type { ServerOutcome, SignInStep, UrlServerAttemptState } from "./url-server-attempt";
import {
  describeUrlServerDialogTitle,
  describeUrlServerStep,
  type UrlServerDialog,
} from "./url-server-step";

const ADDRESS = "https://mcp.docs.example/mcp";
const IDLE = { busy: false, error: null } as const;

const urlServer = (overrides: Partial<McpServer> = {}): McpServer =>
  buildServer("s-docs", "docs", "", {
    source: { kind: "url", url: ADDRESS, signIn: "none", signInOffered: null },
    ...overrides,
  });

const ADD: UrlServerDialog = {
  kind: "add",
  plugins: undefined,
  connections: undefined,
  pluginsSettings: "here",
};

const tokenDialog = (
  openedOn: "server-page" | "elsewhere" = "elsewhere",
  server: McpServer = urlServer({ status: "needs-sign-in" }),
): UrlServerDialog => ({ kind: "token", server, openedOn, entry: "sign-in" });

const following = (
  outcome: ServerOutcome,
  overrides: Partial<Extract<UrlServerAttemptState, { kind: "following" }>> = {},
): UrlServerAttemptState => ({
  kind: "following",
  mcpServerId: "s-docs",
  server: urlServer(),
  outcome,
  problem: null,
  check: IDLE,
  ...overrides,
});

const signingIn = (step: SignInStep): UrlServerAttemptState => ({
  kind: "signing-in",
  mcpServerId: "s-docs",
  step,
});

const waiting = (
  overrides: Partial<Extract<SignInStep, { kind: "waiting" }>> = {},
): SignInStep => ({
  kind: "waiting",
  authorizationUrl: "https://auth.docs.example/authorize?state=x",
  approvalHost: "auth.docs.example",
  expiresAt: "2026-11-23T10:10:00.000Z",
  returnBy: "listener",
  opened: false,
  openError: null,
  pasteProblem: null,
  ...overrides,
});

const ended = (
  reason: "gone" | "moved" | "closed",
  overrides: Partial<Extract<UrlServerAttemptState, { kind: "ended" }>> = {},
): UrlServerAttemptState => ({
  kind: "ended",
  reason,
  mcpServerId: "s-docs",
  name: "docs",
  message: null,
  ...overrides,
});

describe("the title of the dialog", () => {
  it("is one title for Add, and the sign-in heading of the server for a token form", () => {
    expect(describeUrlServerDialogTitle(ADD)).toBe("Add an MCP server");
    expect(describeUrlServerDialogTitle(tokenDialog())).toBe("Sign in to docs");
    expect(
      describeUrlServerDialogTitle(tokenDialog("server-page", urlServer({ status: "ready" }))),
    ).toBe("Replace the token of docs");
  });
});

describe("the first step of Add", () => {
  it("shows no problem for a form that was not refused", () => {
    expect(describeUrlServerStep({ kind: "form", problem: null }, ADD)).toEqual({
      kind: "add-form",
      refusal: null,
      addressIssue: null,
      nameIssue: null,
      problemText: null,
      closingNote: null,
    });
  });

  it("words the duplicate with its button, and the plugin's offer with a sentence for the app that has no Plugins page", () => {
    const exists = describeUrlServerStep(
      {
        kind: "form",
        problem: {
          kind: "exists",
          mcpServerId: "s-docs",
          existing: { kind: "found", name: "docs" },
        },
      },
      ADD,
    );
    expect(exists).toMatchObject({
      refusal: { action: { kind: "open-server", label: "Open docs" } },
    });

    const offered = (pluginsSettings: "here" | "web-app") =>
      describeUrlServerStep(
        {
          kind: "form",
          problem: {
            kind: "plugin-origin",
            refusal: { contributionId: "sentry/sentry", connectionId: null },
            message: "The controller's words.",
          },
        },
        {
          kind: "add",
          plugins: [{ ...OFFERING_PLUGINS[0]!, enabled: false }],
          connections: CONNECTIONS,
          pluginsSettings,
        },
      );
    expect(offered("here")).toMatchObject({ refusal: { action: { kind: "open-plugins" } } });
    expect(offered("web-app")).toMatchObject({ refusal: { action: null } });
  });

  it("puts the controller's issues at the fields, and any other failure under the form, without drawing the plugin's sentence twice", () => {
    expect(
      describeUrlServerStep(
        {
          kind: "form",
          problem: {
            kind: "invalid",
            issues: { address: "Bad address.", name: "Bad name.", token: null, other: "Other." },
          },
        },
        ADD,
      ),
    ).toMatchObject({
      addressIssue: "Bad address.",
      nameIssue: "Bad name.",
      problemText: "Other.",
    });
    expect(
      describeUrlServerStep({ kind: "form", problem: { kind: "failed", message: "offline" } }, ADD),
    ).toMatchObject({ problemText: "offline" });
    expect(
      describeUrlServerStep(
        {
          kind: "form",
          problem: {
            kind: "plugin-origin",
            refusal: { contributionId: "sentry/sentry", connectionId: null },
            message: "The Sentry plugin offers this.",
          },
        },
        ADD,
      ),
    ).toMatchObject({
      problemText: null,
      refusal: { sentence: [{ text: "The Sentry plugin offers this." }] },
    });
  });
});

describe("the sign-in form", () => {
  it("names the server and its address in Add, and not in a dialog whose title names it", () => {
    const state = following(
      { kind: "needs-token", detail: null, refusedWrite: null },
      {
        server: urlServer({ status: "needs-sign-in" }),
      },
    );

    expect(describeUrlServerStep(state, ADD)).toMatchObject({
      kind: "token-form",
      subject: { name: "docs", address: ADDRESS },
    });
    expect(describeUrlServerStep(state, tokenDialog())).toMatchObject({
      kind: "token-form",
      subject: null,
    });
  });

  it("waits for the record in Add, and uses the record the dialog opened with in a token form", () => {
    const needsToken: ServerOutcome = { kind: "needs-token", detail: null, refusedWrite: null };

    expect(describeUrlServerStep(following(needsToken, { server: null }), ADD)).toMatchObject({
      kind: "wait",
      text: "Reading the server…",
    });
    expect(
      describeUrlServerStep(following(needsToken, { server: null }), tokenDialog()),
    ).toMatchObject({
      kind: "token-form",
    });
  });

  it("says why the controller's check refused what this attempt wrote, in the same words wherever it is drawn", () => {
    const refused = (
      refusedWrite: "token" | "sign-in" | null,
      detail: string | null,
      dialog: UrlServerDialog,
    ) =>
      describeUrlServerStep(following({ kind: "needs-token", detail, refusedWrite }), dialog) as {
        refusedReason: string | null;
      };

    for (const dialog of [ADD, tokenDialog()]) {
      expect(refused("token", "No good.", dialog).refusedReason).toBe("No good.");
      expect(refused("token", null, dialog).refusedReason).toBe("The server refused this token.");
      // A browser sign-in that was refused never says "token".
      expect(refused("sign-in", null, dialog).refusedReason).toBe(
        "The server did not accept the sign-in.",
      );
      expect(refused(null, "The server asks for a sign-in.", dialog).refusedReason).toBeNull();
    }
  });

  it("leads from the way that was written, whatever button opened the dialog, and from the button before anything was written", () => {
    const oauth = urlServer({
      status: "needs-sign-in",
      source: { kind: "url", url: ADDRESS, signIn: "none", signInOffered: "oauth" },
    });
    const method = (state: UrlServerAttemptState, entry: "replace-token" | "sign-in-again") =>
      (
        describeUrlServerStep(state, {
          kind: "token",
          server: oauth,
          openedOn: "elsewhere",
          entry,
        }) as {
          words: { method: string };
        }
      ).words.method;

    expect(method({ kind: "form", problem: null }, "replace-token")).toBe("token");
    expect(method({ kind: "form", problem: null }, "sign-in-again")).toBe("browser");
    expect(
      method(
        following({ kind: "needs-token", detail: null, refusedWrite: "token" }, { server: oauth }),
        "sign-in-again",
      ),
    ).toBe("token");
    expect(
      method(
        following(
          { kind: "needs-token", detail: null, refusedWrite: "sign-in" },
          { server: oauth },
        ),
        "replace-token",
      ),
    ).toBe("browser");
  });

  it("shows the reason only a token works as the form's problem", () => {
    const step = describeUrlServerStep(
      {
        kind: "form",
        problem: { kind: "sign-in-unsupported", message: "Paste a token instead." },
      },
      tokenDialog(),
    );

    expect(step).toMatchObject({
      words: { problemText: "Paste a token instead.", method: "token" },
    });
  });
});

describe("the waits", () => {
  it("says what the write does, and offers Close", () => {
    expect(describeUrlServerStep({ kind: "writing", write: "create" }, ADD)).toMatchObject({
      kind: "wait",
      text: "Asking the server what it needs…",
      button: { kind: "close", label: "Close" },
    });
    expect(describeUrlServerStep({ kind: "writing", write: "token" }, tokenDialog())).toMatchObject(
      {
        text: "Saving the token…",
      },
    );
  });

  it("names the host of the server it asks, or the server when the record is not read", () => {
    expect(describeUrlServerStep(following({ kind: "checking" }), ADD)).toMatchObject({
      text: "Asking mcp.docs.example for its tools…",
    });
    expect(
      describeUrlServerStep(following({ kind: "checking" }, { server: null }), ADD),
    ).toMatchObject({
      text: "Asking the server for its tools…",
    });
    expect(
      describeUrlServerStep(following({ kind: "reading" }, { server: null }), ADD),
    ).toMatchObject({
      text: "Reading the server…",
    });
  });

  it("offers Cancel while the sign-in starts, and nothing while it finishes", () => {
    expect(describeUrlServerStep(signingIn({ kind: "starting" }), ADD)).toMatchObject({
      text: "Preparing the sign-in…",
      button: { kind: "cancel-sign-in", label: "Cancel" },
    });
    expect(describeUrlServerStep(signingIn({ kind: "finishing" }), ADD)).toMatchObject({
      text: "Finishing the sign-in…",
      button: null,
    });
  });
});

describe("the sign-in that waits for the browser", () => {
  it("names the host before the browser opens, and offers the button that opens it, then Open again", () => {
    const before = describeUrlServerStep(signingIn(waiting()), ADD);
    const after = describeUrlServerStep(signingIn(waiting({ opened: true })), ADD);

    expect(before).toMatchObject({
      kind: "sign-in-waiting",
      heading: "Finish in your browser",
      approval: "You will approve on auth.docs.example.",
      open: { label: "Open auth.docs.example", url: "https://auth.docs.example/authorize?state=x" },
    });
    expect(after).toMatchObject({ open: { label: "Open again" } });
  });

  it("says the desktop app finishes by itself and keeps the paste behind a question, while the web app asks for the paste at once", () => {
    const listener = describeUrlServerStep(signingIn(waiting()), ADD);
    const paste = describeUrlServerStep(signingIn(waiting({ returnBy: "paste" })), ADD);

    expect(listener).toMatchObject({
      instruction: expect.stringContaining("finishes by itself") as string,
      paste: {
        alwaysShown: false,
        question: "Approved, and the browser did not come back here?",
        toggle: "Paste the browser's address…",
      },
    });
    expect(paste).toMatchObject({
      instruction: expect.stringContaining("paste it here") as string,
      paste: {
        alwaysShown: true,
        question: null,
        toggle: null,
        label: "Address the browser ended on",
      },
    });
  });

  it("shows the paste field when the last address was refused, and why the browser did not open", () => {
    const step = describeUrlServerStep(
      signingIn(waiting({ pasteProblem: "That is not it.", openError: "no browser" })),
      ADD,
    );

    expect(step).toMatchObject({
      openError: "The browser did not open the sign-in page: no browser",
      paste: { alwaysShown: true, problem: "That is not it." },
    });
  });

  it("says why a sign-in ended, with Start again", () => {
    expect(
      describeUrlServerStep(
        signingIn({ kind: "refused", reason: "timed-out", message: "It timed out." }),
        ADD,
      ),
    ).toMatchObject({
      kind: "sign-in-refused",
      message: "It timed out.",
      startAgain: { label: "Start again" },
    });
  });
});

describe("what the check found", () => {
  it("words a failed check with the host of the address, for both statuses", () => {
    const failed = (status: "unreachable" | "error", server: McpServer | null) =>
      describeUrlServerStep(
        following({ kind: "failed", status, detail: "timed out" }, { server }),
        ADD,
      );

    expect(failed("unreachable", urlServer())).toMatchObject({
      headline: "mcp.docs.example could not be reached.",
      detail: "timed out",
    });
    expect(failed("error", urlServer())).toMatchObject({
      headline: "mcp.docs.example answered in a way Hercule could not use.",
    });
    expect(failed("error", null)).toMatchObject({
      headline: "the server answered in a way Hercule could not use.",
    });
  });

  it("offers Check now, busy while it waits, with the controller's refusal of the last press", () => {
    expect(
      describeUrlServerStep(
        following(
          { kind: "failed", status: "unreachable", detail: null },
          { check: { busy: true, error: "Switched off." } },
        ),
        ADD,
      ),
    ).toMatchObject({ checkNow: { label: "Check now", busy: true }, checkError: "Switched off." });
  });

  it("counts the tools of a ready server, and ends only a new server with the note that no project names it", () => {
    const ready = (newServer: boolean) =>
      describeUrlServerStep(
        following(
          { kind: "ready", toolCount: 1, newServer },
          { server: urlServer({ status: "ready" }) },
        ),
        ADD,
      );

    expect(ready(true)).toMatchObject({
      name: "docs",
      address: ADDRESS,
      summary: "ready · 1 tool",
      newServerNote: expect.stringContaining("No project names it yet") as string,
      close: { label: "Done" },
    });
    expect(ready(false)).toMatchObject({ newServerNote: null });
    expect(
      describeUrlServerStep(following({ kind: "ready", toolCount: 4, newServer: false }), ADD),
    ).toMatchObject({ summary: "ready · 4 tools" });
  });

  it("says what a switched-off server keeps, and says the read failed apart from the check", () => {
    expect(describeUrlServerStep(following({ kind: "off", saved: null }), ADD)).toMatchObject({
      text: "This server is switched off, so it is not checked.",
    });
    expect(describeUrlServerStep(following({ kind: "off", saved: "token" }), ADD)).toMatchObject({
      text: "The token is saved. This server is switched off, so checking runs when it is switched on.",
    });
    expect(describeUrlServerStep(following({ kind: "off", saved: "sign-in" }), ADD)).toMatchObject({
      text: expect.stringContaining("The sign-in is saved.") as string,
    });
    expect(
      describeUrlServerStep(following({ kind: "read-failed", message: "offline" }), ADD),
    ).toMatchObject({
      kind: "read-failed",
      headline: "The server could not be read, so what the check found is not known.",
      body: "It may have succeeded. offline",
      tryAgain: { label: "Try again" },
    });
  });
});

describe("the end of an attempt", () => {
  it("says the server was removed, and says a server on a Connection has the Connection's sign-in", () => {
    expect(describeUrlServerStep(ended("gone"), ADD)).toMatchObject({
      kind: "ended",
      headline: "docs was removed.",
      body: "There is nothing more to do here.",
    });
    expect(describeUrlServerStep(ended("gone", { name: null }), ADD)).toMatchObject({
      headline: "This server was removed.",
    });
    expect(describeUrlServerStep(ended("moved"), ADD)).toMatchObject({
      headline: "docs is reached with a Connection now.",
      body: "Its sign-in is the Connection's, not a token.",
    });
    expect(
      describeUrlServerStep(ended("moved", { message: "Use the Connection." }), ADD),
    ).toMatchObject({
      body: "Use the Connection.",
    });
  });

  it("draws nothing for a closed dialog", () => {
    expect(describeUrlServerStep(ended("closed"), ADD)).toEqual({
      kind: "closed",
      closingNote: null,
    });
  });
});

describe("the Open button", () => {
  it("is offered on a failed check wherever the dialog was opened from, even a thread, but never on the server's own page", () => {
    const failed = following({ kind: "failed", status: "unreachable", detail: null });

    expect(describeUrlServerStep(failed, tokenDialog("elsewhere"))).toMatchObject({
      open: { mcpServerId: "s-docs", label: "Open docs" },
    });
    expect(describeUrlServerStep(failed, tokenDialog("server-page"))).toMatchObject({ open: null });
  });

  it("is offered for the off outcome, a record that moved onto a Connection, and a ready server this dialog created, and for no other outcome", () => {
    const open = (state: UrlServerAttemptState) =>
      (describeUrlServerStep(state, ADD) as { open?: unknown }).open ?? null;

    expect(open(following({ kind: "off", saved: null }))).not.toBeNull();
    expect(open(ended("moved"))).toMatchObject({ label: "Open docs" });
    expect(open(ended("gone"))).toBeNull();
    expect(open(following({ kind: "ready", toolCount: 1, newServer: true }))).not.toBeNull();
    expect(open(following({ kind: "ready", toolCount: 1, newServer: false }))).toBeNull();
  });
});

describe("what closing does", () => {
  const note = (state: UrlServerAttemptState, dialog: UrlServerDialog) =>
    describeUrlServerStep(state, dialog).closingNote;

  it("says the server stays in the list in Add, which creates it", () => {
    expect(note({ kind: "writing", write: "create" }, ADD)).toBe(
      "The check creates the server. Closing now leaves it in the list, whatever the check finds.",
    );
    expect(note(following({ kind: "checking" }), ADD)).toBe("The server stays in the list.");
    expect(note(signingIn({ kind: "starting" }), ADD)).toBe(
      "Closing now ends the sign-in. The server stays in the list.",
    );
    expect(note(following({ kind: "ready", toolCount: 1, newServer: true }), ADD)).toBeNull();
  });

  it("says nothing of the list in a token form, which never created the server", () => {
    expect(note(following({ kind: "checking" }), tokenDialog())).toBeNull();
    expect(note(signingIn({ kind: "starting" }), tokenDialog())).toBe(
      "Closing now ends the sign-in.",
    );
    expect(note({ kind: "writing", write: "token" }, tokenDialog())).toBe(
      "The token is being saved. Closing now does not undo it.",
    );
    expect(note(signingIn({ kind: "finishing" }), tokenDialog())).toBe(
      "The sign-in is being finished. Closing now does not undo it.",
    );
  });
});
