/**
 * The Inbox specimen: the app's real shell with the real Inbox screen open,
 * drawn over the fake controller of inbox-fixture.ts, for a check by eye.
 * `capture:ui` captures it and `ui:metrics` measures it.
 *
 * The page takes its state from `?state=<name>`, one of `INBOX_SCENES`:
 * `waits` (the default), `browse`, `search`, `empty`, `zero`, `loading`,
 * `offline`, `failing`, `selection`, `narrow`, `narrow-menu`, `width-1280`,
 * `width-1024` and `stacked-880`. Its theme comes from `?theme=` and its glass
 * from `?glass=`, as for every specimen.
 */
// The fixed clock comes first: the app's age clock reads the time as soon as
// its module loads.
import "./fixed-clock";
import { INBOX_SCENES, INBOX_SIDEBAR_RECORDS, type InboxScene } from "./inbox-fixture";
import { mountInboxSpecimen } from "./shell-page";
import { markSheetReady } from "./sheet-page";

/** Returns the state the page's `?state=` names. Fails when it names none of them. */
function readScene(): InboxScene {
  const name = new URLSearchParams(location.search).get("state") ?? INBOX_SCENES[0]!.name;
  const scene = INBOX_SCENES.find((each) => each.name === name);
  if (scene === undefined) {
    throw new Error(
      `Unknown state "${name}" in the URL. Use one of: ${INBOX_SCENES.map((each) => each.name).join(", ")}.`,
    );
  }
  return scene;
}

const scene = readScene();
await mountInboxSpecimen(INBOX_SIDEBAR_RECORDS, scene.records);
await scene.play?.(document);
await markSheetReady();
