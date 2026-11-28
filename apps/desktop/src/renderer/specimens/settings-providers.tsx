/**
 * The Settings > Providers specimen: the app's real shell with Settings
 * open on the Providers section, drawn from the records in
 * settings-providers-fixture.ts. No capture script draws it; open it in the
 * dev server for a check by eye.
 *
 * The page takes its theme from `?theme=whitehaven` or `?theme=orient-express`.
 * `?sheet=<name>` opens the sheet of the account whose card is called that,
 * such as `?sheet=Anthropic%20%C2%B7%20Work`. `?add=<step>` presses the
 * header's Add an account and goes on to the step of the add-account sheet:
 * `provider`, `kind` (Anthropic's three), `key` (Z.ai's), `label` (after
 * Z.ai's key) or `sign-in` (Anthropic's subscription, after its label). The
 * stubbed controller answers the create. `&focus` leaves the focus where the
 * sheet put it, so the ring shows. `?picker=<account>` opens the picker of the
 * account's "Add a model" (`?picker=Anthropic`), and `?rowmenu=<model>` opens
 * the ⋯ menu of that model's first row (`?rowmenu=Fable%205.1`).
 * `?profiles=2` adds a second Model Profile, "Work", so the tabs show;
 * `?tabmenu` opens the open tab's ⌄ menu, `?rename` edits the open tab's name,
 * `?newprofile` opens the New profile dialog, and `?deleteprofile` the
 * delete confirmation of the open profile. `?empty` empties the open profile,
 * so the page teaches; `?addmenu` opens the menu of "Add an account to
 * <profile>". `?noaccounts` removes every account, and with them every
 * profile's sections, so the page says there is no account and the Models
 * section still teaches (it works with `?profiles=2`).
 */
import { mountProvidersSettingsSpecimen } from "./shell-page";
import { markSheetReady } from "./sheet-page";
import {
  PROVIDERS_SETTINGS_RECORDS,
  PROVIDERS_SIDEBAR_RECORDS,
  PROVIDER_MODEL_PROFILES,
} from "./settings-providers-fixture";
import {
  OPENROUTER_ACCOUNT,
  OPENROUTER_CATALOG,
  addOpenRouterSection,
} from "./model-browser-fixture";

/** Waits for the frame after `find` returns an element, and returns it. */
async function waitFor<T>(find: () => T | null | undefined, what: string): Promise<T> {
  const deadline = performance.now() + 10_000;
  for (;;) {
    const found = find();
    if (found !== null && found !== undefined) return found;
    if (performance.now() > deadline) throw new Error(`The page never showed ${what}.`);
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
}

/** Clicks the enabled button `text` in the open sheet, or the page when no sheet is open. */
async function clickButton(text: string): Promise<void> {
  const button = await waitFor(
    () =>
      [...document.querySelectorAll<HTMLButtonElement>("dialog[open] button, .bar button")].find(
        (each) => each.textContent.trim() === text && !each.disabled,
      ),
    `the button ${text}`,
  );
  button.click();
}

/** Types `value` into the sheet's one input, which React reads from an `input` event. */
async function typeInto(selector: string, value: string): Promise<void> {
  const input = await waitFor(
    () => document.querySelector<HTMLInputElement>(`dialog[open] ${selector}`),
    `the field ${selector}`,
  );
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Opens the add-account sheet and walks it to `step`. */
async function openAddAccountSheet(step: string): Promise<void> {
  await clickButton("Add an account");
  await waitFor(
    () => document.querySelector('dialog[open][aria-label="Add an account"]'),
    "the add-account sheet",
  );
  if (step === "provider") return;
  const tile = async (name: string): Promise<void> => {
    const button = await waitFor(
      () =>
        [...document.querySelectorAll<HTMLButtonElement>("dialog[open] .aa-provider")].find(
          (each) => each.querySelector("b")?.textContent === name,
        ),
      `the tile ${name}`,
    );
    button.click();
  };
  if (step === "kind") return tile("Anthropic");
  if (step === "key" || step === "label") {
    await tile("Z.ai");
    await typeInto('input[type="password"]', "zai-3f9a71c2e5b84d06");
    if (step === "label") await clickButton("Continue");
    return;
  }
  await tile("Anthropic");
  const kind = await waitFor(
    () =>
      [...document.querySelectorAll("dialog[open] .aa-card b")].find(
        (each) => each.textContent === "Claude subscription, signed in on each machine",
      ),
    "the kind",
  );
  (kind as HTMLElement).click();
  await clickButton("Continue");
  await typeInto('input[aria-label="Name"]', "Home");
  await clickButton("Continue");
  await waitFor(
    () => document.querySelector('dialog[open] [role="radiogroup"][aria-label="Machine"]'),
    "the machines",
  );
}

const query = new URLSearchParams(location.search);
const [fixtureMain] = PROVIDER_MODEL_PROFILES;
const noAccounts = query.has("noaccounts");
const main =
  fixtureMain !== undefined && (query.has("empty") || noAccounts)
    ? { ...fixtureMain, accounts: [], defaultEntry: null }
    : fixtureMain;
const baseRecords = noAccounts
  ? { ...PROVIDERS_SIDEBAR_RECORDS, accounts: [] }
  : PROVIDERS_SIDEBAR_RECORDS;
const sidebarRecords =
  query.get("profiles") === "2" && main !== undefined && fixtureMain !== undefined
    ? {
        ...baseRecords,
        modelProfiles: [
          main,
          {
            ...fixtureMain,
            id: "01a06d02-8000-7000-8000-000000000b02",
            name: "Work",
            accounts: noAccounts ? [] : fixtureMain.accounts.slice(1, 2),
          },
        ],
      }
    : main !== undefined && (query.has("empty") || noAccounts)
      ? { ...baseRecords, modelProfiles: [main] }
      : baseRecords;
// `?browse` adds the OpenRouter account, with its 466 models. `?browser` also opens its model browser.
const browsing = query.has("browser") || query.has("browse");
await mountProvidersSettingsSpecimen(
  browsing
    ? {
        ...sidebarRecords,
        accounts: [...sidebarRecords.accounts, OPENROUTER_ACCOUNT],
        modelProfiles: (sidebarRecords.modelProfiles ?? []).map(addOpenRouterSection),
      }
    : sidebarRecords,
  browsing
    ? { ...PROVIDERS_SETTINGS_RECORDS, catalog: OPENROUTER_CATALOG }
    : PROVIDERS_SETTINGS_RECORDS,
);
const sheet = new URLSearchParams(location.search).get("sheet");
if (sheet !== null) {
  const card = document.querySelector<HTMLElement>(`button[title="Open ${sheet}"]`);
  if (card === null) throw new Error(`The page has no card called ${sheet}.`);
  card.click();
  // The dialog focuses its first control, whose ring the page would draw
  // although no key was pressed.
  await new Promise((resolve) => requestAnimationFrame(resolve));
  (document.activeElement as HTMLElement | null)?.blur();
  await new Promise((resolve) => requestAnimationFrame(resolve));
}
// `?picker=<account>` opens the picker of that account's "Add a model", and
// `?rowmenu=<model>` opens the ⋯ menu of the first row of that model.
const picker = new URLSearchParams(location.search).get("picker");
if (picker !== null) {
  const button = document.querySelector<HTMLElement>(
    `button[aria-label="Add a model from ${picker}"]`,
  );
  if (button === null) throw new Error(`The page has no "Add a model" for ${picker}.`);
  button.click();
  await waitFor(() => document.querySelector(".pm-models .line"), "the picker's models");
}
// `?browser` opens the OpenRouter account's model browser. `&bq=<text>` types
// that text into its search, `&bsort=<newest|price|context|name>` picks the
// sort, `&bmaker=<maker>` and `&bcan=<tools|images|reasoning>` turn a facet
// on, and `&bpick=<n>` picks the first n rows.
if (query.has("browser")) {
  (
    await waitFor(
      () =>
        document.querySelector<HTMLElement>(
          'button[aria-label^="Browse "][aria-label$=" from OpenRouter"]',
        ),
      "the Browse button",
    )
  ).click();
  const dialog = await waitFor(
    () => document.querySelector<HTMLElement>("dialog.model-browser[open]"),
    "the model browser",
  );
  await waitFor(() => dialog.querySelector(".mb-row"), "the browser's rows");
  const setField = (element: HTMLInputElement | HTMLSelectElement, value: string): void => {
    const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement : HTMLInputElement;
    Object.getOwnPropertyDescriptor(prototype.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
    );
  };
  const search = query.get("bq");
  if (search !== null)
    setField(dialog.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!, search);
  const sort = query.get("bsort");
  if (sort !== null) setField(dialog.querySelector<HTMLSelectElement>("select")!, sort);
  const facet = (text: string): void => {
    [...dialog.querySelectorAll<HTMLElement>(".mb-check")]
      .find((each) => each.textContent.startsWith(text))
      ?.querySelector("input")
      ?.click();
  };
  const maker = query.get("bmaker");
  if (maker !== null) facet(maker);
  const can = query.get("bcan");
  if (can !== null)
    facet({ tools: "Use tools", images: "Read images", reasoning: "Reason" }[can] ?? can);
  const context = query.get("bcontext");
  if (context !== null) {
    [...dialog.querySelectorAll<HTMLElement>(".mb-seg button")]
      .find((each) => each.textContent === context)
      ?.click();
  }
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const pick = Number(query.get("bpick") ?? 0);
  for (const row of [...dialog.querySelectorAll<HTMLElement>(".mb-row:not(.is-held)")].slice(
    0,
    pick,
  ))
    row.click();
}
const rowMenu = new URLSearchParams(location.search).get("rowmenu");
if (rowMenu !== null) {
  const button = [...document.querySelectorAll<HTMLElement>(".pm-row")]
    .find((row) => row.querySelector("b")?.textContent === rowMenu)
    ?.querySelector<HTMLElement>(".pm-more");
  if (button === undefined || button === null)
    throw new Error(`The page has no row for ${rowMenu}.`);
  button.click();
}
// The open tab's ⌄ menu, and what its items open.
const openTabMenu = async (item?: string): Promise<void> => {
  const button = await waitFor(
    () => document.querySelector<HTMLElement>(".pm-tabmore"),
    "the open tab's ⌄ button",
  );
  button.click();
  if (item === undefined) return;
  const target = await waitFor(
    () =>
      [...document.querySelectorAll<HTMLElement>(".pm-tabmenu [role='menuitem']")].find(
        (each) => each.textContent.trim() === item,
      ),
    `the menu item ${item}`,
  );
  target.click();
};
if (query.has("tabmenu")) await openTabMenu();
if (query.has("rename")) await openTabMenu("Rename");
if (query.has("deleteprofile")) await openTabMenu("Delete…");
if (query.has("addmenu")) {
  (
    await waitFor(
      () => document.querySelector<HTMLElement>(".pm-addacct"),
      "the Add an account row",
    )
  ).click();
}
if (query.has("newprofile")) {
  (await waitFor(() => document.querySelector<HTMLElement>(".pm-tab--new"), "New profile")).click();
  await waitFor(() => document.querySelector("dialog.new-profile-dialog[open]"), "the dialog");
}
const add = new URLSearchParams(location.search).get("add");
if (add !== null) {
  await openAddAccountSheet(add);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  if (!new URLSearchParams(location.search).has("focus")) {
    (document.activeElement as HTMLElement | null)?.blur();
  }
}
const style = document.createElement("style");
style.textContent = "* { animation: none !important; }";
document.head.append(style);
await markSheetReady();
