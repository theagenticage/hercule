/**
 * Tests the assistant route: the header's face, name and pose word, the
 * empty Conversation under it, the pose following the live connection, and
 * the screen shown when no assistant has the id, also once it is deleted.
 */
import { describe, expect, it } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import type { OpenRequest, Session } from "@hercule/contract";
import {
  buildFixtureAssistant,
  buildFixtureAssistantSession,
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  NO_SIDEBAR_RECORDS,
  renderApp,
  stubApi,
} from "../../../../app/testing";

const ADA = buildFixtureAssistant({
  id: "01a06d02-a000-7000-8000-000000000002",
  name: "Ada",
  mainConversationId: "01a06d02-c000-7000-8000-000000000002",
});

/** An assistant id no controller holds. */
const GONE_ID = "01a06d02-a000-7000-8000-0000000000ff";

const APPROVAL_REQUEST: OpenRequest = {
  requestId: "req-1",
  itemId: "tool-1",
  kind: "command_approval",
  decisions: ["allow", "deny"],
  detail: { command: "git push" },
};

/** Returns a session of Ada's main conversation, idle unless `over` says otherwise. */
const buildAdaSession = (over: Partial<Session> = {}): Session =>
  buildFixtureAssistantSession(ADA, { id: "01a06d02-a100-7000-8000-000000000001", ...over });

/**
 * Starts the app signed in at Ada's page, or at `path`, while the current
 * session of Ada's main conversation is `session`. `handlers` replace the
 * stubbed controller's answers.
 */
const openApp = (
  session: Session | null,
  { path = `/assistants/${ADA.id}`, handlers = {} }: OpenOptions = {},
) => {
  stubApi({
    ...buildSidebarHandlers({ ...NO_SIDEBAR_RECORDS, assistants: [{ assistant: ADA, session }] }),
    ...handlers,
  });
  return renderApp(createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }), { path });
};

interface OpenOptions {
  readonly path?: string;
  readonly handlers?: Parameters<typeof stubApi>[0];
}

/** Returns the header's pill, which holds the assistant's face, name and pose word. */
const readHeaderPill = (): HTMLElement => {
  const pill = document.querySelector<HTMLElement>("header.top .pill--who");
  if (pill === null) throw new Error("the assistant's header is not on screen");
  return pill;
};

describe("the assistant route", () => {
  it("shows the assistant idle, with an empty Conversation, before its first session", async () => {
    await openApp(null);

    const pill = readHeaderPill();
    expect(within(pill).getByText("Ada").tagName).toBe("B");
    const word = within(pill).getByText("idle");
    expect(word.classList.contains("you-ink")).toBe(false);
    expect(pill.querySelector(".cr")?.getAttribute("class")).toBe("cr cr--idle");

    const main = screen.getByRole("main");
    expect(within(main).getByRole("heading", { level: 2, name: "Ada" })).toBeTruthy();
    expect(
      within(main).getByText(
        "Send a message to start. Ada falls asleep after a quiet spell and picks up where it left off.",
      ),
    ).toBeTruthy();
    expect(main.querySelector(".hello-who .cr")?.getAttribute("width")).toBe("76");
  });

  it("marks the pose word in the user's ink while the assistant waits on the user", async () => {
    await openApp(buildAdaSession({ status: "busy", openRequests: [APPROVAL_REQUEST] }));

    const word = within(readHeaderPill()).getByText("waiting on you");
    expect(word.classList.contains("you-ink")).toBe(true);
  });

  it("animates the header's face only while the assistant works", async () => {
    await openApp(buildAdaSession({ status: "busy" }));

    const pill = readHeaderPill();
    expect(within(pill).getByText("working")).toBeTruthy();
    expect(pill.querySelector(".cr--animated")).not.toBeNull();
    // The face of the empty Conversation stays still and idle.
    expect(document.querySelector(".hello-who .cr")?.getAttribute("class")).toBe("cr cr--idle");
  });

  it("follows the pose when a push on the session topic reports a change", async () => {
    let session = buildAdaSession({ status: "idle" });
    const { live } = await openApp(session, {
      handlers: {
        // Answers Ada's conversation with the session as it is at each read,
        // so the test can change it, and the thread list with no threads.
        "GET /api/v1/sessions": (call) => ({
          body: { items: call.search.includes("conversationId") ? [session] : [] },
        }),
      },
    });
    expect(within(readHeaderPill()).getByText("idle")).toBeTruthy();
    await waitFor(() => {
      expect(live.readTopics()).toContain("session");
    });

    session = buildAdaSession({ status: "busy" });
    act(() => {
      live.pushInvalidation("session", [session.id]);
    });

    await waitFor(() => {
      expect(within(readHeaderPill()).getByText("working")).toBeTruthy();
    });
  });

  it("shows that an assistant is not found, with nothing to click", async () => {
    const { router } = await openApp(null, { path: `/assistants/${GONE_ID}` });

    expect(router.state.location.pathname).toBe(`/assistants/${GONE_ID}`);
    const main = screen.getByRole("main");
    expect(
      within(main).getByRole("heading", { name: "This assistant was not found." }),
    ).toBeTruthy();
    expect(within(main).queryByRole("link")).toBeNull();
    expect(within(main).queryByRole("button")).toBeNull();
  });

  it("shows that the assistant is not found when it is deleted while its page is open", async () => {
    let assistants = [ADA];
    const { live } = await openApp(null, {
      handlers: {
        // Answers with the assistants as they are at each read, so the test
        // can delete Ada.
        "GET /api/v1/assistants": () => ({ body: { items: assistants } }),
      },
    });
    expect(within(readHeaderPill()).getByText("Ada")).toBeTruthy();
    await waitFor(() => {
      expect(live.readTopics()).toContain("assistant");
    });

    assistants = [];
    act(() => {
      live.pushInvalidation("assistant", [ADA.id]);
    });

    expect(
      await within(screen.getByRole("main")).findByRole("heading", {
        name: "This assistant was not found.",
      }),
    ).toBeTruthy();
    expect(document.querySelector("header.top .pill--who")).toBeNull();
  });
});
