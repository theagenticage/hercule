# External Entities

*(Added 2026-11-07, [#1032](https://github.com/theagenticage/hercule/issues/1032), slice 4 of the Work overview map [#1026](https://github.com/theagenticage/hercule/issues/1026); [ADR 0054](../adr/0054-external-entities-are-durable-records-kept-true-by-polls.md). Amended 2026-11-07, [#1033](https://github.com/theagenticage/hercule/issues/1033), slice 5: signals inside their entity, links, hints and the timeline. Amended 2026-11-08, [#1035](https://github.com/theagenticage/hercule/issues/1035), slice 7: Facts, links by hand and the branch join, [ADR 0055](../adr/0055-facts-move-cards-through-editable-workflows.md).)*

An **External Entity** is a durable record of an outside thing, such as a pull request, a ticket or an error. It is never a copy of the thing: it holds what a card needs to draw, and a poll keeps it true. The Inbox is the page that lists the ones that concern the user. "External Entity" is a word for code and docs. The UI says the kind's noun, "Pull request", and the word "entity" never reaches a screen.

This document owns the records, their rules, the operations and the Inbox's reads. Other documents link here and do not restate it:

- the plugin interfaces (`EntityKindDeclaration`, `EntityObservation`, `IngestContext.entities`, `EntityLookup`) are pinned in [./05-plugins.md](./05-plugins.md) section 4.3. This document owns what the core does with them;
- the GitHub plugin's feed is in [./08-events-and-connections.md](./08-events-and-connections.md) section 5.1, and the Linear plugin's in section 5.7;
- the Signal record and how it leaves are in [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md#9-signals);
- the Task side (links, the active Task) is in [./09-tasks.md](./09-tasks.md#entity-links);
- the desktop Inbox and Work's additions are in [./17-desktop-app.md](./17-desktop-app.md#inbox).

Terms are [GLOSSARY.md](../../GLOSSARY.md)'s: **External Entity**, **Entity Kind**, **Observation**, **Concern**, **Relation Claim**, **Inbox**.

## 1. The model

Keep these questions apart. They are different facts, stored differently.

| Question | Where | Notes |
|---|---|---|
| What is it? | `external_entities`, one row per canonical External Ref | title, status, person, owner, facts, repository, lifecycle |
| Does it concern you, and why? | `external_entity_observations`, one row per ref and Connection, and `following` on a Task's link | the concerns that Connection reported. The entity's concern is their union, plus `following` |
| Can each account read it? | the same observation row: `access`, `last_attempted_at`, `last_refreshed_at`, `next_attempt_at`, `attempt_count` | per Connection, so one account's failure never touches another's |
| Was the inventory read? | `external_entity_scans`, one row per Connection and kind | `last_complete_at`: one write per poll, however many rows it covers |
| What is it part of, and what is it linked to? | `external_entity_relation_claims`, one row per claim | who claims it, and on what evidence ([section 6](#6-relation-claims)) |
| Which Tasks link it? | `task_entity_links`, in the tasks domain | one row per Task and ref ([./09-tasks.md](./09-tasks.md#entity-links)) |
| Which signals are about it? | `signals`, joined on read by `thread_ref = ref` | nothing is stored on either side ([section 8.5](#85-signals-inside-a-card)) |
| What changed at the source? | `external_entity_timeline`, one row per change | `reassigned`, `moved` or `linked`, put into words on read ([section 8.7](#87-what-changed-outside)) |
| Is it on the Inbox? | worked out on read ([section 8](#8-the-inbox)) | |

Observations and claims key on the ref, not on the entity's id. A Connection can hold state for a ref that has no entity yet, and a claim can point at a ref nobody has read. Task links, signals and claims key on the ref too, so pruning an entity leaves them readable.

### 1.1 Records

**Entity** (`external_entities`). One row per canonical External Ref, `UNIQUE (ref)`. The External Ref excludes the Connection ([./09-tasks.md](./09-tasks.md#external-ref-canonical-form)), so two accounts that see one thing share one row. This uniqueness is about entities only: a ref stays non-unique across Tasks.

| Field | Notes |
|---|---|
| `id` | Hercule id |
| `ref`, `kind` | `kind` is qualified: `github/pull-request` |
| `noun`, `card`, `pace`, `patience`, `caption`, `home`, `section` | Copied from the kind table when the entity is observed, so a card reads well after its plugin is gone. `home` and `section` are qualified kinds. `caption` is the kind's `groupable.caption` |
| `completeness` | `full` or `partial` ([section 1.2](#12-three-shapes-of-record)) |
| `identifier`, `status`, `person`, `owner`, `facts`, `reason` | Rendered by the core from the plugin's raw fields and the kind table ([section 5.2](#52-the-core-renders-the-plugin-reports-fields)). `status`, `person`, `facts`, `reason` are JSON |
| `title`, `url`, `lifecycle` | `lifecycle` is `open`, `completed` or `abandoned` |
| `repository` | `{ target: { remote }, head?: { remote, branch } }`, remotes in canonical form ([GLOSSARY.md](../../GLOSSARY.md), Canonical remote) |
| `progress`, `target_date` | Only what the source reports. Progress is never worked out from what Hercule can see |
| `waiting_since`, `concerned_since` | `waiting_since` is the source's word on when the wait began. `concerned_since` is when the entity last went from no concern to some concern |
| `source_updated_at`, `source_revision` | The source's own time and revision of the shared fields ([section 3](#3-shared-fields-and-presented_by)) |
| `first_observed_at`, `updated_at` | |
| `status_key` | *(Added 2026-11-07, [#1033](https://github.com/theagenticage/hercule/issues/1033).)* The status key the plugin reported, such as `in_review`. `status` holds the word the user sees, which a plugin may rename, so the timeline compares keys to tell a real move from a renamed word. Null when the thing has no status. A shared field |
| `reason_templates` | *(Added 2026-11-07, [#1033](https://github.com/theagenticage/hercule/issues/1033).)* A JSON copy of the kind's raw `reasons` table, `{ key: { say, tone } }`, made when the thing is observed as `concern_reasons` is. The sentence of a signal and the words of the timeline are built from it, so they read well after the plugin is gone. A shared field: only the accepted shared write sets it |
| `presented_by` | The Connection whose observation wrote the shared fields. Null when that Connection is deleted |
| `dismissed_at`, `dismissed_by` | [Section 4.2](#42-dismissal) |
| `arrival_sequence` | [Section 8.4](#84-counts-and-the-new-mark) |

**Observation** (`external_entity_observations`). One row per (ref, Connection), the primary key. `concerns` (JSON array), `owned_by_you`, `access` (`ok`, `inaccessible`, `deleted`), `last_attempted_at`, `last_refreshed_at`, `next_attempt_at`, `attempt_count`. Deleting a Connection deletes its rows.

**Scan** (`external_entity_scans`). One row per (Connection, kind): `last_complete_at` and the writing `actor` (`plugin:<id>`). It moves only when a complete inventory was reconciled.

**Ingest warning** (`external_entity_ingest_warnings`). One row per (Connection, kind) whose latest inventory left something unresolved, such as a partial read or a refused relationship: `warning`, the sentence. The Connection has one warning, shared with account setup, so these rows keep it in place until every kind has resolved its own. Deleting a Connection deletes its rows.

**Claim** (`external_entity_relation_claims`). Section 6.

**Arrival counter** (`external_entity_arrival_counter`). One row holding the last number given. A table of its own, so a number is never given twice, even after pruning removes the entity that held the highest one.

**Task link** (`task_entity_links`). `task_id`, `ref`, `linked_at`, `linked_by`, `following`; the primary key is (`task_id`, `ref`), with an index on `ref`. Owned by the tasks domain.

**Task revision** (`tasks.revision`, tasks domain). A count of the edits to a Task, 0 for a Task nobody has edited. Taking back a Task made for an outside thing asks whether it is still 0, which `updated_at` cannot answer when an edit lands in the same millisecond as the creation or the clock steps back.

**Timeline** (`external_entity_timeline`). *(Added 2026-11-07, [#1033](https://github.com/theagenticage/hercule/issues/1033).)* `id`, `ref`, `reason` (`reassigned`, `moved` or `linked`), `person` (the new owner, null when the owner was cleared), `value` (the new status word of a `moved` change, null for the others), `target_ref` (for `linked`, the thing that was linked) and `observed_at`, with an index on (`ref`, `id`). It keys on the ref, not on the entity's id. The prune sweep deletes the rows of refs that have no entity.

### 1.2 Three shapes of record

- **A full record of a work kind.** Has a card: `card` is `rich` or `compact`, `pace` is `fast` or `slow`, and `url` and `lifecycle` are set. Only this shape can be on the Inbox, be read by `externalEntity.read`, or be taken on.
- **A context record.** A record of a kind with `pace: context`, such as a repository. It is a place: no card, no pace, no lifecycle, no moves, and it can never be taken on. Its observations carry `concerns: []`, so it never concerns the user by itself. If a place later concerns the user, it is the same record. Progress is optional and shows only when the source reports it.
- **A partial record.** What a read of something else happened to give, such as a parent issue's id and title. A partial observation (`partial: true`) needs only `kind`, `ref` and `title`. This is allowed for work kinds too. The entity then has `completeness: partial` and draws as a place, with no card and no moves, until a full observation arrives. A partial observation fills in what it carries and never clears a known field: an absent field is unknown, not removed. So a partial read of a thing already known in full changes nothing else.

The work-only columns (`card`, `pace`, `patience`, `identifier`, `url`, `lifecycle` and the rest) are nullable, because a partial or context record has none of them. `externalEntity.read` reads a full record of a work kind only. A partial or context record answers `NotFound` there. It travels in other replies as an `EntityPlace`, by ref.

### 1.3 Restricted things

A link can point at something the user's Connections cannot read. This is one of two cases, and they are kept apart:

- **A place no Connection can read** has no title, identifier or URL to show. Its `EntityPlace` carries the kind's `noun` and `restricted: true`, and the row says "A Sentry issue you cannot open". A title learned through someone else's read, such as an attachment's label, is never stored as the entity's title. `restricted` is on `EntityPlace` only.
- **A card that lost access** keeps its last known facts, with `access: inaccessible` or `deleted`. It is not restricted.

An unknown ref is neither. It is a ref with no record, and a reply leaves it as a ref: no record is invented for it.

## 2. Derived fields

These are worked out on read, from the observations and the Connections, by the same functions for the Inbox, the detail and the Work board.

- **`access`.** `ok` if any Connection reads it. Otherwise `deleted` if any Connection was told so by its source. Otherwise `inaccessible`. One account's 403 never hides another account's good read. A disabled Connection keeps its last known access: eligibility affects `stale`, not the stored facts.
- **`observedAt`.** The newest of `last_complete_at` for each Connection whose latest inventory still lists it (the row is `listed`, whether or not it has concerns) and `last_refreshed_at` for every Connection. So a scan of unrelated open pull requests does not make a closed one look fresh. With no success time at all it is `first_observed_at`.
- **`stale`.** True when no Connection with `access: ok` can poll now. A Connection can poll when its status is `connected` or `error`, its plugin is active at run time and the stored `enabled` flag is on. Backing off after a failed read is not stale; it makes `contextComplete` false.
- **Freshness is as fresh as the last announced change.** A poll that changes nothing announces nothing, so on an open screen `observedAt` can lag a poll that succeeded and found nothing new. A client shows the age only when `stale` is true.
- **`yours`.** True when any observation row of the ref has `owned_by_you`, whichever Connection presents the shared fields. Ownership is account-relative, so it does not follow `presented_by`: one account taking over the shared fields must not move a card between "mine" and "theirs".
- **`concerns`.** The sorted distinct concerns of all observations, plus `following` when a live Task has a link with `following` set. `following` never comes from a plugin and never starts a card by itself: the live Task does that.
- **`waitingSince`.** The source's `waitingSince`, else `concerned_since`. An unchanged concern union does not restart the wait.
- **`taskId`.** The active Task of the ref ([./09-tasks.md](./09-tasks.md#entity-links)).
- **`kindAvailable`.** The catalog still has the kind and its plugin is active. When false the card draws, its actions are off, and it shows why.
- **`contextComplete`.** False when part of what is above the thing could not be read ([section 7](#7-reading-the-graph)).

## 3. Shared fields and `presented_by`

The shared fields are everything on the entity row that is not one Connection's word: title, status, facts and the rest. With two Connections:

- A newer `sourceUpdatedAt` wins them.
- On an equal `sourceUpdatedAt`, only the Connection that wrote the row last (`presented_by`) may change them. A source can change a fact without moving its update time, as GitHub's checks do, so the last writer must be able to, and two accounts must not take turns rewriting one row on every poll.
- An older `sourceUpdatedAt` loses. An observation that loses still updates its own Connection's concerns, ownership and access.
- **`presented_by` hands over.** On an equal `sourceUpdatedAt`, a Connection also may write, and becomes `presented_by`, when the current one is no longer usable: it is null, it cannot poll now, its plugin is not active, or its own `access` for this ref is not `ok`. So the first usable Connection to report takes over, and a card that reads fresh is really being kept fresh.
- A partial observation never takes over a full record. A full observation promotes a partial one, whatever the old source time was.

**`sourceRevision`.** A plugin may send the source's revision of a thing. An unchanged revision skips the shared facts only, and only when the reporter is the same Connection (`presented_by`) and `sourceUpdatedAt` is equal. It never skips concerns, access, ownership, rotation and freshness bookkeeping, or relations. A newer `sourceUpdatedAt` is stored even when the revision string happens to match, because a revision from one reporter is not a clock to compare with another's.

## 4. Lifecycle

### 4.1 What happens when

| Case | What happens |
|---|---|
| First seen | Inserted, with no event and no signal. A baseline is not news |
| A complete scan no longer lists it | That Connection's concerns become empty. The row stays |
| No concern, no open signal, no live Task | Off the Inbox. Pruned after 30 days, unless it is context something still reaches ([section 4.3](#43-pruning)) |
| It has a live Task, or an open signal | Stays observed by `listWanted`, whatever its concern |
| A Task link exists, Task finished | Kept, last known state, not refreshed |
| A source says for certain that it is gone | That Connection's `access` is `deleted`, and the card says so. No plugin can say this yet |
| 403, 404, or any missing answer | `access: inaccessible`, last known state kept. Never read as deleted or closed |
| Token lost, Connection disabled, plugin disabled | Nothing changes. The card shows its age and why. A stale scan is not an empty inventory, and a missing relationship read removes no claim |
| Back in a later scan | Concerns return, and the card comes back unless dismissed |
| Connection deleted | Its observation and scan rows go, and so do its claims. The entity stays and pruning applies. `presented_by` becomes null |

**`following`** lives on the Task's link. `addToWork` sets `task_entity_links.following` when the user added the thing to Work from nothing that concerned them. The entity's `following` concern is then worked out on read: a live Task has such a link. So there is nothing to clear. A Task ending or reopening, a deletion, a merge, an unlink or an Undo changes the links or their liveness, and the answer follows in the same transaction. `reconcile` cannot touch it, and a plugin that reports `following` is refused.

### 4.2 Dismissal

`dismissed_at` and `dismissed_by` (an actor). A dismissed thing stays out of sight and keeps its history. A new signal or a new concern does not bring it back: only `externalEntity.restore` does. So there are no markers to compare. Dismissing tells the plugin nothing and ends no signal. A dismissal is never pruned.

### 4.3 Pruning

A daily sweep, in the shape of the runner-metrics prune, deletes:

- entities with no concern, no link from any Task, no open signal on the ref, no path up from anything concerned or linked, no dismissal, and no change for 30 days; and
- the observation rows of refs with no entity and no reason to be wanted.

It also deletes the timeline rows of refs that have no entity. It keeps their claims: they are small, and they are history. A dismissal is never pruned, because a record that came back without it would undo "only Undo brings it back".

## 5. What a poll reports

A poll returns no data. A plugin that has the `entities` capability reports what it read through `IngestContext.entities` ([./05-plugins.md](./05-plugins.md) section 4.3). The core owns what happens next.

### 5.1 `reconcile`

A plugin reads its whole inventory of one kind, then calls `reconcile({ kind, complete, observations })` once. So a failed page, a rate limit or a restart between pages stores nothing and removes nothing, and the next poll starts again.

**Refused before anything is written** (a `PluginError`; nothing is stored, claims and scan included):

- more than `MAX_ENTITY_OBSERVATIONS` (2,000) observations;
- a kind the source did not declare, or a ref that does not start with the kind's `refPrefix`, or the same ref twice;
- an oversized field (at most 32 fields, 64 characters in a name, 512 in a text), or more than 64 parents or peers in `relations`;
- the concern `following`, or any concern on a context kind;
- a parent or peer in `relations` that starts with `unresolved:`, which the core keeps for its own pending targets ([section 5.4](#54-addresses-and-texts)). The message tells the plugin to report a web address in `relations.linkedUrls` instead;
- more than 64 `linkedUrls`, one that is not an `http` or `https` address, more than 3 `texts`, a text over 16 KiB or an `evidenceKey` over 128 characters. The bounds are checked before any recognizer is called;
- a full observation of a work kind with no `url` or `lifecycle`;
- a status key or reason key that is not in the kind's table, or a template that names a missing field (`renderEntitySlots` fails);
- a Connection that is deleted, disabled or no longer ingesting (`assertConnectionIngesting`, as `emit` does).

**Inside one transaction, in this order:**

1. Read the state to compare against.
2. Write this Connection's observation rows: a full observation sets `access: ok`, the supplied concerns and `owned_by_you`, and resets the failure backoff. A partial observation sets `access: ok` and leaves concerns and ownership as they are.
3. Apply the shared-field rule of [section 3](#3-shared-fields-and-presented_by) in ref order.
4. Apply each observation's `relations` ([section 6](#6-relation-claims)), whatever the shared-field outcome.
5. With `complete: true`, empty this Connection's concerns and clear its `listed` mark for every ref of the kind it reported before and left out now. Retain access, ownership and the entity. Other Connections' concerns stay. Then write the scan row, `last_complete_at`.
6. Raise `arrival_sequence` for the entities that qualify ([section 8.4](#84-counts-and-the-new-mark)).

**Rules:**

- **Compare before writing.** Only a row whose facts or concerns changed is written, and only those announce. For the members of a complete inventory, a poll that changes nothing writes one scan row. That saving covers inventory members only. A wanted ref is outside the inventory and keeps its own `last_refreshed_at`.
- **A complete call is the whole kind.** It unlists what an earlier complete call listed and this one leaves out, so a plugin cannot split one kind over several complete calls: each call would unlist the others' refs, and the rows would change on every poll. A kind that can exceed `MAX_ENTITY_OBSERVATIONS` reports a stable subset in one complete call (GitHub sorts repositories by name and lists the first 2,000). The rest are not listed, so `listWanted` returns them for `refresh`.
- **`complete: false`** updates what it was given and takes nothing away, and it does not move `last_complete_at`. It sets the Connection's `warning` to a fixed sentence saying the Inbox may be missing items. The system tells the user.
- **No event and no signal.** `reconcile` emits none, so 300 existing pull requests never become 300 proposals or 300 runs.
- **Poll writes are stamped** with the plugin's actor (`plugin:<id>`), on the scan row. They hold no user decision.
- **The Connection's `warning` is shared with account setup.** Entity ingest writes it only when it is empty or one of entity ingest's own fixed sentences (a missing page, a refused loop), and clears it only when it is one of them. Those sentences are constants in one place. It never overwrites or clears an authentication warning.
- **A disabled plugin or a lost token** changes no entity. The records stay readable, and the card shows its age.

### 5.2 The core renders; the plugin reports fields

A plugin reports raw `fields` (`Record<string, string | number | null>`) and a status key. `renderEntitySlots(declaration, observation)` applies the kind table and the result is stored on the row.

| Slot | How it is rendered |
|---|---|
| `identifier` | The kind's template with `{field}` placeholders filled from `fields`, at most 64 characters |
| `person`, `owner` | The text of the field the kind names, or left out when the kind has none or the field is empty |
| `status` | The kind's status entry for the observation's key: `shape`, `tone`, the `word` as `label`, and `norm` |
| `facts` | At most three, in a fixed form. A field that is missing, null or empty leaves its fact out |
| `reason` | The kind's `reasons` entry for the observation's `reason` key, with `{person}` and `{value}` filled in. Finished text |
| `noun`, `card`, `pace`, `patience`, `home`, `section` | Copied from the declaration. `card` is `rich` when left out |

Fixed sets: status shapes `ring`, `dashed`, `quarter`, `half`, `most`, `fork`, `join`, `check`, `cross`, `hold`, `alert`; tones `quiet`, `active`, `attention`, `good`, `bad` (the colour kept for the person is out of a plugin's reach); fact forms `delta` (`+120 -30`), `count` (a whole number and a unit in the singular), `word`, `date`, `money`, `bars` (a level from 1 to 3); reason tones `plain`, `attention`, `good`, `bad`. A status may declare a Task `stage`, used by [section 9.3](#93-the-stage-a-new-task-starts-at).

An entity row holds only normalized fields, checked against the contract before they are stored. Entity text comes from outside: it is stored and drawn as plain text, never as Markdown or HTML.

### 5.3 `refresh`, `listWanted` and `reportMissing`

- **`refresh(observations)`** updates what is known without touching any concern. It follows the same validation, shared-field rule, relation rules and partial rules as `reconcile`. It never changes existing concerns and starts new observation rows with none. It updates `owned_by_you` when a full observation supplies `ownedByYou`, and keeps it when absent or partial. It stamps `last_refreshed_at`, sets `access: ok` and resets the backoff, even when nothing changed: the read succeeded. It writes no scan and changes no dismissal. *(Amended 2026-11-07, [#1033](https://github.com/theagenticage/hercule/issues/1033).)* **A refresh of a ref with no entity creates one, with no concerns.** It never touches another Connection's concerns. The new entity is on the Inbox only while a live signal holds it ([section 8.5](#85-signals-inside-a-card)). Such an entity takes an arrival number when that signal alone puts it on the clock, because a refresh never changes the concerns otherwise.
- **`listWanted(kind, limit)`** returns the refs of one kind the core wants this Connection to read, at most `limit`. They are the refs with a live linked Task whose entity is not in this Connection's inventory (not `listed` by it), and the context reachable from what concerns the user: upward through `part of`, at most `MAX_CONTEXT_PARENTS` (32) parents read per thing, plus one read of each `linked` target for its title and access. Its own links and parents are not followed, and no peer is crawled. *(Amended 2026-11-07, [#1033](https://github.com/theagenticage/hercule/issues/1033).)* It also returns the refs of open signals, snoozed ones included, for a kind that has a card (a work kind, not a context kind): the signals that came through this Connection on a ref that starts with the kind's `refPrefix`, even when no entity exists yet. So a mention of a thing no inventory lists gets its card on a following poll, with no `mentions:@me` search, and old mentions never flood in. A read that fails reports `reportMissing`, and the signal stays on its own. It is a fair, durable rotation:
  - Order: refs this Connection has never tried first, then the oldest `last_attempted_at`, then the ref. A ref backing off waits until its `next_attempt_at`.
  - It stamps `last_attempted_at` on what it returns, before it returns. A request that fails for all 50 refs still moves on: the next call gets the next 50. So 51 wanted refs make progress, and no bad ref can hold up the rest.
  - It excludes refs already in this Connection's inventory, because its next complete scan refreshes them.
- **`reportMissing(ref, reason)`** says a ref could not be read, with `inaccessible` or `deleted`. It sets that Connection's `access` and leaves everything else: concerns, ownership, facts, claims and `last_refreshed_at`, so a failed read never looks fresh. It never creates an entity. It is the only source of per-ref retry backoff: `attempt_count` goes up by one and `next_attempt_at` is set to now plus 120 seconds doubling with each failure, at most 6 hours. A good `refresh` resets them. `deleted` is explicit evidence and is never inferred from a 403, a 404 or an empty answer.
- **A batch that fails as a whole** is a failed poll. The host backs the feed off, and the `last_attempted_at` stamp of `listWanted` has already moved the rotation on. Nothing is written for the refs of that batch.
- None of this announces. Only a change to what a card shows pushes.

### 5.4 Addresses and texts

*(Added 2026-11-07, [#1033](https://github.com/theagenticage/hercule/issues/1033).)* A source can say more about a thing than its refs. Two optional fields of an observation carry it, and the core turns them into claims, because only the core knows every plugin's link forms.

**`relations.linkedUrls`** (at most 64 `http` or `https` addresses) holds the addresses the source itself says belong to this thing, such as a Linear attachment that points at a pull request. An address is the source's word whatever happens to its target, so it is always kept, as a `source` claim of the reporting Connection with the address as its `evidence_key`. The core runs a new address through the active plugins' `recognize`, and the first plugin that recognizes it (registry order) decides the target:

| The address is recognized as | The claim's target (`to_ref`) |
|---|---|
| a `ref` | that ref. "Linear reports this pull request", with no GitHub Connection involved |
| `scoped`, such as a Linear issue address | a pending target, resolved by the loop of [section 5.5](#55-resolving-pending-claims) |
| nothing, because no active plugin knows it | the pending target `unresolved:url:<url>`, tried again when the set of plugins that know addresses changes |

- **A claim is matched by its Connection, `from_ref`, relation and `evidence_key`.** The table applies to an address seen for the first time. An address seen again keeps its target, id and time, whatever the plugins recognize now. So an address that resolved once stays resolved after its plugin is disabled, and also when it recognizes as scoped on every poll.
- **`complete` applies to addresses by what the source said.** `relations.complete: true` removes a stored address claim only when the source left that address out. A disabled plugin, a failed resolve or a failed recognition never removes one. `complete: false` removes none, and an observation with no `relations` touches none. Reconcile fetches nothing.
- An address that recognizes as the thing itself makes no claim.

**`texts`** (at most 3, each `{ evidenceKey, text, revision? }`, a text at most 16 KiB, a key at most 128 characters) holds text the core searches for references, such as a description. **The core stores no text.** It runs each text through every active plugin's `recognize` (at most 20 things a text, each once) and keeps only the claims it finds: a `text` claim of the reporting Connection whose `evidence_key` names the text. "The description of #6263" is built from that key when it is drawn.

- A `ref` recognition becomes a claim at once. A `scoped` one is stored as a pending target, and the evidence stays on the claim.
- **An entry replaces that Connection's `text` claims for its `evidenceKey`:** a reference no longer in the text is removed. An entry with an empty text clears the key. A key the observation leaves out touches nothing. A text whose `revision` equals the one its stored claims were made from is skipped, and is not recognized again: the ingest reads the stored revisions of every ref of a call in one statement before it searches.
- A stored claim is matched by what the text said (`recognized_as`), so a claim the resolver already settled keeps its id and time while the text still says the same.
- **A reference is a hint.** It never joins, never groups, never rides and proves nothing. It is drawn only as a hint, which the user may turn into a link ([section 9.5](#95-link-and-unlink)). An unresolved reference draws nothing, so `UTF-8` in a description costs a few failed reads and never reaches a screen.

**The pending target** is the core's own format, in this file's `pending-target.ts` and nowhere else: `unresolved:url:<url>` for an address nothing recognized, or `unresolved:<plugin>:<kind>:<scope>/<identifier>` for something a plugin recognized and cannot place without a read. Every component of the second form is written with `encodeURIComponent` (empty means absent), so none holds `:` or `/` and the form decodes to exactly what was encoded. **A pending target is not an External Ref.** It lives only in claims and never in a link, a peer, a place or the walk of `listWanted`. The generated column `is_pending` marks the claims that hold one, and every read of links filters on it.

**Recognition runs in the ingest of this domain,** after the observations are decoded and bounds-checked and before the transaction opens. The host passes the ingest a `RecognizeText` function over the lookups of the plugins that are active at that moment. It is pure: no plugin gets credentials or makes a request. The claims module writes the difference between what was recognized and what is stored, and the transaction checks again that the Connection still ingests.

### 5.5 Resolving pending claims

*(Added 2026-11-07, [#1033](https://github.com/theagenticage/hercule/issues/1033).)* A loop in the controller daemon gives pending `source` and `text` claims a ref. It runs there and not in the plugin host, because it needs `EntityLookups`, which requires the host, and the host builds the ingest loops: the other way would be a construction cycle.

- **A pass** runs every 30 seconds while the controller serves. With nothing pending, it is one statement over an empty index.
- **The budget is per target plugin, not per reporting Connection,** because the reads cost requests to the target plugin's source. A plugin may read at most 20 due claims in one window, the oldest due first. A window opens when the plugin has claims to read and is as long as the default interval of its `entities` feed. The loop keeps the windows in memory, so a restart opens them afresh. Recognizing a web address reads nothing and spends no budget.
- **A claim is read through `EntityLookups.resolve`,** with the rules of [section 10](#10-search-recognition-and-resolution): never the first match, and `ambiguous` and `incomplete` leave the claim pending. A target that several claims hold is read once in a pass. An answer that does not place it (not found, ambiguous, incomplete or unavailable) postpones every claim holding the target, in one statement. **An `incomplete` or `unavailable` answer also ends that plugin's pass:** a Connection failed or ran out of requests, so the next reads would fail the same way. The claims not yet read stay due for the next window. A pending address is recognized again first, because a plugin may have become active: a `ref` settles it, a `scoped` recognition rewrites it to the scoped target and resolves that, and no recognition postpones it. When the set of plugins that know addresses changes, every pending address becomes due at once.
- **Reads run outside any transaction.** Each result is then written in its own short transaction, which first checks that the claim still exists, is still pending and still holds the target the loop read, because the source may have rewritten it during the read.
- **Found** rewrites the target to the canonical ref and keeps the claim's type, Connection and id. It resets the backoff and announces both ends. When a `source` claim joins a pair that nothing joined before, it also writes a `linked` change on both timelines ([section 8.7](#87-what-changed-outside)), unless the claim is part of its thing's baseline (`in_baseline`, [section 6](#6-relation-claims)). A ref that is the claim's own origin, or that another claim of the same Connection and text already holds, counts as not placed.
- **Not placed** waits: 120 seconds, doubling with each failure, at most 6 hours (`resolve_attempts`, `next_resolve_at`, as the backoff of observations).
- **A failed lookup never marks the reporting Connection unhealthy** or changes its `warning`. The lookup is the target plugin's business, not that Connection's.

## 6. Relation claims

Two relations, and neither knows a system.

- **`part-of`** points from a child to a parent. It is a graph, not a chain: a thing can have many parents, a team is one more path, and no view may draw one parent as if it were the only one.
- **`linked`** is between peers. It draws both ways, keeps its direction in the claim, and can contain loops.

A claim has a `claim_type`:

| Claim | By | Meaning |
|---|---|---|
| `source` | a Connection (`connection_id`) | The source reports it. `evidence_key` holds the URL it came from, if any |
| `person` | an actor (`actor`) | A person made it. A person's claim is `linked` only, made by `externalEntity.link` ([section 9.5](#95-link-and-unlink)) |
| `text` | a Connection | A reference found in text. `evidence_key` names which text. A hint, not a link: it joins, groups and rides nothing |

Each claim also has `observed_revision` (the source's revision of `from_ref`, when it has one), `state` (`current` or `conflicted`), `conflict_reason` and `observed_at`. *(Amended 2026-11-07, [#1033](https://github.com/theagenticage/hercule/issues/1033).)* A claim that waits for a read also has `recognized_as` (the target as the recognizer first named it), `resolve_attempts`, `next_resolve_at` and the generated `is_pending` ([section 5.4](#54-addresses-and-texts)). `in_baseline` is true for a claim written while its thing was not yet a full record: what a thing arrived with is not news, however late a pending claim of it resolves ([section 8.7](#87-what-changed-outside)). Two checks keep the stamp honest: a `person` claim has an `actor` and no `connection_id`, and any other claim has a `connection_id` and no `actor`.

**Partial unique keys.** SQLite treats NULLs as distinct, so one unique key over `connection_id` and `actor` would not stop a repeat. Each claim type has its own partial unique index:

| Claim | Unique on |
|---|---|
| `source` from a ref | `(from_ref, relation, to_ref, connection_id)` where `evidence_key` is empty |
| `source` from a URL | `(from_ref, relation, connection_id, evidence_key)`, whatever its target, so a URL claim keeps its identity when its target is resolved |
| `text` | `(from_ref, relation, to_ref, connection_id, evidence_key)` |
| `person` | `(from_ref, relation, to_ref, actor)` |

Partial indexes on `(from_ref, relation)` and `(to_ref, relation)` where `state = 'current'` serve the walks, and indexes on `from_ref` and `to_ref` where `state = 'conflicted'` serve the read of refused claims.

**Rules:**

- **Claims stay separate.** Two accounts reporting one edge make two rows. The effective relationship of a pair is worked out on read: one row, under its firmest claim (`source`, then `person`, then `text`).
- **The core stamps who claims it.** `claim_type`, `connection_id` and `actor` come from the caller, never from the data. `reconcile` and `refresh` write `source` claims for their own Connection. A manual correction can never pass as the source's word, and a plugin cannot write a `person` claim.
- **Writing claims is a difference.** The core compares the claims it would hold with the rows it has. An unchanged claim keeps its id and time and writes nothing, so the same partial read twice grows nothing and makes no news.
- **Replacing a membership needs a complete read.** An observation's `relations` is `{ complete, partOf, linked }`:
  - `complete: true` replaces this Connection's `source` claims from this ref (those with an empty `evidence_key`), in the same transaction: a parent left out stops being claimed. Other Connections' claims, people's claims, text claims and URL-evidence claims stay.
  - `complete: false` adds what it was given and removes nothing.
  - An observation with no `relations` touches no claim. So a failed page, a missing permission, a rate limit or a disabled plugin never reads as "removed".
- **`part-of` stays acyclic, and the check is inside the write.** Before a new `part-of` claim becomes current, one recursive statement walks up from `to_ref` over current claims, with no depth limit. If it reaches `from_ref`, or the claim makes a thing part of itself, the claim is stored with `state: conflicted` and a `conflict_reason`. The rest of the inventory applies. The claim is kept as evidence and the conflict is visible: the entity's read returns `conflicts`, and the Connection's `warning` names it. There is one writer, so two claims cannot close a loop together. A conflicted claim is not promoted later when the loop opens. A complete read that no longer reports it removes it, and reporting it again checks it again.
- **A link between peers shows once, under its firmest claim** (`source`, then `person`, then `text`), and names only the claim's plugin or actor, never a Connection. Only a `source` or a `person` claim makes two things joined. A hint stays visible as a hint.
- **A link grants nothing.** It gives no permission and creates no concern. A target nobody has read stays a ref ([section 1.3](#13-restricted-things)).
- **Reparenting announces.** A claim replaced by a complete read announces `externalEntity`, and `task` with `derived: true` for the Tasks below it, found by one walk down over current `part-of` claims with no limit, even when the child's own row did not change. The set is the union of the Tasks before and after the change, so Tasks that lost a parent are told too.

## 7. Reading the graph

A flat list of ancestors cannot say which initiative holds which project, so every reply that draws paths carries the edges too: a client rebuilds every path from `ancestors`, `edges` and `places` alone.

`readContext(starts, ...)` is the one read of what lies above a list of refs: the Inbox, one entity, the Work board and the Add sheet's suggestions all call it. It makes one recursive statement over the indexed claims for any number of refs, then one batched read of the records and observations. There is no per-card statement and no HTTP call on a read. It cuts the places by one rule: the places asked for first, then the ancestors of each start in order, nearest first, up to the reply's bound. An ancestor left out is dropped from the ancestors of every start and from the edges, so a reply never carries an edge to a ref it carries no place for.

- It walks the distinct current `part-of` edges (`UNION`, never `UNION ALL`), as `(start_ref, ancestor_ref, depth)`. Two Connections reporting one edge, or an equal-length diamond, give one state, so the limits bound the work.
- It stops at `MAX_CONTEXT_DEPTH` (8) and reads at most `MAX_CONTEXT_PARENTS` (32) parents of one thing. It also has a state budget, so a wide graph cannot cost unbounded work.
- It returns each ancestor once per start, at its minimum depth, nearest first (then by ref). It returns every current `part-of` edge it crossed, both paths of a diamond included, at most `MAX_GRAPH_EDGES` (2,000, with one more read as a sentinel).
- When the edges or the states are cut, every start is `contextComplete: false`, and the ancestors listed come from the edges kept, not from the walk before the cut. No second walk is made.
- **`contextComplete` is false** when a bound cut the walk, an ancestor has no full or partial record, or an ancestor is stale or backing off. A depth cut counts only when something lies above depth 8. Nothing presents a partial picture as whole.
- Work's `WorkBoard` carries `contextComplete` too, for the same reasons.

The walk down, for reparenting, is a separate statement with no limit: a notification cannot silently leave out a deeper descendant.

## 8. The Inbox

### 8.1 Membership

A card is a **full record of a work kind**, not dismissed, with at least one of:

- a current concern;
- an open signal that is not snoozed now ([section 8.5](#85-signals-inside-a-card));
- a live linked Task.

Context and partial records have no card. Membership is **one SQL predicate in the external-entities repository**, used by both `queryInbox` and `countInbox`, so the cards and the counts cannot disagree. The predicate does not filter on `lifecycle`, `access`, the Connection's state, the kind being active or `stale`: a card survives a lost token and keeps its last known facts. A snooze ends with time and nothing is written when it ends, so every read of the predicate takes the time of the read.

The client's `layOutInbox` does not decide membership. It decides where a card lies on the page: which of its places surfaces, the first one in full, the others as a pointer, counted once ([./17-desktop-app.md](./17-desktop-app.md#inbox)).

### 8.2 Sides

The server decides the `InboxSide` of a card:

| Side | When |
|---|---|
| `with-someone-else` | The entity has a live Task |
| `requests` | No live Task, and the kind's `card` is `compact` |
| `ongoing` | No live Task, and the kind's `card` is `rich` |

A client keeps each card's side for the length of a visit, so a card the user just took on keeps its place. The next visit puts it under `with-someone-else`. A rich card lies as a row on the surface of each of its homes (the ancestors of the kind named by its `home`), the second and later ones as a plain pointer, counted once. A rich card with no home lies on a surface of its source, named for the kind's plugin.

### 8.3 Reading

`externalEntity.queryInbox` returns the whole Inbox in one reply and a fixed number of statements, capped at `MAX_INBOX_CARDS` (1,000) with `truncated`:

1. every eligible card, oldest first by `firstObservedAt` then `id` (stable, never by activity), with only the fields riding, the counts and the page order need. This is the one place a read evaluates the membership, and everything below works from it;
2. the direct confirmed links among those cards, one statement. From them the riding is decided once over every eligible card ([section 8.6](#86-what-rides)), and the counts are worked out ([section 8.4](#84-counts-and-the-new-mark)), so `countInbox` reads exactly these two statements and nothing more;
3. the page: `selectInboxPage` chooses the cards in bundles ([section 8.6](#86-what-rides)), then one statement reads their entity rows;
4. the signals of the cards on the page, one statement ([section 8.5](#85-signals-inside-a-card));
5. `readContext` over the listed cards, once (one walk up);
6. a batch read of the records, observations, Connections and scans of the cards and of every place their edges reach, and the latest change of each ([section 8.7](#87-what-changed-outside));
7. the direct links of the cards on the page and, in three statements, the records at their far end that have no card (`peers`).
8. *(Added 2026-11-08, [#1034](https://github.com/theagenticage/hercule/issues/1034).)* the offers ([section 8.8](#88-what-a-card-can-be-handed-to)): the Connections that can act on the cards on the page, the runnable workflows, and the Resources their workspaces name, one statement each, however many cards there are.

`places` holds each record above a card once, so 300 cards do not repeat their repository. Its bound is `MAX_INBOX_PLACES`, the card limit plus `MAX_GRAPH_EDGES`. *(Amended 2026-11-07, [#1033](https://github.com/theagenticage/hercule/issues/1033).)* `links` holds the direct links of the cards on the page, `hints` the pairs among them that only text holds together, and `peers` the records at their far end; the bounds are `MAX_INBOX_LINKS` and `MAX_INBOX_HINTS`, both `MAX_GRAPH_EDGES`, and `MAX_INBOX_PEERS`, their sum, and a read that reaches any of them sets `truncated`. A card gains `signals`, `ridesOn` and `latestChange`. *(Amended 2026-11-08, [#1034](https://github.com/theagenticage/hercule/issues/1034).)* It also gains `offerSetId` and `actingConnections`, and the reply gains `offerSets`. *(Amended 2026-11-08, [#1034](https://github.com/theagenticage/hercule/issues/1034).)* It also gains `liveWorkflows`: the workflows with a live run on the card's active Task, newest run first, at most `MAX_LIVE_WORKFLOWS`, empty when none. The client draws the card's colleague from the first one, so a card shows who has it however the user came to the Inbox, not only for the visit in which they handed it off.

Orders inside the page, and Group by and Filter, are the client's, over this reply: they cost no read and change no number.

### 8.4 Counts and the new mark

`Inbox.counts` and `externalEntity.countInbox` return the same `InboxCounts`, from the same function. The counts come from SQL over all eligible rows, so they include cards past `MAX_INBOX_CARDS`.

| Count | Meaning |
|---|---|
| `onTheClock` | The sidebar's number: distinct refs on the Inbox, not dismissed, with no live Task, of a kind with `pace: fast`, on either side of the page. An entity seen by two accounts, or for two concerns, counts once. Group, filter and order change no number |
| `requests` | The small count beside Requests. It counts the Requests side only, not With someone else, and leaves out what rides on a lead ([section 8.6](#86-what-rides)). `onTheClock` keeps it: a thing that rides still has its clock |
| `withSomeoneElse` | The count at the foot of the column |
| `newestArrival` | The highest `arrival_sequence` among the rows counted in `onTheClock`. Opaque and ordered: a client compares it with the value it stored and never displays it |

`arrival_sequence` comes from the counter table, never from `MAX() + 1`, and never from a time, so no clock is compared. A number is taken only when **a full, fast-paced, not dismissed entity with no live Task comes onto the Inbox in a `reconcile` or a `refresh`, with no concern from any Connection before**. A new concern is the usual cause. The concern union over all Connections is what counts, so these never take one:

- a refresh of a thing that was already there, a change of facts, a summary, or a second signal on a card already there;
- an Undo (`restore`), or a Task finishing;
- a second Connection reporting a concern that is already present;
- a concern joining a card that a live signal had already put on the Inbox;
- a partial record becoming full when it already had concerns.

A signal alone can bring a card onto the clock. That is an arrival too, taken once: `refresh` takes a number when it creates an entity that a live signal holds, and a raised signal takes one for an existing entity that was off the clock, through `SignalEntities.recordArrivalAfter` in the signal's own transaction. It is the same rule as for a write of observations: the Inbox is looked at before the write, and a card that was not on it, and concerned the user through no Connection, takes a number when the write puts it there as a full, fast-paced, not dismissed record with no live Task. A second signal, or one through a second Connection, finds the card on the Inbox and takes none.

**The new mark.** The 6px dot shows when `newestArrival` is above the value this client acknowledged. When an Inbox reply is really shown, the client stores that reply's `newestArrival` in local storage, under controller and user. It stores the reply's value and never the time, so an arrival racing the visit stays newer than what was acknowledged.

### 8.5 Signals inside a card

*(Added 2026-11-07, [#1033](https://github.com/theagenticage/hercule/issues/1033); [ADR 0054](../adr/0054-external-entities-are-durable-records-kept-true-by-polls.md).)* A signal shows inside the card it is about, and stays on Intake. The Signal record is [spec 10 section 9.1](./10-triage-intake-and-notifications.md#91-the-record).

- **The join** is exact string equality, on read: `signals.thread_ref = external_entities.ref`. Nothing is stored on either side, so a signal that came before its entity attaches the moment the entity appears, and an old signal needs no migration. Only an `event` signal has a thread ref: an `api` signal stores none and stays on its own. A ref is never parsed or changed to make it match, and a URL, a repository, a title or a core signal's evidence events never join. `github:pr:` and `github:issue:` are different refs. The index is `signals_thread_ref` on (`thread_ref`, `status`, `created_at`, `id`): a card's read seeks its open signals, and the detail reads the newest lines of one status straight off the index, in order, with no sort and no read of the other signals.
- **Only a work kind joins.** The entity must be a full record of a work kind, the shape that can have a card. A signal on a place (`linear:project:`), a document, a notification, a partial record or a ref nobody has read stays on its own, with Intake's actions. `listWanted`, `SignalEntity` and the Inbox all follow this rule.
- **Membership and retention differ on purpose:**

  | Question | Rule |
  |---|---|
  | Is the card on the Inbox? | An open signal that is not snoozed now puts it there ([section 8.1](#81-membership)). A snoozed signal does not, and shows in the card's lines marked so |
  | Is the record kept and read? | Any open signal, snoozed or not, stops the prune sweep and makes the ref wanted. A snoozed signal still needs its card to be current when it comes back |

- **Dismissal holds.** A dismissed card stays out of sight whatever signals arrive ([section 4.2](#42-dismissal)). The signal stays open and shows on Intake, so it is not lost.
- **A card's signals.** `InboxCard.signals` is `{ latest?, openCount }`. `openCount` counts the open signals that are not snoozed, and `latest` is the newest of them, by `createdAt` then `id`. A line (`EntitySignalLine`) holds the id, kind, title, asker, priority, status, time, the sentence (`say`), the `outcome` once the signal has ended and whether it is `snoozed`. It holds no blocks and no answers: opening a line reads `signal.read`. *(Amended 2026-11-08, [#1034](https://github.com/theagenticage/hercule/issues/1034).)* `InboxCard.signals` also carries `kinds`: the distinct kinds of the card's open signals, snoozed ones included, sorted and bounded by `MAX_ENTITY_SIGNALS`. A handoff ends the open signals of the kinds its workflow answers, and snoozed ones are among them, so the menu needs every open kind to say what a click ends and what it leaves open ("Ends *Review requested*. Leaves the mention open.").
- **The detail's signals.** `ExternalEntityDetail` gains `signals` (at most `MAX_ENTITY_SIGNALS`, 50), `openCount` (every open signal, snoozed ones included) and `signalCount` (open and resolved). The newest open signals are selected first, up to 50. The newest resolved ones fill any room left. The selected lines are returned in time order, oldest first, by `createdAt` then `id`. It is three statements, all served by that index and bounded by the limit however many signals the ref has: the two counts, the open lines, and the resolved lines (not read when the open ones fill the room). Open work is never hidden behind the word "older": a client says how many open lines it left out before it says how many resolved ones.
- **The sentence.** The Inbox card's `reason` is the sentence of its latest live signal. A card with no live signal keeps the observation's own reason. One function builds the sentence for a card and for every line of its detail. It reads the entity's `reason_templates` under the signal kind's word (the part after `<plugin>/`, so `github/review-requested` reads `review-requested`) and fills `{person}` with the signal's `asker`. It falls back to the signal's title, with the tone `plain`, for a core kind, for a kind the entity stores no template for, and when the template needs a person the signal does not have. The result is cut at a word to the bound of `EntityReason.say`. The templates are stored, never read from the catalog at read time, so a sentence reads well after its plugin is gone.
- **Arrival** is in [section 8.4](#84-counts-and-the-new-mark).
- **Acting on a card ends no signal it did not answer.** `takeOn` and `dismiss` end none. The user marks each signal done from its line with `signal.markDone`, or answers it with `signal.act`. A signal is never a fact of the Task. *(Amended 2026-11-08, [#1034](https://github.com/theagenticage/hercule/issues/1034).)* A handoff answers the signals of the kinds its workflow lists in `answers`, and only those ([section 9.6](#96-hand-off-and-its-undo)). Your work follows the links: it shows a signal on the active Task of its ref only ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md#signal)).

### 8.6 What rides

*(Added 2026-11-07, [#1033](https://github.com/theagenticage/hercule/issues/1033).)* A compact thing, such as a pull request, rides on a rich thing, such as its ticket, when the two have a direct link whose firmest claim is `source` or `person`. A hint joins nothing, and neither does sharing a repository or a project. `decideRiding(cards, links, now)` in `external-entities/riding.ts` is a pure function, and `queryInbox` and `countInbox` both call it, so the page and the counts cannot disagree.

- **A rider** is a compact card with no live Task, so one that lies in Requests, and a direct confirmed link to a rich card on the Inbox. A compact card that a Task holds stays under With someone else and never rides. Its link is a quiet row on the lead.
- **With several leads** it rides on the most pressing: the one that has used the largest share of its patience at the time of the read, then the lowest ref. A kind with `pace: slow`, or a card a live Task holds, has used none.
- Two rich things never ride on each other, and neither do two compact ones. Only a direct link counts, so a chain A to B to C joins only what touches the lead.
- **Decided over every eligible card, before the page limit.** A dismissed card is not eligible, so it leads nothing, and what rode on it stands alone. `queryInbox` decides once and derives its counts from it, and `countInbox` makes the same two reads and the same decision.
- **The page is chosen in bundles.** `selectInboxPage(refs, riding, limit)` walks the eligible cards in page order and takes the next lead, or card that rides on nothing, together with all its riders. It stops at the first bundle that does not fit in the room left. A rider never comes alone, because the counts leave out every rider, so a rider on a page without its lead would draw a Requests card the count did not include. So **a rider leaves the page with its cut lead**, and the page is never emptied by a lead it cannot fit: when the very first bundle is larger than the limit, it is cut to the limit, the lead and its oldest riders. `truncated` is true when any card was left off.
- **`InboxCard.ridesOn`** is the ref of the lead, and the lead is always on the page with it. `counts.requests` leaves out every rider ([section 8.4](#84-counts-and-the-new-mark)).
- **`peers`.** `EntityPeer` holds `ref`, `kind`, `noun`, `identifier`, `title`, `status`, `yours`, `restricted` and `latestChange`, and an `id` when the record is a full record of a work kind, so its row can open. A restricted peer holds only `ref`, `kind`, `noun`, `restricted: true` and `yours: false`. A link target that has no record, because no Connection ever read it, is a restricted peer too when an active kind owns its ref (by `refPrefix`), so it draws as a locked row while that kind is active. When no active kind owns it, it has no peer.
- **A link and a hint are two lists, and the controller decides which a pair is.** An `EntityLink` is a pair a source or a person claims, and names its claim's type (`source` or `person`) and its plugin or actor; an `EntityHint` is a pair only text holds together, with the `fromRef` whose text holds the reference and its `evidenceKey` (at most 128 characters), so a client can say "The description of #6263". A pair with a source's or a person's claim and a text claim is a link only, and a client never reads a claim's type to decide whether a pair joins. `hasPersonClaim` is true when a person also claims the pair, whatever the firmest claim is: a source's claim hides the person's one in `claim`, but the person can still take theirs back, and a client offers Unlink from this.

### 8.7 What changed outside

*(Added 2026-11-07, [#1033](https://github.com/theagenticage/hercule/issues/1033).)* **The system shows that something happened at the source, and does not act on it.** Rogier, 2026-11-07: "the system should show that something happened in the external system (someone else assigned the ticket, someone else created a pr, etc.), but not really act on it."

- **Written** by `reconcile` and `refresh`, in their transaction, when a compare of the raw stored values (never of a rendered sentence) shows news, and only on the accepted shared write: an older Connection's rejected observation makes none.
  - `reassigned`: the update sets an `owner` that differs from the stored one. `person` is the new owner. Clearing the owner is news too: the change has no `person` and reads "Unassigned".
  - `moved`: the update sets a status whose **key** (`status_key`) differs from the stored one. `value` is the new word. A word the plugin only renamed is no news, and a thing with no status before is no news either.
  - `linked`: a `source` claim joined a pair that no source or person joined before. It is written once for the pair, on both ends, with `target_ref` the other end. It stores no words: they are worked out when it is read. A second Connection reporting the same edge, a person's link and a hint write none. The resolver loop writes one too when it settles a claim ([section 5.5](#55-resolving-pending-claims)).
  - **A first observation writes none,** and neither does a partial record that a full observation completes. A claim written while its thing was not yet a full record is stored with `in_baseline`, and writes no `linked` change then or when it resolves later: what a thing already carried is a baseline, not news.
- **At most 50 rows for a ref** (`MAX_ENTITY_TIMELINE`). The write that goes over deletes the oldest.
- **The words** come from the entity's `reason_templates` under the keys `reassigned`, `moved`, `linked` and `unassigned`, else from the core's own sentences: "Now with {person}", "Moved to {value}", "Linked {value}", "Unassigned". They are built when read, by the function that builds a signal's sentence.
  - **A `linked` change names the far end from what the user can open now.** `{value}` is the far end's identifier when some Connection reads it (else "a pull request", its noun with an article). A far end no Connection can read, or that has no record, reads "a pull request you cannot open": the noun of its record, else of the active kind whose `refPrefix` starts its ref, else "thing". It never shows an identifier. So a change written while the far end was readable stops naming it when it no longer is. Reading a whole list costs at most two more statements.
- **Read.** `ExternalEntityDetail.timeline` holds at most 50 changes, oldest first. Each is `{ reason, sentence, at, ref? }`, with `ref` for a `linked` change. Each entity record, `EntityPlace` and unrestricted `EntityPeer` has `latestChange`, read for a whole list in one statement, so a Task's linked thing shows its latest change wherever the shared relation row draws it.
- **Nothing acts on it.** No stage moves, no run stops, no signal ends, no card changes place, no Task changes, and no event or signal is raised. Two pull requests for one ticket are fine: each is linked, and each says so.

### 8.8 What a card can be handed to

*(Added 2026-11-08, [#1034](https://github.com/theagenticage/hercule/issues/1034).)* A workflow with an `entity` input ([./07-workflows.md](./07-workflows.md#3-inputs)) can take a card's thing. A card carries its **offers**: the workflows it could be handed to, each available or unavailable with a reason.

**A workflow is available on a thing** when all of these hold:

1. It is enabled and valid.
2. It has exactly one `entity` input, and that input lists the thing's qualified kind.
3. It has at most one required `connection` input with no default of the Connection type of the kind's plugin (the core fills it with the acting account), and at least one acting account exists for the thing.
4. Every other required input has a default.
5. Its repository fits. A workflow with no `workspace`, or with no checkout, runs anywhere. A workflow whose workspace names Resources fits a thing that has a `repository` only when one of those Resources' `canonicalRemote` equals the thing's `repository.target.remote`. A pull request from a fork compares its **target**: that is the repository the work lands in. **A kind with no `repository`, such as a Linear issue, has nothing to compare, so any workflow fits.** A ticket does not say which repository it needs, so the user chooses by choosing the workflow, as they do today.

**Unavailable, with a reason.** When a workflow is listed and one of the rules above fails, the offer says why, when the user can act on it. When several fail, the first of these is given:

| `reason` | The menu says |
|---|---|
| `needs-input` | "*Name* needs *input*, which a card cannot fill" |
| `repository` | "*Name* works on *acme/web* only" |
| `no-account` | "No connected account can act on this" |
| `needs-workflow-change` | "*Name* needs a workflow change: replace its signal input with an entity input" |

`needs-workflow-change` is for a workflow that has a `signal` input on a signal kind the thing's plugin raises, and no `entity` input. It is listed so the user learns what to change, and it stays offered on Intake meanwhile ([spec 10 §9.4](./10-triage-intake-and-notifications.md#94-actions-done-and-hand-to-an-agent)). A disabled or invalid workflow is not listed at all, and neither is one whose `entity` input does not list the kind.

**The acting accounts of a thing** are the Connections of the Connection type of the kind's plugin that have an observation of this very thing with `access: ok` and whose status passes the rule a run start applies to a `connection` input: a Connection that is `disabled` is refused, and `needs-reauth` and `error` are not, because the action that uses the Connection reports that problem. They are listed oldest first (`created_at`, then id), and the first is the default. With several, the menu names the default ("as northwind-bot") and the user can change it. The Connection a poll last used plays no part. A thing no Connection can act on has none, and every workflow is then unavailable with `no-account`.

**The reply.** Offers depend on the kind, the target repository and whether an account can act, not on the card. So `Inbox.offerSets` maps an opaque `offerSetId` to the offers of that group, and each card names its set with `offerSetId` and lists its own accounts in `actingConnections`. The id is built from those three parts, and a client only compares ids; it never parses one. Offers are listed available first, then unavailable, each by name. The lists are bounded by the server (`MAX_ENTITY_OFFERS`, `MAX_ACTING_CONNECTIONS`), so the handoff never reads them: it checks its one workflow and its one Connection directly, with the same rules. `ExternalEntityDetail` carries `offers` and `actingConnections` for one thing. One pure function decides each offer, from workflows, Resources and accounts that are already read, so the Inbox, the detail and the handoff cannot disagree about what is available.

## 9. Operations

The group is `externalEntity` in `packages/contract`; the CLI spells it `hercule entity`. It reuses the `task` grant family, as `modelProfile` reuses `infra`: no new family and no grants migration. The operations are in [./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md#externalentity). Every mutation is stamped with an actor, and the permission check and the stamp live inside the service method. A transport handler is one line.

| Operation | Route | Grant | What it does |
|---|---|---|---|
| `externalEntity.queryInbox` | `GET /external-entities/inbox` | `task.read`, `signal.query`, `workflow.query`, `connection.query` and `run.query` | The Inbox ([section 8.3](#83-reading)), with the offers ([section 8.8](#88-what-a-card-can-be-handed-to)) |
| `externalEntity.countInbox` | `GET /external-entities/inbox/count` | `task.read` and `signal.query` | `InboxCounts`, for the sidebar |
| `externalEntity.read` | `GET /external-entities/:id` | `task.read`, `signal.query`, `workflow.query` and `connection.query` | One full record of a work kind, with its offers. `NotFound` for a partial or context record |
| `externalEntity.takeOn` | `POST /external-entities/:id/take-on` | `task.update`, user only | [Section 9.1](#91-take-on-and-add-to-work) |
| `externalEntity.undoTakeOn` | `POST /external-entities/:id/take-on/undo` | `task.update`, user only | [Section 9.2](#92-undo-of-a-take-or-an-add) |
| `externalEntity.handOff` | `POST /external-entities/:id/hand-off` | `run.start`, user only | [Section 9.6](#96-hand-off-and-its-undo) |
| `externalEntity.undoHandOff` | `POST /external-entities/handoffs/:runId/undo` | `run.write`, user only | [Section 9.6](#96-hand-off-and-its-undo) |
| `externalEntity.dismiss` | `POST /external-entities/:id/dismiss` | `task.update`, user only | Sets `dismissed_at` and `dismissed_by` |
| `externalEntity.restore` | `POST /external-entities/:id/restore` | `task.update`, user only | Undo of a dismissal |
| `externalEntity.search` | `GET /external-entities/search` | `task.read` and `connection.query`, user only | [Section 10](#10-search-recognition-and-resolution) |
| `externalEntity.listSuggestions` | `GET /external-entities/suggestions` | `task.read` | What the Add sheet lists before you type |
| `externalEntity.addToWork` | `POST /external-entities/add-to-work` | `task.update`, user only | [Section 9.1](#91-take-on-and-add-to-work) |
| `externalEntity.link` | `POST /external-entities/links` | `task.update`, user only | [Section 9.5](#95-link-and-unlink) |
| `externalEntity.unlink` | `POST /external-entities/links/remove` | `task.update`, user only | [Section 9.5](#95-link-and-unlink) |

`read` returns the common fields of a card plus `kindAvailable`, `places`, `edges`, `links` (the pairs a source or a person joined, each once, under its firmest claim, which names only its plugin or actor and never a Connection), `hints` (the pairs only text holds together), `conflicts` (the claims the graph refused, with why), and, from slice 5, `signals`, `openCount`, `signalCount`, `timeline` and `peers` ([sections 8.5 to 8.7](#85-signals-inside-a-card)). It needs `signal.query` besides `task.read`, because it shows signal text. *(Amended 2026-11-08, [#1034](https://github.com/theagenticage/hercule/issues/1034).)* It also returns `offers` and `actingConnections`, and needs `workflow.query` and `connection.query` for them, because offers name workflows and accounts. The service checks all four before it reads. The static paths (`inbox`, `search`, `suggestions`, `add-to-work`) sit beside `/external-entities/:id`, and the router prefers them.

A session may read (`list`, `read`, `suggestions`) but may not take on, add, dismiss, restore, link, unlink, hand off or take a handoff back: those are user only. The three reads that show signal text need `signal.query` as well, and the two that show offers need `workflow.query` and `connection.query`.

### 9.1 Take on and Add to work

Both create a Task for a thing, and share one step, `prepareEntityForTask(ref)`, which runs outside any transaction, after looking for an active Task:

- A **context kind** cannot be taken on. It fails `InvalidState`, saying why.
- A full record with `access: ok` and an active kind needs no read.
- Anything else (no record, a partial record, lost access) is read with `resolve` ([section 10](#10-search-recognition-and-resolution)). If that fails, the operation fails and no Task exists. A partial `found` result cannot satisfy preparation.

Inside the final transaction the service revalidates the exact requested ref, full completeness, `access: ok` and an active kind. For a prepared observation, it first checks that its Connection is still eligible, and applies it. Otherwise it recomputes those properties from current rows, so the path with no read is checked too. If they no longer hold, it fails with `Conflict` and no Task, and asks to retry. It never resolves inside the transaction. It also checks that no active Task has appeared, then writes the Task and the link together. The window between the first look and the transaction is only an optimization.

**Tasks go through `TaskService`.** The tasks domain provides two user-only methods for this: one creates a Task linked to one ref inside the caller's transaction, and one deletes a Task only when it is untouched since creation. The entity domain never inserts a Task itself.

- **`takeOn`** with an active Task returns that Task: a second click, or a second account, is idempotent. With none it creates a Task: the entity's title, the stage of [section 9.3](#93-the-stage-a-new-task-starts-at), priority `normal`, the project of [section 9.4](#94-the-project-of-a-task-taken-on), and provenance `{ ref }`, which writes the link. It returns `{ taskId, created }`. It fails `NotFound` for an unknown id. It writes nothing on the source.
- **`addToWork { ref, projectId? }`** with an active Task returns that Task with `created: false` before any read, even when Hercule holds no record of the ref (the reply then has no `id`). Otherwise, after `prepareEntityForTask`, it writes in one transaction: the observation that was read (which creates the entity when it is new), the Task as `takeOn` makes it (in `projectId` when given; an unknown Project is `NotFound`), and `following` on the link when the entity has no concern of its own. It returns `{ id?, taskId, created, stage, followed }`; `id` is absent only when an existing Task links a ref Hercule holds no record of. The line at the foot reads "Added to Exploring. Hercule now follows WEB-301." Adding is always one thing at a time.

Outbound work uses no credential in this slice. Never pick credentials from whichever poll updated the card. *(Amended 2026-11-08, [#1034](https://github.com/theagenticage/hercule/issues/1034).)* A handoff starts a run that acts through a Connection, so it picks one by a rule and not by the last poll: the acting account of [section 8.8](#88-what-a-card-can-be-handed-to), chosen by the user or the oldest one.

### 9.2 Undo of a Take or an Add

A Take or an Add that `created` a Task undoes with `externalEntity.undoTakeOn { id, taskId }`. In one transaction it reads the Task by its own id, **without following a merge redirect**, and deletes it only when it is live, not merged, and untouched since it was created: no Thread, no run, no other link, no edit. A Task that was merged into another is refused with its own reason, because the survivor now holds its work and its links. The check also requires the Task to link this entity's ref, so a stale id never deletes another thing's Task. Otherwise it changes nothing and answers `{ undone: false, reason }`, the undo line says why, and the Task stays. A check in the client could race a Thread joining, so the check and the delete are one write. A Dismiss undoes with `restore`.

### 9.3 The stage a new Task starts at

`chooseStageForEntity(entity)` is the `stage` that the entity's status declares in the kind table, else `planned`. So Todo is Planned and In progress is Building. This one rule serves Take and Add.

### 9.4 The project of a Task taken on

Task `projectId` must be a real Project, so a Linear project or a GitHub repository is never used as one. The service takes `repository.target.remote` from the entity, finds its Resource by canonical remote, and finds that Resource's Projects (`project_resources`), leaving out deleted Projects, which keep their rows. With exactly one, it uses it. Otherwise the Task has no project. External team and project facts group things and never create core Projects or Initiatives.

### 9.5 Link and unlink

*(Added 2026-11-07, [#1033](https://github.com/theagenticage/hercule/issues/1033).)* The user links two things with one move, and takes the link back. Both are methods on the service, user only, with the grant `task.update`. Refs hold `:`, `/` and `#`, so they travel in a body. The CLI spells them `hercule entity link <ref> --to <ref>` and `hercule entity unlink <ref> --to <ref>`.

- **`externalEntity.link { fromRef, toRef }`** writes a `person` claim of relation `linked`, stamped with the actor. The target may be a ref nobody has read: it is read like any other linked target ([section 5.3](#53-refresh-listwanted-and-reportmissing)). The source is never told. Linking a pair the user already linked, in either direction, changes nothing. It fails `NotFound` when Hercule holds no record of `fromRef`, and `InvalidState` for the same ref twice and for a ref that starts with `unresolved:`.
- **`externalEntity.unlink { fromRef, toRef }`** removes the user's own claims between the two refs, in either direction, and returns `{ removed, remaining? }`. `removed` is false when the user had made none. `remaining` is the firmest claim type that still joins them (`source`, `person` or `text`). A source's claim stays: only a person's word is the person's to take back.
- A source's claim is firmer than a person's, so linking a pair that a source reports changes nothing the user sees. Linking a pair that only a hint reports makes it a link, and the hint is no longer drawn.

### 9.6 Hand off and its Undo

*(Added 2026-11-08, [#1034](https://github.com/theagenticage/hercule/issues/1034); [ADR 0046](../adr/0046-handing-a-signal-off-tracks-the-work-on-a-task.md).)* **`externalEntity.handOff { id, workflowId, connectionId? }`** hands a card's thing to a workflow, as the user. It lives in its own service, `ExternalEntityHandoffs`, in the shape of `SignalHandoffs`, because it calls the run and signal services. It returns `RunStarted` and the `taskId` the run works on.

**The rule: acting never ends a signal it did not answer.** A handoff ends only the open signals of the kinds its workflow's `entity` input lists in `answers`. A mention on the same pull request stays open on the card. The order is what makes this safe:

1. Check the caller is the user and the entity exists.
2. **The boundary.** Read the workflow's `answers`, then the ids of the open signals on this exact ref whose kind is in it, snoozed ones included. This is the whole set the handoff may end. A signal that arrives after this read stays open: it is new work.
3. **Claims.** Take `SignalClaims.withSignalsClaimed` on those ids, around the transaction ([spec 10 §9.6](./10-triage-intake-and-notifications.md#96-when-a-signal-leaves)). If a plugin answer or a withdrawal holds one, the whole handoff fails `invalid_state` before anything is written: "A reply to this is still running. Try again in a moment."
4. In one transaction:
   - Check the offer again: the workflow is available on the thing ([section 8.8](#88-what-a-card-can-be-handed-to)) and the chosen account, or the oldest one, can act. An offer read a moment ago proves nothing.
   - Read the workflow's definition and compare its `answers` with the boundary's, as sets. If they differ, fail `invalid_state`, "This workflow changed. Try again.", with nothing written. The run below is started from this same read, so the run and the signals it ends come from one definition.
   - Find the active Task of the ref ([./09-tasks.md](./09-tasks.md#entity-links)), or choose an id for a new one.
   - **Refuse a double click.** When `RunService.findLiveRunOnTask` finds a run of this workflow on the Task that has not ended, fail `invalid_state`, "*Workflow* is already working on this." A second handoff to another workflow is allowed: that is the chain the Task holds.
   - Start the run on the Task with the ref in the `entity` input and the acting account in the `connection` input, if the workflow has one. The first session is placed after the commit, so no transaction waits on a runner ([ADR 0004](../adr/0004-controller-state-lives-in-one-sqlite-database.md)). A run that cannot start rolls everything back.
   - Write the Task and its provenance entry `{ ref, runId }` ([./09-tasks.md](./09-tasks.md#a-handoff-from-a-card)). The core never moves a stage on its own: a handoff decides `building` only from `exploring` or `planned`.
   - End each claimed signal that is still open, with `SignalService.resolveAnswered`: `decided`, the Hand to an agent action id of the workflow, the outcome "Handed to *workflow*", the run, the user's actor, a `signal.decided` audit entry. One that its source ended in the meantime is skipped and is no failure. It runs no source action, tells the source nothing, and feeds no Ignore Rule suggestion: this is not Done.
   - Write the `entity_handoffs` row the Undo reads.
5. After the commit it announces `externalEntity`, `task` and `signal`, and the run's start pushes `run` ([section 12](#12-live-updates)).

Intake's Hand to an agent works as before and shares two rules with this: both continue the oldest live link's Task, and both refuse a second live run of the same workflow on it ([spec 10 §9.4](./10-triage-intake-and-notifications.md#94-actions-done-and-hand-to-an-agent)).

**`externalEntity.undoHandOff { runId }`** takes a handoff back as far as is safe. Cancelling a run is not a rollback, so the handoff keeps its `entity_handoffs` row and the Undo reads that, not the client. In one transaction: it returns the first answer when the Undo was done before; answers `too-late` and changes nothing when the run has ended; decides what may be taken back, before cancelling, because cancelling changes how the run looks; cancels the run and its unfinished sub-runs, as `run.cancel` does (the runner hears after the commit, so this is a stop requested and not a stop done); and reverses the Task if the rules allow. The rules for the Task, the three outcomes (`undone`, `stopped`, `too-late`) and the failure that comes back are in [./09-tasks.md](./09-tasks.md#a-handoff-from-a-card). In practice a full Undo works in the moment before the run's first step starts. After that, Undo means Stop, and the line says so. Signals the handoff ended stay ended; the card stays, because its concern stays, and its place and wait return. A second handoff's run is never touched.

## 10. Search, recognition and resolution

Three separate steps, because they have different rights.

**Recognition is pure.** A plugin recognizes only its own URL and identifier forms. It fetches nothing, follows no redirect and gets no credentials. `recognize(text)` returns at most 20 recognitions, each one of:

- `{ recognized: "ref", form, ref, kind }`: the text names exactly one thing;
- `{ recognized: "scoped", form, kind?, identifier, scopeHint? }`: the text names something only inside a scope, such as `SHOP-123`, which means nothing without its workspace. `kind` is absent when the text does not say which kind it is. GitHub's `owner/repo#87` names an issue or a pull request, so it is `scoped` with no `kind`, and `resolve` finds out which.

**Resolution is credentialed.** Reading the target always uses the target plugin's eligible Connection: `connected` or `error`, with the plugin active. Never the Connection of the thing that mentioned it, and never the first match.

**Search reaches the source.** Results come live through the plugin, never from what Hercule holds. A lookup runs outside any transaction, and the host gives each call a timeout of 8 seconds and fails it as `source-unavailable`.

**How the host decides a resolution.** It gives one answer for all the target plugin's eligible Connections, at most 8:

- A `ref` recognition asks them in turn, oldest first, until one finds it. If none does, a failed Connection makes the answer `incomplete`. Otherwise the answer is the firmest `missing`: `inaccessible`, then `unknown`, then `not-found`.
- A `scoped` recognition asks every one. `outOfScope` rules a Connection out. What was found is grouped by canonical ref, so two accounts in one workspace give one answer, not two:
  - one ref, and every other Connection answered or was ruled out: found;
  - two or more refs: `ambiguous`, and it stays unresolved with its evidence;
  - a Connection failed or was skipped: `incomplete`, even with one ref found, because that Connection may hold another answer.

**`externalEntity.search { source, text, scopeRef? }`**, where `source` is a plugin id:

1. **A link can change the source.** When the text is one URL, the host runs `recognize` over every active plugin's lookup and takes a recognition with `form: "url"`. The reply's `source` is then that plugin's. A URL no plugin recognizes answers `unknown-link`, with the sources that can read links in `linkSources`.
2. **Anything else stays on the chosen source and scope.** An identifier is recognized by that plugin alone, and words go to its `search`, over its eligible Connections, at most 4, oldest first, merged by ref. A fifth eligible Connection sets `incomplete`. A scope the source cannot search by fails the call; it never widens the search.
3. **Mark each result** from what Hercule holds, in one batched read: `new` (no record), `known` (a record, no live Task) or `on-work` (a live Task, named in `taskId`).

Outcomes: `results`, `no-match`, `inaccessible`, `not-found`, `unknown`, `ambiguous`, `incomplete`, `unknown-link`, `source-unavailable`. A reply holds at most 20 results. A source that cannot tell a missing thing from a forbidden one, as GitHub cannot, answers `unknown`. Nothing is stored by a search. A link to something no Connection can read returns no title, because none was read.

**`externalEntity.listSuggestions { contextRef? }`** lists entities with a current concern and no active Task, under the given context when there is one, reached through upward `part of`, each once, at most 100. Context records are never listed. A thing in two contexts is listed once, and the reply names the others in `alsoIn` ("Also in Pricing rules"). Choosing a context never creates Tasks for its children.

**Scopes.** The Add sheet's scope select lists the stored context records of that plugin's `groupable` kinds, from `places` on the board and the Inbox. It needs no read of its own.

## 11. Work's context

Work's Group by and Filter read through a read model, with no new table. `TaskBoardFacts` reads every board Task's explicit entity links, then one `readContext` over all those refs at once. No per-card statement runs.

- `WorkCard` gains `entityMarks` (at most 3: plugin id and kind) and `contextRefs`: its linked refs and everything above them, at most `MAX_CARD_CONTEXTS` (64).
- `WorkBoard` gains `places` (each record once, at most `MAX_BOARD_PLACES`), `edges` (at most `MAX_GRAPH_EDGES`), `groupings` (the `groupable` kinds that have at least one place on this board, each with its caption) and `contextComplete`.
- **A Task is matched through its own links and upward `part of` only.** A peer's ancestors are never its own: a `linked` claim adds nothing to `contextRefs`.
- `task.queryBoard` needs no new grant: `places` comes with the Task's links.
- **Hercule's Initiatives and Projects stay separate.** An outside project is only ever a lane or a filter. Filtering or grouping by one never sets a Task's `projectId` or `initiativeId`.

**The details pane.** `TaskDetail` ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md#task)) carries the Task's own `entities` (each linked thing as an `EntityPlace`, in link order), `places` and `edges`, read through the same `readContext` for one Task. The pane draws two sections from them, as the shared relation rows: **Part of** lists every place above any linked thing by every path, each once, nearest first, with a place no Connection can read as a locked row; **Linked** lists the linked things themselves, each as its identifier and title and its kind and status. A section with no rows is not drawn. An `EntityPlace` carries `identifier` when the record has one and the place is not restricted, for these rows. *(Amended 2026-11-07, [#1033](https://github.com/theagenticage/hercule/issues/1033).)* Each `EntityPlace` carries `latestChange` ([section 8.7](#87-what-changed-outside)), which the shared relation row draws. The direct links between things, the hints found in text and the far-end records are on the thing's own `externalEntity.read` reply.

**Stacks.** *(Added 2026-11-07, [#1033](https://github.com/theagenticage/hercule/issues/1033).)* A stack means what a confirmed link says. `WorkBoard` gains `stackCandidates`, at most `MAX_BOARD_STACK_CANDIDATES` (2,000) pairs `{ leadTaskId, memberTaskId, noun }`, and `stackCandidatesTruncated`. A pair is a Task that links a rich thing and a Task that links a compact thing with a direct `source` or `person` link to it. `noun` is the member thing's kind noun (the lowest, when a member links several). A hint never makes a pair. A Task is never paired with itself, so a Task that links both things makes none, and a pair found through two links is one candidate. Both are decided before the limit, in one statement. What the limit leaves out simply draws as cards.

A Task can link several things, so candidates can compete or point both ways. The client's `arrangeCell` chooses, per cell, by one rule, so stacks never nest:

1. Walk the cell's Tasks in `boardRank` order, then id.
2. A Task not yet placed, with at least one unplaced candidate member in this cell, becomes a lead and takes all of those members.
3. Each Task ends up once: a lead, a member of one lead, or a card alone. A lead is never another stack's member.

Nothing stores a stack. A member dragged to another cell is a card. A stack counts as one row, floats as one unit, and is loud, and opens by itself, when its lead or any member is.

Filtering and grouping run in client-core over that reply, so they cost no read. A Task under two places has a card in each; stage headers count distinct Tasks. A drop in an outside lane changes the stage only and never the membership.

## 12. Live updates

The `externalEntity` topic is a mutable topic ([./14-web-app.md](./14-web-app.md#wire-format)): its push names the changed entity ids. A card depends on more than its own row, so each cause is named:

| Cause | Reads it changes | Who publishes |
|---|---|---|
| A poll changes what a card shows (access included) | the Inbox, the count, Work's marks, an open pane | `external-entities` announces `externalEntity`. When the ref has a live Task, it also announces `task` with `derived: true`: it imports `tasks` |
| A claim changes, or a place's title, status or progress | the Inbox, the board's lanes and filters | the same, for the Tasks below it, found by one walk down |
| Take, Add, Dismiss, Restore | the Inbox, the count, the board | the service, on both topics |
| A handoff, or its Undo *(added 2026-11-08, [#1034](https://github.com/theagenticage/hercule/issues/1034))* | the Inbox, the board, the count, To do | the service announces `externalEntity` and `task`; the signals it ended push `signal`; the run's start pushes `run` |
| An offer's inputs change: a workflow is edited, enabled or disabled, or a Connection changes *(added 2026-11-08, [#1034](https://github.com/theagenticage/hercule/issues/1034))* | the Inbox's and a detail's offers | `workflow` and `connection` already push. `workflow` is not shell data, so the Inbox route subscribes to it; `connection` is mapped to the Inbox keys |
| A Task finishes, is deleted, merged, or gains or loses a link | the Inbox's membership, the count | `task` already pushes. The client maps `task` to the Inbox keys, so no reverse import is needed |
| A signal opens, ends or is snoozed | the Inbox, the count, an open card | `signal` already pushes. The client maps it to the Inbox keys |
| A thing becomes a full record of a work kind (created, or a partial record made full) | Intake: its open signals now show the record as `Signal.entity` | the poll announces `signal` for each open signal on that ref, snoozed ones included, beside `externalEntity`. An `externalEntity` push alone leaves the signal lists alone |
| A snooze runs out | the Inbox, the count | nothing is written, so nothing pushes. The desktop's snooze timer reads them again when the soonest `until` passes |
| A Fact moves a stage *(added 2026-11-08, [#1035](https://github.com/theagenticage/hercule/issues/1035))* | the board, an open pane | an ordinary `task` write on the 50 ms window, not `derived` |
| A Fact moves only the fence | nothing | no announce |
| A Task links or unlinks a thing by hand, or the branch step links one | the board, the pane, the Inbox | `TaskService` announces `task` and `externalEntity` |
| A person links or unlinks two things | the Inbox, an open card, the board | the service announces `externalEntity` for both refs, and `task` with `derived: true` for the Tasks that link them |
| The resolver settles a claim | the same | the same announcement |
| A Connection changes status | `stale` | `connection` already pushes. The client maps it to the Inbox keys |
| A plugin is enabled or disabled | `stale`, `kindAvailable` | `plugin` already pushes. The client maps it to the Inbox keys |

A Task's summary reads the kind, identifier, title, status label and lifecycle of each thing the Task links ([./09-tasks.md](./09-tasks.md#task-summaries)). The write that changes one of those marks every live Task that links the ref dirty (`TaskService`'s marker, `makeSummaryDirtyMarker`), in the write's own transaction. A change to concerns, progress, dates or access alone marks nothing, so a busy poll does not cost a model call. The summary's input reads the facts through `externalEntityRepository.listLinkedEntityFacts`, one batched statement, never through the service.

A poll that changes nothing announces nothing, so a quiet Inbox costs no read. Nothing is announced after a rolled-back transaction: the service publishes after commit.

## 13. The domain graph

Source lives in `apps/controller/src/external-entities/`. It owns entity lifecycle, relation claims, rendering slots, and the Inbox reads. Reading the source stays in the plugin, and polling stays in the host.

```
external-entities -> actor db events tasks resources connections plugins signals
                     runs workflows *(added 2026-11-08, #1034)*

plugins    declares port EntityObservations  -> answered in daemon/ingest/
           declares EntityRecognizer         -> filled by the plugin host at start
signals    declares port SignalEntities      -> answered in daemon/ingest/
workflows  declares port WorkflowEntities    -> answered in daemon/workflows/ *(added 2026-11-08, #1034)*
tasks      TaskBoardFacts                    -> daemon/tasks/ also reads entities and their ancestors
daemon/ingest  ClaimResolution (external-entities) + EntityLookups (plugins) -> the resolver loop
```

- No domain imports `external-entities` except through a port, so the arrows only ever point out of it and the graph stays acyclic.
- *(Added 2026-11-08, [#1035](https://github.com/theagenticage/hercule/issues/1035).)* The tasks domain declares a port, `LinkedEntities.readMany(refs)`, which returns each ref's stored work or context classification, lifecycle and access, or nothing for a ref with no record. `daemon/tasks/linked-entities.ts` answers it from the entity repository and, for a ref with no record, from the declared kinds in the stored plugin catalog. It reads the database only. It must never require `PluginHost`, `ExternalEntityService` or anything that does: `ExternalEntityIngestLayer` sits below `PluginHost`, and ingest calls `TaskService`. `external-entities` calls `TaskService.snapshotLinkedEntities` and `recordEntityFacts` around every write that can change a linked entity's state ([section 14](#14-facts-links-by-hand-and-the-branch-join)).
- `ExternalEntityService` requires `TaskService`, so nothing `TaskService` needs may require `ExternalEntityService`. A port the tasks domain declares is answered from the repository, which needs only the SQL client.
- `plugins` cannot import `external-entities`, because it imports `plugins` for the catalog. The port is `EntityObservations`, in `plugins/entity-observations.ts`, answered in `daemon/ingest/entity-observations.ts`, as Open Signals is. The host side of search is `EntityLookups` in `plugins/entity-lookups.ts`.
- *(Added 2026-11-07, [#1033](https://github.com/theagenticage/hercule/issues/1033).)* `external-entities` imports `signals`, for the rows. `signals` imports nothing of it: it declares the port `SignalEntities` (`readByRefs`, `recordArrivalAfter`) and the controller daemon answers it from the entity repository.
- Recognition (pure) is the ingest's, over a `RecognizeText` that the ingest context builds from the active sources it is given at each call. `PluginHost` requires the ingest loops, so the ingest context cannot depend on the host: the reconciler hands the active sources to `IngestLoops.open`. Resolution (credentialed, slow) is the controller daemon's resolver loop, which may require `EntityLookups`; the database side is `ClaimResolution` in this domain ([section 5.5](#55-resolving-pending-claims)).
- The repository requires the SQL client only. Its write methods join the caller's transaction and never open their own or call a service.

## 14. Facts, links by hand and the branch join

*(Added 2026-11-08, [#1035](https://github.com/theagenticage/hercule/issues/1035), slice 7; [ADR 0055](../adr/0055-facts-move-cards-through-editable-workflows.md).)* A Task keeps its link to a thing true, and the thing's state moves the Task's card through two shipped workflows. The Task side (Facts, the fence, what counts as open, the shipped workflows) is in [./09-tasks.md](./09-tasks.md#facts-and-the-fence). This section holds what belongs to entities: how ingest feeds Facts, how a link is found, and how the user's unlink holds.

### 14.1 Ingest feeds Facts

A Fact is a lifecycle change of a linked thing, so it is written where the entity is written. Every write that can change what a Task counts goes through one pair of `TaskService` methods, and nothing else in this domain knows the rules:

1. `snapshotLinkedEntities(refs)` reads, before the write, the linked-work state of those refs that a live Task links.
2. The write happens: `writeObservations` (for `reconcile`, `refresh` and a read of one ref), `reportMissing`, and any other place that changes `access` (the inaccessible rows of `listWanted`, pruning).
3. `recordEntityFacts(snapshot)` compares each ref's state now with the snapshot, in the same transaction, and writes one Fact and one `task.entityChanged` for each live linked Task when:
   - the lifecycle changed;
   - the ref had no record before (a first observation, `previous_lifecycle` null);
   - the Task's `openLinks` or `completedLinks` differ between before and now (a change of `access`, or a first full record), with `previous_lifecycle` equal to the lifecycle.

   Never anything else. A poll that changes nothing writes nothing: no Fact, no event, no push.

A first observation with no link writes no Fact. `reconcile` and `refresh` still emit no event and raise no signal of their own ([section 5.1](#51-reconcile)).

### 14.2 What counts as open

The count that decides whether a card lands is in [./09-tasks.md](./09-tasks.md#what-counts-as-open). The entity side of it:

- Work or context for a **full record** comes from the stored record. So a record stays counted after its kind leaves the catalog, and its stored `access` decides whether it is readable. A kind leaving the catalog does not by itself make a record unreadable.
- Work or context for a **partial record**, and for a ref with no record, comes from the kind the catalog declares. `isWorkRecord` needs a full record and cannot classify a partial one.
- Readable means `access: ok` (derived across Connections, [section 4](#4-lifecycle)). Anything else counts as open.

### 14.3 Links, suppressions and unlinking

- A link is a row of `task_entity_links` ([./09-tasks.md](./09-tasks.md#entity-links)), added by a provenance `ref`, a handoff, `task.linkEntity` or the branch link step. A link added by any path writes a Fact (`previous_lifecycle` null) when the entity has a stored lifecycle.
- **`task_entity_link_suppressions (task_id, ref, suppressed_at, suppressed_by)`** holds one row for each Task and ref the user unlinked. `task.unlinkEntity` writes it, in the transaction that removes the link and voids the pair's Facts. `task.linkEntity` and an explicit provenance `ref` on `task.update` clear it.
- **The branch link step checks suppressions first.** It never adds back a pair the user unlinked, and a refresh of the entity updates the record and never restores the link.
- **A merge** moves suppressions with the Task, without duplicates. When one Task links a ref and the other suppresses it, the link wins and the suppression is dropped.

### 14.4 Finding a Thread's pull request: the branch join

Hercule already knows a session's live branch. The runner reports the workspace after each `turn.completed` and on exit, and the controller writes `checkouts.branch`. So a rename by the agent is followed. An entity holds `repository.head` as `(remote, branch)` since slice 4. A link is a join of the two.

A step of the controller daemon (`daemon/tasks/entity-links.ts`) runs after each complete scan, after each refresh of a kind that has a `repository`, and when a checkout's branch changes. It joins the entities whose `repository.head` is `(remote, branch)` with the checkouts of ephemeral workspaces whose sessions have a live Task. The checkout's remote is its Resource's `canonicalRemote`.

- **Match on the head, not the target.** A fork's head remote differs from the Resource's, so a fork's pull request does not match; the user links it by hand. Two repositories that share a branch name never match each other.
- **Skip** a checkout on its `default_branch`, and workspaces of kind `primary`: a main workspace's branch says nothing about one Task.
- **Count the Tasks first.** The step counts distinct live Tasks for each `(remote, branch)` over the whole association, before it filters by suppression or "already linked". Several sessions of one Task in one workspace are one match. Two different live Tasks on one branch link neither, and the step logs why. A wrong link is worse than a missing one, and the user can link by hand. Counting before the filter matters: otherwise a Task that unlinked the pull request would drop out of the count, and the other Task would look alone on the branch and get the link.
- **Skip** a pair the user unlinked ([section 14.3](#143-links-suppressions-and-unlinking)).
- **This is not the branch-name match ADR 0046 rejected.** It reads the branch the checkout really has, it matches on the head's remote, and it holds for a Thread and a run alike.
- A pull request never links its ticket: that needs reading text. A Take or a handoff links it, the user links it by hand, or a workflow records a ref.

### 14.5 Short-lived pull requests: `listTrackedBranches`

The inventory is `is:open`, so a pull request opened and merged between two scans may never appear in it. So the core also tells the plugin which branches it cares about. `IngestContext.entities` gains:

```ts
/** Returns tracked branches on remotes starting with `remotePrefix`, at most `limit`, in a fair rotation. */
readonly listTrackedBranches: (remotePrefix: string, limit: number) =>
  Effect.Effect<ReadonlyArray<{ readonly remote: string; readonly branch: string }>>;
```

- It lists the branches of ephemeral checkouts of live Tasks that are not the default branch and are on the remote (`remote_branches`, a JSON column on `checkouts`).
- **A fair rotation.** Branches have no observation rows, so the rotation has its own durable cursor, `tracked_branch_attempts (connection_id, remote, branch, last_attempted_at)`, primary key on all three. Like `listWanted`, it stamps `last_attempted_at` on what it returns, before it returns, never-tried first and then oldest first. So more branches than the limit all get their turn.
- **It leaves a branch out only when the Task already links an entity whose `repository.head` is this exact `(remote, branch)`.** It is an anti-join on the head, not on "has a link":

| What the Task already has | Is the branch listed? | Can the link step link what it finds? |
|---|---|---|
| A link to something else, such as its Linear ticket | Yes | Yes. A ticket says nothing about this branch |
| A link to a pull request with this head | No | Nothing to do |
| A pull request with this head that the user unlinked | Yes, it may be read again | No. The suppression holds, so a refresh updates the entity and never restores the link |

- **The plugin** reads each branch's pull requests by head and reports them with `refresh`, which creates the entity with no concerns ([section 5.3](#53-refresh-listwanted-and-reportmissing)). The GitHub feed is in [./08](./08-events-and-connections.md#51-github-plugin). The link step does the rest. So a pull request that is already merged when first seen links, and its Fact has `lifecycle: completed` and `previous_lifecycle` null: the card lands.
- The capability grows additively, so `hostApi` stays 8.

## Later slices

Not in this document yet, and the tables allow for them:

- ~~Linking a Thread's pull request to its Task, and moving cards on facts. `repository.head` is stored here and used there (slice 7).~~ *(Amended 2026-11-08, [#1035](https://github.com/theagenticage/hercule/issues/1035): built, in [section 14](#14-facts-links-by-hand-and-the-branch-join).)*
- A triage cluster as Hercule's own kind, `core/triage-cluster`, written by the core with no Connection. `external_entities.kind` is a string and an entity needs no observation row, so it fits. It is not built.

## Sources

- [Work overview: the design and its tickets (#1026)](https://github.com/theagenticage/hercule/issues/1026)
- [The Inbox of External Entities (#1032)](https://github.com/theagenticage/hercule/issues/1032)
- [Work overview, slice 5: signals live inside their entity, and Linear joins (#1033)](https://github.com/theagenticage/hercule/issues/1033)
- [ADR 0054 - External Entities are durable records kept true by polls](../adr/0054-external-entities-are-durable-records-kept-true-by-polls.md)
- [ADR 0006 - Plugins request capabilities and register contributions in code](../adr/0006-plugins-request-capabilities-and-register-contributions-in-code.md)
- [ADR 0019 - The task model is thin; workflows own task semantics](../adr/0019-the-task-model-is-thin-workflows-own-task-semantics.md)
- [ADR 0046 - Handing a signal off tracks the work on a Task](../adr/0046-handing-a-signal-off-tracks-the-work-on-a-task.md)
- [ADR 0052 - Tasks have a stage, and Threads join them](../adr/0052-tasks-have-a-stage-and-threads-join-them.md)
- [ADR 0055 - Facts move cards through editable workflows](../adr/0055-facts-move-cards-through-editable-workflows.md)
