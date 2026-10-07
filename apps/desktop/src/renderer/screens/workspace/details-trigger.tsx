import { lazy, Suspense, useRef, useState, type JSX, type ReactNode } from "react";

const WorkspaceDetails = lazy(() =>
  import("./workspace-details").then((module) => ({ default: module.WorkspaceDetails })),
);

/** Opens workspace details on demand and returns keyboard focus when the dialog closes. */
export function WorkspaceDetailsTrigger({
  workspaceId,
  children,
  className = "workspace-details-trigger",
  label = "Workspace details",
}: {
  readonly workspaceId: string;
  readonly children: ReactNode;
  readonly className?: string;
  readonly label?: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={className}
        aria-label={label}
        title="Workspace details"
        onClick={() => setOpen(true)}
      >
        {children}
      </button>
      {open ? (
        <Suspense fallback={null}>
          <WorkspaceDetails
            key={workspaceId}
            workspaceId={workspaceId}
            onClose={() => {
              setOpen(false);
              trigger.current?.focus();
            }}
          />
        </Suspense>
      ) : null}
    </>
  );
}
