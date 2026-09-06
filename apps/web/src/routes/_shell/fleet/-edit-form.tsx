import { useState, type FormEvent, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Checkbox, Field, Input, StringList } from "@hydra/ui";
import {
  queryKeys,
  runnerConflictField,
  runnerDraft,
  runnerPatch,
  type HydraClient,
  type RunnerDraft,
} from "@hydra/client-core";
import type { RunnerDetail, RunnerUpdateInput } from "@hydra/contract";
import { messageOf, SaveStatus } from "../../../screens/save-status";

/**
 * The four fields a machine's owner writes, saved as a patch of what moved.
 *
 * What moved is measured against the machine the form was opened with, not
 * against the machine as it now stands: a re-probe or a live push replaces the
 * latter under the reader, and diffing against that would send a field nobody
 * touched - turning the derived session cap into a stored override with no way
 * back. When the machine changes underneath and nothing is half-typed, the form
 * starts again from the new one instead.
 */
export function EditForm({
  client,
  runner,
}: {
  readonly client: HydraClient;
  readonly runner: RunnerDetail;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<{ readonly base: RunnerDetail; readonly draft: RunnerDraft }>(
    () => ({ base: runner, draft: runnerDraft(runner) }),
  );
  const [sent, setSent] = useState<RunnerUpdateInput>({});

  const edited = Object.keys(runnerPatch(form.base, form.draft)).length > 0;
  if (form.base !== runner && !edited) {
    setForm({ base: runner, draft: runnerDraft(runner) });
  }

  const save = useMutation({
    mutationFn: (patch: RunnerUpdateInput) =>
      client.runner.update({ params: { id: runner.id }, payload: patch }),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.runner(runner.id), updated);
      void queryClient.invalidateQueries({ queryKey: queryKeys.runners() });
      // The answer is the whole machine as it now stands, not only the fields
      // the patch named, so the form starts again from it: a field that moved
      // on the controller while this form was open is shown rather than held
      // as an edit nobody made.
      setForm({ base: updated, draft: runnerDraft(updated) });
    },
  });

  const blamed = runnerConflictField(save.error, sent);
  const message = save.error === null ? null : messageOf(save.error);

  const edit = (next: Partial<RunnerDraft>): void => {
    if (!save.isIdle) save.reset();
    setForm((current) => ({ ...current, draft: { ...current.draft, ...next } }));
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const patch = runnerPatch(form.base, form.draft);
    setSent(patch);
    save.mutate(patch);
  };

  return (
    <form className="flex flex-col gap-3 border-t border-line-soft pt-3" onSubmit={submit}>
      <Field
        id="runner-name"
        label="Name"
        error={blamed === "name" ? (message ?? undefined) : undefined}
      >
        <Input
          id="runner-name"
          // A machine has to be called something, and the name is what every
          // other surface finds it by.
          required
          value={form.draft.name}
          onChange={(event) => {
            edit({ name: event.target.value });
          }}
        />
      </Field>
      <Field label="Labels">
        <StringList
          label="Labels"
          values={form.draft.labels}
          onChange={(labels) => {
            edit({ labels });
          }}
        />
      </Field>
      <Field id="runner-cap" label="Concurrent sessions">
        <Input
          id="runner-cap"
          type="number"
          min={1}
          value={String(form.draft.maxConcurrentSessions)}
          onChange={(event) => {
            edit({ maxConcurrentSessions: Number(event.target.value) });
          }}
        />
      </Field>
      <div className="flex flex-col gap-1.5">
        <Checkbox
          label="Personal machine - only runs work you send to it"
          checked={form.draft.reserved}
          onChange={(event) => {
            edit({ reserved: event.target.checked });
          }}
        />
        {blamed === "reserved" && message !== null ? (
          <p className="text-fine text-fail" role="alert">
            {message}
          </p>
        ) : null}
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" variant="form" disabled={save.isPending}>
          Save
        </Button>
        <SaveStatus saved={save.isSuccess} failure={blamed === null ? message : null} />
      </div>
    </form>
  );
}
