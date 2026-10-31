import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { CloseIcon } from "../../../icons/close";
import { CopyIcon } from "../../../icons/copy";
import { EditorIcon } from "../../../icons/editor";
import { PlusIcon } from "../../../icons/plus";
import { ChevronDownIcon } from "../../../office/ui/office-icons";
import { usePopoverMenu } from "../../use-popover-menu";
import "../../thread/menus.css";
import { ProfileFace } from "./profile-face";
import "./profile-tabs.css";

/** One Model Profile as its tab shows it. */
export interface ProfileTab {
  readonly id: string;
  readonly name: string;
  /** How many models the profile's menu holds, shown small after the name. */
  readonly count: number;
}

/**
 * Renders the open tab's ⌄ button and the menu it opens: Rename, Duplicate and
 * Delete…. Each item closes the menu and calls its callback.
 */
function ProfileTabMenu({
  name,
  onRename,
  onDuplicate,
  onDelete,
}: {
  readonly name: string;
  readonly onRename: () => void;
  readonly onDuplicate: () => void;
  readonly onDelete: () => void;
}): JSX.Element {
  const { triggerProps, menuProps, buildItemProps, close } = usePopoverMenu();
  const label = `Options for ${name}`;
  const deleteProps = buildItemProps("delete");
  return (
    <>
      <button
        type="button"
        className="pm-tabmore"
        {...triggerProps}
        aria-label={label}
        title={label}
      >
        <ChevronDownIcon size={11} />
      </button>
      <div
        {...menuProps}
        popover="auto"
        role="menu"
        aria-label={label}
        className="pop popover-menu pm-tabmenu"
      >
        <button
          type="button"
          {...buildItemProps("rename")}
          onClick={() => {
            close();
            onRename();
          }}
        >
          <EditorIcon size={14} />
          Rename
        </button>
        <button
          type="button"
          {...buildItemProps("duplicate")}
          onClick={() => {
            close();
            onDuplicate();
          }}
        >
          <CopyIcon size={14} />
          Duplicate
        </button>
        <button
          type="button"
          {...deleteProps}
          className={[deleteProps.className, "pm-danger"].filter(Boolean).join(" ")}
          onClick={() => {
            close();
            onDelete();
          }}
        >
          <CloseIcon size={14} />
          Delete…
        </button>
      </div>
    </>
  );
}

/**
 * Renders the open tab while its name is being edited: a text field in the
 * tab. Enter and leaving the field save the name through `onSave`, which
 * resolves to whether the name was saved; the field stays when it was not, so
 * the user can correct it. Esc, or a name that did not change, calls
 * `onStop` without saving.
 */
function RenamingTab({
  tab,
  onSave,
  onStop,
}: {
  readonly tab: ProfileTab;
  readonly onSave: (name: string) => Promise<boolean>;
  readonly onStop: () => void;
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(tab.name);
  // True once Esc or a save has decided the outcome, so the blur that follows
  // as the field goes away does not decide it again.
  const settled = useRef(false);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const commit = async (): Promise<void> => {
    if (settled.current) return;
    if (value === tab.name) {
      settled.current = true;
      onStop();
      return;
    }
    settled.current = true;
    if (await onSave(value)) onStop();
    else settled.current = false;
  };
  return (
    <span className="pm-tab pm-tab--edit" aria-selected="true">
      <ProfileFace name={value === "" ? tab.name : value} size="sm" />
      <input
        ref={inputRef}
        className="pm-rename"
        aria-label={`Name of ${tab.name}`}
        size={Math.max(8, value.length + 2)}
        value={value}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => {
          setValue(event.target.value);
        }}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            settled.current = true;
            onStop();
          }
        }}
      />
    </span>
  );
}

/**
 * Renders the Models section's profile tabs: one per Model Profile in
 * `tabs`, then "New profile". The tab `openId` is selected and carries a ⌄
 * menu with Rename, Duplicate and Delete…. The bottom edge of the row is the
 * rule above the first account's section.
 *
 * Only the selected tab is in the tab order. ←/→ select the previous or next
 * tab, and Home and End the first and the last.
 *
 * Rename edits the name in the tab itself. `onRename` saves the new name and
 * resolves to the controller's message when it refuses it, such as a blank
 * name or one another profile has, or to `null` when it saved. The message
 * shows above the tabs while the name is being edited.
 */
export function ProfileTabs({
  tabs,
  openId,
  onOpen,
  onNew,
  onRename,
  onDuplicate,
  onDelete,
}: {
  readonly tabs: readonly ProfileTab[];
  readonly openId: string;
  readonly onOpen: (id: string) => void;
  readonly onNew: () => void;
  readonly onRename: (id: string, name: string) => Promise<string | null>;
  readonly onDuplicate: (id: string) => void;
  readonly onDelete: (id: string) => void;
}): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);

  const moveFocus = (event: KeyboardEvent<HTMLElement>): void => {
    const index = tabs.findIndex(({ id }) => id === openId);
    const next =
      event.key === "ArrowLeft"
        ? (index + tabs.length - 1) % tabs.length
        : event.key === "ArrowRight"
          ? (index + 1) % tabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : undefined;
    const target = next === undefined ? undefined : tabs[next];
    if (target === undefined) return;
    event.preventDefault();
    onOpen(target.id);
    [...(listRef.current?.querySelectorAll<HTMLElement>("[role='tab']") ?? [])]
      .find((element) => element.dataset.tabId === target.id)
      ?.focus();
  };

  return (
    <>
      {renameError === null ? null : (
        <p className="pm-err" role="alert">
          {renameError}
        </p>
      )}
      <div className="pm-tabs">
        <div ref={listRef} className="pm-tablist" role="tablist" aria-label="Profiles">
          {tabs.map((tab) => {
            const isOpen = tab.id === openId;
            if (isOpen && renamingId === tab.id) {
              return (
                <RenamingTab
                  key={tab.id}
                  tab={tab}
                  onSave={async (name) => {
                    const message = await onRename(tab.id, name);
                    setRenameError(message);
                    return message === null;
                  }}
                  onStop={() => {
                    setRenamingId(null);
                    setRenameError(null);
                  }}
                />
              );
            }
            return (
              <span key={tab.id} className="pm-tabwrap">
                <button
                  type="button"
                  role="tab"
                  className="pm-tab"
                  data-tab-id={tab.id}
                  aria-selected={isOpen}
                  tabIndex={isOpen ? 0 : -1}
                  onClick={() => {
                    onOpen(tab.id);
                  }}
                  onKeyDown={moveFocus}
                >
                  <ProfileFace name={tab.name} size="sm" />
                  {tab.name}
                  <small>{tab.count}</small>
                </button>
                {isOpen ? (
                  <ProfileTabMenu
                    name={tab.name}
                    onRename={() => {
                      setRenamingId(tab.id);
                    }}
                    onDuplicate={() => {
                      onDuplicate(tab.id);
                    }}
                    onDelete={() => {
                      onDelete(tab.id);
                    }}
                  />
                ) : null}
              </span>
            );
          })}
        </div>
        <button type="button" className="pm-tab pm-tab--new" onClick={onNew}>
          <PlusIcon size={13} />
          New profile
        </button>
      </div>
    </>
  );
}
