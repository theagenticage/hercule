import { useState, type FormEvent, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Field, FormCard, Input, Select } from "@hercule/ui";
import { queryKeys, type HydraClient } from "@hercule/client-core";
import type { OwnerKind } from "@hercule/contract";
import { SaveStatus, messageOf } from "../../../screens/save-status";

/**
 * The owner kinds a user may write. `core` is the controller's own key
 * material, which the service refuses anyway, so it is not offered; the
 * `satisfies` fails the build if the contract drops or renames one of the
 * four, which would otherwise leave an option nothing can answer.
 */
const OWNER_KINDS = [
  "connection",
  "plugin",
  "runner",
  "provider-instance",
] as const satisfies ReadonlyArray<OwnerKind>;

const EMPTY = { ownerKind: OWNER_KINDS[0], ownerId: "", name: "", value: "" };

/**
 * Writing a secret by naming its owner.
 *
 * Most secrets are written by whatever owns them - a connection's setup writes
 * its own - so this is the way in for the ones nothing else writes yet, and for
 * putting one back by hand. Setting a name that already exists rotates it,
 * which is what the API does with the same call.
 */
export function SetSecret({ client }: { readonly client: HydraClient }): JSX.Element {
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
      // Cleared whole rather than field by field: the value must not survive
      // the write, and a half-filled form is not worth keeping either.
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
      <FormCard
        label="Set secret"
        fine="A value is never read back. Setting a name that already exists rotates it."
      >
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
        <div className="flex items-center gap-3 pt-1">
          <Button type="submit" variant="form" disabled={set.isPending}>
            Set secret
          </Button>
          <SaveStatus
            saved={set.isSuccess}
            failure={set.error === null ? null : messageOf(set.error)}
          />
        </div>
      </FormCard>
    </form>
  );
}
