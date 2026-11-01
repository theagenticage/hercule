import { useId, type JSX, type ReactNode } from "react";
import {
  MODEL_CONTEXT_CHOICES,
  MODEL_PRICE_CHOICES,
  hasActiveFacets,
  type ModelBrowserChoice,
  type ModelFacets,
  type ModelMaker,
} from "@hercule/client-core";
import { CheckIcon } from "../../../icons/check";
import "./model-browser.css";

/** The abilities the "Can" facet offers, with the words the dialog uses for each. */
const ABILITIES = [
  { key: "tools", label: "Use tools" },
  { key: "images", label: "Read images" },
  { key: "reasoning", label: "Reason" },
] as const;

/** Renders one facet: a small heading and its controls. */
function Facet({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}): JSX.Element {
  const headingId = useId();
  return (
    <div className="mb-facet" role="group" aria-labelledby={headingId}>
      <h3 id={headingId}>{title}</h3>
      {children}
    </div>
  );
}

/** Renders a checkbox with its label and, when given, a count after it. */
function FacetCheck({
  label,
  count,
  checked,
  onChange,
}: {
  readonly label: string;
  readonly count?: number;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}): JSX.Element {
  return (
    <label className="mb-check">
      <span className="choice-box">
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => {
            onChange(event.target.checked);
          }}
        />
        <CheckIcon size={10} />
      </span>
      <span>{label}</span>
      {count === undefined ? null : <small>{count}</small>}
    </label>
  );
}

/** Renders one of the facet's segmented controls: the choice whose value is `value` is pressed. */
function FacetChoices({
  label,
  choices,
  value,
  onChange,
}: {
  readonly label: string;
  readonly choices: readonly ModelBrowserChoice<number | null>[];
  readonly value: number | null;
  readonly onChange: (value: number | null) => void;
}): JSX.Element {
  return (
    <div className="seg mb-seg" role="group" aria-label={label}>
      {choices.map((choice) => (
        <button
          key={choice.label}
          type="button"
          aria-pressed={choice.value === value}
          onClick={() => {
            onChange(choice.value);
          }}
        >
          {choice.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Renders the facets the model browser filters on, as a column: "Made by"
 * (one checkbox per maker, with its count of models, in a list that scrolls),
 * "Can" (tools, images, reasoning), "Context" and "Price", and "Clear
 * filters" once anything is chosen.
 *
 * Every change calls `onChange` with the new facets, except "Clear filters",
 * which calls `onClear`. It is a separate callback because the button
 * unmounts itself, so the caller must decide where the focus goes.
 */
export function ModelBrowserFacets({
  makers,
  facets,
  onChange,
  onClear,
}: {
  readonly makers: readonly ModelMaker[];
  readonly facets: ModelFacets;
  readonly onChange: (facets: ModelFacets) => void;
  readonly onClear: () => void;
}): JSX.Element {
  return (
    <div className="mb-side">
      {makers.length === 0 ? null : (
        <Facet title="Made by">
          <div className="mb-makers">
            {makers.map(({ name, count }) => (
              <FacetCheck
                key={name}
                label={name}
                count={count}
                checked={facets.makers.includes(name)}
                onChange={(checked) => {
                  onChange({
                    ...facets,
                    makers: checked
                      ? [...facets.makers, name]
                      : facets.makers.filter((each) => each !== name),
                  });
                }}
              />
            ))}
          </div>
        </Facet>
      )}
      <Facet title="Can">
        {ABILITIES.map(({ key, label }) => (
          <FacetCheck
            key={key}
            label={label}
            checked={facets[key]}
            onChange={(checked) => {
              onChange({ ...facets, [key]: checked });
            }}
          />
        ))}
      </Facet>
      <Facet title="Context">
        <FacetChoices
          label="Context window"
          choices={MODEL_CONTEXT_CHOICES}
          value={facets.minContextWindow}
          onChange={(minContextWindow) => {
            onChange({ ...facets, minContextWindow });
          }}
        />
      </Facet>
      <Facet title="Price">
        <FacetChoices
          label="Input price"
          choices={MODEL_PRICE_CHOICES}
          value={facets.maxInputPrice}
          onChange={(maxInputPrice) => {
            onChange({ ...facets, maxInputPrice });
          }}
        />
        <small className="mb-note">per million input tokens</small>
      </Facet>
      {hasActiveFacets(facets) ? (
        <button type="button" className="link mb-clear" onClick={onClear}>
          Clear filters
        </button>
      ) : null}
    </div>
  );
}
