import type { JSX } from "react";
import type { Project } from "@hercule/contract";
import { describeNamingProjects } from "@hercule/client-core/mcp-servers";

/**
 * The "Projects" cell of a server's row: the projects that name it, one or two
 * by name, a count for more, or "None". The tooltip lists every name when the
 * cell shows a count.
 */
export function NamingProjectsCell({
  projects,
}: {
  readonly projects: readonly Project[];
}): JSX.Element {
  const naming = describeNamingProjects(projects);
  return (
    <span
      title={naming.kind === "count" ? naming.tooltip : "Projects that name this server"}
      className="w-[104px] shrink-0 text-fine"
    >
      {naming.kind === "tiles" ? (
        naming.projects.map((project) => (
          <span key={project.id} className="block truncate text-muted">
            {project.name}
          </span>
        ))
      ) : (
        <span className={naming.kind === "none" ? "text-faint" : "text-muted"}>{naming.text}</span>
      )}
    </span>
  );
}
