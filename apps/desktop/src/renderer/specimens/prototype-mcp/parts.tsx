/**
 * PROTOTYPE, throwaway. The pieces every scene of the MCP prototype shares:
 * the page's URL parameters, the marks, a server's status line, the switch,
 * and the bar at the bottom that switches scene and variant.
 */
import { useEffect, useSyncExternalStore, type JSX, type ReactNode } from "react";
import { ChevronLeftIcon } from "../../icons/chevron-left";
import { ChevronRightIcon } from "../../icons/chevron-right";
import { IconFrame, type IconProps } from "../../icons/icon-frame";
import { PluginMark } from "../../marks/plugin-mark";
import { CONNECTIONS_SETTINGS_RECORDS } from "../settings-connections-fixture";
import type { Conn, Server, ServerStatus, World } from "./world";
import { findServerConnection } from "./world";

// ---------- The page's URL parameters ----------

const paramListeners = new Set<() => void>();

/** Returns the URL parameter `key`, or `fallback`. */
export const readParam = (key: string, fallback: string): string =>
  new URLSearchParams(location.search).get(key) ?? fallback;

/** Sets URL parameters without loading the page again, and redraws every reader. A null value removes one. */
export function writeParams(changes: Readonly<Record<string, string | null>>): void {
  const next = new URLSearchParams(location.search);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) next.delete(key);
    else next.set(key, value);
  }
  history.replaceState(null, "", `${location.pathname}?${next.toString()}`);
  for (const listener of paramListeners) listener();
}

/** Sets URL parameters and loads the page again, for a change that needs another screen of the app mounted. */
export function reloadWithParams(changes: Readonly<Record<string, string | null>>): void {
  const next = new URLSearchParams(location.search);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) next.delete(key);
    else next.set(key, value);
  }
  location.search = next.toString();
}

/** Returns the URL parameter `key`, and redraws the component when `writeParams` changes it. */
export function useParam(key: string, fallback: string): string {
  return useSyncExternalStore(
    (listener) => {
      paramListeners.add(listener);
      return () => paramListeners.delete(listener);
    },
    () => readParam(key, fallback),
  );
}

// ---------- Marks ----------

/** Linear's mark (Simple Icons, CC0), on its own 24-unit grid. */
const LINEAR_PATH =
  "M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z";

/** Draws a plugin's mark. Linear has no plugin in the fixtures, so its mark is drawn here. */
export function PluginGlyph({
  pluginId,
  size = 16,
}: {
  readonly pluginId: string;
  readonly size?: number;
}): JSX.Element {
  if (pluginId === "linear") {
    const drawn = Math.round(size * 0.9);
    return (
      <svg
        className="br"
        viewBox="0 0 24 24"
        width={drawn}
        height={drawn}
        fill="currentColor"
        aria-hidden="true"
      >
        <path d={LINEAR_PATH} />
      </svg>
    );
  }
  return (
    <PluginMark pluginId={pluginId} plugins={CONNECTIONS_SETTINGS_RECORDS.plugins} size={size} />
  );
}

/**
 * Renders the tools icon: a wrench, for the tools an MCP server gives agents.
 * The Bureau book drew no such icon, so this one was drawn for this prototype.
 * MCP servers used the server icon before, which is also how Machines are drawn.
 */
export function ToolsIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M11.38 2.57L9.11 4.84a.6.6 0 0 0 0 .84l1.21 1.21a.6.6 0 0 0 .84 0l2.27-2.27a3.7 3.7 0 0 1-4.81 4.81l-3.75 3.75a1.45 1.45 0 0 1-2.05-2.05l3.75-3.75a3.7 3.7 0 0 1 4.81-4.81z" />
    </IconFrame>
  );
}

/** Draws a server's mark: its plugin's, or the tools icon for one added by URL. */
export function ServerMark({
  server,
  size = 16,
}: {
  readonly server: Server;
  readonly size?: number;
}): JSX.Element {
  return server.source.kind === "plugin" ? (
    <PluginGlyph pluginId={server.source.pluginId} size={size} />
  ) : (
    <ToolsIcon size={size} />
  );
}

/**
 * Draws a server the way every screen writes one: its name, then its account
 * in muted type. `account` is the label of the Connection the server is
 * reached with, such as `hobby`. A server added by URL has none, and shows
 * its name alone.
 */
export function ServerName({
  name,
  account,
}: {
  readonly name: string;
  readonly account: string | undefined;
}): JSX.Element {
  return (
    <span className="pm-server-name">
      <b>{name}</b>
      {account !== undefined && <span className="pm-server-account">{account}</span>}
    </span>
  );
}

export function ConnMark({
  connection,
  size = 16,
}: {
  readonly connection: Conn;
  readonly size?: number;
}): JSX.Element {
  return <PluginGlyph pluginId={connection.pluginId} size={size} />;
}

// ---------- Status ----------

const STATUS_WORDS: Readonly<Record<ServerStatus, string>> = {
  ready: "ready",
  checking: "checking",
  "needs-sign-in": "needs sign-in",
  unreachable: "unreachable",
  disabled: "off",
};

export const describeStatus = (status: ServerStatus): string => STATUS_WORDS[status];

export const isFailing = (status: ServerStatus): boolean =>
  status === "needs-sign-in" || status === "unreachable";

/** Draws a server's status as a table's health cell does: quiet when fine, a red dot when not. */
export function StatusText({ server }: { readonly server: Server }): JSX.Element {
  const { status } = server;
  if (status === "checking") {
    return (
      <span className="pm-status">
        <span className="spin" />
        checking
      </span>
    );
  }
  if (isFailing(status)) {
    return (
      <span className="pm-status pm-status--fail" title={server.statusDetail ?? undefined}>
        <i className="dot dot--fail" />
        {STATUS_WORDS[status]}
      </span>
    );
  }
  return (
    <span className={status === "disabled" ? "pm-status pm-status--off" : "pm-status"}>
      {STATUS_WORDS[status]}
    </span>
  );
}

/**
 * Returns what the user is asked to do about a server that is not ready, and
 * the label of the button that does it. Returns null for a server that needs
 * nothing from the user. The label is the one the Sign-in or Connection row
 * of the server's page uses, so one action has one name.
 */
export const describeFix = (
  w: World,
  server: Server,
): { readonly text: string; readonly action: string } | null => {
  const connection = findServerConnection(w, server);
  if (server.status === "needs-sign-in") {
    if (connection !== undefined) {
      return {
        text: `Reconnect ${connection.typeName} · ${connection.label} in your browser, and this server comes back with it.`,
        action: "Reconnect…",
      };
    }
    if (server.source.kind === "user" && server.source.signIn === "token") {
      return {
        text: "Paste a new token, once, and every runner has it back.",
        action: "Replace token…",
      };
    }
    return {
      text: "Sign in again in your browser, once, and every runner has it back.",
      action: "Sign in again…",
    };
  }
  if (server.status === "unreachable") {
    return {
      text: "Hercule tries again every 5 minutes. Threads that start meanwhile do not get this server, and say so.",
      action: "Check now",
    };
  }
  return null;
};

// ---------- Controls ----------

export function Toggle({
  on,
  label,
  onChange,
}: {
  readonly on: boolean;
  readonly label: string;
  readonly onChange: (on: boolean) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className="toggle"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onChange(!on);
      }}
    />
  );
}

// ---------- The bar that switches scene and variant ----------

export interface VariantEntry {
  readonly key: string;
  readonly name: string;
}

export interface Knob {
  readonly label: string;
  readonly value: string;
  readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly onChange: (value: string) => void;
}

export interface SceneEntry {
  readonly id: string;
  readonly name: string;
}

/**
 * The floating bar at the bottom of the page. It is not part of any design:
 * it picks the scene, steps through the scene's variants with its arrows or
 * the arrow keys, and holds the scene's knobs.
 */
export function Switcher({
  scenes,
  scene,
  onScene,
  variants,
  variant,
  onVariant,
  knobs,
  note,
}: {
  readonly scenes: readonly SceneEntry[];
  readonly scene: string;
  readonly onScene: (id: string) => void;
  readonly variants: readonly VariantEntry[];
  readonly variant: string;
  readonly onVariant: (key: string) => void;
  readonly knobs: readonly Knob[];
  readonly note?: ReactNode;
}): JSX.Element {
  const at = Math.max(
    0,
    variants.findIndex((each) => each.key === variant),
  );
  const step = (by: number): void => {
    if (variants.length < 2) return;
    onVariant(variants[(at + by + variants.length) % variants.length]!.key);
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable], dialog") != null) return;
      if (event.key === "ArrowLeft") step(-1);
      if (event.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  });
  const current = variants[at];
  return (
    <div className="pm-switcher" role="toolbar" aria-label="Prototype">
      <span className="pm-switcher-tag">Prototype</span>
      <div className="pm-switcher-scenes">
        {scenes.map((each) => (
          <button
            key={each.id}
            type="button"
            aria-pressed={each.id === scene}
            onClick={() => {
              onScene(each.id);
            }}
          >
            {each.name}
          </button>
        ))}
      </div>
      {current !== undefined && (
        <div className="pm-switcher-variant">
          <button
            type="button"
            aria-label="Previous variant"
            disabled={variants.length < 2}
            onClick={() => {
              step(-1);
            }}
          >
            <ChevronLeftIcon size={14} />
          </button>
          <span>
            <b>{current.key}</b> {current.name}
          </span>
          <button
            type="button"
            aria-label="Next variant"
            disabled={variants.length < 2}
            onClick={() => {
              step(1);
            }}
          >
            <ChevronRightIcon size={14} />
          </button>
        </div>
      )}
      {knobs.map((knob) => (
        <label key={knob.label} className="pm-switcher-knob">
          {knob.label}
          <select
            value={knob.value}
            onChange={(event) => {
              knob.onChange(event.target.value);
            }}
          >
            {knob.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      ))}
      {note}
    </div>
  );
}
