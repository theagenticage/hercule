/**
 * A CodeMirror text editor behind this module's own types: the text, a change
 * callback, diagnostics, completions, and a handle that moves the cursor.
 * This folder is the only place that imports CodeMirror, so the library can
 * be replaced here alone.
 *
 * The parent owns the text. The editor sends each change up, and the parent
 * passes the text back down. When the parent passes back a text that the
 * editor sent earlier, the editor ignores it, even if the author has typed
 * more since. Any other text replaces the editor's content and starts a new
 * undo history, so undo never goes back past it.
 *
 * The editor keeps every character of the text, including the exact line
 * breaks. Read the editor's text with `sliceDoc`, which joins lines with the
 * editor's line separator. The document's own `toString` always uses `\n`.
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
import type { CompletionList, CompletionOption } from "@hercule/client-core";
import { editorTheme, syntaxHighlightStyle } from "./theme";

/** An issue to underline, from offset `from` to offset `to` in the text. */
interface TextDiagnostic {
  readonly from: number;
  readonly to: number;
  readonly severity: "error" | "warning";
  readonly message: string;
}

/**
 * A diagnostic at its current underline position, which moves as the author
 * types. `line` is the 1-based line of `from`.
 */
type ShownDiagnostic<D extends TextDiagnostic> = D & { readonly line: number };

/** Returns the completions at an offset in a text, or `undefined` for none. */
type TextCompletionSource = (text: string, offset: number) => CompletionList | undefined;

export interface TextEditorHandle {
  /**
   * Puts the cursor at the start of a 1-based line, scrolls the line into
   * view, and focuses the editor. The editor must be visible, because a
   * hidden editor cannot take focus.
   */
  moveCursorToLine: (line: number) => void;
}

/** The editor's accessible name. */
const ACCESSIBLE_NAME = "Workflow source";

/**
 * How long Tab moves focus out of the editor after Escape. CodeMirror uses
 * the same time after an Escape that nothing else handles.
 */
const TAB_FOCUS_AFTER_ESCAPE_MS = 2000;

/**
 * Returns the line separator the editor should use for a text.
 *
 * The workflow parser starts a new line only at `\n`, and treats a `\r` right
 * before it as part of the line break. So the editor uses `\r\n` when every
 * `\n` in the text follows a `\r`, and `\n` otherwise. The editor then counts
 * lines the same way the parser does, and returns every character of the
 * text unchanged. A lone `\r` stays inside its line, where it shows as a
 * special character.
 */
const chooseLineSeparator = (text: string): "\r\n" | "\n" =>
  text.includes("\n") && !/(?<!\r)\n/.test(text) ? "\r\n" : "\n";

/*
 * CodeMirror counts each line break as one position, even a two-character
 * `\r\n`. A text offset counts every character. The two functions below
 * convert between the two, so the rest of this module uses only text
 * offsets. Every line break in the editor is its line separator, so all line
 * breaks have the same length.
 */

/** Converts a text offset to an editor position. */
const convertOffsetToPosition = (state: EditorState, offset: number): number => {
  const extra = state.lineBreak.length - 1;
  if (extra === 0) return Math.min(offset, state.doc.length);
  // Binary search for the last line that starts at or before the offset.
  let [low, high] = [1, state.doc.lines];
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (state.doc.line(middle).from + (middle - 1) * extra <= offset) low = middle;
    else high = middle - 1;
  }
  const line = state.doc.line(low);
  return Math.min(offset - (low - 1) * extra, line.to);
};

/** Converts an editor position to a text offset. */
const convertPositionToOffset = (state: EditorState, position: number): number =>
  position + (state.doc.lineAt(position).number - 1) * (state.lineBreak.length - 1);

/**
 * Converts a completion option to CodeMirror's form, which inserts the text
 * and places the cursor. CodeMirror passes the range from the start of the
 * replaced text to the cursor. The option also replaces `rest` more
 * characters after the cursor, all on the cursor's line.
 */
const buildLibraryCompletion = (option: CompletionOption, rest: number): Completion => ({
  label: option.label,
  ...(option.detail === undefined ? {} : { detail: option.detail }),
  apply: (view, completion, from, to) => {
    view.dispatch({
      // `Text.of` takes lines, so the editor joins them with its own line separator.
      changes: { from, to: to + rest, insert: Text.of(option.text.split("\n")) },
      // Each `\n` in the option's text is one editor position, so the cursor
      // offset needs no conversion.
      selection: { anchor: from + (option.cursor ?? option.text.length) },
      userEvent: "input.complete",
      annotations: pickedCompletion.of(completion),
    });
  },
});

/** A diagnostic as passed in, and its underline position when the editor last reported it. */
interface ReportedDiagnostic<D extends TextDiagnostic> {
  readonly given: D;
  readonly shown: ShownDiagnostic<D>;
}

/** Returns true when two reports hold the same diagnostics at the same positions. */
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
  /** Called with the new text after each change the author makes. */
  readonly onTextChange: (text: string) => void;
  /**
   * Called when the parent passes in a text that the editor did not send, so
   * the text was replaced rather than edited by the author.
   */
  readonly onTextReplace: () => void;
  /**
   * The issues in `text`, or `undefined` while they are not known. They are
   * underlined only while the editor holds exactly `text`. While they are not
   * known, the current underlines stay and move with the text as the author
   * types.
   */
  readonly diagnostics: ReadonlyArray<D> | undefined;
  /**
   * Called with the underlined diagnostics whenever they or their positions
   * change, in the order of `diagnostics`. Each one is the diagnostic that was
   * passed in, at its current underline position.
   */
  readonly onDiagnosticsChange: (shown: ReadonlyArray<ShownDiagnostic<D>>) => void;
  readonly completionSource: TextCompletionSource;
  readonly ref?: Ref<TextEditorHandle>;
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  /** Texts the editor sent up that the parent has not passed back yet, oldest first. */
  const sentTexts = useRef<Array<string>>([]);
  /** The last diagnostics passed in, keyed by their CodeMirror objects. */
  const givenDiagnostics = useRef(new Map<Diagnostic, D>());
  /** The last report sent to the parent, so an identical report is not sent again. */
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

  /** Creates an editor state for a text: no undo history, no diagnostics, and the cursor at the start. */
  const createState = useEffectEvent((initial: string) =>
    EditorState.create({
      doc: initial,
      extensions: [
        EditorState.lineSeparator.of(chooseLineSeparator(initial)),
        // Pasted or dropped text gets the editor's line separator.
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
        // When the completion list is open, Escape closes the list, and
        // CodeMirror then does not let the next Tab leave the editor. The
        // editor's hint text describes Escape then Tab as a way to always move
        // focus out, so this handler turns that mode on before the list closes.
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
              const offset = convertPositionToOffset(context.state, context.pos);
              const found = findCompletions(context.state.sliceDoc(), offset);
              if (found === undefined) return null;
              const from = convertOffsetToPosition(context.state, found.from);
              // While the author types, the list opens once a word is
              // started. On an empty line or an empty value, it opens only
              // when the author asks, so it does not pop up after every space.
              if (!context.explicit && from === context.pos) return null;
              // CodeMirror filters the options against the text from `from`
              // to the end of the result. So the result ends at the cursor,
              // and each option replaces the rest of the value itself. The
              // rest is on the cursor's line and contains no line break, so
              // its length is the same in text offsets and editor positions.
              const rest = found.to - offset;
              return {
                from,
                options: found.options.map((option) => buildLibraryCompletion(option, rest)),
              };
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
  // A layout effect, so a parent that redraws when the text is replaced does
  // so before paint.
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    const sent = sentTexts.current;
    const index = sent.indexOf(text);
    if (index !== -1) {
      // The parent caught up with a text the editor sent. The author may have
      // typed more since, so the editor keeps its current content.
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
    // The diagnostics were computed for `text`. If the editor now holds a
    // newer text, their offsets may be wrong, so the current underlines stay
    // until diagnostics for the newer text arrive.
    if (view === null || diagnostics === undefined || view.state.sliceDoc() !== text) return;
    const { state } = view;
    const given = new Map<Diagnostic, D>();
    for (const diagnostic of diagnostics) {
      // A new object for each diagnostic, so the report can tell two equal
      // diagnostics apart.
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
