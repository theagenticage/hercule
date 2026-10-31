import { Fragment, useState, type JSX } from "react";
import {
  buildModelMenu,
  describeAccountRow,
  describeModelRow,
  type ModelMenu as ModelMenuModel,
  type RecentModel,
  type ThreadCatalogs,
  type ThreadChoice,
  type ThreadConfig,
  type ThreadKind,
} from "@hercule/client-core";
import { ChevronRightIcon } from "../../icons/chevron-right";
import { MenuLine } from "./menu-line";
import { HarnessLogo } from "./harness-logo";

type ModelRow = ModelMenuModel["current"]["rows"][number];

/**
 * Renders the content of a thread's model menu, as `buildModelMenu` builds
 * it:
 *
 * - a filter, when the accounts together offer more than eight models;
 * - Recent: the models picked most recently;
 * - the models of the thread's account, with its older models behind one
 *   row that shows them;
 * - every other account.
 *
 * `kind` decides what the other accounts offer. A thread that has started
 * keeps its account, so they are dimmed with the reason. A Draft Thread can
 * switch: an account's row picks the account and its default model, and
 * while the filter matches an account's models, they are listed under its
 * name and each picks the account and the model together. An account that
 * is not signed in on the machine stays dimmed.
 *
 * `readRecent` returns the Recent list as the app stores it, and `config`
 * is what the thread runs with, picks included, so the check marks the model
 * the next message will use. `onChoose` receives the one choice a row makes.
 *
 * The filter's text and whether the older models show are held here, so
 * they start afresh each time the menu opens. The Recent list is read once,
 * when the menu opens: it changes only when a message is sent.
 */
export function ModelMenu({
  catalogs,
  config,
  kind,
  readRecent,
  onChoose,
}: {
  readonly catalogs: ThreadCatalogs;
  readonly config: ThreadConfig;
  readonly kind: ThreadKind;
  readonly readRecent: () => readonly RecentModel[];
  readonly onChoose: (choice: ThreadChoice) => void;
}): JSX.Element {
  const [filter, setFilter] = useState("");
  const [older, setOlder] = useState(false);
  const [recent] = useState(readRecent);
  const menu = buildModelMenu(catalogs, config, { kind, filter, recent });
  const { current } = menu;

  const renderModelRow = (harnessId: string | null, row: ModelRow): JSX.Element => (
    <MenuLine
      key={`${row.providerAccountId}:${row.slug}`}
      glyph={harnessId === null ? null : <HarnessLogo harnessId={harnessId} size={13} />}
      name={row.name}
      detail={describeModelRow(row)}
      current={row.current}
      onPick={() => {
        onChoose({ kind: "model", providerAccountId: row.providerAccountId, model: row.slug });
      }}
    />
  );

  return (
    <>
      {menu.filterable ? (
        <div className="pop-sec">
          <input
            className="field menu-filter"
            aria-label="Filter models"
            placeholder="Filter models…"
            // The filter is what the user came to the menu for when there
            // are this many models.
            autoFocus
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
            }}
          />
        </div>
      ) : null}
      {menu.recent.length === 0 ? null : (
        <div className="pop-sec">
          <div className="q-h">Recent</div>
          {menu.recent.map((row) => (
            <MenuLine
              key={`${row.providerAccountId}:${row.model}`}
              glyph={<HarnessLogo harnessId={row.harnessId} size={13} />}
              name={row.name}
              detail={row.account}
              note={row.dimmed}
              current={false}
              inert={row.dimmed !== null}
              onPick={() => {
                onChoose({
                  kind: "model",
                  providerAccountId: row.providerAccountId,
                  model: row.model,
                });
              }}
            />
          ))}
        </div>
      )}
      {/* A filter that matches none of the account's models leaves nothing under its name. */}
      {current.rows.length === 0 && current.older.length === 0 ? null : (
        <div className="pop-sec">
          {current.label === null ? null : <div className="q-h">{current.label}</div>}
          {current.rows.map((row) => renderModelRow(current.harnessId, row))}
          {current.older.length === 0 ? null : older ? (
            current.older.map((row) => renderModelRow(current.harnessId, row))
          ) : (
            <button
              type="button"
              className="line"
              onClick={() => {
                setOlder(true);
              }}
            >
              <span className="grow">older models ({current.older.length})</span>
              <ChevronRightIcon size={13} />
            </button>
          )}
        </div>
      )}
      {menu.others.length === 0 ? null : (
        <div className="pop-sec">
          {menu.others.map((account) =>
            account.dimmed === null && account.rows.length > 0 ? (
              <Fragment key={account.providerAccountId}>
                <div className="q-h">{account.name}</div>
                {account.rows.map((row) => renderModelRow(account.harnessId, row))}
              </Fragment>
            ) : (
              <MenuLine
                key={account.providerAccountId}
                glyph={<HarnessLogo harnessId={account.harnessId} size={13} />}
                name={account.name}
                detail={describeAccountRow(account)}
                note={account.dimmed ?? account.models}
                current={false}
                chevron={account.dimmed === null}
                inert={account.dimmed !== null}
                onPick={() => {
                  onChoose({ kind: "account", providerAccountId: account.providerAccountId });
                }}
              />
            ),
          )}
        </div>
      )}
    </>
  );
}
