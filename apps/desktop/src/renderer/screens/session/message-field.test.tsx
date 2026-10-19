/**
 * Tests the message field as the user meets it: what typing, the send keys,
 * undo, paste and drop do, how the field takes text from outside, and what
 * it shows when it is empty or read-only. The field is read through its
 * textbox role and the text it reports, never through the editor's own state.
 */
import { createRef, useEffect, useState, type ComponentProps } from "react";
import { describe, expect, it, vi, type Mock } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFieldPlaceholder, readFieldText } from "../../app/testing";
import { MessageField } from "./message-field";

type FieldProps = ComponentProps<typeof MessageField>;

const buildProps = (over: Partial<FieldProps> = {}): FieldProps => ({
  text: "",
  onTextChange: vi.fn<(text: string) => void>(),
  placeholder: "Message the thread",
  readOnly: false,
  onSend: vi.fn<() => void>(),
  ref: null,
  ...over,
});

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

/**
 * Renders a field that keeps its own text. Returns the field's props, whose
 * spies it calls; `setTextFromOutside`, which sets the text as a composer
 * does after a send; and `changeProps`, which renders the field again with
 * other props.
 */
const renderField = (over: Partial<FieldProps> = {}) => {
  const props = buildProps(over);
  const setterRef: { current: ((text: string) => void) | null } = { current: null };
  const view = render(<Controlled fieldProps={props} setterRef={setterRef} />);
  return {
    props,
    onTextChange: props.onTextChange as Mock<(text: string) => void>,
    setTextFromOutside: (text: string): void => {
      act(() => setterRef.current!(text));
    },
    changeProps: (changed: Partial<FieldProps>): void => {
      view.rerender(<Controlled fieldProps={{ ...props, ...changed }} setterRef={setterRef} />);
    },
  };
};

const readField = (): HTMLElement => screen.getByRole("textbox", { name: "Message" });

/** Returns a clipboard that holds `text` and `html`, and no files. */
const buildClipboard = (text: string, html = ""): object => ({
  files: [],
  types: html === "" ? ["text/plain"] : ["text/plain", "text/html"],
  getData: (type: string) => (type === "text/plain" ? text : type === "text/html" ? html : ""),
});

describe("the message field", () => {
  it("is a multiline textbox with the label Message", () => {
    renderField();
    const field = readField();
    expect(field.getAttribute("aria-multiline")).toBe("true");
    expect(field.hasAttribute("aria-disabled")).toBe(false);
  });

  it("reports the text the user types, with a line per paragraph", async () => {
    const user = userEvent.setup();
    const { onTextChange } = renderField();
    await user.type(readField(), "First line{Shift>}{Enter}{/Shift}{Shift>}{Enter}{/Shift}third");
    expect(onTextChange).toHaveBeenLastCalledWith("First line\n\nthird");
    expect(readFieldText(readField())).toBe("First line\n\nthird");
  });

  it("sends on Enter and starts a new line on Shift+Enter", async () => {
    const user = userEvent.setup();
    const { props } = renderField();
    await user.type(readField(), "a{Shift>}{Enter}{/Shift}b");
    expect(props.onSend).not.toHaveBeenCalled();
    expect(readFieldText(readField())).toBe("a\nb");

    await user.keyboard("{Enter}");
    expect(props.onSend).toHaveBeenCalledOnce();
    expect(readFieldText(readField())).toBe("a\nb");
  });

  it("sends on ⌘↵", async () => {
    const user = userEvent.setup();
    const { props } = renderField();
    await user.type(readField(), "Ship it{Meta>}{Enter}{/Meta}");
    expect(props.onSend).toHaveBeenCalledOnce();
    expect(readFieldText(readField())).toBe("Ship it");
  });

  it("does not send on the Enter that ends an IME composition", async () => {
    const user = userEvent.setup();
    const { props } = renderField();
    await user.type(readField(), "x");
    fireEvent.keyDown(readField(), { key: "Enter", isComposing: true });
    fireEvent.keyDown(readField(), { key: "Enter", keyCode: 229 });
    expect(props.onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(readField(), { key: "Enter" });
    expect(props.onSend).toHaveBeenCalledOnce();
  });

  it("undoes and redoes typing with ⌘Z and ⇧⌘Z", async () => {
    const user = userEvent.setup();
    renderField();
    await user.type(readField(), "abc");
    await user.keyboard("{Meta>}z{/Meta}");
    expect(readFieldText(readField())).toBe("");
    await user.keyboard("{Meta>}{Shift>}z{/Shift}{/Meta}");
    expect(readFieldText(readField())).toBe("abc");
  });

  it("undoes and redoes on the historyUndo and historyRedo input events", async () => {
    const user = userEvent.setup();
    renderField();
    await user.type(readField(), "abc");
    fireEvent(
      readField(),
      new InputEvent("beforeinput", { inputType: "historyUndo", cancelable: true }),
    );
    expect(readFieldText(readField())).toBe("");
    fireEvent(
      readField(),
      new InputEvent("beforeinput", { inputType: "historyRedo", cancelable: true }),
    );
    expect(readFieldText(readField())).toBe("abc");
  });

  it("copies and cuts lines joined by one newline, as a textarea does", async () => {
    const user = userEvent.setup();
    renderField();
    await user.type(readField(), "one{Shift>}{Enter}{/Shift}two");
    await user.keyboard("{Meta>}a{/Meta}");
    const setData = vi.fn<(type: string, data: string) => void>();
    fireEvent.copy(readField(), { clipboardData: { setData, clearData: () => {} } });
    expect(setData).toHaveBeenCalledWith("text/plain", "one\ntwo");

    setData.mockClear();
    fireEvent.cut(readField(), { clipboardData: { setData, clearData: () => {} } });
    expect(setData).toHaveBeenCalledWith("text/plain", "one\ntwo");
    expect(readFieldText(readField())).toBe("");
  });

  it("pastes the plain text of the clipboard, never its formatting", async () => {
    const user = userEvent.setup();
    const { onTextChange } = renderField();
    await user.type(readField(), "ab");
    fireEvent.paste(readField(), {
      clipboardData: buildClipboard("one\ntwo\r\nthree", "<p><b>bold</b> <a href='x'>link</a></p>"),
    });
    expect(readFieldText(readField())).toBe("abone\ntwo\nthree");
    expect(onTextChange).toHaveBeenLastCalledWith("abone\ntwo\nthree");
    expect(readField().querySelector("b, a, strong")).toBeNull();
  });

  it("hands pasted files on and inserts nothing, not even their names", () => {
    const onPasteFiles = vi.fn<(files: readonly File[]) => void>();
    renderField({ onPasteFiles });
    const image = new File(["png"], "shot.png", { type: "image/png" });
    const handled = fireEvent.paste(readField(), {
      clipboardData: {
        ...buildClipboard("shot.png"),
        files: [image],
        types: ["Files", "text/plain"],
      },
    });
    expect(handled).toBe(false);
    expect(onPasteFiles).toHaveBeenCalledWith([image]);
    expect(readFieldText(readField())).toBe("");
  });

  it("pastes the text that comes with files when it takes no files", () => {
    renderField();
    const image = new File(["png"], "shot.png", { type: "image/png" });
    fireEvent.paste(readField(), {
      clipboardData: {
        ...buildClipboard("shot.png"),
        files: [image],
        types: ["Files", "text/plain"],
      },
    });
    expect(readFieldText(readField())).toBe("shot.png");
  });

  it("hands pasted files on while an IME composition is going on", () => {
    const onPasteFiles = vi.fn<(files: readonly File[]) => void>();
    renderField({ onPasteFiles });
    const image = new File(["png"], "shot.png", { type: "image/png" });
    fireEvent.compositionStart(readField());
    const handled = fireEvent.paste(readField(), {
      clipboardData: {
        ...buildClipboard("shot.png", "<img src='https://example.test/shot.png'>"),
        files: [image],
        types: ["Files", "text/plain", "text/html"],
      },
    });
    expect(handled).toBe(false);
    expect(onPasteFiles).toHaveBeenCalledWith([image]);
    expect(readFieldText(readField())).toBe("");
  });

  it("leaves a text paste to the browser while an IME composition is going on", () => {
    renderField();
    fireEvent.compositionStart(readField());
    const handled = fireEvent.paste(readField(), { clipboardData: buildClipboard("pasted") });
    // Not cancelled, so the browser inserts the text itself; the editor inserted nothing.
    expect(handled).toBe(true);
    expect(readFieldText(readField())).toBe("");
  });

  it("takes no paste when read-only, files included", () => {
    const onPasteFiles = vi.fn<(files: readonly File[]) => void>();
    const { onTextChange } = renderField({ readOnly: true, onPasteFiles });
    const image = new File(["png"], "shot.png", { type: "image/png" });
    fireEvent.paste(readField(), { clipboardData: buildClipboard("text") });
    fireEvent.paste(readField(), {
      clipboardData: { ...buildClipboard("shot.png"), files: [image], types: ["Files"] },
    });
    expect(onPasteFiles).not.toHaveBeenCalled();
    expect(onTextChange).not.toHaveBeenCalled();
    expect(readFieldText(readField())).toBe("");
  });

  it("leaves a dropped file to the element around the field, and inserts nothing", () => {
    const onDrop = vi.fn<(event: { defaultPrevented: boolean }) => void>();
    const image = new File(["png"], "shot.png", { type: "image/png" });
    render(
      <div onDrop={onDrop}>
        <MessageField {...buildProps()} />
      </div>,
    );
    // jsdom has no DragEvent. A MouseEvent with coordinates is what makes
    // ProseMirror find a drop position and so reach `handleDrop`.
    const drop = new MouseEvent("drop", {
      bubbles: true,
      cancelable: true,
      clientX: 0,
      clientY: 0,
    });
    Object.defineProperty(drop, "dataTransfer", {
      value: {
        types: ["Files", "text/plain", "text/html"],
        files: [image],
        getData: (type: string) => (type === "text/html" ? "<p>shot.png</p>" : "shot.png"),
      },
    });
    fireEvent(readField(), drop);
    expect(onDrop).toHaveBeenCalledOnce();
    expect(readFieldText(readField())).toBe("");
  });

  it("takes text from outside without reporting it, and keeps it out of undo", async () => {
    const user = userEvent.setup();
    const { onTextChange, setTextFromOutside } = renderField();
    await user.type(readField(), "typed");
    onTextChange.mockClear();

    setTextFromOutside("");
    expect(readFieldText(readField())).toBe("");
    setTextFromOutside("Restored draft\nsecond line");
    expect(readFieldText(readField())).toBe("Restored draft\nsecond line");
    expect(onTextChange).not.toHaveBeenCalled();

    await user.keyboard("{Meta>}z{/Meta}");
    expect(readFieldText(readField())).toBe("Restored draft\nsecond line");
  });

  it("shows text it is given when it mounts, with the caret at its end", async () => {
    const user = userEvent.setup();
    renderField({ text: "Draft\n\nend" });
    expect(readFieldText(readField())).toBe("Draft\n\nend");
    readField().focus();
    await user.keyboard("!");
    expect(readFieldText(readField())).toBe("Draft\n\nend!");
  });

  it("puts the caret at the end of text that arrives after the field has the focus", async () => {
    const user = userEvent.setup();
    const { setTextFromOutside } = renderField();
    readField().focus();
    setTextFromOutside("Look at checkout");
    readField().focus();
    await user.keyboard("!");
    expect(readFieldText(readField())).toBe("Look at checkout!");
  });

  it("shows the placeholder while it is empty, and the new one when it changes", async () => {
    const user = userEvent.setup();
    const { changeProps } = renderField();
    expect(readFieldPlaceholder(readField())).toBe("Message the thread");
    changeProps({ placeholder: "Queued until the turn finishes" });
    expect(readFieldPlaceholder(readField())).toBe("Queued until the turn finishes");
    await user.type(readField(), "a");
    expect(readFieldPlaceholder(readField())).toBeNull();
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(readFieldPlaceholder(readField())).toBeNull();
  });

  it("takes no text when read-only, still shows its placeholder, and can be focused", async () => {
    const user = userEvent.setup();
  it("exposes the placeholder to assistive technology as aria-placeholder, and updates it", () => {
    const { changeProps } = renderField();
    expect(readField().getAttribute("aria-placeholder")).toBe("Message the thread");
    changeProps({ placeholder: "Queued until the turn finishes" });
    expect(readField().getAttribute("aria-placeholder")).toBe("Queued until the turn finishes");
  });

    const { props, onTextChange } = renderField({ readOnly: true });
    const field = readField();
    expect(field.getAttribute("aria-disabled")).toBe("true");
    expect(readFieldPlaceholder(field)).toBe("Message the thread");
    await user.click(field);
    expect(document.activeElement).toBe(field);
    await user.keyboard("typed{Enter}");
    expect(readFieldText(field)).toBe("");
    expect(onTextChange).not.toHaveBeenCalled();
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it("takes text again once it is no longer read-only", async () => {
    const user = userEvent.setup();
    const { changeProps } = renderField({ readOnly: true });
    changeProps({ readOnly: false });
    expect(readField().hasAttribute("aria-disabled")).toBe(false);
    await user.type(readField(), "now");
    expect(readFieldText(readField())).toBe("now");
  });

  it("takes the focus when it mounts with autoFocus", () => {
    render(<MessageField {...buildProps({ autoFocus: true })} />);
    expect(document.activeElement).toBe(readField());
  });

  it("carries the id it is given", () => {
    render(<MessageField {...buildProps({ id: "draft-message" })} />);
    expect(readField().id).toBe("draft-message");
  });

  it("gives its editable element to the ref", () => {
    const ref = createRef<HTMLElement>();
    render(<MessageField {...buildProps({ ref })} />);
    expect(ref.current).toBe(readField());
  });
});
