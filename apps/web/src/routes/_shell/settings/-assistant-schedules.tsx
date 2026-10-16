import { useState, type JSX } from "react";
import {
  buildHeartbeatSchedule,
  changeHeartbeatInterval,
  describeConversationChannel,
  findTimeOfDayError,
  formatContextFraction,
  formatTimeOfDay,
  formatTokenLimit,
  listContextFractionChoices,
  listContextTokenChoices,
  listHeartbeatIntervalChoices,
  moveHeartbeatEnd,
  moveHeartbeatStart,
  parseHeartbeatWindow,
  type AssistantDraft,
  type HeartbeatWindowEdit,
} from "@hercule/client-core";
import type { HeartbeatTarget, Rotation } from "@hercule/contract";
import { Checkbox, FormCard, Input, Row, Select, Textarea } from "@hercule/ui";

/** The id of the element that shows the error of a refused time, for `aria-describedby`. */
const TIME_ERROR_ID = "heartbeat-time-error";

/** The places a heartbeat can write, and the words the select shows for them. */
const HEARTBEAT_TARGETS: ReadonlyArray<{
  readonly value: HeartbeatTarget;
  readonly label: string;
}> = [
  { value: "web", label: describeConversationChannel("web") },
  { value: "most-recent", label: "Most recent conversation" },
];

/**
 * Renders a time of day in a small text field, such as "07:00".
 *
 * The text typed is kept in the field until the user leaves it or presses
 * Enter. Then `onCommit` receives it without the spaces around it, and the
 * field shows `value` again: the stored time, or the new one once the caller
 * has taken it, so a time the caller refuses reverts on its own. Escape
 * drops the typed text. Enter commits here instead of submitting the form,
 * because the form's Save is for the whole assistant.
 *
 * `id` lets a `Row` label point at the field. When `errorId` is set, the
 * field is marked invalid and described by the element with that id, which
 * the caller renders with the error it refused the time for.
 */
function TimeInput({
  id,
  label,
  value,
  errorId,
  onCommit,
}: {
  readonly id: string;
  /** Names the field when no visible label points at it. */
  readonly label?: string;
  readonly value: string;
  readonly errorId?: string | undefined;
  readonly onCommit: (text: string) => void;
}): JSX.Element {
  // The text being typed, or null while the field shows `value`.
  const [typed, setTyped] = useState<string | null>(null);
  const commitTypedTime = (): void => {
    if (typed === null) return;
    setTyped(null);
    if (typed.trim() !== value) onCommit(typed.trim());
  };
  return (
    <Input
      id={id}
      aria-label={label}
      aria-invalid={errorId === undefined ? undefined : true}
      aria-describedby={errorId}
      className="w-20 font-mono tabular-nums"
      inputMode="numeric"
      spellCheck={false}
      value={typed ?? value}
      onChange={(event) => {
        setTyped(event.target.value);
      }}
      onBlur={commitTypedTime}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setTyped(null);
        } else if (event.key === "Enter") {
          event.preventDefault();
          commitTypedTime();
        }
      }}
    />
  );
}

/** Renders the error of a refused time under its field, inside the control column. */
function TimeError({
  id,
  message,
}: {
  readonly id: string;
  readonly message: string;
}): JSX.Element {
  return (
    <p id={id} className="text-fine text-fail" role="alert">
      {message}
    </p>
  );
}

/**
 * Renders the Heartbeat card: whether the assistant checks in on a schedule,
 * how often and when, where it writes, and what it is told.
 *
 * - The schedule is stored as a cron expression. When it is an interval and a
 *   window of hours, it is edited as such, by the client-core functions that
 *   keep the window ending on a beat. A time they refuse shows its error
 *   under the fields, and the field shows the stored time again.
 * - A schedule that is not a window, set from the CLI, shows as its cron
 *   expression. Choosing an interval replaces it with that interval from
 *   07:00 to 23:00.
 * - `timezone` is the zone the schedule is read in, named in the fine print.
 */
export function HeartbeatCard({
  assistantName,
  draft,
  timezone,
  onChange,
}: {
  readonly assistantName: string;
  readonly draft: AssistantDraft;
  readonly timezone: string;
  readonly onChange: (fields: Partial<AssistantDraft>) => void;
}): JSX.Element {
  const heartbeatWindow = parseHeartbeatWindow(draft.heartbeatSchedule);
  const [timeError, setTimeError] = useState<string | null>(null);

  const changeSchedule = (schedule: string): void => {
    setTimeError(null);
    onChange({ heartbeatSchedule: schedule });
  };
  const commitEdit = (edit: HeartbeatWindowEdit): void => {
    if (edit.error === undefined) changeSchedule(buildHeartbeatSchedule(edit.window));
    else setTimeError(edit.error);
  };

  const describeSchedule =
    heartbeatWindow === null
      ? `on its own schedule`
      : `every ${String(heartbeatWindow.intervalHours)} h, from ${formatTimeOfDay(heartbeatWindow.fromHour, heartbeatWindow.minute)} to ${formatTimeOfDay(heartbeatWindow.toHour, heartbeatWindow.minute)}`;

  return (
    <FormCard
      label="Heartbeat"
      fine={`${assistantName} checks in ${describeSchedule} (${timezone}) and only writes when something matters.`}
    >
      <Row label="Enabled">
        <Checkbox
          label="Check in on a schedule"
          checked={draft.heartbeatEnabled}
          onChange={(event) => {
            onChange({ heartbeatEnabled: event.target.checked });
          }}
        />
      </Row>
      {/* The fields stay editable while the heartbeat is off, so a schedule
          can be set before it is switched on; they are only dimmed. */}
      <div className={`flex flex-col gap-2 ${draft.heartbeatEnabled ? "" : "opacity-50"}`}>
        <Row label="Every" htmlFor="heartbeat-interval">
          <Select
            id="heartbeat-interval"
            value={heartbeatWindow === null ? "" : String(heartbeatWindow.intervalHours)}
            onChange={(event) => {
              changeSchedule(
                buildHeartbeatSchedule(
                  changeHeartbeatInterval(heartbeatWindow, Number(event.target.value)),
                ),
              );
            }}
          >
            {heartbeatWindow === null && (
              <option value="" disabled>
                Custom
              </option>
            )}
            {listHeartbeatIntervalChoices(heartbeatWindow?.intervalHours ?? null).map((hours) => (
              <option key={hours} value={hours}>
                {`${String(hours)} h`}
              </option>
            ))}
          </Select>
        </Row>
        {heartbeatWindow === null ? (
          <Row label="Schedule">
            <div className="flex flex-col gap-1">
              <code className="font-mono text-row text-ink">{draft.heartbeatSchedule}</code>
              <p className="text-fine text-muted">
                Set outside the app. Choosing an interval here replaces it.
              </p>
            </div>
          </Row>
        ) : (
          <Row label="Window" htmlFor="heartbeat-from">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2 text-row text-muted">
                <TimeInput
                  id="heartbeat-from"
                  label="From"
                  value={formatTimeOfDay(heartbeatWindow.fromHour, heartbeatWindow.minute)}
                  errorId={timeError === null ? undefined : TIME_ERROR_ID}
                  onCommit={(text) => {
                    commitEdit(moveHeartbeatStart(heartbeatWindow, text));
                  }}
                />
                to
                <TimeInput
                  id="heartbeat-to"
                  label="To"
                  value={formatTimeOfDay(heartbeatWindow.toHour, heartbeatWindow.minute)}
                  errorId={timeError === null ? undefined : TIME_ERROR_ID}
                  onCommit={(text) => {
                    commitEdit(moveHeartbeatEnd(heartbeatWindow, text));
                  }}
                />
              </div>
              {timeError === null ? null : <TimeError id={TIME_ERROR_ID} message={timeError} />}
            </div>
          </Row>
        )}
        <Row label="Writes to" htmlFor="heartbeat-target">
          <Select
            id="heartbeat-target"
            value={draft.heartbeatTarget}
            onChange={(event) => {
              onChange({ heartbeatTarget: event.target.value as HeartbeatTarget });
            }}
          >
            {HEARTBEAT_TARGETS.map((target) => (
              <option key={target.value} value={target.value}>
                {target.label}
              </option>
            ))}
          </Select>
        </Row>
        <Row label="Prompt" htmlFor="heartbeat-prompt">
          <Textarea
            id="heartbeat-prompt"
            rows={6}
            value={draft.heartbeatPrompt}
            onChange={(event) => {
              onChange({ heartbeatPrompt: event.target.value });
            }}
          />
        </Row>
      </div>
    </FormCard>
  );
}

/**
 * Renders the Rotation card: when the assistant's conversation moves on to a
 * fresh session, by how full the context is and by the time of day.
 *
 * A daily time that is not a time shows its error under the fields, and the
 * field shows the stored time again. `timezone` is the zone the daily time
 * is read in, named in the fine print.
 */
export function RotationCard({
  assistantName,
  storedRotation,
  draft,
  timezone,
  onChange,
}: {
  readonly assistantName: string;
  /** The saved rotation, whose current values the choices always include. */
  readonly storedRotation: Rotation;
  readonly draft: AssistantDraft;
  readonly timezone: string;
  readonly onChange: (fields: Partial<AssistantDraft>) => void;
}): JSX.Element {
  const [timeError, setTimeError] = useState<string | null>(null);
  return (
    <FormCard
      label="Rotation"
      fine={`${assistantName} starts a fresh session when the context gets too full, and every day at ${draft.rotationDailyAt} (${timezone}). What it learned stays in its memory.`}
    >
      <Row label="Context share" htmlFor="rotation-fraction">
        <Select
          id="rotation-fraction"
          value={String(draft.rotationContextFraction)}
          onChange={(event) => {
            onChange({ rotationContextFraction: Number(event.target.value) });
          }}
        >
          {listContextFractionChoices(storedRotation.contextFraction).map((fraction) => (
            <option key={fraction} value={fraction}>
              {formatContextFraction(fraction)}
            </option>
          ))}
        </Select>
      </Row>
      <Row label="Token limit" htmlFor="rotation-tokens">
        <Select
          id="rotation-tokens"
          value={String(draft.rotationMaxContextTokens)}
          onChange={(event) => {
            onChange({ rotationMaxContextTokens: Number(event.target.value) });
          }}
        >
          {listContextTokenChoices(storedRotation.maxContextTokens).map((tokens) => (
            <option key={tokens} value={tokens}>
              {`${formatTokenLimit(tokens)} tokens`}
            </option>
          ))}
        </Select>
      </Row>
      <Row label="Daily at" htmlFor="rotation-daily-at">
        <div className="flex flex-col gap-1">
          <TimeInput
            id="rotation-daily-at"
            value={draft.rotationDailyAt}
            errorId={timeError === null ? undefined : "rotation-time-error"}
            onCommit={(text) => {
              const error = findTimeOfDayError(text);
              setTimeError(error);
              if (error === null) onChange({ rotationDailyAt: text });
            }}
          />
          {timeError === null ? null : <TimeError id="rotation-time-error" message={timeError} />}
        </div>
      </Row>
    </FormCard>
  );
}
