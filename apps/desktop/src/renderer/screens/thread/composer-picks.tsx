import type { JSX } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  buildOptionsLabel,
  resolveDisplayTimezone,
  type ModelPill,
  type RecentModel,
  type SignInTarget,
  type ThreadCatalogs,
  type ThreadChoice,
  type ThreadConfig,
  type ThreadKind,
} from "@hercule/client-core";
import type { ModelOption } from "@hercule/contract";
import { useModelProfileUpdate } from "../../app/model-profile-cache";
import { pluginsQuery, settingsQuery } from "../../app/queries";
import { readLastOpenProfileId, rememberOpenProfile } from "../../app/recent-models";
import { SlidersIcon } from "../../icons/sliders";
import { ComposerMenu } from "./composer-menu";
import { ModelMenu } from "./model-menu";
import { OptionsMenu } from "./options-menu";
import { HarnessLogo } from "./harness-logo";

/**
 * Renders the model options pick in a composer's row: the options' values in
 * one word, or "Model options", as a trigger that opens the options menu, see
 * `OptionsMenu`.
 *
 * `descriptors` are the options the model declares, `selected` the values in
 * use, and `modelName` the model's name for the menu's header. `onChoose`
 * receives the choice of each option the user sets. `disabled` leaves the
 * trigger drawn but unable to open the menu.
 */
export function OptionsPick({
  descriptors,
  selected,
  modelName,
  disabled,
  onChoose,
}: {
  readonly descriptors: readonly ModelOption[];
  readonly selected: Readonly<Record<string, string | boolean>>;
  readonly modelName: string | null;
  readonly disabled: boolean;
  readonly onChoose: (choice: ThreadChoice) => void;
}): JSX.Element {
  return (
    <ComposerMenu
      label="Model options"
      align="start"
      disabled={disabled}
      triggerClassName="pick"
      trigger={
        <>
          <SlidersIcon size={14} />
          {buildOptionsLabel(descriptors, selected) ?? "Model options"}
        </>
      }
    >
      {() => (
        <OptionsMenu
          descriptors={descriptors}
          selected={selected}
          modelName={modelName}
          onPick={(id, value) => {
            onChoose({ kind: "option", id, value });
          }}
        />
      )}
    </ComposerMenu>
  );
}

/**
 * Renders the model pick in a composer's row: the pill with the harness's
 * logo, the account, the model and "in pi" when the harness is not the
 * account's default, as a trigger that opens the model menu,
 * see `ModelMenu`.
 *
 * `pill` is what the trigger shows, and `catalogs`, `config`, `kind` and
 * `runnerId` are what the menu is built from; `runnerId` is the machine a
 * Draft Thread is bound to, or `null` while any machine will do. `readRecent`
 * returns the Recent list, which the menu reads when it opens. `onChoose`
 * receives the choice a row makes, and the menu then closes. `onSignIn`, when
 * given, puts a Sign in link on a row that signing in would fix, and the menu
 * closes before it is called. `disabled` leaves the trigger drawn but unable
 * to open the menu.
 *
 * The menu reads nothing from the controller when it opens: the profiles, the
 * accounts and the plugins are the shell's reads, already in the cache. So are
 * the settings that give the time zone, which only a Draft Thread's menu uses,
 * because only it announces new models: the new-thread route's loader caches
 * them, and a thread that has started never reads them. The menu reads the
 * profile open last from this device's storage, and stores the one the user
 * opens.
 *
 * Add and "Not now" on a "New" row save the profile through
 * `useModelProfileUpdate`, the way the Providers page does. They neither pick
 * the model nor close the menu: the `provider` live topic and the answer of
 * the save redraw the lane.
 */
export function ModelPick({
  pill,
  catalogs,
  config,
  kind,
  runnerId,
  disabled,
  readRecent,
  onChoose,
  onSignIn,
}: {
  readonly pill: ModelPill;
  readonly catalogs: ThreadCatalogs;
  readonly config: ThreadConfig;
  readonly kind: ThreadKind;
  readonly runnerId: string | null;
  readonly disabled: boolean;
  readonly readRecent: () => readonly RecentModel[];
  readonly onChoose: (choice: ThreadChoice) => void;
  readonly onSignIn?: ((target: SignInTarget) => void) | undefined;
}): JSX.Element {
  const { client, url } = useRouteContext({ from: "/_connected" }).controller;
  const plugins = useSuspenseQuery(pluginsQuery(client)).data;
  const settings = useQuery({ ...settingsQuery(client), enabled: kind === "draft" }).data;
  const saveProfile = useModelProfileUpdate(client);
  return (
    <ComposerMenu
      label="Model"
      align="end"
      width="wide"
      disabled={disabled}
      triggerClassName="pick pick--pill"
      trigger={
        <>
          {pill.harnessId === null ? null : <HarnessLogo harnessId={pill.harnessId} size={13} />}
          {pill.account === null ? null : <span className="faint">{pill.account}</span>}
          <span className="pick-name">{pill.name ?? "No model"}</span>
          {pill.inHarness === null ? null : <span className="faint">in {pill.inHarness}</span>}
        </>
      }
    >
      {(close) => (
        <ModelMenu
          catalogs={catalogs}
          plugins={plugins}
          config={config}
          kind={kind}
          runnerId={runnerId}
          timezone={resolveDisplayTimezone(settings?.user.timezone)}
          readRecent={readRecent}
          readLastOpenProfileId={() => readLastOpenProfileId(url)}
          rememberOpenProfile={(profileId) => {
            rememberOpenProfile(url, profileId);
          }}
          onChoose={(choice) => {
            onChoose(choice);
            close();
          }}
          onSignIn={
            onSignIn === undefined
              ? undefined
              : (target) => {
                  close();
                  onSignIn(target);
                }
          }
          saveProfile={saveProfile.mutateAsync}
        />
      )}
    </ComposerMenu>
  );
}
