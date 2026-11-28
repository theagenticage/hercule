import { useState, type FormEvent, type JSX } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { addCompletedStep, isMutationRunning, readErrorMessage } from "@hercule/client-core";
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
 * Names the assistant that setup created. A fresh install has none, because
 * the first Provider Account creates it and the web app cannot add an account,
 * so the step then says where the assistant comes from and lets the user
 * continue. The step is recorded as done only after the rename succeeds, so a
 * refused write leaves the user on this step.
 */
function AssistantStep(): JSX.Element {
  const { client, queryClient } = Route.useRouteContext();
  const navigate = useNavigate();
  const settings = useSuspenseQuery(settingsQuery(client)).data;
  const shown = useSuspenseQuery(assistantsQuery(client)).data.items[0] ?? null;

  // The draft is null until the user types, so the field shows the assistant's
  // current name, also when the assistant only appears after the first render.
  const [draft, setDraft] = useState<string | null>(null);
  const name = draft ?? shown?.name ?? "";

  const save = useMutation({
    mutationKey: SAVE_KEY,
    mutationFn: async (typed: string) => {
      if (shown !== null) {
        await client.assistant.update({ params: { id: shown.id }, payload: { name: typed } });
        // The write changes the assistants list, which the sidebar shows the
        // name from. The conversation screen reads the one assistant instead,
        // and the live `assistant` topic refreshes that read.
        await queryClient.invalidateQueries({ queryKey: assistantsQuery(client).queryKey });
      }
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
    if (isMutationRunning(queryClient, SAVE_KEY)) return;
    save.mutate(name.trim());
  };

  const hasAssistant = shown !== null;
  return (
    <CenteredScreen
      title={hasAssistant ? "Name your assistant" : "Your assistant comes with your first account"}
      // Non-breaking spaces keep "Settings > Assistants" on one line: the
      // place name reads as one thing and must not wrap after the ">".
      lead={
        hasAssistant
          ? "Your assistant is an agent you talk to in this controller. You can rename it later in Settings\u00a0>\u00a0Assistants."
          : "The assistant appears when your first Provider Account is ready. The web app cannot add one: use the desktop app, or run hercule provider-account create (see its --help). You can name the assistant then, in Settings\u00a0>\u00a0Assistants."
      }
    >
      <form className="flex flex-col gap-4" onSubmit={submit}>
        {hasAssistant ? (
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
                setDraft(event.target.value);
              }}
            />
          </Field>
        ) : save.isError ? (
          <p className="text-fine text-fail" role="alert">
            {readErrorMessage(save.error)}
          </p>
        ) : null}
        <Button
          type="submit"
          variant="form"
          disabled={(hasAssistant && name.trim() === "") || save.isPending}
          className={
            hasAssistant ? "mt-2 w-full justify-center py-2" : "w-full justify-center py-2"
          }
        >
          Continue
        </Button>
      </form>
    </CenteredScreen>
  );
}
