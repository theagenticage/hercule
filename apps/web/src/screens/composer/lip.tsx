import type { JSX } from "react";
import type { ComposerFields } from "@hydra/client-core";
import { MachineSelector } from "./machine-selector";
import { WorkspaceSelector } from "./workspace-selector";

type Key = "workspace" | "machine";

/**
 * The strip tucked under the card: where the thread works at the left, which
 * machine it runs on at the right. Both are the session's placement, so both
 * are plain text on an active thread.
 */
export function Lip({
  workspace,
  machine,
  open,
  onOpenChange,
  onPickRunner,
}: {
  readonly workspace: ComposerFields["workspace"];
  readonly machine: ComposerFields["machine"];
  readonly open: Key | null;
  readonly onOpenChange: (key: Key, open: boolean) => void;
  readonly onPickRunner: (runnerId: string) => void;
}): JSX.Element {
  return (
    <div className="mx-3.5 -mt-2 flex items-center gap-0.5 rounded-b-[10px] border border-t-0 border-line-soft bg-surface px-3 pt-[13px] pb-[5px] text-fine text-muted">
      <WorkspaceSelector
        locked={workspace.locked}
        open={open === "workspace"}
        onOpenChange={(next) => {
          onOpenChange("workspace", next);
        }}
      />
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
