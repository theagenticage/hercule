/**
 * Tests the Initiative sheet as the user works it: the fields, the colour
 * flags with the arrow keys, Return, Esc, the foot's Close and Delete with its
 * confirmation, and the error the foot shows.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { INITIATIVE_HUES } from "@hercule/contract";
import type { InitiativeDraft } from "@hercule/client-core/work";
import { InitiativeSheet, type InitiativeSheetSubject } from "./initiative-sheet";

const PROJECTS = [
  { id: "web", name: "Storefront" },
  { id: "api", name: "Platform" },
];

const NEW_DRAFT: InitiativeDraft = {
  name: "",
  intent: "",
  target: "",
  targetDay: "",
  projectId: "api",
  hue: INITIATIVE_HUES[1],
};

const OPEN: InitiativeSheetSubject = { name: "Gift card refunds", isClosed: false };

/** Renders the sheet and returns what it calls. */
const renderSheet = (
  options: {
    readonly initial?: InitiativeDraft;
    readonly subject?: InitiativeSheetSubject | null;
    readonly onSave?: () => Promise<void>;
    readonly onDelete?: () => Promise<void>;
    readonly onCloseInitiative?: () => Promise<void>;
  } = {},
) => {
  const calls = {
    onSave: vi.fn(options.onSave ?? (() => Promise.resolve())),
    onCloseInitiative: vi.fn(options.onCloseInitiative ?? (() => Promise.resolve())),
    onReopenInitiative: vi.fn(() => Promise.resolve()),
    onDelete: vi.fn(options.onDelete ?? (() => Promise.resolve())),
    onDismiss: vi.fn(),
  };
  render(
    <InitiativeSheet
      initial={options.initial ?? NEW_DRAFT}
      projects={PROJECTS}
      subject={options.subject === undefined ? null : options.subject}
      {...calls}
    />,
  );
  return calls;
};

describe("InitiativeSheet", () => {
  it("titles a new initiative, has Name focused, and preselects the hue it was given", () => {
    renderSheet();

    expect(screen.getByRole("heading", { name: "New initiative" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Name" }));
    expect(screen.getByRole("radio", { name: "Green" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Blue" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getAllByRole("radio")).toHaveLength(INITIATIVE_HUES.length);
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close initiative" })).toBeNull();
  });

  it("starts the Project field on the project it was given, with No project to choose", () => {
    renderSheet();

    const project = screen.getByRole("combobox", { name: "Project" }) as HTMLSelectElement;
    expect(project.value).toBe("api");
    expect([...project.options].map((option) => option.text)).toEqual([
      "No project",
      "Storefront",
      "Platform",
    ]);
  });

  it("cannot save without a name", async () => {
    const user = userEvent.setup();
    const calls = renderSheet();

    expect(screen.getByRole("button", { name: "Create initiative" })).toHaveProperty(
      "disabled",
      true,
    );
    await user.type(screen.getByRole("textbox", { name: "Name" }), "   {Enter}");

    expect(calls.onSave).not.toHaveBeenCalled();
  });

  it("saves every field as typed when Return is pressed in the name field", async () => {
    const user = userEvent.setup();
    const calls = renderSheet();

    await user.type(screen.getByRole("textbox", { name: "Intent" }), "Refund to the card");
    await user.type(screen.getByRole("textbox", { name: "Target" }), "Live by spring");
    await user.type(screen.getByLabelText("Target date"), "2026-03-14");
    await user.selectOptions(screen.getByRole("combobox", { name: "Project" }), "web");
    await user.click(screen.getByRole("radio", { name: "Rose" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Gift card refunds{Enter}");

    expect(calls.onSave).toHaveBeenCalledExactlyOnceWith({
      name: "Gift card refunds",
      intent: "Refund to the card",
      target: "Live by spring",
      targetDay: "2026-03-14",
      projectId: "web",
      hue: INITIATIVE_HUES[4],
    });
  });

  it("saves with No project as null", async () => {
    const user = userEvent.setup();
    const calls = renderSheet();

    await user.selectOptions(screen.getByRole("combobox", { name: "Project" }), "No project");
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Refunds{Enter}");

    expect(calls.onSave).toHaveBeenCalledWith(expect.objectContaining({ projectId: null }));
  });

  it("moves the colour with the arrow keys, around the ends, and with Home and End", async () => {
    const user = userEvent.setup();
    renderSheet({ initial: { ...NEW_DRAFT, hue: INITIATIVE_HUES[0] } });
    const checked = (): string | undefined =>
      screen.getAllByRole("radio").find((each) => each.getAttribute("aria-checked") === "true")
        ?.ariaLabel ?? undefined;

    screen.getByRole("radio", { name: "Blue" }).focus();
    await user.keyboard("{ArrowLeft}");
    expect(checked()).toBe("Gold");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Gold" }));

    await user.keyboard("{ArrowRight}{ArrowDown}");
    expect(checked()).toBe("Green");

    await user.keyboard("{ArrowUp}{End}");
    expect(checked()).toBe("Gold");
    await user.keyboard("{Home}");
    expect(checked()).toBe("Blue");
    // Only the chosen flag is a tab stop.
    expect(screen.getByRole("radio", { name: "Green" }).tabIndex).toBe(-1);
    expect(screen.getByRole("radio", { name: "Blue" }).tabIndex).toBe(0);
  });

  it("shows an edited initiative by its name, with its own fields and Save", async () => {
    const user = userEvent.setup();
    const calls = renderSheet({
      subject: OPEN,
      initial: { ...NEW_DRAFT, name: "Gift card refunds", target: "Live by spring" },
    });

    expect(screen.getByRole("heading", { name: "Gift card refunds" })).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Target" }).value).toBe(
      "Live by spring",
    );
    await user.clear(screen.getByRole("textbox", { name: "Target" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(calls.onSave).toHaveBeenCalledWith(expect.objectContaining({ target: "" }));
  });

  it("closes the initiative from the foot, and offers Reopen on a closed one", async () => {
    const user = userEvent.setup();
    const calls = renderSheet({ subject: OPEN, initial: { ...NEW_DRAFT, name: OPEN.name } });

    await user.click(screen.getByRole("button", { name: "Close initiative" }));

    expect(calls.onCloseInitiative).toHaveBeenCalledOnce();
  });

  it("reopens a closed initiative", async () => {
    const user = userEvent.setup();
    const calls = renderSheet({
      subject: { name: "Gift card refunds", isClosed: true },
      initial: { ...NEW_DRAFT, name: "Gift card refunds" },
    });

    expect(screen.queryByRole("button", { name: "Close initiative" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Reopen" }));

    expect(calls.onReopenInitiative).toHaveBeenCalledOnce();
  });

  it("asks to confirm a delete, in words that say there is no Undo, with the focus on Cancel", async () => {
    const user = userEvent.setup();
    const calls = renderSheet({ subject: OPEN, initial: { ...NEW_DRAFT, name: OPEN.name } });

    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(calls.onDelete).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "Delete Gift card refunds? Its Tasks stay, and leave it. This cannot be undone.",
      ),
    ).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));

    await user.click(screen.getByRole("button", { name: "Delete initiative" }));

    expect(calls.onDelete).toHaveBeenCalledOnce();
  });

  it("does not confirm a delete on a double click, because the button that was pressed is gone", async () => {
    const user = userEvent.setup();
    const calls = renderSheet({ subject: OPEN, initial: { ...NEW_DRAFT, name: OPEN.name } });

    await user.dblClick(screen.getByRole("button", { name: "Delete" }));

    expect(calls.onDelete).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete initiative" })).toBeTruthy();
  });

  it("takes the delete back with Cancel and with Esc, which does not dismiss the sheet", async () => {
    const user = userEvent.setup();
    const calls = renderSheet({ subject: OPEN, initial: { ...NEW_DRAFT, name: OPEN.name } });

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(/Its Tasks stay/)).toBeNull();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.keyboard("{Escape}");

    expect(screen.queryByText(/Its Tasks stay/)).toBeNull();
    expect(calls.onDismiss).not.toHaveBeenCalled();
    expect(calls.onDelete).not.toHaveBeenCalled();
  });

  it("steps back on Esc: the typed fields first, then the sheet", async () => {
    const user = userEvent.setup();
    const calls = renderSheet();
    const name = screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement;

    await user.type(name, "Refunds");
    await user.click(screen.getByRole("radio", { name: "Indigo" }));
    await user.keyboard("{Escape}");

    expect(name.value).toBe("");
    expect(screen.getByRole("radio", { name: "Green" }).getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(name);
    expect(calls.onDismiss).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");

    expect(calls.onDismiss).toHaveBeenCalledOnce();
  });

  it("shows the error of a failed save in the foot and keeps what was typed", async () => {
    const user = userEvent.setup();
    const calls = renderSheet({
      onSave: () => Promise.reject(new Error("That project is gone.")),
    });

    await user.type(screen.getByRole("textbox", { name: "Name" }), "Refunds{Enter}");

    expect((await screen.findByRole("alert")).textContent).toBe("That project is gone.");
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Name" }).value).toBe("Refunds");
    expect(calls.onDismiss).not.toHaveBeenCalled();
  });

  it("shows the error of a failed delete and stays on the confirmation", async () => {
    const user = userEvent.setup();
    renderSheet({
      subject: OPEN,
      initial: { ...NEW_DRAFT, name: OPEN.name },
      onDelete: () => Promise.reject(new Error("Could not reach the controller.")),
    });

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Delete initiative" }));

    expect(await screen.findByText("Could not reach the controller.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });
});
