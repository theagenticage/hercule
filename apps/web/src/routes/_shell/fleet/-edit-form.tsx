import { useState, type FormEvent, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Checkbox, Field, Input, StringList } from "@hercule/ui";
import {
  queryKeys,
  runnerConflictField,
  runnerDraft,
  runnerPatch,
  type HerculeClient,
  type RunnerDraft,
} from "@hercule/client-core";
import type { RunnerDetail, RunnerUpdateInput } from "@hercule/contract";
import { messageOf, SaveStatus } from "../../../screens/save-status";

const GIB = 1024 * 1024 * 1024;

/**
 * The five fields a machine's owner writes, saved as a patch of what moved.
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
  readonly client: HerculeClient;
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
  /** What a refusal the controller pinned on one field says, beside that field. */
  const refusal = (field: "name" | "reserved"): string | undefined =>
    blamed === field ? (message ?? undefined) : undefined;

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
      <Field id="runner-name" label="Name" error={refusal("name")}>
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
      <Field id="runner-disk-watermark" label="Disk watermark (GiB)">
        <Input
          id="runner-disk-watermark"
          type="number"
          min={1}
          step={1}
          value={String(form.draft.diskWatermarkBytes / GIB)}
          onChange={(event) => {
            // Rounded, so a fraction of a GiB never turns into a byte count
            // the contract's integer check refuses.
            edit({ diskWatermarkBytes: Math.round(Number(event.target.value) * GIB) });
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
        {refusal("reserved") === undefined ? null : (
          <p className="text-fine text-fail" role="alert">
            {refusal("reserved")}
          </p>
        )}
      </div>
      <div className="flex items-center gap-3">
        {/* An untouched form has no patch to send, and the controller refuses
            an empty one, so Save is not offered until something has moved. */}
        <Button type="submit" variant="form" disabled={save.isPending || !edited}>
          Save
        </Button>
        <SaveStatus saved={save.isSuccess} failure={blamed === null ? message : null} />
      </div>
    </form>
  );
}
