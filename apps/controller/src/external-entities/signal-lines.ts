/**
 * The signals that live inside an External Entity: the lines a card or a
 * detail shows, and the sentence a card says for its latest signal.
 *
 * A signal and an entity meet by exact equality of `signals.thread_ref` and
 * `external_entities.ref`, on read. Nothing is stored on either side. The
 * signals domain owns every read of the signals by thread ref, and decides
 * which signal is live (open and not snoozed now). This module only turns what
 * it returns into the contract's lines, using the entity's reason templates.
 */
import type {
  EntityReason,
  EntitySignalLine,
  ExternalEntityDetail,
  InboxCard,
} from "@hercule/contract";
import type { LiveThreadSignals, ThreadSignal, ThreadSignalLines } from "../signals";
import { parseReasonTemplates, renderSentence } from "./sentences";

/**
 * Builds the line of one signal: its fields, and the sentence it says
 * (`buildSignalSay`).
 */
const buildSignalLine = (
  signal: ThreadSignal,
  reasonTemplates: string | null,
): EntitySignalLine => ({
  ...signal,
  say: buildSignalSay(signal, reasonTemplates),
});

/**
 * Builds the sentence a card says for one signal. The Inbox card's `reason`
 * and every line of a card's detail use this one function.
 *
 * The kind's own words come from `reasonTemplates`, the JSON copy of the
 * kind's `reasons` table that the entity stores, under the signal kind's word
 * (the part after `<plugin>/`, so `github/review-requested` looks up
 * `review-requested`). `{person}` is the signal's asker. The signal's title is
 * the fallback, with the `plain` tone, when:
 *
 * - the signal kind is a core kind, which has no plugin word;
 * - the entity stores no template under the word;
 * - the template needs a person and the signal has no asker, or it names
 *   anything else, which a signal cannot supply.
 *
 * Filling, cutting and falling back are done by `renderSentence`, as for the
 * words of a timeline.
 */
const buildSignalSay = (
  signal: Pick<ThreadSignal, "kind" | "title" | "asker">,
  reasonTemplates: string | null,
): EntityReason => {
  const slash = signal.kind.indexOf("/");
  const template =
    slash < 0 ? undefined : parseReasonTemplates(reasonTemplates)?.[signal.kind.slice(slash + 1)];
  return renderSentence(template, { person: signal.asker }, signal.title);
};

/**
 * Builds the two fields of an Inbox card that come from its signals: the
 * `signals` summary, and, when the card has a live signal, the `reason` that
 * replaces the observation's own: the sentence of its latest signal. A card
 * with no live signal gets no `reason` here, so it keeps the one its
 * observation gave. `openKinds` are the kinds of all the card's open signals,
 * snoozed ones included.
 */
export const buildCardSignalFields = (
  found: LiveThreadSignals | undefined,
  openKinds: ReadonlyArray<string>,
  reasonTemplates: string | null,
): Pick<InboxCard, "signals"> & { readonly reason?: EntityReason } => {
  if (found === undefined) return { signals: { openCount: 0, kinds: openKinds } };
  const latest = buildSignalLine(found.latest, reasonTemplates);
  return {
    signals: { latest, openCount: found.liveCount, kinds: openKinds },
    reason: latest.say,
  };
};

/** Builds the fields of an entity's detail that come from its signals. */
export const buildDetailSignalFields = (
  found: ThreadSignalLines,
  reasonTemplates: string | null,
): Pick<ExternalEntityDetail, "signals" | "openCount" | "signalCount"> => ({
  signals: found.signals.map((signal) => buildSignalLine(signal, reasonTemplates)),
  openCount: found.openCount,
  signalCount: found.signalCount,
});
