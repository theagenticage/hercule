import { useState, type FormEvent, type JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { browserTimezone } from "@hydra/client-core";
import { Button, Input } from "@hydra/ui";
import { settingsQuery } from "../../../app/queries";
import { Row, SaveStatus, SettingsForm, useSaveSettings } from "./-form";

export const Route = createFileRoute("/_shell/settings/profile")({
  staticData: { title: "Profile" },
  component: Profile,
});

/**
 * The user's timezone: the one zone the whole system reads times in. It is set
 * during onboarding from the browser and changed here.
 */
function Profile(): JSX.Element {
  const { client, queryClient } = Route.useRouteContext();
  const settings = useSuspenseQuery(settingsQuery(client)).data;
  const { save, saving, saved, failure } = useSaveSettings(client, queryClient);

  const [timezone, setTimezone] = useState(settings.user.timezone ?? browserTimezone());

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    void save({ user: { timezone } });
  };

  return (
    <form onSubmit={submit}>
      <SettingsForm
        label="Profile"
        fine="Schedules, ages and every time on screen are read in this zone."
      >
        <Row label="Timezone" htmlFor="timezone">
          <Input
            id="timezone"
            name="timezone"
            value={timezone}
            onChange={(event) => {
              setTimezone(event.target.value);
            }}
          />
        </Row>
        <div className="-ml-2 flex items-center gap-3 pt-1.5">
          <Button type="submit" variant="primary" disabled={saving || timezone.length === 0}>
            Save
          </Button>
          <SaveStatus saved={saved} failure={failure} />
        </div>
      </SettingsForm>
    </form>
  );
}
