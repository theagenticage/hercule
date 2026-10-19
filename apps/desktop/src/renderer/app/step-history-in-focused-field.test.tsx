import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MessageField } from "../screens/session/message-field";
import { stepHistoryInFocusedField } from "./step-history-in-focused-field";
import { readFieldText, spyOnExecCommand } from "./testing";

/** Renders the message field and types "abc" into it. Returns the field. */
const renderFieldWithTypedText = async (): Promise<HTMLElement> => {
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
  await userEvent.setup().type(field, "abc");
  return field;
};

describe("stepHistoryInFocusedField", () => {
  it("undoes and redoes in the message field by itself, without asking Chromium", async () => {
    const execCommand = spyOnExecCommand();
    const field = await renderFieldWithTypedText();
    stepHistoryInFocusedField("undo");
    expect(readFieldText(field)).toBe("");
    stepHistoryInFocusedField("redo");
    expect(readFieldText(field)).toBe("abc");
    expect(execCommand).not.toHaveBeenCalled();
  });

  it.each(["undo", "redo"] as const)("asks Chromium to %s in a plain text field", async (step) => {
    const execCommand = spyOnExecCommand();
    render(<input aria-label="Name" />);
    await userEvent.setup().click(screen.getByRole("textbox", { name: "Name" }));
    stepHistoryInFocusedField(step);
    expect(execCommand).toHaveBeenCalledExactlyOnceWith(step);
  });
});
