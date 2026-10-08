/**
 * The Settings > Permission profiles specimen: the app's real shell with
 * Settings open on the Permission profiles section, drawn from the records in
 * settings-profiles-fixture.ts. `pnpm compare:bureau` compares its main pane
 * pixel for pixel with the Bureau book's desktop/settings-profiles.html,
 * edited by settings-profiles-reference.ts to show the same data.
 *
 * The page takes its theme from `?theme=whitehaven` or `?theme=orient-express`,
 * and opens the state the book opens with the same `?state=`:
 * - none: the list of profiles;
 * - `reviewer`: Reviewer's page;
 * - `shipped`: `unrestricted`'s page;
 * - `confirm`: `unrestricted`'s page with the confirmation open, which the
 *   page opens by pressing the verb Delete on Tasks, as the user does.
 *
 * With `?scrolled=1`, it scrolls the section's body to its end, as the
 * reference does, so the sections below the first screen are compared too.
 *
 * The working face's paws tap. The page removes every animation, as the
 * book's page is held still, so the paws rest where they start.
 */
import { mountPermissionProfilesSettingsSpecimen } from "./shell-page";
import { markSheetReady } from "./sheet-page";
import {
  REVIEWER_PROFILE,
  SETTINGS_PROFILES_RECORDS,
  SETTINGS_PROFILES_SCREEN,
  UNRESTRICTED_PROFILE,
} from "./settings-profiles-fixture";

const params = new URLSearchParams(location.search);
const state = params.get("state");

/** The address the section opens at for the book's `?state=`. Fails for a state the book does not draw. */
function chooseAddress(bookState: string | null): string {
  switch (bookState) {
    case null:
      return "/settings/permission-profiles";
    case "reviewer":
      return `/settings/permission-profiles/${REVIEWER_PROFILE.id}`;
    case "shipped":
    case "confirm":
      return `/settings/permission-profiles/${UNRESTRICTED_PROFILE.id}`;
    default:
      throw new Error(`The Permission profiles specimen draws no state "${bookState}".`);
  }
}

await mountPermissionProfilesSettingsSpecimen(
  SETTINGS_PROFILES_RECORDS,
  chooseAddress(state),
  SETTINGS_PROFILES_SCREEN,
);
const style = document.createElement("style");
style.textContent = "* { animation: none !important; }";
document.head.append(style);

if (state === "confirm") {
  // Pressing the verb is how the user opens the confirmation. `unrestricted`
  // holds every grant, so the verb is pressed.
  const deleteVerb = document.querySelector('button[title="task.delete"]');
  if (!(deleteVerb instanceof HTMLElement)) {
    throw new Error("The page draws no Delete verb in its Tasks row.");
  }
  deleteVerb.click();
  const deadline = performance.now() + 5000;
  while (document.querySelector("dialog[open]") === null && performance.now() < deadline) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  if (document.querySelector("dialog[open]") === null) {
    throw new Error("Pressing Delete on Tasks of unrestricted opened no confirmation.");
  }
}
if (params.has("scrolled")) {
  const body = document.querySelector(".set-body");
  if (body === null) throw new Error("The Settings specimen draws no section body.");
  body.scrollTop = body.scrollHeight;
}
await markSheetReady();
