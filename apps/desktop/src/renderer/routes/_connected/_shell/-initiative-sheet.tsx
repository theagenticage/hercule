/**
 * The Initiative sheet of the Work screen: opening it to create an Initiative
 * or to edit one, and what saving, closing and deleting do. The sheet itself
 * (`screens/work/initiative-sheet.tsx`) only draws the fields and the foot.
 */
import { useRef, useState, type JSX } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import {
  buildInitiativeCreateInput,
  buildInitiativeDraft,
  buildInitiativeUpdateInput,
  buildNewInitiativeDraft,
  putInitiative,
  type InitiativeDraft,
} from "@hercule/client-core/work";
import type { Initiative } from "@hercule/contract";
import { requireSignedIn, type AccountScope } from "../../../app/account-scope";
import { projectsQuery } from "../../../app/queries";
import type { Gesture } from "../../../app/undo-stack";
import type { CardMover } from "../../../app/card-mover";
import { InitiativeSheet } from "../../../screens/work/initiative-sheet";
import { initiativesQuery } from "./-work-board";

/** What the sheet is open on: a new Initiative, starting in a Project's lane, or one that exists. */
type Opening =
  | { readonly kind: "new"; readonly projectId: string | null }
  | { readonly kind: "edit"; readonly initiativeId: string };

/** What `useInitiativeSheet` returns. */
export interface InitiativeSheetControls {
  /** The sheet, to draw among the screen's overlays, or `null` while it is closed. */
  readonly sheet: JSX.Element | null;
  /** Whether the sheet is open, so the screen can keep other sheets from covering it. */
  readonly isOpen: boolean;
  /**
   * Opens the sheet on a new Initiative. `fromProjectId` is the Project of
   * the lane the user opened it from, which the Project field starts on. A
   * Project that is not listed means none.
   */
  readonly openNew: (fromProjectId?: string | null) => void;
  /** Opens the sheet on the open Initiative `initiativeId`. Does nothing for one that is not in the list, such as a closed one. */
  readonly openEdit: (initiativeId: string) => void;
  /** Closes the sheet and gives the focus back to what had it when the sheet opened. */
  readonly close: () => void;
}

/**
 * Holds the Initiative sheet for the Work screen of the user of `scope`.
 *
 * - Saving writes the Initiative the controller returns into the cached list
 *   of open Initiatives, so its row is drawn at once. The `initiative` push
 *   then reads the list again.
 * - Closing takes it out of that list and offers Undo on the undo line, which
 *   reopens it. Deleting does not: its Tasks have lost it, which nothing puts
 *   back, so the line says that it is gone and offers no Undo.
 * - Every answer that arrives after the user signed out is dropped.
 *
 * `sayWithUndo` and `sayWithoutUndo` are the screen's undo line (see
 * `CardMoves`).
 */
export function useInitiativeSheet({
  client,
  scope,
  sayWithUndo,
  sayWithoutUndo,
}: {
  readonly client: HerculeClient;
  readonly scope: AccountScope;
  readonly sayWithUndo: (text: string, gesture: Gesture<CardMover>) => () => void;
  readonly sayWithoutUndo: (text: string) => void;
}): InitiativeSheetControls {
  const queryClient = useQueryClient();
  const initiatives = useQuery(initiativesQuery(client)).data ?? [];
  const projects = useQuery(projectsQuery(client)).data ?? [];
  const [opening, setOpening] = useState<Opening | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  const listKey = initiativesQuery(client).queryKey;
  const writeSaved = (saved: Initiative): void => {
    queryClient.setQueryData(listKey, (list) =>
      list === undefined ? undefined : [...putInitiative(list, saved)],
    );
  };

  const close = (): void => {
    setOpening(null);
    opener.current?.focus({ preventScroll: true });
  };
  const open = (next: Opening): void => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpening(next);
  };

  /** Reopens `initiativeId`. Throws, with the controller's words, when it cannot, or when the user signed out meanwhile. */
  const reopenInitiative = async (initiativeId: string): Promise<void> => {
    requireSignedIn(scope);
    const reopened = await client.initiative.reopen({ params: { id: initiativeId } });
    if (scope.isCurrent()) writeSaved(reopened);
  };

  const save = useMutation({
    mutationFn: ({
      initiative,
      draft,
    }: {
      readonly initiative: Initiative | null;
      readonly draft: InitiativeDraft;
    }): Promise<Initiative> => {
      if (initiative === null) {
        return client.initiative.create({ payload: buildInitiativeCreateInput(draft) });
      }
      const payload = buildInitiativeUpdateInput(initiative, draft, projects);
      // Nothing changed: there is nothing to send, and the sheet just closes.
      return payload === null
        ? Promise.resolve(initiative)
        : client.initiative.update({ params: { id: initiative.id }, payload });
    },
    onSuccess: (saved, { initiative }) => {
      if (!scope.isCurrent()) return;
      writeSaved(saved);
      close();
      // A filter can hide the new row, so the line says it was added.
      if (initiative === null) sayWithoutUndo(`Added the initiative ${saved.name}.`);
    },
  });

  const closeInitiative = useMutation({
    mutationFn: (initiative: Initiative) =>
      client.initiative.close({ params: { id: initiative.id } }),
    onSuccess: (closed) => {
      if (!scope.isCurrent()) return;
      writeSaved(closed);
      close();
      const words = `Closed ${closed.name}`;
      sayWithUndo(`${words}.`, {
        words,
        undo: async () => {
          await reopenInitiative(closed.id);
          return undefined;
        },
      });
    },
  });

  const reopen = useMutation({
    mutationFn: reopenInitiative,
    onSuccess: () => {
      if (scope.isCurrent()) close();
    },
  });

  const remove = useMutation({
    mutationFn: (initiative: Initiative) =>
      client.initiative.delete({ params: { id: initiative.id } }),
    onSuccess: (_deleted, initiative) => {
      if (!scope.isCurrent()) return;
      queryClient.setQueryData(listKey, (list) =>
        list?.filter((each) => each.id !== initiative.id),
      );
      close();
      sayWithoutUndo(`Deleted ${initiative.name}. Its Tasks stay, and leave it.`);
    },
  });

  const editing =
    opening?.kind === "edit"
      ? initiatives.find((each) => each.id === opening.initiativeId)
      : undefined;
  let sheet: JSX.Element | null = null;
  if (opening?.kind === "new" || editing !== undefined) {
    const initial =
      editing === undefined
        ? buildNewInitiativeDraft(
            initiatives,
            projects,
            opening?.kind === "new" ? opening.projectId : null,
          )
        : buildInitiativeDraft(editing, projects);
    sheet = (
      <InitiativeSheet
        key={editing?.id ?? "new"}
        initial={initial}
        projects={projects}
        subject={
          editing === undefined
            ? null
            : { name: editing.name, isClosed: editing.closedAt !== undefined }
        }
        onSave={async (draft) => {
          await save.mutateAsync({ initiative: editing ?? null, draft });
        }}
        onCloseInitiative={async () => {
          if (editing !== undefined) await closeInitiative.mutateAsync(editing);
        }}
        onReopenInitiative={async () => {
          if (editing !== undefined) await reopen.mutateAsync(editing.id);
        }}
        onDelete={async () => {
          if (editing !== undefined) await remove.mutateAsync(editing);
        }}
        onDismiss={close}
      />
    );
  }

  return {
    sheet,
    isOpen: sheet !== null,
    openNew: (fromProjectId) => {
      open({ kind: "new", projectId: fromProjectId ?? null });
    },
    openEdit: (initiativeId) => {
      if (queryClient.getQueryData(listKey)?.some((each) => each.id === initiativeId) === true) {
        open({ kind: "edit", initiativeId });
      }
    },
    close,
  };
}
