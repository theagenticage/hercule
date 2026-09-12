import type { JSX } from "react";
import type { ComposerFields } from "@hydra/client-core";
import { MachineSelector } from "./machine-selector";
import { WorkspaceSelector } from "./workspace-selector";

/**
 * The strip tucked under the card: where the thread works at the left, which
 * machine it runs on at the right. Both are the session's placement, so both
 * are plain text on an active thread.
 */
export function Lip({
  fields,
  runnerId,
  open,
  onOpenChange,
  onPickRunner,
  onClose,
}: {
  readonly fields: ComposerFields;
  /** The machine picked, which marks its row; none picked marks no row. */
  readonly runnerId: string | null;
  readonly open: "workspace" | "machine" | null;
  readonly onOpenChange: (key: "workspace" | "machine") => (open: boolean) => void;
  readonly onPickRunner: (runnerId: string) => void;
  readonly onClose: () => void;
}): JSX.Element {
  return (
    <div className="mx-3.5 -mt-2 flex items-center gap-0.5 rounded-b-[10px] border border-t-0 border-line-soft bg-surface px-3 pt-[13px] pb-[5px] text-fine text-muted">
      <WorkspaceSelector
        locked={fields.workspace.locked}
        open={open === "workspace"}
        onOpenChange={onOpenChange("workspace")}
        onPick={onClose}
      />
      <span className="ml-auto inline-flex items-center gap-0.5">
        <MachineSelector
          name={fields.machine.label}
          rows={fields.machine.rows}
          referenceId={fields.machine.referenceId}
          runnerId={runnerId}
          locked={fields.machine.locked}
          open={open === "machine"}
          onOpenChange={onOpenChange("machine")}
          onPick={onPickRunner}
        />
      </span>
    </div>
  );
}
