/**
 * Tests how a composer's card takes images: Attach opens the file picker,
 * and pasted, dropped and picked files reach the caller. A card that takes
 * no images, such as an assistant's Conversation's, keeps Attach off. Also
 * tests the step controls that take Send's place while the composer answers a
 * question, and the message field's blur and composition reports.
 */
import { describe, expect, it, vi, type Mock } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ShelfItem } from "@hercule/client-core";
import { readFieldText } from "../../app/testing";
import { ComposerCard, type ComposerAttachments, type ComposerStep } from "./composer-frame";

const IMAGE = new File(["png"], "shot.png", { type: "image/png" });

const SHELF: readonly ShelfItem[] = [
  { key: "k-1", name: "shot.png", sizeBytes: 3, file: IMAGE, status: "uploading" },
];

const renderCard = (attachments?: ComposerAttachments, readOnly = false) =>
  render(
    <ComposerCard
      text=""
      onTextChange={() => {}}
      placeholder="Message"
      readOnly={readOnly}
      canSend={false}
      onSend={() => {}}
      error={null}
      attachments={attachments}
      fieldRef={null}
    />,
  );

const buildAttachments = (
  attachBlockedReason: string | null = null,
): ComposerAttachments & { readonly onFiles: Mock<(files: readonly File[]) => void> } => ({
  shelf: SHELF,
  model: { imageInput: { maxBytes: null }, modelName: "Opus 5.5" },
  onRemove: () => {},
  onRetry: () => {},
  attachBlockedReason,
  onFiles: vi.fn<(files: readonly File[]) => void>(),
});

/** Returns a clipboard that holds `files`, and the name of the first as its text, as a copied file does. */
const buildFileClipboard = (files: readonly File[]): object => ({
  files,
  types: ["Files", "text/plain"],
  getData: (type: string) => (type === "text/plain" ? (files[0]?.name ?? "") : ""),
});

/** Returns the card's hidden file picker. */
const readPicker = (): HTMLInputElement => document.querySelector("input[type=file]")!;

describe("the composer card's images", () => {
  it("keeps Attach off, and takes no pasted files, on a card without images", async () => {
    const user = userEvent.setup();
    renderCard();
    const attach = screen.getByRole("button", { name: "Attach" });
    expect(attach.getAttribute("aria-disabled")).toBe("true");
    await user.click(attach);
    expect(readPicker()).toBeNull();
    expect(screen.queryByRole("list", { name: "Attached images" })).toBeNull();
  });

  it("opens the picker with the image types, and hands the picked files on", async () => {
    const user = userEvent.setup();
    const attachments = buildAttachments();
    renderCard(attachments);
    expect(screen.getByRole("list", { name: "Attached images" })).toBeTruthy();
    const attach = screen.getByRole("button", { name: "Attach" });
    expect(attach.hasAttribute("aria-disabled")).toBe(false);
    const picker = readPicker();
    expect(picker.accept).toBe("image/png,image/jpeg,image/gif,image/webp");
    expect(picker.multiple).toBe(true);
    const opened = vi.spyOn(picker, "click");
    await user.click(attach);
    expect(opened).toHaveBeenCalledOnce();

    await user.upload(picker, IMAGE);
    expect(attachments.onFiles).toHaveBeenCalledWith([IMAGE]);
  });

  it("attaches pasted files rather than pasting their names", () => {
    const attachments = buildAttachments();
    renderCard(attachments);
    const field = screen.getByRole("textbox", { name: "Message" });
    const pasted = fireEvent.paste(field, { clipboardData: buildFileClipboard([IMAGE]) });
    expect(pasted).toBe(false);
    expect(attachments.onFiles).toHaveBeenCalledWith([IMAGE]);
    expect(readFieldText(field)).toBe("");
  });

  it("draws the drop overlay while files are dragged over, and takes the dropped files", () => {
    const attachments = buildAttachments();
    const { container } = renderCard(attachments);
    const card = container.querySelector(".composer-card")!;
    const dataTransfer = { types: ["Files"], files: [IMAGE], dropEffect: "none" };

    fireEvent.dragEnter(card, { dataTransfer });
    // Moving onto a child enters it before leaving the card.
    fireEvent.dragEnter(screen.getByRole("textbox"), { dataTransfer });
    fireEvent.dragLeave(card, { dataTransfer });
    expect(screen.getByText("Drop images to attach")).toBeTruthy();
    // Dropped on the field, which the editor must leave to the card.
    // jsdom has no DragEvent. A MouseEvent with coordinates is what makes the
    // editor find a drop position and so reach its own drop handling.
    const drop = new MouseEvent("drop", {
      bubbles: true,
      cancelable: true,
      clientX: 0,
      clientY: 0,
    });
    Object.defineProperty(drop, "dataTransfer", {
      value: { ...dataTransfer, getData: () => "shot.png" },
    });
    fireEvent(screen.getByRole("textbox"), drop);
    expect(screen.queryByText("Drop images to attach")).toBeNull();
    expect(attachments.onFiles).toHaveBeenCalledWith([IMAGE]);
    expect(readFieldText(screen.getByRole("textbox"))).toBe("");

    // Dragged text is the browser's to drop.
    fireEvent.dragEnter(card, { dataTransfer: { types: ["text/plain"], files: [] } });
    expect(screen.queryByText("Drop images to attach")).toBeNull();
  });

  it("keeps Attach off with the reason, and still hands pasted files on to be refused", async () => {
    const user = userEvent.setup();
    const attachments = buildAttachments("`glm-5.3` does not accept images.");
    renderCard(attachments);
    const attach = screen.getByRole("button", { name: "Attach" });
    expect(attach.getAttribute("aria-disabled")).toBe("true");
    expect(attach.title).toBe("`glm-5.3` does not accept images.");
    const opened = vi.spyOn(readPicker(), "click");
    await user.click(attach);
    expect(opened).not.toHaveBeenCalled();

    fireEvent.paste(screen.getByRole("textbox"), { clipboardData: buildFileClipboard([IMAGE]) });
    expect(attachments.onFiles).toHaveBeenCalledWith([IMAGE]);
  });

  it("takes no images into a read-only field", () => {
    const attachments = buildAttachments();
    renderCard(attachments, true);
    expect(screen.getByRole("button", { name: "Attach" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
    fireEvent.paste(screen.getByRole("textbox"), { clipboardData: buildFileClipboard([IMAGE]) });
    expect(attachments.onFiles).not.toHaveBeenCalled();
  });
});

describe("the composer card's step controls", () => {
  const buildStep = (over: Partial<ComposerStep> = {}): ComposerStep => ({
    label: "Next",
    showsPrevious: true,
    canGoBack: true,
    ready: true,
    onPrevious: vi.fn<() => void>(),
    onStep: vi.fn<() => void>(),
    ...over,
  });

  const renderStepCard = (step: ComposerStep | undefined, stop = false) =>
    render(
      <ComposerCard
        text=""
        onTextChange={() => {}}
        placeholder="Message"
        readOnly={false}
        canSend
        onSend={() => {}}
        stop={stop ? { stopping: false, onStop: () => {} } : undefined}
        error={null}
        step={step}
        fieldRef={null}
      />,
    );

  /** Returns the names of the buttons at the end of the row, after Dictate. */
  const readEndOfRow = (): readonly string[] =>
    [
      ...document.querySelectorAll(
        ".composer-row > button, .composer-row > .composer-step > button",
      ),
    ]
      .slice(2)
      .map((button) => button.getAttribute("title") ?? button.textContent ?? "");

  it("replaces Send with Previous and the step button, and calls what each one is for", async () => {
    const user = userEvent.setup();
    const step = buildStep();
    renderStepCard(step);
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(readEndOfRow()).toEqual(["Previous", "Next"]);

    await user.click(screen.getByRole("button", { name: "Previous" }));
    await user.click(screen.getByRole("button", { name: "Next" }));

    expect(step.onPrevious).toHaveBeenCalledOnce();
    expect(step.onStep).toHaveBeenCalledOnce();
  });

  it("leaves Previous out on the first question, and labels the step button as given", () => {
    renderStepCard(buildStep({ showsPrevious: false, label: "Send answers" }));

    expect(screen.queryByRole("button", { name: "Previous" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send answers" })).toBeTruthy();
  });

  it("draws the step button and Previous as off when they cannot work, and keeps them in the tab order", () => {
    renderStepCard(buildStep({ ready: false, canGoBack: false }));

    for (const name of ["Previous", "Next"]) {
      const button = screen.getByRole("button", { name });
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(button.hasAttribute("data-unready")).toBe(true);
      expect((button as HTMLButtonElement).disabled).toBe(false);
    }
  });

  it("keeps Stop at the end of the row, beside the step controls", () => {
    renderStepCard(buildStep(), true);

    expect(readEndOfRow()).toEqual(["Previous", "Next", "Stop"]);
  });

  it("draws Send when there is no step", () => {
    renderStepCard(undefined);

    expect(readEndOfRow()).toEqual(["Send"]);
  });
});

describe("the composer card's message field reports", () => {
  it("reports when the field loses the focus, and when a composition starts and ends", () => {
    const onFieldBlur = vi.fn<() => void>();
    const onComposingChange = vi.fn<(composing: boolean) => void>();
    render(
      <ComposerCard
        text=""
        onTextChange={() => {}}
        placeholder="Message"
        readOnly={false}
        canSend
        onSend={() => {}}
        error={null}
        onFieldBlur={onFieldBlur}
        onComposingChange={onComposingChange}
        fieldRef={null}
      />,
    );
    const field = screen.getByRole("textbox", { name: "Message" });

    fireEvent.compositionStart(field);
    fireEvent.compositionEnd(field);
    fireEvent.blur(field);

    expect(onComposingChange.mock.calls).toEqual([[true], [false]]);
    expect(onFieldBlur).toHaveBeenCalledOnce();
  });
});
