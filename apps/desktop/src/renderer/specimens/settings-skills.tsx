/**
 * The Settings > Skills specimen: the app's real shell with Settings open on
 * the Skills section, drawn from the records in settings-skills-fixture.ts.
 * No capture script draws it yet; open it in the dev server for a check by
 * eye, or list its states in scripts/ui-screens.ts to record goldens.
 *
 * The page takes its theme from `?theme=whitehaven` or `?theme=orient-express`,
 * and opens the state its `?state=` names:
 * - none or `list`: the list, with a proposal on `ship` and the new skill
 *   `release-checklist`;
 * - `proposed`: the page of `release-checklist`, a new skill with Ada's
 *   proposal waiting;
 * - `tainted`: the page of `ship`, with Milo's proposal that includes
 *   third-party content;
 * - `applied`: the page of `release-checklist` after Ada applied it, with
 *   its History.
 *
 * With `?scrolled=1`, it scrolls the section's body to its end.
 */
// The fixed clock comes first: the page places a time against the moment the
// skill was read, and the sidebar's age clock reads the time when it loads.
import "./fixed-clock";
import { mountSkillsSettingsSpecimen } from "./shell-page";
import { markSheetReady } from "./sheet-page";
import { PERMISSION_PROFILES_SIDEBAR_RECORDS } from "./settings-profiles-fixture";
import { buildSkillsRecords, type SkillsState } from "./settings-skills-fixture";

const params = new URLSearchParams(location.search);
const state = params.get("state") ?? "list";

/** The address the section opens at for `?state=`. Fails for a state the specimen does not draw. */
function chooseAddress(name: string): { readonly state: SkillsState; readonly path: string } {
  switch (name) {
    case "list":
      return { state: "list", path: "/settings/skills" };
    case "proposed":
    case "applied":
      return { state: name, path: "/settings/skills/release-checklist" };
    case "tainted":
      return { state: "tainted", path: "/settings/skills/ship" };
    default:
      throw new Error(`The Skills specimen draws no state "${name}".`);
  }
}

const address = chooseAddress(state);
await mountSkillsSettingsSpecimen(
  PERMISSION_PROFILES_SIDEBAR_RECORDS,
  address.path,
  buildSkillsRecords(address.state),
);
const style = document.createElement("style");
style.textContent = "* { animation: none !important; }";
document.head.append(style);
if (params.has("scrolled")) {
  const body = document.querySelector(".set-body");
  if (body === null) throw new Error("The Settings specimen draws no section body.");
  body.scrollTop = body.scrollHeight;
}
await markSheetReady();
