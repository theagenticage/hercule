/**
 * The Projects section of a server's page: one box for each project, and one
 * for the threads that have no project, each ticked while its list names the
 * server (spec 17, Settings > MCP servers).
 */
import type { Project } from "@hercule/contract";
import { formatNameList } from "../name-list";
import { chooseNamedServer, findOtherOccupant, type NamedServer } from "./named-lists";
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
 * A box is a picture of the lists as they are now. The write a click makes is
 * decided by `decideProjectBoxWrite` on the target's list as it is when the
 * user clicks, so a box drawn from an older read never overwrites a newer
 * list.
 */
export const buildProjectBoxes = (
  view: McpServerView,
  views: readonly McpServerView[],
  projects: readonly Project[],
  defaultIds: readonly string[],
): ProjectBox[] => {
  const servers = views.map((each) => each.server);
  const buildBox = (target: ProjectBoxTarget, ids: readonly string[]): ProjectBox => {
    const occupantId = findOtherOccupant(ids, servers, view.server.name, [view.server.id]);
    return {
      target,
      ticked: ids.includes(view.server.id),
      takenBy: views.find((each) => each.server.id === occupantId) ?? null,
    };
  };
  return [
    ...projects.map((project) => buildBox({ kind: "project", project }, project.mcpServerIds)),
    buildBox({ kind: "default" }, defaultIds),
  ];
};

/** Returns how many of the boxes are ticked, such as "2 of 5", for the heading of the Projects section. */
export const describeTickedBoxes = (boxes: readonly ProjectBox[]): string =>
  `${String(boxes.filter((box) => box.ticked).length)} of ${String(boxes.length)}`;

/** The words of the question asked before a server is removed. */
export interface ServerRemovalWording {
  /** Which lists name the server, such as "webshop and threads without a project name it." */
  readonly naming: string;
  /** What the removal does to every list. */
  readonly effect: string;
}

/**
 * Returns the words of the removal question for the server `serverId`: which
 * of `projects` name it, and whether the default list `defaultIds` does. The
 * default list is the list of the threads without a project, and is named as
 * such. The two parts are meant to be drawn one after the other.
 */
export const describeServerRemoval = (
  serverId: string,
  projects: readonly Project[],
  defaultIds: readonly string[],
): ServerRemovalWording => {
  const names = [
    ...projects.filter((project) => project.mcpServerIds.includes(serverId)).map((p) => p.name),
    ...(defaultIds.includes(serverId) ? ["threads without a project"] : []),
  ];
  return {
    naming:
      names.length === 0
        ? "No project names it."
        : `${formatNameList(names, "and")} ${names.length === 1 ? "names" : "name"} it.`,
    effect:
      "Every project's list and every thread's list drops it, and a running thread loses its tools at once.",
  };
};

/** What a click on a box asks for, on the page of one server. */
export type ProjectBoxAction =
  /** Switches the page's server on. */
  | "tick"
  /** Switches the page's server off. */
  | "untick"
  /** Replaces `swapFrom`, the other server of the same name the user confirmed, with the page's server. */
  | { readonly swapFrom: string };

/** What `decideProjectBoxWrite` decided. */
export type ProjectBoxWrite =
  | { readonly kind: "write"; readonly mcpServerIds: readonly string[] }
  | {
      readonly kind: "refused";
      /** The id of the other server of the same name that the list holds now. */
      readonly occupantId: string;
    };

/**
 * Returns the write for a click on a box, decided on `currentIds`, the
 * target's list as it is at the moment of the click, and on the ids and names
 * of `servers`:
 *
 * - `"tick"` writes the list with `server`, or is refused with the server of
 *   the same name that the list already names;
 * - `"untick"` writes the list without `server`, and touches nothing else. It
 *   goes by the id alone, because the box shows that one server;
 * - `{ swapFrom }` writes the swap only while the list's server of that name
 *   is still `swapFrom`. When the list names another one now, it is refused
 *   with that one, because the user confirmed a swap for a different server.
 *   A list with none of that name left is written like a tick.
 *
 * The list is never decided from a read made when the box was drawn, so a
 * list changed meanwhile is neither overwritten nor swapped blindly.
 */
export const decideProjectBoxWrite = (
  currentIds: readonly string[],
  servers: readonly NamedServer[],
  server: NamedServer,
  action: ProjectBoxAction,
): ProjectBoxWrite => {
  if (action === "untick") {
    return { kind: "write", mcpServerIds: currentIds.filter((id) => id !== server.id) };
  }
  const expectedIds = action === "tick" ? [server.id] : [server.id, action.swapFrom];
  const occupantId = findOtherOccupant(currentIds, servers, server.name, expectedIds);
  if (occupantId !== undefined) return { kind: "refused", occupantId };
  return {
    kind: "write",
    mcpServerIds: chooseNamedServer(currentIds, servers, server.name, server.id),
  };
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

const buildTextPart = (value: string): TextPart => ({ text: value, code: false });
const buildCodePart = (value: string): TextPart => ({ text: value, code: true });

/** Returns a server as the code spans of a sentence: its name, then its account when it has one. */
const describeServerParts = (view: McpServerView): TextPart[] =>
  view.account === undefined
    ? [buildCodePart(view.server.name)]
    : [buildCodePart(view.server.name), buildTextPart(" "), buildCodePart(view.account)];

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
          buildCodePart(box.target.project.name),
          buildTextPart(" already uses "),
          ...takenParts,
          buildTextPart(". One project cannot name both: their tools would get the same names."),
        ]
      : [
          buildTextPart("Threads without a project already use "),
          ...takenParts,
          buildTextPart(". One list cannot name both: their tools would get the same names."),
        ];
  return {
    sentence,
    use: [buildTextPart("Use "), ...describeServerParts(view)],
    keep: [buildTextPart("Keep "), ...takenParts],
  };
};
