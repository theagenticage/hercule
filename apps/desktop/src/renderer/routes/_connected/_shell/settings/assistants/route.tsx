import type { JSX } from "react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { NEW_ASSISTANT_NAME, readErrorMessage } from "@hercule/client-core";
import { isId } from "@hercule/contract";
import { useAssistantRows } from "../../../../../app/assistant-rows";
import { rememberSettingsSection } from "../../../../../app/last-settings-section";
import {
  assistantsQuery,
  profilesQuery,
  providersQuery,
  readOnOpen,
  settingsQuery,
} from "../../../../../app/queries";
import { buildAssistantLook, buildHueStyle, Face } from "../../../../../faces";
import { PlusIcon } from "../../../../../icons/plus";
import { SettingsHeaderActions } from "../../../../../screens/settings/settings-frame";
import { AssistantRecord } from "./-assistant-record";
import "../../../../../screens/settings/assistants/assistants.css";

/**
 * Settings > Assistants: one tab per assistant, and the settings of the one
 * picked, which save as soon as they change (spec 17 §Settings, Assistants).
 * The header's New assistant button creates one and picks it.
 *
 * The picked assistant is the `assistant` search parameter, so a link can
 * open the section on one assistant. Without it, or when no assistant has
 * that id, the first tab is picked.
 *
 * The assistants and the provider instances are the shell's reads, which the
 * live connection keeps current. The permission profiles and the settings
 * (whose time zone the heartbeat's day uses) have no live topic, so the
 * loader reads them each time the section opens.
 */
export const Route = createFileRoute("/_connected/_shell/settings/assistants")({
  staticData: { title: "Assistants" },
  validateSearch: (search: Record<string, unknown>): { readonly assistant?: string } =>
    isId(search.assistant) ? { assistant: search.assistant } : {},
  loader: async ({ context: { controller, queryClient } }) => {
    const { client } = controller;
    await Promise.all([
      queryClient.ensureQueryData(assistantsQuery(client)),
      queryClient.ensureQueryData(providersQuery(client)),
      readOnOpen(queryClient, profilesQuery(client)),
      readOnOpen(queryClient, settingsQuery(client)),
    ]);
  },
  onEnter: () => {
    rememberSettingsSection("/settings/assistants");
  },
  component: Assistants,
});

function Assistants(): JSX.Element {
  const { client } = Route.useRouteContext().controller;
  const { assistant: pickedId } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const queryClient = useQueryClient();
  const rows = useAssistantRows();
  const assistants = useSuspenseQuery(assistantsQuery(client)).data;
  const picked = rows.find(({ id }) => id === pickedId) ?? rows[0];
  const assistant = assistants.find(({ id }) => id === picked?.id);

  const create = useMutation({
    mutationFn: () => client.assistant.create({ payload: { name: NEW_ASSISTANT_NAME } }),
    onSuccess: async (created) => {
      // Added to the cached list first, so its tab exists when it is picked.
      // The live connection can add it first, and then it is not added twice.
      const { queryKey } = assistantsQuery(client);
      queryClient.setQueryData(queryKey, (list) =>
        list === undefined || list.some(({ id }) => id === created.id) ? list : [...list, created],
      );
      await navigate({ search: { assistant: created.id } });
      // Read again, so a read that started before the create cannot leave
      // the list without the new assistant.
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  return (
    <>
      <SettingsHeaderActions>
        <button
          type="button"
          className="btn btn--sm"
          aria-disabled={create.isPending}
          onClick={() => {
            if (!create.isPending) create.mutate();
          }}
        >
          <PlusIcon size={14} />
          New assistant
        </button>
      </SettingsHeaderActions>
      {create.error !== null && (
        <p className="set-err" role="alert">
          Could not create the assistant: {readErrorMessage(create.error)}
        </p>
      )}
      {picked === undefined || assistant === undefined ? (
        <div className="empty-assistants">
          <b>No assistants yet</b>
          <span>
            An assistant keeps one Conversation with you, remembers what matters, and checks in on
            its own. Create one with New assistant.
          </span>
        </div>
      ) : (
        <div className="assistant-settings">
          <nav className="assistant-tabs" aria-label="Choose an assistant">
            {rows.map((row) => (
              <Link
                key={row.id}
                from={Route.fullPath}
                search={{ assistant: row.id }}
                className="assistant-tab"
                aria-current={row.id === picked.id ? "page" : undefined}
                style={buildHueStyle(buildAssistantLook(row.id).hue)}
                title={row.name}
              >
                <Face look={buildAssistantLook(row.id)} pose={row.pose} size={28} />
                <span className="assistant-tab-name">{row.name}</span>
              </Link>
            ))}
          </nav>
          <AssistantRecord
            // A new record per assistant, so no field keeps another assistant's edit or error.
            key={assistant.id}
            assistant={assistant}
            pose={picked.pose}
            onDeleted={(id) => {
              // The delete can answer after another assistant was picked, and
              // that pick stays.
              void navigate({ search: (prev) => (prev.assistant === id ? {} : prev) });
            }}
          />
        </div>
      )}
    </>
  );
}
