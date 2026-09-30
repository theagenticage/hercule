import { useState, type FormEvent, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Field, Input } from "@hercule/ui";
import { formatStamp, queryKeys, type HerculeClient, readErrorMessage } from "@hercule/client-core";
import type { SecretRef } from "@hercule/contract";
import { InPlaceQuestion } from "../../../screens/in-place-question";
import { SaveStatus } from "../../../screens/save-status";

/**
 * The row for one stored secret: its owner, its name, and when it was last
 * written. The API never returns a secret's value, so the row can write a
 * value but never show one.
 *
 * - Rotate opens an inline field for the new value, because rotating needs
 *   that value.
 * - Delete asks for confirmation inline. Hercule holds the only copy of the
 *   value (nobody can retype a pasted token from memory), and the Delete
 *   button sits right next to Rotate.
 */
export function SecretRow({
  client,
  secret,
  timezone,
}: {
  readonly client: HerculeClient;
  readonly secret: SecretRef;
  readonly timezone: string;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [rotating, setRotating] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [value, setValue] = useState("");

  const params = { ownerKind: secret.ownerKind, ownerId: secret.ownerId, name: secret.name };
  // The response to a write does not cover the rest of the list (a set may
  // have replaced a secret this browser never saw), so the list is fetched
  // again rather than patched in place.
  const reread = () => queryClient.invalidateQueries({ queryKey: queryKeys.secrets() });

  const rotate = useMutation({
    // The value is read from state when the call runs, not passed to
    // `mutate`: a mutation keeps its variables until the next call replaces
    // them, which would be one more place holding the plaintext.
    mutationFn: () => client.secret.set({ params, payload: { value } }),
    onSuccess: async () => {
      setValue("");
      setRotating(false);
      await reread();
    },
  });
  const remove = useMutation({
    mutationFn: () => client.secret.delete({ params }),
    onSuccess: reread,
  });

  const written = secret.rotatedAt ?? secret.createdAt;
  // Only the last action's status is shown. Pressing Rotate or Delete clears
  // the other one's state, so an old failure does not stay on screen.
  const failure = rotate.error ?? remove.error;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    rotate.mutate();
  };

  return (
    <li className="flex flex-col gap-1.5 px-2.5 py-2">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-row">
        <span className="text-fine text-muted">{secret.ownerKind}</span>
        <code className="min-w-0 flex-1 truncate font-mono text-fine text-faint">
          {secret.ownerId}
        </code>
        <b className="font-emph text-ink">{secret.name}</b>
        <span className="font-mono text-fine text-faint tabular-nums">
          {secret.rotatedAt === undefined ? "set" : "rotated"}{" "}
          {formatStamp(new Date(written), timezone) ?? written}
        </span>
        {/* Only the controller writes its own key material. The secret service
            rejects both a rotate and a delete, so neither button is shown. */}
        {secret.ownerKind === "core" ? (
          <span className="text-fine text-faint">controller key</span>
        ) : (
          <div className="flex items-center gap-1.5">
            <Button
              disabled={rotating || rotate.isPending}
              onClick={() => {
                remove.reset();
                setRotating(true);
              }}
            >
              Rotate
            </Button>
            <Button
              disabled={confirmingDelete || remove.isPending}
              onClick={() => {
                rotate.reset();
                setConfirmingDelete(true);
              }}
            >
              Delete
            </Button>
          </div>
        )}
      </div>

      {rotating ? (
        <form className="flex items-end gap-1.5 pb-1" onSubmit={submit}>
          <div className="min-w-0 flex-1">
            <Field
              id={`rotate-${secret.ownerKind}-${secret.ownerId}-${secret.name}`}
              label="New value"
            >
              <Input
                id={`rotate-${secret.ownerKind}-${secret.ownerId}-${secret.name}`}
                type="password"
                autoComplete="off"
                // A rotation needs a new value.
                required
                value={value}
                onChange={(event) => {
                  setValue(event.target.value);
                }}
              />
            </Field>
          </div>
          <Button
            type="button"
            variant="form"
            onClick={() => {
              setValue("");
              setRotating(false);
            }}
          >
            Cancel
          </Button>
          <Button type="submit" variant="form" disabled={rotate.isPending}>
            Save
          </Button>
        </form>
      ) : null}

      {confirmingDelete ? (
        <InPlaceQuestion
          question="Delete this secret? Its value cannot be recovered."
          declineLabel="Cancel"
          acceptLabel="Confirm"
          onDecline={() => {
            setConfirmingDelete(false);
          }}
          onAccept={() => {
            setConfirmingDelete(false);
            remove.mutate();
          }}
        />
      ) : null}

      <SaveStatus
        saved={rotate.isSuccess}
        failure={failure === null ? null : readErrorMessage(failure)}
      />
    </li>
  );
}
