import type { JSX } from "react";
import type { TextDraftProps } from "../use-text-draft";
import "./providers.css";

/**
 * Renders the text field of an account's label, with `hint` under it and,
 * when the last save failed, `error` in place of the hint. `draft` holds the
 * field's value and handlers (`useTextDraft`), so typing saves when the user
 * leaves the field or presses Enter.
 */
export function AccountNameField({
  draft,
  placeholder,
  hint,
  error,
}: {
  readonly draft: TextDraftProps;
  readonly placeholder: string;
  readonly hint: string;
  readonly error: string | null;
}): JSX.Element {
  return (
    <div className="pa-name">
      <span className={error === null ? "field" : "field is-bad"}>
        <input
          type="text"
          aria-label="Name"
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          {...draft}
        />
      </span>
      {error === null ? (
        <p className="pa-hint">{hint}</p>
      ) : (
        <p className="fl-err" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
