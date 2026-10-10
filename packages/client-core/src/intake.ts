/**
 * How Intake reads the signals on To do: the count, the tabs, the sections
 * and their order, what a row and the pane say, and the answers in the order
 * the pane draws them. Spec 17 §Intake owns the screen; spec 10 §9 owns the
 * Signal record.
 *
 * Every client that draws Intake uses these functions, so the desktop app,
 * its notifications and the sidebar's count never disagree about a signal.
 */
import {
  DONE_ACTION_ID,
  HAND_TO_ACTION_PREFIX,
  isCoreSignalKind,
  type PluginMark,
  type Signal,
  type SignalAction,
} from "@hercule/contract";

/** A plugin's id and the name the user knows it by, as `plugin.query` returns them. */
export interface PluginName {
  readonly id: string;
  readonly displayName: string;
}

/** A plugin's id, its name and the mark it declares, as `plugin.query` returns them. */
export interface PluginIdentity extends PluginName {
  readonly mark?: PluginMark;
}

/** The name the core's own signals carry as their source, such as an offer of an Ignore Rule. */
const CORE_SOURCE_NAME = "Hercule";

/** The labels of the core's kinds. A plugin kind is labelled from its id instead. */
const CORE_KIND_LABELS: Readonly<Record<string, string>> = {
  proposal: "Proposal",
  offer: "Offer",
  unsure: "Unsure",
  fyi: "FYI",
};

/** Returns `text` with its first letter in lower case: "Review requested" becomes "review requested". */
const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

/** Returns `text` with its first letter in upper case: "an agent" becomes "An agent". */
const upperFirst = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Returns the id of the plugin whose kind `kind` is, such as `github` for
 * `github/mentioned`, or `null` for a core kind, which no plugin owns.
 */
export const parseSignalPluginId = (kind: string): string | null =>
  isCoreSignalKind(kind) ? null : kind.slice(0, kind.indexOf("/"));

/**
 * Returns the label of a signal's kind: "Mentioned" for `github/mentioned`,
 * "Review requested" for `github/review-requested`, "Proposal" for
 * `proposal`.
 *
 * A plugin declares no label for its kinds, so the label is made from the
 * word after the "/": dashes become spaces and the first letter is a
 * capital.
 */
const nameSignalKind = (kind: string): string =>
  CORE_KIND_LABELS[kind] ?? upperFirst(kind.slice(kind.indexOf("/") + 1).replaceAll("-", " "));

/** Returns the name of the plugin `pluginId`, or the id itself when the plugin is not listed. */
const namePlugin = (pluginId: string, plugins: ReadonlyArray<PluginName>): string =>
  plugins.find((plugin) => plugin.id === pluginId)?.displayName ?? pluginId;

/** What a client draws as a plugin's mark: the plugin's own paths, or the initial of its name. */
export type PluginMarkDrawing =
  | { readonly _tag: "paths"; readonly paths: ReadonlyArray<string> }
  | { readonly _tag: "initial"; readonly initial: string };

/**
 * Decides what to draw as the mark of the plugin `pluginId`: the paths of
 * the mark it declares, or else the first letter of its name in upper case,
 * which the apps draw in a rounded square. A plugin `plugins` does not list
 * gets the first letter of its id.
 */
export const decidePluginMark = (
  pluginId: string,
  plugins: ReadonlyArray<PluginIdentity>,
): PluginMarkDrawing => {
  const mark = plugins.find((plugin) => plugin.id === pluginId)?.mark;
  if (mark !== undefined) return { _tag: "paths", paths: mark.paths };
  return { _tag: "initial", initial: namePlugin(pluginId, plugins).charAt(0).toUpperCase() };
};

/**
 * Returns who an actor stamp names, as the middle of a sentence: "you" for
 * the user, the plugin's name for a plugin, "a workflow" for a run, "an
 * agent" for a session, and "Hercule" for the core. The stamp holds no name
 * for a run or a session, so those two stay general.
 */
const nameActor = (actor: string, plugins: ReadonlyArray<PluginName>): string => {
  if (actor === "user") return "you";
  if (actor.startsWith("plugin:")) return namePlugin(actor.slice("plugin:".length), plugins);
  if (actor.startsWith("run:")) return "a workflow";
  if (actor.startsWith("session:")) return "an agent";
  return CORE_SOURCE_NAME;
};

/**
 * Returns the name of a signal's source, as its row, its pane and its
 * notification show it:
 *
 * - a plugin kind names its plugin: "GitHub";
 * - a core kind raised from an event names the core: "Hercule";
 * - any other core kind names who raised it: "You", a plugin's name, "A
 *   workflow", "An agent" or "Hercule".
 */
export const nameSignalSource = (signal: Signal, plugins: ReadonlyArray<PluginName>): string => {
  const pluginId = parseSignalPluginId(signal.kind);
  if (pluginId !== null) return namePlugin(pluginId, plugins);
  if (signal.origin.type === "event") return CORE_SOURCE_NAME;
  return upperFirst(nameActor(signal.origin.actor, plugins));
};

/**
 * Returns the provenance line at the top of the pane: the source and the
 * kind, such as "GitHub · Mentioned" or "You · Proposal".
 */
export const describeSignalProvenance = (
  signal: Signal,
  plugins: ReadonlyArray<PluginName>,
): string => `${nameSignalSource(signal, plugins)} · ${nameSignalKind(signal.kind)}`;

/**
 * Checks whether a signal on To do is back from a snooze. The To do view
 * holds no signal that is still snoozed, so a snooze on a signal there has
 * run out.
 */
export const isBackFromSnooze = (signal: Signal): boolean => signal.snooze !== undefined;

/**
 * Returns the To do count: the number of signals on To do. The sidebar's
 * Hercule segment, Intake's row and the All tab all show it.
 */
export const countToDo = (signals: ReadonlyArray<Signal>): number => signals.length;

/**
 * Returns the accessible name of the sidebar's Hercule segment while
 * something is on To do: "Hercule, 8 to do". The segment draws no count at
 * 0, so it is not called then.
 */
export const describeOrchestrationSegment = (toDoCount: number): string =>
  `Hercule, ${String(toDoCount)} to do`;

/** One tab of Intake's bar: All, or one plugin's signals. */
interface IntakeTab {
  /** The plugin whose signals the tab shows, or `null` for All. */
  readonly pluginId: string | null;
  readonly label: string;
  /** The tab's To do count. The tab hides it at 0. */
  readonly count: number;
}

/**
 * Returns Intake's tabs: All, then one per plugin with a signal on To do
 * now or at any time in `seenSourceIds`, in the order `plugins` lists them.
 * Also returns the plugins seen so far, which the caller keeps and passes
 * back on the next call.
 *
 * A tab never disappears while the screen is mounted, even after its last
 * signal leaves, so the tabs keep their places as signals arrive and leave.
 * The returned set is `seenSourceIds` itself when no new plugin appeared,
 * so a caller can compare the two to see whether to store it.
 *
 * Core signals have no tab of their own: they show under All only. The
 * Triage tab comes with the triage workflow (#533).
 */
export const buildIntakeTabs = (
  signals: ReadonlyArray<Signal>,
  plugins: ReadonlyArray<PluginName>,
  seenSourceIds: ReadonlySet<string>,
): { readonly tabs: ReadonlyArray<IntakeTab>; readonly seenSourceIds: ReadonlySet<string> } => {
  const current = signals
    .map((signal) => parseSignalPluginId(signal.kind))
    .filter((id) => id !== null);
  const seen = current.every((id) => seenSourceIds.has(id))
    ? seenSourceIds
    : new Set([...seenSourceIds, ...current]);
  const listed = plugins.filter((plugin) => seen.has(plugin.id));
  // A plugin that `plugins` does not list, such as one removed while its
  // signals are still open, still gets its tab, after the listed ones.
  const unlisted = [...seen]
    .filter((id) => !plugins.some((plugin) => plugin.id === id))
    .sort()
    .map((id) => ({ id, displayName: id }));
  const tabs = [
    { pluginId: null, label: "All", count: signals.length },
    ...[...listed, ...unlisted].map((plugin) => ({
      pluginId: plugin.id,
      label: plugin.displayName,
      count: current.filter((id) => id === plugin.id).length,
    })),
  ];
  return { tabs, seenSourceIds: seen };
};

/** One section of the To do list. */
export interface IntakeSection {
  /** `now` holds the `urgent` signals; `signals` holds every other one. */
  readonly key: "now" | "signals";
  readonly label: "Now" | "Signals";
  /** The section's signals, in the order the list draws them. Never empty. */
  readonly signals: ReadonlyArray<Signal>;
}

/**
 * Compares two signals for the order inside a section: the signals back from
 * a snooze first, the one whose snooze ended earliest first, then the rest,
 * the oldest first. Timestamps are ISO strings in UTC, so they sort as text.
 */
const compareInSection = (a: Signal, b: Signal): number => {
  if (a.snooze !== undefined && b.snooze !== undefined)
    return a.snooze.until.localeCompare(b.snooze.until);
  if (a.snooze !== undefined) return -1;
  if (b.snooze !== undefined) return 1;
  return a.createdAt.localeCompare(b.createdAt);
};

/**
 * Groups the signals on To do into the sections the list draws, for the tab
 * of `pluginId`, or for All when it is `null`:
 *
 * - **Now**, the `urgent` signals, drawn only while it holds one;
 * - **Signals**, every other signal.
 *
 * A section with no signal is left out. Inside each, the signals back from a
 * snooze come first, then the oldest first, so the one that waited longest
 * leads. `high` does not reorder the list.
 */
export const groupSignalsIntoSections = (
  signals: ReadonlyArray<Signal>,
  pluginId: string | null,
): ReadonlyArray<IntakeSection> => {
  const shown = signals
    .filter((signal) => pluginId === null || parseSignalPluginId(signal.kind) === pluginId)
    .toSorted(compareInSection);
  const now = shown.filter((signal) => signal.priority === "urgent");
  const rest = shown.filter((signal) => signal.priority !== "urgent");
  return [
    ...(now.length > 0 ? [{ key: "now", label: "Now", signals: now } as const] : []),
    ...(rest.length > 0 ? [{ key: "signals", label: "Signals", signals: rest } as const] : []),
  ];
};

/**
 * Returns the second line of a signal's row: who asks, the kind and where,
 * such as "Marta · review requested · acme/webshop#1296". A core signal
 * with no asker names its source in the asker's place. An `unsure` signal
 * leaves its kind out, because its row labels it "Unsure" already.
 */
export const describeSignalRow = (signal: Signal, plugins: ReadonlyArray<PluginName>): string => {
  const asker =
    signal.asker ?? (isCoreSignalKind(signal.kind) ? nameSignalSource(signal, plugins) : undefined);
  const kind = signal.kind === "unsure" ? undefined : lowerFirst(nameSignalKind(signal.kind));
  return [asker, kind, signal.place].filter((part) => part !== undefined).join(" · ");
};

/**
 * Returns the line under the pane's title: who asks and where, such as
 * "Marta asks in acme/webshop#1296". The time is drawn beside it, so it is
 * not part of the line. Returns `null` when the signal names neither.
 */
export const describeSignalAsker = (signal: Signal): string | null => {
  if (signal.asker !== undefined && signal.place !== undefined)
    return `${signal.asker} asks in ${signal.place}`;
  if (signal.asker !== undefined) return `${signal.asker} asks`;
  if (signal.place !== undefined) return `In ${signal.place}`;
  return null;
};

/**
 * Returns the line the pane shows when the plugin could not draw the signal
 * and the core wrote it from the event instead, or `null` when the plugin
 * drew it.
 */
export const describeBuildFailure = (
  signal: Signal,
  plugins: ReadonlyArray<PluginName>,
): string | null =>
  signal.buildError === undefined
    ? null
    : `${nameSignalSource(signal, plugins)} couldn't draw this signal. Showing the event as it came in.`;

/** How the pane draws an answer. */
export type SignalAnswerStyle =
  /** An action with a `field`: a text box with its button. */
  | "reply"
  /** Done, which the core adds and the user's own list keeps. */
  | "done"
  /** An answer that runs nothing, such as Dismiss: drawn quiet. */
  | "quiet"
  /** Any other answer. */
  | "plain";

/** One answer of a signal, as the pane draws it. */
export interface SignalAnswer {
  readonly action: SignalAction;
  readonly style: SignalAnswerStyle;
  /** Whether this is the signal's suggested answer, its `primary` action. At most one is. */
  readonly suggested: boolean;
  /**
   * The workflow a Hand to an agent answer starts, whose face its button
   * wears, or `null` for every other answer.
   */
  readonly workflowId: string | null;
}

/** Returns how the pane draws `action`. */
const chooseAnswerStyle = (action: SignalAction): SignalAnswerStyle => {
  if (action.id === DONE_ACTION_ID) return "done";
  if (action.field !== undefined) return "reply";
  if (action.operation === null) return "quiet";
  return "plain";
};

/**
 * Returns the workflow an action starts: the `workflowId` of a `run.start`
 * binding, as the core binds Hand to an agent (spec 10 §9.4), or `null` for
 * an action that starts no workflow.
 */
const readStartedWorkflowId = (action: SignalAction): string | null => {
  if (action.operation?.op !== "run.start") return null;
  const input: unknown = action.operation.input;
  if (typeof input !== "object" || input === null || !("workflowId" in input)) return null;
  return typeof input.workflowId === "string" ? input.workflowId : null;
};

/** Returns where an action goes in the pane: the plugin's actions first, then Hand to an agent, then Done. */
const rankAnswer = (action: SignalAction): number => {
  if (action.id === DONE_ACTION_ID) return 2;
  if (action.id.startsWith(HAND_TO_ACTION_PREFIX)) return 1;
  return 0;
};

/**
 * Returns a signal's answers in the order the pane draws them: the plugin's
 * or the raiser's actions as they were given, then each Hand to an agent,
 * then Done. The `primary` action is the suggested answer.
 */
export const buildSignalAnswers = (signal: Signal): ReadonlyArray<SignalAnswer> =>
  signal.actions
    .toSorted((a, b) => rankAnswer(a) - rankAnswer(b))
    .map((action) => ({
      action,
      style: chooseAnswerStyle(action),
      suggested: action.primary === true,
      workflowId: readStartedWorkflowId(action),
    }));

/** Returns the suggested answer among `answers`, or `undefined` when the signal suggests none. */
export const findSuggestedAnswer = (
  answers: ReadonlyArray<SignalAnswer>,
): SignalAnswer | undefined => answers.find((answer) => answer.suggested);

/** Returns the first answer with a text box, which `R` opens, or `undefined` when there is none. */
export const findReplyAnswer = (answers: ReadonlyArray<SignalAnswer>): SignalAnswer | undefined =>
  answers.find((answer) => answer.style === "reply");

/**
 * Returns an answer's label without the ellipsis at its end, if it has one:
 * "Reply…" becomes "Reply". The ellipsis means the answer asks for more,
 * such as a typed reply, so a button or a sentence that already asks drops it.
 */
export const trimAnswerEllipsis = (label: string): string => label.replace(/…$/, "");

/**
 * Returns what a key in the pane's foot does with an answer, in lower case:
 * "approve" for Approve, "reply" for "Reply…". A suggested reply reads
 * "write the reply", because its `↩` puts the focus in the text box.
 */
export const describeAnswerKey = (answer: SignalAnswer, key: "↩" | "R"): string =>
  key === "↩" && answer.style === "reply"
    ? "write the reply"
    : lowerFirst(trimAnswerEllipsis(answer.action.label));

/** How a resolved signal's pane names what ended it. */
export interface SignalOutcome {
  /** "What you did" when the user's move ended it; "Left on its own" otherwise. */
  readonly label: string;
  /** The resolution's one line, such as "Approved #1293". */
  readonly outcome: string;
  /** Who ended it: "by you", "by GitHub", "by an agent". */
  readonly by: string;
  /** Whether the user's own move ended it, which the pane draws with a filled mark. */
  readonly byUser: boolean;
}

/**
 * Returns how a resolved signal ended, for the outcome the pane shows in
 * place of the answers, or `null` while the signal is open.
 *
 * A signal the user decided reads "What you did"; one withdrawn, or decided
 * by someone else on the source, reads "Left on its own".
 */
export const describeSignalOutcome = (
  signal: Signal,
  plugins: ReadonlyArray<PluginName>,
): SignalOutcome | null => {
  const { resolution } = signal;
  if (signal.status === "open" || resolution === undefined) return null;
  const byUser = resolution.kind === "decided" && resolution.actor === "user";
  return {
    label: byUser ? "What you did" : "Left on its own",
    outcome: resolution.outcome,
    by: `by ${nameActor(resolution.actor, plugins)}`,
    byUser,
  };
};

/**
 * Returns the line the pane shows when the open signal was resolved while
 * the user had it open, by someone or something other than this pane:
 * "Resolved elsewhere: approved #1293, by GitHub". Returns `null` while
 * the signal is open.
 */
export const describeResolvedElsewhere = (
  signal: Signal,
  plugins: ReadonlyArray<PluginName>,
): string | null => {
  const outcome = describeSignalOutcome(signal, plugins);
  return outcome === null
    ? null
    : `Resolved elsewhere: ${lowerFirst(outcome.outcome)}, ${outcome.by}`;
};

/** A Now signal as a native notification shows it. The shape main takes on `urgentSignals.set`. */
export interface UrgentSignal {
  readonly signalId: string;
  /** The notification's title: the signal's source, such as "GitHub". */
  readonly title: string;
  /** The notification's text: the signal's title. */
  readonly body: string;
}

/**
 * Returns the Now signals on To do as their notifications show them, the
 * oldest first. Main notifies for each one it has not shown yet, while the
 * window is not focused.
 */
export const listUrgentSignals = (
  signals: ReadonlyArray<Signal>,
  plugins: ReadonlyArray<PluginName>,
): ReadonlyArray<UrgentSignal> =>
  signals
    .filter((signal) => signal.priority === "urgent")
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((signal) => ({
      signalId: signal.id,
      title: nameSignalSource(signal, plugins),
      body: signal.title,
    }));

/**
 * Returns the id of the signal `step` rows away from `selectedId` in the
 * list's order, for `J`, `K` and the arrow keys. With no selection, or a
 * selected signal that has left the list, `J` selects the first row and `K`
 * the last. At either end the selection stays where it is. Returns `null`
 * when the list is empty.
 */
export const moveSignalSelection = (
  sections: ReadonlyArray<IntakeSection>,
  selectedId: string | null,
  step: 1 | -1,
): string | null => {
  const ids = sections.flatMap((section) => section.signals.map((signal) => signal.id));
  if (ids.length === 0) return null;
  const index = selectedId === null ? -1 : ids.indexOf(selectedId);
  if (index < 0) return step === 1 ? ids[0]! : ids.at(-1)!;
  return ids[Math.min(ids.length - 1, Math.max(0, index + step))]!;
};

/**
 * Returns the initials a message's author shows in place of an avatar: the
 * first letter of the first and the last word of `name`, in capitals, such
 * as "MV" for "Marta de Vries", or one letter for a one-word name.
 */
export const buildInitials = (name: string): string => {
  const words = name.split(/\s+/).filter((word) => word !== "");
  const first = words[0]?.charAt(0) ?? "";
  const last = words.length > 1 ? words.at(-1)!.charAt(0) : "";
  return (first + last).toUpperCase();
};

/** The list's width when the user has never dragged the split's handle: the drawing's. */
export const DEFAULT_INTAKE_LIST_WIDTH = 432;

/** The narrowest the list may be. */
export const MIN_INTAKE_LIST_WIDTH = 360;

/** The narrowest the pane may be. Below both minimums together, the pane hides. */
export const MIN_INTAKE_PANE_WIDTH = 400;

/**
 * Parses the stored width of Intake's list. Returns
 * `DEFAULT_INTAKE_LIST_WIDTH` for nothing stored and for anything that is not
 * a width the user could have dragged to.
 */
export const parseIntakeListWidth = (raw: string | null): number => {
  const width = Number(raw);
  return raw === null || !Number.isFinite(width) || width < MIN_INTAKE_LIST_WIDTH
    ? DEFAULT_INTAKE_LIST_WIDTH
    : Math.round(width);
};

/**
 * Checks whether the list and the pane both fit in `available`, the width
 * they share, each at its minimum. When they do not, the pane hides.
 */
export const fitsIntakePane = (available: number): boolean =>
  available >= MIN_INTAKE_LIST_WIDTH + MIN_INTAKE_PANE_WIDTH;

/**
 * Returns the list's width to draw beside the pane: `width`, made no
 * narrower than `MIN_INTAKE_LIST_WIDTH` and narrow enough to leave the pane
 * `MIN_INTAKE_PANE_WIDTH` of `available`, the width the two share.
 */
export const fitIntakeListWidth = (width: number, available: number): number =>
  Math.max(MIN_INTAKE_LIST_WIDTH, Math.min(width, available - MIN_INTAKE_PANE_WIDTH));
