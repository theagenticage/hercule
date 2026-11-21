import { Suspense, useState, type JSX, type KeyboardEvent } from "react";
import { ToolsIcon } from "../../icons/tools";
import { FileIcon } from "../../icons/file";
import { ChevronRightIcon } from "../../icons/chevron-right";
import type { PlusAttach } from "../session/composer-frame";
import { isMenuFocusKey, moveMenuFocus } from "../move-menu-focus";
import { ComposerMenu } from "./composer-menu";
import { PlusFace, describePlusLabel } from "./plus-face";
import { LazyThreadServerPicker, LazyThreadServersMenu } from "./lazy-thread-servers";
import { ReconnectDialog } from "./reconnect-dialog";
import type { ThreadServers } from "./use-thread-servers";

/**
 * Renders the composer's `+`: a button that opens a menu above itself with two
 * rows (spec 17 §Design system, the `+` menu).
 *
 * - "Attach an image" does what the `+` did before, with its disabled state
 *   and the reason as its tooltip (see `PlusAttach`).
 * - "MCP servers" shows the number of servers the thread has, or in the
 *   failure colour "1 needs sign-in" while one of them does. Pointing at it
 *   or pressing it opens the submenu with the switches beside the menu (see
 *   `ThreadServersMenu`, loaded then), and the submenu's "N more servers…"
 *   opens the picker. A server that needs sign-in also puts a red dot on the
 *   `+`.
 *
 * `servers` is the thread's list and how it is written. The dialogs the menu
 * opens, the picker and Reconnect, are drawn outside the menu, because the
 * menu closes first. `serversOff` is the reason the MCP row is off, or
 * `null` when it works. `disabled` leaves the `+` drawn but unable to open
 * the menu, as the composer's other menus are on a thread that takes no
 * message.
 */
export function PlusMenu({
  attach,
  servers,
  serversOff,
  disabled,
}: {
  readonly attach: PlusAttach;
  readonly servers: ThreadServers;
  readonly serversOff: string | null;
  readonly disabled: boolean;
}): JSX.Element {
  const [picking, setPicking] = useState(false);
  const [reconnectingId, setReconnectingId] = useState<string | null>(null);
  const { row } = servers;
  return (
    <>
      <ComposerMenu
        label="Add"
        align="start"
        width="bare"
        disabled={disabled}
        triggerClassName="icon-btn plus-button"
        triggerLabel={describePlusLabel(row)}
        trigger={<PlusFace row={row} />}
        onOpen={servers.clearRefusal}
      >
        {(close) => (
          <PlusMenuPanels
            attach={attach}
            servers={servers}
            serversOff={serversOff}
            onAttach={() => {
              close();
              attach.onAttach();
            }}
            onClose={close}
            onOpenPicker={() => {
              close();
              setPicking(true);
            }}
            onReconnect={(connectionId) => {
              close();
              setReconnectingId(connectionId);
            }}
          />
        )}
      </ComposerMenu>
      {picking && (
        // Without their own boundary, the dialogs' load would suspend the composer behind them.
        <Suspense fallback={null}>
          <LazyThreadServerPicker
            servers={servers}
            onClose={() => {
              setPicking(false);
            }}
          />
        </Suspense>
      )}
      {reconnectingId !== null && (
        <ReconnectDialog
          connectionId={reconnectingId}
          onClose={() => {
            setReconnectingId(null);
          }}
        />
      )}
    </>
  );
}

/**
 * Renders the two panels of the open menu: the rows, and beside them the
 * submenu once the MCP row has been pointed at or pressed. The submenu stays
 * until the menu closes, and the order of its rows is taken when it first
 * opens.
 */
function PlusMenuPanels({
  attach,
  servers,
  serversOff,
  onAttach,
  onClose,
  onOpenPicker,
  onReconnect,
}: {
  readonly attach: PlusAttach;
  readonly servers: ThreadServers;
  readonly serversOff: string | null;
  readonly onAttach: () => void;
  readonly onClose: () => void;
  readonly onOpenPicker: () => void;
  readonly onReconnect: (connectionId: string) => void;
}): JSX.Element {
  const [showsServers, setShowsServers] = useState(false);
  const openServers = (): void => {
    if (serversOff === null) setShowsServers(true);
  };
  const { row } = servers;
  const handleKeys = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "ArrowRight" && event.target instanceof HTMLElement) {
      if (event.target.dataset.item === "servers") openServers();
      return;
    }
    if (!isMenuFocusKey(event.key)) return;
    event.preventDefault();
    moveMenuFocus(event.currentTarget, event.key);
  };
  return (
    <>
      <div
        className="pop popover-menu plus-main"
        role="menu"
        aria-label="Add"
        onKeyDown={handleKeys}
      >
        <button
          type="button"
          role="menuitem"
          data-item="attach"
          aria-disabled={attach.off || undefined}
          title={attach.off ? attach.title : undefined}
          onPointerEnter={(event) => {
            event.currentTarget.focus({ preventScroll: true });
          }}
          onClick={() => {
            if (!attach.off) onAttach();
          }}
        >
          <FileIcon size={15} />
          <span className="plus-label">Attach an image</span>
        </button>
        <button
          type="button"
          role="menuitem"
          data-item="servers"
          aria-haspopup="true"
          aria-expanded={showsServers}
          aria-disabled={serversOff !== null || undefined}
          title={serversOff ?? undefined}
          className={showsServers ? "is-open" : undefined}
          onPointerEnter={(event) => {
            event.currentTarget.focus({ preventScroll: true });
            openServers();
          }}
          onClick={openServers}
        >
          <ToolsIcon size={15} />
          <span className="plus-label">MCP servers</span>
          <span className={row.failing ? "plus-fine is-fail" : "plus-fine"}>{row.words}</span>
          <ChevronRightIcon size={13} />
        </button>
      </div>
      {showsServers && (
        <Suspense fallback={<div className="pop plus-sub" aria-busy="true" />}>
          <LazyThreadServersMenu
            servers={servers}
            onOpenPicker={onOpenPicker}
            onReconnect={onReconnect}
            onClose={onClose}
          />
        </Suspense>
      )}
    </>
  );
}
