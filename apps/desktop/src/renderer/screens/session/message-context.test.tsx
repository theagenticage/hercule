/**
 * Tests what hangs under a user message that carried context: a live card for
 * each thing, and the fold with the block as sent. Cards are read from the
 * stubbed controller.
 */
import { describe, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import {
  appendPromptContext,
  type Attachment,
  splitPromptContext,
  type EntityCard,
  type PromptContextBlock,
} from "@hercule/contract";
import type { Call } from "@hercule/client-core/testing";
import { THREAD_FIXTURES } from "../../app/testing";
import { entityCardsQuery } from "../../app/queries";
import { AgentSentMessage } from "../thread/agent-sent-message";
import { renderThreadPart } from "../thread/testing";
import { hasSameMessageProps, UserMessage } from "./messages";

const THREAD = THREAD_FIXTURES.finished;
const IMAGE: Attachment = {
  id: "01a06d02-9000-7000-8000-0000000000a1",
  name: "shot.png",
  mimeType: "image/png",
  sizeBytes: 10,
};
const ISSUE_ID = "01a06d02-9000-7000-8000-000000000001";
const ERROR_ID = "01a06d02-9000-7000-8000-000000000002";
const ISSUE_REF = "linear:issue:northwind/SHOP-142";
const ERROR_REF = "sentry:error:storefront-1z9";

const ISSUE: EntityCard = {
  id: ISSUE_ID,
  ref: ISSUE_REF,
  kind: "linear/issue",
  noun: "Issue",
  identifier: "SHOP-142",
  title: "Show the delivery cost",
  face: null,
  restricted: false,
};
const ERROR: EntityCard = {
  id: ERROR_ID,
  ref: ERROR_REF,
  kind: "sentry/error",
  noun: "Error",
  identifier: "STOREFRONT-1Z9",
  title: "TypeError: Cannot read properties of undefined",
  status: { shape: "alert", tone: "bad", label: "Escalating" },
  face: { fact: { key: "events", type: "number", label: "Events", number: 1211 } },
  restricted: false,
};
const CARDS_PATH = "POST /api/v1/external-entities/cards";

const CONTEXT_TEXT = appendPromptContext("", {
  origin: { kind: "selection" },
  things: [
    { entityId: ISSUE_ID, ref: ISSUE_REF, title: "Show the delivery cost", fields: [] },
    { entityId: ERROR_ID, ref: ERROR_REF, title: "TypeError · kept in the block", fields: [] },
  ],
});
const CONTEXT = splitPromptContext(`Look into these.\n\n${CONTEXT_TEXT}`).context!;

const drawMessage = () => (): React.JSX.Element => (
  <UserMessage
    text="Look into these."
    context={CONTEXT}
    attachments={[]}
    at="2026-11-13T09:41:00.000Z"
    timezone="UTC"
    today={Date.parse("2026-11-13T12:00:00.000Z")}
  />
);

/**
 * Renders the message, with the controller answering one read of the cards.
 * `answer` is the reply for the ids asked; the default leaves out the ids in
 * `gone` and answers the issue and the error otherwise. `failing.now` makes
 * the read fail with a `forbidden` refusal.
 */
const renderMessage = (
  answer: (ids: readonly string[]) => readonly EntityCard[] = (ids) =>
    [ISSUE, ERROR].filter((card) => ids.includes(card.id)),
  failing?: { now: boolean },
) =>
  renderThreadPart(drawMessage(), {
    thread: THREAD,
    handlers: {
      [CARDS_PATH]: (call) =>
        failing?.now === true
          ? {
              status: 403,
              body: {
                error: { code: "forbidden", message: "No.", details: { grant: "task.read" } },
              },
            }
          : { body: { cards: answer((call.body as { ids: string[] }).ids) } },
    },
  });

const cardCalls = (calls: readonly Call[]) =>
  calls.filter((call) => `${call.method} ${call.path}` === CARDS_PATH);

describe("the cards under a message with context", () => {
  it("draws each thing from its live read: source, identifier, title, status and fact", async () => {
    await renderMessage();

    const error = (await screen.findByText("STOREFRONT-1Z9")).closest("li")!;
    expect(within(error).getByText("TypeError: Cannot read properties of undefined")).toBeTruthy();
    expect(within(error).getByText("sentry · Error")).toBeTruthy();
    expect(within(error).getByText("Escalating")).toBeTruthy();
    expect(within(error).getByText("1,211 events")).toBeTruthy();
    const issue = screen.getByText("SHOP-142").closest("li")!;
    expect(within(issue).getByText("Show the delivery cost")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("reads all the things of one message in one request, in the order of the block", async () => {
    const { calls } = await renderMessage();
    await screen.findByText("1,211 events");

    expect(cardCalls(calls).map((call) => call.body)).toEqual([{ ids: [ISSUE_ID, ERROR_ID] }]);
  });

  it("draws the title the block kept, and no identifier, for a thing the reply leaves out", async () => {
    await renderMessage((ids) => (ISSUE.id === ids[0] ? [ISSUE] : []));

    await screen.findByText("SHOP-142");
    const card = screen.getByText("TypeError · kept in the block").closest("li")!;
    expect(within(card).queryByText("STOREFRONT-1Z9")).toBeNull();
    expect(within(card).queryByText("Escalating")).toBeNull();
  });

  it("draws a locked card, with no title, for a thing the user cannot read", async () => {
    await renderMessage(() => [
      ISSUE,
      {
        id: ERROR_ID,
        ref: ERROR_REF,
        kind: "sentry/error",
        noun: "Error",
        face: null,
        restricted: true,
      },
    ]);

    await screen.findByText("SHOP-142");
    const card = screen.getByText("An error you cannot open").closest("li")!;
    expect(card.className).toContain("is-locked");
    expect(screen.queryByText("STOREFRONT-1Z9")).toBeNull();
    expect(screen.queryByText("TypeError · kept in the block")).toBeNull();
  });

  it("keeps the last known facts of a thing that lost access, and says they are last known", async () => {
    await renderMessage(() => [ISSUE, { ...ERROR, access: "inaccessible" }]);

    const error = (await screen.findByText("STOREFRONT-1Z9")).closest("li")!;
    expect(within(error).getByText("Escalating")).toBeTruthy();
    expect(within(error).getByText("Last known state - you can no longer open it")).toBeTruthy();
    const issue = screen.getByText("SHOP-142").closest("li")!;
    expect(within(issue).queryByText(/Last known state/)).toBeNull();
  });

  it("asks once when the read is refused for good, and does not retry", async () => {
    const { queryClient, client, calls } = await renderMessage(undefined, { now: true });

    await waitFor(() => {
      expect(
        queryClient.getQueryState(entityCardsQuery(client, [ISSUE_ID, ERROR_ID]).queryKey)?.status,
      ).toBe("error");
    });
    expect(cardCalls(calls)).toHaveLength(1);
    expect(screen.getByText("TypeError · kept in the block")).toBeTruthy();
  });

  it("keeps the cards of the last good read when a refresh fails", async () => {
    const failing = { now: false };
    const { queryClient, client } = await renderMessage(undefined, failing);
    await screen.findByText("1,211 events");

    failing.now = true;
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: entityCardsQuery(client, [ISSUE_ID, ERROR_ID]).queryKey,
      });
    });

    await waitFor(() => {
      expect(
        queryClient.getQueryState(entityCardsQuery(client, [ISSUE_ID, ERROR_ID]).queryKey)
          ?.fetchStatus,
      ).toBe("idle");
    });
    const card = screen.getByText("STOREFRONT-1Z9").closest("li")!;
    expect(within(card).getByText("1,211 events")).toBeTruthy();
    expect(screen.queryByText("TypeError · kept in the block")).toBeNull();
  });

  it("draws a fact that changes again, without drawing the other card", async () => {
    const { queryClient, client } = await renderMessage();
    const error = (await screen.findByText("1,211 events")).closest("li")!;
    expect(error.querySelector(".is-ticked")).toBeNull();
    const issue = screen.getByText("SHOP-142").closest("li")!;

    act(() => {
      queryClient.setQueryData(entityCardsQuery(client, [ISSUE_ID, ERROR_ID]).queryKey, {
        cards: [
          ISSUE,
          {
            ...ERROR,
            face: { fact: { key: "events", type: "number", label: "Events", number: 1212 } },
          },
        ],
      });
    });

    expect((await within(error).findByText("1,212 events")).className).toContain("is-ticked");
    // The same element stays: the issue's card was not drawn again.
    expect(screen.getByText("SHOP-142").closest("li")).toBe(issue);
  });
});

it("draws the cards and the fold under the first message of a thread another agent spawned", async () => {
  await renderThreadPart(
    () => (
      <AgentSentMessage
        senderSessionId="01a06d02-9000-7000-8000-0000000000b1"
        text="Look into these."
        context={CONTEXT}
        attachments={[]}
        at="2026-11-13T09:41:00.000Z"
        timezone="UTC"
        today={Date.parse("2026-11-13T12:00:00.000Z")}
        steered={false}
        sending={false}
        skills={[]}
        sessionId={THREAD.session.id}
      />
    ),
    {
      thread: THREAD,
      handlers: { [CARDS_PATH]: () => ({ body: { cards: [ISSUE, ERROR] } }) },
    },
  );

  expect(await screen.findByText("STOREFRONT-1Z9")).toBeTruthy();
  expect(screen.getByRole("button", { name: /Context sent with it/ })).toBeTruthy();
});

describe("the fold under the cards", () => {
  it("is folded, with the line count, until it is pressed", async () => {
    await renderMessage();

    const button = await screen.findByRole("button", { name: /Context sent with it/ });
    expect(button.textContent).toContain(`${String(CONTEXT.lineCount)} lines`);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(CONTEXT.text, { normalizer: (text) => text })).toBeNull();

    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector(".msg-ctx-body")?.textContent).toBe(CONTEXT.text);

    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector(".msg-ctx-body")).toBeNull();
  });

  it("keeps the words in the bubble and the block out of it", async () => {
    await renderMessage();

    const bubble = (await screen.findByText("Look into these.")).closest(".bubble")!;
    expect(bubble.textContent).toBe("Look into these.");
  });
});

it("draws a message with no context as before", async () => {
  await renderThreadPart(
    () => (
      <UserMessage
        text="Just words."
        attachments={[]}
        at="2026-11-13T09:41:00.000Z"
        timezone="UTC"
        today={Date.parse("2026-11-13T12:00:00.000Z")}
      />
    ),
    { thread: THREAD },
  );

  await screen.findByText("Just words.");
  expect(screen.queryByRole("button", { name: /Context sent with it/ })).toBeNull();
  expect(document.querySelector(".msg--context")).toBeNull();
});

describe("hasSameMessageProps", () => {
  const props: {
    text: string;
    context: PromptContextBlock | undefined;
    attachments: Attachment[];
    steered: boolean;
  } = {
    text: "Hello",
    context: CONTEXT,
    attachments: [IMAGE],
    steered: false,
  };

  it("counts a context block read again from the same text as the same", () => {
    const again = splitPromptContext(`Look into these.\n\n${CONTEXT_TEXT}`).context!;
    expect(again).not.toBe(CONTEXT);
    expect(hasSameMessageProps(props, { ...props, context: again })).toBe(true);
  });

  it("counts attachments read again with the same ids as the same", () => {
    expect(hasSameMessageProps(props, { ...props, attachments: [{ ...IMAGE }] })).toBe(true);
    expect(hasSameMessageProps(props, { ...props, attachments: [] })).toBe(false);
    expect(
      hasSameMessageProps(props, {
        ...props,
        attachments: [{ ...IMAGE, id: "01a06d02-9000-7000-8000-0000000000aa" }],
      }),
    ).toBe(false);
  });

  it("tells a message with other words, or other context, or none, from the same one", () => {
    expect(hasSameMessageProps(props, { ...props, text: "Hello!" })).toBe(false);
    expect(hasSameMessageProps(props, { ...props, steered: true })).toBe(false);
    expect(hasSameMessageProps(props, { ...props, context: undefined })).toBe(false);
  });
});
