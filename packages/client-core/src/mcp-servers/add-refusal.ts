/**
 * What the Add by URL form says and offers when `mcpServer.create` refuses an
 * address as a duplicate. One projection serves both refusals, from the
 * plugins and Connections as they are now, so the button leads somewhere the
 * user can act.
 */
import type { Connection, PluginDetail } from "@hercule/contract";
import { listConnectionTypes } from "../connection-types";
import { parsePluginId } from "../plugin-id";
import { readMcpServerOffers } from "./offers";
import type { TextPart } from "./project-boxes";

const text = (value: string): TextPart => ({ text: value, code: false });

/** The server an `mcp-server-exists` refusal points at, as far as it could be read. */
export type ExistingServer =
  /** The record is being read. */
  | { readonly kind: "reading" }
  | { readonly kind: "found"; readonly name: string }
  /** The record does not exist any more. */
  | { readonly kind: "gone" }
  /** The record could not be read. */
  | { readonly kind: "unknown" };

/** The button of a refusal, and where it leads. */
export type RefusalAction =
  /** The page of a server. */
  | { readonly kind: "open-server"; readonly mcpServerId: string; readonly label: string }
  /** The row of the offer of `contributionId` on the Connection `connectionId`, in the list "From your Connections". */
  | {
      readonly kind: "open-offer-row";
      readonly contributionId: string;
      readonly connectionId: string;
      readonly label: string;
    }
  /** Settings > Connections. */
  | { readonly kind: "open-connections"; readonly label: "Open Connections" }
  /** Settings > Plugins. */
  | { readonly kind: "open-plugins"; readonly label: "Open Plugins" };

/** A refusal as the form draws it: the sentence, and its button when there is somewhere to go. */
export interface RefusalDescription {
  readonly sentence: readonly TextPart[];
  readonly action: RefusalAction | null;
}

/**
 * Describes the refusal that the address is added already. `mcpServerId` is
 * the server that holds it and `existing` says what is known of that record.
 *
 * - found: "You added this server before, as `<name>`. One address is one
 *   server." with "Open `<name>`".
 * - being read, or not readable: the same sentence without the name, with
 *   "Open server".
 * - gone: it says so and has no button, because the next "Check server" adds
 *   the address again.
 */
export const describeExistsRefusal = (
  mcpServerId: string,
  existing: ExistingServer,
): RefusalDescription => {
  switch (existing.kind) {
    case "found":
      return {
        sentence: [
          text("You added this server before, as "),
          { text: existing.name, code: true },
          text(". One address is one server."),
        ],
        action: { kind: "open-server", mcpServerId, label: `Open ${existing.name}` },
      };
    case "gone":
      return {
        sentence: [
          text(
            "You added this server before, but it was removed since. Check the server again to add it.",
          ),
        ],
        action: null,
      };
    case "reading":
    case "unknown":
      return {
        sentence: [text("You added this server before. One address is one server.")],
        action: { kind: "open-server", mcpServerId, label: "Open server" },
      };
  }
};

/** What the controller said when it refused an address on a plugin's origin. */
export interface PluginOriginRefusal {
  readonly contributionId: string;
  /** One of the user's Connections the server can be reached with, or `null` when there is none. */
  readonly connectionId: string | null;
}

/**
 * Describes the refusal that a plugin offers this server, and chooses where
 * its button leads from the plugin and the Connections as they are now, not
 * as the controller saw them:
 *
 * - the plugin is switched off, or switched on and did not start: Settings >
 *   Plugins;
 * - it runs and the user has no Connection of its type: Settings > Connections,
 *   "Connect first";
 * - it runs and the Connection, the one the controller named or else a
 *   connected one of that type, is connected: the exact row of that offer on
 *   that Connection;
 * - it runs and every Connection of the type needs attention: Settings >
 *   Connections, to fix it first.
 *
 * `pluginsSettings` says whether the app has Settings > Plugins. An app that
 * has none (the desktop app) says where to act in words and gives no button:
 * the plugin is switched on in the web app's Settings > Plugins.
 *
 * `message` is the controller's own sentence. It is the text, without a
 * button, when `plugins` or `connections` is `undefined` (not read yet) and
 * when the plugin or its offer is not in `plugins` any more, because then no
 * row exists to lead to.
 */
export const describePluginOriginRefusal = ({
  refusal,
  message,
  plugins,
  connections,
  pluginsSettings = "here",
}: {
  readonly refusal: PluginOriginRefusal;
  readonly message: string;
  readonly plugins: readonly PluginDetail[] | undefined;
  readonly connections: readonly Connection[] | undefined;
  /** `here`: the app opens Settings > Plugins. `web-app`: only the web app has that page. */
  readonly pluginsSettings?: "here" | "web-app";
}): RefusalDescription => {
  const fallback: RefusalDescription = { sentence: [text(message)], action: null };
  if (plugins === undefined || connections === undefined) return fallback;
  const pluginId = parsePluginId(refusal.contributionId);
  const plugin = plugins.find((each) => each.id === pluginId);
  const offer = readMcpServerOffers(plugins).find(
    (each) => each.contributionId === refusal.contributionId,
  );
  if (plugin === undefined || offer === undefined) return fallback;

  const typeName =
    listConnectionTypes(plugins).find((type) => type.type === offer.connectionType)?.displayName ??
    plugin.displayName;
  const offers = `The ${plugin.displayName} plugin already offers this server. It is reached with a ${typeName} Connection, with no second sign-in, so it is not added by hand.`;

  const pluginsPage =
    pluginsSettings === "here" ? "Settings > Plugins" : "Settings > Plugins in the web app";
  const pluginsAction: RefusalAction | null =
    pluginsSettings === "here" ? { kind: "open-plugins", label: "Open Plugins" } : null;
  if (!plugin.enabled) {
    return {
      sentence: [
        text(`${offers} Switch the ${plugin.displayName} plugin on in ${pluginsPage} to use it.`),
      ],
      action: pluginsAction,
    };
  }
  if (plugin.status._tag !== "active") {
    return {
      sentence: [
        text(
          `${offers} The ${plugin.displayName} plugin is switched on but did not start. See ${pluginsPage}.`,
        ),
      ],
      action: pluginsAction,
    };
  }

  const ofType = connections.filter((each) => each.type === offer.connectionType);
  if (ofType.length === 0) {
    return {
      sentence: [
        text(
          `${offers} Connect ${plugin.displayName} first in Settings > Connections, then switch its server on.`,
        ),
      ],
      action: { kind: "open-connections", label: "Open Connections" },
    };
  }
  // The Connection the controller named stays the one pointed at while it still works.
  const named = ofType.find((each) => each.id === refusal.connectionId);
  const usable =
    named?.status === "connected" ? named : ofType.find((each) => each.status === "connected");
  if (usable === undefined) {
    const label = (named ?? ofType[0]!).label;
    return {
      sentence: [
        text(
          `${offers} The ${typeName} Connection ${label} needs attention first. Fix it in Settings > Connections, then switch its server on.`,
        ),
      ],
      action: { kind: "open-connections", label: "Open Connections" },
    };
  }
  return {
    sentence: [text(offers)],
    action: {
      kind: "open-offer-row",
      contributionId: offer.contributionId,
      connectionId: usable.id,
      label: `Show ${typeName} · ${usable.label}`,
    },
  };
};
