/**
 * Tests the message field's skill support as the user meets it: the `$`
 * list of skills and the `/` list of commands, the keys that drive them,
 * picking, the chips that appear in the text, and the hover card. The field
 * is read through its role and the text it reports, as the field's other
 * tests do.
 */
import { useEffect, useState, type ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Editor } from "@tiptap/core";
import type { SessionSkill } from "@hercule/contract";
import { readFieldText } from "../../app/testing";
import { MessageField, type ComposerSkills } from "./message-field";

type FieldProps = ComponentProps<typeof MessageField>;

const SKILLS = [
  { source: "library", name: "implement", description: "Implement a locked SPEC" },
  { source: "library", name: "review", description: "Review a diff" },
  {
    source: "repository",
    name: "webshop:release",
    description: "Walk the release checklist",
    path: "webshop/.claude/skills/release",
  },
] as unknown as ReadonlyArray<SessionSkill>;

/** Holds the text of a field as a composer does: each change comes back as the `text` prop. */
function Controlled({
  fieldProps,
  setterRef,
}: {
  readonly fieldProps: FieldProps;
  readonly setterRef: { current: ((text: string) => void) | null };
}) {
  const [text, setText] = useState(fieldProps.text);
  useEffect(() => {
    setterRef.current = setText;
  }, [setterRef]);
  return (
    <MessageField
      {...fieldProps}
      text={text}
      onTextChange={(next) => {
        fieldProps.onTextChange(next);
        setText(next);
      }}
    />
  );
}

const renderField = (over: Partial<FieldProps> = {}) => {
  const skills =
    "skills" in over
      ? over.skills
      : { skills: SKILLS, failure: undefined, refreshIfStale: vi.fn<() => void>() };
  const onTextChange = vi.fn<(text: string) => void>();
  const onSend = vi.fn<() => void>();
  const setterRef: { current: ((text: string) => void) | null } = { current: null };
  const props: FieldProps = {
    text: "",
    onTextChange,
    placeholder: "Message the thread",
    readOnly: false,
    onSend,
    ref: null,
    ...over,
    skills,
  };
  const view = render(<Controlled fieldProps={props} setterRef={setterRef} />);
  return {
    onTextChange,
    onSend,
    skills,
    setTextFromOutside: (text: string): void => {
      act(() => setterRef.current!(text));
    },
    changeSkills: (changed: ComposerSkills): void => {
      view.rerender(
        <Controlled fieldProps={{ ...props, skills: changed }} setterRef={setterRef} />,
      );
    },
  };
};

const readField = (): HTMLElement => screen.getByRole("textbox", { name: "Message" });
/** The editable element, whichever role it has: the field is a combobox while a list is open. */
const readEditor = (): HTMLElement => document.querySelector<HTMLElement>(".composer-input")!;
const readOpenField = (): HTMLElement => screen.getByRole("combobox", { name: "Message" });
const readRows = (): HTMLElement[] => within(screen.getByRole("listbox")).getAllByRole("option");
const readActiveRow = (): string =>
  readRows().find((row) => row.getAttribute("aria-selected") === "true")?.textContent ?? "";
const lastText = (onTextChange: ReturnType<typeof vi.fn>): string =>
  onTextChange.mock.lastCall?.[0] as string;

describe("the skills list in the message field", () => {
  it("opens the skills list when the user types $", async () => {
    const user = userEvent.setup();
    const { skills } = renderField();
    await user.type(readField(), "$");
    expect(screen.getByRole("listbox", { name: "Skills" })).toBeTruthy();
    expect(readRows().map((row) => row.textContent)).toHaveLength(3);
    expect(skills?.refreshIfStale).toHaveBeenCalledTimes(1);
  });

  it("filters the rows by what follows the $", async () => {
    const user = userEvent.setup();
    renderField();
    await user.type(readField(), "Run $rev");
    expect(readRows()).toHaveLength(1);
    expect(readRows()[0]!.textContent).toContain("review");
  });

  it("opens the commands list with /skill: labels when the user types /", async () => {
    const user = userEvent.setup();
    renderField();
    await user.type(readField(), "/");
    expect(screen.getByRole("listbox", { name: "Commands" })).toBeTruthy();
    expect(readRows()[0]!.textContent).toContain("/skill:implement");
  });

  it("strips a typed skill: prefix from the command query", async () => {
    const user = userEvent.setup();
    renderField();
    await user.type(readField(), "/skill:rev");
    expect(readRows()).toHaveLength(1);
    expect(readRows()[0]!.textContent).toContain("/skill:review");
  });

  it("opens nothing for a path, a number, a closed token or a field without skills", async () => {
    const user = userEvent.setup();
    renderField();
    await user.type(readField(), "/tmp/x");
    expect(screen.queryByRole("listbox")).toBeNull();
    await user.clear(readField());
    await user.type(readField(), "$20");
    expect(screen.queryByRole("listbox")).toBeNull();
    await user.clear(readField());
    await user.type(readField(), "word$");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("opens nothing without a skills prop", async () => {
    const user = userEvent.setup();
    renderField({ skills: undefined });
    await user.type(readField(), "$");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("says the skills are being read while they are unknown, and shows them once they are known", async () => {
    const user = userEvent.setup();
    const { changeSkills } = renderField({
      skills: { skills: undefined, failure: undefined, refreshIfStale: vi.fn() },
    });
    await user.type(readField(), "$");
    expect(screen.getByText("Reading skills…")).toBeTruthy();
    expect(screen.queryByText("This thread has no skills")).toBeNull();
    changeSkills({ skills: SKILLS, failure: undefined, refreshIfStale: vi.fn() });
    expect(screen.queryByText("Reading skills…")).toBeNull();
    expect(readRows()).toHaveLength(3);
  });

  it("says the skills could not be read, and why, when no skills are known and the read failed", async () => {
    const user = userEvent.setup();
    renderField({
      skills: { skills: undefined, failure: "Runner offline.", refreshIfStale: vi.fn() },
    });
    await user.type(readField(), "/");
    expect(screen.getByText("Couldn't read this thread's skills")).toBeTruthy();
    expect(screen.getByText("Runner offline.")).toBeTruthy();
  });

  it("keeps showing the skills it has when a later read fails", async () => {
    const user = userEvent.setup();
    renderField({
      skills: { skills: SKILLS, failure: "Runner offline.", refreshIfStale: vi.fn() },
    });
    await user.type(readField(), "$");
    expect(readRows()).toHaveLength(3);
    expect(screen.queryByText("Couldn't read this thread's skills")).toBeNull();
  });

  it("opens nothing inside inline code or a fenced block", async () => {
    const user = userEvent.setup();
    renderField();
    await user.type(readField(), "`$");
    expect(screen.queryByRole("listbox")).toBeNull();
    await user.clear(readField());
    await user.type(readField(), "```{Shift>}{Enter}{/Shift}$");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("moves the highlight with the arrow keys and wraps around", async () => {
    const user = userEvent.setup();
    renderField();
    await user.type(readField(), "$");
    expect(readActiveRow()).toContain("implement");
    await user.keyboard("{ArrowDown}");
    expect(readActiveRow()).toContain("review");
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(readActiveRow()).toContain("webshop:release");
    await user.keyboard("{ArrowDown}");
    expect(readActiveRow()).toContain("implement");
  });

  it("names the list and the highlighted row for assistive technology while open", async () => {
    const user = userEvent.setup();
    renderField();
    await user.type(readField(), "$");
    const field = readOpenField();
    const listbox = screen.getByRole("listbox");
    expect(field.getAttribute("aria-controls")).toBe(listbox.id);
    expect(field.getAttribute("aria-expanded")).toBe("true");
    expect(field.getAttribute("aria-autocomplete")).toBe("list");
    expect(field.getAttribute("aria-activedescendant")).toBe(readRows()[0]!.id);
    await user.keyboard("{ArrowDown}");
    expect(field.getAttribute("aria-activedescendant")).toBe(readRows()[1]!.id);
    await user.keyboard("{Escape}");
    const closed = readField();
    for (const name of [
      "aria-controls",
      "aria-expanded",
      "aria-autocomplete",
      "aria-activedescendant",
    ]) {
      expect(closed.hasAttribute(name)).toBe(false);
    }
    expect(closed.getAttribute("aria-multiline")).toBe("true");
  });

  it("picks the highlighted row with Enter, without sending", async () => {
    const user = userEvent.setup();
    const { onTextChange, onSend } = renderField();
    await user.type(readField(), "Run $");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onSend).not.toHaveBeenCalled();
    expect(lastText(onTextChange)).toBe("Run $review ");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(readEditor().querySelector("[data-skill='review']")).not.toBeNull();
    expect(readFieldText(readEditor())).toBe("Run $review ");
  });

  it("does not pick on the Enter that confirms an IME composition", async () => {
    const user = userEvent.setup();
    const { onTextChange, onSend } = renderField();
    await user.type(readField(), "Run $");
    // Safari and some Chromium input methods report the confirming Enter this way.
    fireEvent.keyDown(readOpenField(), { key: "Enter", keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();
    expect(readEditor().querySelector("[data-skill]")).toBeNull();
    expect(lastText(onTextChange)).not.toContain("implement");
  });

  it("puts the caret past a space that already follows the token, without adding another", async () => {
    const user = userEvent.setup();
    const { onTextChange, setTextFromOutside } = renderField();
    setTextFromOutside("Run $rev now");
    // jsdom cannot move the caret with the arrow keys, so the test sets it just after `$rev`.
    const { editor } = readEditor() as HTMLElement & { editor: Editor };
    act(() => {
      readEditor().focus();
      editor.commands.setTextSelection("Run $rev".length + 1);
    });
    expect(screen.getByRole("listbox")).toBeTruthy();
    await user.keyboard("{Enter}");
    expect(lastText(onTextChange)).toBe("Run $review now");
    await user.keyboard("!");
    expect(lastText(onTextChange)).toBe("Run $review !now");
  });

  it("picks with Tab and puts the caret after the space", async () => {
    const user = userEvent.setup();
    const { onTextChange } = renderField();
    await user.type(readField(), "$rev");
    await user.keyboard("{Tab}more");
    expect(lastText(onTextChange)).toBe("$review more");
  });

  it("picks a command row as a skill reference", async () => {
    const user = userEvent.setup();
    const { onTextChange } = renderField();
    await user.type(readField(), "/rel");
    await user.keyboard("{Enter}");
    expect(lastText(onTextChange)).toBe("$webshop:release ");
  });

  it("picks a row that is clicked", async () => {
    const user = userEvent.setup();
    const { onTextChange } = renderField();
    await user.type(readField(), "$");
    await user.click(readRows()[1]!);
    expect(lastText(onTextChange)).toBe("$review ");
  });

  it("closes on Escape until the token changes", async () => {
    const user = userEvent.setup();
    renderField();
    await user.type(readField(), "$r");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    await user.keyboard("e");
    expect(screen.getByRole("listbox")).toBeTruthy();
  });

  it("sends on Enter when no row matches", async () => {
    const user = userEvent.setup();
    const { onSend } = renderField();
    await user.type(readField(), "$zzz");
    expect(screen.getByRole("listbox").textContent).toContain("No skill matches");
    await user.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("closes when the caret leaves the token", async () => {
    const user = userEvent.setup();
    renderField();
    await user.type(readField(), "$re");
    expect(screen.getByRole("listbox")).toBeTruthy();
    // jsdom does not move a caret on an arrow key, so the test moves it.
    const text = readEditor().querySelector("p")!.firstChild!;
    act(() => {
      window.getSelection()!.collapse(text, 0);
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("skill chips in the message field", () => {
  it("makes a chip of a typed reference to a known skill once a space follows", async () => {
    const user = userEvent.setup();
    const { onTextChange } = renderField();
    await user.type(readField(), "Use $review ");
    expect(readEditor().querySelector("[data-skill='review']")).not.toBeNull();
    expect(lastText(onTextChange)).toBe("Use $review ");
  });

  it("leaves a reference to an unknown skill as text", async () => {
    const user = userEvent.setup();
    renderField();
    await user.type(readField(), "Use $reveiw ");
    expect(readEditor().querySelector("[data-skill]")).toBeNull();
    expect(readFieldText(readEditor())).toBe("Use $reveiw ");
  });

  it("does not make a chip while the caret is still at the end of the reference", async () => {
    const user = userEvent.setup();
    renderField();
    await user.type(readField(), "Use $review");
    expect(readEditor().querySelector("[data-skill]")).toBeNull();
  });

  it("makes chips of references in text that comes from outside", () => {
    const { setTextFromOutside } = renderField();
    setTextFromOutside("Do $implement then $review");
    expect(readEditor().querySelectorAll("[data-skill]")).toHaveLength(2);
    expect(readFieldText(readEditor())).toBe("Do $implement then $review");
  });

  it("leaves references in code as text", () => {
    const { setTextFromOutside } = renderField();
    setTextFromOutside("Run `$review` now");
    expect(readEditor().querySelector("[data-skill]")).toBeNull();
  });

  it("makes chips when the skills arrive after the text", () => {
    const { changeSkills, setTextFromOutside } = renderField({
      skills: { skills: undefined, failure: undefined, refreshIfStale: vi.fn() },
    });
    setTextFromOutside("Do $review now");
    expect(readEditor().querySelector("[data-skill]")).toBeNull();
    changeSkills({ skills: SKILLS, failure: undefined, refreshIfStale: vi.fn() });
    expect(readEditor().querySelector("[data-skill='review']")).not.toBeNull();
  });

  it("leaves a reference at the caret as text when the skills change under it", async () => {
    const user = userEvent.setup();
    const { changeSkills } = renderField({
      skills: { skills: undefined, failure: undefined, refreshIfStale: vi.fn() },
    });
    await user.type(readField(), "Do $review");
    changeSkills({ skills: SKILLS, failure: undefined, refreshIfStale: vi.fn() });
    expect(readEditor().querySelector("[data-skill]")).toBeNull();
    expect(readFieldText(readEditor())).toBe("Do $review");
  });

  it("leaves one undo step for typing a reference and its chip", async () => {
    const user = userEvent.setup();
    const { onTextChange } = renderField();
    await user.type(readField(), "$review ");
    expect(readEditor().querySelector("[data-skill]")).not.toBeNull();
    onTextChange.mockClear();
    await user.keyboard("{Meta>}z{/Meta}");
    expect(readEditor().querySelector("[data-skill]")).toBeNull();
    expect(lastText(onTextChange)).toBe("");
  });

  it("turns a chip back into text when a name character is typed right after it", async () => {
    const user = userEvent.setup();
    const { onTextChange, setTextFromOutside } = renderField();
    setTextFromOutside("$review ");
    expect(readEditor().querySelector("[data-skill='review']")).not.toBeNull();
    act(() => readEditor().focus());
    await user.keyboard("{Backspace}er");
    expect(readEditor().querySelector("[data-skill]")).toBeNull();
    expect(readFieldText(readEditor())).toBe("$reviewer");
    expect(lastText(onTextChange)).toBe("$reviewer");
  });

  it("keeps a chip when whitespace is typed after it", async () => {
    const user = userEvent.setup();
    const { setTextFromOutside } = renderField();
    setTextFromOutside("$review ");
    act(() => readEditor().focus());
    await user.keyboard("{Backspace} then");
    expect(readEditor().querySelectorAll("[data-skill='review']")).toHaveLength(1);
  });

  it("brings the chip back when the edit that dissolved it is undone", async () => {
    const user = userEvent.setup();
    const { onTextChange, setTextFromOutside } = renderField();
    setTextFromOutside("$review ");
    act(() => readEditor().focus());
    await user.keyboard("{Backspace}e");
    expect(readEditor().querySelector("[data-skill]")).toBeNull();
    await user.keyboard("{Meta>}z{/Meta}");
    expect(readEditor().querySelector("[data-skill='review']")).not.toBeNull();
    expect(lastText(onTextChange)).toBe("$review ");
  });

  it("does not report a change when chip-making leaves the text as it was", () => {
    const { onTextChange, setTextFromOutside } = renderField();
    setTextFromOutside("Do $review");
    expect(onTextChange).not.toHaveBeenCalled();
  });
});

describe("the skill hover card in the message field", () => {
  it("shows the card when the pointer is over a chip, and hides it when it leaves", () => {
    const { setTextFromOutside } = renderField();
    setTextFromOutside("Do $review");
    const chip = readEditor().querySelector("[data-skill='review']")!;
    fireEvent.pointerOver(chip);
    expect(screen.getByRole("tooltip", { hidden: true }).textContent).toContain("Review a diff");
    fireEvent.pointerLeave(readEditor().parentElement!);
    expect(screen.queryByRole("tooltip", { hidden: true })).toBeNull();
  });
});
