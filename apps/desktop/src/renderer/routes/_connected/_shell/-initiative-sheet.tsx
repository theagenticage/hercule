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
import { initiativesQuery, useWorkInitiatives } from "./-work-board";

/**
 * What the sheet is open on: a new Initiative, starting in a Project's lane,
 * or one that exists. An edit keeps the Initiative as it was when the sheet
 * opened (`opened`), which is what the fields started from. A save sends the
 * fields the user changed from it, so a change another client made to a field
 * the user left alone is never written over.
 */
type Opening =
  | { readonly kind: "new"; readonly projectId: string | null }
  | { readonly kind: "edit"; readonly opened: Initiative };

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
 * - Saving an edit sends only the fields the user changed since the sheet
 *   opened, whatever the Initiative looks like now.
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
  // Gated on the window being visible, like the Work screen's own read of the list.
  const initiatives = useWorkInitiatives(client).data ?? [];
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
      edited,
      draft,
    }: {
      /** The Initiative as the sheet opened on it, and as it is now; `null` for a new one. */
      readonly edited: { readonly opened: Initiative; readonly now: Initiative } | null;
      readonly draft: InitiativeDraft;
    }): Promise<Initiative> => {
      if (edited === null) {
        return client.initiative.create({ payload: buildInitiativeCreateInput(draft) });
      }
      const payload = buildInitiativeUpdateInput(edited.opened, draft, projects);
      // Nothing changed: there is nothing to send, and the sheet just closes.
      return payload === null
        ? Promise.resolve(edited.now)
        : client.initiative.update({ params: { id: edited.opened.id }, payload });
    },
    onSuccess: (saved, { edited }) => {
      if (!scope.isCurrent()) return;
      writeSaved(saved);
      close();
      // A filter can hide the new row, so the line says it was added.
      if (edited === null) sayWithoutUndo(`Added the initiative ${saved.name}.`);
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

  // The Initiative as it was on opening and as it is now. `now` is missing when another client
  // closed or deleted it meanwhile, and the sheet is then taken away.
  const now =
    opening?.kind === "edit"
      ? initiatives.find((each) => each.id === opening.opened.id)
      : undefined;
  const edited =
    opening?.kind === "edit" && now !== undefined ? { opened: opening.opened, now } : null;
  let sheet: JSX.Element | null = null;
  if (opening?.kind === "new" || edited !== null) {
    const initial =
      edited === null
        ? buildNewInitiativeDraft(
            initiatives,
            projects,
            opening?.kind === "new" ? opening.projectId : null,
          )
        : buildInitiativeDraft(edited.opened, projects);
    sheet = (
      <InitiativeSheet
        key={edited?.now.id ?? "new"}
        initial={initial}
        projects={projects}
        subject={edited === null ? null : { name: edited.now.name }}
        onSave={async (draft) => {
          await save.mutateAsync({ edited, draft });
        }}
        onCloseInitiative={async () => {
          if (edited !== null) await closeInitiative.mutateAsync(edited.now);
        }}
        onDelete={async () => {
          if (edited !== null) await remove.mutateAsync(edited.now);
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
      const opened = queryClient.getQueryData(listKey)?.find((each) => each.id === initiativeId);
      if (opened !== undefined) open({ kind: "edit", opened });
    },
    close,
  };
}
