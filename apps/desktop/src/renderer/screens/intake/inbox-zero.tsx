/**
 * Inbox zero: the picture To do shows when nothing is left on it (spec 17
 * §Motion).
 */
import type { JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  countClearedToday,
  countClearedTodayByPlugin,
  describeInboxZero,
  resolveDisplayTimezone,
} from "@hercule/client-core";
import { useZonedClockValue } from "../../app/age-clock";
import { pluginsQuery, settingsQuery } from "../../app/queries";
import { Face, HERCULE_LOOK } from "../../faces";
import { PluginMark } from "../../marks";
import { useSignalsClearedToday } from "./use-signals-cleared-today";
import "./inbox-zero.css";

declare module "react" {
  interface CSSProperties {
    /** A ray's place in the sunburst, from 0 at the top, clockwise; it sets when the ray grows. */
    "--ray-index"?: number;
    /** The direction a ray or a spark points in, clockwise from the top. */
    "--angle"?: string;
  }
}

/** The sunburst's rays, long and short in turn, clockwise from the top. */
const RAY_COUNT = 24;
/** The sparks that fly out from behind Hercule as it arrives. */
const SPARK_COUNT = 6;

/** Returns when inbox zero's line may next read differently in `timezone`. */
const findNextLineChange = (timezone: string, now: Date): Date =>
  describeInboxZero(now, timezone).changesAt;

/**
 * Renders inbox zero: Hercule in a brass sunburst, "Inbox zero", a line that
 * follows the time of day in the user's timezone setting, and how many
 * signals were cleared today, with a pill per plugin that opens Done on that
 * plugin's tab. With nothing cleared today, the count and the pills are left
 * out.
 *
 * `arriving` plays the arrival once, for when the user's own move emptied To
 * do. Otherwise, and always with Reduce motion, the picture shows still.
 * `onShowDone` is called with a plugin's id when its pill is pressed.
 */
export function InboxZero({
  arriving,
  onShowDone,
}: {
  readonly arriving: boolean;
  readonly onShowDone: (pluginId: string) => void;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const { data: settings } = useSuspenseQuery(settingsQuery(client));
  const { data: plugins } = useSuspenseQuery(pluginsQuery(client));
  const timezone = resolveDisplayTimezone(settings.user.timezone);
  const { signals, now } = useSignalsClearedToday(timezone);
  const line = useZonedClockValue(
    timezone,
    findNextLineChange,
    (clockNow) => describeInboxZero(clockNow, timezone).text,
  );
  const { cleared } = countClearedToday(signals, now, timezone);
  const byPlugin = countClearedTodayByPlugin(signals, now, timezone, plugins);

  return (
    <div className={arriving ? "asks-zero is-arriving" : "asks-zero"}>
      <div className="asks-zero-art" aria-hidden="true">
        {Array.from({ length: RAY_COUNT }, (_, index) => (
          <span
            key={index}
            className={index % 2 === 0 ? "asks-zero-ray" : "asks-zero-ray asks-zero-ray--short"}
            style={{ "--ray-index": index, "--angle": `${String((index * 360) / RAY_COUNT)}deg` }}
          />
        ))}
        {Array.from({ length: SPARK_COUNT }, (_, index) => (
          <span
            key={index}
            className="asks-zero-spark"
            style={{ "--angle": `${String(30 + (index * 360) / SPARK_COUNT)}deg` }}
          />
        ))}
        <span className="asks-zero-face">
          <span className="asks-zero-face-body">
            <Face look={HERCULE_LOOK} pose="done" size={88} />
          </span>
        </span>
      </div>
      <h2 className="asks-zero-h">Inbox zero</h2>
      <p className="asks-zero-line">{line}</p>
      {cleared > 0 && (
        <>
          <p className="asks-zero-n">
            <span className="asks-zero-num">{cleared}</span>cleared today
          </p>
          {byPlugin.length > 0 && (
            <div className="asks-zero-tally">
              {byPlugin.map(({ pluginId, cleared: count }) => {
                const name =
                  plugins.find((plugin) => plugin.id === pluginId)?.displayName ?? pluginId;
                const label = `${String(count)} cleared from ${name}`;
                return (
                  <button
                    key={pluginId}
                    type="button"
                    title={label}
                    aria-label={label}
                    onClick={() => {
                      onShowDone(pluginId);
                    }}
                  >
                    <PluginMark pluginId={pluginId} plugins={plugins} size={14} />
                    {count}
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
