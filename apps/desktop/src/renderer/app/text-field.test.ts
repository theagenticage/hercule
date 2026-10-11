/** Tests which key press targets count as text fields. */
import { describe, expect, it } from "vitest";
import { isTextField } from "./text-field";

describe("isTextField", () => {
  it("counts inputs, text areas and selects as text fields", () => {
    for (const tag of ["input", "textarea", "select"]) {
      expect(isTextField(document.createElement(tag))).toBe(true);
    }
  });

  it("counts an element the user can edit as a text field", () => {
    const editable = document.createElement("div");
    // jsdom does not compute isContentEditable from the contenteditable attribute.
    Object.defineProperty(editable, "isContentEditable", { value: true });
    expect(isTextField(editable)).toBe(true);
  });

  it("does not count other elements, the window or no target", () => {
    expect(isTextField(document.createElement("button"))).toBe(false);
    expect(isTextField(window)).toBe(false);
    expect(isTextField(null)).toBe(false);
  });
});
