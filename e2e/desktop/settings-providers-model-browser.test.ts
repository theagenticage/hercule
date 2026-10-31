/**
 * Tests the model browser of Settings > Providers and what it is for, in the
 * packaged app, signed in to a real controller (spec 17 "The model browser",
 * spec 06 sections 10.4 and 16): an OpenRouter account with a 466-model Model
 * Catalog gets three models added to "Main" from the browser, and a thread
 * started on one of them runs in the real pi.
 *
 * Nothing here spends a token or reaches OpenRouter:
 *
 * - The account, its key and its catalog are written into the controller's
 *   database while it is stopped (`writeProviderAccounts`). The catalog was
 *   "just read" and so was the usage, so the controller sends the key nowhere.
 * - The machine is a real runner, the compiled `hercule runner` on a Hercule
 *   Home of its own, with the real pi first on its `PATH`. pi's `models.json`
 *   for the account points the `openrouter` provider at a fake upstream on
 *   loopback, which records the model id each request names and answers with
 *   a fixed sentence.
 * - The runner's proxy settings name a port nothing listens on, so a request
 *   to anywhere but loopback fails at once. pi's refresh of its model list in
 *   the probe is the one that would otherwise go out, with the dummy key.
 *
 * The catalog's models are ones pi does not ship, so the controller sends
 * them to the runner as `unlistedModels` and the pi adapter declares them in
 * `models.json`. The fake upstream receiving the exact id of the picked model
 * shows that whole path works.
 *
 * Skips without `pi` on the `PATH`. Run `pnpm build:binary` and then
 * `pnpm build:desktop` first.
 */
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { delimiter, join } from "node:path";
import type { Locator, Page } from "playwright";
import { describe, expect, it } from "vitest";
import {
  writeProviderAccounts,
  type ProviderAccountFixture,
} from "../../apps/desktop/scripts/provider-account-fixtures";
import { pollUntil } from "../../apps/desktop/scripts/poll";
import { buildOpenRouterCatalog } from "../../apps/desktop/src/renderer/specimens/openrouter-catalog";
import type { ProviderAccount } from "../../packages/contract/src/index";
import { findCompiledBinary, runCli, type Ran } from "../../scripts/controller-process";
import { buildHarnessHomeDir, createTemporaryHome } from "../harness";
import {
  arrangeFleet,
  chooseMenuItem,
  findUnusedLoopbackUrl,
  keepWindowOnTop,
  openSignedIn,
  startServerForTest,
} from "./harness";

const OPENROUTER = "openrouter/openrouter";
const PI = "pi/pi";

/** The key the account stores. It is not an OpenRouter key and is sent only to the fake upstream. */
const DUMMY_KEY = "sk-or-dummy-key-for-a-test-only";

/** What the fake upstream answers with, so the transcript shows it came from there. */
const FAKE_ANSWER = "Hello from the fake upstream.";

/** The name the real runner is given, which the thread's lip shows. */
const RUNNER_NAME = "forge";

const FIXTURE: ProviderAccountFixture = {
  providerId: OPENROUTER,
  kind: "api-key",
  defaultHarnessId: PI,
  apiKey: DUMMY_KEY,
  catalog: buildOpenRouterCatalog(),
};

/** Opens Settings from the sidebar's foot, then Providers from the Settings list. */
async function openProviders(page: Page): Promise<void> {
  await page.locator(".side-foot").getByRole("link", { name: "Settings" }).click();
  await page
    .getByRole("navigation", { name: "Settings" })
    .getByText("Providers", { exact: true })
    .click();
  await expect.poll(() => page.locator(".bar .title").textContent()).toBe("Providers");
}

/** Returns the full path of the program `name` on the `PATH`, or undefined when there is none. */
function findOnPath(name: string): string | undefined {
  return (process.env["PATH"] ?? "")
    .split(delimiter)
    .map((folder) => join(folder, name))
    .find((path) => existsSync(path));
}

/**
 * Starts an HTTP server that answers like OpenAI's chat completions API with
 * `FAKE_ANSWER`, and returns the model id each completion request named. The
 * server stops when the test finishes. Any other request gets an empty list
 * of models.
 */
async function startFakeUpstream(): Promise<{
  readonly baseUrl: string;
  readonly readRequestedModels: () => string[];
}> {
  const requested: string[] = [];
  const answer = (request: IncomingMessage, response: ServerResponse): void => {
    if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [] }));
      return;
    }
    let body = "";
    request.setEncoding("utf8").on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      requested.push((JSON.parse(body) as { model: string }).model);
      const chunk = (choice: object, extra: object = {}): string =>
        `data: ${JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          created: 1789373122,
          model: "fake-model",
          choices: [{ index: 0, ...choice }],
          ...extra,
        })}\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.end(
        chunk({ delta: { role: "assistant", content: "" }, finish_reason: null }) +
          chunk({ delta: { content: FAKE_ANSWER }, finish_reason: null }) +
          chunk({ delta: {}, finish_reason: "stop" }) +
          "data: [DONE]\n\n",
      );
    });
  };
  const server = await startServerForTest(answer);
  return { baseUrl: `${server.url}/v1`, readRequestedModels: () => [...requested] };
}

/** Opens a Draft Thread in the project "notes" from File > New Thread, and ⌘1. */
async function openDraft(app: Parameters<typeof chooseMenuItem>[0], page: Page): Promise<void> {
  await chooseMenuItem(app, "File", "New Thread");
  await page.getByRole("dialog", { name: "New thread in" }).waitFor();
  await page.keyboard.press("Meta+1");
  await page.getByRole("heading", { name: "What should the agent do in notes?" }).waitFor();
}

/** Returns the slug and the name of the model a row of the browser's table shows. */
async function readRow(row: Locator): Promise<{ slug: string; name: string }> {
  return {
    slug: (await row.getAttribute("data-key"))!,
    name: (await row.locator("b").textContent())!,
  };
}

const piBinary = findOnPath("pi");

describe("Settings > Providers > model browser", () => {
  it.skipIf(piBinary === undefined)(
    "adds three of 466 models to Main, and a thread on one of them runs in pi",
    async () => {
      const arranged = await arrangeFleet();
      const { url, home, fleet, client } = arranged;
      const binary = findCompiledBinary();
      await fleet.createProject("notes");
      await arranged.restartController(() => {
        writeProviderAccounts(home, [FIXTURE]);
      });
      const seeded = (await fleet.call<ProviderAccount[]>("GET", "/provider-accounts")).find(
        ({ providerId }) => providerId === OPENROUTER,
      )!;
      expect(seeded.modelCount).toBe(466);

      // The real runner: a Hercule Home of its own, and only pi and node on its PATH, so it
      // finds no Claude Code or Codex to probe or run.
      const upstream = await startFakeUpstream();
      const machine = createTemporaryHome();
      let daemon: Promise<Ran> | undefined;
      let runnerId: string | undefined;
      try {
        const tools = join(machine.home, "tools");
        mkdirSync(tools);
        symlinkSync(realpathSync(piBinary!), join(tools, "pi"));
        symlinkSync(process.execPath, join(tools, "node"));
        mkdirSync(join(machine.home, "user"));
        const deadProxy = await findUnusedLoopbackUrl();
        const env = {
          PATH: `${tools}${delimiter}/usr/bin${delimiter}/bin`,
          HOME: join(machine.home, "user"),
          HTTP_PROXY: deadProxy,
          HTTPS_PROXY: deadProxy,
          NO_PROXY: "127.0.0.1,localhost",
        };

        const { token } = await fleet.call<{ token: string }>("POST", "/runners/join-tokens");
        const joined = await runCli(["runner", "join", url, "--token", token, "--no-service"], {
          home: machine.home,
          binary,
          env,
        });
        expect(joined.code, `${joined.stdout}\n${joined.stderr}`).toBe(0);
        // The Harness Home pi runs the account in. The runner merges the models it declares
        // into this file and keeps the rest of it.
        const harnessHome = buildHarnessHomeDir(machine.home, seeded.id, PI);
        mkdirSync(harnessHome, { recursive: true });
        writeFileSync(
          join(harnessHome, "models.json"),
          JSON.stringify({ providers: { openrouter: { baseUrl: upstream.baseUrl } } }),
        );
        daemon = runCli(["runner"], { home: machine.home, binary, env });
        runnerId = await pollUntil(
          async () =>
            (await client.runner.query({ query: { limit: 10 } })).items.find(
              ({ connectivity }) => connectivity === "online",
            )?.id,
          {
            timeoutMs: 30_000,
            intervalMs: 200,
            timeoutMessage: "the real runner never came online",
          },
        );
        await client.runner.update({ params: { id: runnerId }, payload: { name: RUNNER_NAME } });
        // The runner probes every account when it connects. pi is ready for the account.
        await pollUntil(
          async () =>
            (await fleet.call<ProviderAccount[]>("GET", "/provider-accounts"))
              .find(({ id }) => id === seeded.id)
              ?.snapshots.some(
                (snapshot) => snapshot.runnerId === runnerId && snapshot.auth.status === "ok",
              ) === true
              ? true
              : undefined,
          { timeoutMs: 40_000, intervalMs: 250, timeoutMessage: "pi never probed ready" },
        );

        const { app, page } = await openSignedIn(url);
        await keepWindowOnTop(app);
        await openProviders(page);

        // The account's section is in Main and empty, and the catalog is too large for the picker.
        const section = page.getByRole("region", { name: "OpenRouter", exact: true });
        await section.waitFor();
        expect(await section.locator(".pm-rows li").count()).toBe(0);
        await section.getByRole("button", { name: "Browse 466 models from OpenRouter" }).click();
        const browser = page.getByRole("dialog", { name: "Browse OpenRouter models" });
        const count = browser.getByRole("status");
        await expect.poll(() => count.textContent()).toBe("466 models");
        await expect
          .poll(() =>
            browser.getByLabel("Search models").evaluate((el) => el === document.activeElement),
          )
          .toBe(true);

        // A search narrows the table, and a facet narrows it again. Both are filtered in the page.
        await browser.getByLabel("Search models").fill("claude");
        await expect.poll(() => count.textContent()).not.toBe("466 models");
        const afterSearch = Number.parseInt((await count.textContent())!, 10);
        expect(afterSearch).toBeGreaterThanOrEqual(3);
        await browser.locator("label.mb-check", { hasText: "Reason" }).click();
        await expect
          .poll(async () => Number.parseInt((await count.textContent())!, 10))
          .toBeLessThan(afterSearch);
        expect(Number.parseInt((await count.textContent())!, 10)).toBeGreaterThanOrEqual(3);
        await browser.getByRole("button", { name: "Clear filters" }).waitFor();

        // Pick the first three matches.
        const rows = browser.locator(".mb-row");
        const picks = [];
        for (const at of [0, 1, 2]) {
          picks.push(await readRow(rows.nth(at)));
          await rows.nth(at).click();
        }
        for (const { name } of picks) {
          expect(name.toLowerCase()).toContain("claude");
        }
        expect(
          await browser.getByRole("list", { name: "Models to add" }).locator("li").count(),
        ).toBe(3);
        await browser.getByRole("button", { name: "Add 3 to Main" }).click();
        await browser.waitFor({ state: "hidden" });

        // The section lists the three, in the order they were picked, and the controller holds them.
        await expect
          .poll(() => section.locator(".pm-rows li b").allTextContents())
          .toEqual(picks.map(({ name }) => name));
        const [main] = await client.modelProfile.query();
        const entries = main!.accounts.find(
          ({ providerAccountId }) => providerAccountId === seeded.id,
        )!;
        expect(entries.entries.map(({ model }) => model)).toEqual(picks.map(({ slug }) => slug));

        // A thread started on the first pick runs in pi on the real runner.
        const chosen = picks[0]!;
        await openDraft(app, page);
        const pill = page.locator(".composer-row button.pick--pill");
        const menu = page.getByRole("dialog", { name: "Model", exact: true });
        await pill.click();
        await menu.waitFor();
        await menu.locator("button.line", { hasText: chosen.name }).first().click();
        await menu.waitFor({ state: "hidden" });
        const field = page.getByRole("textbox", { name: "Message" });
        await field.fill("Say hello.");
        await field.press("Enter");
        await page
          .locator('section[aria-label="Transcript"] .msg-body', { hasText: FAKE_ANSWER })
          .waitFor({ timeout: 60_000 });

        const { items } = await client.session.query({ query: { kind: "thread", limit: 10 } });
        expect(
          items.map(({ runnerId: ranOn, providerAccountId, harnessId, modelSelection }) => ({
            ranOn,
            providerAccountId,
            harnessId,
            model: modelSelection.model,
          })),
        ).toEqual([
          { ranOn: runnerId, providerAccountId: seeded.id, harnessId: PI, model: chosen.slug },
        ]);
        // The fake upstream received the picked model's exact id, and no other model.
        expect(upstream.readRequestedModels().length).toBeGreaterThan(0);
        expect(new Set(upstream.readRequestedModels())).toEqual(new Set([chosen.slug]));

        // Nothing went to OpenRouter: the controller did not read the catalog or the usage again.
        const after = (await fleet.call<ProviderAccount[]>("GET", "/provider-accounts")).find(
          ({ id }) => id === seeded.id,
        )!;
        expect(after.catalogReadAt).toBe(seeded.catalogReadAt);
        expect(after.catalogError).toBeNull();
        expect(after.failure).toBeNull();
        expect(after.usage).toEqual([]);
      } finally {
        // A runner still up here means the test failed before the end. Retiring it ends the daemon.
        // The controller's own runner was retired when the fleet was arranged, so the only
        // runner left to retire is the one this test joined, even if it never came online.
        if (daemon !== undefined) {
          // A pi process that is still running holds the daemon's output open, so the daemon
          // would not end.
          const threads = await client.session.query({ query: { kind: "thread", limit: 10 } });
          for (const { id } of threads.items) {
            await client.session.stop({ params: { id } }).catch(() => undefined);
          }
          for (const runner of (await client.runner.query({ query: { limit: 10 } })).items) {
            if (runner.lifecycle !== "retired") {
              await client.runner.retire({ params: { id: runner.id }, payload: { force: true } });
            }
          }
          await daemon.catch(() => undefined);
        }
        machine.remove();
      }
    },
    180_000,
  );
});
