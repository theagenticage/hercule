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
 * One rename of a profile's name. `token` tells this edit from every earlier
 * and later one, even on the same profile; `error` is the controller's
 * refusal of the last save, shown while the edit is open.
 */
interface RenameEdit {
  readonly token: number;
  readonly id: string;
  readonly error: string | null;
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
 * tab. Enter and leaving the field save the name through `onSave`, which
 * resolves to whether the name was saved; the field stays when it was not, so
 * the user can correct it. Esc, or a name that did not change, calls
 * `onStop` without saving.
 *
 * The field is read-only while its save runs, so the name the user sees is
 * the name being saved: a letter typed then would be lost when the field
 * closes.
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
  const [saving, setSaving] = useState(false);
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
    setSaving(true);
    const saved = await onSave(value);
    setSaving(false);
    if (saved) onStop();
    else settled.current = false;
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
        readOnly={saving}
        aria-busy={saving}
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
 *
 * Each Rename starts a new edit, and the answer to a save only reaches the
 * edit that sent it. Opening another tab ends the edit, so an answer that
 * arrives later cannot close or put an error on the edit of another tab the
 * user has started since. A refusal that arrives after the edit ended is
 * handed to `onRenameRefusedLater` with the name the profile still has, so the
 * page can tell the user the profile was not renamed.
 */
export function ProfileTabs({
  tabs,
  openId,
  onOpen,
  onNew,
  onRename,
  onRenameRefusedLater,
  onDuplicate,
  onDelete,
}: {
  readonly tabs: readonly ProfileTab[];
  readonly openId: string;
  readonly onOpen: (id: string) => void;
  readonly onNew: () => void;
  readonly onRename: (id: string, name: string) => Promise<string | null>;
  readonly onRenameRefusedLater: (profileName: string, message: string) => void;
  readonly onDuplicate: (id: string) => void;
  readonly onDelete: (id: string) => void;
}): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);
  const [edit, setEdit] = useState<RenameEdit | null>(null);
  const nextEditToken = useRef(0);
  // The token of the edit that is open now, or `null`. Read when a save
  // answers, to tell an answer for the open edit from one for an edit that
  // ended.
  const openEditToken = useRef<number | null>(null);
  /** Changes the edit `token` with `change`, unless that edit has ended or another has begun. */
  const changeEdit = (token: number, change: (current: RenameEdit) => RenameEdit | null): void => {
    setEdit((current) => (current?.token === token ? change(current) : current));
  };

  const openTab = (id: string): void => {
    openEditToken.current = null;
    setEdit(null);
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
    [...(listRef.current?.querySelectorAll<HTMLElement>("[role='tab']") ?? [])]
      .find((element) => element.dataset.tabId === target.id)
      ?.focus();
  };

  return (
    <>
      {edit?.error == null ? null : (
        <p className="pm-err" role="alert">
          {edit.error}
        </p>
      )}
      <div className="pm-tabs">
        <div ref={listRef} className="pm-tablist" role="tablist" aria-label="Profiles">
          {tabs.map((tab) => {
            const isOpen = tab.id === openId;
            if (isOpen && edit?.id === tab.id) {
              const { token } = edit;
              return (
                <RenamingTab
                  key={tab.id}
                  tab={tab}
                  onSave={async (name) => {
                    const message = await onRename(tab.id, name);
                    if (message !== null && openEditToken.current !== token) {
                      onRenameRefusedLater(tab.name, message);
                    } else {
                      changeEdit(token, (current) => ({ ...current, error: message }));
                    }
                    return message === null;
                  }}
                  onStop={() => {
                    if (openEditToken.current === token) openEditToken.current = null;
                    changeEdit(token, () => null);
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
                      const token = nextEditToken.current++;
                      openEditToken.current = token;
                      setEdit({ token, id: tab.id, error: null });
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
