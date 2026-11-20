/**
 * PROTOTYPE, throwaway. The management screens of MCP servers in the desktop
 * app, for Rogier to choose from before anything is built. Start it with
 * `pnpm --filter @hercule/desktop prototype:mcp`.
 *
 * One page, five scenes (`?scene=`). Rogier has chosen between the variants
 * of every scene, so each scene now has one drawing:
 *
 * - `servers`: Settings > MCP servers, one list with switches, and a server's page;
 * - `connections`: a Connection says that it offers agent tools, and leads to MCP servers;
 * - `add`: adding a server by URL, with the sign-in the server asks for;
 * - `project`: a server's page, where the projects that name it are ticked;
 * - `thread`: a thread's own servers, under the composer's plus.
 *
 * `np=default|none` says what a thread with no project starts with,
 * `size=large` draws 15 servers and 10 projects, and `bar=off` hides the
 * prototype's own panel and strips.
 *
 * The page mounts a real specimen for the shell and the sidebar: Settings >
 * Connections for the first four scenes, whose main pane it replaces, and a
 * thread or a Draft Thread for the last. Nothing is read from or written to a
 * controller.
 */
import "../fixed-clock";
import type { JSX } from "react";
import { createRoot } from "react-dom/client";
import {
  CONNECTIONS_SETTINGS_RECORDS,
  CONNECTIONS_SIDEBAR_RECORDS,
} from "../settings-connections-fixture";
import { mountConnectionsSettingsSpecimen } from "../shell-page";
import "../../screens/settings/permission-profiles/permission-profiles.css";
import "../../screens/settings/skills/skills.css";
import "../../screens/thread/menus.css";
import "./prototype.css";
import {
  readParam,
  reloadWithParams,
  Switcher,
  useParam,
  writeParams,
  type Knob,
  type SceneEntry,
} from "./parts";
import { SettingsApp } from "./settings-app";
import { mountThreadScene, ThreadApp, THREAD_KNOBS } from "./thread-scene";
import { forceStatus, SERVER_STATUSES, useWorld, type ServerStatus } from "./world";

const SCENES: readonly SceneEntry[] = [
  { id: "servers", name: "MCP servers" },
  { id: "connections", name: "Connections" },
  { id: "add", name: "Add by URL" },
  { id: "project", name: "Project" },
  { id: "thread", name: "Thread" },
];

const scene = SCENES.some((each) => each.id === readParam("scene", ""))
  ? readParam("scene", "")
  : "servers";

/** The server whose page the Project scene opens: one of two servers named `sentry`. */
const PROJECT_SCENE_SERVER = "s-sentry-hobby";

function Bar(): JSX.Element {
  const w = useWorld();
  const np = useParam("np", "default");
  const openId = useParam("open", "");
  const page = useParam("page", "servers");
  const open =
    scene !== "thread" && page === "servers"
      ? w.servers.find((each) => each.id === openId)
      : undefined;
  const knobs: Knob[] = [
    {
      label: "No project:",
      value: np,
      options: [
        { value: "default", label: "a default list" },
        { value: "none", label: "no servers" },
      ],
      onChange: (value) => {
        if (scene === "thread") reloadWithParams({ np: value });
        else writeParams({ np: value });
      },
    },
    {
      label: "Size:",
      value: readParam("size", "small"),
      options: [
        { value: "small", label: "7 servers, 3 projects" },
        { value: "large", label: "15 servers, 10 projects" },
      ],
      onChange: (value) => {
        // The world is built when the page loads.
        reloadWithParams({ size: value });
      },
    },
    ...(open === undefined
      ? []
      : [
          {
            label: "Status:",
            value: open.status,
            options: SERVER_STATUSES.map((status) => ({ value: status, label: status })),
            onChange: (value: string) => {
              forceStatus(open.id, value as ServerStatus);
            },
          },
        ]),
    ...(scene === "thread" ? THREAD_KNOBS() : []),
  ];
  return (
    <Switcher
      scenes={SCENES}
      scene={scene}
      onScene={(id) => {
        // Each scene starts from its own page, so the page loads again.
        reloadWithParams({
          scene: id,
          page: null,
          open: id === "project" ? PROJECT_SCENE_SERVER : null,
        });
      }}
      variants={[]}
      variant=""
      onVariant={() => undefined}
      knobs={knobs}
    />
  );
}

/**
 * Whether the page draws what is not part of the design: the panel that
 * switches scene, and the dashed strips inside dialogs. `?bar=off` hides
 * both, for a screenshot of the design alone.
 */
const showsBar = readParam("bar", "on") !== "off";
if (!showsBar) document.documentElement.dataset.pmBar = "off";

/** Appends a new element to `parent` and draws `app` and the bar in it. */
const drawIn = (parent: Element, className: string, app: JSX.Element): void => {
  const host = document.createElement("div");
  host.className = className;
  parent.appendChild(host);
  createRoot(host).render(
    <>
      {app}
      {import.meta.env.DEV && showsBar ? <Bar /> : null}
    </>,
  );
};

if (scene === "thread") {
  await mountThreadScene();
  drawIn(document.body, "pm-layer", <ThreadApp />);
} else {
  await mountConnectionsSettingsSpecimen(CONNECTIONS_SIDEBAR_RECORDS, CONNECTIONS_SETTINGS_RECORDS);
  const main = document.querySelector<HTMLElement>("main.main");
  if (main === null) throw new Error("The Settings specimen drew no main pane.");
  for (const child of main.children) (child as HTMLElement).style.display = "none";
  drawIn(main, "pm-host", <SettingsApp />);
}
