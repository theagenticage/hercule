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
import {
  useSavedMemoryDocument,
  type MemoryField,
  type SavedMemoryDocument,
} from "./-saved-memory-document";
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
      // oxlint-disable-next-line typescript/only-throw-error -- the router's way to redirect
      throw redirect({ to: "/settings/assistants", replace: true });
    }
    try {
      await readOnOpen(queryClient, memoryDocumentQuery(client, id, name));
    } catch (error) {
      if (!isNotFound(error)) throw error;
      // oxlint-disable-next-line typescript/only-throw-error -- the router's way to redirect
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
            <>
              <GistRow
                gist={saved.gist.text}
                readOnly={saved.gist.saving}
                error={describeSaveError(saved.gist.error)}
                onCommit={(gist) => {
                  saved.save("gist", gist);
                }}
                onEditStart={() => {
                  saved.startEdit("gist");
                }}
              />
              <SaveFailureOffer field="gist" error={saved.gist.error} saved={saved} />
            </>
          )}
          <SettingTextRow
            label="Text"
            hint={describeTextHint(document)}
            value={saved.body.text}
            readOnly={saved.body.saving}
            error={describeSaveError(saved.body.error)}
            onCommit={(body) => {
              saved.save("body", body);
            }}
            onEditStart={() => {
              saved.startEdit("body");
            }}
          />
          <SaveFailureOffer field="body" error={saved.body.error} saved={saved} />
        </section>
        {!isCore && <DeleteTopicSection assistant={assistant} name={name} />}
      </div>
    </>
  );
}

/** Returns the message shown under a field whose last save failed with `error`, or `null`. */
const describeSaveError = (error: Error | null): string | null =>
  error === null ? null : `Could not save: ${readErrorMessage(error)}`;

/**
 * Renders what the user can do about a field's failed save, under its row:
 *
 * - after a `conflict`, the page shows what the agent wrote, and a button
 *   writes the user's text over that version;
 * - after `shrink_rejected`, a button saves the shorter text once a dialog
 *   confirms it.
 *
 * Renders nothing for any other error.
 */
function SaveFailureOffer({
  field,
  error,
  saved,
}: {
  readonly field: MemoryField;
  readonly error: Error | null;
  readonly saved: SavedMemoryDocument;
}): JSX.Element | null {
  if (error === null) return null;
  const shrinkLoss = describeShrinkLoss(error);
  if (shrinkLoss !== undefined) {
    return (
      <ShrinkOffer
        loss={shrinkLoss}
        onConfirm={() => {
          saved.confirmShrink(field);
        }}
      />
    );
  }
  if (!isConflict(error)) return null;
  return (
    <div className="memory-retry">
      <button
        type="button"
        className="btn btn--sm"
        onClick={() => {
          saved.saveAnyway(field);
        }}
      >
        {field === "gist" ? "Save my gist anyway" : "Save my text anyway"}
      </button>
    </div>
  );
}

/** Returns the hint under a document's text, which gives its cap. */
const describeTextHint = (document: MemoryDocument): string =>
  document.name === MEMORY_CORE
    ? `Up to ${MEMORY_CORE_CAP.toLocaleString("en-US")} characters. Empty it to clear the core note; it cannot be deleted.`
    : `Up to ${MEMORY_TOPIC_CAP.toLocaleString("en-US")} characters.`;

/**
 * Renders a topic's gist as a one-line field that saves through `onCommit`.
 * `onEditStart` runs when the user begins typing over the shown gist. The
 * field is read-only while its save runs.
 */
function GistRow({
  gist,
  readOnly,
  error,
  onCommit,
  onEditStart,
}: {
  readonly gist: string;
  readonly readOnly: boolean;
  readonly error: string | null;
  readonly onCommit: (gist: string) => void;
  readonly onEditStart: () => void;
}): JSX.Element {
  const input = useTextDraft(gist, onCommit, onEditStart);
  return (
    <SettingRow
      label="Gist"
      hint="One line that says what the topic holds, shown beside its name."
      error={error}
      control={(labels) => (
        <span className="field memory-gist">
          <input
            type="text"
            maxLength={MAX_MEMORY_GIST_LENGTH}
            readOnly={readOnly}
            {...labels}
            {...input}
          />
        </span>
      )}
    />
  );
}
