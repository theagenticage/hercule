import type { JSX } from "react";
import { Field, Input } from "@hercule/ui";

/**
 * The topics a connection can file into. Suggestions rather than a closed list:
 * a topic is an ordinary label, so a user with topics of their own types one.
 */
const TOPICS = ["Code", "Business", "Personal", "Ops"];

/**
 * The two things the user decides about a connection rather than the account:
 * what to call it, and which topic its work files into. Asked at setup and
 * edited afterwards, so both places ask in the same words.
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
          // Two accounts of one type are told apart by this and nothing else.
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
