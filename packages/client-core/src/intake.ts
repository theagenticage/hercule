/**
 * How Intake reads the signals on To do: the count, the tabs, the sections
 * and their order, the day sections of Later and Done, what a row and the pane say, and the answers in the order
 * the pane draws them. Spec 17 §Intake owns the screen; spec 10 §9 owns the
 * Signal record.
 *
 * Every client that draws Intake uses these functions, so the desktop app,
 * its notifications and the sidebar's count never disagree about a signal.
 */
import {
  DONE_ACTION_ID,
  EVENT_HANDLINGS,
  HAND_TO_ACTION_PREFIX,
  isCoreSignalKind,
  type Event,
  type EventFacts,
  type EventHandling,
  type EventWithFacts,
  type PluginMark,
  type Signal,
  type SignalAction,
  type SignalOrigin,
  type SignalView,
} from "@hercule/contract";
import { parsePluginId } from "./plugin-id";
import { countCalendarDaysBetween, formatRelativeDay, formatRelativeMoment } from "./time-context";

/** A plugin's id and the name the user knows it by, as `plugin.query` returns them. */
export interface PluginName {
  readonly id: string;
  readonly displayName: string;
}

/** A plugin's id, its name and the mark it declares, as `plugin.query` returns them. */
export interface PluginIdentity extends PluginName {
  readonly mark?: PluginMark;
}

/** A workflow's or an assistant's id and name, as `workflow.query` and `assistant.query` return them. */
export interface RaiserName {
  readonly id: string;
  readonly name: string;
}

/** The stored workflows and the assistants, whose names a signal they raised shows as its source. */
export interface SignalRaiserNames {
  readonly workflows: ReadonlyArray<RaiserName>;
  readonly assistants: ReadonlyArray<RaiserName>;
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

/**
 * Returns `text` with its first letter in lower case: "Review requested"
 * becomes "review requested". Text that starts with an acronym, such as
 * "FYI", is returned unchanged, because "fYI" would misspell it.
 */
export const lowerFirst = (text: string): string =>
  /^\p{Lu}{2}/u.test(text) ? text : text.charAt(0).toLowerCase() + text.slice(1);

/** Returns `text` with its first letter in upper case: "an agent" becomes "An agent". */
const upperFirst = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Returns the label of a signal's kind: "Mentioned" for `github/mentioned`,
 * "Review requested" for `github/review-requested`, "Proposal" for
 * `proposal`.
 *
 * A plugin declares no label for its kinds, so the label is made from the
 * word after the "/": dashes become spaces and the first letter is a
 * capital.
 */
export const nameSignalKind = (kind: string): string =>
  CORE_KIND_LABELS[kind] ?? upperFirst(kind.slice(kind.indexOf("/") + 1).replaceAll("-", " "));

/** Returns the name of the plugin `pluginId`, or the id itself when the plugin is not listed. */
export const namePlugin = (pluginId: string, plugins: ReadonlyArray<PluginName>): string =>
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
 * Returns who raised a signal with `signal.raise`, as the middle of a
 * sentence:
 *
 * - a run names its workflow, or "a workflow" for a run of a sent workflow,
 *   or of a workflow `raisers` no longer lists because it was deleted;
 * - a session of an assistant's conversation names the assistant, or "an
 *   agent" for an assistant `raisers` no longer lists;
 * - any other raiser is named from its actor stamp, as `nameActor` does. A
 *   session that is neither a run's nor an assistant's stays "an agent",
 *   because spec 10 §9.1 lists no other source it could name.
 */
const nameSignalRaiser = (
  origin: Extract<SignalOrigin, { readonly type: "api" }>,
  plugins: ReadonlyArray<PluginName>,
  raisers: SignalRaiserNames,
): string => {
  if (origin.runId !== undefined || origin.workflowId !== undefined) {
    return (
      raisers.workflows.find((workflow) => workflow.id === origin.workflowId)?.name ?? "a workflow"
    );
  }
  if (origin.assistantId !== undefined) {
    return (
      raisers.assistants.find((assistant) => assistant.id === origin.assistantId)?.name ??
      "an agent"
    );
  }
  return nameActor(origin.actor, plugins);
};

/**
 * Returns the name of a signal's source, as its row and its pane show it:
 *
 * - a plugin kind names its plugin: "GitHub";
 * - a core kind raised from an event names the core: "Hercule";
 * - any other core kind names who raised it: "You", a plugin's name, the
 *   workflow's or the assistant's name, "A workflow", "An agent" or
 *   "Hercule".
 */
export const nameSignalSource = (
  signal: Signal,
  plugins: ReadonlyArray<PluginName>,
  raisers: SignalRaiserNames,
): string => {
  const pluginId = parsePluginId(signal.kind);
  if (pluginId !== null) return namePlugin(pluginId, plugins);
  if (signal.origin.type === "event") return CORE_SOURCE_NAME;
  return upperFirst(nameSignalRaiser(signal.origin, plugins, raisers));
};

/**
 * Returns the provenance line at the top of the pane: the source and the
 * kind, such as "GitHub · Mentioned", "You · Proposal" or "Triage · Offer".
 */
export const describeSignalProvenance = (
  signal: Signal,
  plugins: ReadonlyArray<PluginName>,
  raisers: SignalRaiserNames,
): string => `${nameSignalSource(signal, plugins, raisers)} · ${nameSignalKind(signal.kind)}`;

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
export interface IntakeTab {
  /** The plugin whose signals the tab shows, or `null` for All. */
  readonly pluginId: string | null;
  readonly label: string;
  /** The tab's To do count. The tab hides it at 0. */
  readonly count: number;
}

/** A plugin as the tabs read it: its name, and the signal kinds its Intake settings switch on. */
export interface IntakeTabPlugin extends PluginName {
  readonly intake: { readonly signalKinds: ReadonlyArray<{ readonly on: boolean }> };
}

/**
 * Returns Intake's tabs: All, then one per plugin that has a signal kind
 * switched on in its Intake settings, or a signal on To do now, or that is
 * the tab `pressedPluginId` names. Plugins come in the order `plugins` lists
 * them.
 *
 * The tabs are worked out from the settings and the To do signals, which every
 * view reads, so a switch between views keeps the same tabs, and a tab does
 * not vanish when its last signal is done. A plugin with every signal kind
 * switched off keeps its tab only while it has a signal on To do.
 *
 * A plugin that `plugins` does not list, such as one removed while its signals
 * are still open, still gets its tab, named by its id, after the listed ones.
 *
 * Core signals have no tab of their own: they show under All only. The
 * Triage tab comes with the triage workflow (#533).
 */
export const buildIntakeTabs = (
  signals: ReadonlyArray<Signal>,
  plugins: ReadonlyArray<IntakeTabPlugin>,
  pressedPluginId: string | null,
): ReadonlyArray<IntakeTab> => {
  const current = signals.map((signal) => parsePluginId(signal.kind)).filter((id) => id !== null);
  const wanted = new Set(current);
  if (pressedPluginId !== null) wanted.add(pressedPluginId);
  const listed = plugins.filter(
    (plugin) => wanted.has(plugin.id) || plugin.intake.signalKinds.some((kind) => kind.on),
  );
  const unlisted = [...wanted]
    .filter((id) => !plugins.some((plugin) => plugin.id === id))
    .sort()
    .map((id) => ({ id, displayName: id }));
  return [
    { pluginId: null, label: "All", count: signals.length },
    ...[...listed, ...unlisted].map((plugin) => ({
      pluginId: plugin.id,
      label: plugin.displayName,
      count: current.filter((id) => id === plugin.id).length,
    })),
  ];
};

/** One section of an Intake list, under its heading. */
export interface IntakeSection {
  /**
   * On To do, `now` holds the `urgent` signals and `signals` every other
   * one. On Later and Done, each calendar date has its own section, keyed
   * `day:` and the number of days from today, such as `day:-1`.
   */
  readonly key: string;
  /** The heading: "Now", "Signals", "Back Monday", "Yesterday". */
  readonly label: string;
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
    .filter((signal) => pluginId === null || parsePluginId(signal.kind) === pluginId)
    .toSorted(compareInSection);
  const now = shown.filter((signal) => signal.priority === "urgent");
  const rest = shown.filter((signal) => signal.priority !== "urgent");
  return [
    ...(now.length > 0 ? [{ key: "now", label: "Now", signals: now } as const] : []),
    ...(rest.length > 0 ? [{ key: "signals", label: "Signals", signals: rest } as const] : []),
  ];
};

/**
 * Groups `items` into runs that share a calendar date in `timezone`, in the
 * order `items` holds them. `readTime` gives the moment that decides an
 * item's date, and `buildLabel` the heading of a date from its name relative
 * to `now`, as `formatRelativeDay` names it. A section's key is `day:` and the
 * number of days from today.
 */
const groupByDay = <Item>(
  items: ReadonlyArray<Item>,
  readTime: (item: Item) => Date,
  buildLabel: (day: string) => string,
  now: Date,
  timezone: string,
): ReadonlyArray<{ readonly key: string; readonly label: string; readonly items: Item[] }> => {
  const sections: Array<{ key: string; label: string; items: Item[] }> = [];
  for (const item of items) {
    const at = readTime(item);
    const key = `day:${String(countCalendarDaysBetween(now, at, timezone))}`;
    const last = sections.at(-1);
    if (last?.key === key) {
      last.items.push(item);
      continue;
    }
    // Only a zone this runtime cannot read leaves a date unnamed; the
    // heading is then left empty rather than wrong.
    sections.push({
      key,
      label: buildLabel(formatRelativeDay(at, now, timezone) ?? ""),
      items: [item],
    });
  }
  return sections;
};

/**
 * Groups the signals of Later or Done into one section per calendar date in
 * `timezone`, in the order `signals` holds them, which the controller sorts:
 *
 * - Later, by the date each signal comes back: "Back today", "Back Monday";
 * - Done, by the date each was resolved: "Today", "Yesterday", "Friday".
 *
 * The dates are named relative to `now`, as `formatRelativeDay` names them.
 */
export const groupSignalsByDay = (
  signals: ReadonlyArray<Signal>,
  view: "later" | "done",
  now: Date,
  timezone: string,
): ReadonlyArray<IntakeSection> =>
  groupByDay(
    signals,
    (signal) => new Date((view === "later" ? signal.snooze?.until : signal.resolution?.at) ?? ""),
    (day) => (view === "later" ? `Back ${day}` : upperFirst(day)),
    now,
    timezone,
  ).map(({ key, label, items }) => ({ key, label, signals: items }));

/**
 * Returns the second line of a signal's row: who asks, the kind and where,
 * such as "Marta · review requested · acme/webshop#1296". A core signal
 * with no asker names its source in the asker's place. An `unsure` signal
 * leaves its kind out, because its row labels it "Unsure" already.
 */
export const describeSignalRow = (
  signal: Signal,
  plugins: ReadonlyArray<PluginName>,
  raisers: SignalRaiserNames,
): string => {
  const asker =
    signal.asker ??
    (isCoreSignalKind(signal.kind) ? nameSignalSource(signal, plugins, raisers) : undefined);
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
  raisers: SignalRaiserNames,
): string | null =>
  signal.buildError === undefined
    ? null
    : `${nameSignalSource(signal, plugins, raisers)} couldn't draw this signal. Showing the event as it came in.`;

/**
 * Returns the Screening line the pane shows when a signal was raised without
 * the Screener deciding on it, or `null` when the Screener let it through or
 * its kind asks for no Screening. The core raises such a signal anyway, because
 * a missed question costs more than one the user marks Done (spec 10 §9.8,
 * "Fail open"), and this line tells the user that nothing screened it.
 */
export const describeNotScreened = (signal: Signal): string | null =>
  signal.origin.type === "event" && signal.origin.notScreened !== undefined
    ? "Not screened: no workflow screens signals"
    : null;

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
 * Returns the workflow a Hand to an agent answer starts: the `workflowId` of
 * the `run.start` the core binds (spec 10 §9.4), or `null` for any other
 * answer, a raiser's own `run.start` included.
 */
const readStartedWorkflowId = (action: SignalAction): string | null => {
  if (!action.id.startsWith(HAND_TO_ACTION_PREFIX) || action.operation?.op !== "run.start") {
    return null;
  }
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
  /** Whether the user's own move ended it, which the pane draws with a green mark. */
  readonly byUser: boolean;
}

/**
 * Returns the line under a resolved signal's outcome in the pane: where and
 * when it ended, and by whom, with the moment relative to `now` in
 * `timezone`:
 *
 * - "Here · today 10:42 · by you" when the user's move ended it;
 * - "Withdrawn by GitHub · today 10:42" when its source withdrew it;
 * - "Resolved by GitHub · yesterday 16:05" when someone else decided it.
 *
 * Returns `null` while the signal is open.
 */
export const describeSignalOutcomeMoment = (
  signal: Signal,
  plugins: ReadonlyArray<PluginName>,
  now: Date,
  timezone: string,
): string | null => {
  const { resolution } = signal;
  if (signal.status === "open" || resolution === undefined) return null;
  const moment = formatRelativeMoment(new Date(resolution.at), now, timezone) ?? "";
  if (resolution.kind === "decided" && resolution.actor === "user")
    return `Here · ${moment} · by you`;
  const ended = resolution.kind === "withdrawn" ? "Withdrawn" : "Resolved";
  return `${ended} by ${nameActor(resolution.actor, plugins)} · ${moment}`;
};

/**
 * Returns how a resolved signal ended, for the outcome the pane shows in
 * place of the answers, or `null` while the signal is open.
 *
 * A signal the user decided reads "What you did"; one withdrawn, or decided
 * by someone else on the source, reads "Left on its own".
 *
 * The user may also answer on the source itself, such as a review submitted
 * on GitHub. The core then resolves the signal as `decided`, stamped
 * `system`, with the `actionId` of the action the answer matches. That is
 * still the user's move, so it reads "What you did: Reviewed on GitHub, by
 * you". The kind's outcome already names the source (spec 10 §9.6).
 */
export const describeSignalOutcome = (
  signal: Signal,
  plugins: ReadonlyArray<PluginName>,
): SignalOutcome | null => {
  const { resolution } = signal;
  if (signal.status === "open" || resolution === undefined) return null;
  const answeredOnSource =
    resolution.kind === "decided" &&
    resolution.actor === "system" &&
    resolution.actionId !== undefined &&
    parsePluginId(signal.kind) !== null;
  const byUser = (resolution.kind === "decided" && resolution.actor === "user") || answeredOnSource;
  return {
    label: byUser ? "What you did" : "Left on its own",
    outcome: resolution.outcome,
    by: answeredOnSource ? "by you" : `by ${nameResolver(signal, resolution.actor, plugins)}`,
    byUser,
  };
};

/**
 * Returns who resolved a signal, as the middle of a sentence. The core stamps
 * the actor `system` on an end it observed on the source, such as a review
 * submitted on GitHub, so a plugin's signal names its plugin there. It also
 * stamps `system` on a signal a newer one replaced, but that is the core's
 * own move (spec 10 §9.6), so a replaced signal names the core. Any other
 * actor is named as `nameActor` does.
 */
const nameResolver = (
  signal: Signal,
  actor: string,
  plugins: ReadonlyArray<PluginName>,
): string => {
  const pluginId = parsePluginId(signal.kind);
  return actor === "system" && pluginId !== null && signal.replacedBy === undefined
    ? namePlugin(pluginId, plugins)
    : nameActor(actor, plugins);
};

/**
 * Returns the line the pane shows when the open signal was resolved while
 * the user had it open, by someone or something other than this pane:
 * "Resolved elsewhere: approved #1293, by GitHub". Returns `null` while
 * the signal is open.
 *
 * An outcome the core observed on the source keeps its first letter as the
 * plugin wrote it, because such an outcome can start with a name: "Marta
 * removed the request" must not become "marta removed the request".
 */
export const describeResolvedElsewhere = (
  signal: Signal,
  plugins: ReadonlyArray<PluginName>,
): string | null => {
  const outcome = describeSignalOutcome(signal, plugins);
  if (outcome === null) return null;
  const text =
    signal.resolution?.actor === "system" ? outcome.outcome : lowerFirst(outcome.outcome);
  return `Resolved elsewhere: ${text}, ${outcome.by}`;
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
 *
 * Only a plugin's kind may be `urgent` (spec 10 §9.3), so each title is a
 * plugin's name, and no workflow or assistant is needed to name it.
 */
export const listUrgentSignals = (
  signals: ReadonlyArray<Signal>,
  plugins: ReadonlyArray<PluginName>,
): ReadonlyArray<UrgentSignal> =>
  signals
    .filter((signal) => signal.priority === "urgent")
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((signal) => {
      const pluginId = parsePluginId(signal.kind);
      return {
        signalId: signal.id,
        title: pluginId === null ? CORE_SOURCE_NAME : namePlugin(pluginId, plugins),
        body: signal.title,
      };
    });

/**
 * Returns the id `step` places away from `selectedId` in `ids`, for `J`, `K`
 * and the arrow keys. With no selection, or a selected id that is not in the
 * list, `J` selects the first and `K` the last. At either end the selection
 * stays where it is. Returns `null` when the list is empty.
 */
const moveSelection = <Id>(
  ids: ReadonlyArray<Id>,
  selectedId: Id | null,
  step: 1 | -1,
): Id | null => {
  if (ids.length === 0) return null;
  const index = selectedId === null ? -1 : ids.indexOf(selectedId);
  if (index < 0) return step === 1 ? ids[0]! : ids.at(-1)!;
  return ids[Math.min(ids.length - 1, Math.max(0, index + step))]!;
};

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
): string | null =>
  moveSelection(
    sections.flatMap((section) => section.signals.map((signal) => signal.id)),
    selectedId,
    step,
  );

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

/** The views of Intake's list: the three over signals, and Everything over the events behind them. */
export type IntakeView = SignalView | "everything";

/**
 * The record a handling's label links to. A client opens the ones it has a
 * screen for and draws the rest as plain text.
 */
export type EventHandlingTarget =
  | { readonly kind: "signal"; readonly signalId: string; readonly view: SignalView }
  | { readonly kind: "task"; readonly taskId: string }
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "run"; readonly runId: string }
  | { readonly kind: "conversation"; readonly conversationId: string }
  | { readonly kind: "ignore-rule"; readonly signalKind: string };

/**
 * One handling of an event, as a row or the pane shows it. A row draws
 * `lead` and `detail` on one line. The pane draws the handling's caption, then
 * `record`, then `standing`, one under the other.
 */
export interface EventHandlingLabel {
  /** The handling this label is for. */
  readonly handling: EventHandling;
  /** Tells the labels of one event apart: an event can have several of one handling. */
  readonly key: string;
  /** The row's first part, which it draws with more weight: "→ signal", "known to Release thread", "no action". */
  readonly lead: string;
  /** What follows the lead in the row, after " · ": the state, the title or the outcome. `null` when there is none. */
  readonly detail: string | null;
  /** The pane's name of the record the handling is about: a signal's or a Task's title. `null` when it names none. */
  readonly record: string | null;
  /** The pane's line under the record: where it stands, such as "on your To do list" or "Thread". `null` when there is none. */
  readonly standing: string | null;
  /** The record the label links to, or `null` when it names none. */
  readonly target: EventHandlingTarget | null;
}

/**
 * Describes the holder of a Subscription that received an event: the name to
 * show when the caller may not read it, what kind of record it is, and the
 * record to link to. A conversation names the assistant it belongs to, and no
 * screen opens a conversation by its own id, so its label links nowhere.
 */
const describeKnownHolder = (
  holder: EventFacts["knownBy"][number]["holder"],
): {
  readonly fallbackName: string;
  readonly standing: string;
  readonly target: EventHandlingTarget;
} => {
  switch (holder.kind) {
    case "session":
      return {
        fallbackName: "a Thread",
        standing: "Thread",
        target: { kind: "session", sessionId: holder.id },
      };
    case "run":
      return { fallbackName: "a run", standing: "Run", target: { kind: "run", runId: holder.id } };
    case "conversation":
      return {
        fallbackName: "an assistant",
        standing: "Assistant",
        target: { kind: "conversation", conversationId: holder.id },
      };
  }
};

/**
 * Decides which view a signal is on, from the facts of an event: Done once
 * resolved, Later while its snooze runs, else To do. A snooze whose time has
 * passed no longer holds the signal back.
 */
const decideSignalView = (fact: EventFacts["signals"][number], now: Date): SignalView => {
  if (fact.status === "resolved") return "done";
  const snoozed = fact.snoozedUntil !== undefined && new Date(fact.snoozedUntil) > now;
  return snoozed ? "later" : "to-do";
};

/**
 * Names where a signal stands, for the label of the event that raised it:
 * "on your To do list", "Later · back Monday" or "Done · Replied in Gmail".
 * The day a snoozed signal comes back is named in `timezone`.
 */
const describeSignalStanding = (
  fact: EventFacts["signals"][number],
  now: Date,
  timezone: string,
): string => {
  const view = decideSignalView(fact, now);
  if (view === "done") return fact.outcome === undefined ? "Done" : `Done · ${fact.outcome}`;
  if (view === "to-do") return "on your To do list";
  const day = formatRelativeDay(new Date(fact.snoozedUntil!), now, timezone);
  return day === undefined ? "Later" : `Later · back ${day}`;
};

/**
 * Builds the label of an event an Ignore Rule caught. The row reads "→
 * ignored by a rule", or "→ ignored by a deleted rule" once the user has
 * deleted it; the rule's text is too long for the row, so only the pane shows
 * it. The label links the rule's kind on Settings > Intake, where the rule is
 * listed. A deleted rule is listed nowhere, so its label links nothing.
 */
const buildIgnoredLabel = (fact: NonNullable<EventFacts["ignoredBy"]>): EventHandlingLabel => ({
  handling: "ignored",
  key: `ignored:${fact.ruleId}`,
  lead: fact.ruleDeleted ? "→ ignored by a deleted rule" : "→ ignored by a rule",
  detail: null,
  record: fact.text,
  standing: fact.ruleDeleted ? "Rule deleted" : "In Settings › Intake",
  target: fact.ruleDeleted ? null : { kind: "ignore-rule", signalKind: fact.kind },
});

/**
 * Builds the labels of what came of an event, in the order spec 10 §9.10
 * fixes, whatever order the facts come in:
 *
 * - a plugin's signal the event raised: "→ signal · on your To do list";
 * - a signal the event ended: "ended Review this PR · Approved on GitHub";
 * - the Ignore Rule that caught it: "→ ignored by a rule", or "→ ignored by
 *   a deleted rule" once the user has deleted the rule;
 * - a core signal that lists the event: "→ proposal · Fix the flaky test";
 * - a Task whose provenance carries the event: "→ Fix the flaky test";
 * - a live Subscription that received it: "known to Release thread", or
 *   "known to a Thread" when the caller may not read the holder's title;
 * - "no action", only when none of the others applies.
 *
 * Pending triage and the Screener's two states wait for the features that
 * produce them, so no label is built for them. A signal's state
 * is read as of `now` in `timezone`, which names the day a snoozed signal
 * comes back.
 */
export const buildHandlingLabels = (
  facts: EventFacts,
  now: Date,
  timezone: string,
): ReadonlyArray<EventHandlingLabel> => {
  const raised = facts.signals.filter((fact) => !isCoreSignalKind(fact.kind));
  const evidence = facts.signals.filter((fact) => isCoreSignalKind(fact.kind));
  const labels: EventHandlingLabel[] = [
    ...raised.map((fact): EventHandlingLabel => {
      const standing = describeSignalStanding(fact, now, timezone);
      return {
        handling: "raised-signal",
        key: `raised-signal:${fact.signalId}`,
        lead: "→ signal",
        detail: standing,
        record: fact.title,
        standing,
        target: { kind: "signal", signalId: fact.signalId, view: decideSignalView(fact, now) },
      };
    }),
    ...facts.resolvedSignals.map((fact): EventHandlingLabel => ({
      handling: "ended-signal",
      key: `ended-signal:${fact.signalId}`,
      lead: `ended ${fact.title}`,
      detail: fact.outcome,
      record: fact.title,
      standing: fact.outcome,
      target: { kind: "signal", signalId: fact.signalId, view: "done" },
    })),
    ...(facts.ignoredBy === null ? [] : [buildIgnoredLabel(facts.ignoredBy)]),
    ...evidence.map((fact): EventHandlingLabel => ({
      handling: "evidence",
      key: `evidence:${fact.signalId}`,
      lead: `→ ${lowerFirst(nameSignalKind(fact.kind))}`,
      detail: fact.title,
      record: fact.title,
      standing: `${nameSignalKind(fact.kind)} · ${describeSignalStanding(fact, now, timezone)}`,
      target: { kind: "signal", signalId: fact.signalId, view: decideSignalView(fact, now) },
    })),
    ...facts.tasks.map((fact): EventHandlingLabel => ({
      handling: "on-task",
      key: `on-task:${fact.taskId}`,
      lead: `→ ${fact.title}`,
      detail: null,
      record: fact.title,
      standing: null,
      target: { kind: "task", taskId: fact.taskId },
    })),
    ...facts.knownBy.map((fact): EventHandlingLabel => {
      const known = describeKnownHolder(fact.holder);
      // The title is null when the caller may not read the holder.
      const holder = fact.title ?? known.fallbackName;
      return {
        handling: "known-work",
        key: `known-work:${fact.subscriptionId}`,
        lead: `known to ${holder}`,
        detail: null,
        record: holder,
        standing: known.standing,
        target: known.target,
      };
    }),
  ];
  if (labels.length > 0) return labels;
  return [
    {
      handling: "no-action",
      key: "no-action",
      lead: "no action",
      detail: null,
      record: null,
      standing: null,
      target: null,
    },
  ];
};

/** How many handlings an event's row shows before it counts the rest. */
const ROW_HANDLING_COUNT = 2;

/**
 * Cuts the labels of an event's row to the first two, which are the most
 * telling ones because the order is fixed, and counts the rest as the row's
 * "+N". The pane shows every label and does not cut.
 */
export const cutHandlingLabels = (
  labels: ReadonlyArray<EventHandlingLabel>,
): { readonly shown: ReadonlyArray<EventHandlingLabel>; readonly more: number } => ({
  shown: labels.slice(0, ROW_HANDLING_COUNT),
  more: Math.max(0, labels.length - ROW_HANDLING_COUNT),
});

/** One option of Everything's filter menu: the handling it keeps, or `null` for every event. */
export interface EventHandlingOption {
  readonly handling: EventHandling | null;
  readonly caption: string;
}

/** The captions of the filter menu, one per handling. The word "handling" is never shown. */
const EVENT_HANDLING_CAPTIONS: Readonly<Record<EventHandling, string>> = {
  "raised-signal": "Raised a signal",
  "ended-signal": "Ended a signal",
  ignored: "Ignored by a rule",
  evidence: "Evidence for a signal",
  "on-task": "Added to a Task",
  "known-work": "Known to running work",
  "no-action": "No action",
};

/**
 * Returns the caption of `handling`, the words the filter menu offers it by,
 * which the event pane also puts over the block of each handling.
 */
export const describeHandlingCaption = (handling: EventHandling): string =>
  EVENT_HANDLING_CAPTIONS[handling];

/** The options of Everything's filter menu in the order it draws them: every event, then one per handling. */
export const EVENT_HANDLING_OPTIONS: ReadonlyArray<EventHandlingOption> = [
  { handling: null, caption: "All events" },
  ...EVENT_HANDLINGS.map((handling) => ({ handling, caption: EVENT_HANDLING_CAPTIONS[handling] })),
];

/** How many days the controller keeps events when the `retention.events` setting is not set. */
const DEFAULT_EVENT_RETENTION_DAYS = 90;

/**
 * Names the span the `retention.events` setting keeps: "the last 90 days", or
 * "the last day" for one. A setting that is not set reads as the default of
 * 90 days.
 */
export const describeRetentionSpan = (retentionDays: number | undefined): string => {
  const days = retentionDays ?? DEFAULT_EVENT_RETENTION_DAYS;
  return days === 1 ? "the last day" : `the last ${String(days)} days`;
};

/**
 * Describes how far back Everything reaches, from the `retention.events`
 * setting: "Events from the last 90 days", or "Events from the last day"
 * for one. A setting that is not set reads as the default of 90 days.
 */
export const describeEventHorizon = (retentionDays: number | undefined): string =>
  `Events from ${describeRetentionSpan(retentionDays)}`;

/**
 * Describes the end of Everything's list, which stops at the horizon:
 * "No more events from the last 90 days."
 */
export const describeEventListEnd = (retentionDays: number | undefined): string =>
  `No more events from ${describeRetentionSpan(retentionDays)}.`;

/**
 * Returns the moment Everything's list starts at, as an ISO timestamp for
 * `event.query`'s `since`: `retentionDays` before `now`. The controller may
 * still hold older events, because it removes them only at its next sweep,
 * so the client asks for the horizon it shows. A setting that is not set reads
 * as the default of 90 days.
 */
export const computeEventHorizonStart = (now: Date, retentionDays: number | undefined): string =>
  new Date(
    now.getTime() - (retentionDays ?? DEFAULT_EVENT_RETENTION_DAYS) * 24 * 60 * 60 * 1000,
  ).toISOString();

/** One day of Everything's list: its heading and the events received that day. */
export interface EventDaySection {
  /** Identifies the day: `day:` and the number of days from today, such as `day:-1`. */
  readonly key: string;
  /** The heading: "Today", "Yesterday", "Friday", "4 Nov". */
  readonly label: string;
  /** The day's events, in the order given. Never empty. */
  readonly events: ReadonlyArray<EventWithFacts>;
}

/**
 * Groups events into one section per calendar date in `timezone`, by when
 * each was received, in the order `events` holds them, which the controller
 * sorts newest first. The dates are named relative to `now`, as
 * `formatRelativeDay` names them.
 */
export const groupEventsByDay = (
  events: ReadonlyArray<EventWithFacts>,
  now: Date,
  timezone: string,
): ReadonlyArray<EventDaySection> =>
  groupByDay(events, (event) => new Date(event.receivedAt), upperFirst, now, timezone).map(
    ({ key, label, items }) => ({ key, label, events: items }),
  );

/**
 * Returns the title an event's row and pane show: the one-line title its
 * source set, or the event's kind for an event that has none.
 */
export const describeEventTitle = (event: Pick<EventWithFacts, "title" | "kind">): string =>
  event.title ?? event.kind;

/**
 * Names the system an event came from, for its mark and its "Open in" link.
 * A source that is a listed plugin gives the plugin's id and display name.
 * A source that is not listed but came through a Connection is a plugin that
 * was removed, so it gives its id as both, as `buildIntakeTabs` does. Any
 * other source is a core emitter, such as `cron` or `manual`, which has no
 * Connection and gives no plugin id, so the caller draws the core's mark, and
 * the core's name.
 */
export const describeEventSystem = (
  event: Pick<Event, "source" | "connectionId">,
  plugins: ReadonlyArray<PluginName>,
): { readonly pluginId: string | null; readonly name: string } =>
  event.connectionId !== null || plugins.some((plugin) => plugin.id === event.source)
    ? { pluginId: event.source, name: namePlugin(event.source, plugins) }
    : { pluginId: null, name: CORE_SOURCE_NAME };

/**
 * Returns the id of the event `step` rows away from `selectedId` in
 * `events`, for `J`, `K` and the arrow keys on Everything. With no
 * selection, or a selected event that has left the list, `J` selects the
 * first row and `K` the last. At either end the selection stays where it is.
 * Returns `null` when the list is empty.
 */
export const moveEventSelection = (
  events: ReadonlyArray<Pick<EventWithFacts, "id">>,
  selectedId: number | null,
  step: 1 | -1,
): number | null =>
  moveSelection(
    events.map((event) => event.id),
    selectedId,
    step,
  );
