/**
 * Tests the generated config form on its own: what a number field shows when
 * its setting is unset, how it refuses text that is not a number, and how an
 * optional choice can be unset.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { buildConfigFields, type ConfigJson } from "@hercule/client-core";
import { ConfigForm } from "./config-form";

const FIELDS = buildConfigFields({
  type: "object",
  properties: {
    days: { type: "integer", title: "Window (days)", minimum: 1, maximum: 30, default: 7 },
    ratio: { type: "number", title: "Ratio" },
    mode: { type: "string", enum: ["fast", "slow"], title: "Mode" },
  },
  required: [],
  additionalProperties: false,
});

const NO_ISSUES = { perField: {}, perEntry: {}, rest: false };

const renderForm = () => {
  const onSave = vi.fn<(config: ConfigJson) => void>();
  render(
    <ConfigForm
      id="notes"
      fields={FIELDS}
      config={{}}
      issues={NO_ISSUES}
      saving={false}
      onEdit={() => undefined}
      onSave={onSave}
    />,
  );
  return { onSave, user: userEvent.setup() };
};

describe("ConfigForm", () => {
  it("shows a number setting's default as the placeholder, and saves nothing for it when left empty", async () => {
    const { onSave, user } = renderForm();
    const days = screen.getByLabelText<HTMLInputElement>("Window (days)");

    expect(days.placeholder).toBe("7");
    expect(days.value).toBe("");
    // A text field with a numeric keyboard, like a feed's poll interval.
    expect(days.type).toBe("text");
    expect(days.inputMode).toBe("numeric");
    expect(screen.getByLabelText<HTMLInputElement>("Ratio").placeholder).toBe("");

    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith({});
  });

  it("refuses text that is not an integer under its field, keeps it, and sends nothing", async () => {
    const complaint = "Enter an integer.";
    const { onSave, user } = renderForm();
    const days = screen.getByLabelText<HTMLInputElement>("Window (days)");

    await user.type(days, "1.5");
    await user.click(screen.getByRole("button", { name: "Save" }));

    const error = screen.getByRole("alert");
    expect(error.textContent).toBe(complaint);
    // The error sits under the field it is about, before the next field.
    expect(days.compareDocumentPosition(error) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      error.compareDocumentPosition(screen.getByLabelText("Ratio")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(days.value).toBe("1.5");
    expect(onSave).not.toHaveBeenCalled();

    // Any edit clears the error, because it was about the text the field held then.
    await user.clear(days);
    expect(screen.queryByText(complaint)).toBeNull();
    await user.type(days, "12");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith({ days: 12 });
  });

  it("refuses text that is not a number in a decimal field", async () => {
    const { onSave, user } = renderForm();

    await user.type(screen.getByLabelText("Ratio"), "1e3");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByRole("alert").textContent).toBe("Enter a number.");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("offers an optional choice as Not set", () => {
    renderForm();

    const options = screen.getAllByRole<HTMLOptionElement>("option").map((option) => option.text);
    expect(options).toEqual(["Not set", "fast", "slow"]);
  });
});
