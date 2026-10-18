import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MessageField } from "../screens/session/message-field";
import { redoInFocusedField } from "./redo-focused-field";
import { readFieldText } from "./testing";

/** Replaces `document.execCommand`, which jsdom lacks, with a spy. */
const spyOnExecCommand = () => {
  const execCommand = vi.fn<(command: string) => boolean>(() => true);
  Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });
  return execCommand;
};

afterEach(() => {
  Reflect.deleteProperty(document, "execCommand");
});

describe("redoInFocusedField", () => {
  it("redoes in the message field by itself, without asking Chromium to redo", async () => {
    const execCommand = spyOnExecCommand();
    const user = userEvent.setup();
    render(
      <MessageField
        text=""
        onTextChange={() => {}}
        placeholder="Message the thread"
        readOnly={false}
        onSend={() => {}}
        ref={null}
      />,
    );
    const field = screen.getByRole("textbox", { name: "Message" });
    await user.type(field, "abc");
    await user.keyboard("{Meta>}z{/Meta}");
    expect(readFieldText(field)).toBe("");
    redoInFocusedField();
    expect(readFieldText(field)).toBe("abc");
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("asks Chromium to redo in a plain text field", async () => {
    const execCommand = spyOnExecCommand();
    render(<input aria-label="Name" />);
    await userEvent.setup().click(screen.getByRole("textbox", { name: "Name" }));
    redoInFocusedField();
    expect(execCommand).toHaveBeenCalledExactlyOnceWith("redo");
  });
});
