import { useState, type JSX } from "react";
import {
  buildHeartbeatDay,
  buildHeartbeatSchedule,
  changeHeartbeatInterval,
  formatTimeOfDay,
  listHeartbeatIntervalChoices,
  moveHeartbeatEnd,
  moveHeartbeatStart,
  parseHeartbeatWindow,
  type HeartbeatWindow,
  type HeartbeatWindowEdit,
} from "@hercule/client-core";
import type { Heartbeat } from "@hercule/contract";
import { ChatIcon } from "../../../icons/chat";
import { HeartIcon } from "../../../icons/heart";
import { SettingTextRow } from "../setting-text-row";
import { TimeField } from "./time-field";
import "./schedule.css";

/**
 * Renders an assistant's Heartbeat section (spec 17 §Settings, Assistants):
 * the on and off switch, "Every <n> h from <hh:mm> to <hh:mm> in Web chat",
 * the day's timeline with a tick at each beat and a "now" line at
 * `nowMinutes`, and the prompt the heartbeat sends.
 *
 * Every change calls `onSave` with only the fields it changes. The interval,
 * the start and the end are edited by `changeHeartbeatInterval`,
 * `moveHeartbeatStart` and `moveHeartbeatEnd`, which keep the window ending
 * on a beat and refuse a time it cannot hold. A refused time shows its error
 * under the schedule, and the field shows the saved time again.
 *
 * A schedule that is not an interval and a window, set from the CLI, shows
 * as its cron expression with no timeline. Choosing an interval then
 * replaces it with that interval from 07:00 to 23:00.
 *
 * `unknownTimezone` is the zone the heartbeat or the user asked for when this
 * Mac does not know it, else `null`; `nowTimezone` is the zone `nowMinutes`
 * was read in. A line under the lead then names both, because the "now"
 * line would otherwise sit at the wrong hour with nothing to explain it.
 *
 * `error` is the last failed save's message. A refused time shows in its
 * place until the next change.
 */
export function HeartbeatSection({
  assistantName,
  heartbeat,
  nowMinutes,
  nowTimezone,
  unknownTimezone,
  error,
  onSave,
}: {
  readonly assistantName: string;
  readonly heartbeat: Heartbeat;
  readonly nowMinutes: number;
  readonly nowTimezone: string;
  readonly unknownTimezone: string | null;
  readonly error: string | null;
  readonly onSave: (change: Partial<Heartbeat>) => void;
}): JSX.Element {
  const heartbeatWindow = parseHeartbeatWindow(heartbeat.schedule);
  const [timeError, setTimeError] = useState<string | null>(null);
  const shownError = timeError ?? error;

  const save = (change: Partial<Heartbeat>): void => {
    setTimeError(null);
    onSave(change);
  };

  const saveWindow = (next: HeartbeatWindow): void => {
    const schedule = buildHeartbeatSchedule(next);
    if (schedule === heartbeat.schedule) setTimeError(null);
    else save({ schedule });
  };

  const commitEdit = (edit: HeartbeatWindowEdit): void => {
    if (edit.error === undefined) saveWindow(edit.window);
    else setTimeError(edit.error);
  };

  return (
    <section className="set-sec">
      <h2>
        <HeartIcon size={15} />
        Heartbeat
        <button
          type="button"
          className="toggle"
          role="switch"
          aria-checked={heartbeat.enabled}
          aria-label="Heartbeat"
          onClick={() => {
            save({ enabled: !heartbeat.enabled });
          }}
        />
      </h2>
      <p>{`${assistantName} checks in on a schedule and only writes when something matters.`}</p>
      {/* The controller stores the heartbeat but does not run it yet. Remove
          this line when it does (#94). */}
      <p className="schedule-note">
        Saved, but not run yet: this version of Hercule does not start heartbeats.
      </p>
      {unknownTimezone !== null && (
        <p className="schedule-note">
          {`This Mac does not know the zone ${unknownTimezone}; the timeline shows now in ${nowTimezone}.`}
        </p>
      )}
      <div className="schedule-sentence">
        Every{" "}
        <span className="field field--select">
          <select
            aria-label="Interval"
            value={heartbeatWindow === null ? "" : String(heartbeatWindow.intervalHours)}
            onChange={(event) => {
              saveWindow(changeHeartbeatInterval(heartbeatWindow, Number(event.target.value)));
            }}
          >
            {heartbeatWindow === null && (
              <option value="" disabled>
                Custom
              </option>
            )}
            {listHeartbeatIntervalChoices(heartbeatWindow?.intervalHours ?? null).map((hours) => (
              <option key={hours} value={hours}>
                {hours} h
              </option>
            ))}
          </select>
        </span>
        {heartbeatWindow !== null && (
          <>
            {" "}
            from{" "}
            <TimeField
              label="From"
              value={formatTimeOfDay(heartbeatWindow.fromHour, heartbeatWindow.minute)}
              onCommit={(text) => {
                commitEdit(moveHeartbeatStart(heartbeatWindow, text));
              }}
            />{" "}
            to{" "}
            <TimeField
              label="To"
              value={formatTimeOfDay(heartbeatWindow.toHour, heartbeatWindow.minute)}
              onCommit={(text) => {
                commitEdit(moveHeartbeatEnd(heartbeatWindow, text));
              }}
            />
          </>
        )}{" "}
        in{" "}
        <span className="field field--select">
          <ChatIcon size={13} />
          <select aria-label="Where the heartbeat writes">
            <option value="web">Web chat</option>
          </select>
        </span>
      </div>
      {shownError !== null && (
        <p className="set-err" role="alert">
          {shownError}
        </p>
      )}
      {heartbeatWindow === null ? (
        <p>
          <code className="mono">{heartbeat.schedule}</code> Set outside the app. Choosing an
          interval here replaces it.
        </p>
      ) : (
        <DayTimeline heartbeatWindow={heartbeatWindow} nowMinutes={nowMinutes} />
      )}
      <SettingTextRow
        label="Prompt"
        hint={`What ${assistantName} is told at each heartbeat.`}
        value={heartbeat.prompt}
        error={null}
        onCommit={(prompt) => {
          save({ prompt });
        }}
      />
    </section>
  );
}

/** Converts a share of the day to a CSS percentage. */
function toPercent(fraction: number): string {
  return `${String(fraction * 100)}%`;
}

/**
 * Renders the heartbeat window on a 24-hour day, with its axis: the
 * window's span, or two when it crosses midnight, a tick at each beat, and
 * the "now" line. Nothing moves it until the section draws again.
 */
function DayTimeline({
  heartbeatWindow,
  nowMinutes,
}: {
  readonly heartbeatWindow: HeartbeatWindow;
  readonly nowMinutes: number;
}): JSX.Element {
  const day = buildHeartbeatDay(heartbeatWindow, nowMinutes);
  const from = formatTimeOfDay(heartbeatWindow.fromHour, heartbeatWindow.minute);
  const to = formatTimeOfDay(heartbeatWindow.toHour, heartbeatWindow.minute);
  const now = formatTimeOfDay(Math.floor(nowMinutes / 60), nowMinutes % 60);
  return (
    <>
      <div
        className="heartbeat-day"
        role="img"
        aria-label={`Heartbeat window from ${from} to ${to}, now ${now}`}
      >
        {day.spans.map((span) => (
          <div
            key={span.from}
            className="heartbeat-day-window"
            style={{ left: toPercent(span.from), width: toPercent(span.to - span.from) }}
          />
        ))}
        {day.beats.map((beat) => (
          <i
            key={beat.at}
            className="heartbeat-day-beat"
            data-end={beat.atEnd || undefined}
            style={{ left: toPercent(beat.at) }}
          />
        ))}
        <div className="heartbeat-day-now" style={{ left: toPercent(day.now) }} />
      </div>
      <div className="heartbeat-day-axis" aria-hidden="true">
        {day.labels.map((label) => (
          <span
            key={`${label.text}-${String(label.at)}`}
            style={{ left: toPercent(label.at), transform: label.at === 0 ? "none" : undefined }}
          >
            {label.text === "now" ? <b>now</b> : label.text}
          </span>
        ))}
      </div>
    </>
  );
}
