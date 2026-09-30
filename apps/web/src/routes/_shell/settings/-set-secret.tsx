import { useState, type FormEvent, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Field, FormCard, Input, Select } from "@hercule/ui";
import { queryKeys, type HerculeClient, readErrorMessage } from "@hercule/client-core";
import type { OwnerKind } from "@hercule/contract";
import { SaveStatus } from "../../../screens/save-status";

/**
 * The owner kinds a user may write secrets for. `core` is left out: it is the
 * controller's own key material, and the secret service rejects writes to it.
 * The `satisfies` fails the build if the contract drops or renames one of
 * these four, which would otherwise leave an option that always fails.
 */
const OWNER_KINDS = [
  "connection",
  "plugin",
  "runner",
  "provider-instance",
] as const satisfies ReadonlyArray<OwnerKind>;

const EMPTY = { ownerKind: OWNER_KINDS[0], ownerId: "", name: "", value: "" };

/**
 * The form that writes a secret for an owner the user names.
 *
 * Most secrets are written by their owner's own screen (a connection's setup
 * writes its credentials, for example). This form is for secrets that no
 * screen writes yet, and for restoring one by hand. Setting a name that
 * already exists rotates that secret, because the API uses the same call for
 * both.
 */
export function SetSecret({ client }: { readonly client: HerculeClient }): JSX.Element {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<{
    ownerKind: OwnerKind;
    ownerId: string;
    name: string;
    value: string;
  }>(EMPTY);

  const set = useMutation({
    mutationFn: () =>
      client.secret.set({
        params: { ownerKind: form.ownerKind, ownerId: form.ownerId, name: form.name },
        payload: { value: form.value },
      }),
    onSuccess: async () => {
      // The whole form is cleared, not just the value: the value must not stay
      // after the write, and a half-filled form is not worth keeping.
      setForm(EMPTY);
      await queryClient.invalidateQueries({ queryKey: queryKeys.secrets() });
    },
  });

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    set.mutate();
  };

  return (
    <form onSubmit={submit}>
      <FormCard label="Set secret">
        <Field id="secret-owner-kind" label="Owner kind">
          <Select
            id="secret-owner-kind"
            value={form.ownerKind}
            onChange={(event) => {
              setForm({ ...form, ownerKind: event.target.value as OwnerKind });
            }}
          >
            {OWNER_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="secret-owner-id" label="Owner id">
          <Input
            id="secret-owner-id"
            required
            value={form.ownerId}
            onChange={(event) => {
              setForm({ ...form, ownerId: event.target.value });
            }}
          />
        </Field>
        <Field id="secret-name" label="Name">
          <Input
            id="secret-name"
            required
            value={form.name}
            onChange={(event) => {
              setForm({ ...form, name: event.target.value });
            }}
          />
        </Field>
        <Field id="secret-value" label="Value">
          <Input
            id="secret-value"
            type="password"
            autoComplete="off"
            required
            value={form.value}
            onChange={(event) => {
              setForm({ ...form, value: event.target.value });
            }}
          />
        </Field>
        {/* The note sits under the fields it explains and the button ends
            the card, as on every settings card with a Save. */}
        <p className="text-fine text-faint">
          A value is never read back. Setting a name that already exists rotates it.
        </p>
        <div className="flex items-center gap-3 pt-2">
          <Button type="submit" variant="form" disabled={set.isPending}>
            Set secret
          </Button>
          <SaveStatus
            saved={set.isSuccess}
            failure={set.error === null ? null : readErrorMessage(set.error)}
          />
        </div>
      </FormCard>
    </form>
  );
}
