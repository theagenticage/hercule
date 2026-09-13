import { useState, type FormEvent, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Field, Input } from "@hydra/ui";
import { formatStamp, queryKeys, type HydraClient } from "@hydra/client-core";
import type { SecretRef } from "@hydra/contract";
import { SaveStatus, messageOf } from "../../../screens/save-status";

/**
 * One stored secret, as everything about it that can be read: who owns it, what
 * it is called, and when it was last written. No read carries a value, so the
 * row can only ever write one.
 *
 * Rotating asks for the new value in place rather than writing on the press:
 * the value is the whole of the operation, and there is nothing to rotate to
 * without it. Deleting asks for a confirmation in the same place, because
 * Hydra holds the only copy of what it is about to drop - a pasted token
 * cannot be typed again from memory - and the press sits beside Rotate.
 */
export function SecretRow({
  client,
  secret,
  timezone,
}: {
  readonly client: HydraClient;
  readonly secret: SecretRef;
  readonly timezone: string;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [rotating, setRotating] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [value, setValue] = useState("");

  const params = { ownerKind: secret.ownerKind, ownerId: secret.ownerId, name: secret.name };
  // The answer to a write says nothing about the rest of the listing - a set
  // may have replaced a reference this browser never saw - so the list is
  // reread rather than patched in place.
  const reread = () => queryClient.invalidateQueries({ queryKey: queryKeys.secrets() });

  const rotate = useMutation({
    // The value is read from state at call time rather than handed to
    // `mutate`: a mutation keeps its variables until the next one replaces
    // them, and that is one more place the plaintext would sit.
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
  // Only the last thing pressed has a status to show; the other's is dropped
  // when its turn comes, so a failure cannot outlive the move that caused it.
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
        {/* The controller's own key material is written by the controller and
            by nothing else: the service refuses both writes, so neither is
            offered. */}
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
                // There is nothing to rotate to without one.
                required
                value={value}
                onChange={(event) => {
                  setValue(event.target.value);
                }}
              />
            </Field>
          </div>
          <Button type="submit" variant="form" disabled={rotate.isPending}>
            Save
          </Button>
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
        </form>
      ) : null}

      {/* Asked in place rather than behind a browser dialog, like every other
          question this app puts to the reader. */}
      {confirmingDelete ? (
        <div className="flex flex-wrap items-center gap-1.5 text-row text-muted">
          <span>Delete this secret? Its value cannot be recovered.</span>
          <Button
            variant="primary"
            onClick={() => {
              setConfirmingDelete(false);
              remove.mutate();
            }}
          >
            Confirm
          </Button>
          <Button
            onClick={() => {
              setConfirmingDelete(false);
            }}
          >
            Cancel
          </Button>
        </div>
      ) : null}

      <SaveStatus saved={rotate.isSuccess} failure={failure === null ? null : messageOf(failure)} />
    </li>
  );
}
