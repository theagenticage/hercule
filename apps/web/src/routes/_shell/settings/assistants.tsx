import { useEffect, useRef, useState, type JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useIsMutating, useMutation, useSuspenseQuery } from "@tanstack/react-query";
import {
  buildAssistantDraft,
  buildAssistantUpdate,
  type AssistantDraft,
} from "@hercule/client-core";
import { Button, EmptyState } from "@hercule/ui";
import { useLiveInvalidation } from "../../../app/live-invalidation";
import { assistantsQuery, profilesQuery, providersQuery } from "../../../app/queries";
import { InPlaceQuestion } from "../../../screens/in-place-question";
import { SaveStatus, readErrorMessage } from "../../../screens/save-status";
import {
  AssistantForm,
  ASSISTANT_MUTATION_KEY,
  type ChangeAssistantEdits,
} from "./-assistant-form";
import { AssistantList } from "./-assistant-list";

export const Route = createFileRoute("/_shell/settings/assistants")({
  staticData: { title: "Assistants" },
  // The form's selects read the provider instances and the permission
  // profiles, so both load with the list and the form never waits for them.
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(assistantsQuery(context.client)),
      context.queryClient.ensureQueryData(providersQuery(context.client)),
      context.queryClient.ensureQueryData(profilesQuery(context.client)),
    ]),
  component: Assistants,
});

/** The name a new assistant starts with. The user renames it in the form. */
const NEW_ASSISTANT_NAME = "Hercule";

/** What the user asked to do next that would throw away the form's unsaved edits. */
type Leaving =
  { readonly _tag: "select"; readonly assistantId: string } | { readonly _tag: "create" };

/**
 * Renders the Assistants settings screen: the list of assistants, a button
 * that creates one, and the form of the selected one.
 *
 * - The first assistant is selected until the user picks another, and a new
 *   assistant is selected as soon as it exists.
 * - Picking another assistant, or creating one, while the form holds unsaved
 *   edits first asks whether to discard them.
 * - While a create, a save or a delete runs, the list, New assistant and the
 *   question about unsaved edits are disabled, so its answer, and any error
 *   in it, lands on the form that sent it.
 * - After the user picks, creates or deletes an assistant, focus moves to the
 *   selected row, or to New assistant when none is left.
 */
function Assistants(): JSX.Element {
  const { client, queryClient, live } = Route.useRouteContext();

  useLiveInvalidation(live, queryClient, "assistant");
  // The provider instance select lists the instances, so an instance added
  // or removed elsewhere shows without a reload.
  useLiveInvalidation(live, queryClient, "provider");

  const assistants = useSuspenseQuery(assistantsQuery(client)).data.items;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = assistants.find((each) => each.id === selectedId) ?? assistants[0];

  // The edits are tagged with the assistant they were made to, so they never
  // show on another one, even when the selected assistant changes without
  // the user picking it, as after a delete.
  const [edits, setEdits] = useState<{
    readonly assistantId: string | null;
    readonly fields: Partial<AssistantDraft>;
  }>({ assistantId: null, fields: {} });
  const fields = selected !== undefined && edits.assistantId === selected.id ? edits.fields : {};
  const hasUnsavedEdits =
    selected !== undefined &&
    Object.keys(buildAssistantUpdate(selected, { ...buildAssistantDraft(selected), ...fields }))
      .length > 0;
  const busy = useIsMutating({ mutationKey: ASSISTANT_MUTATION_KEY }) > 0;

  const [leaving, setLeaving] = useState<Leaving | null>(null);

  // After the user switches, creates or deletes an assistant, the element
  // that had focus is gone or disabled: the answered question, the removed
  // form, or New assistant while it creates. Focus then moves to the
  // selected row, or to New assistant when no assistant is left. Each of
  // these updates the selection or the cached list before it sets the flag,
  // so the render after the flag is set already shows the new selection.
  const focusSelectedRowRef = useRef(false);
  const selectedRowRef = useRef<HTMLButtonElement>(null);
  const newAssistantButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!focusSelectedRowRef.current) return;
    focusSelectedRowRef.current = false;
    (selectedRowRef.current ?? newAssistantButtonRef.current)?.focus();
  });

  const create = useMutation({
    mutationKey: [...ASSISTANT_MUTATION_KEY, "create"],
    mutationFn: () => client.assistant.create({ payload: { name: NEW_ASSISTANT_NAME } }),
    onSuccess: async (created) => {
      // Added to the cached list first, so the new assistant is selected at
      // once, without the form briefly showing another assistant.
      queryClient.setQueryData(assistantsQuery(client).queryKey, (page) =>
        page === undefined ? page : { ...page, items: [...page.items, created] },
      );
      setSelectedId(created.id);
      focusSelectedRowRef.current = true;
      await queryClient.invalidateQueries({ queryKey: assistantsQuery(client).queryKey });
    },
  });

  const leave = (next: Leaving): void => {
    setLeaving(null);
    setEdits({ assistantId: null, fields: {} });
    if (next._tag === "select") {
      setSelectedId(next.assistantId);
      focusSelectedRowRef.current = true;
    } else {
      create.mutate();
    }
  };
  const askToLeave = (next: Leaving): void => {
    if (hasUnsavedEdits) setLeaving(next);
    else leave(next);
  };

  const changeEdits: ChangeAssistantEdits = (update) => {
    if (selected === undefined) return;
    setEdits((current) => ({
      assistantId: selected.id,
      fields: update(current.assistantId === selected.id ? current.fields : {}),
    }));
  };

  const newAssistantButton = (
    <div className="flex items-center gap-3">
      <Button
        ref={newAssistantButtonRef}
        variant="form"
        disabled={busy}
        onClick={() => {
          askToLeave({ _tag: "create" });
        }}
      >
        New assistant
      </Button>
      <SaveStatus
        saved={false}
        failure={create.error === null ? null : readErrorMessage(create.error)}
      />
    </div>
  );

  if (selected === undefined) {
    return (
      <EmptyState
        className="mt-0"
        headline="No assistants."
        lead="An assistant is a conversation with memory, bound to the channels you give it. Its memory, heartbeat and reply style are edited here."
      >
        {newAssistantButton}
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col gap-7">
      <section className="flex flex-col gap-3">
        <AssistantList
          assistants={assistants}
          selectedId={selected.id}
          selectedRowRef={selectedRowRef}
          disabled={busy}
          onSelect={(assistantId) => {
            askToLeave({ _tag: "select", assistantId });
          }}
        />
        {newAssistantButton}
        {leaving === null ? null : (
          <InPlaceQuestion
            // A question asked for another target is a new question, so it
            // remounts, takes focus and remembers its own asking element.
            key={leaving._tag === "select" ? leaving.assistantId : "create"}
            question={`Discard changes to ${selected.name}?`}
            declineLabel="Cancel"
            acceptLabel="Discard"
            disabled={busy}
            onDecline={() => {
              setLeaving(null);
            }}
            onAccept={() => {
              leave(leaving);
            }}
          />
        )}
      </section>

      <AssistantForm
        // Keyed by the assistant, so the delete question and the save state
        // of one assistant never show on another.
        key={selected.id}
        client={client}
        assistant={selected}
        edits={fields}
        onEditsChange={changeEdits}
        onDeleted={() => {
          // The deleted assistant's edits went with it, so a question about
          // discarding them no longer applies.
          setLeaving(null);
          focusSelectedRowRef.current = true;
        }}
      />
    </div>
  );
}
