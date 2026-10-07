import { useState, type JSX } from "react";
import {
  findTimeOfDayError,
  formatContextFraction,
  formatTokenLimit,
  listContextFractionChoices,
  listContextTokenChoices,
} from "@hercule/client-core";
import type { Rotation } from "@hercule/contract";
import { UndoIcon } from "../../../icons/undo";
import { TimeField } from "./time-field";
import "./schedule.css";

/**
 * Renders an assistant's Rotation section (spec 17 §Settings, Assistants):
 * "At <share> of the context or <size> tokens, and daily at <hh:mm>", the
 * three limits at which its conversation moves on to a fresh session.
 *
 * Every change calls `onSave` with only the field it changes. A daily time that is not HH:MM is refused: the field shows the
 * saved time again, and an error says why.
 *
 * `error` is the last failed save's message. A refused time shows its own
 * error in the same place, until the next change.
 */
export function RotationSection({
  assistantName,
  rotation,
  error,
  onSave,
}: {
  readonly assistantName: string;
  readonly rotation: Rotation;
  readonly error: string | null;
  readonly onSave: (change: Partial<Rotation>) => void;
}): JSX.Element {
  const [timeError, setTimeError] = useState<string | null>(null);
  const shownError = timeError ?? error;

  const save = (change: Partial<Rotation>): void => {
    setTimeError(null);
    onSave(change);
  };

  return (
    <section className="set-sec">
      <h2>
        <UndoIcon size={15} />
        Rotation
      </h2>
      <p>{`${assistantName} starts a fresh context before the current one gets too full.`}</p>
      {/* The controller stores the rotation but does not run it yet. Remove
          this line when it does (#94). */}
      <p className="schedule-note">
        Saved, but not run yet: this version of Hercule does not rotate contexts.
      </p>
      <div className="schedule-sentence">
        At{" "}
        <span className="field field--select">
          <select
            aria-label="Share of the context"
            value={rotation.contextFraction}
            onChange={(event) => {
              save({ contextFraction: Number(event.target.value) });
            }}
          >
            {listContextFractionChoices(rotation.contextFraction).map((fraction) => (
              <option key={fraction} value={fraction}>
                {formatContextFraction(fraction)}
              </option>
            ))}
          </select>
        </span>{" "}
        of the context or{" "}
        <span className="field field--select">
          <select
            aria-label="Context size in tokens"
            value={rotation.maxContextTokens}
            onChange={(event) => {
              save({ maxContextTokens: Number(event.target.value) });
            }}
          >
            {listContextTokenChoices(rotation.maxContextTokens).map((tokens) => (
              <option key={tokens} value={tokens}>
                {formatTokenLimit(tokens)}
              </option>
            ))}
          </select>
        </span>{" "}
        tokens, and daily at{" "}
        <TimeField
          label="Daily at"
          value={rotation.dailyAt}
          onCommit={(text) => {
            const timeOfDayError = findTimeOfDayError(text);
            if (timeOfDayError !== null) setTimeError(timeOfDayError);
            else if (text !== rotation.dailyAt) save({ dailyAt: text });
            else setTimeError(null);
          }}
        />
      </div>
      {shownError !== null && (
        <p className="set-err" role="alert">
          {shownError}
        </p>
      )}
    </section>
  );
}
