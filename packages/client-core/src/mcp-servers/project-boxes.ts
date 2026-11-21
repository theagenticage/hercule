/**
 * The Projects section of a server's page: one box for each project, and one
 * for the threads that have no project, each ticked while its list names the
 * server (spec 17, Settings > MCP servers).
 */
import type { Project } from "@hercule/contract";
import type { McpServerView } from "./views";

/** The list a box edits. */
export type ProjectBoxTarget =
  | { readonly kind: "project"; readonly project: Project }
  | { readonly kind: "default" };

/** One box of the Projects section. */
export interface ProjectBox {
  readonly target: ProjectBoxTarget;
  /** Whether the target's list names the server of the page. */
  readonly ticked: boolean;
  /**
   * The other server of the same name that the target's list names, or `null`.
   * A list holds one server of a name, so ticking the box would be refused,
   * and the box offers to swap instead.
   */
  readonly takenBy: McpServerView | null;
}

/**
 * Returns the boxes of `view`'s page: one for each of `projects`, in their
 * order, then one for the threads without a project, which edits the default
 * list `defaultIds`.
 *
 * A box is a picture of the lists as they are now. The write a tick makes is
 * `chooseNamedServer` on the target's list as it is when the user clicks, so
 * a box drawn from an older read never overwrites a newer list.
 */
export const buildProjectBoxes = (
  view: McpServerView,
  views: readonly McpServerView[],
  projects: readonly Project[],
  defaultIds: readonly string[],
): ProjectBox[] => {
  const buildBox = (target: ProjectBoxTarget, ids: readonly string[]): ProjectBox => ({
    target,
    ticked: ids.includes(view.server.id),
    takenBy:
      views.find(
        (other) =>
          other.server.name === view.server.name &&
          other.server.id !== view.server.id &&
          ids.includes(other.server.id),
      ) ?? null,
  });
  return [
    ...projects.map((project) => buildBox({ kind: "project", project }, project.mcpServerIds)),
    buildBox({ kind: "default" }, defaultIds),
  ];
};

/** A piece of a sentence or of a button label: plain text, or text the app draws as a code span. */
export interface TextPart {
  readonly text: string;
  readonly code: boolean;
}

/**
 * The refusal under a box that is ticked while its list names another server
 * of the same name, and its two buttons. Each is a list of parts, so the app
 * draws the code spans.
 */
export interface ProjectRefusal {
  /** Such as "`webshop` already uses `sentry` `work`. One project cannot name both: their tools would get the same names." */
  readonly sentence: readonly TextPart[];
  /** Swaps the other server for the one of the page: "Use `sentry` `hobby`". */
  readonly use: readonly TextPart[];
  /** Closes the refusal and keeps the other server: "Keep `sentry` `work`". */
  readonly keep: readonly TextPart[];
}

const text = (value: string): TextPart => ({ text: value, code: false });
const code = (value: string): TextPart => ({ text: value, code: true });

/** Returns a server as the code spans of a sentence: its name, then its account when it has one. */
const describeServerParts = (view: McpServerView): TextPart[] =>
  view.account === undefined
    ? [code(view.server.name)]
    : [code(view.server.name), text(" "), code(view.account)];

/**
 * Returns the refusal for ticking `box` on the page of `view`, or `null` when
 * nothing blocks it: no other server of that name is named by the box's list.
 * The box of the threads without a project words it as "Threads without a
 * project already use ... One list cannot name both", and a project's box as
 * "`webshop` already uses ... One project cannot name both".
 */
export const describeProjectRefusal = (
  box: ProjectBox,
  view: McpServerView,
): ProjectRefusal | null => {
  if (box.takenBy === null) return null;
  const takenParts = describeServerParts(box.takenBy);
  const sentence =
    box.target.kind === "project"
      ? [
          code(box.target.project.name),
          text(" already uses "),
          ...takenParts,
          text(". One project cannot name both: their tools would get the same names."),
        ]
      : [
          text("Threads without a project already use "),
          ...takenParts,
          text(". One list cannot name both: their tools would get the same names."),
        ];
  return {
    sentence,
    use: [text("Use "), ...describeServerParts(view)],
    keep: [text("Keep "), ...takenParts],
  };
};
