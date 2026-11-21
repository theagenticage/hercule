import { useRef, useState, type JSX, type ReactNode } from "react";
import { IMAGE_MIME_TYPES } from "@hercule/contract";
import { cn, Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@hercule/ui";
import { MenuRow } from "./menu";

/** What the "MCP servers" row says about the thread's list. */
export interface ServersSummary {
  /** How many servers the thread has. */
  readonly count: number;
  /** How many of them need sign-in. */
  readonly needSignInCount: number;
}

/**
 * Returns the note on the "MCP servers" row: how many servers need sign-in
 * while any does, else how many the thread has, or "none".
 */
const describeServersNote = ({ count, needSignInCount }: ServersSummary): string => {
  if (needSignInCount > 0) {
    return `${String(needSignInCount)} ${needSignInCount === 1 ? "needs" : "need"} sign-in`;
  }
  return count === 0 ? "none" : String(count);
};

const holdFocus = (event: Event): void => {
  event.preventDefault();
};

/**
 * The composer's `+` button and its menu, which opens above the button. The
 * menu has two rows:
 *
 * - "Attach an image", the button's old action. While no image can be
 *   attached the row is dimmed and shows why.
 * - "MCP servers", with the number of servers the thread has, or "1 needs
 *   sign-in" in the failure colour. It opens the `submenu` beside the menu,
 *   on hover or on a press. While a server needs sign-in the button carries a
 *   red dot, so the problem shows with the menu closed.
 *
 * The component holds no domain: the caller builds the `submenu` and decides
 * the numbers and the reason. The file input sits outside the menu, so the
 * menu unmounting when the row is picked does not take the picker with it.
 */
export function PlusMenu({
  open,
  onOpenChange,
  attachDisabledReason,
  onFiles,
  servers,
  submenu,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Why no image can be attached, or `null` when one can. */
  readonly attachDisabledReason: string | null;
  readonly onFiles: (files: readonly File[]) => void;
  readonly servers: ServersSummary;
  /** The content of the submenu "Servers of this thread". */
  readonly submenu: ReactNode;
}): JSX.Element {
  const picker = useRef<HTMLInputElement>(null);
  const needsSignIn = servers.needSignInCount > 0;
  return (
    <>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={needsSignIn ? "Add to thread, a server needs sign-in" : "Add to thread"}
            title="Attach an image or choose MCP servers"
            className={cn(
              "relative inline-flex size-[26px] shrink-0 cursor-pointer items-center justify-center rounded-[7px] text-[17px] text-muted",
              "hover:bg-line-soft hover:text-ink aria-expanded:bg-line-soft aria-expanded:text-ink",
              "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live",
            )}
          >
            +
            {needsSignIn ? (
              <span
                aria-hidden="true"
                className="absolute top-[3px] right-[3px] size-1.5 rounded-full bg-fail"
              />
            ) : null}
          </button>
        </PopoverTrigger>
        <PopoverContent
          aria-label="Add to thread"
          side="top"
          align="start"
          avoidCollisions={false}
          onOpenAutoFocus={holdFocus}
          className="flex w-[260px] flex-col rounded-[10px] p-1.5 text-meta"
        >
          <PlusMenuRows
            attachDisabledReason={attachDisabledReason}
            servers={servers}
            submenu={submenu}
            onAttach={() => {
              picker.current?.click();
              onOpenChange(false);
            }}
          />
        </PopoverContent>
      </Popover>
      <input
        ref={picker}
        type="file"
        multiple
        accept={IMAGE_MIME_TYPES.join(",")}
        hidden
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          onFiles([...(event.target.files ?? [])]);
          // Cleared so picking the same file again still reports a change.
          event.target.value = "";
        }}
      />
    </>
  );
}

/**
 * The two rows of the menu and the submenu beside them. It lives inside the
 * menu's content, so the submenu closes whenever the menu does.
 */
function PlusMenuRows({
  attachDisabledReason,
  servers,
  submenu,
  onAttach,
}: {
  readonly attachDisabledReason: string | null;
  readonly servers: ServersSummary;
  readonly submenu: ReactNode;
  readonly onAttach: () => void;
}): JSX.Element {
  const [showsServers, setShowsServers] = useState(false);
  const row = useRef<HTMLDivElement>(null);
  return (
    <>
      <MenuRow
        name="Attach an image"
        inert={attachDisabledReason !== null}
        sub={
          attachDisabledReason === null ? undefined : (
            <span className="block whitespace-normal">{attachDisabledReason}</span>
          )
        }
        onPick={onAttach}
      />
      <Popover open={showsServers} onOpenChange={setShowsServers}>
        <PopoverAnchor asChild>
          <div ref={row}>
            <MenuRow
              name="MCP servers"
              note={
                <>
                  <span className={cn(servers.needSignInCount > 0 && "text-fail")}>
                    {describeServersNote(servers)}
                  </span>
                  <span aria-hidden="true" className="text-fine">
                    ›
                  </span>
                </>
              }
              className={cn(showsServers && "bg-line-soft text-ink")}
              buttonProps={{
                "aria-haspopup": "dialog",
                "aria-expanded": showsServers,
                onPointerEnter: (event) => {
                  // A touch has no hover; its press opens the submenu.
                  if (event.pointerType === "mouse") setShowsServers(true);
                },
              }}
              onPick={() => {
                setShowsServers(true);
              }}
            />
          </div>
        </PopoverAnchor>
        <PopoverContent
          aria-label="Servers of this thread"
          side="right"
          align="end"
          sideOffset={6}
          onOpenAutoFocus={holdFocus}
          // A press on the row that opened the submenu is not a press outside
          // it: closing and reopening would make the submenu flicker.
          onInteractOutside={(event) => {
            if (row.current?.contains(event.target as Node | null)) event.preventDefault();
          }}
          className="flex max-h-[calc(var(--radix-popover-content-available-height)-10px)] w-[340px] flex-col overflow-y-auto rounded-[10px] p-1.5 text-meta"
        >
          {submenu}
        </PopoverContent>
      </Popover>
    </>
  );
}
