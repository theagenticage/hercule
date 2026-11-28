/**
 * Tests how the context block of a sent message draws: folded by default,
 * with a summary that counts its lines, and the block as sent inside.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MessageContext } from "./message-context";

afterEach(cleanup);

const CONTEXT = {
  text: "From your Inbox (1 thing)\n1. linear:issue:northwind/SHOP-142 · Show the cost · <id>\nRead any of them in full: hercule entity read <id>",
  lineCount: 3,
  things: [],
};

describe("MessageContext", () => {
  it("is folded, names the line count, and holds the block as sent", () => {
    const { container, getByText } = render(<MessageContext context={CONTEXT} />);
    const details = container.querySelector("details");
    expect(details?.open).toBe(false);
    expect(getByText(/Context sent with it/).textContent).toBe("Context sent with it · 3 lines");
    expect(container.querySelector("pre")?.textContent).toBe(CONTEXT.text);
  });
});
