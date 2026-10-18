/**
 * PROTOTYPE (#731): Settings > Skills on the desktop app's real shell, in
 * the scenes the switcher at the bottom offers. Run it with
 *
 *   cd apps/desktop && npx vite --config vite.renderer.config.ts --port 5198
 *
 * and open /specimens/skills-prototype/index.html. The URL keeps
 * `?scene=` and `?theme=`; ← and → step through the scenes.
 */
import "../fixed-clock";
import "../../screens/settings/permission-profiles/permission-profiles.css";
import "./prototype.css";
import { PERMISSION_PROFILES_SIDEBAR_RECORDS } from "../settings-profiles-fixture";
import { mountSkillsPrototype } from "../shell-page";
import { buildScenePath, readPrototype } from "./prototype-state";
import { SkillPageRoute } from "./skill-page";
import { SkillsListRoute } from "./skills-list";
import { Switcher } from "./switcher";

await mountSkillsPrototype(
  PERMISSION_PROFILES_SIDEBAR_RECORDS,
  buildScenePath(readPrototype().scene),
  {
    list: SkillsListRoute,
    page: SkillPageRoute,
    overlay: <Switcher />,
  },
);
