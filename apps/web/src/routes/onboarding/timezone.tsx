import { useState, type FormEvent, type JSX } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { browserTimezone } from "@hercule/client-core";
import { Button, Field } from "@hercule/ui";
import { HOME_PATH } from "../../app/entry-guard";
import { settingsQuery } from "../../app/queries";
import { CenteredScreen } from "../../screens/centered-screen";
import { TimezoneField } from "../../screens/timezone-field";

/** The id this step records when it is done. */
const STEP = "timezone";

export const Route = createFileRoute("/onboarding/timezone")({
  staticData: { title: "Confirm your timezone" },
  component: TimezoneStep,
});

function TimezoneStep(): JSX.Element {
  const { client, queryClient } = Route.useRouteContext();
  const navigate = useNavigate();
  const settings = useSuspenseQuery(settingsQuery(client)).data;

  const [timezone, setTimezone] = useState(settings.user.timezone ?? browserTimezone());
  const [failure, setFailure] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setFailure(null);
    setSubmitting(true);

    const completed = settings.user["onboarding.completedSteps"] ?? [];
    try {
      const updated = await client.settings.update({
        payload: {
          user: {
            timezone,
            "onboarding.completedSteps": [...completed, STEP],
          },
        },
      });
      queryClient.setQueryData(settingsQuery(client).queryKey, updated);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
      setSubmitting(false);
      return;
    }

    await navigate({ to: HOME_PATH });
  };

  return (
    <CenteredScreen
      title="Confirm your timezone"
      lead="Hercule reads every time in this zone: schedules, ages, and what happened since you last looked."
    >
      <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
        <Field id="timezone" label="Timezone">
          <TimezoneField value={timezone} onChange={setTimezone} />
        </Field>
        {failure === null ? null : (
          <p className="text-fine text-fail" role="alert">
            {failure}
          </p>
        )}
        <Button
          type="submit"
          variant="form"
          disabled={submitting}
          className="mt-2 w-full justify-center py-2"
        >
          Continue
        </Button>
      </form>
    </CenteredScreen>
  );
}
