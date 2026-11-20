/**
 * PROTOTYPE, throwaway. A copy of the Settings frame and its list, with one
 * more row: MCP servers. The real frame's rows are router links, and the
 * prototype has no router, so the rows here are buttons with the same looks.
 * Only MCP servers and Connections lead anywhere.
 */
import type { JSX, ReactNode } from "react";
import { BoundIcon } from "../../icons/bound";
import { ConnectionsIcon } from "../../icons/connections";
import { CpuIcon } from "../../icons/cpu";
import { CrewIcon } from "../../icons/crew";
import { FleetIcon } from "../../icons/fleet";
import type { IconProps } from "../../icons/icon-frame";
import { IdIcon } from "../../icons/id";
import { IntakeIcon } from "../../icons/intake";
import { KeyIcon } from "../../icons/key";
import { PaletteIcon } from "../../icons/palette";
import { PuzzleIcon } from "../../icons/puzzle";
import { ShieldIcon } from "../../icons/shield";
import { SkillIcon } from "../../icons/skill";
import { SystemIcon } from "../../icons/system";
import { ThreadsIcon } from "../../icons/threads";
import { UserIcon } from "../../icons/user";
import { ToolsIcon } from "./parts";

export type SettingsPage = "servers" | "connections";

interface Row {
  readonly label: string;
  readonly Icon: (props: IconProps) => JSX.Element;
  readonly page?: SettingsPage;
}

const GROUPS: ReadonlyArray<{ readonly heading: string; readonly rows: readonly Row[] }> = [
  {
    heading: "You",
    rows: [
      { label: "Profile", Icon: UserIcon },
      { label: "Appearance", Icon: PaletteIcon },
      { label: "Threads", Icon: ThreadsIcon },
      { label: "Intake", Icon: IntakeIcon },
    ],
  },
  {
    heading: "Crew",
    rows: [
      { label: "Assistants", Icon: CrewIcon },
      { label: "Skills", Icon: SkillIcon },
      { label: "MCP servers", Icon: ToolsIcon, page: "servers" },
      { label: "Connections", Icon: ConnectionsIcon, page: "connections" },
      { label: "Providers", Icon: CpuIcon },
      { label: "Machines", Icon: FleetIcon },
    ],
  },
  {
    heading: "Safety",
    rows: [
      { label: "Identities", Icon: IdIcon },
      { label: "Permission profiles", Icon: ShieldIcon },
      { label: "Secrets", Icon: KeyIcon },
      { label: "Bounds", Icon: BoundIcon },
    ],
  },
  {
    heading: "System",
    rows: [
      { label: "Plugins", Icon: PuzzleIcon },
      { label: "System", Icon: SystemIcon },
    ],
  },
];

/**
 * Renders Settings in the main pane: the header with the crumb, the title and
 * `actions`, then the Settings list beside `children`. `parent`, when given,
 * is the list the open record belongs to, drawn in the crumb as a link.
 * `dots` names the pages whose row carries the red dot.
 */
export function SettingsFrame({
  page,
  title,
  parent,
  actions,
  dots,
  onPage,
  children,
}: {
  readonly page: SettingsPage;
  readonly title: string;
  readonly parent?: { readonly title: string; readonly onOpen: () => void } | undefined;
  readonly actions?: ReactNode;
  readonly dots: ReadonlySet<SettingsPage>;
  readonly onPage: (page: SettingsPage) => void;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <>
      <header className="bar">
        <span className="crumb">
          Settings /
          {parent !== undefined && (
            <>
              {" "}
              <a
                href="#"
                onClick={(event) => {
                  event.preventDefault();
                  parent.onOpen();
                }}
              >
                {parent.title}
              </a>
              {" /"}
            </>
          )}
        </span>
        <h1 className="title">{title}</h1>
        <span className="spacer" />
        <div className="bar-actions">{actions}</div>
      </header>
      <div className="settings">
        <nav className="set-nav" aria-label="Settings">
          {GROUPS.map((group) => (
            <section key={group.heading} className="side-sec">
              <h3 className="side-h">
                <span>{group.heading}</span>
              </h3>
              {group.rows.map(({ label, Icon, page: to }) => (
                <button
                  key={label}
                  type="button"
                  className={to === page ? "nav-row is-on" : "nav-row"}
                  title={to === undefined ? "Not part of this prototype" : undefined}
                  onClick={() => {
                    if (to !== undefined) onPage(to);
                  }}
                >
                  <Icon />
                  <span>{label}</span>
                  {to !== undefined && dots.has(to) && (
                    <i className="dot dot--fail" role="img" aria-label="Needs attention" />
                  )}
                </button>
              ))}
            </section>
          ))}
        </nav>
        <div className="set-body">
          <div className="set-col">{children}</div>
        </div>
      </div>
    </>
  );
}
