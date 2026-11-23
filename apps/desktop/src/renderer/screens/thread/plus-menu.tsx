import { Suspense, useEffect, useState, type JSX, type KeyboardEvent } from "react";
import { ToolsIcon } from "../../icons/tools";
import { FileIcon } from "../../icons/file";
import { ChevronRightIcon } from "../../icons/chevron-right";
import type { PlusAttach } from "../session/composer-frame";
import { isMenuFocusKey, moveMenuFocus } from "../move-menu-focus";
import type { ThreadServersRow } from "@hercule/client-core/mcp-servers/first-screen";
import type { SignInAction } from "@hercule/client-core/mcp-servers";
import { PlusIcon } from "../../icons/plus";
import { ComposerMenu } from "./composer-menu";
import {
  LazySignInDialog,
  LazyThreadServerPicker,
  LazyThreadServersMenu,
} from "./lazy-thread-servers";
import { useThreadServers } from "./thread-servers";
import type { ThreadServersTarget } from "./thread-server-edits";

/**
 * Renders the composer's `+`: a button that opens a menu above itself with two
 * rows (spec 17 §Design system, the `+` menu). The button and the two rows are
 * part of the first screen, so Attach works on the first click and the red dot
 * is drawn from the first frame. Only the submenu and the picker load, when
 * the MCP row opens.
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
 * The thread's list and its row come from the open thread's servers (see
 * `ThreadServersProvider`), and `target` is the thread whose list the submenu
 * and the picker edit (see `WithThreadServerEdits`). Opening the
 * MCP row or the picker tells the provider the editor is open, which is when
 * it reads the servers, and it stays open from the submenu to the picker.
 * Opening the menu for Attach alone reads nothing. The dialogs the menu
 * opens, the picker and the sign-in, are drawn outside the menu, because the
 * menu closes first. `serversOff` is the reason the MCP row is off, or
 * `null` when it works. The menu opens on a thread that takes no message too:
 * its list can be edited, and `attach` says that Attach is off.
 *
 * A refusal of a write belongs to the thread's list, so it stays until the
 * next write: closing the menu or the picker, opening them again, and the
 * handoff from the submenu to the picker never clear it, and a write refused
 * after they were closed still shows when they open again.
 */
export function PlusMenu({
  attach,
  target,
  serversOff,
}: {
  readonly attach: PlusAttach;
  readonly target: ThreadServersTarget;
  readonly serversOff: string | null;
}): JSX.Element {
  const { described, setEditing } = useThreadServers();
  const { row } = described;
  const [picking, setPicking] = useState(false);
  // Whether the submenu is open. It closes with the menu, in `onClosed`.
  const [showsServers, setShowsServers] = useState(false);
  const [signingIn, setSigningIn] = useState<SignInAction | null>(null);
  // One state for the submenu and the picker, so the handoff from one to the other never drops it.
  const editing = showsServers || picking;
  useEffect(() => {
    setEditing(editing);
    return () => {
      setEditing(false);
    };
  }, [editing, setEditing]);
  return (
    <>
      <ComposerMenu
        label="Add"
        align="start"
        width="bare"
        disabled={false}
        triggerClassName="icon-btn plus-button"
        triggerLabel={row.failing ? `Add (${row.words})` : "Add"}
        trigger={
          <>
            <PlusIcon />
            {row.failing && <i className="dot dot--fail plus-dot" />}
          </>
        }
        onClosed={() => {
          setShowsServers(false);
        }}
      >
        {(close) => (
          <PlusMenuPanels
            attach={attach}
            row={row}
            showsServers={showsServers}
            onShowServers={() => {
              setShowsServers(true);
            }}
            target={target}
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
            onSignIn={(action) => {
              close();
              setSigningIn(action);
            }}
          />
        )}
      </ComposerMenu>
      {picking && (
        // Without their own boundary, the dialogs' load would suspend the composer behind them.
        <Suspense fallback={null}>
          <LazyThreadServerPicker
            target={target}
            onClose={() => {
              setPicking(false);
            }}
          />
        </Suspense>
      )}
      {signingIn !== null && (
        <Suspense fallback={null}>
          <LazySignInDialog
            action={signingIn}
            onClose={() => {
              setSigningIn(null);
            }}
          />
        </Suspense>
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
  row,
  showsServers,
  onShowServers,
  target,
  serversOff,
  onAttach,
  onClose,
  onOpenPicker,
  onSignIn,
}: {
  readonly attach: PlusAttach;
  readonly row: ThreadServersRow;
  readonly showsServers: boolean;
  readonly onShowServers: () => void;
  readonly target: ThreadServersTarget;
  readonly serversOff: string | null;
  readonly onAttach: () => void;
  readonly onClose: () => void;
  readonly onOpenPicker: () => void;
  readonly onSignIn: (action: SignInAction) => void;
}): JSX.Element {
  const openServers = (): void => {
    if (serversOff === null) onShowServers();
  };
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
            target={target}
            onOpenPicker={onOpenPicker}
            onSignIn={onSignIn}
            onClose={onClose}
          />
        </Suspense>
      )}
    </>
  );
}
