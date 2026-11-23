/**
 * The Replace dialog: moving a server added by URL onto the Connection of the
 * plugin that offers the same server. The app opens it from the switch of an
 * offer's row when a server added by URL sits on the offer's origin.
 */
import type { McpServer } from "@hercule/contract";
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

/** One server the Replace dialog lists to choose from. */
export interface ReplaceChoice {
  readonly serverId: string;
  readonly name: string;
  /** The address the server was added by. */
  readonly address: string;
}

/**
 * Something the Replace dialog tells the user besides its question.
 *
 * - `working`: the write, or a read of the list, runs. Nothing to do but wait.
 * - `unread`: the write is saved, or its reply was lost, and the list could
 *   not be read to show the result. `readAgainLabel` is set: the user reads it
 *   again, or closes.
 * - `refused`: nothing was replaced, with the reason. `winner` links to the
 *   server that holds the Connection, when there is one.
 * - `lost-choice`: the server the user chose is not a candidate any more.
 * - `empty`: no server is left to replace.
 */
export interface ReplaceNotice {
  readonly kind: "working" | "unread" | "refused" | "lost-choice" | "empty";
  readonly message: string;
  readonly winner: { readonly serverId: string; readonly label: string } | null;
  /** The label of the button that reads the list again, or `null` when there is none. */
  readonly readAgainLabel: string | null;
}

/** Everything the Replace dialog draws. An app draws it and decides nothing. */
export interface ReplaceDialogView {
  /** Such as "Replace the `docs` server you added?", or "Which server do you replace?" while none is chosen. */
  readonly title: string;
  /** The paragraph under the title, or `null` while no server is chosen. */
  readonly body: string | null;
  /** What stays, what changes and what goes, in that order. Empty while no server is chosen. */
  readonly lines: readonly ReplaceLine[];
  /** The servers to choose from, or `null` when the dialog asks about one server and lists none. */
  readonly choices: readonly ReplaceChoice[] | null;
  /** The id of the chosen server, or `null`. The dialog never chooses for the user among several. */
  readonly selectedId: string | null;
  /** True while the choice cannot change: from the confirmation until the attempt ends in a refusal. */
  readonly locked: boolean;
  readonly notice: ReplaceNotice | null;
  /** Whether Replace can be pressed now. */
  readonly canReplace: boolean;
  /** True once the confirmed server is on the Connection: the dialog closes. */
  readonly done: boolean;
}

/** How a Replace attempt stands, decided by the switches from the guard, the write and the list. */
export type ReplaceOutcome =
  /** Nothing was confirmed, or a write ended and was released. */
  | { readonly kind: "choosing" }
  | { readonly kind: "working"; readonly message: string }
  | { readonly kind: "unread"; readonly message: string }
  | { readonly kind: "replaced" }
  | {
      readonly kind: "refused";
      readonly message: string;
      readonly winnerServerId: string | null;
      /** True while the list could not be read again, so the user may read it again. */
      readonly unread: boolean;
    };

const READ_AGAIN_LABEL = "Read again";

/**
 * Returns the Replace dialog's title, paragraph and three lines for `server`,
 * the server added by URL, and the Connection of the plugin's server, whose
 * type is named `typeName` (such as "Sentry"). Returns `null` when `server`
 * was not added by URL, because only that server has anything to replace.
 */
const describeReplaceDialog = ({
  server,
  connectionLabel,
  typeName,
}: {
  readonly server: McpServer;
  readonly connectionLabel: string;
  readonly typeName: string;
}): { title: string; body: string; lines: readonly ReplaceLine[] } | null => {
  if (server.source.kind !== "url") return null;
  return {
    title: `Replace the ${server.name} server you added?`,
    body: `You added ${server.source.url} by hand, with a sign-in of its own. ${typeName} · ${connectionLabel} reaches the same server, and one address and account is one server.`,
    lines: [
      { label: "Stays", text: "the name and the projects that name it." },
      { label: "Changes", text: "it acts through the Connection." },
      { label: "Goes", text: "the sign-in made by hand." },
    ],
  };
};

/**
 * Builds what the Replace dialog draws.
 *
 * - `live` are the servers that qualify now, `servers` all servers the cache
 *   holds (to name a winner).
 * - `pickedId` is the user's pick. It is the selection only while that server
 *   is still in `live`; a pick that left is never replaced by another server.
 *   Once `confirmed`, the confirmed server and the servers shown at the
 *   confirmation stay, whatever the list does, until the attempt ends in a
 *   refusal.
 * - `occupied` tells that the Connection has a server already, so Replace is
 *   off. `offerBlocked` tells that a write of the offer runs, and
 *   `isServerBlocked` that a write of one candidate does.
 *
 * The notice follows the outcome first. Only while nothing was confirmed does
 * it say that a chosen server left or that no server is left.
 */
export const buildReplaceDialogView = ({
  connectionLabel,
  typeName,
  servers,
  live,
  pickedId,
  confirmed,
  outcome,
  occupied,
  offerBlocked,
  isServerBlocked,
}: {
  readonly connectionLabel: string;
  readonly typeName: string;
  readonly servers: readonly McpServer[];
  readonly live: readonly McpServer[];
  readonly pickedId: string | null;
  readonly confirmed: { readonly serverId: string; readonly shown: readonly McpServer[] } | null;
  readonly outcome: ReplaceOutcome;
  readonly occupied: boolean;
  readonly offerBlocked: boolean;
  readonly isServerBlocked: (serverId: string) => boolean;
}): ReplaceDialogView => {
  const locked = confirmed !== null && (offerBlocked || outcome.kind === "replaced");
  const listed = locked ? confirmed.shown : live;
  const selectedId = locked
    ? confirmed.serverId
    : pickedId !== null && live.some((server) => server.id === pickedId)
      ? pickedId
      : null;
  const pickLeft = !locked && pickedId !== null && selectedId === null;
  const selected = listed.find((server) => server.id === selectedId) ?? null;
  const words =
    selected === null
      ? null
      : describeReplaceDialog({ server: selected, connectionLabel, typeName });
  const showList = listed.length > 1 || (pickLeft && listed.length > 0);

  let notice: ReplaceNotice | null = null;
  const buildNotice = (
    kind: ReplaceNotice["kind"],
    message: string,
    options: { winnerServerId?: string | null; readAgain?: boolean } = {},
  ): ReplaceNotice => {
    const winnerId = options.winnerServerId ?? null;
    const winnerName = servers.find((server) => server.id === winnerId)?.name;
    return {
      kind,
      message,
      winner:
        winnerId === null
          ? null
          : {
              serverId: winnerId,
              label: winnerName === undefined ? "Open server" : `Open ${winnerName}`,
            },
      readAgainLabel: options.readAgain === true ? READ_AGAIN_LABEL : null,
    };
  };
  if (outcome.kind === "working") {
    notice = buildNotice("working", outcome.message);
  } else if (outcome.kind === "unread") {
    notice = buildNotice("unread", outcome.message, { readAgain: true });
  } else if (outcome.kind === "refused") {
    notice = buildNotice("refused", outcome.message, {
      winnerServerId: outcome.winnerServerId,
      readAgain: outcome.unread,
    });
  } else if (!locked && listed.length === 0) {
    notice = buildNotice(
      "empty",
      pickLeft
        ? "The server you chose is gone, or is not added by URL on this address any more. Nothing was replaced."
        : "No server added by URL sits on this address any more.",
    );
  } else if (pickLeft) {
    notice = buildNotice(
      "lost-choice",
      "The server you chose is gone, or is not added by URL on this address any more. Nothing was replaced. Choose again.",
    );
  }

  return {
    title: words?.title ?? "Which server do you replace?",
    body: words?.body ?? null,
    lines: words?.lines ?? [],
    choices: showList
      ? listed.map((server) => ({
          serverId: server.id,
          name: server.name,
          address: server.source.kind === "url" ? server.source.url : "",
        }))
      : null,
    selectedId,
    locked,
    notice,
    canReplace:
      !locked && !offerBlocked && !occupied && selectedId !== null && !isServerBlocked(selectedId),
    done: outcome.kind === "replaced",
  };
};
