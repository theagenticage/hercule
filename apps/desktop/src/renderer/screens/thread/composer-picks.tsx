import type { JSX } from "react";
import {
  buildOptionsLabel,
  type ModelPill,
  type RecentModel,
  type ThreadCatalogs,
  type ThreadChoice,
  type ThreadConfig,
  type ThreadKind,
} from "@hercule/client-core";
import type { ModelOption } from "@hercule/contract";
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
 * logo, the account and the model, as a trigger that opens the model menu,
 * see `ModelMenu`.
 *
 * `pill` is what the trigger shows, and `catalogs`, `config` and `kind` are
 * what the menu is built from. `readRecent` returns the Recent list, which
 * the menu reads when it opens. `onChoose` receives the choice a row makes,
 * and the menu then closes. `disabled` leaves the trigger drawn but unable to
 * open the menu.
 */
export function ModelPick({
  pill,
  catalogs,
  config,
  kind,
  disabled,
  readRecent,
  onChoose,
}: {
  readonly pill: ModelPill;
  readonly catalogs: ThreadCatalogs;
  readonly config: ThreadConfig;
  readonly kind: ThreadKind;
  readonly disabled: boolean;
  readonly readRecent: () => readonly RecentModel[];
  readonly onChoose: (choice: ThreadChoice) => void;
}): JSX.Element {
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
        </>
      }
    >
      {(close) => (
        <ModelMenu
          catalogs={catalogs}
          config={config}
          kind={kind}
          readRecent={readRecent}
          onChoose={(choice) => {
            onChoose(choice);
            close();
          }}
        />
      )}
    </ComposerMenu>
  );
}
