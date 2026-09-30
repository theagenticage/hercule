import { useState, type FormEvent, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Checkbox, Field, Input, StringList } from "@hercule/ui";
import {
  queryKeys,
  findRunnerConflictField,
  buildRunnerDraft,
  buildRunnerPatch,
  type HerculeClient,
  type RunnerDraft,
  readErrorMessage,
} from "@hercule/client-core";
import type { RunnerDetail, RunnerUpdateInput } from "@hercule/contract";
import { SaveStatus } from "../../../screens/save-status";

const GIB = 1024 * 1024 * 1024;

/**
 * The form for the five runner fields its owner can edit. Saving sends a patch
 * of only the changed fields.
 *
 * Changes are measured against the runner as it was when the form opened, not
 * against the latest copy. A re-probe or a live update can replace the latest
 * copy while the user is editing, and a diff against it would send fields
 * nobody touched. For example, the derived session cap would become a stored
 * override that cannot be undone. When the runner changes and the user has not
 * edited anything, the form resets to the new copy instead.
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
    () => ({ base: runner, draft: buildRunnerDraft(runner) }),
  );
  const [sent, setSent] = useState<RunnerUpdateInput>({});

  const edited = Object.keys(buildRunnerPatch(form.base, form.draft)).length > 0;
  if (form.base !== runner && !edited) {
    setForm({ base: runner, draft: buildRunnerDraft(runner) });
  }

  const save = useMutation({
    mutationFn: (patch: RunnerUpdateInput) =>
      client.runner.update({ params: { id: runner.id }, payload: patch }),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.runner(runner.id), updated);
      void queryClient.invalidateQueries({ queryKey: queryKeys.runners() });
      // The response is the whole runner, not only the patched fields, so the
      // form resets to it. A field that changed on the controller while the
      // form was open is then shown as current, not as an edit nobody made.
      setForm({ base: updated, draft: buildRunnerDraft(updated) });
    },
  });

  const blamed = findRunnerConflictField(save.error, sent);
  const message = save.error === null ? null : readErrorMessage(save.error);
  /** Returns the controller's error message if it is about `field`, otherwise undefined. */
  const readFieldRefusal = (field: "name" | "reserved"): string | undefined =>
    blamed === field ? (message ?? undefined) : undefined;

  const edit = (next: Partial<RunnerDraft>): void => {
    if (!save.isIdle) save.reset();
    setForm((current) => ({ ...current, draft: { ...current.draft, ...next } }));
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const patch = buildRunnerPatch(form.base, form.draft);
    setSent(patch);
    save.mutate(patch);
  };

  return (
    <form className="flex flex-col gap-3 border-t border-line-soft pt-3" onSubmit={submit}>
      <Field id="runner-name" label="Name" error={readFieldRefusal("name")}>
        <Input
          id="runner-name"
          // Every other screen finds the runner by its name, so it cannot be empty.
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
            // Rounded, because a fraction of a GiB gives a byte count that is
            // not an integer, which the contract rejects.
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
        {readFieldRefusal("reserved") === undefined ? null : (
          <p className="text-fine text-fail" role="alert">
            {readFieldRefusal("reserved")}
          </p>
        )}
      </div>
      <div className="flex items-center gap-3">
        {/* An unedited form has no patch to send, and the controller rejects
            an empty patch, so Save is disabled until something changes. */}
        <Button type="submit" variant="form" disabled={save.isPending || !edited}>
          Save
        </Button>
        <SaveStatus saved={save.isSuccess} failure={blamed === null ? message : null} />
      </div>
    </form>
  );
}
