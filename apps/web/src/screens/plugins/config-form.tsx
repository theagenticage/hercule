import { useState, type FormEvent, type JSX } from "react";
import { Button, Checkbox, Field, Input, LaneLabel, Select, StringList } from "@hercule/ui";
import {
  configDraft,
  configPayload,
  type ConfigDraft,
  type ConfigField,
  type ConfigJson,
  type ConfigValue,
} from "@hercule/client-core";

/**
 * The form a plugin's own config schema generates. No checking here beyond
 * giving each widget the type its field names: the schema lives in the plugin
 * and only the controller can apply it, so a second reading in the browser
 * would tell the user two different things about one value. A refusal comes
 * back from the write and is shown under the field it blamed.
 */
export function ConfigForm({
  id,
  fields,
  config,
  issues,
  saving,
  onEdit,
  onSave,
}: {
  /** Unique per plugin: these fields sit beside another plugin's on one page. */
  readonly id: string;
  readonly fields: ReadonlyArray<ConfigField>;
  readonly config: unknown;
  readonly issues: Readonly<Record<string, string>>;
  readonly saving: boolean;
  /** The first change since the last write, so what that write said can go. */
  readonly onEdit: () => void;
  readonly onSave: (config: ConfigJson) => void;
}): JSX.Element {
  const [draft, setDraft] = useState<ConfigDraft>(() => configDraft(fields, config));

  const set = (name: string, value: ConfigValue): void => {
    onEdit();
    setDraft((current) => ({ ...current, [name]: value }));
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    onSave(configPayload(fields, draft, config));
  };

  return (
    <form className="flex flex-col gap-3 border-t border-line-soft pt-3" onSubmit={submit}>
      {/* The settings are a card of their own inside the plugin's card: without
          a line above them they read as more of what the plugin contributes.
          The label's own margin comes off, because the form's gap is what sets
          the rhythm between every other pair of lines here. */}
      <div className="-mb-2.5">
        <LaneLabel>Configuration</LaneLabel>
      </div>
      {fields.map((field) => (
        <ConfigFieldRow
          key={field.name}
          inputId={`${id}-${field.name}`}
          field={field}
          value={draft[field.name] ?? ""}
          error={issues[field.name]}
          onChange={(value) => {
            set(field.name, value);
          }}
        />
      ))}
      <div>
        <Button type="submit" variant="form" disabled={saving}>
          Save
        </Button>
      </div>
    </form>
  );
}

/** What a setting's own words say about it, under its name. */
function Description({ field }: { readonly field: ConfigField }): JSX.Element | null {
  if (field.description === undefined) return null;
  return <p className="text-fine text-faint">{field.description}</p>;
}

/**
 * One setting, as the widget its kind asks for. A boolean carries its own name
 * beside the box, so it is the one kind not stacked under a label.
 *
 * Exported because a connection's settings are the same generated fields inside
 * a form of their own: one form there holds the label and the topic beside
 * them, so it renders the rows rather than a whole second form.
 */
export function ConfigFieldRow({
  inputId,
  field,
  value,
  error,
  onChange,
}: {
  readonly inputId: string;
  readonly field: ConfigField;
  readonly value: ConfigValue;
  readonly error: string | undefined;
  readonly onChange: (value: ConfigValue) => void;
}): JSX.Element {
  if (field.kind === "boolean") {
    return (
      <div className="flex flex-col gap-1.5">
        <Checkbox
          id={inputId}
          label={field.label}
          checked={value === true}
          onChange={(event) => {
            onChange(event.target.checked);
          }}
        />
        <Description field={field} />
        <FieldError error={error} />
      </div>
    );
  }

  return (
    <Field id={field.kind === "stringList" ? undefined : inputId} label={field.label} error={error}>
      {/* Above the box, so a refusal reads directly under what it refused. */}
      <Description field={field} />
      <ConfigWidget inputId={inputId} field={field} value={value} onChange={onChange} />
    </Field>
  );
}

/** The same message `Field` shows, for the kind that carries its own label. */
function FieldError({ error }: { readonly error: string | undefined }): JSX.Element | null {
  if (error === undefined) return null;
  return (
    <p className="text-fine text-fail" role="alert">
      {error}
    </p>
  );
}

function ConfigWidget({
  inputId,
  field,
  value,
  onChange,
}: {
  readonly inputId: string;
  readonly field: ConfigField;
  readonly value: ConfigValue;
  readonly onChange: (value: ConfigValue) => void;
}): JSX.Element {
  // Announced, not enforced: the browser refusing a value would be a second
  // reading of a schema only the controller holds.
  const required = field.required ? true : undefined;

  if (field.kind === "enum") {
    return (
      // A closed list of short words needs no more room than its longest one.
      <div className="w-[220px]">
        <Select
          id={inputId}
          aria-required={required}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        >
          {/* An optional setting needs a way back to unset, which no choice says. */}
          {field.required ? null : <option value="">—</option>}
          {(field.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      </div>
    );
  }

  if (field.kind === "stringList") {
    return (
      <StringList
        required={field.required}
        label={field.label}
        values={Array.isArray(value) ? value : []}
        onChange={onChange}
      />
    );
  }

  return (
    <Input
      id={inputId}
      aria-required={required}
      // A number is a few characters wide; only text can be arbitrarily long.
      className={field.kind === "string" ? undefined : "w-[140px]"}
      type={field.kind === "string" ? "text" : "number"}
      step={field.kind === "integer" ? 1 : "any"}
      value={typeof value === "string" ? value : ""}
      onChange={(event) => {
        onChange(event.target.value);
      }}
    />
  );
}
