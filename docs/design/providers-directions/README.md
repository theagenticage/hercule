# PROTOTYPE: Settings › Providers (#405)

Throwaway. Variants of the desktop app's Providers page, on one page, switchable with
`?variant=` and a floating bar. Round 3 (`i` Shared accounts, the default, and `h` Profiles)
leads; rounds 1 (`a` to `d`) and 2 (`e` to `g`, the Wallet) are one step away in the bar. It answers #405 and feeds the model decision of #404.

**The question.** What does Providers look like once *who pays* (an account) and *what runs it*
(a harness) are separate, without adding to the user's load? And can one sign-in serve every
machine?

## Open it

- Double-click `index.html` (it reads the book's CSS and the app's `tokens.css` by relative
  path, so open it from inside the repository).
- Or serve the repository root and open `/docs/design/providers-directions/`:
  `python3 -m http.server 4938 --directory <repo root>`.
- `composer.html` is the composer's model menu that the page feeds.

Keys: ← and → switch variants. The bar picks the moment, opens a sheet, switches the theme,
and opens the notes.

## Parameters

| Parameter | Values |
|---|---|
| `variant` | Round 3: `i` Shared accounts (default), `h` Profiles. Round 2: `e` Menu cards, `f` Cards on the table, `g` The ledger. Round 1: `a` The menu, `b` The wallet, `c` The switchboard, `d` By vendor |
| `state` | `ready` (default), `failed` (Z.ai refused its key), `expiring` (token ends in 12 days), `empty`, `single` (one profile, no tabs) |
| `sheet` | `add-account`, `add-anthropic`, `add-openai`, `browser`, `added`, `relay`, `relay-openai`, `renew`, `replace-key`, `catalog`, `catalog-openrouter` |
| `theme` | `whitehaven`, `styles`, `orient-express`, `nile`, `end-house` |
| `notes` | `1` opens the notes drawer |
| `opencode` | `0` removes OpenCode, so pi is the only open harness |
| composer: `project`, `switch`, `open`, `q` | `?project=payments-api` opens on Work; `?switch=rows` (default) shows every profile as an accordion head, one open; `?switch=pick` makes the profile its own pick; `?open=profile` opens that pick; `?q=glm` filters |

## Round 3: Profiles, then shared accounts

Variant I puts accounts in one pool above the profiles; a profile picks from it, and any
account may sit in any number of profiles (no one-per-vendor rule: the menu tells two Claude
accounts apart by section). A catalog over 40 models opens the model browser (`browser.js`)
instead of the popover. With one profile there are no tabs. A new profile is named first and
starts empty (a teaching state) or as a copy; "Add an account to <profile>" sits at the end of
its menu. The preview, like composer.html, is an accordion: one profile open at a time.
Harnesses, three steps, each "same as the one above" until changed: the account's default harness
(its sheet: the vendor's own, else pi; the ones it cannot run in are struck through, with why);
the account's pill in a profile; a model's ⋯, which moves it or offers it in a second harness too
(an entry `gpt-6-1-sol@pi`). Installing harnesses belongs to the Fleet page.


Round 2's wallet, renamed Profile on Rogier's word, with one rule for every account: its
section lists what is in the menu, and Add a model opens the same picker for every account.
Models reorder by drag (within their account) or Alt+Up/Down; accounts reorder by their head.
State: `r3.js` (sessionStorage). "Profile" collides with Settings › Profile, Permission
profiles and GLOSSARY's Avoid list.

## Round 2: the Wallet

A Wallet is a named set of accounts, at most one per vendor, with its own model menu. Each
project picks a wallet; the composer opens on it and has a tab per wallet. An account may sit
in several wallets, each picking its own models from it. State: `r2.js` (sessionStorage).
New GLOSSARY term; contradicts Project's "no behaviour, no defaults".

## Variant D's model (round 1)

- Per vendor, the models you want to see. Every account of the vendor shows them, unless one
  account has its own list.
- Per project, which account pays, where a vendor has more than one. The composer starts there;
  a thread can still take another account.
- Per vendor, the harness a model runs in; the composer can switch it per thread.

D's state lives in sessionStorage (`menu-d.js`), so a change on the Settings page shows in
`composer.html`. "Start over" under the rail resets it. Giving a project a default account
contradicts GLOSSARY.md's Project ("no behaviour, no defaults").

## The model A to C assume

- **Account**: who pays. One sign-in or key (`Anthropic · Work`, `OpenRouter`).
- **Harness**: the agent program (Claude Code, Codex, pi, OpenCode).
- **Model**: what the user picks (Opus 5.5).
- **Menu entry**: one model, from one account, in one harness. The composer's menu is exactly
  the list of entries, in order. `GPT-6.1 Sol · pi` is GPT-6.1 Sol, paid by OpenAI · Personal,
  run by pi.

This contradicts GLOSSARY.md (Provider Instance = one account of one harness; "account" is
reserved) and spec 06 §11 (per-machine login is the durable model). #404 decides.

## Files

| File | What it holds |
|---|---|
| `world.js` | The fixture world: machines, harnesses, vendors, accounts, models, the menu; the `state` moments |
| `shared.js` | Renderers two or more variants use: the route line, sign-in words, the empty page |
| `variant-a.js` `variant-b.js` `variant-c.js` `variant-d.js` | One variant each |
| `menu-d.js` | D's state and the composer menu it produces |
| `r2.js` `r2-sheets.js` `r2.css` | Round 2: the Wallet state, the monogram, pips and gauge, the composer menu, the account sheet |
| `variant-e.js` `variant-f.js` `variant-g.js` | Round 2's variants |
| `r3.js` `r3.css` `variant-h.js` `variant-i.js` | Round 3: profiles, the add picker, reordering, the composer menu with folded profiles, the shared accounts pool |
| `browser.js` | The model browser for big catalogs |
| `catalog.js` | The interactive Add models sheet |
| `sheets.js` | The sheets every variant opens |
| `marks.js` | Placeholder marks for vendors the book has no brand for (Z.ai, OpenCode, OpenRouter, Codex) |
| `notes.js` | The notes drawer |
| `proto.js` | The switcher bar; not part of the design |
| `providers.css` | All styles, scoped per variant |

The research behind the sign-in copy is `research/fleet-sign-in.md` on `research/fleet-sign-in`.
Rogier's reference screenshot from T3 Code is in `docs/design/references/t3code/`.
