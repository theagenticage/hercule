import type { ComponentType } from "react";
import { RunGlyph, TaskGlyph, WorkflowGlyph, type MarkProps } from "@hercule/ui";

/** Which sidebar face a screen belongs to. */
export type Face = "threads" | "orchestration";

/** One item of the orchestration nav, or the hairline between its two halves. */
export interface NavItem {
  readonly to: string;
  readonly label: string;
  /** Set only on the entity items; every other item carries no glyph. */
  readonly glyph?: ComponentType<MarkProps>;
  /** The name of the count this item shows once there is one to show. */
  readonly count?: "intake" | "checkin" | "notifications";
  /** True where the item is the head of a section rather than a leaf screen. */
  readonly section?: boolean;
}

export const SEPARATOR = "separator" as const;

/** The items of the orchestration face, in their pinned order. */
export const ORCHESTRATION_NAV: readonly (NavItem | typeof SEPARATOR)[] = [
  { to: "/intake", label: "Intake", count: "intake" },
  { to: "/check-in", label: "Check-in", count: "checkin" },
  { to: "/tasks", label: "Tasks", glyph: TaskGlyph },
  { to: "/runs", label: "Runs", glyph: RunGlyph },
  { to: "/workflows", label: "Workflows", glyph: WorkflowGlyph },
  SEPARATOR,
  { to: "/fleet", label: "Fleet" },
  { to: "/connections", label: "Connections" },
  { to: "/notifications", label: "Notifications", count: "notifications" },
  { to: "/settings/profile", label: "Settings", section: true },
];

/** The nine Settings screens, in the order the screen lists them. */
export const SETTINGS_NAV: readonly { readonly to: string; readonly label: string }[] = [
  { to: "/settings/profile", label: "Profile" },
  { to: "/settings/threads", label: "Threads" },
  { to: "/settings/assistants", label: "Assistants" },
  { to: "/settings/identities", label: "Identities" },
  { to: "/settings/permission-profiles", label: "Permission profiles" },
  { to: "/settings/secrets", label: "Secrets" },
  { to: "/settings/bounds", label: "Bounds" },
  { to: "/settings/plugins", label: "Plugins" },
  { to: "/settings/system", label: "System" },
];

/**
 * The face a screen shows itself on: Sessions, a thread, and All sessions are
 * the threads side; everything else is orchestration, so the segmented switch
 * is what puts threads back.
 */
export const chooseFaceForPath = (pathname: string): Face =>
  pathname === "/" || pathname === "/sessions" || pathname.startsWith("/threads/")
    ? "threads"
    : "orchestration";
