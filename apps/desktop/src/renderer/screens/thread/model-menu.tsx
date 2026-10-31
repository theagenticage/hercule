import { useState, type JSX } from "react";
import {
  buildModelMenu,
  describeModelRow,
  findProviderPluginId,
  type ModelMenuRow,
  type PluginIdentity,
  type RecentModel,
  type SignInTarget,
  type ThreadCatalogs,
  type ThreadChoice,
  type ThreadConfig,
  type ThreadKind,
} from "@hercule/client-core";
import { ProviderMark } from "../settings/providers/provider-mark";
import { MenuLine } from "./menu-line";

/** The size of the Provider's mark beside a lane's name and a Recent row. */
const MARK_SIZE = 12;

/**
 * Renders the content of a thread's model menu, as `buildModelMenu` builds
 * it from the user's Model Profile:
 *
 * - a filter, when the profile holds more than eight entries;
 * - on a Draft Thread: Recent, the entries picked most recently, then one lane
 *   per Provider Account with its entries in the profile's order. A lane
 *   whose models are still being read shows a note in place of rows;
 * - on a thread that has started: one flat list of the models it can switch
 *   to, and a note that other models start a new thread.
 *
 * An entry that cannot run now is dimmed with its reason at the right, never
 * hidden. When signing in would fix it and `onSignIn` is given, the row also
 * has a Sign in link.
 *
 * `readRecent` returns the Recent list as the app stores it, and `config` is
 * what the thread runs with, picks included, so the check marks the entry the
 * next message will use. `runnerId` is the machine a Draft Thread is bound to,
 * or `null` while any machine will do (see `ModelMenuView`). `plugins` give
 * the Providers their marks. `onChoose` receives the one choice a row makes.
 *
 * The filter's text starts afresh each time the menu opens. The Recent list is
 * read once, when the menu opens: it changes only when a message is sent.
 */
export function ModelMenu({
  catalogs,
  plugins,
  config,
  kind,
  runnerId,
  readRecent,
  onChoose,
  onSignIn,
}: {
  readonly catalogs: ThreadCatalogs;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly config: ThreadConfig;
  readonly kind: ThreadKind;
  readonly runnerId: string | null;
  readonly readRecent: () => readonly RecentModel[];
  readonly onChoose: (choice: ThreadChoice) => void;
  readonly onSignIn?: ((target: SignInTarget) => void) | undefined;
}): JSX.Element {
  const [filter, setFilter] = useState("");
  const [recent] = useState(readRecent);
  const menu = buildModelMenu(catalogs, config, { kind, filter, recent, runnerId });

  const renderMark = (providerId: string): JSX.Element => (
    <ProviderMark
      pluginId={findProviderPluginId(catalogs.providers, { providerId })}
      plugins={plugins}
      size={MARK_SIZE}
    />
  );

  const renderRow = (
    row: ModelMenuRow,
    options: { readonly account?: string | null; readonly mark?: boolean } = {},
  ): JSX.Element => {
    const detail = [options.account ?? null, describeModelRow(row)]
      .filter((part) => part !== null)
      .join(" · ");
    const { problem } = row;
    const signIn = problem?.signIn ?? null;
    return (
      <MenuLine
        key={`${row.providerAccountId}:${row.harnessId}:${row.model}`}
        glyph={options.mark === true ? renderMark(row.providerId) : null}
        name={row.name}
        detail={detail === "" ? null : detail}
        note={problem?.message}
        current={row.isCurrent}
        inert={problem !== null}
        action={
          signIn === null || onSignIn === undefined
            ? null
            : {
                label: "Sign in",
                onAct: () => {
                  onSignIn(signIn);
                },
              }
        }
        onPick={() => {
          onChoose({
            kind: "model",
            providerAccountId: row.providerAccountId,
            harnessId: row.harnessId,
            model: row.model,
          });
        }}
      />
    );
  };

  const filterField = menu.filterable ? (
    <div className="pop-sec">
      <input
        className="field menu-filter"
        aria-label="Filter models"
        placeholder="Filter models…"
        // The filter is what the user came to the menu for when there are
        // this many entries.
        autoFocus
        value={filter}
        onChange={(event) => {
          setFilter(event.target.value);
        }}
      />
    </div>
  ) : null;
  const emptyNote = menu.empty === null ? null : <p className="menu-note">{menu.empty}</p>;

  if (menu.kind === "active") {
    return (
      <>
        {filterField}
        {emptyNote ?? <div className="pop-sec">{menu.rows.map((row) => renderRow(row))}</div>}
        <p className="pop-foot">{menu.note}</p>
      </>
    );
  }

  const { profile } = menu;
  if (profile === null || emptyNote !== null) {
    return (
      <>
        {filterField}
        {emptyNote}
      </>
    );
  }
  return (
    <>
      {filterField}
      {profile.recent.length === 0 ? null : (
        <div className="pop-sec">
          <div className="q-h">Recent</div>
          {profile.recent.map((row) => renderRow(row, { account: row.account, mark: true }))}
        </div>
      )}
      {profile.lanes.map((lane) => (
        <div key={lane.providerAccountId} className="pop-sec">
          <div className="q-h">
            {renderMark(lane.providerId)}
            {lane.name}
          </div>
          {lane.note === null ? lane.rows.map((row) => renderRow(row)) : null}
          {lane.note === null ? null : <p className="menu-note">{lane.note}</p>}
        </div>
      ))}
    </>
  );
}
