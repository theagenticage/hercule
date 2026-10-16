import { expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { UserMessage } from "./messages";

it("shows the HTML a user typed as text, not as elements", () => {
  const { container } = render(
    <UserMessage
      text="make it <b>bold</b>"
      attachments={[]}
      at="2026-09-29T09:14:00.000Z"
      timezone="UTC"
      today={Date.UTC(2026, 8, 29)}
    />,
  );

  expect(screen.getByText("make it <b>bold</b>")).toBeTruthy();
  expect(container.querySelector("b")).toBeNull();
});
