/**
 * Tests the bubble of a message another session's agent sent into a thread,
 * against the stubbed controller: the chip that names the agent, what the
 * chip links to, and the bubble of an owner's steered message beside it.
 */
import type { JSX } from "react";
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
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
    await renderThreadPart(drawAgentMessage(RUNBOOK.id), {
      thread: THREAD,
      handlers: { [`GET /api/v1/sessions/${RUNBOOK.id}`]: { body: RUNBOOK } },
    });

    const message = await screen.findByRole("group", { name: `Message from ${RUNBOOK.title}` });
    expect(message.className).toBe("msg--me msg--agent");
    const chip = screen.getByRole("link", { name: RUNBOOK.title });
    expect(chip.getAttribute("href")).toBe(`/threads/${RUNBOOK.id}`);
    expect(message.querySelector(".bubble-meta")?.textContent).toBe("Steered · 09:14");
  });

  it("names an assistant's agent by the assistant, linked to its page", async () => {
    await renderThreadPart(drawAgentMessage(ADA_SESSION.id), {
      thread: THREAD,
      handlers: {
        "GET /api/v1/assistants": { body: { items: [ADA] } },
        [`GET /api/v1/sessions/${ADA_SESSION.id}`]: { body: ADA_SESSION },
      },
    });

    await screen.findByRole("group", { name: "Message from Ada" });
    const chip = screen.getByRole("link", { name: "Ada" });
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

    const message = await screen.findByRole("group", { name: "Message from Another agent" });
    expect(message.querySelector(".sender-chip")?.textContent).toBe("Another agent");
    expect(screen.queryByRole("link")).toBeNull();
  });
  it('calls an agent the user may not read "Another agent" too', async () => {
    await renderThreadPart(drawAgentMessage(RUNBOOK.id), {
      thread: THREAD,
      handlers: {
        [`GET /api/v1/sessions/${RUNBOOK.id}`]: {
          status: 403,
          body: buildErrorBody("forbidden", "You may not read this session."),
        },
      },
    });

    await screen.findByRole("group", { name: "Message from Another agent" });
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("a message the owner steered into a turn", () => {
  it("is the owner's bubble, with no chip, and says it was steered", async () => {
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

    const bubble = screen.getByText("Rebase onto main first.").closest(".msg--me")!;
    expect(bubble.className).toBe("msg--me");
    expect(bubble.getAttribute("role")).toBeNull();
    expect(bubble.querySelector(".msg-sender")).toBeNull();
    expect(bubble.querySelector(".bubble-meta")?.textContent).toBe("Steered · 09:14");
  });
});
