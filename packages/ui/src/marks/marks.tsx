import type { JSX, ReactNode, SVGProps } from "react";
import { cn } from "../primitives/cn";

/**
 * Every mark is drawn on one 12px grid at a 1.15px stroke, in `currentColor`,
 * and is decorative: the row it sits in names its meaning in text.
 */
export type MarkProps = Omit<SVGProps<SVGSVGElement>, "children" | "name">;

function Mark({
  name,
  paint,
  strokeWidth = 1.15,
  className,
  drawing,
  ...props
}: MarkProps & {
  name: string;
  paint?: string;
  drawing: ReactNode;
}): JSX.Element {
  return (
    <svg
      data-mark={name}
      viewBox="0 0 12 12"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn("shrink-0", paint, className)}
      {...props}
    >
      {drawing}
    </svg>
  );
}

/**
 * The soft equalizer: three bars breathing in the live hue. Their resting
 * heights are the attributes, which is what shows under reduced motion; the
 * `hydra-equalizer` rules in styles.css animate them otherwise.
 */
export function WorkingMark({ className, ...props }: MarkProps): JSX.Element {
  return (
    <Mark
      name="working"
      paint="text-live"
      className={cn("hydra-equalizer", className)}
      stroke="none"
      drawing={
        <>
          <rect x={1.5} y={6.5} width={2} height={3} rx={1} fill="currentColor" />
          <rect x={5} y={2.5} width={2} height={7} rx={1} fill="currentColor" />
          <rect x={8.5} y={5} width={2} height={4.5} rx={1} fill="currentColor" />
        </>
      }
      {...props}
    />
  );
}

export function DecisionMark(props: MarkProps): JSX.Element {
  return (
    <Mark
      name="decision"
      paint="text-attn"
      strokeWidth={1.35}
      drawing={
        <>
          <path d="M3.9 4.3a2.1 2.1 0 1 1 3 1.9c-.6.35-.9.75-.9 1.4v.2" />
          <path d="M6 10.2h.01" />
        </>
      }
      {...props}
    />
  );
}

export function QueuedMark(props: MarkProps): JSX.Element {
  return (
    <Mark name="queued" paint="text-faint" drawing={<circle cx={6} cy={6} r={3.4} />} {...props} />
  );
}

export function PausedMark(props: MarkProps): JSX.Element {
  return (
    <Mark name="paused" paint="text-attn" drawing={<path d="M4 2.5v7M8 2.5v7" />} {...props} />
  );
}

export function DoneMark(props: MarkProps): JSX.Element {
  return (
    <Mark name="done" paint="text-ok" drawing={<path d="m2.4 6.4 2.5 2.5 4.8-5.3" />} {...props} />
  );
}

export function FailedMark(props: MarkProps): JSX.Element {
  return (
    <Mark name="failed" paint="text-fail" drawing={<path d="m3 3 6 6M9 3l-6 6" />} {...props} />
  );
}

export function CancelledMark(props: MarkProps): JSX.Element {
  return <Mark name="cancelled" paint="text-faint" drawing={<path d="M2.75 6h6.5" />} {...props} />;
}

export function TaskGlyph(props: MarkProps): JSX.Element {
  return (
    <Mark
      name="task"
      drawing={<rect x={1.75} y={1.75} width={8.5} height={8.5} rx={2.25} />}
      {...props}
    />
  );
}

export function RunGlyph(props: MarkProps): JSX.Element {
  return (
    <Mark
      name="run"
      drawing={
        <path d="M3.25 2.4v7.2a.55.55 0 0 0 .83.47l5.9-3.6a.55.55 0 0 0 0-.94l-5.9-3.6a.55.55 0 0 0-.83.47z" />
      }
      {...props}
    />
  );
}

export function SessionGlyph(props: MarkProps): JSX.Element {
  return (
    <Mark
      name="session"
      drawing={
        <path d="M3.25 1.75h5.5A1.75 1.75 0 0 1 10.5 3.5v2.75A1.75 1.75 0 0 1 8.75 8H5.6L3.4 10.2V8h-.15A1.75 1.75 0 0 1 1.5 6.25V3.5a1.75 1.75 0 0 1 1.75-1.75z" />
      }
      {...props}
    />
  );
}

export function WorkflowGlyph(props: MarkProps): JSX.Element {
  return (
    <Mark
      name="workflow"
      drawing={
        <>
          <circle cx={2.6} cy={6} r={1.35} />
          <circle cx={9.4} cy={2.6} r={1.35} />
          <circle cx={9.4} cy={9.4} r={1.35} />
          <path d="M3.9 6h2.4l2.1-2.5M6.3 6l2.1 2.5" />
        </>
      }
      {...props}
    />
  );
}
