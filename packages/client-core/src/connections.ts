/**
 * Client-side rules about a Connection record that screens across the app
 * share: the sidebar, Settings, the first run and the thread composer.
 *
 * Keep this module small. The app's first screen imports it (the sidebar
 * reads `connectionNeedsAttention`), and the bundler loads a module the first
 * screen imports whole, minus only the exports nothing in the app uses. A
 * rule that only the Connections screens use belongs in
 * `connection-types.ts`, `connection-device-flow.ts` or
 * `connection-settings.ts`, which load with those screens.
 */
import { GITHUB_CONNECTION_TYPE, type Connection } from "@hercule/contract";

/**
 * Returns the GitHub connections: the accounts a repo can be cloned through.
 * Two screens offer them (the composer's add-repo form and Settings > Threads),
 * so the filter is written once here rather than in each screen.
 */
export const filterGitHubConnections = (
  connections: readonly Connection[],
): readonly Connection[] =>
  connections.filter((connection) => connection.type === GITHUB_CONNECTION_TYPE);

/**
 * Checks whether the Connection needs the user to act: its status is `error`
 * or `needs-reauth`. A `connected` or `disabled` Connection needs nothing.
 */
export function connectionNeedsAttention(connection: Pick<Connection, "status">): boolean {
  return connection.status === "error" || connection.status === "needs-reauth";
}

/**
 * Checks whether a screen shows the connection's account beside its name.
 * The account is shown only when it adds something the name does not:
 *
 * - A connection the user never named is named after its account, so the
 *   account would repeat the name.
 * - An account with no name, or a name of only spaces, has nothing to show.
 *   Such a connection is named after its type instead.
 */
export const showsAccountBesideLabel = (connection: Connection): boolean =>
  connection.displayName.trim() !== "" && connection.displayName !== connection.label;
