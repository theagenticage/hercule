import type { JSX } from "react";

export { cn } from "./primitives/cn";
export { Button, type ButtonVariant } from "./primitives/button";
export { Input } from "./primitives/input";
export { Label } from "./primitives/label";
export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "./primitives/popover";
export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "./primitives/dialog";
export { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./primitives/select";
export { SegmentedControl, SegmentedControlItem } from "./primitives/segmented-control";

export {
  CancelledMark,
  DecisionMark,
  DoneMark,
  FailedMark,
  PausedMark,
  QueuedMark,
  RunGlyph,
  SessionGlyph,
  TaskGlyph,
  WorkflowGlyph,
  WorkingMark,
  type MarkProps,
} from "./marks/marks";
export { MarksLegend } from "./marks/marks-legend";

/** The product wordmark. */
export function Logo(): JSX.Element {
  return <span data-testid="logo">Hydra</span>;
}
