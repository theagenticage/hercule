/**
 * What the generic card draws for a card of the Inbox. The face is worked out
 * from the card alone and holds no branch on its kind: the kind table already
 * shaped the slots when the entity was observed, so a new plugin draws with no
 * code here.
 */
import type { EntityFact, EntityReason, EntityStatus, InboxCard } from "@hercule/contract";
import { readEntityPluginId, formatTargetDate } from "../desk/entity-words";

/** A fact in words. A client makes the plural of a count and the sign of a delta. */
export type CardFact =
  | {
      readonly form: "delta";
      readonly text: string;
      readonly added: string;
      readonly removed: string;
    }
  | { readonly form: "bars"; readonly text: string; readonly level: number }
  | { readonly form: "count" | "word" | "date" | "money"; readonly text: string };

/** What a card draws, slot by slot. A slot with nothing to say is absent. */
export interface CardFace {
  /** The plugin whose mark the card shows. */
  readonly pluginId: string;
  /** The word for one, such as "Pull request", for a screen reader. */
  readonly noun: string;
  /** Shape and word of the status. Absent when the kind has none, or when it is the usual state of a request. */
  readonly status?: EntityStatus;
  readonly title: string;
  /** Why the card is here, with the person as words. */
  readonly sentence?: Pick<EntityReason, "tone"> & { readonly text: string };
  /** `Tessa's` on a row of a colleague, `yours` on a request of yours. A row of yours says nothing. */
  readonly whose?: string;
  /** How the source names it, such as `#87`. A request shows it only in the open card. */
  readonly identifier: string;
  readonly facts: readonly CardFact[];
}

const describeFact = (fact: EntityFact): CardFact => {
  switch (fact.form) {
    case "delta":
      return {
        form: "delta",
        text: `+${String(fact.added)} -${String(fact.removed)}`,
        added: `+${String(fact.added)}`,
        removed: `-${String(fact.removed)}`,
      };
    case "count":
      return {
        form: "count",
        text: `${fact.value.toLocaleString("en-GB")} ${fact.unit}${fact.value === 1 ? "" : "s"}`,
      };
    case "date":
      return { form: "date", text: `Due ${formatTargetDate(fact.on)}` };
    case "bars":
      return { form: "bars", text: `${String(fact.level)} of 3`, level: fact.level };
    case "word":
    case "money":
      return { form: fact.form, text: fact.text };
  }
};

/**
 * Returns the sentence of a card. On a request, the usual reason (a plain
 * tone) needs only the person's name, because the column's title already says
 * what requests are. Anything with a tone, or with no person to name, keeps
 * its full sentence.
 */
const decideSentence = (card: InboxCard): CardFace["sentence"] => {
  const { reason } = card;
  if (reason === undefined) return undefined;
  if (card.card === "compact" && reason.tone === "plain" && card.person !== undefined) {
    return { text: card.person.name, tone: "plain" };
  }
  return { text: reason.say, tone: reason.tone };
};

const decideWhose = (card: InboxCard): string | undefined => {
  if (card.card === "compact") return card.yours ? "yours" : undefined;
  return card.person === undefined || card.yours ? undefined : `${card.person.name}'s`;
};

/** Returns what the generic card draws for `card`. */
export const decideCardFace = (card: InboxCard): CardFace => {
  const status =
    card.status !== undefined && (card.card === "rich" || card.status.norm !== true)
      ? card.status
      : undefined;
  const sentence = decideSentence(card);
  const whose = decideWhose(card);
  return {
    pluginId: readEntityPluginId(card.kind),
    noun: card.noun,
    ...(status === undefined ? {} : { status }),
    title: card.title,
    ...(sentence === undefined ? {} : { sentence }),
    ...(whose === undefined ? {} : { whose }),
    identifier: card.identifier,
    facts: card.facts.map(describeFact),
  };
};
