/**
 * The Replace dialog: moving a server added by URL onto the Connection of the
 * plugin that offers the same server. The app opens it from the switch of an
 * offer's row when a server added by URL sits on the offer's origin.
 */
import type { Connection, McpServer } from "@hercule/contract";
import type { McpListEditState } from "./edit-guard";
import type { McpServerOffer } from "./offers";

/**
 * Returns the servers added by URL whose address is on the offer's origin
 * (scheme, host and port), in the order of `servers`. Replace is offered for
 * these. Returns none when the offer's origin is not an address.
 *
 * The comparison is the URL standard's origin of both, so the case of the
 * host and a default port do not matter. It is a check for the screen: the
 * controller does not refuse creating a plugin's server while a server added
 * by URL sits on its origin, so the app asks before it writes.
 */
export const findReplaceCandidates = (
  offer: Pick<McpServerOffer, "origin">,
  servers: readonly McpServer[],
): McpServer[] => {
  if (!URL.canParse(offer.origin)) return [];
  const { origin } = new URL(offer.origin);
  return servers.filter(
    ({ source }) =>
      source.kind === "url" && URL.canParse(source.url) && new URL(source.url).origin === origin,
  );
};

/** One line of the Replace dialog: a bold label, then the text. */
export interface ReplaceLine {
  /** `Stays`, `Changes` or `Goes`. */
  readonly label: string;
  /** A full sentence, such as "the name and the projects that name it." */
  readonly text: string;
}

/** What the Replace dialog says. */
export interface ReplaceDialog {
  /** Such as "Replace the `docs` server you added?". */
  readonly title: string;
  /** The paragraph under the title. */
  readonly body: string;
  /** What stays, what changes and what goes, in that order. */
  readonly lines: readonly ReplaceLine[];
}

/**
 * Returns the words of the Replace dialog for `server`, the server added by
 * URL, and the Connection of the plugin's server, whose type is named
 * `typeName` (such as "Sentry"). Returns `null` when `server` was not added
 * by URL, because only that server has anything to replace.
 */
export const describeReplaceDialog = ({
  server,
  connection,
  typeName,
}: {
  readonly server: McpServer;
  readonly connection: Pick<Connection, "label">;
  readonly typeName: string;
}): ReplaceDialog | null => {
  if (server.source.kind !== "url") return null;
  return {
    title: `Replace the ${server.name} server you added?`,
    body: `You added ${server.source.url} by hand, with a sign-in of its own. ${typeName} · ${connection.label} reaches the same server, and one address and account is one server.`,
    lines: [
      { label: "Stays", text: "the name and the projects that name it." },
      { label: "Changes", text: "it acts through the Connection." },
      { label: "Goes", text: "the sign-in made by hand." },
    ],
  };
};

/**
 * Returns the title of the Replace dialog: the dialog's own (see
 * `describeReplaceDialog`) once a server is chosen, else the question that asks
 * which one.
 */
export const describeReplaceTitle = (dialog: ReplaceDialog | null): string =>
  dialog?.title ?? "Which server do you replace?";

/** What the Replace dialog does with the server the user chose, once the list changed under it. */
export type ReplaceChoice =
  /** The chosen server is still a candidate: confirming writes to it. */
  | { readonly kind: "chosen"; readonly server: McpServer }
  /**
   * It is not any more (deleted, or moved onto a Connection meanwhile).
   * `candidates` are the servers that are now, possibly none. Using one of
   * them needs the user's new confirmation: the dialog never switches the
   * choice by itself.
   */
  | { readonly kind: "changed"; readonly candidates: readonly McpServer[] };

/**
 * Decides whether the server the user chose, `chosenServerId`, can still be
 * replaced, from the servers the cache holds now. The dialog calls it with
 * every render, so a push that deleted or moved the server shows at once.
 */
export const decideReplaceChoice = ({
  offer,
  servers,
  chosenServerId,
}: {
  readonly offer: Pick<McpServerOffer, "origin">;
  readonly servers: readonly McpServer[];
  readonly chosenServerId: string;
}): ReplaceChoice => {
  const candidates = findReplaceCandidates(offer, servers);
  const server = candidates.find((candidate) => candidate.id === chosenServerId);
  return server === undefined ? { kind: "changed", candidates } : { kind: "chosen", server };
};

/** What the Replace dialog shows of a write the controller refused, or that could not start. */
export interface ReplaceRefusal {
  /** The reason, starting with "Nothing was replaced." */
  readonly message: string;
  /** The server that won, when the refusal names one: the dialog links to its page. `null` otherwise. */
  readonly winnerServerId: string | null;
}

/**
 * Returns what the Replace dialog shows of the offer's target state (the
 * switch's `readState` of the plugin target), or `null` while there is no
 * refusal.
 */
export const describeReplaceRefusal = (state: McpListEditState): ReplaceRefusal | null =>
  state.refusal?.kind === "refused"
    ? { message: state.refusal.message, winnerServerId: state.refusal.existingServerId ?? null }
    : null;
