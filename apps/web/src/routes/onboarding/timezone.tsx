import { useState, type FormEvent, type JSX } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import {
  addCompletedStep,
  isMutationRunning,
  resolveBrowserTimezone,
  readErrorMessage,
} from "@hercule/client-core";
import { Button, Field } from "@hercule/ui";
import { HOME_PATH } from "../../app/entry-guard";
import { settingsQuery } from "../../app/queries";
import { CenteredScreen } from "../../screens/centered-screen";
import { TimezoneField } from "../../screens/timezone-field";

/** The key of this step's save, so a second submit can see that one is running. */
const SAVE_KEY = ["onboarding-timezone"];

export const Route = createFileRoute("/onboarding/timezone")({
  staticData: { title: "Confirm your timezone" },
  component: TimezoneStep,
});

function TimezoneStep(): JSX.Element {
  const { client, queryClient } = Route.useRouteContext();
  const navigate = useNavigate();
  const settings = useSuspenseQuery(settingsQuery(client)).data;

  const [timezone, setTimezone] = useState(settings.user.timezone ?? resolveBrowserTimezone());
  const save = useMutation({
    mutationKey: SAVE_KEY,
    mutationFn: (zone: string) =>
      client.settings.update({
        payload: {
          user: {
            timezone: zone,
            "onboarding.completedSteps": addCompletedStep(
              settings.user["onboarding.completedSteps"] ?? [],
              "timezone",
            ),
          },
        },
      }),
    onSuccess: async (updated) => {
      queryClient.setQueryData(settingsQuery(client).queryKey, updated);
      await navigate({ to: HOME_PATH });
    },
  });

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (isMutationRunning(queryClient, SAVE_KEY)) return;
    save.mutate(timezone);
  };

  return (
    <CenteredScreen
      title="Confirm your timezone"
      lead="Hercule uses this zone for all times: schedules, ages, and what happened since you last looked."
    >
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <Field id="timezone" label="Timezone">
          <TimezoneField value={timezone} onChange={setTimezone} />
        </Field>
        {save.isError ? (
          <p className="text-fine text-fail" role="alert">
            {readErrorMessage(save.error)}
          </p>
        ) : null}
        <Button
          type="submit"
          variant="form"
          disabled={save.isPending}
          className="mt-2 w-full justify-center py-2"
        >
          Continue
        </Button>
      </form>
    </CenteredScreen>
  );
}
