import type { JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate, redirect } from "@tanstack/react-router";
import {
  computeMemoryFill,
  describeShrinkLoss,
  describeTopicVisibility,
  formatMemoryUsage,
  isConflict,
  isNotFound,
  readErrorMessage,
} from "@hercule/client-core";
import {
  chooseMemoryCap,
  MAX_MEMORY_GIST_LENGTH,
  MEMORY_CORE,
  MEMORY_CORE_CAP,
  MEMORY_TOPIC_CAP,
  type Assistant,
  type MemoryDocument,
} from "@hercule/contract";
import { rememberSettingsSection } from "../../../../../../../app/last-settings-section";
import { assistantsQuery, memoryDocumentQuery, readOnOpen } from "../../../../../../../app/queries";
import { buildAssistantLook, buildHueStyle } from "../../../../../../../faces";
import { MemoryIcon } from "../../../../../../../icons/memory";
import { SettingRow } from "../../../../../../../screens/settings/setting-row";
import { SettingTextRow } from "../../../../../../../screens/settings/setting-text-row";
import { SettingsHeaderTitle } from "../../../../../../../screens/settings/settings-frame";
import { useTextDraft } from "../../../../../../../screens/settings/use-text-draft";
import { DeleteTopicSection } from "./-delete-topic-section";
import { ShrinkOffer } from "./-shrink-offer";
import { useSavedMemoryDocument } from "./-saved-memory-document";
import "../../../../../../../screens/settings/assistants/assistants.css";

/**
 * Settings > Assistants, the page of one memory document of an assistant:
 * its core note or one of its topics (spec 17 §Settings, Assistants). It
 * shows the document's size against its cap, and edits its text and, for a
 * topic, its gist. Each saves when it is committed. A topic also has Delete.
 * The header reads "Settings / Assistants / <document>", with Assistants
 * linked back to this assistant.
 *
 * Memory has no live topic, so the loader reads the document each time the
 * page opens. An assistant or a document that does not exist goes back to
 * the section. The section stays the one Settings remembers.
 */
export const Route = createFileRoute("/_connected/_shell/settings/assistants/$id/memory/$name")({
  staticData: { title: "Assistants" },
  loader: async ({ context: { controller, queryClient }, params: { id, name } }) => {
    const { client } = controller;
    const assistants = await queryClient.ensureQueryData(assistantsQuery(client));
    if (!assistants.some((assistant) => assistant.id === id)) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the router's way to redirect
      throw redirect({ to: "/settings/assistants", replace: true });
    }
    try {
      await readOnOpen(queryClient, memoryDocumentQuery(client, id, name));
    } catch (error) {
      if (!isNotFound(error)) throw error;
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the router's way to redirect
      throw redirect({ to: "/settings/assistants", search: { assistant: id }, replace: true });
    }
  },
  onEnter: () => {
    rememberSettingsSection("/settings/assistants");
  },
  component: MemoryDocumentPage,
});

function MemoryDocumentPage(): JSX.Element {
  const { client } = Route.useRouteContext().controller;
  const { id, name } = Route.useParams();
  const assistant = useSuspenseQuery(assistantsQuery(client)).data.find((each) => each.id === id);
  // The assistant is gone from the cache once it is deleted, and the page
  // goes back to the section.
  if (assistant === undefined) return <Navigate to="/settings/assistants" replace />;
  return (
    // A new record per document, so no field keeps another document's edit or error.
    <MemoryDocumentRecord key={`${id}/${name}`} assistant={assistant} name={name} />
  );
}

function MemoryDocumentRecord({
  assistant,
  name,
}: {
  readonly assistant: Assistant;
  readonly name: string;
}): JSX.Element {
  const { client } = Route.useRouteContext().controller;
  const document = useSuspenseQuery(memoryDocumentQuery(client, assistant.id, name)).data;
  const saved = useSavedMemoryDocument(client, assistant.id, document);
  const isCore = name === MEMORY_CORE;
  const title = isCore ? "Core note" : name;
  const cap = chooseMemoryCap(name);
  const { failure } = saved;
  const failedField = failure === null ? null : failure.edit.body === undefined ? "gist" : "body";
  const failureText =
    failure === null ? null : `Could not save: ${readErrorMessage(failure.error)}`;
  const shrinkLoss = failure === null ? undefined : describeShrinkLoss(failure.error);
  // After a save refused because an agent wrote the document since, the page
  // shows what the agent wrote, and the user's text is kept in the failed
  // save. This button, under the row that failed, writes it over that version.
  const staleSaveOffer = failure !== null && isConflict(failure.error) && (
    <div className="memory-retry">
      <button
        type="button"
        className="btn btn--sm"
        onClick={() => {
          saved.save(failure.edit);
        }}
      >
        {failedField === "gist" ? "Save my gist anyway" : "Save my text anyway"}
      </button>
    </div>
  );
  return (
    <>
      <SettingsHeaderTitle
        parent={{
          title: "Assistants",
          to: "/settings/assistants",
          search: { assistant: assistant.id },
        }}
        title={title}
      />
      <div className="memory-document" style={buildHueStyle(buildAssistantLook(assistant.id).hue)}>
        <section className="set-sec">
          <h2>
            <MemoryIcon size={15} />
            <span className="memory-document-name">{title}</span>{" "}
            <small>{formatMemoryUsage(document.size, cap)}</small>
          </h2>
          <p>
            {isCore
              ? `${assistant.name} reads the whole core note at the start of every session. Keep in it what it must always know.`
              : describeTopicVisibility(assistant.name)}
          </p>
          <div className="meter">
            <i style={{ width: `${String(computeMemoryFill(document.size, cap) * 100)}%` }} />
          </div>
          {!isCore && (
            <GistRow
              gist={saved.gist}
              error={failedField === "gist" ? failureText : null}
              onCommit={(gist) => {
                saved.save({ gist });
              }}
            />
          )}
          {failedField === "gist" && staleSaveOffer}
          <SettingTextRow
            label="Text"
            hint={describeTextHint(document)}
            value={saved.body}
            error={failedField === "body" ? failureText : null}
            onCommit={(body) => {
              saved.save({ body });
            }}
          />
          {failure !== null && shrinkLoss !== undefined && (
            <ShrinkOffer
              loss={shrinkLoss}
              onConfirm={() => {
                saved.save(failure.edit, true);
              }}
            />
          )}
          {failedField === "body" && staleSaveOffer}
        </section>
        {!isCore && <DeleteTopicSection assistant={assistant} name={name} />}
      </div>
    </>
  );
}

/** Returns the hint under a document's text, which gives its cap. */
const describeTextHint = (document: MemoryDocument): string =>
  document.name === MEMORY_CORE
    ? `Up to ${MEMORY_CORE_CAP.toLocaleString("en-US")} characters. Empty it to clear the core note; it cannot be deleted.`
    : `Up to ${MEMORY_TOPIC_CAP.toLocaleString("en-US")} characters.`;

/** Renders a topic's gist as a one-line field that saves through `onCommit`. */
function GistRow({
  gist,
  error,
  onCommit,
}: {
  readonly gist: string;
  readonly error: string | null;
  readonly onCommit: (gist: string) => void;
}): JSX.Element {
  const input = useTextDraft(gist, onCommit);
  return (
    <SettingRow
      label="Gist"
      hint="One line that says what the topic holds, shown beside its name."
      error={error}
      control={(labels) => (
        <span className="field memory-gist">
          <input type="text" maxLength={MAX_MEMORY_GIST_LENGTH} {...labels} {...input} />
        </span>
      )}
    />
  );
}
