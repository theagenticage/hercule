import { useEffect, useRef, useState, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  countSkillImportOutcomes,
  describeFolderWithoutSkills,
  describeLockedSkillSource,
  describeSkillImportSummary,
  readErrorMessage,
  type SkillImportOutcome,
} from "@hercule/client-core";
import type { PickedSkill, SkillFoldersPickOutcome } from "../../../../../../ipc/contract";
import { readSkillsAgain } from "../../../../../app/queries";
import { CheckIcon } from "../../../../../icons/check";
import { GlassDialog } from "../../../../../screens/glass-dialog";
import { InlineCode } from "../../../../../screens/inline-code";
import { importPickedSkill } from "./-import-picked-skill";

/** The folder the user picked, as main answered `skillFolders.pick`. */
type PickedFolder = Extract<SkillFoldersPickOutcome, { readonly _tag: "Picked" }>;

/**
 * The step the dialog shows. A pass of imports runs inside a step, and the
 * mutation's `isPending` is true while one runs.
 *
 * - `picked`: one row per skill folder, which the user checks, then the
 *   checked skills import one at a time.
 * - `conflict`: the skills that exist with different content wait for the
 *   user to confirm or skip them, then the confirmed ones import again.
 *   `conflicts` holds those skills as the first pass left them, so a row
 *   stays while the replace pass imports it.
 * - `done`: the summary.
 */
type ImportStep =
  | { readonly kind: "picked" }
  | { readonly kind: "conflict"; readonly conflicts: ReadonlyArray<PickedSkill> }
  | { readonly kind: "done" };

/** One pass of imports: the checked skills, or the confirmed conflicts with `replace`. */
interface ImportPass {
  readonly skills: ReadonlyArray<PickedSkill>;
  readonly replace: boolean;
}

/** Which skill of how many is importing, counted from 1, and its name. */
interface ImportProgress {
  readonly at: number;
  readonly of: number;
  readonly name: string;
}

/** Returns `names` with `name` added, or without it when it was there. */
const toggleName = (names: ReadonlySet<string>, name: string): ReadonlySet<string> => {
  const next = new Set(names);
  if (!next.delete(name)) next.add(name);
  return next;
};

/** Returns "1 skill" or "3 skills". */
const formatSkillCount = (count: number): string =>
  `${String(count)} ${count === 1 ? "skill" : "skills"}`;

/**
 * Renders the import dialog for `folder`, the folder the user picked (spec
 * 17 §Settings, Skills, Import from a folder). It imports the skills the
 * user leaves checked, one at a time: main builds a skill's archive, then
 * `skill.import` sends it, so the renderer holds one archive at a time.
 *
 * - A refusal, by main or by the controller, shows under its row, and the
 *   import goes on with the next skill.
 * - An error about the connection or the credential stops the import at its
 *   skill, because every later skill would get it too. The rows keep what
 *   the skills before it got, and the error shows once, in the summary's
 *   place.
 * - Once every skill has run, the skills that exist with different content
 *   wait in one confirmation, and confirmed ones are sent again with
 *   `replace`.
 * - The dialog ends with a summary and Done.
 *
 * Closing the dialog while it imports stops the import after the skill being
 * sent. Each pass of imports reads the list again when it ends, also when it
 * was stopped, so the list shows what the controller now holds.
 */
export function ImportDialog({
  folder,
  onClose,
}: {
  readonly folder: PickedFolder;
  readonly onClose: () => void;
}): JSX.Element {
  const { bridge } = useRouteContext({ from: "__root__" });
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const stoppedRef = useRef(false);
  // True from the click that starts a pass until the pass settles. The
  // mutation reports itself pending only on a later tick, so a second click
  // before then would otherwise start a second pass.
  const passRunningRef = useRef(false);
  const [step, setStep] = useState<ImportStep>({ kind: "picked" });
  const [checked, setChecked] = useState<ReadonlySet<string>>(
    () => new Set(folder.skills.map(({ name }) => name)),
  );
  // The conflicts the user confirms. Kept apart from `checked`, which the
  // summary's rows still draw.
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(new Set());
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, SkillImportOutcome>>(new Map());
  const [progress, setProgress] = useState<ImportProgress | null>(null);

  // Main builds one archive at a time, so the skills of a pass run in turn.
  const run = useMutation({
    mutationFn: async ({ skills, replace }: ImportPass) => {
      const ran = new Map<string, SkillImportOutcome>();
      for (const [index, skill] of skills.entries()) {
        if (stoppedRef.current) break;
        setProgress({ at: index + 1, of: skills.length, name: skill.name });
        const outcome = await importPickedSkill(bridge, client, skill, replace);
        ran.set(skill.name, outcome);
        setOutcomes((before) => new Map(before).set(skill.name, outcome));
      }
      return ran;
    },
    onSuccess: (ran, { skills }) => {
      const conflicts = skills.filter(({ name }) => ran.get(name)?.kind === "conflict");
      setConfirmed(new Set(conflicts.map(({ name }) => name)));
      setStep(conflicts.length === 0 ? { kind: "done" } : { kind: "conflict", conflicts });
    },
    // The import stopped at the skill `progress` names: the controller could
    // not be reached, or refused the credential, or main refused to build an
    // archive, which it does only when the name is not in its last answer or
    // a build is already running. The error shows in the summary's place.
    onError: () => {
      setStep({ kind: "done" });
    },
    onSettled: async () => {
      passRunningRef.current = false;
      await readSkillsAgain(queryClient);
    },
  });

  /** Starts a pass of imports, unless one is already running. */
  const startPass = (pass: ImportPass): void => {
    if (passRunningRef.current) return;
    passRunningRef.current = true;
    run.mutate(pass);
  };

  /** Marks the conflicts the user did not confirm as skipped, and imports the rest with `replace`. */
  const finishConflicts = (
    conflicts: ReadonlyArray<PickedSkill>,
    replaceConfirmed: boolean,
  ): void => {
    if (passRunningRef.current) return;
    const sent = replaceConfirmed ? conflicts.filter(({ name }) => confirmed.has(name)) : [];
    setOutcomes((before) => {
      const next = new Map(before);
      for (const { name } of conflicts) {
        if (!sent.some((skill) => skill.name === name)) next.set(name, { kind: "skipped" });
      }
      return next;
    });
    if (sent.length === 0) setStep({ kind: "done" });
    else startPass({ skills: sent, replace: true });
  };

  // Runs after GlassDialog has opened the dialog, which focuses its first
  // control: the list, which scrolls and so would ring as a whole. The step's
  // main button takes the focus instead; a step with none focuses nothing.
  // The row that matters scrolls into the list's view: the one importing, at
  // the list's foot, or after the import the first refusal, at its top.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const action = dialog.querySelector<HTMLElement>("[data-autofocus]");
    if (action === null) (document.activeElement as HTMLElement | null)?.blur();
    else action.focus();
  }, [step, run.isPending]);
  const scrollTo =
    step.kind === "picked" && run.isPending && progress !== null
      ? { name: progress.name, at: "end" }
      : step.kind === "done"
        ? {
            name: folder.skills.find(({ name }) => outcomes.get(name)?.kind === "refused")?.name,
            at: "start",
          }
        : null;
  useEffect(() => {
    const row = dialogRef.current?.querySelector<HTMLElement>("[data-scroll-to]");
    const list = row?.parentElement;
    if (row == null || list == null) return;
    // The list scrolls itself, never the page behind the dialog.
    const top = row.offsetTop - list.offsetTop;
    list.scrollTop =
      row.dataset.scrollTo === "end" ? top - list.clientHeight + row.offsetHeight + 6 : top - 6;
  }, [scrollTo?.name, scrollTo?.at]);

  const close = (): void => dialogRef.current?.close();
  // In the confirmation, the list draws the conflicts and which of them the
  // user confirms. Otherwise it draws every skill of the folder and the picks.
  const confirming = step.kind === "conflict";
  const listed = confirming ? step.conflicts : folder.skills;
  const selected = confirming ? confirmed : checked;
  const setSelected = confirming ? setConfirmed : setChecked;

  return (
    <GlassDialog
      dialogRef={dialogRef}
      className="skill-import"
      label={`Import from ${folder.displayPath}`}
      onClose={() => {
        stoppedRef.current = true;
        onClose();
      }}
    >
      <div className="pop-h">
        <b>
          Import from <code>{folder.displayPath}</code>
        </b>
        <span>{formatSkillCount(folder.skills.length)}</span>
      </div>
      {folder.lockFileProblem !== null && (
        <p className="skill-import-note">
          <InlineCode text={folder.lockFileProblem} />
        </p>
      )}
      {folder.skills.length === 0 ? (
        <>
          <p className="skill-import-note">
            <InlineCode text={describeFolderWithoutSkills(folder.displayPath)} />
          </p>
          <div className="skill-import-foot">
            <button type="button" className="btn btn--accent" data-autofocus onClick={close}>
              Done
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="pop-sec skill-import-list">
            {listed.map(({ name, source }) => {
              const outcome = confirming ? undefined : outcomes.get(name);
              return (
                <label
                  key={name}
                  className={
                    outcome?.kind === "refused" ? "skill-import-row is-refused" : "skill-import-row"
                  }
                  data-scroll-to={scrollTo?.name === name ? scrollTo.at : undefined}
                >
                  <span className="choice-box">
                    <input
                      type="checkbox"
                      checked={selected.has(name)}
                      disabled={run.isPending || step.kind === "done"}
                      onChange={() => setSelected(toggleName(selected, name))}
                    />
                    <CheckIcon size={12} />
                  </span>
                  <span className="skill-import-name">
                    {confirming ? (
                      <span>
                        <code>{name}</code> exists with different content.
                      </span>
                    ) : (
                      <>
                        <b>{name}</b>
                        <small>
                          {outcome?.kind === "refused" ? (
                            <InlineCode text={outcome.reason} />
                          ) : (
                            describeLockedSkillSource(source)
                          )}
                        </small>
                      </>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
          <div className="skill-import-foot">
            {step.kind === "done" ? (
              <>
                <span className="time" role={run.error === null ? undefined : "alert"}>
                  {run.error === null ? (
                    describeSkillImportSummary(countSkillImportOutcomes(outcomes.values()))
                  ) : (
                    <InlineCode text={describeImportStop(progress, run.error)} />
                  )}
                </span>
                <button type="button" className="btn btn--accent" data-autofocus onClick={close}>
                  Done
                </button>
              </>
            ) : run.isPending ? (
              <span className="time">{describeProgress(progress)}</span>
            ) : step.kind === "picked" ? (
              <>
                <span className="time">
                  {`${String(checked.size)} of ${String(folder.skills.length)} selected`}
                </span>
                <button type="button" className="btn btn--quiet" onClick={close}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn--accent"
                  aria-disabled={checked.size === 0}
                  data-autofocus
                  onClick={() => {
                    if (checked.size === 0) return;
                    startPass({
                      skills: folder.skills.filter(({ name }) => checked.has(name)),
                      replace: false,
                    });
                  }}
                >
                  {`Import ${String(checked.size)}`}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn--quiet"
                  onClick={() => finishConflicts(step.conflicts, false)}
                >
                  Skip
                </button>
                <button
                  type="button"
                  className="btn btn--accent"
                  aria-disabled={confirmed.size === 0}
                  data-autofocus
                  onClick={() => {
                    if (confirmed.size > 0) finishConflicts(step.conflicts, true);
                  }}
                >
                  Import as new revisions
                </button>
              </>
            )}
          </div>
        </>
      )}
    </GlassDialog>
  );
}

/** Returns "Importing 3 of 24", or nothing before the first skill starts. */
const describeProgress = (progress: ImportProgress | null): string =>
  progress === null ? "" : `Importing ${String(progress.at)} of ${String(progress.of)}`;

/**
 * Returns the line that replaces the summary when `error` stopped the import:
 * "The import stopped at `teach`: cannot reach http://…", naming the skill
 * `progress` was at. The skill's name is a code span, between backticks.
 */
const describeImportStop = (progress: ImportProgress | null, error: Error): string =>
  progress === null
    ? `The import stopped: ${readErrorMessage(error)}`
    : `The import stopped at \`${progress.name}\`: ${readErrorMessage(error)}`;
