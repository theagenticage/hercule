import { useState, type FormEvent, type JSX } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { FALLBACK_TIMEZONE } from "@hercule/client-core";
import { Button, FormCard, Row } from "@hercule/ui";
import { LOGIN_PATH } from "../../../app/entry-guard";
import { settingsQuery } from "../../../app/queries";
import { TimezoneField } from "../../../screens/timezone-field";
import { SaveStatus } from "../../../screens/save-status";
import { useSaveSettings } from "./-form";

export const Route = createFileRoute("/_shell/settings/profile")({
  staticData: { title: "Profile" },
  component: Profile,
});

/**
 * The Profile screen: the user's timezone, and signing out.
 *
 * The whole system shows times in this one timezone. Onboarding sets it from
 * the browser, so there is always one to show; the user changes it here.
 */
function Profile(): JSX.Element {
  const { client, queryClient } = Route.useRouteContext();
  const navigate = useNavigate();
  const settings = useSuspenseQuery(settingsQuery(client)).data;
  const { save, saving, saved, failure } = useSaveSettings(client);

  const [timezone, setTimezone] = useState(settings.user.timezone ?? FALLBACK_TIMEZONE);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    save({ user: { timezone } });
  };

  /**
   * Signs out: revokes the bearer token at the controller, then forgets it in
   * this browser whatever the controller returned.
   *
   * - The local part runs when the mutation settles, not only when it
   *   succeeds. A failed revocation must not leave the user signed in, and a
   *   token this browser has discarded cannot be sent again anyway.
   * - The query cache is cleared only after the login screen is showing.
   *   Clearing it first would evict a query this screen still uses; that
   *   query would refetch without a token, and its failure screen would race
   *   the navigation.
   * - The navigation also closes the live connection, because the entry guard
   *   keeps it open only while there is a token.
   */
  const signOut = useMutation({
    mutationFn: () => client.auth.logout(),
    onSettled: async () => {
      client.setToken(null);
      await navigate({ to: LOGIN_PATH });
      queryClient.clear();
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={submit}>
        <FormCard
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
        </FormCard>
      </form>

      <FormCard
        label="Session"
        fine="This browser keeps you signed in until you sign out or the login expires."
      >
        <div className="pt-1">
          <Button
            type="button"
            variant="form"
            disabled={signOut.isPending}
            onClick={() => {
              signOut.mutate();
            }}
          >
            Sign out
          </Button>
        </div>
      </FormCard>
    </div>
  );
}
