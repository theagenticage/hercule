/**
 * What the composer shows of a Thread's MCP Servers: the submenu under the
 * `+` button and the picker that opens from it (spec 17, the composer's `+`
 * menu). The Thread's list is `mcpServerIds`: the draft's own list, or the
 * ids of `Session.mcpServers`.
 *
 * A menu holds two things between renders, both small: the order of the names
 * (`orderMenuNames`, taken when the menu opens, so no row jumps while the
 * user uses it) and the account each name last showed. Everything else is
 * read again from the current records, so a server deleted or switched off
 * meanwhile never leaves a stale row.
 */
import { groupServersByName, type ServerNameGroup } from "./named-lists";
import { MCP_SERVER_STATUS_FACTS } from "./status";
import { describeSignInAction, type McpServerView, type SignInAction } from "./views";

/** How many server names a menu or a picker lists before it moves the rest behind a link or a filter. */
const NAME_LIMIT = 8;

/**
 * The account each name last showed, as a server id by name. It keeps a row
 * on the account the user chose while the name is switched off, so switching
 * it back on picks that account again.
 */
export type RememberedAccounts = Readonly<Record<string, string>>;

/**
 * Returns the server names in the order a menu opens with: the names of the
 * Thread's own servers, then the names of servers that are switched on in
 * Settings. A name that only switched-off servers have is left out, unless the
 * Thread has one of them. Each name appears once; within each group the order
 * is the order of `views`.
 *
 * The caller keeps the result for as long as the menu stays open.
 */
export const orderMenuNames = (
  views: readonly McpServerView[],
  mcpServerIds: readonly string[],
): string[] => {
  const own = views.filter((view) => mcpServerIds.includes(view.server.id));
  const switchedOn = views.filter((view) => view.server.enabled);
  return [...new Set([...own, ...switchedOn].map((view) => view.server.name))];
};

/** Returns the account `group` shows: the Thread's own, else the remembered one, else the first. */
const decideShownAccount = (
  group: ServerNameGroup,
  mcpServerIds: readonly string[],
  remembered: RememberedAccounts,
): McpServerView =>
  group.views.find((view) => mcpServerIds.includes(view.server.id)) ??
  group.views.find((view) => view.server.id === remembered[group.name]) ??
  group.views[0]!;

/** One server name in the submenu. */
export interface ServerMenuRow {
  readonly name: string;
  /** The servers of this name the submenu offers, one for each account. More than one gives the row a choice of account. */
  readonly accounts: readonly McpServerView[];
  /** The account the row stands for: the Thread's own, else the remembered one, else the first. */
  readonly shown: McpServerView;
  /** Whether the Thread has the server of this name. */
  readonly on: boolean;
  /** What a server that needs sign-in says beside its name, or `null` for any other server. */
  readonly note: "on, joins once you sign in" | "needs sign-in" | null;
  /** The button that fixes `note` (`describeSignInAction`), or `null` when there is no note. */
  readonly signIn: SignInAction | null;
}

/** The submenu under the `+` button. */
export interface ThreadServerMenu {
  readonly rows: readonly ServerMenuRow[];
  /** How many server names the rows leave out, those that only switched-off servers have included. They are in the picker. */
  readonly moreCount: number;
}

/**
 * Returns the submenu for a Thread whose list is `mcpServerIds`.
 *
 * - A server switched off in Settings is offered only when the Thread has it.
 * - The rows are the names of `order` that still have a server, in that
 *   order, then the names the Thread owns now that `order` lacks (a server
 *   added in the picker while the menu is open), appended.
 * - There are at most `max(8, the number of names the Thread owns now)` rows.
 *   The Thread's own names are never cut, so the other names give way: a
 *   Thread that owns one server never gets nine rows.
 * - A server that needs sign-in stays on, and its row says so.
 */
export const buildThreadServerMenu = ({
  views,
  mcpServerIds,
  order,
  rememberedAccounts,
}: {
  readonly views: readonly McpServerView[];
  readonly mcpServerIds: readonly string[];
  readonly order: readonly string[];
  readonly rememberedAccounts: RememberedAccounts;
}): ThreadServerMenu => {
  const groups = groupServersByName(views);
  const ownNames = new Set(
    views.filter((view) => mcpServerIds.includes(view.server.id)).map((view) => view.server.name),
  );
  const limit = Math.max(NAME_LIMIT, ownNames.size);
  const offerAccounts = (name: string): ServerNameGroup[] => {
    const accounts = (groups.find((group) => group.name === name)?.views ?? []).filter(
      (view) => view.server.enabled || mcpServerIds.includes(view.server.id),
    );
    return accounts.length === 0 ? [] : [{ name, views: accounts }];
  };
  const offered = [
    ...order.flatMap(offerAccounts),
    ...groups
      .filter((group) => ownNames.has(group.name) && !order.includes(group.name))
      .flatMap((group) => offerAccounts(group.name)),
  ];
  // The other names fill what the own names leave of the limit.
  const keptOthers = new Set(
    offered
      .filter((group) => !ownNames.has(group.name))
      .slice(0, limit - ownNames.size)
      .map((group) => group.name),
  );
  const rows = offered
    .filter((group) => ownNames.has(group.name) || keptOthers.has(group.name))
    .map((group): ServerMenuRow => {
      const shown = decideShownAccount(group, mcpServerIds, rememberedAccounts);
      const on = mcpServerIds.includes(shown.server.id);
      const note = !MCP_SERVER_STATUS_FACTS[shown.displayStatus].needsSignIn
        ? null
        : on
          ? "on, joins once you sign in"
          : "needs sign-in";
      return {
        name: group.name,
        accounts: group.views,
        shown,
        on,
        note,
        signIn: note === null ? null : describeSignInAction(shown),
      };
    });
  return { rows, moreCount: groups.length - rows.length };
};

/** One server name in the picker. */
export interface ServerPickerRow {
  readonly name: string;
  /** Every server of this name, switched off ones too, one for each account. */
  readonly accounts: readonly McpServerView[];
  /** The account the row stands for: the chosen one, else the remembered one, else the first. */
  readonly shown: McpServerView;
  readonly chosen: boolean;
  /**
   * What the shown account is reached with, such as "Sentry Connection",
   * "Sentry Connection · 2 accounts" or, for a server added by URL, its whole
   * address, "https://mcp.example.com/mcp".
   */
  readonly secondLine: string;
  /** The status word of the shown account when it needs sign-in, is unreachable, in error or off. `null` otherwise. */
  readonly statusWord: string | null;
}

/** The picker: one dialog for the list of any Thread, and for the default list. */
export interface ServerPicker {
  /** The rows the filter keeps. */
  readonly rows: readonly ServerPickerRow[];
  /** How many names the list holds, whatever the filter hides. */
  readonly chosenCount: number;
  /** Whether the dialog draws a filter field: there are more than eight names. */
  readonly showsFilter: boolean;
}

/**
 * Returns the picker for the list `mcpServerIds`. Every server is offered,
 * those switched off in Settings too. The rows follow `order` (see
 * `orderMenuNames`); a name it does not hold comes after, in the order of
 * `views`.
 *
 * `filter` keeps the names whose name or whose account contains it, whatever
 * its case. A blank filter keeps every row.
 */
export const buildServerPicker = ({
  views,
  mcpServerIds,
  order,
  rememberedAccounts,
  filter,
}: {
  readonly views: readonly McpServerView[];
  readonly mcpServerIds: readonly string[];
  readonly order: readonly string[];
  readonly rememberedAccounts: RememberedAccounts;
  readonly filter: string;
}): ServerPicker => {
  const groups = groupServersByName(views);
  const ordered = [
    ...order.flatMap((name) => groups.filter((group) => group.name === name)),
    ...groups.filter((group) => !order.includes(group.name)),
  ];
  const rows = ordered.map((group): ServerPickerRow => {
    const shown = decideShownAccount(group, mcpServerIds, rememberedAccounts);
    const accountCount = group.views.length;
    // A server added by URL is named by its whole address, a Connection's server by its type.
    const source =
      shown.server.source.kind === "url" ? shown.server.source.url : `${shown.typeName} Connection`;
    return {
      name: group.name,
      accounts: group.views,
      shown,
      chosen: group.views.some((view) => mcpServerIds.includes(view.server.id)),
      secondLine: accountCount > 1 ? `${source} · ${String(accountCount)} accounts` : source,
      statusWord: MCP_SERVER_STATUS_FACTS[shown.displayStatus].showsWordInPicker
        ? shown.statusWord
        : null,
    };
  });
  const needle = filter.trim().toLowerCase();
  return {
    rows:
      needle === ""
        ? rows
        : rows.filter(
            (row) =>
              row.name.toLowerCase().includes(needle) ||
              row.accounts.some((view) => (view.account ?? "").toLowerCase().includes(needle)),
          ),
    chosenCount: rows.filter((row) => row.chosen).length,
    showsFilter: rows.length > NAME_LIMIT,
  };
};
