/**
 * The PickedSkillFolders service: the folder of skills the user picked for
 * Settings > Skills, and the tar archive of each skill in it.
 *
 * The renderer never sends a path. It names a skill of the last `Picked`
 * answer, and main reads that skill's folder, which main remembered. With the
 * reader's rule for links, a link inside a skill's folder must point inside
 * that folder, so a compromised renderer can make main read nothing but the
 * folder the user picked (spec 13 §8, spec 17 §The IPC contract).
 *
 * Main imports the folder reader, `@hercule/client-core/skill-folder`, only
 * when a method is first called: the Skills screen calls the methods, and a
 * usual launch calls none, so it loads none of that code.
 */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type { SkillArchiveBuildOutcome, SkillFoldersPickOutcome } from "../ipc/contract";
import { MainWindow } from "./main-window";

/**
 * The renderer asked for the archive of a skill that was not in the last
 * `Picked` answer, or asked before any `Picked` answer.
 */
export class SkillNotPicked extends Data.TaggedError("SkillNotPicked")<{
  readonly message: string;
}> {}

/** The renderer asked for an archive while another one was still being built. */
export class SkillArchiveBuildRunning extends Data.TaggedError("SkillArchiveBuildRunning")<{
  readonly message: string;
}> {}

/** Picks a folder of skills, and builds the archive of one skill in it. */
export class PickedSkillFolders extends Context.Service<
  PickedSkillFolders,
  {
    /**
     * Asks the user to pick a folder in the system's dialog, and returns the
     * skill folders in it (see `findSkillFolders`). A `Picked` answer replaces
     * the skills main remembers. `Cancelled` and `Unreadable` keep the
     * skills of the `Picked` answer before.
     */
    readonly pick: Effect.Effect<SkillFoldersPickOutcome>;

    /**
     * Reads the folder of the skill `name` of the last `Picked` answer again,
     * and returns its tar archive (see `buildSkillFolderArchive`). Fails with
     * SkillNotPicked when `name` was not in that answer, or there was none,
     * and with SkillArchiveBuildRunning while another archive is being
     * built, so main holds at most one archive at a time.
     */
    readonly buildArchive: (
      name: string,
    ) => Effect.Effect<SkillArchiveBuildOutcome, SkillNotPicked | SkillArchiveBuildRunning>;
  }
>()("hercule/desktop/PickedSkillFolders") {}

/** Builds the PickedSkillFolders service, with the window's folder dialog. */
export const PickedSkillFoldersLayer: Layer.Layer<PickedSkillFolders, never, MainWindow> =
  Layer.effect(PickedSkillFolders)(
    Effect.gen(function* () {
      const window = yield* MainWindow;
      const loadReader = yield* Effect.cached(
        Effect.promise(() => import("@hercule/client-core/skill-folder")),
      );
      // The folder of each skill of the last `Picked` answer, by the skill's
      // name, or null before the first `Picked` answer. Main keeps nothing
      // else of the answer: the renderer holds the rest.
      const pickedFolders = yield* Ref.make<ReadonlyMap<string, string> | null>(null);
      const building = yield* Ref.make(false);

      const pick = Effect.gen(function* () {
        const folder = yield* window.pickFolder;
        if (folder === null) return { _tag: "Cancelled" } as const;
        const reader = yield* loadReader;
        return yield* reader.findSkillFolders(folder).pipe(
          Effect.tap((found) =>
            Ref.set(
              pickedFolders,
              new Map(found.skills.map((skill) => [skill.name, skill.folder])),
            ),
          ),
          Effect.map((found): SkillFoldersPickOutcome => ({
            _tag: "Picked",
            displayPath: found.displayPath,
            lockFileProblem: found.lockFileProblem,
            skills: found.skills.map(({ name, source }) => ({ name, source })),
          })),
          Effect.catchTag("SkillFolderUnreadable", (error) =>
            Effect.succeed({ _tag: "Unreadable", reason: error.reason } as const),
          ),
        );
      });

      const buildArchive = (name: string) =>
        Effect.gen(function* () {
          const folders = yield* Ref.get(pickedFolders);
          if (folders === null) {
            return yield* new SkillNotPicked({ message: "no folder of skills has been picked" });
          }
          const folder = folders.get(name);
          if (folder === undefined) {
            return yield* new SkillNotPicked({
              message: `${JSON.stringify(name)} is not a skill of the folder picked last`,
            });
          }
          const reader = yield* loadReader;
          if (yield* Ref.getAndSet(building, true)) {
            return yield* new SkillArchiveBuildRunning({
              message:
                "another skill's archive is still being built, and they are built one at a time",
            });
          }
          return yield* reader.buildSkillFolderArchive(folder).pipe(
            Effect.map((archive): SkillArchiveBuildOutcome => ({ _tag: "Archive", archive })),
            Effect.catchTags({
              SkillTooLarge: () => Effect.succeed({ _tag: "TooLarge" } as const),
              SkillFolderUnreadable: (error) =>
                Effect.succeed({ _tag: "Unreadable", reason: error.reason } as const),
            }),
            Effect.ensuring(Ref.set(building, false)),
          );
        });

      return PickedSkillFolders.of({ pick, buildArchive });
    }),
  );
