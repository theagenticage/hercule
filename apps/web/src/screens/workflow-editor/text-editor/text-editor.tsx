/**
 * A text editor that speaks the module's own types: the text, a callback for
 * each change, marks for problems, offers to complete what the author types,
 * and a handle that moves the cursor. This folder is the one place that
 * imports the editor library, so the library can be replaced here alone.
 *
 * The parent owns the text. The editor sends each change up, and the parent
 * sends the text back down. A text that the parent sends and that the editor
 * sent before is a text the editor has already, so it changes nothing, even
 * when the author has typed more since. Any other text replaces the text in
 * the editor, and starts a new history: undo never goes back past it.
 *
 * The editor keeps every character of the text, line breaks included. The
 * editor's text is read with `sliceDoc`, which writes each line break with
 * the line separator of the editor: the document's own `toString` writes
 * `\n`.
 */
import {
  useEffect,
  useEffectEvent,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type Ref,
} from "react";
import { autocompletion, pickedCompletion, type Completion } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { yaml } from "@codemirror/lang-yaml";
import {
  forEachDiagnostic,
  setDiagnostics,
  setDiagnosticsEffect,
  type Diagnostic,
} from "@codemirror/lint";
import { EditorState, Prec, Text } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import type { CompletionList, CompletionOffer } from "@hercule/client-core";
import { editorTheme, syntaxHighlightStyle } from "./theme";

/** A problem to mark in the text, from the offset `from` to the offset `to` of the text. */
interface TextDiagnostic {
  readonly from: number;
  readonly to: number;
  readonly severity: "error" | "warning";
  readonly message: string;
}

/**
 * A problem as the editor marks it now: at its offsets in the text that the
 * editor holds, which move with the text that the author types, and on the
 * line of `from`, counted from 1.
 */
type ShownDiagnostic<D extends TextDiagnostic> = D & { readonly line: number };

/** What to offer at an offset of a text, or `undefined` for nothing. */
type TextCompletionSource = (text: string, offset: number) => CompletionList | undefined;

export interface TextEditorHandle {
  /**
   * Puts the cursor at the start of a line, counted from 1, shows the line,
   * and focuses the editor. The editor must be visible, because a hidden
   * editor cannot take focus.
   */
  moveCursorToLine: (line: number) => void;
}

/** The editor's accessible name. */
const ACCESSIBLE_NAME = "Workflow source";

/**
 * How long Tab moves focus out of the editor after Escape. It is the time the
 * editor library gives Tab after an Escape that nothing else handles.
 */
const TAB_FOCUS_AFTER_ESCAPE_MS = 2000;

/**
 * The line separator of the editor for a text. The parser of a workflow's
 * text starts a new line at each `\n` only, and a `\r` just before a `\n` is a
 * part of that line break. So the editor splits the text at `\r\n` when each
 * `\n` of the text follows a `\r`, and at `\n` in every other text. Then the
 * editor counts the lines as the parser does, and gives back every character
 * of the text. A `\r` that is not a part of a line break stays in its line,
 * where it shows as a special character.
 */
const chooseLineSeparator = (text: string): "\r\n" | "\n" =>
  text.includes("\n") && !/(?<!\r)\n/.test(text) ? "\r\n" : "\n";

/*
 * The editor library counts each line break as one position, whatever its
 * characters. An offset into the text counts each character of it. The two
 * functions below convert between them, so the rest of the module speaks of
 * offsets into the text only. Every line break of the editor is its line
 * separator, so each line break has the same length.
 */

/** The position in the editor of an offset into the text. */
const convertOffsetToPosition = (state: EditorState, offset: number): number => {
  const extra = state.lineBreak.length - 1;
  if (extra === 0) return Math.min(offset, state.doc.length);
  // The last line whose first character is at or before the offset.
  let [low, high] = [1, state.doc.lines];
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (state.doc.line(middle).from + (middle - 1) * extra <= offset) low = middle;
    else high = middle - 1;
  }
  const line = state.doc.line(low);
  return Math.min(offset - (low - 1) * extra, line.to);
};

/** The offset into the text of a position in the editor. */
const convertPositionToOffset = (state: EditorState, position: number): number =>
  position + (state.doc.lineAt(position).number - 1) * (state.lineBreak.length - 1);

/** An offer in the form the editor library takes, which writes the offer's text and places the cursor. */
const buildLibraryCompletion = (offer: CompletionOffer): Completion => ({
  label: offer.label,
  ...(offer.detail === undefined ? {} : { detail: offer.detail }),
  apply: (view, completion, from, to) => {
    view.dispatch({
      // A text of lines, which the editor writes with the line break of its text.
      changes: { from, to, insert: Text.of(offer.text.split("\n")) },
      // Each line break of the offer's text is one position in the editor.
      selection: { anchor: from + (offer.cursor ?? offer.text.length) },
      userEvent: "input.complete",
      annotations: pickedCompletion.of(completion),
    });
  },
});

/** A problem that the editor was given, and the place of its mark when the editor reported it. */
interface ReportedDiagnostic<D extends TextDiagnostic> {
  readonly given: D;
  readonly shown: ShownDiagnostic<D>;
}

/** Whether two reports name the same given problems, at the same places. */
const isSameReport = <D extends TextDiagnostic>(
  a: ReadonlyArray<ReportedDiagnostic<D>>,
  b: ReadonlyArray<ReportedDiagnostic<D>>,
): boolean =>
  a.length === b.length &&
  a.every(({ given, shown }, index) => {
    const other = b[index];
    return (
      other?.given === given &&
      other.shown.from === shown.from &&
      other.shown.to === shown.to &&
      other.shown.line === shown.line
    );
  });

export function TextEditor<D extends TextDiagnostic>({
  text,
  onTextChange,
  onTextReplace,
  diagnostics,
  onDiagnosticsChange,
  completionSource,
  ref,
}: {
  readonly text: string;
  /** Receives each text that the author makes. */
  readonly onTextChange: (text: string) => void;
  /**
   * Is called when the editor takes a text from the parent that it did not
   * send: another text, and not the author's next change.
   */
  readonly onTextReplace: () => void;
  /**
   * The problems of `text`, or `undefined` while they are not known. The
   * problems are marked only while the editor holds `text`. While the problems
   * are not known, the marks that the editor shows stay, and move with the
   * text that the author types.
   */
  readonly diagnostics: ReadonlyArray<D> | undefined;
  /**
   * Receives the problems that the editor marks, each time they or their
   * places change, in the order that `diagnostics` gave them. Each is the
   * problem that `diagnostics` gave, at the place of its mark now.
   */
  readonly onDiagnosticsChange: (shown: ReadonlyArray<ShownDiagnostic<D>>) => void;
  readonly completionSource: TextCompletionSource;
  readonly ref?: Ref<TextEditorHandle>;
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  /** The texts the editor sent up that the parent has not sent back yet, oldest first. */
  const sentTexts = useRef<Array<string>>([]);
  /** Each problem that the editor was given last, by the library's form of it. */
  const givenDiagnostics = useRef(new Map<Diagnostic, D>());
  /** The problems that the editor reported last, which a report of the same problems does not repeat. */
  const reportedDiagnostics = useRef<ReadonlyArray<ReportedDiagnostic<D>> | undefined>(undefined);
  const [initialText] = useState(text);
  const hintId = useId();

  const sendText = useEffectEvent((next: string) => {
    sentTexts.current.push(next);
    onTextChange(next);
  });
  const findCompletions = useEffectEvent((current: string, offset: number) =>
    completionSource(current, offset),
  );
  const reportDiagnostics = useEffectEvent((state: EditorState) => {
    const places = new Map<Diagnostic, readonly [number, number]>();
    forEachDiagnostic(state, (diagnostic, from, to) => places.set(diagnostic, [from, to]));
    const report = [...givenDiagnostics.current].flatMap(([libraryDiagnostic, given]) => {
      const place = places.get(libraryDiagnostic);
      if (place === undefined) return [];
      const [from, to] = place;
      const shown = {
        ...given,
        from: convertPositionToOffset(state, from),
        to: convertPositionToOffset(state, to),
        line: state.doc.lineAt(from).number,
      };
      return [{ given, shown }];
    });
    const reported = reportedDiagnostics.current;
    if (reported !== undefined && isSameReport(reported, report)) return;
    reportedDiagnostics.current = report;
    onDiagnosticsChange(report.map(({ shown }) => shown));
  });

  /** A new state of the editor for a text: no history, no marks, and the cursor at the start. */
  const createState = useEffectEvent((initial: string) =>
    EditorState.create({
      doc: initial,
      extensions: [
        EditorState.lineSeparator.of(chooseLineSeparator(initial)),
        // A pasted or dropped text is written with the line break of the text.
        EditorView.clipboardInputFilter.of((pasted, state) =>
          pasted.replace(/\r\n?|\n/g, state.lineBreak),
        ),
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        highlightActiveLine(),
        drawSelection(),
        history(),
        yaml(),
        syntaxHighlightStyle,
        editorTheme,
        // The completion list takes Escape to close itself, and then the
        // editor library does not give the next Tab to the page. Escape then
        // Tab moves focus out of the editor in every state, as the editor's
        // description says, so Escape turns that on before the list closes.
        Prec.highest(
          keymap.of([
            {
              key: "Escape",
              run: (view) => {
                view.setTabFocusMode(TAB_FOCUS_AFTER_ESCAPE_MS);
                return false;
              },
            },
          ]),
        ),
        autocompletion({
          icons: false,
          override: [
            (context) => {
              const found = findCompletions(
                context.state.sliceDoc(),
                convertPositionToOffset(context.state, context.pos),
              );
              if (found === undefined) return null;
              const from = convertOffsetToPosition(context.state, found.from);
              // While the author types, the list opens once a word is
              // started. An empty line or a new value opens it only when
              // the author asks, so the list does not follow each space.
              if (!context.explicit && from === context.pos) return null;
              return { from, options: found.offers.map(buildLibraryCompletion) };
            },
          ],
        }),
        keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
        EditorView.contentAttributes.of({
          "aria-label": ACCESSIBLE_NAME,
          "aria-describedby": hintId,
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) sendText(update.state.sliceDoc());
          const isMarked = update.transactions.some((transaction) =>
            transaction.effects.some((effect) => effect.is(setDiagnosticsEffect)),
          );
          if (update.docChanged || isMarked) reportDiagnostics(update.state);
        }),
      ],
    }),
  );

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const view = new EditorView({ parent: host, state: createState(initialText) });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [initialText]);

  const replaceText = useEffectEvent(() => {
    onTextReplace();
  });
  // A layout effect, so that a parent that changes what it draws when the
  // text is replaced does so before the page is painted.
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    const sent = sentTexts.current;
    const index = sent.indexOf(text);
    if (index !== -1) {
      // The parent caught up with a text the editor sent. The author may have
      // typed more since, so the editor keeps what it holds.
      sent.splice(0, index + 1);
      return;
    }
    if (view.state.sliceDoc() === text) return;
    sent.length = 0;
    view.setState(createState(text));
    givenDiagnostics.current = new Map();
    reportDiagnostics(view.state);
    replaceText();
  }, [text]);

  useEffect(() => {
    const view = viewRef.current;
    // The problems were found in `text`. While the editor holds a newer text
    // their offsets may be wrong, so the marks stay until the problems of the
    // newer text arrive.
    if (view === null || diagnostics === undefined || view.state.sliceDoc() !== text) return;
    const { state } = view;
    const given = new Map<Diagnostic, D>();
    for (const diagnostic of diagnostics) {
      // A new object for each problem, so that the report can tell two equal
      // problems apart.
      const libraryDiagnostic: Diagnostic = {
        from: convertOffsetToPosition(state, diagnostic.from),
        to: convertOffsetToPosition(state, diagnostic.to),
        severity: diagnostic.severity,
        message: diagnostic.message,
      };
      given.set(libraryDiagnostic, diagnostic);
    }
    givenDiagnostics.current = given;
    view.dispatch(setDiagnostics(state, [...given.keys()]));
  }, [text, diagnostics]);

  useImperativeHandle(
    ref,
    () => ({
      moveCursorToLine: (line) => {
        const view = viewRef.current;
        if (view === null) return;
        const { doc } = view.state;
        const target = doc.line(Math.min(Math.max(line, 1), doc.lines));
        view.dispatch({
          selection: { anchor: target.from },
          effects: EditorView.scrollIntoView(target.from, { y: "center" }),
        });
        view.focus();
      },
    }),
    [],
  );

  return (
    <div className="h-full min-h-0">
      <p id={hintId} hidden>
        Press Escape, then Tab, to move focus out of the editor.
      </p>
      <div ref={hostRef} className="h-full" />
    </div>
  );
}
