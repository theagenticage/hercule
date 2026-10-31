import { useRef, type JSX } from "react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import {
  buildModelProfileSections,
  makeDefaultModelProfileEntry,
  moveModelProfileAccount,
  moveModelProfileEntry,
  readErrorMessage,
  setModelProfileEntryIncluded,
  takeOutModelProfileEntry,
  updateModelProfile,
  type HerculeClient,
} from "@hercule/client-core";
import type { ModelProfile, ModelProfileUpdateInput } from "@hercule/contract";
import {
  harnessesQuery,
  modelProfilesQuery,
  pluginsQuery,
  providerAccountsQuery,
  providersQuery,
} from "../../../../app/queries";
import { ModelProfileSection } from "../../../../screens/settings/providers/model-profile-section";
import { ProviderMark } from "../../../../screens/settings/providers/provider-mark";
import { useDragReorder } from "../../../../screens/settings/providers/use-drag-reorder";
import { useOptimisticOrder } from "../../../../screens/settings/providers/use-optimistic-order";
import "../../../../screens/settings/providers/models.css";
import { AccountModelPicker } from "./-models-picker";

/**
 * Renders Settings > Providers > Models in its one-profile form: the only
 * Model Profile, one section for each account in it, in the profile's order.
 * Each change the user makes, whether a drop, an Alt+arrow, "Make it the
 * default", "Take out of the menu" or a model picked, is one
 * `modelProfile.update` that carries the revision the page read. When the
 * controller reports a conflict, the profile is read again and the same change
 * is applied to it (`updateModelProfile`). Saves go one after the other, each
 * built from the newest profile the page holds, so quick key presses do not
 * conflict with one another.
 *
 * `flashProviderAccountId` is the account just added to the profile, whose
 * section flashes once.
 *
 * Everything it reads is a shell read that the live connection keeps current,
 * so opening the section sends no request.
 */
export function ModelsSection({
  client,
  flashProviderAccountId,
}: {
  readonly client: HerculeClient;
  readonly flashProviderAccountId: string | null;
}): JSX.Element | null {
  const queryClient = useQueryClient();
  const profile = useSuspenseQuery(modelProfilesQuery(client)).data[0];
  const accounts = useSuspenseQuery(providerAccountsQuery(client)).data;
  const providers = useSuspenseQuery(providersQuery(client)).data;
  const harnesses = useSuspenseQuery(harnessesQuery(client)).data;
  const plugins = useSuspenseQuery(pluginsQuery(client)).data;

  const save = useMutation({
    scope: { id: "model-profile" },
    mutationFn: ({
      profileId,
      buildChange,
    }: {
      readonly profileId: string;
      readonly buildChange: (profile: ModelProfile) => ModelProfileUpdateInput;
    }) => {
      // The newest profile the page holds, not the one the user acted on: a
      // save that ran before this one has changed its revision.
      const newest = queryClient
        .getQueryData(modelProfilesQuery(client).queryKey)
        ?.find(({ id }) => id === profileId);
      if (newest === undefined) throw new Error("The profile is gone.");
      return updateModelProfile(client, newest, buildChange);
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(modelProfilesQuery(client).queryKey, (list) =>
        list?.map((each) => (each.id === saved.id ? saved : each)),
      );
    },
  });

  /** Saves one change and resolves when the save is over, whether it worked or not; a failure shows above the sections. */
  const change = (
    buildChange: (profile: ModelProfile) => ModelProfileUpdateInput,
  ): Promise<void> =>
    profile === undefined
      ? Promise.resolve()
      : save.mutateAsync({ profileId: profile.id, buildChange }).then(
          () => undefined,
          () => undefined,
        );
  // What the user last asked for each model in the picker, until the save that
  // carries it is over. A second click before the first save is answered
  // reads the page as it was drawn, so it would ask for the same thing twice.
  const wanted = useRef(new Map<string, boolean>());
  const sections =
    profile === undefined
      ? []
      : buildModelProfileSections(profile, { accounts, providers, harnesses });
  const order = useOptimisticOrder(sections.map(({ providerAccountId }) => providerAccountId));
  const moveSection = (providerAccountId: string, toIndex: number): Promise<void> =>
    order.move(providerAccountId, toIndex, () =>
      change((current) => moveModelProfileAccount(current, providerAccountId, toIndex)),
    );
  const sectionDrag = useDragReorder(order.keys, (providerAccountId, toIndex) => {
    void moveSection(providerAccountId, toIndex);
  });
  if (profile === undefined) return null;

  const byId = new Map(sections.map((section) => [section.providerAccountId, section]));
  return (
    <section className="set-sec provider-models">
      <h2>Models</h2>
      <p className="pm-lead">
        The models you can use in Hercule, in the order the composer shows them.
      </p>
      {save.isError ? (
        <p className="pm-err" role="alert">
          {`The change was not saved. ${readErrorMessage(save.error)}`}
        </p>
      ) : null}
      {sections.length === 0 ? (
        <p className="pm-none">{`${profile.name} has no accounts yet. Add one to give the composer models.`}</p>
      ) : (
        <div className="pm-list">
          {order.keys.flatMap((providerAccountId) => {
            const section = byId.get(providerAccountId);
            if (section === undefined) return [];
            const held = new Set(section.sectionHarnessModels);
            return (
              <ModelProfileSection
                key={providerAccountId}
                section={section}
                mark={<ProviderMark pluginId={section.pluginId} plugins={plugins} size={13} />}
                profileName={profile.name}
                isNew={providerAccountId === flashProviderAccountId}
                drag={{
                  headProps: sectionDrag.getSourceProps(providerAccountId),
                  sectionProps: sectionDrag.getTargetProps(providerAccountId),
                  dropSide:
                    sectionDrag.dropMark?.key === providerAccountId
                      ? sectionDrag.dropMark.side
                      : null,
                  onMoveBy: (offset) => {
                    void moveSection(
                      providerAccountId,
                      order.keys.indexOf(providerAccountId) + offset,
                    );
                  },
                }}
                addModel={
                  <AccountModelPicker
                    client={client}
                    providerAccountId={providerAccountId}
                    name={section.name}
                    held={held}
                    onToggle={(model) => {
                      // The change is "hold it" or "do not hold it", decided
                      // here from what the user saw, so a retry on a newer
                      // profile does the same and never flips it back.
                      const key = `${providerAccountId}:${model}`;
                      const included = !(wanted.current.get(key) ?? held.has(model));
                      wanted.current.set(key, included);
                      void change((current) =>
                        setModelProfileEntryIncluded(current, providerAccountId, model, included),
                      ).then(() => {
                        if (wanted.current.get(key) === included) wanted.current.delete(key);
                      });
                    }}
                  />
                }
                onMoveEntry={(entry, toIndex) =>
                  change((current) => moveModelProfileEntry(current, entry, toIndex))
                }
                onMakeDefault={(entry) => {
                  void change((current) => makeDefaultModelProfileEntry(current, entry));
                }}
                onTakeOut={(entry) => {
                  void change((current) => takeOutModelProfileEntry(current, entry));
                }}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
