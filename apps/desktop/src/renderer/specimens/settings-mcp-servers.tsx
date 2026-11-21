/**
 * The Settings > MCP servers specimen: the app's real shell with Settings
 * open on the MCP servers section, drawn from the world in mcp-fixture.ts.
 * `capture:ui` draws its four states (scripts/ui-screens.ts); open it in the
 * dev server for a check by eye.
 *
 * The page takes its theme from `?theme=whitehaven` or `?theme=orient-express`,
 * and opens the state its `?state=` names:
 * - none or `list`: the list, with a server in each state and the default list;
 * - `page`: the page of Linear's server, which needs sign-in, at its top;
 * - `projects`: the page of the hobby Sentry server scrolled to Projects, with
 *   the refusal open on webshop, whose list names the other server `sentry`;
 * - `picker`: the list with the picker of the default list open.
 */
// The fixed clock comes first: a page places a time against the moment the
// server was checked, and the sidebar's age clock reads the time when it loads.
import "./fixed-clock";
import {
  MCP_HOBBY_SERVER_ID,
  MCP_LINEAR_SERVER_ID,
  MCP_RECORDS,
  MCP_SETTINGS_PAGE_RECORDS,
} from "./mcp-fixture";
import { pressPart, waitForPart } from "./mcp-script";
import { mountMcpServersSettingsSpecimen } from "./shell-page";
import { markSheetReady } from "./sheet-page";

const state = new URLSearchParams(location.search).get("state") ?? "list";

/** The address the section opens at for `?state=`. Fails for a state the specimen does not draw. */
function chooseAddress(name: string): string {
  switch (name) {
    case "list":
    case "picker":
      return "/settings/mcp-servers";
    case "page":
      return `/settings/mcp-servers/${MCP_LINEAR_SERVER_ID}`;
    case "projects":
      return `/settings/mcp-servers/${MCP_HOBBY_SERVER_ID}`;
    default:
      throw new Error(`The MCP servers specimen draws no state "${name}".`);
  }
}

await mountMcpServersSettingsSpecimen(MCP_SETTINGS_PAGE_RECORDS, chooseAddress(state), MCP_RECORDS);
const style = document.createElement("style");
style.textContent = "* { animation: none !important; }";
document.head.append(style);
if (state === "projects") {
  // Ticking webshop while its list names the other `sentry` opens the refusal.
  await waitForPart(".mcp-proj-row");
  const webshop = [...document.querySelectorAll<HTMLElement>(".mcp-proj-row")].find((row) =>
    row.textContent?.startsWith("webshop"),
  );
  webshop?.querySelector<HTMLInputElement>("input")?.click();
  await waitForPart(".mcp-clash");
  const body = document.querySelector(".set-body");
  if (body === null) throw new Error("The Settings specimen draws no section body.");
  body.scrollTop = body.scrollHeight;
}
if (state === "picker") {
  await pressPart('section[aria-label="Threads without a project"] button');
  await waitForPart("dialog[open].mcp-picker .mcp-pick-row");
}
await markSheetReady();
