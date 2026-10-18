import {
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type JSX,
  type Ref,
} from "react";
import { Editor, Extension } from "@tiptap/core";
import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { Placeholder } from "@tiptap/extensions/placeholder";
import { UndoRedo } from "@tiptap/extensions/undo-redo";
import { Fragment, Slice, type Node as ProseMirrorNode, type Schema } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { isSendKey } from "./send-key";

/**
 * Starts a new line on ⇧⏎. Tiptap binds ⏎ to a new line itself, but not ⇧⏎,
 * which a textarea also turns into one.
 */
const ShiftEnterNewLine = Extension.create({
  name: "shiftEnterNewLine",
  addKeyboardShortcuts() {
    return { "Shift-Enter": ({ editor }) => editor.commands.splitBlock() };
  },
});

/** Splits `text` into lines and returns one paragraph per line, an empty line being an empty paragraph. */
const buildParagraphs = (schema: Schema, text: string): ProseMirrorNode[] =>
  text
    .split(/\r\n|\r|\n/)
    .map((line) => schema.nodes.paragraph!.create(null, line === "" ? null : schema.text(line)));

/** Returns a document that holds `text`, one paragraph per line. `""` is one empty paragraph. */
const buildDocument = (schema: Schema, text: string): ProseMirrorNode =>
  schema.topNodeType.create(null, buildParagraphs(schema, text));

/** Returns the text of `doc`: the text of each paragraph, joined by newlines. */
const readText = (doc: ProseMirrorNode): string => {
  const lines: string[] = [];
  doc.forEach((paragraph) => {
    lines.push(paragraph.textContent);
  });
  return lines.join("\n");
};

/**
 * Renders the message field of a composer: an editor that takes plain text
 * and gives back plain text. It looks and behaves like a textarea, which it
 * replaces, and it is the base for editing a message with more than text
 * later.
 *
 * The field shows `text` and hands each change the user makes to
 * `onTextChange`. When `text` changes to something other than what the field
 * holds, such as the clear after a send, the field takes it, puts the caret
 * at its end, and keeps it out of the undo history, so undo cannot bring a
 * sent message back.
 *
 * - ⏎, and so ⌘↵, calls `onSend`; ⇧⏎ starts a new line. A ⏎ that ends an IME
 *   composition does not send, see `isSendKey`.
 * - Paste inserts the clipboard's plain text, never its formatting. When the
 *   clipboard holds files and `onPasteFiles` is given, the files go to
 *   `onPasteFiles` instead, and nothing is inserted: a copied file also
 *   carries its name as text, which must not land in the field. Dropped
 *   files are never inserted either; they bubble to the element around the
 *   field.
 * - A `readOnly` field takes no text and carries `aria-disabled`, but keeps
 *   the focus.
 * - `ref` receives the field's editable element, so a caller can focus it.
 *
 * `autoFocus` and `id` are read when the field mounts.
 */
export function MessageField({
  text,
  onTextChange,
  placeholder,
  readOnly,
  onSend,
  onPasteFiles,
  id,
  autoFocus,
  ref,
}: {
  readonly text: string;
  readonly onTextChange: (text: string) => void;
  readonly placeholder: string;
  readonly readOnly: boolean;
  readonly onSend: () => void;
  /** Given when the field takes files. */
  readonly onPasteFiles?: ((files: readonly File[]) => void) | undefined;
  readonly id?: string | undefined;
  readonly autoFocus?: boolean | undefined;
  readonly ref: Ref<HTMLElement>;
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);

  // The editor outlives the renders, so what it calls reaches the latest
  // props through effect events.
  const sendMessage = useEffectEvent(onSend);
  const changeText = useEffectEvent(onTextChange);
  const readPlaceholder = useEffectEvent(() => placeholder);
  const takeFiles = useEffectEvent((files: readonly File[]): boolean => {
    if (onPasteFiles === undefined || files.length === 0) return false;
    onPasteFiles(files);
    return true;
  });
  const createEditor = useEffectEvent((element: HTMLElement): Editor => {
    const editor = new Editor({
      element,
      extensions: [
        Document,
        Paragraph,
        Text,
        UndoRedo,
        ShiftEnterNewLine,
        // The placeholder shows on the empty document only, and also while
        // the field is read-only, as a textarea's does.
        Placeholder.configure({
          placeholder: () => readPlaceholder(),
          showOnlyWhenEditable: false,
        }),
      ],
      // Tiptap's stylesheet is a `<style>` element, which the app's content
      // security policy blocks. composer.css has the few rules the editor needs.
      injectCSS: false,
      // A read-only field stays focusable, as a read-only textarea is.
      coreExtensionOptions: { tabindex: { value: "0" } },
      editorProps: {
        attributes: {
          class: "composer-input",
          role: "textbox",
          "aria-multiline": "true",
          "aria-label": "Message",
          ...(id === undefined ? {} : { id }),
        },
        handleKeyDown: (_view, event) => {
          if (!isSendKey(event)) return false;
          sendMessage();
          return true;
        },
        handlePaste: (view, event) => {
          const clipboard = event.clipboardData;
          if (takeFiles([...(clipboard?.files ?? [])])) return true;
          const pasted = clipboard?.getData("text/plain") ?? "";
          if (pasted === "") return true;
          // Open at both ends, so the first and last pasted lines join the
          // paragraphs around the caret, as pasting into a textarea does.
          const lines = new Slice(Fragment.from(buildParagraphs(view.state.schema, pasted)), 1, 1);
          view.dispatch(view.state.tr.replaceSelection(lines).scrollIntoView());
          return true;
        },
        // Dropped files go to the element around the field, which attaches
        // them. Returning true keeps the editor from inserting anything.
        handleDrop: (_view, event) => event.dataTransfer?.types.includes("Files") ?? false,
      },
      onUpdate: ({ editor: updated }) => {
        changeText(readText(updated.state.doc));
      },
    });
    if (autoFocus === true) editor.view.dom.focus();
    return editor;
  });

  // These are layout effects, so the field is in the first frame the card is
  // drawn in, and `ref` is set before any effect of a parent runs.
  useLayoutEffect(() => {
    const editor = createEditor(hostRef.current!);
    editorRef.current = editor;
    return () => {
      editorRef.current = null;
      editor.destroy();
    };
  }, []);

  useImperativeHandle(ref, () => editorRef.current!.view.dom, []);

  // Takes `text` when it differs from the field's: the first text, and then
  // any text the user did not type. Typing reports its text through
  // `onTextChange`, which comes back as `text` and finds the field equal.
  useLayoutEffect(() => {
    const { state, view } = editorRef.current!;
    if (readText(state.doc) === text) return;
    const replaced = state.tr.replaceWith(
      0,
      state.doc.content.size,
      buildDocument(state.schema, text).content,
    );
    replaced
      .setSelection(TextSelection.atEnd(replaced.doc))
      // The text is not an edit of the user's: no undo, no `onTextChange`.
      .setMeta("addToHistory", false)
      .setMeta("preventUpdate", true);
    view.dispatch(replaced);
  }, [text]);

  useLayoutEffect(() => {
    const editor = editorRef.current!;
    // The second argument keeps the editor from reporting an update.
    editor.setEditable(!readOnly, false);
    if (readOnly) editor.view.dom.setAttribute("aria-disabled", "true");
    else editor.view.dom.removeAttribute("aria-disabled");
  }, [readOnly]);

  // The placeholder is drawn from the editor's state, so a new one needs a
  // transaction that changes nothing.
  useLayoutEffect(() => {
    const { state, view } = editorRef.current!;
    view.dispatch(state.tr);
  }, [placeholder]);

  return <div ref={hostRef} className="composer-field" />;
}
