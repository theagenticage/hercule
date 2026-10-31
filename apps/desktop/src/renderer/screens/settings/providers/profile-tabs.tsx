import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { ChevronRightIcon } from "../../../icons/chevron-right";
import { CloseIcon } from "../../../icons/close";
import { CopyIcon } from "../../../icons/copy";
import { EditorIcon } from "../../../icons/editor";
import { PlusIcon } from "../../../icons/plus";
import { usePopoverMenu } from "../../use-popover-menu";
import "../../thread/menus.css";
import { ProfileFace } from "../../profile-face";
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
        <ChevronRightIcon size={11} />
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
 * tab. Enter and leaving the field end the edit. A name that is blank calls
 * `onBlank` and keeps the field, so the user can correct it. A name that did
 * not change calls `onStop`, and so does Esc. Any other name calls `onSave`.
 * Both are told whether the edit ended on the keyboard (Enter or Esc), because
 * then focus goes back to the tab, while leaving the field means the user has
 * already moved focus somewhere else. The field never waits for a save:
 * whoever receives the name saves it.
 */
function RenamingTab({
  tab,
  onSave,
  onBlank,
  onStop,
}: {
  readonly tab: ProfileTab;
  readonly onSave: (name: string, endedOnKeyboard: boolean) => void;
  readonly onBlank: () => void;
  readonly onStop: (endedOnKeyboard: boolean) => void;
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(tab.name);
  // True once the edit has ended, so the blur that follows as the field goes
  // away does not end it a second time.
  const ended = useRef(false);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const end = (finish: () => void): void => {
    ended.current = true;
    finish();
  };
  const commit = (endedOnKeyboard: boolean): void => {
    if (ended.current) return;
    if (value === tab.name)
      end(() => {
        onStop(endedOnKeyboard);
      });
    else if (value.trim() === "") onBlank();
    else
      end(() => {
        onSave(value, endedOnKeyboard);
      });
  };
  return (
    <span className="pm-tab pm-tab--edit" role="tab" aria-selected="true">
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
        onBlur={() => {
          commit(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit(true);
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (!ended.current)
              end(() => {
                onStop(true);
              });
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
 * Rename edits the name in the tab itself. A valid name closes the editor at
 * once and goes to `onRename`, which saves it; the caller shows the new name
 * in `tabs` while the save runs, and the stored name again if it is refused.
 * A blank name is refused here, in the editor, with "A profile needs a name.",
 * and `onRename` is not called.
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
  readonly onRename: (id: string, name: string) => void;
  readonly onDuplicate: (id: string) => void;
  readonly onDelete: (id: string) => void;
}): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);
  // The profile whose name is being edited, and whether the editor holds a blank name.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [blankName, setBlankName] = useState(false);

  // Set when a rename ended on the keyboard: the field was focused, and
  // focus would drop to the page when it goes away, so the tab takes it back.
  const refocusAfterRename = useRef(false);
  const stopRenaming = (endedOnKeyboard = false): void => {
    refocusAfterRename.current = endedOnKeyboard;
    setRenamingId(null);
    setBlankName(false);
  };
  const focusTab = (id: string): void => {
    [...(listRef.current?.querySelectorAll<HTMLElement>("[role='tab']") ?? [])]
      .find((element) => element.dataset.tabId === id)
      ?.focus();
  };
  useEffect(() => {
    if (renamingId !== null || !refocusAfterRename.current) return;
    refocusAfterRename.current = false;
    focusTab(openId);
  }, [renamingId, openId]);
  const openTab = (id: string): void => {
    stopRenaming();
    onOpen(id);
  };

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
    openTab(target.id);
    focusTab(target.id);
  };

  return (
    <>
      {blankName ? (
        <p className="pm-err" role="alert">
          A profile needs a name.
        </p>
      ) : null}
      <div className="pm-tabs">
        <div ref={listRef} className="pm-tablist" role="tablist" aria-label="Profiles">
          {tabs.map((tab) => {
            const isOpen = tab.id === openId;
            if (isOpen && renamingId === tab.id) {
              return (
                <RenamingTab
                  key={tab.id}
                  tab={tab}
                  onSave={(name, endedOnKeyboard) => {
                    stopRenaming(endedOnKeyboard);
                    onRename(tab.id, name);
                  }}
                  onBlank={() => {
                    setBlankName(true);
                  }}
                  onStop={stopRenaming}
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
                    openTab(tab.id);
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
