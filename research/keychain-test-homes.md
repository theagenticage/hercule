# Keychain items left by test and scratch homes (#318)

Research for [#318](https://github.com/theagenticage/hercule/issues/318), done 2026-10-02 at `f962cc91`.

## TL;DR

- **The ticket is partly stale.** Its option 2 ("delete the item when the harness removes the home") already landed in `c497e121` (2026-10-02 01:03 +0200, after the issue was filed on 2026-10-01 21:30Z). Every in-repo harness that boots a controller now calls `deleteMasterKeyItem(home)` on cleanup (`scripts/controller-process.ts:59-64`).
- **Items still leak** from:
  - runs that crash or are killed before `afterAll`/`finally`;
  - agents' ad hoc scratch runs (`HERCULE_HOME=/tmp/...`), which follow the AGENTS.md rule but delete nothing;
  - any future script that forgets the delete.
- **This machine holds 4,513 Hercule items**: 4,483 for paths that no longer exist, 30 for paths that still exist. The `hydra-e2e-*` items the ticket counts are already gone. All 4,513 predate or bypass the fix.
- **Recommendation: rewrite #318 as three parts.**
  1. Option 1: a new bootstrap key, `master_key.store = "keychain" | "file"`. This gives `HERCULE_MASTER_KEY_STORE` and `-c master_key.store=file` for free. The harness sets it to `file`, so tests never reach the keychain.
  2. Remove `deleteMasterKeyItem` and the `BootOptions.masterKeyBackend` seam, so there is one path to the decision. Add a darwin e2e check that a booted scratch home leaves no item.
  3. A one-off cleanup script for the 4,483 dead items (dry run by default).
- **One spec conflict to resolve first**: spec 15 §6 allows only keys "needed before the database can open", and says the list has "four keys". The key store needs that test reworded (draft below).

## Current state

### How the master key is stored

`apps/controller/src/secrets/masterKey.ts`:

- `KEYCHAIN_SERVICE = "Hercule"` (:45). An item is a generic password with service `Hercule`, and its account is the absolute home path (`createKeychainStore(home.home)`, :301).
- The keychain store (:207-267):
  - It reads with `security find-generic-password -s Hercule -a <home> -w`.
  - Exit code 44 means "not found" (:48).
  - It writes with `add-generic-password` (no `-U`). On failure it reads the item back, which handles two first boots racing.
- The file store (:106-162) uses `<home>/master.key`:
  - It refuses a file whose mode is not 0600 and checks that the key is 32 bytes.
  - It writes with `wx`, and on EEXIST it reads the other boot's key.
- `type MasterKeyBackend = "keychain" | "file"` (:270). `defaultBackend` is `"keychain"` on darwin and `"file"` elsewhere (:273).
- `masterKeyLayer(backend = defaultBackend)` (:293-332). When the store holds no key but the database holds secrets, it fails with `MasterKeyError` and does not mint a new key (:305-315).
  - A booted home always holds at least one secret: the controller identity's signing key is a `core` secret (`apps/controller/src/identity/repository.ts:101-172`).
  - So switching the store on a booted home refuses to start, loudly. Nothing is migrated, and nothing fails silently.

### Who picks the store

- Production: `apps/controller/src/index.ts:180` calls `bootWith({ argv, env: process.env, localRunner })` with no backend, so the platform default applies.
- In-process tests pass `masterKeyBackend: "file"` through `BootOptions` (`apps/controller/src/bootstrap.ts:213`, used at :305). The callers are:
  - `bootstrap.test.ts:41,46,147,167,236`
  - `runners/local.test.ts:219,394,456,478,548`
  - `http/testing.ts:171`
  - `plugins/testing.ts:80`
  - `secrets/service.test.ts:46`, `secrets/repository.test.ts:33,187,222`
  - `identity/repository.test.ts:18`
  - `connections/service.test.ts:56`
  - `controller/service.test.ts:34`
  - `sessions/service.integration.test.ts:75`
  - `secrets/masterKey.test.ts:34`
- **Subprocess controllers** (the binary e2e suite, the desktop e2e suite, the desktop perf and packaging scripts) cannot pass that option. On macOS they always use the keychain. This is the leak.

### What `c497e121` already did

`deleteMasterKeyItem(home)` (`scripts/controller-process.ts:59-64`) runs `security delete-generic-password -s Hercule -a <home>` on darwin. It is called from:

- `e2e/harness.ts:142-145`: `createTemporaryHome().remove`. Every e2e file calls this in `afterAll`, and `e2e/desktop/harness.ts:215-227` calls it in `onTestFinished`.
- `apps/desktop/scripts/perf-fixture.ts:389-390`, in a `finally` block.
- `apps/desktop/scripts/packaged-app.ts:339-352`, in a `finally` block.

It works for runs that end normally. A concurrent desktop e2e run created two items at 2026-10-02 21:21Z, and a minute later `find-generic-password` returned 44 for both.

### Keychain counts on this machine (read only)

Source: `security dump-keychain login.keychain-db` without `-d`, so attributes only. No secret values were read.

| Account prefix | Items |
|---|---|
| `$TMPDIR/hercule-e2e-*` | 4,088 |
| `/tmp/hercule-ab/...` | 133 |
| `$TMPDIR/hercule-desktop-perf-home-*` | 84 |
| `/tmp/hercule-layer/...` | 36 |
| `$TMPDIR/hercule-desktop-home-*` | 36 |
| `w3-perf-home-*` | 20 |
| `hercule-mem-home-*` | 18 |
| `/tmp/hercule-visual/...` | 16 |
| `w5-wakeups-home-*` | 9 |
| long tail (`/tmp/p02x-*`, `/tmp/hercule-proof-*`, ...) | rest |
| `hydra-e2e-*` | 0 |
| **Total** | **4,513** (4,483 path gone, 30 path exists) |

- Items by creation date: 1,134 on 09-29, 2,064 on 09-30, and 183 on 10-01.
- None of the `hercule-ab`, `hercule-layer`, `hercule-visual`, `w3-`, `w5-` or `mem-home` prefixes appear in the repo. They come from agents' ad hoc runs.
- The 30 live items belong to leftover `hercule-e2e-*` dirs from crashed runs, two `/tmp` scratch homes, and possibly a concurrent run.
- There is no item for `~/.hercule`, which does not exist on this machine.

## Findings per question

### 1. The current mechanism

See "Current state" above. In short:

- The store is chosen by platform.
- In-process tests override it with `BootOptions.masterKeyBackend`.
- Subprocess controllers cannot override it.
- Leaks are cleaned up after the fact by `deleteMasterKeyItem`.

### 2. Where config is read

- `apps/controller/src/config/index.ts` `layer(argv, env)` runs these steps:
  1. `parseGlobalOptions`.
  2. Refuses extra args.
  3. `resolveHomePath`.
  4. `writeDefaultConfigFile`.
  5. `loadBootstrapConfig`.
  6. `buildHomePaths` and `createLayout`.
- The whole thing is provided at `bootstrap.ts:432`. `BootstrapConfig` is already read inside the boot sequence (`bootstrap.ts:280`), so `masterKeyLayer` can read it as well.
- `packages/home/src/config.ts`:
  - `BootstrapConfig` (:40-48).
  - `BOOTSTRAP_KEYS` (:51), with the comment "Nothing else may be added (spec 15 section 6)" (:50).
  - `buildEnvName` (:59-61).
  - `DEFAULTS` (:68-73).
  - `SCHEMAS` (:104-118).
  - `writeDefaultConfigFile` writes the defaults only when no file exists (:136-144).
  - `readConfigFile` rejects unknown keys (:151-176).
  - `resolveConfig` resolves flag > env > file > default, and its error messages name the source (:189-236).
- `packages/home/src/args.ts` parses `--home` and `-c key=value`. `packages/home/src/paths.ts` resolves the home path in the order `--home`, `HERCULE_HOME`, `~/.hercule`.

### 3. Spec, ADRs, contradictions

The texts that describe the store as "keychain on macOS, file elsewhere", with no override:

- spec 13 §2.2 (`docs/spec/13-security.md:68-73`)
- spec 13 §12 (:368)
- spec 15 §5 layout (`docs/spec/15-packaging-and-operations.md:147`) and :188
- spec 15 §7 step 3 (:224)
- spec 04 (`docs/spec/04-state-store.md:121,137`)
- ADR 0015 (`docs/adr/0015-...md:3`)
- CONTEXT.md:149-151

**Contradicts spec 15 §6** (:194, :205, :216), on two counts:

- A store key is not "needed before the database can open". It is needed before the database's secrets can be read.
- §6 says the list is "four keys", and that nothing else may be added "without meeting the tier-1 test".

The key cannot live in controller state, for two reasons:

- Reading it would need the very key it chooses.
- It is bound to the machine, while the Data Root moves with promotion.

So the tier-1 test needs rewording, not an exception.

There is already a stale line to fix while we are there: spec 15 §5 :147 and :188 still say "headless Linux only". Spec 13 §2.2 narrowed this on 2026-09-04: every platform but macOS always uses the key file.

There are two precedents for this change:

- Spec 17:812: desktop tests pass `--use-mock-keychain` "so no test touches the real Keychain".
- Spec 13 §1: a weaker but allowed configuration prints a warning and does not refuse to start. That is the perimeter warning, `apps/controller/src/index.ts:156-157`.

Draft wording is in the implementation plan below.

### 4. Config key vs env var vs flag

**Recommendation: a bootstrap key, `master_key.store`, with the values `keychain` and `file`.**

- **A dedicated flag** (`--master-key-store`) contradicts spec 15 §6: "there are no curated per-key flags... `--home` is the only dedicated flag."
- **A bare test-only env var** outside `BOOTSTRAP_KEYS` would be a second, hidden config path:
  - It skips Effect Schema decoding and the error messages that name the source.
  - It does not persist per home.
  - The service unit would not protect against it (see the last bullet).
- **A bootstrap key** gets all of these for free:
  - `-c master_key.store=file` and `HERCULE_MASTER_KEY_STORE=file`, through `buildEnvName`.
  - Decoding, with an error message that names whether the bad value came from the flag, the env or the file.
  - It persists in `config.toml`, so a home keeps its store across restarts.
  - `hercule service install` refuses a bootstrap `HERCULE_*` variable (`packages/service/src/install.ts:56-65`), and the systemd unit unsets every one (`packages/service/src/unit.ts:201`). So a variable left in a shell profile cannot leak into the installed service. This covers the new key automatically.
- **The name.** The ticket's `secrets.masterKeyStore` maps to `HERCULE_SECRETS_MASTERKEYSTORE`, which is hard to read. `master_key.store` maps to `HERCULE_MASTER_KEY_STORE`. Snake case inside a segment is new here, but it keeps the mechanical env rule readable. `masterKey.store` would give `HERCULE_MASTERKEY_STORE`.
- **One spelling (AGENTS.md naming rule 4).** The code says `MasterKeyBackend` and `defaultBackend`, while the functions say `createFileStore` and `createKeychainStore`. Rename the type and field to "store" (`MasterKeyStore`, `masterKeyStore`) in the same change.

### 5. Every place that makes a throwaway home

Homes where a controller boots:

| Where | Prefix | Spawn | Cleanup |
|---|---|---|---|
| `e2e/harness.ts:126-147` `createTemporaryHome` | `hercule-e2e-` | `startControllerOnPort` | `remove` deletes the dir and the item |
| `e2e/desktop/harness.ts:215-227` `startControllerForTest` | `hercule-e2e-` | `startControllerOnPort` | `onTestFinished(remove)` |
| `apps/desktop/scripts/perf-fixture.ts:180` | `hercule-desktop-perf-home-` | `startSetUpController`, restarted at :296 | `finally` at :389-390 |
| `apps/desktop/scripts/packaged-app.ts:339-352` | `hercule-desktop-home-` | `startSetUpController` | `finally` |

- Every row above spawns through **one function**, `startControllerOnPort` (`scripts/controller-process.ts:158-162`): `env: { ...buildCleanEnv(), ...env, HERCULE_HOME: home }`. Restarts go through it too.
- `buildCleanEnv` strips every `HERCULE_*` variable (:43-50), so a developer's shell cannot leak in.
- `runCli` (:257) runs the CLI, which is HTTP only and never reads the master key.

Every e2e file uses `createTemporaryHome` with `remove` in `afterAll`: agent-session, api, cli, live, github-push, logs, session-tool, subscription-wake, runner, session, workflows, workspace, web, workspace-steps.

These make a temp dir but boot no controller, so they are out of scope:

- `apps/desktop/scripts/first-frame.ts:630-631`
- `apps/desktop/scripts/perf.ts:343,1259` (user data dirs)
- `apps/desktop/scripts/sheet-server.ts:117`
- `apps/desktop/src/main/testing.ts:75`
- `install.test.ts:95`, which uses a fake `hercule` that only records its args (:141)
- `packages/home/src/config.test.ts:12`

Other roles never touch the master key: the runner, the CLI, `hercule service`, and the desktop main process (which uses Electron `safeStorage`, spec 17).

**The `Library` symlink.** `e2e/harness.ts:130-132` links `$HOME/Library` into gitconfig homes on darwin. Those homes are handed to the controller as `HOME` in `workspace.test.ts:177,202`, `workspace-steps.test.ts:202,221` and `github-push.test.ts:291,299`.

- The stated reason (:121-124, added in `a5caaa2e`) is only the master key: "`security` finds [the login keychain] under `$HOME/Library/Keychains`, so without it the controller cannot boot".
- With the file store, that reason goes away.
- But the live-session cases in those files run a real Claude Code CLI under `HOME=<gitHome>`, and on macOS the CLI keeps its login in the keychain. The symlink may quietly be what lets those cases sign in.
- This must be checked on a Mac with a login before the symlink is removed (open question 5).

### 6. Tests and CI feasibility

- **CI.**
  - `ubuntu-latest` runs typecheck, lint, test, dep-lint, `build:binary` and `test:binary` (`.github/workflows/ci.yml:24-46`). The file store is already in use there.
  - The macOS `desktop` job (:57) runs `install.test.ts`, `build:desktop` and `compare:bureau`. None of these boots a controller.
  - The macOS `edge-build` job on `main` (:103, :222-262) runs `hercule service install` with `HERCULE_HOME: ${{ runner.temp }}/hercule-home`. That is the only CI path that uses the real keychain. It stays on the keychain, because it runs no harness and sets no store.
- **So a darwin-only e2e check runs only on developer Macs.** That is acceptable: the leak only happens on developer Macs.
- **Unit tests (Linux and macOS):**
  - `packages/home/src/config.test.ts`: `buildEnvName("master_key.store")` is `HERCULE_MASTER_KEY_STORE`, and the key resolves through flag, env and file.
  - Decoding refuses an unknown value, and refuses `keychain` on a platform with no keychain store. The error names the source.
  - `masterKeyLayer` reads the store from `BootstrapConfig`. The existing store tests in `masterKey.test.ts:138-227` stay as they are, because they test the stores directly.
  - `apps/controller/src/config/index.test.ts:56-63` pins the exact default `config.toml`. It changes if first run writes the new key (open question 2).
- **e2e (darwin only, `it.runIf(process.platform === "darwin")`):** boot a scratch controller through the harness, then assert that `security find-generic-password -s Hercule -a <home>` (no `-w`) exits 44. Also assert that `<home>/master.key` exists with mode 0600.

### 7. CLI row or contract change

None. No operation is added or changed, so spec 11 §6.3 (a CLI row per operation) does not apply. Only bootstrap config changes. The `hercule serve` usage string (`USAGE` in `apps/controller/src/config/index.ts`) already covers `-c key=value`.

### 8. Cleanup script and the item count

The count is in "Keychain counts" above.

Design for `scripts/delete-dead-master-key-items.ts` (Bun TS, like the other scripts):

- **macOS only.** On other platforms it exits with a message that there is nothing to clean.
- **Read the items:**
  - Parse `security dump-keychain <login keychain path>` without `-d`, so no secret values are read.
  - Select `class: "genp"` items whose `svce` is `"Hercule"`.
  - Decode the `acct` value. It is either `"<path>"` or `0x<HEX>  "..."` for bytes that are not printable.
- **Choose which items to delete.** All three conditions must hold:
  - The account is an absolute path.
  - The path does not exist.
  - The path is under a temp root: `os.tmpdir()`, `/var/folders`, `/tmp` or `/private/tmp`.
- **What it lists but never deletes:**
  - Dead paths outside a temp root, because an unmounted volume looks dead.
  - The resolved default home (`HERCULE_HOME` or `~/.hercule`), even when it looks dead.
- **Dry run by default.** `--delete` acts.
- **How it deletes:** `security delete-generic-password -s Hercule -a <exact path> <keychain path>`.
  - Both `-s` and `-a` are required. With `-s` alone, `security` deletes the first `Hercule` item it finds, which could be a live home's key.
  - The keychain argument limits the search to the login keychain.
- **Concurrent runs:** it checks the path again right before each delete, so it tolerates a run that is still going.
- **Output:** never prints secret values. It reports counts: deleted, kept (path exists), and listed for review.
- **Speed:** about 4,500 `security` calls, so expect minutes. Print progress.
- **Keep it in `scripts/`.** Agents' ad hoc runs will keep leaking items until they set the store, and crashed runs always will.

### 9. Options 2 and 3

- **Option 2 (delete on cleanup)** is done (`c497e121`).
  - Once option 1 lands, recommend removing it. With the delete in place, a harness change that drops the store setting would still leak nothing visible, so the regression would go unnoticed. Without the delete, the darwin e2e check catches it.
  - The design should not need cleanup at all.
- **Option 3 (a separate test keychain)** is rejected. It would mean:
  - `security create-keychain` plus a search-list change, which is global user state;
  - unlocking it in every run;
  - a keychain argument threaded into `createKeychainStore`.

  That is more moving parts than the file store, and it still exercises a keychain the product never uses. Edge-build already creates its own signing keychain (`ci.yml:149-163`), but that is for codesigning, not the master key.

### 10. Open questions

See the last section.

## Recommended implementation plan

### Code

1. **`packages/home/src/config.ts`**
   - Add `masterKeyStore: "keychain" | "file"` to `BootstrapConfig`.
   - Add `"master_key.store"` to `BOOTSTRAP_KEYS`.
   - The default is `process.platform === "darwin" ? "keychain" : "file"`.
   - Add a schema: `Schema.Literals(["keychain", "file"])`. Refusing `keychain` off macOS is the implementer's choice between two places:
     - the schema (a platform-aware literal set);
     - `masterKeyLayer`, failing with a message that names the key.

     Either way, the message says `keychain` is supported only on macOS.
   - Update the :50 comment to cite the reworded tier-1 test.
2. **`packages/home/src/toml.ts:13`**: change the "four scalar keys" wording.
3. **`apps/controller/src/secrets/masterKey.ts`**
   - Rename `MasterKeyBackend` to `MasterKeyStore` and drop `defaultBackend`.
   - `masterKeyLayer` takes no argument. It reads `BootstrapConfig.masterKeyStore`, and its requirements gain `BootstrapConfig`.
   - Rewrite the docstring at :286-292, because the parameter it explains goes away.
4. **`apps/controller/src/bootstrap.ts`**
   - Remove `BootOptions.masterKeyBackend` (:210-213), and call `masterKeyLayer` at :305 with no argument.
   - Log the resolved store once at boot at info level, e.g. "Master key: login keychain" or "Master key: <home>/master.key".
5. **`apps/controller/src/index.ts`**: next to the perimeter warning (:156-157), `console.warn` once when the store is not the platform default. This follows "never silently substitute behaviour": a `HERCULE_MASTER_KEY_STORE=file` left in a shell profile shows up. Keep it one rule with no option.
6. **In-process test callers** (the list in "Who picks the store"): replace `masterKeyBackend: "file"` with `env: { HERCULE_MASTER_KEY_STORE: "file" }`, or `-c master_key.store=file` in `argv`. `http/testing.ts:171` and `plugins/testing.ts:80` cover most of them.
7. **`scripts/controller-process.ts`**
   - In `startControllerOnPort`, set `HERCULE_MASTER_KEY_STORE: "file"` after `buildCleanEnv()` (:158-162), with a comment on why: tests never touch the developer's login keychain, and a crash leaves nothing behind but a temp dir.
   - Delete `deleteMasterKeyItem` (:59-64).
8. **Remove the `deleteMasterKeyItem` calls** in `e2e/harness.ts:142-145`, `apps/desktop/scripts/perf-fixture.ts:389-390` and `apps/desktop/scripts/packaged-app.ts:339-352`.
9. **The `e2e/harness.ts:121-132` `Library` symlink**: see open question 5.
   - If the symlink stays, rewrite the comment to give the real reason.
   - If it goes, a controller without the store setting fails loudly on macOS. That acts as a guard.
10. **New `scripts/delete-dead-master-key-items.ts`**, per section 8. Add a root `package.json` script only if Rogier wants one (open question 7).

### Tests

- `packages/home/src/config.test.ts`:
  - `buildEnvName("master_key.store")` returns `HERCULE_MASTER_KEY_STORE`.
  - The default is the platform default.
  - Flag beats env beats file.
  - A bad value fails with an error that names the source.
- `apps/controller/src/config/index.test.ts:56-63`: update the default `config.toml` if first run writes the key.
- `apps/controller/src/bootstrap.test.ts`: a boot with `HERCULE_MASTER_KEY_STORE=file` writes `<home>/master.key`. A boot that changes the store on a booted home fails with `MasterKeyError`; extend the existing case at `bootstrap.test.ts:329` ("creates no second master key for a database that already has secrets").
- `e2e/` (darwin only): no keychain item after a harness boot, and `master.key` exists with mode 0600.

### Spec and doc wording (drafts)

**Spec 15 §6, tier 1 (:194):**

> 1. **Bootstrap config** (`config.toml`): only keys needed before the database can open or before its secrets can be read. Named in the sources: the data root location, the bind address/port, the log level, and where the master key is stored. Nothing else may be added here.

**Spec 15 §6, key list (:205-212):** change "**four keys**" to "**five keys**", add a row, and add a paragraph after the table.

> | `master_key.store` | `keychain` on macOS, `file` elsewhere |
>
> `master_key.store` says where this home's master key is stored ([./13](./13-security.md) §2.2): `keychain` (the macOS login keychain, the only platform with one in v1) or `file` (`<home>/master.key`). It is a bootstrap key because the store must be known before any secret can be read, and it cannot live in controller state because it belongs to the machine, while the Data Root moves with promotion. Tests and throwaway homes set it to `file` so they leave nothing in the login keychain. The controller prints a warning when a home uses a store other than its platform's default. Changing the store on a home that already holds secrets does not move the key: the controller refuses to start until the original store is restored.

**Spec 15 §5 layout (:147):**

> `master.key        master key, when master_key.store is file (the default everywhere but macOS), mode 0600 (./13)`

**Spec 15 §5 (:188):** replace "The plain-file master key fallback on headless Linux" with "The master key file (`master_key.store = file`)".

**Spec 15 §7 step 3 (:224):**

> 3. Mint the master key into its store (the macOS login keychain, or `<home>/master.key`; `master_key.store`, section 6) and create the controller identity.

**Spec 13 §2.2, second bullet (:69):** append this, and keep the narrowing note:

> The store is the bootstrap key `master_key.store` ([./15](./15-packaging-and-operations.md) §6): it defaults to `keychain` on macOS and `file` everywhere else. A macOS home may choose `file`; tests and throwaway homes do, so they leave no item in the login keychain. A home that uses a store other than its platform's default gets a warning at startup.

**Spec 13 §2.2, last paragraph (:73):** change "The plain key file" to "The key file (`master_key.store = file`)".

**Spec 04:121 and :137:** change "or a plain key file on headless Linux" and "The plain-key-file fallback (every platform but macOS...)" to point at `master_key.store`, and link spec 15 §6.

**ADR 0015:** add an amendment note, not a new ADR.

> *Amended 2026-10-xx ([#318](https://github.com/theagenticage/hercule/issues/318)): where the master key is stored is the bootstrap key `master_key.store`. It defaults to the keychain on macOS and the key file elsewhere, and a macOS home may choose the key file. Test and throwaway homes do, so they leave no keychain items behind.*

**CONTEXT.md:149-151:**

> The per-machine key that encrypts secret values in the controller database; held in the macOS login keychain or in a key file in the Hercule Home (`master_key.store`), and never leaves its machine, even during promotion.

**AGENTS.md "Never touch `~/.hercule`" (:79):** add one sentence after the throwaway-home sentence.

> On macOS also set `HERCULE_MASTER_KEY_STORE=file` for that run, so it leaves no item in the login keychain.

## Acceptance checks

- `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm dep-lint` are green, on Linux and on macOS.
- On a Mac:
  - Note the item count from `security dump-keychain login.keychain-db | grep -c '"svce"<blob>="Hercule"'`.
  - Run `pnpm build:binary && pnpm test:binary`, then `pnpm build:desktop && pnpm test:desktop`, then `pnpm --filter @hercule/desktop perf`.
  - The count is unchanged afterwards.
- On a Mac, kill a `test:binary` run partway through. The count is still unchanged.
- The new darwin e2e check passes, and fails if `HERCULE_MASTER_KEY_STORE` is removed from `startControllerOnPort`.
- `rg deleteMasterKeyItem` and `rg masterKeyBackend` find nothing.
- `hercule serve --home <scratch> -c master_key.store=nope` fails with a message that names `-c` and the allowed values.
- On Linux, `-c master_key.store=keychain` fails with a message that the keychain store is supported only on macOS.
- `hercule service install` with `HERCULE_MASTER_KEY_STORE` set is refused, like the other bootstrap variables. Covered with no code change: `install.ts:57` and `unit.ts:201` iterate over `BOOTSTRAP_KEYS`.
- Cleanup script:
  - A dry run lists about 4,483 dead temp-path items and deletes nothing.
  - `--delete` removes them.
  - A second dry run finds 0.
  - The live items, and any item outside a temp root, are untouched.
- Spec 15 §5/§6/§7, spec 13 §2.2, spec 04, ADR 0015, CONTEXT.md and AGENTS.md are updated as drafted.

## Open questions (each with a recommended answer)

1. **The key name and the tier-1 amendment.** Is `master_key.store` acceptable, and may spec 15 §6's tier-1 test be reworded as drafted?
   *Recommended: yes to both.* The alternative is a hidden env var, which contradicts spec 15 §6 in a worse way.
2. **Does first run write `master_key.store` into `config.toml`?**
   *Recommended: yes, like the other four keys.*
   - Consequence: a scratch home first booted with the keychain records `keychain`, and later boots read it from the file.
   - A macOS scratch home booted with `file` and later booted without the env var still reads `file` from its `config.toml`. That is correct.
   - `apps/controller/src/config/index.test.ts:56-63` changes.
3. **A startup warning when the store is not the platform default?**
   *Recommended: yes.* Print one `console.warn` line beside the perimeter warning, plus an info log of the store on every boot. It catches an env var left in a shell profile.
   - Cost: e2e runs print the warning. The harness captures stderr, so this is noise only.
   - If that noise is unwanted, the alternative is the info log alone.
4. **Keep one e2e test on the real keychain?**
   *Recommended: no.*
   - The keychain store's argv, exit codes and read-back are unit-tested through an injected `SecurityRunner` (`masterKey.test.ts:138-227`).
   - Real-keychain boots happen on every developer's actual install, and in CI's `edge-build` job (`ci.yml:222-262`).
   - A real-keychain e2e test would bring back the leak it would need to clean up.
5. **Remove the `Library` symlink in `createTemporaryHome`?**
   *Recommended: keep it in this ticket, and rewrite its comment.*
   - The stated reason (the master key) goes away.
   - The live-session cases likely depend on it for the Claude Code CLI's keychain login under `HOME=<gitHome>`.
   - Removing it needs a run of those live cases on a Mac with a login. Make that a follow-up ticket, unless the implementer can verify it here.
6. **Remove `deleteMasterKeyItem` entirely?**
   *Recommended: yes.* Keeping it hides a regression that the darwin e2e check would otherwise catch. Note that the check runs only on developer Macs, because CI runs binary e2e on ubuntu.
7. **The cleanup script: keep it in the repo, and where?**
   *Recommended:* keep it as `scripts/delete-dead-master-key-items.ts`, with no root `package.json` script; it is run with `bun scripts/...`.
   - Crashed runs and ad hoc agent runs keep leaking items.
   - If Rogier prefers it one-off, run it once and do not commit it.
8. **Rewrite #318?**
   *Recommended: yes.*
   - Mark option 2 as done in `c497e121`.
   - Drop the `hydra-e2e-*` count, since those items are gone.
   - Rescope the ticket to: option 1 (`master_key.store`), the removal of `deleteMasterKeyItem` and `BootOptions.masterKeyBackend`, the darwin e2e check, the spec edits, and the cleanup script.
