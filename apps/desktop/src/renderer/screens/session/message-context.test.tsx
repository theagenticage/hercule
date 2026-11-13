/**
 * Tests what hangs under a user message that carried context: a live card for
 * each thing, and the fold with the block as sent. Cards are read from the
 * stubbed controller.
 */
import { describe, expect, it } from "vitest";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { buildFakeInboxDetail } from "@hercule/client-core/inbox/testing";
import {
  formatPromptContext,
  splitPromptContext,
  type InboxThing,
  type PromptContextBlock,
} from "@hercule/contract";
import { buildErrorBody, THREAD_FIXTURES } from "../../app/testing";
import { entityQuery } from "../../app/queries";
import { renderThreadPart } from "../thread/testing";
import { hasSameMessageProps, UserMessage } from "./messages";

const THREAD = THREAD_FIXTURES.finished;
const ISSUE_ID = "01a06d02-9000-7000-8000-000000000001";
const ERROR_ID = "01a06d02-9000-7000-8000-000000000002";
const ISSUE_REF = "linear:issue:northwind/SHOP-142";
const ERROR_REF = "sentry:error:storefront-1z9";

const buildThing = (id: string, ref: string, overrides: Partial<InboxThing>): InboxThing =>
  ({
    id,
    ref,
    kind: "linear/issue",
    noun: "Issue",
    patience: 24,
    identifier: "SHOP-142",
    title: "Show the delivery cost",
    url: "https://example.test/x",
    observedAt: "2026-11-01T09:00:00.000Z",
    sourceUpdatedAt: "2026-11-01T09:00:00.000Z",
    ...overrides,
  }) as InboxThing;

const ISSUE = buildFakeInboxDetail(buildThing(ISSUE_ID, ISSUE_REF, {}));
const ERROR = {
  ...buildFakeInboxDetail(
    buildThing(ERROR_ID, ERROR_REF, {
      kind: "sentry/error",
      noun: "Error",
      identifier: "STOREFRONT-1Z9",
      title: "TypeError: Cannot read properties of undefined",
    }),
  ),
  status: { shape: "alert", tone: "bad", label: "Escalating" },
  face: { fact: { key: "events", type: "number", label: "Events", number: 1211 } },
} as const;

const CONTEXT_TEXT = formatPromptContext({
  origin: { kind: "selection" },
  things: [
    { entityId: ISSUE_ID, ref: ISSUE_REF, title: "Show the delivery cost", fields: [] },
    { entityId: ERROR_ID, ref: ERROR_REF, title: "TypeError kept in the block", fields: [] },
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

/** Renders the message, with the controller reading the issue and the error, and the thing in `unreadable` failing. */
const renderMessage = (unreadable?: string) =>
  renderThreadPart(drawMessage(), {
    thread: THREAD,
    handlers: {
      [`GET /api/v1/external-entities/${ISSUE_ID}`]:
        unreadable === ISSUE_ID
          ? { status: 404, body: buildErrorBody("not_found", "No entity has this id.") }
          : { body: ISSUE },
      [`GET /api/v1/external-entities/${ERROR_ID}`]:
        unreadable === ERROR_ID
          ? { status: 404, body: buildErrorBody("not_found", "No entity has this id.") }
          : { body: ERROR },
    },
  });

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

  it("draws the title the block kept, and no identifier, for a thing that cannot be read", async () => {
    await renderMessage(ERROR_ID);

    await screen.findByText("SHOP-142");
    const card = screen.getByText("TypeError kept in the block").closest("li")!;
    expect(within(card).queryByText("STOREFRONT-1Z9")).toBeNull();
    expect(within(card).queryByText("Escalating")).toBeNull();
  });

  it("draws a fact that changes again, without drawing the other card", async () => {
    const { queryClient, client } = await renderMessage();
    const error = (await screen.findByText("1,211 events")).closest("li")!;
    expect(error.querySelector(".is-ticked")).toBeNull();
    const issue = screen.getByText("SHOP-142").closest("li")!;

    await act(async () => {
      queryClient.setQueryData(entityQuery(client, ERROR_ID).queryKey, {
        ...ERROR,
        face: { fact: { key: "events", type: "number", label: "Events", number: 1212 } },
      });
    });

    expect((await within(error).findByText("1,212 events")).className).toContain("is-ticked");
    // The same element stays: the issue's card was not drawn again.
    expect(screen.getByText("SHOP-142").closest("li")).toBe(issue);
  });
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
  const props: { text: string; context: PromptContextBlock | undefined; steered: boolean } = {
    text: "Hello",
    context: CONTEXT,
    steered: false,
  };

  it("counts a context block read again from the same text as the same", () => {
    const again = splitPromptContext(`Look into these.\n\n${CONTEXT_TEXT}`).context!;
    expect(again).not.toBe(CONTEXT);
    expect(hasSameMessageProps(props, { ...props, context: again })).toBe(true);
  });

  it("tells a message with other words, or other context, or none, from the same one", () => {
    expect(hasSameMessageProps(props, { ...props, text: "Hello!" })).toBe(false);
    expect(hasSameMessageProps(props, { ...props, steered: true })).toBe(false);
    expect(hasSameMessageProps(props, { ...props, context: undefined })).toBe(false);
  });
});
