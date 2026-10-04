import { useState, type FormEvent, type JSX } from "react";
import { Button, Checkbox, Field, FormSection, Input, Select, StringList } from "@hercule/ui";
import {
  buildConfigDraft,
  buildConfigPayload,
  type ConfigDraft,
  type ConfigField,
  type ConfigJson,
  type ConfigValue,
} from "@hercule/client-core";

/**
 * The form generated from a plugin's config schema. The form does not
 * validate anything beyond giving each widget the right input type. The
 * schema lives in the plugin and only the controller can apply it, so a
 * second check in the browser could disagree with the controller about the
 * same value. Validation errors come back from the save and are shown under
 * the field they belong to.
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
  /** A prefix for input ids, unique per plugin, because several plugins' forms share one page. */
  readonly id: string;
  readonly fields: ReadonlyArray<ConfigField>;
  readonly config: unknown;
  readonly issues: Readonly<Record<string, string>>;
  readonly saving: boolean;
  /** Called on every edit, so the parent can clear the result of the last save. */
  readonly onEdit: () => void;
  readonly onSave: (config: ConfigJson) => void;
}): JSX.Element {
  const [draft, setDraft] = useState<ConfigDraft>(() => buildConfigDraft(fields, config));

  const setField = (name: string, value: ConfigValue): void => {
    onEdit();
    setDraft((current) => ({ ...current, [name]: value }));
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    onSave(buildConfigPayload(fields, draft, config));
  };

  return (
    <form className="flex flex-col gap-3 border-t border-line-soft pt-3" onSubmit={submit}>
      {/* The settings get a rule above them inside the plugin's card; without
          it they look like part of the plugin's contributions. */}
      <FormSection heading="Configuration">
        {fields.map((field) => (
          <ConfigFieldRow
            key={field.name}
            inputId={`${id}-${field.name}`}
            field={field}
            value={draft[field.name] ?? ""}
            error={issues[field.name]}
            onChange={(value) => {
              setField(field.name, value);
            }}
          />
        ))}
      </FormSection>
      <div>
        <Button type="submit" variant="form" disabled={saving}>
          Save
        </Button>
      </div>
    </form>
  );
}

/** The setting's description from the schema, shown under its name. */
function Description({ field }: { readonly field: ConfigField }): JSX.Element | null {
  if (field.description === undefined) return null;
  return <p className="text-fine text-faint">{field.description}</p>;
}

/**
 * One setting, rendered with the widget for its kind. A boolean shows its
 * name beside the checkbox, so it is the only kind not placed under a label.
 *
 * Exported because a connection's settings use the same generated fields
 * inside another form, which also holds the label and the topic. That form
 * renders these rows rather than a second `ConfigForm`.
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
      {/* The description goes above the input, so an error appears directly under the input. */}
      <Description field={field} />
      <ConfigWidget inputId={inputId} field={field} value={value} onChange={onChange} />
    </Field>
  );
}

/** The error message `Field` would show, for the boolean kind, which has its own label. */
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
  // Announced with `aria-required` but not enforced with `required`. If the
  // browser blocked a value, it would be a second check of a schema only the
  // controller holds.
  const required = field.required ? true : undefined;

  if (field.kind === "enum") {
    return (
      // A list of short options needs no more width than its longest option.
      <div className="w-[220px]">
        <Select
          id={inputId}
          aria-required={required}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        >
          {/* An optional setting needs an empty choice, so the user can unset it. */}
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
      // A number needs only a few characters; only text can be arbitrarily long.
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
