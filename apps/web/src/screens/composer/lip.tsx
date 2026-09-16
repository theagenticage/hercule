import { useRef, useState, type JSX, type RefObject } from "react";
import type { BranchField, ComposerFields, WorkspaceMenu, WorkspacePick } from "@hydra/client-core";
import { BranchSelector } from "./branch-selector";
import { MachineSelector } from "./machine-selector";
import { WorkspaceSelector } from "./workspace-selector";

type Key = "workspace" | "branch" | "machine";

/** What a menu keeps clear of whatever stands to its right. */
const GAP = 4;

/** The branch menu's own width, as `contentClassName` sets it. */
const BRANCH_MENU_WIDTH = 320;

/**
 * The strip tucked under the card: where the thread works and on which branch
 * at the left, which machine it runs on at the right. All three are the
 * session's placement, so all three are plain text on an active thread; the
 * branch is absent entirely on a workspace the thread merely joins.
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
   * is as wide as the prototype's, which on a long model name would reach
   * under the pill; it stops 4px short of it instead.
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
                // Measured as it opens: both boxes stand still while it is
                // open, and neither exists to measure before it does.
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
