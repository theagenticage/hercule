/**
 * Tests the bubble of a message another session's agent sent into a thread,
 * against the stubbed controller: the chip that names the agent, what the
 * chip links to, and the bubble of an owner's steered message beside it.
 */
import type { JSX } from "react";
import { describe, expect, it } from "vitest";
import { act, screen, within } from "@testing-library/react";
import { queryKeys } from "@hercule/client-core";
import type { Session } from "@hercule/contract";
import {
  buildErrorBody,
  buildFixtureAssistant,
  buildFixtureAssistantSession,
  SIDEBAR_FIXTURE,
  THREAD_FIXTURES,
} from "../../app/testing";
import { UserMessage } from "../session/messages";
import { AgentSentMessage } from "./agent-sent-message";
import { renderThreadPart } from "./testing";

const THREAD = THREAD_FIXTURES.finished;
const SENT_AT = "2026-09-10T09:14:00.000Z";
/** Noon on the day the message was sent, so its time is printed without a date. */
const TODAY = Date.parse("2026-09-10T12:00:00.000Z");

/** "Write the retry runbook", a thread the user can read. */
const RUNBOOK = SIDEBAR_FIXTURE.threads[0]!;
const ADA = buildFixtureAssistant({
  id: "01a06d02-a000-7000-8000-000000000005",
  name: "Ada",
  mainConversationId: "01a06d02-c000-7000-8000-000000000005",
});
const ADA_SESSION = buildFixtureAssistantSession(ADA, {
  id: "01a06d02-7400-7000-8000-0000000000a5",
});
/**
 * A thread the sidebar's lists do not hold, as an archived one is, so naming
 * its agent takes a read of its own.
 */
const ARCHIVED: Session = {
  ...RUNBOOK,
  id: "01a06d02-7400-7000-8000-0000000000b1",
  title: "Archive the old runbook",
};
/** A session the controller no longer holds. */
const GONE_ID = "01a06d02-7400-7000-8000-0000000000ff";

/** Returns a part that draws one message the agent of `senderSessionId` sent. */
const drawAgentMessage = (senderSessionId: string) => (): JSX.Element => (
  <AgentSentMessage
    senderSessionId={senderSessionId}
    text="Rebase onto main first."
    attachments={[]}
    at={SENT_AT}
    timezone="UTC"
    today={TODAY}
    steered
  />
);

describe("a message another session's agent sent", () => {
  it("names a thread's agent in a chip that links to its thread", async () => {
    const { calls } = await renderThreadPart(drawAgentMessage(RUNBOOK.id), { thread: THREAD });

    const message = await screen.findByRole("group", { name: `Message from ${RUNBOOK.title}` });
    const chip = within(message).getByRole("link", { name: RUNBOOK.title });
    expect(chip.getAttribute("href")).toBe(`/threads/${RUNBOOK.id}`);
    expect(within(message).getByText("Rebase onto main first.")).toBeTruthy();
    expect(within(message).getByText("Steered · 09:14")).toBeTruthy();
    // The sidebar's list holds the thread, so naming it costs no request.
    expect(calls.filter((call) => call.path === `/api/v1/sessions/${RUNBOOK.id}`)).toHaveLength(0);
  });

  it("draws the HTML in the message, as an agent's own message does", async () => {
    await renderThreadPart(
      () => (
        <AgentSentMessage
          senderSessionId={RUNBOOK.id}
          text="Merge <b>now</b>"
          attachments={[]}
          at={SENT_AT}
          timezone="UTC"
          today={TODAY}
          steered={false}
        />
      ),
      { thread: THREAD },
    );

    const message = await screen.findByRole("group", { name: `Message from ${RUNBOOK.title}` });
    expect(within(message).getByText("now").tagName).toBe("STRONG");
  });

  it("follows the title of an agent the sidebar's list holds when a push changes it", async () => {
    const { queryClient } = await renderThreadPart(drawAgentMessage(RUNBOOK.id), {
      thread: THREAD,
    });
    await screen.findByRole("group", { name: `Message from ${RUNBOOK.title}` });

    const key = queryKeys.sessions({ thread: true });
    const threads = queryClient.getQueryData<readonly Session[]>(key)!;
    act(() => {
      queryClient.setQueryData(
        key,
        threads.map((each) =>
          each.id === RUNBOOK.id ? { ...each, title: "Ship the runbook" } : each,
        ),
      );
    });

    const message = await screen.findByRole("group", { name: "Message from Ship the runbook" });
    expect(within(message).getByRole("link", { name: "Ship the runbook" })).toBeTruthy();
  });

  it("reads an agent the sidebar's lists do not hold, once", async () => {
    const { calls } = await renderThreadPart(drawAgentMessage(ARCHIVED.id), {
      thread: THREAD,
      handlers: { [`GET /api/v1/sessions/${ARCHIVED.id}`]: { body: ARCHIVED } },
    });

    const message = await screen.findByRole("group", { name: `Message from ${ARCHIVED.title}` });
    expect(within(message).getByRole("link", { name: ARCHIVED.title }).getAttribute("href")).toBe(
      `/threads/${ARCHIVED.id}`,
    );
    expect(calls.filter((call) => call.path === `/api/v1/sessions/${ARCHIVED.id}`)).toHaveLength(1);
  });

  it("names an assistant's agent by the assistant, linked to its page", async () => {
    await renderThreadPart(drawAgentMessage(ADA_SESSION.id), {
      thread: THREAD,
      handlers: {
        "GET /api/v1/assistants": { body: { items: [ADA] } },
        [`GET /api/v1/sessions/${ADA_SESSION.id}`]: { body: ADA_SESSION },
      },
    });

    const message = await screen.findByRole("group", { name: "Message from Ada" });
    const chip = within(message).getByRole("link", { name: "Ada" });
    expect(chip.getAttribute("href")).toBe(`/assistants/${ADA.id}`);
  });

  it('calls an agent it cannot read "Another agent", with no link', async () => {
    await renderThreadPart(drawAgentMessage(GONE_ID), {
      thread: THREAD,
      handlers: {
        [`GET /api/v1/sessions/${GONE_ID}`]: {
          status: 404,
          body: buildErrorBody("not_found", "No session has this id."),
        },
      },
    });

    const message = await screen.findByRole("group", { name: "Message from another agent" });
    expect(within(message).getByText("Another agent")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it('calls an agent the user may not read "Another agent" too', async () => {
    await renderThreadPart(drawAgentMessage(ARCHIVED.id), {
      thread: THREAD,
      handlers: {
        [`GET /api/v1/sessions/${ARCHIVED.id}`]: {
          status: 403,
          body: buildErrorBody("forbidden", "You may not read this session."),
        },
      },
    });

    await screen.findByRole("group", { name: "Message from another agent" });
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("a message the owner steered into a turn", () => {
  it("names no sender and says it was steered", async () => {
    await renderThreadPart(
      () => (
        <UserMessage
          text="Rebase onto main first."
          attachments={[]}
          at={SENT_AT}
          timezone="UTC"
          today={TODAY}
          steered
        />
      ),
      { thread: THREAD },
    );

    expect(screen.getByText("Rebase onto main first.")).toBeTruthy();
    expect(screen.getByText("Steered · 09:14")).toBeTruthy();
    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByText("Another agent")).toBeNull();
  });
});
