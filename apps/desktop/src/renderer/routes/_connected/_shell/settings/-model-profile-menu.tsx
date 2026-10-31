import { useMemo, useRef, useState, type HTMLAttributes, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import {
  addModelProfileAccount,
  buildModelProfileSections,
  buildProviderAccountName,
  describeProviderAccountIdentity,
  findProviderPluginId,
  makeDefaultModelProfileEntry,
  moveModelProfileAccount,
  moveModelProfileEntry,
  moveModelProfileEntryToHarness,
  offerModelProfileEntryIn,
  readErrorMessage,
  setModelProfileAccountHarness,
  setModelProfileEntryIncluded,
  takeOutModelProfileEntry,
  type HerculeClient,
} from "@hercule/client-core";
import type { ModelProfile, ModelProfileUpdateInput } from "@hercule/contract";
import {
  harnessesQuery,
  pluginsQuery,
  providerAccountsQuery,
  providersQuery,
  runnersQuery,
} from "../../../../app/queries";
import { AddProfileAccount } from "../../../../screens/settings/providers/add-profile-account";
import { ModelProfileSection } from "../../../../screens/settings/providers/model-profile-section";
import { ProfileTeaching } from "../../../../screens/settings/providers/profile-teaching";
import { ProviderMark } from "../../../../screens/settings/providers/provider-mark";
import { useDragReorder } from "../../../../screens/settings/providers/use-drag-reorder";
import { useOptimisticOrder } from "../../../../screens/settings/providers/use-optimistic-order";
import "../../../../screens/settings/providers/models.css";
import { useModelProfileUpdate } from "./-model-profile-cache";
import { ModelProfilePreview } from "./-model-profile-preview";
import { AccountModelPicker } from "./-models-picker";

/**
 * Renders the menu of the open Model Profile `profile`: one section for
 * each account in it, in the profile's order. Each change the user makes,
 * whether a drop, an Alt+arrow, "Make it the default", "Take out of the
 * menu" or a model picked, is one `modelProfile.update` that carries the
 * revision the page read. When the controller reports a conflict, the
 * profile is read again and the same change is applied to it
 * (`updateModelProfile`). Saves go one after the other, each built from the
 * newest profile the page holds, so quick key presses do not conflict with
 * one another.
 *
 * The caller gives it a `key` of the profile's id, so opening another
 * profile starts the menu afresh: the order being dragged, the pending
 * picks and the last save's error belong to one profile. A save the user
 * started in the profile they left still finishes, and writes only to that
 * profile.
 *
 * `flashProviderAccountId` is the account just added to the profile, whose
 * section flashes once. So does the section of an account the user joins to
 * the profile from the page itself, through "Add an account to <profile>"
 * or a tile of the empty profile; both join it with its provider's Default
 * Selection. `onOpenAccount` opens the sheet of an account, from "Change
 * it" in the harness pill's popover; it gets the account's id and name.
 * `onAddAccount` opens the add-account sheet, which joins the new account
 * to this profile when it is done.
 *
 * Beside the sections, or under them in a narrow body, the preview shows
 * the composer's menu with this profile unfolded (`ModelProfilePreview`).
 * The pointer on a section lights the same lane in the preview, and the
 * pointer on a lane lights the section.
 *
 * Everything it reads is a shell read that the live connection keeps
 * current, so opening the section sends no request.
 */
export function ModelProfileMenu({
  client,
  profile,
  flashProviderAccountId,
  onAddAccount,
  onOpenAccount,
}: {
  readonly client: HerculeClient;
  readonly profile: ModelProfile;
  readonly flashProviderAccountId: string | null;
  readonly onAddAccount: () => void;
  readonly onOpenAccount: (providerAccountId: string, name: string) => void;
}): JSX.Element {
  const accounts = useSuspenseQuery(providerAccountsQuery(client)).data;
  const providers = useSuspenseQuery(providersQuery(client)).data;
  const harnesses = useSuspenseQuery(harnessesQuery(client)).data;
  const runners = useSuspenseQuery(runnersQuery(client)).data;
  const plugins = useSuspenseQuery(pluginsQuery(client)).data;

  const save = useModelProfileUpdate(client);

  /** Saves one change and resolves when the save is over, whether it worked or not; a failure shows above the sections. */
  const change = (buildChange: (profile: ModelProfile) => ModelProfileUpdateInput): Promise<void> =>
    save.mutateAsync({ profileId: profile.id, buildChange }).then(
      () => undefined,
      () => undefined,
    );
  // What the user last asked for each model in the picker, until the save that
  // carries it is over. A second click before the first save is answered
  // reads the page as it was drawn, so it would ask for the same thing twice.
  const wanted = useRef(new Map<string, boolean>());
  // Memoized by hand: the React Compiler does not cache this call, and a build
  // takes 2 to 6 ms, which the pointer entering a section would pay each time.
  const sections = useMemo(
    () => buildModelProfileSections(profile, { accounts, providers, harnesses, runners }),
    [profile, accounts, providers, harnesses, runners],
  );
  const order = useOptimisticOrder(sections.map(({ providerAccountId }) => providerAccountId));
  const moveSection = (providerAccountId: string, toIndex: number): Promise<void> =>
    order.move(providerAccountId, toIndex, () =>
      change((current) => moveModelProfileAccount(current, providerAccountId, toIndex)),
    );
  const sectionDrag = useDragReorder(order.keys, (providerAccountId, toIndex) => {
    void moveSection(providerAccountId, toIndex);
  });

  // The account the user last joined to the profile from this page, whose section flashes once.
  const [joinedProviderAccountId, setJoinedProviderAccountId] = useState<string | null>(null);
  const joinAccount = (providerAccountId: string): void => {
    setJoinedProviderAccountId(providerAccountId);
    void change((current) => addModelProfileAccount(current, providerAccountId));
  };
  const choices = accounts
    .filter(({ id }) => !profile.accounts.some(({ providerAccountId }) => providerAccountId === id))
    .map((account) => ({
      providerAccountId: account.id,
      name: buildProviderAccountName(providers, account),
      pluginId: findProviderPluginId(providers, account),
      identity: describeProviderAccountIdentity(providers, account),
    }));

  // The account whose section or lane the pointer is on, which lights both.
  const [litProviderAccountId, setLitProviderAccountId] = useState<string | null>(null);
  const leave = (providerAccountId: string): void => {
    setLitProviderAccountId((lit) => (lit === providerAccountId ? null : lit));
  };

  /** Returns the props of an account's section: the drop target, and the pointer that lights its lane in the preview. */
  const buildSectionProps = (providerAccountId: string): HTMLAttributes<HTMLElement> => {
    const lit: Record<string, string> =
      providerAccountId === litProviderAccountId ? { "data-lit": "true" } : {};
    return {
      ...sectionDrag.getTargetProps(providerAccountId),
      ...lit,
      onPointerEnter: () => {
        setLitProviderAccountId(providerAccountId);
      },
      onPointerLeave: () => {
        leave(providerAccountId);
      },
    };
  };

  const byId = new Map(sections.map((section) => [section.providerAccountId, section]));
  // Built when the sections change, not when the pointer moves, so a section's
  // picker is handed the same set while the pointer crosses the page.
  const heldBySection = useMemo(
    () =>
      new Map(
        sections.map((section) => [
          section.providerAccountId,
          new Set(section.sectionHarnessModels),
        ]),
      ),
    [sections],
  );
  return (
    <>
      {save.isError ? (
        <p className="pm-err" role="alert">
          {`The change was not saved. ${readErrorMessage(save.error)}`}
        </p>
      ) : null}
      {sections.length === 0 ? (
        <ProfileTeaching
          profileName={profile.name}
          choices={choices}
          plugins={plugins}
          onJoin={joinAccount}
          onNewAccount={onAddAccount}
        />
      ) : (
        <div className="pm-build">
          <div className="pm-list">
            {order.keys.flatMap((providerAccountId) => {
              const section = byId.get(providerAccountId);
              if (section === undefined) return [];
              const held = heldBySection.get(providerAccountId) ?? new Set<string>();
              return (
                <ModelProfileSection
                  key={providerAccountId}
                  section={section}
                  mark={<ProviderMark pluginId={section.pluginId} plugins={plugins} size={13} />}
                  profileName={profile.name}
                  isNew={
                    providerAccountId === flashProviderAccountId ||
                    providerAccountId === joinedProviderAccountId
                  }
                  drag={{
                    headProps: sectionDrag.getSourceProps(providerAccountId),
                    sectionProps: buildSectionProps(providerAccountId),
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
                  onSetHarness={(harnessId) => {
                    void change((current) =>
                      setModelProfileAccountHarness(current, providerAccountId, harnessId),
                    );
                  }}
                  onOpenAccount={onOpenAccount}
                  onMakeDefault={(entry) => {
                    void change((current) => makeDefaultModelProfileEntry(current, entry));
                  }}
                  onMoveToHarness={(entry, harnessId) => {
                    void change((current) =>
                      moveModelProfileEntryToHarness(current, entry, harnessId),
                    );
                  }}
                  onAlsoOfferIn={(entry, harnessId) => {
                    void change((current) => offerModelProfileEntryIn(current, entry, harnessId));
                  }}
                  onTakeOut={(entry) => {
                    void change((current) => takeOutModelProfileEntry(current, entry));
                  }}
                />
              );
            })}
            <AddProfileAccount
              profileName={profile.name}
              choices={choices}
              plugins={plugins}
              onJoin={joinAccount}
              onNewAccount={onAddAccount}
            />
          </div>
          <ModelProfilePreview
            client={client}
            profile={profile}
            highlightedAccountId={litProviderAccountId}
            onEnterLane={setLitProviderAccountId}
            onLeaveLane={leave}
          />
        </div>
      )}
    </>
  );
}
