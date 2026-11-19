import { useId, useImperativeHandle, useRef, useState, type JSX, type Ref } from "react";
import { ChatIcon } from "../../icons/chat";
import { CheckIcon } from "../../icons/check";
import { ChevronDownIcon } from "../../icons/chevron-down";
import { FolderIcon } from "../../icons/folder";
import { ProjectTile, type ProjectTint } from "../project-tile";
import { usePopoverMenu } from "../use-popover-menu";
import "../new-thread/new-thread.css";
import "../thread/menus.css";
import "./thread-dialog.css";

/** One project the pick offers. */
export interface ProjectPickOption {
  readonly id: string;
  readonly name: string;
  readonly tint: ProjectTint;
  /** The project's repositories, as one line of text. */
  readonly repositories: string;
}

/** What the dialog has picked so far: a project, no project on purpose, or nothing yet. */
export type ProjectPickValue =
  | { readonly kind: "project"; readonly projectId: string }
  | { readonly kind: "none" }
  | { readonly kind: "unpicked" };

/** The item name of "No project" in the menu, which no project id can equal. */
const NO_PROJECT_ITEM = "";

/**
 * Renders the project pick that starts the dialog's lip, and the menu it
 * opens. The pick has three looks:
 *
 * - a picked project: its folder, its name and a chevron;
 * - "No project" with the note "No checkout", when the user chose to start
 *   with no code;
 * - "Choose a project" in marigold, the colour of what asks the user, when
 *   nothing points at a project and the user has not chosen.
 *
 * The menu is the browser's own popover, so it opens on top of the dialog and
 * nothing clips it. It opens under the pick, or above it when there is no
 * room. It holds a heading, `reason` (why the current pick is the current
 * pick), a row for each of `projects` with a check on the current one, a
 * separator and "No project: no code, no checkout". The arrows move, ↩ picks,
 * Esc closes the menu and gives the focus back to the pick.
 *
 * A pick calls `onPick` with the project's id, or with `null` for no project.
 * `openMenuRef` receives a function that opens the menu, for the caller that
 * asks for a choice, such as ⌘↩ before a project is picked.
 */
export function ProjectPick({
  pick,
  reason,
  projects,
  openMenuRef,
  onPick,
}: {
  readonly pick: ProjectPickValue;
  readonly reason: string;
  readonly projects: readonly ProjectPickOption[];
  readonly openMenuRef?: Ref<() => void> | undefined;
  readonly onPick: (projectId: string | null) => void;
}): JSX.Element {
  const { triggerProps, menuProps, buildItemProps, close } = usePopoverMenu();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const headingId = useId();
  // Follows the browser's open state, which changes without React: on Esc and on a click outside.
  const [open, setOpen] = useState(false);
  // A click opens the menu through `popovertarget`, which also anchors it to the pick.
  // Only opens: a second call while the menu is open leaves it open.
  useImperativeHandle(
    openMenuRef,
    () => () => {
      if (!open) triggerRef.current?.click();
    },
    [open],
  );
  const chosen =
    pick.kind === "project" ? projects.find((p) => p.id === pick.projectId) : undefined;

  const take = (projectId: string | null): void => {
    close();
    onPick(projectId);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={pick.kind === "unpicked" ? "lip-pick lip-pick--ask" : "lip-pick"}
        aria-label={chosen === undefined ? undefined : `Project ${chosen.name}`}
        aria-expanded={open}
        {...triggerProps}
      >
        {pick.kind === "none" ? <ChatIcon size={14} /> : <FolderIcon size={14} />}
        {pick.kind === "none"
          ? "No project"
          : pick.kind === "unpicked"
            ? "Choose a project"
            : (chosen?.name ?? "")}
        <ChevronDownIcon size={10} />
      </button>
      {pick.kind === "none" ? <span className="thread-dialog-lip-note">No checkout</span> : null}
      <div
        {...menuProps}
        popover="auto"
        className="pop popover-menu project-pick-menu"
        onToggle={(event) => {
          menuProps.onToggle(event);
          setOpen(event.newState === "open");
        }}
      >
        <p id={headingId} className="project-pick-heading">
          Project
        </p>
        <p className="project-pick-reason">{reason}</p>
        <div role="menu" aria-labelledby={headingId}>
          {projects.map((project) => {
            const current = pick.kind === "project" && pick.projectId === project.id;
            return (
              <button
                key={project.id}
                type="button"
                {...buildItemProps(project.id, { checked: current })}
                onClick={() => {
                  take(project.id);
                }}
              >
                <ProjectTile tint={project.tint} name={project.name} />
                <small>{project.repositories}</small>
                {current ? <CheckIcon size={14} /> : null}
              </button>
            );
          })}
          <div role="separator" className="project-pick-line" />
          <button
            type="button"
            {...buildItemProps(NO_PROJECT_ITEM, { checked: pick.kind === "none" })}
            onClick={() => {
              take(null);
            }}
          >
            <ChatIcon size={14} />
            <span className="project-pick-none">No project: no code, no checkout</span>
            {pick.kind === "none" ? <CheckIcon size={14} /> : null}
          </button>
        </div>
      </div>
    </>
  );
}
