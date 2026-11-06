# How a view plugs in (PROTOTYPE)

Every piece of data here is invented. `generate-data.mjs` writes `data.js`, `delivered.js` and `inbox.js` from a fixed seed: `node generate-data.mjs`.

`views/<id>.js` calls `Shell.register({ id, label, render(el, api) })`. `views/<id>.css` is loaded for it; scope every rule under one root class, e.g. `.v-list`.
`render` runs after every change: draw into `el`. Keep pan/zoom state in a variable of your file so a re-render does not lose it.

Any element with `data-id="<piece id>"` opens that piece's details on click, and `data-init="<initiative id>"` opens the initiative. For drag, call `e.preventDefault()` in the click that ends a drag.

Put `api.cls(w)` on the element that draws a piece. It carries the filter dimming, the Wear and Fog add-ons (CSS filters, so it works on HTML and SVG), and `think` or `quick`.

api: `pieces()` (all open pieces, oldest first) · `initiatives()` (each with `.pieces`) · `groups()` (`[{project, inits, loose}]`, where `loose` = pieces with no initiative) · `stages`, `moves`, `needs` (`[[value,label]]`) · `cls(w)` · `quiet(w)` (text) · `quietDays(w)` · `color(initId, lightness, saturation)` (each initiative's own colour) · `hue(initId)` · `progress(i)` and `bullet(i)` (HTML) · `esc(s)` · `load(key, default)` and `store(key, value)` (per-view, survives reload) · `rerender()`.

A piece: `id name project initiative what where left ask context[] options[] move need stage stalled whyStalled links[{label,url,state}] threads[{title,id}] kind source createdAt lastActivityAt confidence`.
- `stage`: exploring planned building reviewing landed. `need`: think quick look nothing. `move`: you agent others nobody.
- `kind`: review mention errors ticket pr thread other. `source`: thread signal pr task.
An initiative: `id name project intent target? progress? done? total?`. Most pieces have no initiative (`initiative === ''`), and that is the normal case, not an exception.

CSS variables: `--bg --panel --ink --mute --line --soft --hot --warm --off --s-exploring --s-planned --s-building --s-reviewing --s-landed`. They switch with the system's dark mode.

Also available: `api.hit(w)`, `api.open(id)`, `api.openInit(id)`.

`DELIVERED` (global, from delivered.js) is finished work from the last four weeks: `{id, kind:'pr'|'thread', name, project, initiative, start, end, days, url}`. For a PR, start is when it opened and end when it merged. For a thread, start is when it was created and end when it was marked Done. Neither is true conception: nothing links a thread to the PR it became yet.

Scope your helpers: a top-level `function render` overwrites the shell's own. Put your file in a block or use 'use strict'.

Each piece also has `topic` (a name; set on every piece with no initiative). `api.relations()` returns `[{from,to,kind}]`: `blockedBy` means `from` cannot finish until `to` does; `linked` is a weak relation that never shapes a hierarchy. `api.selected()` returns the id of the piece open in the drawer, or null.

Each piece also has `zone` (where in the code base it acts).

`INBOX` (global, from inbox.js) holds the external things that concern the reader, shaped per kind: `{reviews, mine, mentions, tickets, raised, intakeLeft, sentryTotal, sample}`.
- reviews: `{id, ref, title, url, author, waitingHours, rereview, approvedBy[], changesBy[], checks, hold, task}`. `hold` is why an example auto-pickup rule would not start it by itself; empty means it would start.
- mine (PRs the reader opened): `{id, ref, repo, title, url, ageDays, checks, approvedBy[], changesBy[], next, task}`. `next` is Fix the checks, Address requested changes, Ready to merge, or Waiting for a review.
- tickets: `{id, ref, title, team, project, milestone, state, priority, assignee, gist, ageDays, task}`.
- raised (a simulated triage result): `{id, title, why, initiative, project, issues[{ref,title,events,users,last,state}], events, users, last}`.
- mentions: `{id, ref, title, url, author, ageDays}`.
- sample (a made-up email thread, to show a kind with no real source): `{id, kind, title, from_, state, deadline, age, signals}`.
