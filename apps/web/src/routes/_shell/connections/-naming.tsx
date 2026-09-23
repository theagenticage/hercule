import type { JSX } from "react";
import { Field, Input } from "@hercule/ui";

/**
 * Suggested topics for a connection. They are suggestions, not a closed list:
 * a topic is an ordinary label, so the user can type any other topic.
 */
const TOPICS = ["Code", "Business", "Personal", "Ops"];

/**
 * The label and default topic fields of a connection. Setup and the edit form
 * both use these fields, so both ask in the same words.
 */
export function Naming({
  idPrefix,
  label,
  topic,
  onLabel,
  onTopic,
}: {
  /** Unique per form: two connections' fields can sit on one page. */
  readonly idPrefix: string;
  readonly label: string;
  readonly topic: string;
  readonly onLabel: (label: string) => void;
  readonly onTopic: (topic: string) => void;
}): JSX.Element {
  const topicsId = `${idPrefix}-topics`;

  return (
    <>
      <Field id={`${idPrefix}-label`} label="Label">
        <Input
          id={`${idPrefix}-label`}
          // The label is the only thing that tells two accounts of one type apart.
          required
          placeholder="work"
          value={label}
          onChange={(event) => {
            onLabel(event.target.value);
          }}
        />
      </Field>
      <Field id={`${idPrefix}-topic`} label="Default topic">
        <Input
          id={`${idPrefix}-topic`}
          list={topicsId}
          required
          value={topic}
          onChange={(event) => {
            onTopic(event.target.value);
          }}
        />
        <datalist id={topicsId}>
          {TOPICS.map((suggestion) => (
            <option key={suggestion} value={suggestion} />
          ))}
        </datalist>
      </Field>
    </>
  );
}
