import { useEffect, useId, useRef, useState, type FormEvent, type JSX } from "react";
import { useMutation } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { readErrorMessage } from "@hercule/client-core";
import type { ModelProfile } from "@hercule/contract";
import { CloseIcon } from "../../../../icons/close";
import { GlassDialog } from "../../../../screens/glass-dialog";
import { FormField } from "../../../../screens/step";
import "../../../../screens/settings/providers/providers.css";
import "../../../../screens/settings/providers/new-model-profile-dialog.css";

/** Names the dialog suggests, as chips that fill the Name field. */
const SUGGESTED_NAMES = ["Client work", "Experiments", "Cheap and fast"];

/**
 * Renders the New profile dialog (spec 17 §Settings, Providers, Models): a
 * name, and whether the profile starts empty or as a copy of `copyOf`, the
 * profile that is open. "Create profile" calls `modelProfile.create`; the
 * dialog closes and `onCreated` is called with the new profile, so the caller
 * can open its tab.
 *
 * The controller refuses a name another profile has, and its message shows
 * under the form with what the user typed kept. While the request runs, Esc,
 * the scrim and the buttons do nothing, so a profile is not made after the
 * user thought they had cancelled. `onClose` is called whenever the dialog
 * closes, also after a create.
 */
export function NewModelProfileDialog({
  copyOf,
  onCreated,
  onClose,
}: {
  readonly copyOf: ModelProfile;
  readonly onCreated: (created: ModelProfile) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const formId = useId();
  const startGroup = useId();
  const [name, setName] = useState("");
  const [startFrom, setStartFrom] = useState<"nothing" | "copy">("nothing");
  const create = useMutation({
    // After the saves that are running, so a copy holds the user's last change.
    scope: { id: "model-profile" },
    mutationFn: () =>
      client.modelProfile.create({
        payload: { name, ...(startFrom === "copy" ? { copyFromId: copyOf.id } : {}) },
      }),
    onSuccess: (created) => {
      // The dialog closes first, because an open modal dialog keeps the focus inside it.
      dialogRef.current?.close();
      onCreated(created);
    },
  });
  // A modal dialog focuses its first control, the close button, when it
  // opens. The user is here to type a name. This effect runs after the one in
  // GlassDialog that opens the dialog, because that is a child's.
  useEffect(() => {
    nameRef.current?.focus();
  }, []);
  const canCreate = name.trim() !== "" && !create.isPending;
  const change = (apply: () => void): void => {
    if (create.isPending) return;
    create.reset();
    apply();
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (canCreate) create.mutate();
  };

  return (
    <GlassDialog
      dialogRef={dialogRef}
      className="account-sheet new-profile-dialog"
      label="New profile"
      locked={create.isPending}
      onClose={onClose}
    >
      <div className="pa-sheet-h">
        <span className="pa-sheet-title">
          <h2>New profile</h2>
        </span>
        <button
          type="button"
          className="icon-btn"
          title="Close"
          aria-label="Close"
          disabled={create.isPending}
          onClick={() => dialogRef.current?.close()}
        >
          <CloseIcon size={14} />
        </button>
      </div>
      <form id={formId} className="pa-sheet-b" onSubmit={submit}>
        <p className="np-lead">
          A profile is your own model menu, put together from your accounts. Name it for what it is
          for.
        </p>
        <FormField
          label="Name"
          hint={
            <span className="np-chips">
              {SUGGESTED_NAMES.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="np-chip"
                  onClick={() => {
                    change(() => {
                      setName(suggestion);
                    });
                    nameRef.current?.focus();
                  }}
                >
                  {suggestion}
                </button>
              ))}
            </span>
          }
        >
          <input
            ref={nameRef}
            type="text"
            placeholder="Client work, Experiments, Cheap and fast…"
            spellCheck={false}
            autoComplete="off"
            readOnly={create.isPending}
            value={name}
            onChange={(event) => {
              change(() => {
                setName(event.target.value);
              });
            }}
          />
        </FormField>
        <div className="np-start">
          <span className="fl-label" id={`${startGroup}-label`}>
            Start from
          </span>
          <div role="radiogroup" aria-labelledby={`${startGroup}-label`} className="np-cards">
            <label className="np-card">
              <span className="choice-box">
                <input
                  type="radio"
                  name={startGroup}
                  checked={startFrom === "nothing"}
                  onChange={() => {
                    change(() => {
                      setStartFrom("nothing");
                    });
                  }}
                />
              </span>
              <b>Nothing</b>
              <small>Pick its accounts and models yourself. The page shows how.</small>
            </label>
            <label className="np-card">
              <span className="choice-box">
                <input
                  type="radio"
                  name={startGroup}
                  checked={startFrom === "copy"}
                  onChange={() => {
                    change(() => {
                      setStartFrom("copy");
                    });
                  }}
                />
              </span>
              <b>{`A copy of ${copyOf.name}`}</b>
              <small>
                Its accounts and menu, to change from there. The original stays as it is.
              </small>
            </label>
          </div>
        </div>
        {create.error === null ? null : (
          <p className="fl-err np-error" role="alert">
            {readErrorMessage(create.error)}
          </p>
        )}
      </form>
      <div className="pa-sheet-f">
        <button
          type="button"
          className="btn"
          disabled={create.isPending}
          onClick={() => dialogRef.current?.close()}
        >
          Cancel
        </button>
        <button
          type="submit"
          form={formId}
          className="btn btn--accent"
          disabled={!canCreate}
          aria-busy={create.isPending ? true : undefined}
        >
          {create.isPending ? "Creating…" : "Create profile"}
        </button>
      </div>
    </GlassDialog>
  );
}
