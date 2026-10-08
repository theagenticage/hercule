/**
 * Tests how a composer's card takes images: Attach opens the file picker,
 * and pasted, dropped and picked files reach the caller. A card that takes
 * no images, such as an assistant's Conversation's, keeps Attach off.
 */
import { describe, expect, it, vi, type Mock } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ShelfItem } from "@hercule/client-core";
import { ComposerCard, type ComposerAttachments } from "./composer-frame";

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
  model: { acceptsImages: true, modelName: "Opus 5.5" },
  onRemove: () => {},
  onRetry: () => {},
  attachBlockedReason,
  onFiles: vi.fn<(files: readonly File[]) => void>(),
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
    const pasted = fireEvent.paste(field, { clipboardData: { files: [IMAGE] } });
    expect(pasted).toBe(false);
    expect(attachments.onFiles).toHaveBeenCalledWith([IMAGE]);
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
    fireEvent.drop(card, { dataTransfer });
    expect(screen.queryByText("Drop images to attach")).toBeNull();
    expect(attachments.onFiles).toHaveBeenCalledWith([IMAGE]);

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

    fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { files: [IMAGE] } });
    expect(attachments.onFiles).toHaveBeenCalledWith([IMAGE]);
  });

  it("takes no images into a read-only field", () => {
    const attachments = buildAttachments();
    renderCard(attachments, true);
    expect(screen.getByRole("button", { name: "Attach" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
    fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { files: [IMAGE] } });
    expect(attachments.onFiles).not.toHaveBeenCalled();
  });
});
