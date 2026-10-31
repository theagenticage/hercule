import { useState, type JSX } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import type { ModelProfile } from "@hercule/contract";
import "../../../../screens/settings/providers/models.css";
import { addCachedModelProfile } from "./-model-profile-cache";
import { ModelProfileMenu } from "./-model-profile-menu";
import { ModelProfileTabs } from "./-model-profile-tabs";
import { NewModelProfileDialog } from "./-new-model-profile-dialog";
import { useOpenModelProfile } from "./-open-model-profile";

/**
 * Renders Settings > Providers > Models: the lead, the profile tabs when there
 * are two or more Model Profiles, and the menu of the open profile
 * (`ModelProfileMenu`). The open profile is the one the URL names, as
 * `useOpenModelProfile` reads it.
 *
 * The lead's "create several profiles" (with one profile) and the "New
 * profile" tab both open the New profile dialog, which starts empty or as a
 * copy of the open profile and opens the new profile's tab.
 *
 * `flashProviderAccountId` is the account just added to the open profile,
 * whose section flashes once. `onAddAccount` opens the add-account sheet,
 * which the page owns; the profile's "New account…" calls it.
 *
 * Everything it reads is a shell read that the live connection keeps current,
 * so opening the section sends no request.
 */
export function ModelsSection({
  client,
  flashProviderAccountId,
  onAddAccount,
}: {
  readonly client: HerculeClient;
  readonly flashProviderAccountId: string | null;
  readonly onAddAccount: () => void;
}): JSX.Element | null {
  const queryClient = useQueryClient();
  const { profile, profiles, openProfile } = useOpenModelProfile(client);
  const [creating, setCreating] = useState(false);
  if (profile === undefined) return null;

  const hasTabs = profiles.length > 1;
  return (
    <section className={hasTabs ? "set-sec provider-models has-tabs" : "set-sec provider-models"}>
      <h2>Models</h2>
      <p className="pm-lead">
        The models you can use in Hercule, in the order the composer shows them.{" "}
        {hasTabs ? (
          "Each profile is its own set; you can create as many as you like."
        ) : (
          <>
            You can also{" "}
            <button
              type="button"
              className="pm-link"
              onClick={() => {
                setCreating(true);
              }}
            >
              create several profiles
            </button>
            , each with its own set.
          </>
        )}
      </p>
      {hasTabs ? (
        <ModelProfileTabs
          client={client}
          onNew={() => {
            setCreating(true);
          }}
        />
      ) : null}
      <ModelProfileMenu
        key={profile.id}
        client={client}
        profile={profile}
        flashProviderAccountId={flashProviderAccountId}
        onAddAccount={onAddAccount}
      />
      {creating ? (
        <NewModelProfileDialog
          copyOf={profile}
          onCreated={(created: ModelProfile) => {
            addCachedModelProfile(queryClient, client, created);
            openProfile(created.id);
          }}
          onClose={() => {
            setCreating(false);
          }}
        />
      ) : null}
    </section>
  );
}
