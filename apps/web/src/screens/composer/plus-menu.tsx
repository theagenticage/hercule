import { useRef, type JSX, type ReactNode } from "react";
import type { ThreadServersRow } from "@hercule/client-core/mcp-servers";
import { IMAGE_MIME_TYPES } from "@hercule/contract";
import { cn, Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@hercule/ui";
import { MenuRow } from "./menu";

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
 * While `serversOffReason` is set the MCP servers row is dimmed and shows it.
 *
 * The component holds no domain: the caller builds the `submenu` and decides
 * the numbers and the reason. The caller also owns whether the submenu is
 * open (`serversOpen`), because it reads the servers only once the submenu
 * opens, not when the menu does. The file input sits outside the menu, so the
 * menu unmounting when the row is picked does not take the picker with it.
 */
export function PlusMenu({
  open,
  onOpenChange,
  attachDisabledReason,
  serversOffReason,
  onFiles,
  serversRow,
  serversOpen,
  onServersOpenChange,
  submenu,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Why no image can be attached, or `null` when one can. */
  readonly attachDisabledReason: string | null;
  /** Why the MCP servers row is off, or `null` when it works. */
  readonly serversOffReason: string | null;
  readonly onFiles: (files: readonly File[]) => void;
  readonly serversRow: ThreadServersRow;
  /** Whether the submenu "Servers of this thread" is open. */
  readonly serversOpen: boolean;
  readonly onServersOpenChange: (open: boolean) => void;
  /** The content of the submenu "Servers of this thread". */
  readonly submenu: ReactNode;
}): JSX.Element {
  const picker = useRef<HTMLInputElement>(null);
  return (
    <>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={
              serversRow.failing ? "Add to thread, a server needs sign-in" : "Add to thread"
            }
            title="Attach an image or choose MCP servers"
            className={cn(
              "relative inline-flex size-[26px] shrink-0 cursor-pointer items-center justify-center rounded-[7px] text-[17px] text-muted",
              "hover:bg-line-soft hover:text-ink aria-expanded:bg-line-soft aria-expanded:text-ink",
              "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live",
            )}
          >
            +
            {serversRow.failing ? (
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
            serversOffReason={serversOffReason}
            serversRow={serversRow}
            serversOpen={serversOpen}
            onServersOpenChange={onServersOpenChange}
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
  serversOffReason,
  serversRow,
  serversOpen: showsServers,
  onServersOpenChange: setShowsServers,
  submenu,
  onAttach,
}: {
  readonly attachDisabledReason: string | null;
  readonly serversOffReason: string | null;
  readonly serversRow: ThreadServersRow;
  readonly serversOpen: boolean;
  readonly onServersOpenChange: (open: boolean) => void;
  readonly submenu: ReactNode;
  readonly onAttach: () => void;
}): JSX.Element {
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
              inert={serversOffReason !== null}
              sub={
                serversOffReason === null ? undefined : (
                  <span className="block whitespace-normal">{serversOffReason}</span>
                )
              }
              note={
                <>
                  <span className={cn(serversRow.failing && "text-fail")}>{serversRow.words}</span>
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
