import { useState, type JSX } from "react";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  composerFields,
  modelMenu,
  optionsLabel,
  pendingModelNote,
  queryKeys,
  type Thread,
} from "@hydra/client-core";
import { localRunnerQuery, providersQuery, runnersQuery } from "../../app/queries";
import { messageOf } from "../save-status";
import { AccessModeSelector } from "./access-mode-selector";
import { AttachButton, PendingNote, SendButton, StopButton, VoiceButton } from "./controls";
import { DraftHero } from "./draft-hero";
import { Lip } from "./lip";
import { loginSlot } from "./login-slot";
import { ModelOptionsSelector } from "./model-options-selector";
import { ModelSelector } from "./model-selector";
import { MessageBox } from "./message-box";
import { useComposerModel } from "./use-composer-model";

type SelectorKey = "accessMode" | "options" | "model" | "workspace" | "machine";

/**
 * The composer: what the thread runs with, and the message about to go to it. One
 * component for a draft and an active thread - `useComposerModel` holds the
 * difference, and every lock, dimming and blocker comes from `composerFields`.
 */
export function Composer({
  thread,
  onSend,
}: {
  readonly thread: Thread;
  /** An active thread's way to rejoin the tail as a message goes out. */
  readonly onSend?: () => void;
}): JSX.Element {
  const { client, detectLocalRunner } = useRouteContext({ from: "/_shell" });
  const queryClient = useQueryClient();
  const instances = useSuspenseQuery(providersQuery(client)).data;
  const runners = useSuspenseQuery(runnersQuery(client)).data.items;
  const localRunnerId = useQuery(localRunnerQuery(detectLocalRunner, runners)).data ?? null;
  const catalogs = { instances, runners, localRunnerId };
  const [open, setOpen] = useState<SelectorKey | null>(null);
  const model = useComposerModel(thread, catalogs, client, onSend);
  const fields = composerFields(catalogs, model.config, model.kind);
  const pending = pendingModelNote(model.kind, model.picks);
  const login = loginSlot(client, () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.providers() });
  });
  // A click opening selector B is also a click outside A, whose dismissal can
  // land after B's open - so closing clears only the selector still asking to.
  const toggle =
    (key: SelectorKey) =>
    (next: boolean): void => {
      setOpen((current) => (next ? key : current === key ? null : current));
    };
  const menuOf = (filter: string) =>
    modelMenu(catalogs, model.config, { kind: model.kind, filter, recent: model.recent });
  const blocked = fields.blocked !== null || model.readOnly !== null || model.sending;
  const canSend = !blocked && model.message.trim() !== "";
  return (
    // A draft stands under its own sentence, which takes the room above the card.
    <div className={model.lead === null ? "flex w-full flex-col" : "flex w-full flex-1 flex-col"}>
      <DraftHero lead={model.lead} blocked={fields.blocked} loginSlot={login} />
      <div className="relative z-[1] flex flex-col gap-2 rounded-[14px] border border-line bg-raised px-3.5 pt-3 pb-2.5 shadow-lift">
        <MessageBox
          value={model.message}
          placeholder={model.placeholder}
          disabled={model.readOnly !== null}
          onChange={model.setMessage}
          onSubmit={() => {
            if (canSend) model.submit();
          }}
        />
        <div className="flex items-center gap-1.5">
          <AttachButton />
          <AccessModeSelector
            mode={fields.accessMode.value}
            items={fields.accessMode.rows}
            locked={fields.accessMode.locked}
            open={open === "accessMode"}
            onOpenChange={toggle("accessMode")}
            onPick={(mode) => {
              model.pick({ kind: "accessMode", value: mode });
              setOpen(null);
            }}
          />
          {pending === null ? null : <PendingNote note={pending} />}
          <div className="ml-auto flex min-w-0 items-center gap-1.5">
            {fields.options === null ? null : (
              <ModelOptionsSelector
                descriptors={fields.options}
                selected={model.config.options}
                label={optionsLabel(fields.options, model.config.options)}
                modelName={fields.model.pill.name}
                disabled={model.readOnly !== null}
                open={open === "options"}
                onOpenChange={toggle("options")}
                onPick={(id, value) => {
                  model.pick({ kind: "option", id, value });
                }}
              />
            )}
            <ModelSelector
              menuOf={menuOf}
              pill={fields.model.pill}
              disabled={model.readOnly !== null}
              open={open === "model"}
              onOpenChange={toggle("model")}
              onPick={model.pick}
              loginSlot={login}
            />
          </div>
          <VoiceButton />
          {model.busy ? <StopButton onStop={model.stop} /> : null}
          <SendButton tip={model.sendTip} disabled={!canSend} onSend={model.submit} />
        </div>
        {model.error === null ? null : (
          <p className="text-fine text-fail" role="alert">
            {messageOf(model.error)}
          </p>
        )}
      </div>
      <Lip
        fields={fields}
        runnerId={model.config.runnerId}
        open={open === "workspace" || open === "machine" ? open : null}
        onOpenChange={toggle}
        onPickRunner={(runnerId) => {
          model.pick({ kind: "runnerId", value: runnerId });
          setOpen(null);
        }}
        onClose={() => {
          setOpen(null);
        }}
      />
    </div>
  );
}
