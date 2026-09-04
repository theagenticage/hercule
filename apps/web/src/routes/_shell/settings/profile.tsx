import { useState, type FormEvent, type JSX } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { FALLBACK_TIMEZONE } from "@hydra/client-core";
import { Button, Row, SettingsForm } from "@hydra/ui";
import { LOGIN_PATH } from "../../../app/entry-guard";
import { settingsQuery } from "../../../app/queries";
import { TimezoneField } from "../../../screens/timezone-field";
import { SaveStatus, useSaveSettings } from "./-form";

export const Route = createFileRoute("/_shell/settings/profile")({
  staticData: { title: "Profile" },
  component: Profile,
});

/**
 * The user's timezone: the one zone the whole system reads times in. It is set
 * during onboarding from the browser and changed here, and onboarding is what
 * guarantees there is one to show.
 */
function Profile(): JSX.Element {
  const { client, queryClient } = Route.useRouteContext();
  const navigate = useNavigate();
  const settings = useSuspenseQuery(settingsQuery(client)).data;
  const { save, saving, saved, failure } = useSaveSettings(client, queryClient);

  const [timezone, setTimezone] = useState(settings.user.timezone ?? FALLBACK_TIMEZONE);
  const [signingOut, setSigningOut] = useState(false);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    void save({ user: { timezone } });
  };

  /**
   * Sign out: revoke the bearer at the controller, and drop it here whatever
   * the controller answered. A token this browser has thrown away cannot be
   * presented again, so a failed revocation must not leave the user signed in.
   *
   * What this screen read is dropped only once the login screen is up. Clearing
   * it first evicts a query this screen is still subscribed to, which refetches
   * it with no bearer and turns the answer into a failure screen racing the
   * navigation.
   */
  const signOut = async (): Promise<void> => {
    setSigningOut(true);
    try {
      await client.auth.logout();
    } catch {
      // The revocation is the controller's to record; this browser is done
      // with the token either way.
    }
    client.setToken(null);
    await navigate({ to: LOGIN_PATH });
    queryClient.clear();
  };

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={submit}>
        <SettingsForm
          label="Profile"
          fine="Schedules, ages and every time on screen are read in this zone."
        >
          <Row label="Timezone" htmlFor="timezone">
            <TimezoneField value={timezone} onChange={setTimezone} />
          </Row>
          <div className="flex items-center gap-3 pt-2">
            <Button type="submit" variant="form" disabled={saving}>
              Save
            </Button>
            <SaveStatus saved={saved} failure={failure} />
          </div>
        </SettingsForm>
      </form>

      <SettingsForm
        label="Session"
        fine="This browser keeps you signed in until you sign out or the login expires."
      >
        <div className="pt-1">
          <Button type="button" variant="form" disabled={signingOut} onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </SettingsForm>
    </div>
  );
}
