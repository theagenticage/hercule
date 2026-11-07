/**
 * The two quiet lines the Inbox says about itself when something may be off:
 * the page shows fewer cards than exist, or a source cannot be read.
 */
import type { Connection, Inbox, PluginDetail } from "@hercule/contract";
import { MAX_INBOX_CARDS } from "@hercule/contract";
import { namePlugin } from "../intake";
import { parsePluginId } from "../plugin-id";

/**
 * Returns the line that says the Inbox holds more cards than the page shows,
 * or `undefined` when it shows them all. Dismissing or taking on cards lets
 * the rest in, so the line says so.
 */
export const describeTruncatedInbox = (inbox: Inbox): string | undefined =>
  inbox.truncated
    ? `The Inbox shows the first ${MAX_INBOX_CARDS.toLocaleString("en")} cards, and more exist. Dismiss or take on some to bring the rest in.`
    : undefined;

const joinNames = (names: readonly string[]): string =>
  names.length <= 2
    ? names.join(" and ")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;

/**
 * Returns the one line that names a source the Inbox cannot read now and says
 * what that means for its cards, or `undefined` when every source answers.
 *
 * Only Connections of a plugin that declares kinds of cards count. A Connection
 * the user disabled is their own choice and says nothing. In order:
 *
 * - a Connection that needs signing in again, or has failed, names its plugin
 *   and says its cards may be out of date;
 * - failing that, the warning of a Connection of such a plugin, as the
 *   Connection holds it. The warning is the server's sentence, so the client
 *   does not read it: it says it as it is.
 */
export const describeFailingSources = (
  connections: readonly Connection[],
  plugins: readonly PluginDetail[],
): string | undefined => {
  const sourcePluginIds = new Set(
    plugins.filter((plugin) => plugin.entityKinds.length > 0).map((plugin) => plugin.id),
  );
  const ofSources = connections.filter((connection) => {
    const pluginId = parsePluginId(connection.type);
    return pluginId !== null && sourcePluginIds.has(pluginId);
  });
  const failing = ofSources.filter(
    (connection) => connection.status === "needs-reauth" || connection.status === "error",
  );
  if (failing.length > 0) {
    const names = [
      ...new Set(
        failing.map((connection) => namePlugin(parsePluginId(connection.type) ?? "", plugins)),
      ),
    ];
    const [only] = failing;
    if (names.length === 1 && only !== undefined) {
      return `${names[0] ?? ""} ${only.status === "needs-reauth" ? "needs you to sign in again" : "stopped answering"}. Its cards may be out of date.`;
    }
    return `${joinNames(names)} are not answering. Their cards may be out of date.`;
  }
  return ofSources.find(
    (connection) =>
      connection.status !== "disabled" && connection.warning !== undefined && connection.warning !== "",
  )?.warning;
};
