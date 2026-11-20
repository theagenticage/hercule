/**
 * PROTOTYPE, throwaway. The picker of MCP servers: one dialog for every list
 * of servers there is. A project's list, the list of a thread with no
 * project, and one thread's own list all open it.
 *
 * It is built for many servers: a filter, a list that scrolls, and one row
 * per server name. Two servers that share a name, such as a work and a hobby
 * Sentry, are one row with a choice of account, so a list can never hold
 * both.
 */
import { useRef, useState, type JSX } from "react";
import { CheckIcon } from "../../icons/check";
import { GlassDialog } from "../../screens/glass-dialog";
import { isFailing, ServerMark, ServerName, StatusText } from "./parts";
import {
  describeAddress,
  findServerConnection,
  pickNamedServer,
  type Server,
  type World,
} from "./world";

/** The list a picker edits. */
export interface PickerTarget {
  /** The dialog's title, such as "MCP servers of webshop". */
  readonly title: string;
  readonly ids: readonly string[];
  readonly onChange: (ids: readonly string[]) => void;
  /** One line at the dialog's foot: when the change takes effect. */
  readonly foot: string;
  /** The list this one started from, when it can go back to it, such as the project's list for a thread. */
  readonly reset?: { readonly label: string; readonly ids: readonly string[] } | undefined;
}

/** Returns the word that tells two servers of one name apart: the Connection's label, or the address. */
export const describeAccount = (w: World, server: Server): string =>
  findServerConnection(w, server)?.label ?? describeAddress(server);

/**
 * Draws the choice between the servers that share one name, each as its
 * account. `chosenId` is the server the choice shows. The choice cannot be
 * changed while `disabled`, which is while its name is off the list: it then
 * only shows the account the name would come on with.
 */
export function AccountChoice({
  w,
  servers,
  chosenId,
  disabled,
  onChoose,
}: {
  readonly w: World;
  readonly servers: readonly Server[];
  readonly chosenId: string;
  readonly disabled: boolean;
  readonly onChoose: (serverId: string) => void;
}): JSX.Element {
  return (
    <span className="field field--select pm-grid-pick">
      <select
        aria-label={`Account of ${servers[0]!.name}`}
        value={chosenId}
        disabled={disabled}
        onChange={(event) => {
          onChoose(event.target.value);
        }}
      >
        {servers.map((server) => (
          <option key={server.id} value={server.id}>
            {describeAccount(w, server)}
          </option>
        ))}
      </select>
    </span>
  );
}

const sameIds = (one: readonly string[], other: readonly string[]): boolean =>
  one.length === other.length && one.every((id) => other.includes(id));

export function ServerPickerDialog({
  w,
  target,
  onClose,
}: {
  readonly w: World;
  readonly target: PickerTarget;
  readonly onClose: () => void;
}): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [filter, setFilter] = useState("");
  // The names in the order the dialog opened with, the ones on the list first, so a row never jumps while it is used.
  const [names] = useState(() => {
    const all = [...new Set(w.servers.map((server) => server.name))];
    const isOn = (name: string): boolean =>
      w.servers.some((server) => server.name === name && target.ids.includes(server.id));
    return [...all.filter(isOn), ...all.filter((name) => !isOn(name))];
  });
  // The account each name's choice last showed, which it keeps showing while the name is off the list.
  const [shownAccounts, setShownAccounts] = useState<Readonly<Record<string, string>>>({});

  const needle = filter.trim().toLowerCase();
  const shown = names.filter((name) => {
    if (needle === "") return true;
    return w.servers
      .filter((server) => server.name === name)
      .some((server) =>
        `${server.name} ${describeAccount(w, server)} ${describeAddress(server)}`
          .toLowerCase()
          .includes(needle),
      );
  });
  const onCount = names.filter((name) =>
    w.servers.some((server) => server.name === name && target.ids.includes(server.id)),
  ).length;

  return (
    <GlassDialog
      dialogRef={dialogRef}
      className="skill-import pm-picker"
      label={target.title}
      onClose={onClose}
    >
      <div className="pop-h">
        <b>{target.title}</b>
        <span>{onCount} chosen</span>
      </div>
      {names.length > 8 && (
        <div className="pop-sec pm-picker-filter">
          <input
            className="field menu-filter"
            placeholder="Filter servers"
            aria-label="Filter servers"
            autoFocus
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
            }}
          />
        </div>
      )}
      <div className="pop-sec skill-import-list">
        {shown.map((name) => {
          const servers = w.servers.filter((server) => server.name === name);
          const picked = servers.find((server) => target.ids.includes(server.id));
          const offered =
            picked ?? servers.find((server) => server.id === shownAccounts[name]) ?? servers[0]!;
          const connection = findServerConnection(w, offered);
          return (
            <label key={name} className="pm-pick-row">
              <span className="choice-box">
                <input
                  type="checkbox"
                  checked={picked !== undefined}
                  onChange={(event) => {
                    setShownAccounts({ ...shownAccounts, [name]: offered.id });
                    target.onChange(
                      pickNamedServer(
                        w,
                        target.ids,
                        name,
                        event.target.checked ? offered.id : null,
                      ),
                    );
                  }}
                />
                <CheckIcon size={11} />
              </span>
              <span className="pm-pick-mark">
                <ServerMark server={offered} size={15} />
              </span>
              <span className="skill-import-name">
                {/* A row with a choice of account shows the name alone: the choice beside it names the account. */}
                <ServerName
                  name={name}
                  account={servers.length > 1 ? undefined : connection?.label}
                />
                <small>
                  {connection === undefined
                    ? describeAddress(offered)
                    : servers.length > 1
                      ? `${connection.typeName} Connection, ${String(servers.length)} accounts`
                      : `${connection.typeName} Connection`}
                </small>
              </span>
              {(isFailing(offered.status) || offered.status === "disabled") && (
                <StatusText server={offered} />
              )}
              {servers.length > 1 && (
                <span className="pm-pick-account">
                  account
                  <AccountChoice
                    w={w}
                    servers={servers}
                    chosenId={offered.id}
                    disabled={picked === undefined}
                    onChoose={(serverId) => {
                      setShownAccounts({ ...shownAccounts, [name]: serverId });
                      target.onChange(pickNamedServer(w, target.ids, name, serverId));
                    }}
                  />
                </span>
              )}
            </label>
          );
        })}
        {shown.length === 0 && <p className="menu-note">No server matches "{filter}".</p>}
      </div>
      <div className="skill-import-foot">
        <span className="time pm-picker-foot">{target.foot}</span>
        {target.reset !== undefined && !sameIds(target.reset.ids, target.ids) && (
          <button
            type="button"
            className="btn btn--quiet"
            onClick={() => {
              target.onChange(target.reset!.ids);
            }}
          >
            {target.reset.label}
          </button>
        )}
        <button
          type="button"
          className="btn btn--accent"
          onClick={() => dialogRef.current?.close()}
        >
          Done
        </button>
      </div>
    </GlassDialog>
  );
}
