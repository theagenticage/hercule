import { useState, type JSX } from "react";
import {
  buildModelMenu,
  type ModelMenu as ModelMenuModel,
  type RecentModel,
  type ThreadCatalogs,
  type ThreadConfig,
} from "@hercule/client-core";
import { CheckIcon, ChevronRightIcon } from "../../icons";
import { ProviderLogo } from "./provider-logo";

type ModelRow = ModelMenuModel["current"]["rows"][number];

/**
 * Renders the content of an active thread's model menu, as `buildModelMenu`
 * builds it:
 *
 * - a filter, when the accounts together offer more than eight models;
 * - Recent: the models picked most recently;
 * - the models of the thread's account, with its older models behind one
 *   row that shows them;
 * - every other account, dimmed with the reason: a thread that has started
 *   keeps its account, so only its own account's models can be picked.
 *
 * `recent` is the Recent list as the app stores it, and `config` what the
 * thread runs with, picks included, so the check marks the model the next
 * message will use. `onPick` receives the slug of the model picked.
 *
 * The filter's text and whether the older models show are held here, so
 * they start afresh each time the menu opens.
 */
export function ModelMenu({
  catalogs,
  config,
  recent,
  onPick,
}: {
  readonly catalogs: ThreadCatalogs;
  readonly config: ThreadConfig;
  readonly recent: readonly RecentModel[];
  readonly onPick: (model: string) => void;
}): JSX.Element {
  const [filter, setFilter] = useState("");
  const [older, setOlder] = useState(false);
  const menu = buildModelMenu(catalogs, config, { kind: "active", filter, recent });
  const { current } = menu;

  const renderModelRow = (row: ModelRow): JSX.Element => (
    <button
      key={row.slug}
      type="button"
      className="line"
      aria-current={row.current || undefined}
      onClick={() => {
        onPick(row.slug);
      }}
    >
      {current.providerId === null ? null : (
        <ProviderLogo providerId={current.providerId} size={13} />
      )}
      <span className="grow">
        <b>{row.name}</b>
        {row.isDefault && !row.current ? " · default" : null}
      </span>
      {row.current ? <CheckIcon size={14} /> : null}
    </button>
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
          {menu.recent.map((row) => {
            const body = (
              <>
                <ProviderLogo providerId={row.providerId} size={13} />
                <span className="grow">
                  <b>{row.name}</b>
                  {row.account === null ? null : ` · ${row.account}`}
                </span>
                {row.dimmed === null ? null : <span className="faint">{row.dimmed}</span>}
              </>
            );
            const key = `${row.instanceId}:${row.model}`;
            return row.dimmed === null ? (
              <button
                key={key}
                type="button"
                className="line"
                onClick={() => {
                  onPick(row.model);
                }}
              >
                {body}
              </button>
            ) : (
              <div key={key} className="line line--dimmed">
                {body}
              </div>
            );
          })}
        </div>
      )}
      <div className="pop-sec">
        {current.label === null ? null : <div className="q-h">{current.label}</div>}
        {current.rows.map(renderModelRow)}
        {current.older.length === 0 ? null : older ? (
          current.older.map(renderModelRow)
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
      {menu.others.length === 0 ? null : (
        <div className="pop-sec">
          {menu.others.map((instance) => (
            <div key={instance.instanceId} className="line line--dimmed">
              <ProviderLogo providerId={instance.providerId} size={13} />
              <span className="grow">
                <b>{instance.name}</b>
                {[instance.identity, instance.planLabel]
                  .filter((each) => each !== null)
                  .map((each) => ` · ${each}`)}
              </span>
              <span className="faint">{instance.dimmed}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
