import type { JSX } from "react";
import type { BranchField, ComposerFields, WorkspaceMenu, WorkspacePick } from "@hydra/client-core";
import { BranchSelector } from "./branch-selector";
import { MachineSelector } from "./machine-selector";
import { WorkspaceSelector } from "./workspace-selector";

type Key = "workspace" | "branch" | "machine";

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
  readonly open: Key | null;
  readonly onOpenChange: (key: Key, open: boolean) => void;
  readonly onPickWorkspace: (pick: WorkspacePick) => void;
  readonly onPickBranch: (branch: string) => void;
  readonly onPickRunner: (runnerId: string) => void;
}): JSX.Element {
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
          <BranchSelector
            field={branch}
            open={open === "branch"}
            onOpenChange={(next) => {
              onOpenChange("branch", next);
            }}
            onPick={onPickBranch}
          />
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
