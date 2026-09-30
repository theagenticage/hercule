import { useState, type FormEvent, type JSX } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { addCompletedStep, readErrorMessage } from "@hercule/client-core";
import { Button, Field, Input } from "@hercule/ui";
import { HOME_PATH } from "../../app/entry-guard";
import { assistantsQuery, settingsQuery } from "../../app/queries";
import { CenteredScreen } from "../../screens/centered-screen";

/** The key of this step's save, so a second submit can see that one is running. */
const SAVE_KEY = ["onboarding-assistant"];

export const Route = createFileRoute("/onboarding/assistant")({
  staticData: { title: "Name your assistant" },
  loader: ({ context: { client, queryClient } }) =>
    queryClient.ensureQueryData(assistantsQuery(client)),
  component: AssistantStep,
});

/**
 * Names the assistant that setup created. When there is none (it was deleted,
 * or setup ran before assistants existed), the step creates one with the typed
 * name instead. The step is recorded as done only after the assistant write
 * succeeds, so a refused write leaves the user on this step.
 */
function AssistantStep(): JSX.Element {
  const { client, queryClient } = Route.useRouteContext();
  const navigate = useNavigate();
  const settings = useSuspenseQuery(settingsQuery(client)).data;
  const shown = useSuspenseQuery(assistantsQuery(client)).data.items[0] ?? null;

  const [name, setName] = useState(shown?.name ?? "");

  const save = useMutation({
    mutationKey: SAVE_KEY,
    mutationFn: async (typed: string) => {
      // The list is read afresh rather than taken from the render: after a
      // create whose settings write was refused, a retry must rename the
      // assistant it created, not create a second one.
      const assistant =
        (await queryClient.fetchQuery({ ...assistantsQuery(client), staleTime: 0 })).items[0] ??
        null;
      if (assistant === null) {
        await client.assistant.create({ payload: { name: typed } });
      } else {
        await client.assistant.update({ params: { id: assistant.id }, payload: { name: typed } });
      }
      // Both writes change the assistants list, which the sidebar shows the
      // name from. The conversation screen reads the one assistant instead,
      // and the live `assistant` topic refreshes that read.
      await queryClient.invalidateQueries({ queryKey: assistantsQuery(client).queryKey });
      return client.settings.update({
        payload: {
          user: {
            "onboarding.completedSteps": addCompletedStep(
              settings.user["onboarding.completedSteps"] ?? [],
              "assistant",
            ),
          },
        },
      });
    },
    onSuccess: async (updated) => {
      queryClient.setQueryData(settingsQuery(client).queryKey, updated);
      await navigate({ to: HOME_PATH });
    },
  });

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    // `save.isPending` reaches the render a tick after `mutate`, so a second
    // Enter in the same tick would still see it false; the mutation cache
    // knows at once.
    if (queryClient.isMutating({ mutationKey: SAVE_KEY }) > 0) return;
    save.mutate(name.trim());
  };

  return (
    <CenteredScreen
      title="Name your assistant"
      // Non-breaking spaces keep "Settings > Assistants" on one line: the
      // place name reads as one thing and must not wrap after the ">".
      lead={
        "Your assistant is an agent you talk to in this controller. You can rename it later in Settings\u00a0>\u00a0Assistants."
      }
    >
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <Field
          id="assistant-name"
          label="Name"
          error={save.isError ? readErrorMessage(save.error) : undefined}
        >
          <Input
            id="assistant-name"
            name="name"
            autoComplete="off"
            autoFocus
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </Field>
        <Button
          type="submit"
          variant="form"
          disabled={name.trim() === "" || save.isPending}
          className="mt-2 w-full justify-center py-2"
        >
          Continue
        </Button>
      </form>
    </CenteredScreen>
  );
}
