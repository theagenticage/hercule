import { useState, type JSX } from "react";
import {
  buildHeartbeatSchedule,
  changeHeartbeatInterval,
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
import type { Assistant, HeartbeatTarget } from "@hercule/contract";
import { Checkbox, FormCard, Input, Row, Select, Textarea } from "@hercule/ui";

/** The places a heartbeat can write, and the words the select shows for them. */
const HEARTBEAT_TARGETS: ReadonlyArray<{
  readonly value: HeartbeatTarget;
  readonly label: string;
}> = [
  { value: "web", label: "Web chat" },
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
 */
function TimeInput({
  label,
  value,
  onCommit,
}: {
  readonly label: string;
  readonly value: string;
  readonly onCommit: (text: string) => void;
}): JSX.Element {
  // The text being typed, or null while the field shows `value`.
  const [typed, setTyped] = useState<string | null>(null);
  const commit = (): void => {
    if (typed === null) return;
    setTyped(null);
    if (typed.trim() !== value) onCommit(typed.trim());
  };
  return (
    <Input
      aria-label={label}
      className="w-20 font-mono tabular-nums"
      inputMode="numeric"
      spellCheck={false}
      value={typed ?? value}
      onChange={(event) => {
        setTyped(event.target.value);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setTyped(null);
        } else if (event.key === "Enter") {
          event.preventDefault();
          commit();
        }
      }}
    />
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

  return (
    <FormCard
      label="Heartbeat"
      fine={`${assistantName} checks in on this schedule and only writes when something matters. Times are in ${timezone}.`}
    >
      <Row label="Enabled">
        <Checkbox
          label="On"
          checked={draft.heartbeatEnabled}
          onChange={(event) => {
            onChange({ heartbeatEnabled: event.target.checked });
          }}
        />
      </Row>
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
          <p className="text-fine text-muted">
            <code className="font-mono">{draft.heartbeatSchedule}</code> Set outside the app.
            Choosing an interval here replaces it.
          </p>
        </Row>
      ) : (
        <Row label="Window">
          <div className="flex items-center gap-2 text-row text-muted">
            <TimeInput
              label="From"
              value={formatTimeOfDay(heartbeatWindow.fromHour, heartbeatWindow.minute)}
              onCommit={(text) => {
                commitEdit(moveHeartbeatStart(heartbeatWindow, text));
              }}
            />
            to
            <TimeInput
              label="To"
              value={formatTimeOfDay(heartbeatWindow.toHour, heartbeatWindow.minute)}
              onCommit={(text) => {
                commitEdit(moveHeartbeatEnd(heartbeatWindow, text));
              }}
            />
          </div>
        </Row>
      )}
      {timeError === null ? null : (
        <p className="text-fine text-fail" role="alert">
          {timeError}
        </p>
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
          rows={3}
          value={draft.heartbeatPrompt}
          onChange={(event) => {
            onChange({ heartbeatPrompt: event.target.value });
          }}
        />
      </Row>
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
  assistant,
  draft,
  timezone,
  onChange,
}: {
  readonly assistantName: string;
  readonly assistant: Assistant;
  readonly draft: AssistantDraft;
  readonly timezone: string;
  readonly onChange: (fields: Partial<AssistantDraft>) => void;
}): JSX.Element {
  const [timeError, setTimeError] = useState<string | null>(null);
  return (
    <FormCard
      label="Rotation"
      fine={`${assistantName} starts a fresh session when the context gets too full, and every day at the time above, in ${timezone}. What it learned stays in its memory.`}
    >
      <Row label="Context share" htmlFor="rotation-fraction">
        <Select
          id="rotation-fraction"
          value={String(draft.rotationContextFraction)}
          onChange={(event) => {
            onChange({ rotationContextFraction: Number(event.target.value) });
          }}
        >
          {listContextFractionChoices(assistant.rotation.contextFraction).map((fraction) => (
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
          {listContextTokenChoices(assistant.rotation.maxContextTokens).map((tokens) => (
            <option key={tokens} value={tokens}>
              {`${formatTokenLimit(tokens)} tokens`}
            </option>
          ))}
        </Select>
      </Row>
      <Row label="Daily at">
        <TimeInput
          label="Daily at"
          value={draft.rotationDailyAt}
          onCommit={(text) => {
            const error = findTimeOfDayError(text);
            setTimeError(error);
            if (error === null) onChange({ rotationDailyAt: text });
          }}
        />
      </Row>
      {timeError === null ? null : (
        <p className="text-fine text-fail" role="alert">
          {timeError}
        </p>
      )}
    </FormCard>
  );
}
