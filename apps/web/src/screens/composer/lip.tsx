import type { JSX } from "react";
import {
  referenceRunner,
  runnerMenu,
  type ComposerFields,
  type ThreadCatalogs,
} from "@hydra/client-core";
import type { ProviderInstance } from "@hydra/contract";
import { MachineSelector } from "./machine-selector";
import { WorkspaceSelector } from "./workspace-selector";

/**
 * The strip tucked under the card: where the thread works at the left, which
 * machine it runs on at the right. Both are the session's placement, so both
 * are plain text once the thread has started.
 */
export function Lip({
  fields,
  catalogs,
  instance,
  runnerId,
  open,
  onOpenChange,
  onPickRunner,
  onClose,
}: {
  readonly fields: ComposerFields;
  readonly catalogs: ThreadCatalogs;
  /** The account the machines are judged against; none picked means no rows. */
  readonly instance: ProviderInstance | undefined;
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
      <span className="ml-auto">
        <MachineSelector
          name={fields.machine.label}
          rows={
            instance === undefined
              ? []
              : runnerMenu(catalogs.runners, catalogs.localRunnerId, instance).rows
          }
          referenceId={
            referenceRunner(catalogs.runners, runnerId, catalogs.localRunnerId)?.id ?? null
          }
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
