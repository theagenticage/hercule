import type { JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  buildAssistantDraft,
  buildAssistantProviderField,
  buildAssistantUpdate,
  buildIdOptions,
  describeWhenAssistantChangesApply,
  formatAccessMode,
  setDisallowedTool,
  type AssistantDraft,
} from "@hercule/client-core";
import {
  ACCESS_MODE_CHAIN,
  type AccessMode,
  type Assistant,
  type AssistantReply,
  type DisallowedTool,
} from "@hercule/contract";
import { profilesQuery, providersQuery } from "../../../../../app/queries";
import type { SavedField } from "../../../../../app/saved-field";
import { ShieldIcon } from "../../../../../icons/shield";
import { DisallowedToolsRow } from "../../../../../screens/settings/assistants/disallowed-tools-row";
import { SettingRow } from "../../../../../screens/settings/setting-row";
import { SettingTextRow } from "../../../../../screens/settings/setting-text-row";
import { useTextDraft } from "../../../../../screens/settings/use-text-draft";
import { ProviderLogo } from "../../../../../screens/thread/provider-logo";
import { useSavedAssistantField } from "./-saved-assistant-field";

const REPLY_MODES: ReadonlyArray<{ readonly value: AssistantReply; readonly label: string }> = [
  { value: "turn-end", label: "Turn end" },
  { value: "segments", label: "Segments" },
];

/**
 * Renders "How <name> works": the assistant's name, persona, provider and
 * model, permission profile, access mode, disallowed tools and reply mode.
 * Each row saves on its own, as soon as its value changes. The lead says
 * when a saved change reaches the assistant's session (spec 12 §7).
 */
export function HowItWorksSection({ assistant }: { readonly assistant: Assistant }): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const name = useSavedDraftField(assistant, "name");
  const persona = useSavedDraftField(assistant, "systemPrompt");
  const profile = useSavedDraftField(assistant, "permissionProfileId");
  const accessMode = useSavedDraftField(assistant, "accessMode");
  const reply = useSavedDraftField(assistant, "reply");
  const tools = useSavedAssistantField(
    client,
    assistant.id,
    assistant.disallowedTools,
    (value, change: DisallowedToolChange) =>
      setDisallowedTool(value, change.family, change.disallowed),
    (latest, change) => {
      const disallowedTools = setDisallowedTool(
        latest.disallowedTools,
        change.family,
        change.disallowed,
      );
      return disallowedTools === latest.disallowedTools ? {} : { disallowedTools };
    },
  );
  const profiles = useSuspenseQuery(profilesQuery(client)).data;
  const profileOptions = buildIdOptions(
    profiles.map(({ id, name: label }) => ({ id, label })),
    profile.value,
  );
  const nameInput = useTextDraft(name.value, name.save);
  return (
    <section className="set-sec">
      <h2>How {assistant.name} works</h2>
      <p className="changes-lead">{describeWhenAssistantChangesApply(assistant.name)}</p>
      <SettingRow
        label="Name"
        hint="The name it signs with, in the sidebar and in every channel."
        error={name.error}
        control={(labels) => (
          <span className="field">
            <input type="text" {...labels} {...nameInput} />
          </span>
        )}
      />
      <SettingTextRow
        label="Persona"
        hint={`Instructions added to every session ${assistant.name} starts, on top of the provider’s own.`}
        value={persona.value}
        error={persona.error}
        onCommit={persona.save}
      />
      <ProviderRow assistant={assistant} />
      <SettingRow
        label="Permission profile"
        hint="What its sessions may reach: folders, network and secrets."
        error={profile.error}
        control={(labels) => (
          <span className="field field--select">
            <select
              {...labels}
              value={profile.value}
              onChange={(event) => profile.save(event.target.value)}
            >
              {profileOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </span>
        )}
      />
      <SettingRow
        label="Access mode"
        hint="How much its sessions do without asking you first."
        error={accessMode.error}
        control={(labels) => (
          <span className="field field--select">
            <ShieldIcon size={14} />
            <select
              {...labels}
              value={accessMode.value}
              onChange={(event) => accessMode.save(event.target.value as AccessMode)}
            >
              {ACCESS_MODE_CHAIN.map((mode) => (
                <option key={mode} value={mode}>
                  {formatAccessMode(mode)}
                </option>
              ))}
            </select>
          </span>
        )}
      />
      <DisallowedToolsRow
        assistantName={assistant.name}
        tools={tools.value}
        unenforced={assistant.unenforced.includes("disallowedTools")}
        error={tools.error}
        onChange={(family, disallowed) => {
          tools.save({ family, disallowed });
        }}
      />
      <SettingRow
        label="Reply mode"
        hint="One message when the turn ends, or each part as it is written."
        error={reply.error}
        control={(labels) => (
          <div className="seg" role="group" {...labels}>
            {REPLY_MODES.map((mode) => (
              <button
                key={mode.value}
                type="button"
                aria-pressed={reply.value === mode.value}
                onClick={() => {
                  if (reply.value !== mode.value) reply.save(mode.value);
                }}
              >
                {mode.label}
              </button>
            ))}
          </div>
        )}
      />
    </section>
  );
}

/**
 * Renders the Provider row: one menu that picks both the provider instance
 * and the model on it. The hint is the account the instance is logged in as.
 */
function ProviderRow({ assistant }: { readonly assistant: Assistant }): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const instances = useSuspenseQuery(providersQuery(client)).data;
  const provider = useSavedAssistantField(
    client,
    assistant.id,
    { instanceId: assistant.instanceId, model: assistant.model?.model ?? null },
    (_value, picked: ProviderChoice) => picked,
    (latest, picked) => buildAssistantUpdate(latest, { ...buildAssistantDraft(latest), ...picked }),
  );
  // The field is built for the value on screen, so a pick that is still
  // saving shows its own instance's logo and account.
  const field = buildAssistantProviderField(instances, provider.value);
  return (
    <SettingRow
      label="Provider"
      hint={field.hint}
      error={provider.error}
      control={(labels) => (
        <span className="field field--select">
          {field.providerId !== null && <ProviderLogo providerId={field.providerId} size={13} />}
          <select
            {...labels}
            value={encodeProviderChoice(provider.value)}
            onChange={(event) => provider.save(JSON.parse(event.target.value) as ProviderChoice)}
          >
            {field.groups.map((group) => (
              <optgroup key={group.instanceId} label={group.label}>
                {group.choices.map((choice) => (
                  <option key={choice.model ?? ""} value={encodeProviderChoice(choice)}>
                    {choice.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </span>
      )}
    />
  );
}

/** An assistant's provider instance and the model on it, as the Provider row picks them. */
type ProviderChoice = Pick<AssistantDraft, "instanceId" | "model">;

/** A disallowed tools change: one tool family added to the list or removed from it. */
interface DisallowedToolChange {
  readonly family: DisallowedTool;
  readonly disallowed: boolean;
}

/** Returns the select's value for an instance and a model: both, as JSON, in a fixed key order. */
const encodeProviderChoice = ({ instanceId, model }: ProviderChoice): string =>
  JSON.stringify({ instanceId, model });

/**
 * Returns one scalar field of the form as a saved field: a change saves
 * that field alone, built onto the assistant as the cache holds it when the
 * save starts. A value equal to the stored one saves nothing.
 */
function useSavedDraftField<Field extends keyof AssistantDraft>(
  assistant: Assistant,
  field: Field,
): SavedField<AssistantDraft[Field]> {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  return useSavedAssistantField(
    client,
    assistant.id,
    buildAssistantDraft(assistant)[field],
    (_value, next: AssistantDraft[Field]) => next,
    (latest, next) =>
      buildAssistantUpdate(latest, { ...buildAssistantDraft(latest), [field]: next }),
  );
}
