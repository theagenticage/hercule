import { useState, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { computeHeartbeatNow, type Pose } from "@hercule/client-core";
import type { Assistant, Heartbeat, Rotation } from "@hercule/contract";
import { settingsQuery } from "../../../../../app/queries";
import { buildHueStyle, buildLook, Face } from "../../../../../faces";
import { HeartbeatSection } from "../../../../../screens/settings/assistants/heartbeat-section";
import { RotationSection } from "../../../../../screens/settings/assistants/rotation-section";
import { DeleteSection } from "./-delete-section";
import { HowItWorksSection } from "./-how-it-works-section";
import { useSavedAssistantField } from "./-saved-assistant-field";

/**
 * Renders the settings of one assistant, in its hue: its face and name, how
 * it works, its heartbeat, its rotation, and Delete. `onDeleted` is called
 * with the assistant's id once it is deleted.
 */
export function AssistantRecord({
  assistant,
  pose,
  onDeleted,
}: {
  readonly assistant: Assistant;
  readonly pose: Pose;
  readonly onDeleted: (id: string) => void;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const settings = useSuspenseQuery(settingsQuery(client)).data;
  // The time is read once, when the record opens: the heartbeat's "now" mark
  // does not move while the section is open, so the app does no work while idle.
  const [openedAt] = useState(() => new Date());
  const heartbeat = useSavedAssistantField(
    client,
    assistant.id,
    assistant.heartbeat,
    (value, change: Partial<Omit<Heartbeat, "prompt">>) => ({ ...value, ...change }),
    (latest, change) => ({ heartbeat: { ...latest.heartbeat, ...change } }),
  );
  // The prompt saves on its own, so a failed save shows under its row and
  // not under the schedule.
  const prompt = useSavedAssistantField(
    client,
    assistant.id,
    assistant.heartbeat.prompt,
    (_value, change: string) => change,
    (latest, change) => ({ heartbeat: { ...latest.heartbeat, prompt: change } }),
  );
  const rotation = useSavedAssistantField(
    client,
    assistant.id,
    assistant.rotation,
    (value, change: Partial<Rotation>) => ({ ...value, ...change }),
    (latest, change) => ({ rotation: { ...latest.rotation, ...change } }),
  );
  const now = computeHeartbeatNow(openedAt, heartbeat.value.timezone, settings.user.timezone);
  const look = buildLook(assistant.id);
  return (
    <div className="assistant-record" style={buildHueStyle(look.hue)}>
      <div className="head">
        <Face look={look} pose={pose} size={64} />
        <h2>{assistant.name}</h2>
      </div>
      <HowItWorksSection assistant={assistant} />
      <HeartbeatSection
        assistantName={assistant.name}
        heartbeat={{ ...heartbeat.value, prompt: prompt.value }}
        nowMinutes={now.nowMinutes}
        nowTimezone={now.timezone}
        unknownTimezone={now.unknownTimezone}
        error={heartbeat.error}
        onSave={heartbeat.save}
        promptError={prompt.error}
        onSavePrompt={prompt.save}
      />
      <RotationSection
        assistantName={assistant.name}
        rotation={rotation.value}
        error={rotation.error}
        onSave={rotation.save}
      />
      <DeleteSection assistant={assistant} onDeleted={onDeleted} />
    </div>
  );
}
