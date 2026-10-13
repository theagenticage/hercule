import { useState, type FormEvent, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import {
  parseSpawnBoundDraft,
  type HerculeClient,
  type SpawnBoundDraft,
} from "@hercule/client-core";
import { DEFAULT_SPAWN_BOUND, describeSpawnBound, type SpawnBound } from "@hercule/contract";
import { Button, FormCard, Input, Row } from "@hercule/ui";
import { settingsQuery } from "../../../app/queries";
import { SaveStatus } from "../../../screens/save-status";
import { useSaveSettings } from "./-form";

/** Returns the form's two fields holding `bound`, as text. */
const buildDraft = (bound: SpawnBound): SpawnBoundDraft => ({
  maxRuns: String(bound.maxRuns),
  windowSeconds: String(bound.windowSeconds),
});

/**
 * Renders the card that edits the default spawn bound: the most runs a start
 * trigger may start in any window of the given length, when its workflow's
 * source sets no bound of its own.
 *
 * The fields are checked when the form is sent. A field that holds no whole
 * number of 1 or more shows its error under it, and nothing is sent; editing
 * the field clears its error. The sentence under the fields reads the bound
 * the fields hold, so "3600" seconds is also read as "per hour".
 */
export function DefaultBound({ client }: { readonly client: HerculeClient }): JSX.Element {
  const settings = useSuspenseQuery(settingsQuery(client)).data;
  const { save, saving, saved, failure } = useSaveSettings(client);
  const stored = settings.controller["spawnBound.default"] ?? DEFAULT_SPAWN_BOUND;
  const storedDraft = buildDraft(stored);

  const [draft, setDraft] = useState(storedDraft);
  const [errors, setErrors] = useState<Partial<Record<keyof SpawnBoundDraft, string | undefined>>>(
    {},
  );
  // Save is off while the fields hold the stored bound: there is nothing to send.
  const hasChanges =
    draft.maxRuns !== storedDraft.maxRuns || draft.windowSeconds !== storedDraft.windowSeconds;
  const reading = parseSpawnBoundDraft(draft);
  const shownBound = reading.ok ? reading.bound : stored;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!reading.ok) {
      setErrors(reading.errors);
      return;
    }
    // The fields are rewritten as the numbers sent, so " 030" reads "30" and
    // matches the stored bound once the save lands.
    setDraft(buildDraft(reading.bound));
    save({ controller: { "spawnBound.default": reading.bound } });
  };

  const edit = (field: keyof SpawnBoundDraft, text: string): void => {
    setDraft({ ...draft, [field]: text });
    setErrors({ ...errors, [field]: undefined });
  };

  return (
    <form onSubmit={submit} noValidate>
      <FormCard label="Default spawn bound">
        <Row label="Runs" htmlFor="spawn-bound-runs">
          <BoundField
            id="spawn-bound-runs"
            value={draft.maxRuns}
            error={errors.maxRuns}
            onChange={(text) => {
              edit("maxRuns", text);
            }}
          />
        </Row>
        <Row label="Window" htmlFor="spawn-bound-window">
          <BoundField
            id="spawn-bound-window"
            unit="seconds"
            value={draft.windowSeconds}
            error={errors.windowSeconds}
            onChange={(text) => {
              edit("windowSeconds", text);
            }}
          />
        </Row>
        <p className="text-fine text-faint">
          A start trigger whose source sets no bound starts at most {describeSpawnBound(shownBound)}
          . A source can set its own bound for any of its triggers.
        </p>
        <div className="flex items-center gap-3 pt-2">
          <Button type="submit" variant="form" disabled={saving || !hasChanges}>
            Save
          </Button>
          {/* "Saved." describes the last save, so it goes once a field is edited again. */}
          <SaveStatus saved={saved && !hasChanges} failure={failure} />
        </div>
      </FormCard>
    </form>
  );
}

/**
 * Renders one numeric field of the form, the unit after it when it has one,
 * and its error under it.
 */
function BoundField({
  id,
  unit,
  value,
  error,
  onChange,
}: {
  readonly id: string;
  readonly unit?: string;
  readonly value: string;
  readonly error: string | undefined;
  readonly onChange: (text: string) => void;
}): JSX.Element {
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        {/* A text field, not a number field: for text the browser cannot read
            as a number, such as "abc", a number field hands over an empty
            value, so the form could not say what is wrong. */}
        <Input
          id={id}
          className="w-[140px]"
          inputMode="numeric"
          value={value}
          aria-invalid={error !== undefined}
          aria-describedby={error === undefined ? undefined : errorId}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
        {unit === undefined ? null : <span className="text-meta text-muted">{unit}</span>}
      </div>
      {error === undefined ? null : (
        <p id={errorId} className="text-fine text-fail" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
