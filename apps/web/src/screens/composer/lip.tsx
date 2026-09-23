import { useRef, useState, type JSX, type RefObject } from "react";
import type {
  BranchField,
  ComposerFields,
  WorkspaceMenu,
  WorkspacePick,
} from "@hercule/client-core";
import { BranchSelector } from "./branch-selector";
import { MachineSelector } from "./machine-selector";
import { WorkspaceSelector } from "./workspace-selector";

type Key = "workspace" | "branch" | "machine";

/** The space, in pixels, a menu leaves between itself and the element to its right. */
const GAP = 4;

/** The branch menu's width in pixels; must match the `w-80` in its `contentClassName`. */
const BRANCH_MENU_WIDTH = 320;

/**
 * The strip tucked under the composer card. The workspace and branch sit on
 * the left, the machine on the right. All three are where the session is
 * placed, so on an active thread all three are plain text. When the thread
 * joins an existing workspace, there is no branch selector at all.
 */
export function Lip({
  workspace,
  menu,
  branch,
  machine,
  pill,
  open,
  onOpenChange,
  onPickWorkspace,
  onPickBranch,
  onPickRunner,
}: {
  readonly workspace: ComposerFields["workspace"];
  readonly menu: WorkspaceMenu;
  readonly branch: BranchField | null;
  readonly machine: ComposerFields["machine"];
  /**
   * The card's model pill. The branch menu opens from the left of the lip and
   * is as wide as in the prototype, so with a long model name it would reach
   * under the pill. It is shifted left to stop 4px short of the pill instead.
   */
  readonly pill: RefObject<HTMLSpanElement | null>;
  readonly open: Key | null;
  readonly onOpenChange: (key: Key, open: boolean) => void;
  readonly onPickWorkspace: (pick: WorkspacePick) => void;
  readonly onPickBranch: (branch: string) => void;
  readonly onPickRunner: (runnerId: string) => void;
}): JSX.Element {
  const branchTrigger = useRef<HTMLSpanElement>(null);
  const [room, setRoom] = useState(0);

  return (
    <div className="mx-3.5 -mt-2 flex items-center gap-0.5 rounded-b-[10px] border border-t-0 border-line-soft bg-surface px-3 pt-[13px] pb-[5px] text-fine text-muted">
      <WorkspaceSelector
        menu={menu}
        locked={workspace.locked}
        open={open === "workspace"}
        onOpenChange={(next) => {
          onOpenChange("workspace", next);
        }}
        onPick={onPickWorkspace}
      />
      {branch === null ? null : (
        <>
          <span aria-hidden="true" className="mx-1.5 h-3 w-px bg-line" />
          <span ref={branchTrigger} className="inline-flex">
            <BranchSelector
              field={branch}
              room={room}
              open={open === "branch"}
              onOpenChange={(next) => {
                // Measure when the menu opens. Neither element moves while
                // the menu is open, so one measurement is enough.
                if (next) {
                  const from = branchTrigger.current?.getBoundingClientRect().left;
                  const to = pill.current?.getBoundingClientRect().left;
                  setRoom(
                    from === undefined || to === undefined
                      ? 0
                      : Math.min(0, to - GAP - (from + BRANCH_MENU_WIDTH)),
                  );
                }
                onOpenChange("branch", next);
              }}
              onPick={onPickBranch}
            />
          </span>
        </>
      )}
      <span className="ml-auto inline-flex items-center gap-0.5">
        <MachineSelector
          label={machine.label}
          rows={machine.rows}
          locked={machine.locked}
          open={open === "machine"}
          onOpenChange={(next) => {
            onOpenChange("machine", next);
          }}
          onPick={onPickRunner}
        />
      </span>
    </div>
  );
}
