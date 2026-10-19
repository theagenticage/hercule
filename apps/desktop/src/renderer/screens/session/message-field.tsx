import {
  useEffect,
  useEffectEvent,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
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
import type { SessionSkill } from "@hercule/contract";
import { filterSessionSkills } from "@hercule/client-core";
import { isImeKey, isSendKey } from "./send-key";
import {
  buildSkillChipExtension,
  CONVERT_ALL_REFERENCES,
  readDocumentText,
  RESCAN_REFERENCES,
  SkillChipNode,
} from "./skill-chip-extension";
import { SkillHoverCard } from "./skill-hover-card";
import { buildSkillOptionId, SkillList, type SkillsUnavailable } from "./skill-list";
import { readSkillTrigger, type SkillTrigger } from "./skill-trigger";

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

/**
 * The skills a composer offers in its message field, and how to read them
 * again. Without them, the field draws no chips and opens no list.
 */
export interface ComposerSkills {
  /**
   * The skills of the thread, or `undefined` while they are not known:
   * `failure` tells whether they are still being read or the read failed. The
   * last skills read stay here while they are read again, also when that read
   * fails.
   */
  readonly skills: ReadonlyArray<SessionSkill> | undefined;
  /**
   * Why the last read of the skills failed, in words for the user, or
   * `undefined` when it did not. The lists show it only while `skills` is
   * `undefined`.
   */
  readonly failure: string | undefined;
  /**
   * Reads the skills again when the ones held are old, and does nothing
   * otherwise. The field calls it each time a list opens.
   */
  readonly refreshIfStale: () => void;
}

/** The list that is open and its highlighted row. */
interface OpenList {
  readonly trigger: SkillTrigger;
  readonly activeIndex: number;
}

/** Checks that two triggers are the same token with the same text typed after it. */
const isSameTrigger = (a: SkillTrigger, b: SkillTrigger): boolean =>
  a.kind === b.kind && a.query === b.query && a.from === b.from && a.to === b.to;

/**
 * Returns the chip under the pointer, when `target` is inside one and the
 * skill it names is in `skills`. Returns `null` otherwise.
 */
const findHoveredChip = (
  target: EventTarget,
  skills: ReadonlyArray<SessionSkill> | undefined,
): { readonly skill: SessionSkill; readonly anchor: HTMLElement } | null => {
  if (!(target instanceof Element)) return null;
  const anchor = target.closest<HTMLElement>("[data-skill]");
  const skill = skills?.find((each) => each.name === anchor?.dataset.skill);
  return anchor === null || skill === undefined ? null : { skill, anchor };
};

/**
 * Renders the message field of a composer: an editor that takes plain text
 * and gives back plain text. It looks and behaves like a textarea, which it
 * replaces.
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
 * With `skills`, the field also handles Skill References, which are `$name`
 * in the text:
 *
 * - A reference to one of the skills is drawn as a chip. The text still
 *   reads `$name`, so `onTextChange` and `text` never see a chip. A chip is
 *   deleted as a whole, and a hover over it opens the skill's card.
 * - `$` after whitespace opens the list of skills, `/` the list of commands
 *   (see `readSkillTrigger`), above the field. The arrow keys move through
 *   the list, ⏎ or ⇥ replaces what was typed with a chip, and Esc closes
 *   the list until the token changes. With no row to pick, ⏎ sends as usual.
 *   While a list is open, the field names it in its ARIA attributes, and
 *   `skills.refreshIfStale` is called.
 *
 * The list renders next to the field, so a caller renders the field inside
 * `.composer-card`, which the list positions itself against.
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
  skills,
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
  /** Given when the field handles Skill References. */
  readonly skills?: ComposerSkills | undefined;
  readonly ref: Ref<HTMLElement>;
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const listId = useId();
  const availableSkills = skills?.skills;
  const skillNames = useMemo(
    () => new Set(availableSkills?.map((skill) => skill.name)),
    [availableSkills],
  );
  const [list, setList] = useState<OpenList | null>(null);
  // The token the user closed with Esc. Its list stays closed until the token
  // changes or the caret leaves it.
  const dismissedRef = useRef<SkillTrigger | null>(null);
  const [hovered, setHovered] = useState<ReturnType<typeof findHoveredChip>>(null);
  // The skills are unknown until the first read answers. The lists say so
  // instead of claiming the thread has none.
  const unavailable: SkillsUnavailable | undefined =
    availableSkills !== undefined
      ? undefined
      : skills?.failure === undefined
        ? { status: "reading" }
        : { status: "failed", message: skills.failure };
  const rows = list === null ? [] : filterSessionSkills(availableSkills ?? [], list.trigger.query);
  const activeIndex = list === null ? 0 : Math.min(list.activeIndex, Math.max(rows.length - 1, 0));

  // The editor outlives the renders, so what it calls reaches the latest
  // props through effect events.
  const sendMessage = useEffectEvent(onSend);
  const changeText = useEffectEvent(onTextChange);
  const readPlaceholder = useEffectEvent(() => placeholder);
  /** Passes `files` to `onPasteFiles` and returns true. Returns false, passing nothing, when there are no files or the field takes none. */
  const forwardFiles = useEffectEvent((files: readonly File[]): boolean => {
    if (onPasteFiles === undefined || files.length === 0) return false;
    onPasteFiles(files);
    return true;
  });
  const readSkillNames = useEffectEvent(() => skillNames);

  /** Opens, updates or closes the list to match the token at the caret of `editor`. */
  const followTrigger = useEffectEvent((editor: Editor) => {
    const trigger =
      skills !== undefined && editor.isEditable ? readSkillTrigger(editor.state) : null;
    const dismissed = dismissedRef.current;
    if (dismissed !== null && (trigger === null || !isSameTrigger(dismissed, trigger))) {
      dismissedRef.current = null;
    }
    const shown = dismissedRef.current === null ? trigger : null;
    setList((previous) => {
      if (shown === null) return null;
      if (previous === null) return { trigger: shown, activeIndex: 0 };
      return isSameTrigger(previous.trigger, shown) ? previous : { trigger: shown, activeIndex: 0 };
    });
  });

  /**
   * Replaces the token at the caret with a chip for `skill` and a space, and
   * puts the caret after the space. When a space already follows the token,
   * that space is the one, so none is added.
   */
  const pickSkill = (skill: SessionSkill): void => {
    const { state, view } = editorRef.current!;
    const trigger = readSkillTrigger(state);
    if (trigger === null) return;
    const chip = state.schema.nodes.skill!.create({ name: skill.name });
    const spaceFollows = state.doc.textBetween(trigger.to, trigger.to + 1) === " ";
    const picked = state.tr.replaceWith(
      trigger.from,
      trigger.to,
      spaceFollows ? [chip] : [chip, state.schema.text(" ")],
    );
    picked.setSelection(TextSelection.create(picked.doc, trigger.from + 2));
    view.dispatch(picked.scrollIntoView());
    view.focus();
  };

  /**
   * Handles a key while a list is open. Returns true when the key was for the
   * list. ⏎ and ⇥ pick only when the list has a row, so ⏎ in an empty list
   * still sends. Keys with a modifier, and keys of an IME composition, are
   * not the list's.
   */
  const handleListKey = useEffectEvent((event: KeyboardEvent): boolean => {
    if (list === null || isImeKey(event)) return false;
    if (event.metaKey || event.ctrlKey || event.altKey) return false;
    const move = (step: number): boolean => {
      if (rows.length === 0) return false;
      const next = (activeIndex + step + rows.length) % rows.length;
      setList({ ...list, activeIndex: next });
      return true;
    };
    switch (event.key) {
      case "ArrowDown":
        return !event.shiftKey && move(1);
      case "ArrowUp":
        return !event.shiftKey && move(-1);
      case "Enter":
      case "Tab": {
        const row = rows[activeIndex];
        if (event.shiftKey || row === undefined) return false;
        pickSkill(row);
        return true;
      }
      case "Escape":
        dismissedRef.current = list.trigger;
        setList(null);
        return true;
      default:
        return false;
    }
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
        SkillChipNode,
        buildSkillChipExtension(() => readSkillNames()),
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
      coreExtensionOptions: {
        tabindex: { value: "0" },
        // Tiptap puts a blank line between paragraphs in copied text; a
        // textarea puts a single newline, and so does the field.
        clipboardTextSerializer: { blockSeparator: "\n" },
      },
      editorProps: {
        // A textarea reveals the caret flush with its edge. ProseMirror keeps
        // 5px between the caret and the edge unless given a margin, and reads
        // a plain 0 as "not set", so the margin is an object. Its threshold
        // already defaults to 0.
        scrollMargin: { top: 0, right: 0, bottom: 0, left: 0 },
        attributes: {
          class: "composer-input",
          role: "textbox",
          "aria-multiline": "true",
          "aria-label": "Message",
          ...(id === undefined ? {} : { id }),
        },
        handleKeyDown: (_view, event) => {
          if (handleListKey(event)) return true;
          if (!isSendKey(event)) return false;
          sendMessage();
          return true;
        },
        // ProseMirror's own is not used: it parses the clipboard's HTML first,
        // which is wasted work when only the text is kept, and during an IME
        // composition it does nothing and leaves the paste to the browser,
        // which would skip the files and paste the HTML, where `<br>` becomes
        // a space. So files are handled here at all times, and so is the
        // text, in one of two ways:
        // - Outside a composition, it becomes paragraphs in one transaction.
        // - During a composition, replacing content from script can break the
        //   IME's state. The paste is cancelled and the browser's own
        //   `insertText` command inserts the text, as a native edit that
        //   ProseMirror reads back from the page, as it does a typed one.
        handleDOMEvents: {
          paste: (view, event) => {
            if (!view.editable) return false;
            const clipboard = event.clipboardData;
            if (forwardFiles([...(clipboard?.files ?? [])])) {
              event.preventDefault();
              return true;
            }
            const pasted = clipboard?.getData("text/plain") ?? "";
            if (view.composing) {
              event.preventDefault();
              if (pasted !== "") document.execCommand("insertText", false, pasted);
              return true;
            }
            if (pasted !== "") {
              // Open at both ends, so the first and last pasted lines join the
              // paragraphs around the caret, as pasting into a textarea does.
              const lines = new Slice(
                Fragment.from(buildParagraphs(view.state.schema, pasted)),
                1,
                1,
              );
              view.dispatch(view.state.tr.replaceSelection(lines).scrollIntoView());
            }
            event.preventDefault();
            return true;
          },
        },
        // Dropped files go to the element around the field, which attaches
        // them. Returning true keeps the editor from inserting anything.
        handleDrop: (_view, event) => event.dataTransfer?.types.includes("Files") ?? false,
      },
      onUpdate: ({ editor: updated }) => {
        changeText(readDocumentText(updated.state.doc));
      },
      onTransaction: ({ editor: changed, transaction }) => {
        followTrigger(changed);
        // The chip the pointer is over may be gone.
        if (transaction.docChanged) setHovered(null);
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
    if (readDocumentText(state.doc) === text) return;
    const replaced = state.tr.replaceWith(
      0,
      state.doc.content.size,
      buildDocument(state.schema, text).content,
    );
    replaced
      .setSelection(TextSelection.atEnd(replaced.doc))
      // The text is not an edit of the user's: no undo, no `onTextChange`.
      .setMeta(CONVERT_ALL_REFERENCES, true)
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
  // transaction that changes nothing. A screen reader gets the same text as
  // `aria-placeholder`, because the drawn text is hidden from it (see
  // composer.css).
  useLayoutEffect(() => {
    const { state, view } = editorRef.current!;
    view.dispatch(state.tr);
    if (placeholder === "") view.dom.removeAttribute("aria-placeholder");
    else view.dom.setAttribute("aria-placeholder", placeholder);
  }, [placeholder]);

  // Turns the references to skills that just became known into chips. The
  // change is no edit of the user's: no undo, no `onTextChange`.
  useLayoutEffect(() => {
    const { state, view } = editorRef.current!;
    view.dispatch(
      state.tr
        .setMeta(RESCAN_REFERENCES, true)
        .setMeta("addToHistory", false)
        .setMeta("preventUpdate", true),
    );
  }, [skillNames]);

  // While a list is open the field is the combobox of the pattern: it names
  // the list and the highlighted option. It is a textbox again once the list
  // closes. `aria-multiline` belongs to the textbox role only.
  const open = list !== null;
  const activeOptionId = open && rows.length > 0 ? buildSkillOptionId(listId, activeIndex) : null;
  useLayoutEffect(() => {
    const element = editorRef.current!.view.dom;
    element.setAttribute("role", open ? "combobox" : "textbox");
    if (open) {
      element.removeAttribute("aria-multiline");
      element.setAttribute("aria-controls", listId);
      element.setAttribute("aria-expanded", "true");
      element.setAttribute("aria-autocomplete", "list");
    } else {
      element.setAttribute("aria-multiline", "true");
      element.removeAttribute("aria-controls");
      element.removeAttribute("aria-expanded");
      element.removeAttribute("aria-autocomplete");
    }
    if (activeOptionId === null) element.removeAttribute("aria-activedescendant");
    else element.setAttribute("aria-activedescendant", activeOptionId);
  }, [open, listId, activeOptionId]);

  // The repository part of a thread's skills comes live from its runner's
  // disk, so it is read again when a list opens, unless it was read a moment
  // ago.
  const refreshSkillsIfStale = useEffectEvent(() => {
    skills?.refreshIfStale();
  });
  useEffect(() => {
    if (open) refreshSkillsIfStale();
  }, [open]);

  return (
    <>
      <div
        ref={hostRef}
        className="composer-field"
        onPointerOver={(event) => {
          const chip = findHoveredChip(event.target, availableSkills);
          setHovered((previous) => (previous?.anchor === chip?.anchor ? previous : chip));
        }}
        onPointerLeave={() => {
          setHovered(null);
        }}
      />
      {list === null ? null : (
        <SkillList
          kind={list.trigger.kind}
          skills={rows}
          unavailable={unavailable}
          query={list.trigger.query}
          activeIndex={activeIndex}
          onActiveIndexChange={(index) => {
            setList({ ...list, activeIndex: index });
          }}
          onPick={pickSkill}
          id={listId}
        />
      )}
      {hovered === null ? null : <SkillHoverCard skill={hovered.skill} anchor={hovered.anchor} />}
    </>
  );
}
