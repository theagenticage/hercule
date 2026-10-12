import { useId, type JSX, type ReactNode } from "react";
import {
  describeFeedInterval,
  describeFeedName,
  SUGGESTED_TOPICS,
  type ConnectionFeed,
  type FeedIntervalsDraft,
} from "@hercule/client-core";
import { buildHintId, FormField, LabelledField } from "../../step";
import "./configure-connection.css";

/**
 * Renders the header and the form of Configure, the dialog that edits a
 * Connection (spec 17 §Settings, Connections), for a `GlassDialog` with the
 * class `configure-connection-dialog`. The form holds three groups:
 *
 * - the name and the topic, with `missingType`'s note under them when the
 *   plugin that declared the Connection's type is no longer installed;
 * - `settings`, the rows of the settings the type declares, under their
 *   heading, when there are any;
 * - Polling, an interval field per feed in `feeds`, when there are any.
 *
 * Cancel and Save sit at the foot, with `failure`, the error of the last
 * save that belongs to no field, above them.
 *
 * While `saving`, every field is disabled, so nothing typed after Save is
 * lost when the save closes the dialog, and Save reads "Saving…".
 *
 * Presentational: the caller holds the values, checks them and saves them.
 * The settings come as rendered rows because a row may read its choices
 * from the account.
 */
export function ConfigureConnection({
  title,
  name,
  nameError,
  topic,
  missingType,
  settings,
  feeds,
  typeName,
  intervals,
  intervalErrors,
  failure,
  saving,
  onNameChange,
  onTopicChange,
  onIntervalChange,
  onSave,
  onCancel,
}: {
  /** The dialog's title, such as "Configure GitHub · work". */
  readonly title: string;
  readonly name: string;
  readonly nameError: string | undefined;
  readonly topic: string;
  /** The Connection's type when no installed plugin declares it, or `undefined`. */
  readonly missingType: string | undefined;
  readonly settings: { readonly heading: string; readonly rows: ReactNode } | undefined;
  readonly feeds: ReadonlyArray<ConnectionFeed>;
  /** The type's name, for the hint under each interval field. */
  readonly typeName: string;
  readonly intervals: FeedIntervalsDraft;
  /** The error of each feed's interval, by feed name. */
  readonly intervalErrors: Readonly<Record<string, string | undefined>>;
  readonly failure: string | null;
  readonly saving: boolean;
  readonly onNameChange: (name: string) => void;
  readonly onTopicChange: (topic: string) => void;
  readonly onIntervalChange: (feedName: string, text: string) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const id = useId();
  return (
    <>
      <div className="pop-h">
        <b>{title}</b>
      </div>
      <form
        className="configure-connection-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          onSave();
        }}
      >
        {/* Disabled while saving, so nothing typed after Save is lost when
            the save closes the dialog. */}
        <fieldset className="pop-sec configure-connection-body" disabled={saving}>
          <div className="configure-connection-group">
            <FormField label="Name" error={nameError ?? null}>
              <input
                aria-required
                spellCheck={false}
                autoComplete="off"
                value={name}
                onChange={(event) => onNameChange(event.target.value)}
              />
            </FormField>
            <FormField label="Topic">
              <input
                list={`${id}-topics`}
                autoComplete="off"
                value={topic}
                onChange={(event) => onTopicChange(event.target.value)}
              />
              <datalist id={`${id}-topics`}>
                {SUGGESTED_TOPICS.map((suggestion) => (
                  <option key={suggestion} value={suggestion} />
                ))}
              </datalist>
            </FormField>
            {missingType === undefined ? null : (
              <p className="configure-connection-note">
                {`The plugin that declared ${missingType} is not installed, so only the name and topic can be changed. Its settings and polling are kept as they are.`}
              </p>
            )}
          </div>

          {settings === undefined ? null : (
            <section className="configure-connection-group" aria-labelledby={`${id}-settings`}>
              <h3 id={`${id}-settings`}>{settings.heading}</h3>
              {settings.rows}
            </section>
          )}

          {feeds.length === 0 ? null : (
            <section className="configure-connection-group" aria-labelledby={`${id}-polling`}>
              <h3 id={`${id}-polling`}>Polling</h3>
              {feeds.map((feed) => {
                const inputId = `${id}-feed-${feed.name}`;
                const error = intervalErrors[feed.name];
                return (
                  <LabelledField
                    key={feed.name}
                    labelId={`${inputId}-label`}
                    inputId={inputId}
                    label={describeFeedName(feed)}
                    hint={describeFeedInterval(feed, typeName)}
                    error={error}
                  >
                    <span
                      className={
                        error === undefined
                          ? "field config-field-narrow"
                          : "field config-field-narrow is-bad"
                      }
                    >
                      {/* A text field, not a number field, so text such as
                          "abc" reaches the form, which can say what is wrong. */}
                      <input
                        id={inputId}
                        aria-describedby={buildHintId(`${inputId}-label`)}
                        aria-invalid={error === undefined ? undefined : true}
                        inputMode="numeric"
                        autoComplete="off"
                        placeholder={String(feed.defaultIntervalSeconds)}
                        value={intervals[feed.name] ?? ""}
                        onChange={(event) => onIntervalChange(feed.name, event.target.value)}
                      />
                      <span className="fine">seconds</span>
                    </span>
                  </LabelledField>
                );
              })}
            </section>
          )}
        </fieldset>

        <div className="pop-sec configure-connection-foot">
          {failure === null ? null : (
            <p className="fl-err" role="alert">
              {`Could not save: ${failure}`}
            </p>
          )}
          <div className="configure-connection-acts">
            <button type="button" className="btn btn--quiet" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className="btn btn--accent" aria-disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </form>
    </>
  );
}
