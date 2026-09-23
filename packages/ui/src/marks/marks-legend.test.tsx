import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Input } from "../primitives/input";
import { MarksLegend } from "./marks-legend";

const meanings = [
  "agent working",
  "decision wanted",
  "queued",
  "paused",
  "done",
  "failed",
  "cancelled",
];

describe("MarksLegend", () => {
  it("shows only its toggle until it is opened", () => {
    render(<MarksLegend />);
    expect(screen.getByRole("button", { name: /Marks/ })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens from its toggle and labels every state mark and entity glyph", async () => {
    render(<MarksLegend />);
    await userEvent.click(screen.getByRole("button", { name: /Marks/ }));
    const legend = screen.getByRole("dialog");
    for (const meaning of [...meanings, "task", "run", "session", "workflow"]) {
      expect(screen.getByText(meaning), meaning).toBeTruthy();
    }
    expect(legend.querySelectorAll("svg[data-mark]")).toHaveLength(11);
  });

  it("opens on ? from anywhere on the page", async () => {
    render(<MarksLegend />);
    await userEvent.keyboard("?");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("closes on Escape", async () => {
    render(<MarksLegend />);
    await userEvent.keyboard("?");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("leaves ? alone while the user is typing", async () => {
    render(
      <>
        <Input aria-label="Message" />
        <MarksLegend />
      </>,
    );
    await userEvent.type(screen.getByLabelText("Message"), "why?");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByLabelText("Message")).toHaveProperty("value", "why?");
  });
});
