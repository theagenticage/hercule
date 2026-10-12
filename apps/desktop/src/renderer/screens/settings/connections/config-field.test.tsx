/**
 * Tests the widget each kind of plugin setting is drawn with, and the picker
 * of a setting whose choices load from an account: while they load, once
 * they have loaded, and when they cannot be loaded.
 */
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ConfigField, ConfigValue, FieldChoices } from "@hercule/client-core";
import { ConfigFieldRow } from "./config-field";

/**
 * Renders `field` holding `initial`, as a form would: each change is kept and
 * drawn again. Returns the spy that receives every change.
 */
const renderField = (
  field: ConfigField,
  initial: ConfigValue,
  {
    error,
    entryErrors,
    choices,
  }: {
    readonly error?: string;
    readonly entryErrors?: Readonly<Record<number, string>>;
    readonly choices?: FieldChoices;
  } = {},
) => {
  const onChange = vi.fn<(value: ConfigValue) => void>();
  function Form() {
    const [value, setValue] = useState(initial);
    return (
      <ConfigFieldRow
        inputId="setting"
        field={field}
        value={value}
        error={error}
        entryErrors={entryErrors}
        choices={choices}
        onChange={(next) => {
          onChange(next);
          setValue(next);
        }}
      />
    );
  }
  render(<Form />);
  return onChange;
};

describe("ConfigFieldRow", () => {
  it("draws a text setting as a field named and described by the schema, with its default as the placeholder", async () => {
    const onChange = renderField(
      {
        name: "host",
        kind: "string",
        label: "Host",
        description: "Where the server runs.",
        required: false,
        defaultValue: "localhost",
      },
      "",
    );
    const input = screen.getByRole("textbox", {
      name: "Host",
      description: "Where the server runs.",
    });
    expect(input.getAttribute("placeholder")).toBe("localhost");
    await userEvent.type(input, "db");
    expect(onChange).toHaveBeenLastCalledWith("db");
  });

  it("draws a number setting as a text field, so text that is not a number reaches the form", async () => {
    const onChange = renderField(
      { name: "limit", kind: "integer", label: "Limit", required: true },
      "",
      { error: "Enter an integer." },
    );
    const input = screen.getByRole("textbox", { name: "Limit" });
    await userEvent.type(input, "abc");
    expect(onChange).toHaveBeenLastCalledWith("abc");
    expect(input.getAttribute("aria-required")).toBe("true");
    expect(screen.getByRole("alert").textContent).toBe("Enter an integer.");
  });

  it("draws a boolean setting as a switch", async () => {
    const onChange = renderField(
      { name: "drafts", kind: "boolean", label: "Include drafts", required: false },
      false,
    );
    const toggle = screen.getByRole("switch", { name: "Include drafts" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await userEvent.click(toggle);
    expect(onChange).toHaveBeenLastCalledWith(true);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("offers Not set for an optional enum setting, and not for a required one", async () => {
    const options = ["low", "high"];
    const onChange = renderField(
      { name: "level", kind: "enum", label: "Level", required: false, options },
      "",
    );
    const select = screen.getByRole("combobox", { name: "Level" });
    expect(
      within(select)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Not set", "low", "high"]);
    await userEvent.selectOptions(select, "high");
    expect(onChange).toHaveBeenLastCalledWith("high");
  });

  it("offers no Not set for a required enum setting", () => {
    renderField(
      { name: "level", kind: "enum", label: "Level", required: true, options: ["low", "high"] },
      "low",
    );
    expect(
      within(screen.getByRole("combobox", { name: "Level" }))
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["low", "high"]);
  });

  it("draws a list setting as a field per entry, with each entry's error under it, Remove and Add", async () => {
    const onChange = renderField(
      { name: "repos", kind: "stringList", label: "Repositories", required: false },
      ["acme/api", "bad name"],
      { entryErrors: { 1: "Not a repository." } },
    );
    const group = screen.getByRole("group", { name: "Repositories" });
    const second = within(group).getByRole("textbox", { name: "Repositories entry 2" });
    expect(second.getAttribute("aria-invalid")).toBe("true");
    expect(second.closest(".config-list-entry")?.textContent).toBe("Not a repository.");
    expect(
      within(group)
        .getByRole("textbox", { name: "Repositories entry 1" })
        .closest(".config-list-entry")?.textContent,
    ).toBe("");

    await userEvent.click(screen.getByRole("button", { name: "Remove Repositories entry 1" }));
    expect(onChange).toHaveBeenLastCalledWith(["bad name"]);
    await userEvent.click(screen.getByRole("button", { name: "Add to Repositories" }));
    expect(onChange).toHaveBeenLastCalledWith(["bad name", ""]);
    expect(within(group).getAllByRole("textbox")).toHaveLength(2);
  });

  describe("a setting whose choices load from the account", () => {
    const team: ConfigField = {
      name: "team",
      kind: "string",
      label: "Team",
      required: true,
      loadsChoices: true,
    };
    const projects: ConfigField = {
      name: "projects",
      kind: "stringList",
      label: "Projects",
      required: false,
      loadsChoices: true,
    };

    it("holds the picker's place with a disabled select while the choices load", () => {
      renderField(team, "", { choices: { status: "loading" } });
      const select = screen.getByRole<HTMLSelectElement>("combobox", { name: "Team" });
      expect(select.disabled).toBe(true);
      expect(select.selectedOptions[0]?.textContent).toBe("Loading choices…");
    });

    it("picks one value by its label, and keeps a stored value the account no longer has", async () => {
      const onChange = renderField(team, "gone", {
        choices: {
          status: "loaded",
          choices: [
            { value: "t-1", label: "Platform" },
            { value: "t-2", label: "Web" },
          ],
        },
      });
      const select = screen.getByRole<HTMLSelectElement>("combobox", { name: "Team" });
      expect(select.selectedOptions[0]?.textContent).toBe("Not found: gone");
      await userEvent.selectOptions(select, "Web");
      expect(onChange).toHaveBeenLastCalledWith("t-2");
    });

    it("draws the picker's red edge when the setting has an error", () => {
      renderField(team, "", {
        error: "Pick a team.",
        choices: { status: "loaded", choices: [{ value: "t-1", label: "Platform" }] },
      });
      const select = screen.getByRole("combobox", { name: "Team" });
      expect(select.getAttribute("aria-invalid")).toBe("true");
      expect(select.closest(".field")?.classList.contains("is-bad")).toBe(true);
    });

    it("picks several values with checkboxes, and filters a long list", async () => {
      const choices = Array.from({ length: 12 }, (_, at) => ({
        value: `p-${String(at)}`,
        label: `Project ${String(at)}`,
      }));
      const onChange = renderField(projects, ["p-11"], { choices: { status: "loaded", choices } });
      const group = screen.getByRole("group", { name: "Projects" });
      expect(within(group).getAllByRole("checkbox")).toHaveLength(12);

      await userEvent.type(screen.getByRole("textbox", { name: "Filter Projects" }), "project 2");
      // The selected value stays in view, so the user can still clear it.
      expect(
        within(group)
          .getAllByRole("checkbox")
          .map((box) => box.closest("label")?.textContent),
      ).toEqual(["Project 2", "Project 11"]);

      await userEvent.click(within(group).getByRole("checkbox", { name: "Project 2" }));
      expect(onChange).toHaveBeenLastCalledWith(["p-11", "p-2"]);
    });

    it("falls back to the plain widget and says under it why the choices are missing", async () => {
      const onChange = renderField(team, "", {
        choices: { status: "failed", message: "The account refused the token." },
      });
      const input = screen.getByRole("textbox", { name: "Team" });
      // A hint rather than an alert: the field still takes the value.
      expect(screen.queryByRole("alert")).toBeNull();
      expect(input.closest(".field")?.nextElementSibling?.textContent).toBe(
        "Could not load the choices: The account refused the token.",
      );
      await userEvent.type(input, "t-9");
      expect(onChange).toHaveBeenLastCalledWith("t-9");
    });
  });
});
