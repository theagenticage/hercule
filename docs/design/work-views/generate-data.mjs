// Generates the invented world behind this prototype and writes data.js, delivered.js and inbox.js next to this file.
// Everything is made up: Northwind Market, its people, repositories, tickets and errors. This script reads no other file,
// and the fixed seed means every run writes the same output. Run it with: node generate-data.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEED = 20260611;
const TODAY = '2026-11-04';
const DAY_MS = 864e5, HOUR_MS = 36e5, MINUTE_MS = 6e4;

// Mulberry32: a small seeded random number generator, so that the output never changes between runs.
let seedState = SEED;
function random() {
  seedState = (seedState + 0x6d2b79f5) | 0;
  let t = Math.imul(seedState ^ (seedState >>> 15), 1 | seedState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = list => list[Math.floor(random() * list.length)];
const between = (low, high) => low + Math.floor(random() * (high - low + 1));
const hex = length => Array.from({ length }, () => Math.floor(random() * 16).toString(16)).join('');
function shuffle(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
const repeat = (value, count) => Array(count).fill(value);
const dayAgo = days => new Date(Date.parse(TODAY) - days * DAY_MS).toISOString().slice(0, 10);

const OWNER = 'Dana Reyes';
const PEOPLE = ['tessa-lindqvist', 'omar-haddad', 'juno-park', 'felix-marsh', 'ines-carvalho', 'theo-brandt', 'wren-adeyemi', 'kofi-mensah'];
const ORG = 'northwind';
const REPOS = { storefront:'storefront-web', platform:'platform-core', ops:'ops-console', 'field-app':'field-app', Insights:'insights-jobs' };
// The .example domain is reserved, so that no link in the prototype can ever reach a real site.
const buildPrUrl = (repo, number) => `https://github.example/${ORG}/${repo}/pull/${number}`;
const buildIssueUrl = (repo, number) => `https://github.example/${ORG}/${repo}/issues/${number}`;
const buildTicketUrl = ref => `https://tracker.example/northwind/issue/${ref}`;

const INITIATIVES = [
  { id:'scheduler', name:'Retire the old job scheduler', project:'platform', intent:'Move every timed job to the new job runner, so the old box can be switched off.', progress:'Job groups moved: 7 of 12', done:7, total:12 },
  { id:'flaky', name:'Calm the test suite', project:'platform', intent:'Make a red build mean something again.', progress:'Flaky tests fixed: 15 of 18', done:15, total:18 },
  { id:'priceengine', name:'One price engine', project:'storefront', intent:'Work out every price in one place, for the shop, the basket and the receipt.', progress:'Price rules moved: 11 of 16', done:11, total:16 },
  { id:'a11y', name:'Accessible checkout', project:'storefront', intent:'Let anyone finish an order with a keyboard or a screen reader.', target:'Every checkout step passes the audit', progress:'Audit findings closed: 18 of 22', done:18, total:22 },
  { id:'search', name:'Faster search on phones', project:'storefront', intent:'Show useful results quickly on the phones shoppers actually own.', target:'First results within one second on a mid-range phone' },
  { id:'returns', name:'Self-service returns at the depots', project:'ops', intent:'Let a shopper hand a crate back at a depot and get the refund the same day.', progress:'Depots live: 0 of 5', done:0, total:5 },
];

// The long-form pieces, one per line of thought. `why` is the reason a stalled piece may be lying around.
const THREADS = [
  { id:'sched-inventory', project:'platform', initiative:'scheduler', zone:'Job runner', stage:'planned', need:'quick', move:'you', stalled:true, name:'List every job on the old scheduler', what:'Find out which jobs still run on the old scheduler and who owns each one.', where:'Forty-one jobs found so far. Eleven have no clear owner, and three look unused since the summer.', left:'Name an owner for the last eleven jobs', ask:'Pick owners for the eleven orphan jobs, or say which can go.', why:'Owners are a people question, and nobody wants a job they did not write.' },
  { id:'sched-retries', project:'platform', initiative:'scheduler', zone:'Job runner', stage:'exploring', need:'think', move:'you', name:'Retry policy for moved jobs', what:'Agree how a moved job retries when a downstream service is down.', where:'Two drafts exist. One backs off for an hour, the other gives up after three tries and pages someone.', left:'Choose one draft and write it down', ask:'Choose between the two retry drafts.' },
  { id:'sched-cutover', project:'platform', initiative:'scheduler', zone:'Job runner', stage:'reviewing', need:'quick', move:'you', topic:'Upkeep', name:'Cut over the invoice export', what:'Move the first real job, the invoice export, to the new job runner.', where:'The move is in review as #3318. It ran clean on staging for five nights in a row.', left:'Approve the cutover and watch one live run', ask:'Approve the cutover for Monday night?' },
  { id:'sched-dashboards', project:'platform', initiative:'scheduler', zone:'Reports', stage:'planned', need:'quick', move:'you', stalled:true, name:'Dashboards for job lag', what:'Show how late each job runs, so a slow run is seen before finance notices.', where:'A rough board exists on staging. It has no alert yet and shows only the moved jobs.', left:'Add an alert and the remaining jobs', ask:'Say which lag should page someone.', why:'Waiting on the job list, which is itself stuck on owners.' },
  { id:'flake-quarantine', project:'platform', initiative:'flaky', zone:'Test rigs', stage:'reviewing', need:'quick', move:'you', topic:'Upkeep', name:'Quarantine list for flaky tests', what:'Move known flaky tests out of the blocking run until each one has an owner.', where:'Six small PRs are open, one per test. Blocking runs failed on 9% of attempts last week.', left:'Merge the six PRs', ask:'Merge the quarantine PRs together, or one at a time?' },
  { id:'flake-clock', project:'platform', initiative:'flaky', zone:'Test rigs', stage:'building', need:'look', move:'agent', name:'Tests that depend on the wall clock', what:'Replace real time in tests with a fake clock.', where:'An agent is working through the order tests. About half are done.', left:'The delivery and coupon tests', ask:'' },
  { id:'flake-seeds', project:'platform', initiative:'flaky', zone:'Test rigs', stage:'planned', need:'quick', move:'you', stalled:true, name:'Stable seed data for integration tests', what:'Give integration tests one fixed set of shoppers and products.', where:'The seed file is drafted but not wired in. Two suites still build their own records.', left:'Wire the seed file into both suites', ask:'Is one shared seed file fine, or one per suite?', why:'The two suites have different owners, and each one expects the other to move first.' },
  { id:'flake-parallel', project:'platform', initiative:'flaky', zone:'Test rigs', stage:'exploring', need:'think', move:'you', stalled:true, name:'Run the slow suite in shards', what:'Split the 38-minute suite over four machines.', where:'A trial brought it to eleven minutes, but shared fixtures collide. It needs the stable seed data first.', left:'Decide on the shard count once the seeds land', ask:'Is the extra runner cost worth 27 minutes per run?', why:'Blocked by the seed data, and the cost question has no owner.' },
  { id:'flake-report', project:'platform', initiative:'flaky', zone:'Reports', stage:'landed', need:'nothing', move:'nobody', name:'Weekly flake report', what:'Post the worst flaky tests to the team channel every Monday.', where:'Done. The report has posted for three weeks and the team reads it.', left:'Nothing', ask:'' },
  { id:'flake-browser', project:'platform', initiative:'flaky', zone:'Test rigs', stage:'planned', need:'quick', move:'you', name:'Browser tests that race the basket API', what:'Wait for the basket response instead of sleeping for two seconds.', where:'Twelve sleeps found in the browser tests. Four are replaced on a branch.', left:'Replace the last eight sleeps', ask:'Hand the last eight to an agent?' },
  { id:'cost-logs', project:'platform', topic:'Cost control', zone:'Gateway', stage:'exploring', need:'think', move:'you', stalled:true, name:'Trim log storage cost', what:'Cut what we pay to keep logs nobody reads.', where:'Debug logs from the gateway make up about 60% of the bill. Retention is 90 days for all of it.', left:'Pick retention per log type', ask:'How long must gateway logs stay?', why:'Nobody knows which logs the auditors expect.' },
  { id:'secrets-rotation', project:'platform', topic:'Secrets', zone:'Secrets', stage:'planned', need:'think', move:'you', stalled:true, name:'Rotate service tokens every quarter', what:'Stop long-lived tokens from staying in place for years.', where:'Fourteen tokens are older than a year. Rotating them by hand takes most of a day.', left:'Choose a rotation tool and a calendar', ask:'Buy a tool, or script it ourselves?', why:'A purchase needs a budget line, and that conversation has not started.' },
  { id:'oncall-runbook', project:'platform', topic:'On-call', zone:'Gateway', stage:'reviewing', need:'quick', move:'you', name:'Runbooks for the top ten alerts', what:'Give whoever is on call a short page for each noisy alert.', where:'Seven are written. The queue backlog one is in review as an open PR.', left:'Three more runbooks', ask:'Read the queue backlog runbook?' },
  { id:'dep-bumps', project:'platform', topic:'Upkeep', zone:'Shop front', stage:'landed', need:'nothing', move:'nobody', name:'Batch dependency bumps weekly', what:'Group small library upgrades into one PR a week.', where:'Landed. The weekly PR has merged twice without trouble.', left:'Nothing', ask:'' },
  { id:'staging-data', project:'platform', topic:'Staging data', zone:'Staging', stage:'exploring', need:'think', move:'you', stalled:true, name:'Staging data without customer records', what:'Refresh staging from production with every personal field replaced.', where:'The masking script covers orders and addresses, not support notes. Legal want a sign-off before it runs.', left:'Cover support notes and get the sign-off', ask:'Who signs off the masking rules?', why:'Sign-off sits with a person who has not been told yet.' },
  { id:'price-rounding', project:'storefront', initiative:'priceengine', zone:'Price engine', stage:'exploring', need:'think', move:'you', stalled:true, topic:'Money paths', name:'Rounding rules for multi-buy offers', what:'Decide how three-for-two rounds on weighed items.', where:'Shop and finance disagree by a penny on about 2% of baskets. Both sides have a written case.', left:'Pick one rule', ask:'Round per line or per basket?', why:'Either answer annoys one team, so it waits for a meeting that has no date.' },
  { id:'price-rules-tests', project:'storefront', initiative:'priceengine', zone:'Price engine', stage:'reviewing', need:'quick', move:'you', name:'Golden tests for price rules', what:"Pin today's prices for 500 sample baskets before anything moves.", where:'The sample baskets are in review. Eleven differ from the old engine and need a look.', left:'Explain the eleven differences', ask:'Are the eleven differences acceptable?' },
  { id:'cart-focus', project:'storefront', initiative:'a11y', zone:'Basket', stage:'reviewing', need:'quick', move:'you', name:'Keyboard focus in the basket drawer', what:'Keep focus inside the drawer and return it when the drawer closes.', where:'The fix is in review. It works with two screen readers and still needs a check on phones.', left:'A phone check', ask:'Test it on a phone, or ship and watch?' },
  { id:'contrast-audit', project:'storefront', initiative:'a11y', zone:'Shop front', stage:'landed', need:'look', move:'you', topic:'Clean-up', name:'Contrast audit for sale badges', what:'Check every sale badge against the contrast rules.', where:'Done. All nine badge colours pass after the new palette.', left:'Nothing', ask:'Anything else to check before this closes?' },
  { id:'search-synonyms', project:'storefront', initiative:'search', zone:'Search', stage:'planned', need:'quick', move:'you', stalled:true, topic:'Speed', name:'Synonyms for everyday products', what:'Make "fizzy drink" find soda and "nappies" find diapers.', where:'A first list of 200 pairs is ready. The search team wants a way to edit it without a release.', left:'An editing screen for the list', ask:'Is a spreadsheet import good enough for now?', why:'Nobody has said who keeps the list up to date.' },
  { id:'search-latency', project:'storefront', initiative:'search', zone:'Search', stage:'exploring', need:'think', move:'you', topic:'Speed', name:'Search latency on slow phones', what:'Find out why search takes over three seconds on older phones.', where:'Most of the time goes on the first result image, not on the query. Two fixes look possible.', left:'Choose a fix and measure it', ask:'Drop images from the first paint, or shrink them?' },
  { id:'coupons-stack', project:'storefront', topic:'Coupons and points', zone:'Promotions', stage:'exploring', need:'think', move:'you', stalled:true, name:'Can coupons stack with loyalty points?', what:'Settle whether a shopper can use both on one order.', where:'Marketing says yes, finance says only above a minimum spend. The code allows it today by accident.', left:'One answer from marketing and finance', ask:'Bring both sides to one answer?', why:'The accident works in shoppers\' favour, so nobody is in a hurry.' },
  { id:'substitutions', project:'storefront', topic:'Substitutions', zone:'Delivery', stage:'planned', need:'think', move:'you', stalled:true, name:'Substitutions when an item runs out', what:'Let shoppers accept or refuse a swap before the driver leaves.', where:'Three designs sketched. Depot staff worry about the extra time at packing.', left:'Pick a design and try it at one depot', ask:'Which depot should try it first?', why:'The depots were never asked, and each design changes their packing line.' },
  { id:'slot-rush', project:'storefront', topic:'Delivery slots', zone:'Delivery', stage:'reviewing', need:'quick', move:'you', name:'Delivery slot page feels slow at noon', what:'Find why the slot page crawls during the lunchtime rush.', where:'A cache is in review. Slot lookups were 70% of the database load at peak.', left:'Merge the cache and compare next Tuesday', ask:'Is five minutes of stale slots acceptable?' },
  { id:'image-sizes', project:'storefront', topic:'Product photos', zone:'Product photos', stage:'building', need:'quick', move:'you', stalled:true, name:'Serve smaller product photos', what:'Send each device a photo of the right size.', where:'Started, then paused. The resizing service handles about half the range so far.', left:'Move the remaining photos', ask:'Keep the originals, or drop them after a month?' },
  { id:'guest-checkout', project:'storefront', topic:'Guest shoppers', zone:'Accounts', stage:'planned', need:'quick', move:'you', stalled:true, name:'Guest checkout without an account', what:'Let a first-time shopper pay without creating an account.', where:'Product wants it for the spring sale. Order history and returns need a plan for guests.', left:'A plan for returns by guests', ask:'Is an email link enough for guest returns?', why:'It waits on the basket merge question.' },
  { id:'gift-receipt', project:'storefront', topic:'Money paths', zone:'Checkout', stage:'landed', need:'nothing', move:'nobody', name:'Gift card balance on the receipt', what:'Print the remaining balance on the email receipt.', where:'Landed. Support contacts on this topic have stopped.', left:'Nothing', ask:'' },
  { id:'basket-restore', project:'storefront', topic:'Guest shoppers', zone:'Basket', stage:'reviewing', need:'quick', move:'you', name:'Restore a basket after sign-in', what:'Merge a guest basket into the account basket on sign-in.', where:'One question is left on the PR: which quantity wins when both baskets hold an item.', left:'Answer the quantity question', ask:'Highest quantity, or add them together?' },
  { id:'depot-labels', project:'ops', initiative:'returns', topic:'Depot returns', zone:'Depot tools', stage:'planned', need:'look', move:'you', stalled:true, name:'Return labels at the depot', what:'Let depot staff print a label for a return made in person.', where:'Label printers are in two of five depots. The vendor quote is in the shared folder.', left:'Look at the vendor quote', ask:'Look over the printer quote.', why:'The quote expired and nobody asked for a new one.' },
  { id:'offline-proof', project:'field-app', topic:'Driver tools', zone:'Driver app', stage:'exploring', need:'think', move:'you', stalled:true, name:'Proof of delivery while offline', what:'Keep photos and signatures on the phone until the signal comes back.', where:'Drivers lose about one proof in forty on rural routes. Storage on old phones is the open risk.', left:'Decide how long the phone keeps a proof', ask:'How many days should a phone keep proofs?', why:'Needs a look at the phones drivers really carry.' },
  { id:'route-order', project:'field-app', topic:'Driver tools', zone:'Driver app', stage:'landed', need:'nothing', move:'you', name:'Drivers reorder their own stops', what:'Let a driver change the stop order when a road is closed.', where:'Landed in the last app release. Drivers used it on 6% of routes in its first week.', left:'Nothing', ask:'Can this thread be closed?' },
];

const CONTEXT_LINES = [
  'Support logged {n} contacts about this in the last month',
  'The team would rather ship a small version first and learn from it',
  'Nothing here blocks the spring sale, but it gets harder to change afterwards',
  'An agent read the code and found {n} places that would have to change',
  'The last attempt stopped when its owner moved teams',
  'Finance asked for a written rule before anything ships',
  'The product team says a rival shop already does this',
  'I could not confirm the numbers: they come from a single week',
  'The depot managers have not been asked yet',
  'The change is small in code and large in what people must relearn',
  'Legal only needs a note if personal data moves',
  'About {n}% of shoppers would notice, mostly on phones',
  'There is a cheap version that covers most cases',
  'Two earlier threads reached this same question and stopped there',
  'A vendor sells this, at a price nobody has checked',
  'It would take roughly {n} days of agent time, plus review',
  'The numbers look better on weekdays, so a weekend trial may mislead',
  'Whoever picks this up will need access to the staging tools',
  'One of the two approaches needs a database change, the other does not',
  'I found no owner for this in the team list',
];
const OPTIONS = ['Ship the small version first', 'Wait until after the spring sale', 'Raise it at the Thursday planning call', 'Drop it for now', 'Try it at one depot', 'Let an agent try it', 'Write the rule down first', 'Get a quote', 'Time-box it to one week'];
const THREAD_PREFIXES = ['Notes on', 'Second look at', 'Options for', 'Follow-up on'];
const lowerFirst = text => text[0].toLowerCase() + text.slice(1);

// Pull requests waiting for a review, oldest first: number, title, author, hours waiting, back for a re-review, approved by, changes by, checks, hold, Topic, Zone.
const ON_MONEY = 'Moves money: a person should look first';
const CHECKS_RED = 'Red checks come first';
const REVIEWS = [
  [6204, 'Cache delivery slot lookups for five minutes', 'juno-park', 131.4, false, [], [], 'success', '', 'Delivery slots', 'Delivery'],
  [6209, 'Split the basket summary into smaller components', 'felix-marsh', 129.2, false, [], [], 'success', '', 'Clean-up', 'Basket'],
  [6213, 'Show unit prices on multi-buy offers', 'felix-marsh', 118.7, true, [], ['omar-haddad'], 'success', ON_MONEY, 'Money paths', 'Shop front'],
  [6238, 'Retry card payments once on a gateway timeout', 'ines-carvalho', 31.5, false, [], [], 'failure', CHECKS_RED, 'Money paths', 'Checkout'],
  [6241, 'Drop the unused wishlist endpoints', 'theo-brandt', 26.1, false, [], [], 'success', '', 'Clean-up', 'Accounts'],
  [6252, 'Move promo banner copy into the content tool', 'wren-adeyemi', 10.3, true, [], [], 'success', '', 'Clean-up', 'Promotions'],
  [6255, 'Add a loading state to the address finder', 'juno-park', 9.2, false, ['theo-brandt'], [], 'success', 'Has an approval from theo-brandt', 'Speed', 'Checkout'],
  [6257, 'Round loyalty points down at checkout', 'kofi-mensah', 8.4, true, [], [], 'failure', CHECKS_RED, 'Coupons and points', 'Promotions'],
  [6258, 'Stop sending duplicate order emails', 'tessa-lindqvist', 6.8, false, [], [], 'success', '', 'Clean-up', 'Checkout'],
  [6260, 'Log the reason when a coupon is refused', 'ines-carvalho', 6.2, false, [], [], 'failure', CHECKS_RED, 'Coupons and points', 'Promotions'],
  [6263, 'Refund delivery on a fully returned order', 'kofi-mensah', 4.1, true, [], [], 'success', ON_MONEY, 'Money paths', 'Checkout'],
  [6266, 'Remove the old store credit page', 'wren-adeyemi', 1.6, false, [], [], 'success', ON_MONEY, 'Clean-up', 'Accounts'],
];

// The reader's own pull requests with a piece of their own: id, project, initiative, Topic, Zone, number, title, need, move, age, checks, next step, approved by, changes by, stalled.
const FIX_CHECKS = 'Fix the checks', WAITING = 'Waiting for a review', READY = 'Ready to merge', ADDRESS = 'Address requested changes';
const OWN_PRS = [
  ['pr-multibuy', 'storefront', 'priceengine', '', 'Price engine', 6118, 'Move multi-buy rules into the price engine', 'quick', 'you', 19.6, 'failure', FIX_CHECKS, [], [], true],
  ['pr-weighed', 'storefront', 'priceengine', '', 'Price engine', 6147, 'Price engine: handle weighed items', 'look', 'others', 13.2, 'success', WAITING, [], [], false],
  ['pr-breakdown', 'storefront', 'priceengine', '', 'Basket', 6171, 'Show the price breakdown in the basket', 'look', 'others', 8.4, 'unknown', WAITING, [], [], false],
  ['pr-qty-labels', 'storefront', 'a11y', 'Clean-up', 'Basket', 6189, 'Label the quantity buttons for screen readers', 'quick', 'you', 5.7, 'success', READY, ['ines-carvalho'], [], false],
  ['pr-lazy-photos', 'storefront', '', 'Product photos', 'Product photos', 6135, 'Lazy-load photos below the fold', 'look', 'others', 15.3, 'unknown', WAITING, [], [], true],
  ['pr-font', 'storefront', '', 'Speed', 'Shop front', 6162, 'Preload the checkout font', 'look', 'others', 9.8, 'success', WAITING, [], [], false],
  ['pr-address-form', 'storefront', '', 'Speed', 'Checkout', 6195, 'Shorten the address form', 'quick', 'you', 5.2, 'success', ADDRESS, [], ['felix-marsh'], false],
  ['pr-report-runner', 'platform', 'scheduler', '', 'Job runner', 3318, 'Run the invoice export on the new job runner', 'quick', 'you', 6.1, 'failure', FIX_CHECKS, [], [], false],
  ['pr-fake-clock', 'platform', 'flaky', 'Upkeep', 'Test rigs', 3331, 'Freeze time in the order expiry tests', 'look', 'others', 2.3, 'unknown', WAITING, [], [], false],
  ['pr-gateway-debug', 'platform', '', 'Cost control', 'Gateway', 3299, 'Drop debug logging from the gateway', 'quick', 'you', 12.4, 'failure', FIX_CHECKS, [], [], true],
  ['pr-rollup', 'Insights', '', 'Reporting', 'Reports', 1487, 'Nightly basket size rollup', 'look', 'others', 1.4, 'success', WAITING, ['tessa-lindqvist'], [], false],
];
// Further pull requests of the reader's that sit on an existing piece. Six on one piece make the shared-Task pile in the Inbox.
const SHARED_PRS = [
  [3337, 'Quarantine the flaky order expiry test', 'flake-quarantine', 8.1, 'success'],
  [3338, 'Quarantine the flaky slot booking test', 'flake-quarantine', 8.0, 'unknown'],
  [3339, 'Quarantine the flaky coupon refusal test', 'flake-quarantine', 6.3, 'unknown'],
  [3340, 'Quarantine the flaky address lookup test', 'flake-quarantine', 6.2, 'success'],
  [3341, 'Quarantine the flaky refund webhook test', 'flake-quarantine', 6.1, 'unknown'],
  [3342, 'Quarantine the flaky search paging test', 'flake-quarantine', 1.2, 'unknown'],
  [3326, 'Add a runbook for queue backlog alerts', 'oncall-runbook', 10.2, 'success'],
];

const MENTIONS = [
  { number:6088, title:'Agree a naming rule for feature flags', author:'omar-haddad', ageDays:11.6, stage:'reviewing', need:'look', move:'you', topic:'Clean-up', zone:'Shop front', open:true },
  { number:6126, title:'Move the order schema to the shared package', author:'tessa-lindqvist', ageDays:4.4, stage:'reviewing', need:'look', move:'you', topic:'Clean-up', zone:'Checkout', open:true },
  { number:6079, title:'Reword the cookie banner', author:'wren-adeyemi', ageDays:17.2, stage:'landed', need:'nothing', move:'nobody', topic:'Clean-up', zone:'Shop front', open:false },
];

// Tickets. Those with a `piece` block get a piece of their own. The rest only sit in the Inbox, on the Task named by `task`, or on none.
const TICKETS = [
  { ref:'OPS-41', title:'Scan a returned crate at the depot door', team:'Depot', project:'Returns', milestone:'', state:'Triage', priority:'No priority', gist:'Staff need a quick scan that tells the system a crate is back, so the refund can begin without anyone typing an order number', ageDays:18.4, piece:{ id:'t-crate-scan', initiative:'returns', zone:'Depot tools', stage:'planned', need:'think', move:'you', stalled:true, source:'task' } },
  { ref:'OPS-44', title:'Print a return label without a print queue', team:'Depot', project:'Returns', milestone:'', state:'Triage', priority:'No priority', gist:'- Team: Depot\n- Area: labels\n- Raised by: depot lead', ageDays:16.9, piece:{ id:'t-label-queue', initiative:'returns', zone:'Depot tools', stage:'planned', need:'nothing', move:'nobody', stalled:true, source:'task' } },
  { ref:'OPS-47', title:'Start the refund when the depot confirms', team:'Depot', project:'Returns', milestone:'Spring sale', state:'Triage', priority:'No priority', gist:'### What this needs\nA single event from the depot tool that the refund service can trust, including the crate count.', ageDays:11.1, piece:{ id:'t-depot-refund', initiative:'returns', zone:'Depot tools', stage:'planned', need:'nothing', move:'nobody', stalled:true, source:'task' } },
  { ref:'OPS-52', title:'Show depot staff why an item came back', team:'Depot', project:'', milestone:'Spring sale', state:'Todo', priority:'No priority', gist:'**Context** Staff sort returns by reason, and today they ask the shopper at the counter.', ageDays:9.3, piece:{ id:'t-return-reason', initiative:'returns', zone:'Depot tools', stage:'exploring', need:'nothing', move:'nobody', source:'signal' } },
  { ref:'PLAT-118', title:'Agree a retry rule for browser tests', team:'Platform', project:'', milestone:'', state:'Triage', priority:'Medium', gist:'A retried browser test can hide a real race, so the rule should say how many retries are allowed and what gets reported afterwards.', ageDays:6.2, piece:{ id:'t-browser-retry', initiative:'flaky', project:'platform', zone:'Test rigs', stage:'planned', need:'quick', move:'you', source:'signal' } },
  { ref:'SHOP-318', title:'Basket drawer traps focus in one browser', team:'Shop', project:'', milestone:'', state:'In Progress', priority:'No priority', gist:'The drawer works everywhere except one mobile browser, where the close button can no longer be reached with a keyboard', ageDays:5.5, piece:{ id:'t-focus-trap', initiative:'a11y', project:'storefront', zone:'Basket', stage:'planned', need:'quick', move:'you', source:'task' } },
  { ref:'SHOP-342', title:'Typo tolerance for short search words', team:'Shop', project:'', milestone:'', state:'Todo', priority:'No priority', gist:'Words under four letters get no typo correction, so a small slip returns an empty page.', ageDays:4.8, piece:{ id:'t-typos', initiative:'search', project:'storefront', topic:'Speed', zone:'Search', stage:'exploring', need:'think', move:'you', source:'task' } },
  { ref:'SHOP-355', title:'Order history hides cancelled items', team:'Shop', project:'', milestone:'', state:'Triage', priority:'No priority', gist:'Shoppers contact support to ask where an item went, because a cancelled line vanishes from the order page.', ageDays:2.6, piece:{ id:'t-cancelled', project:'storefront', topic:'Clean-up', zone:'Accounts', stage:'planned', need:'nothing', move:'nobody', source:'signal' } },
  { ref:'SHOP-360', title:'Slot picker jumps when a slot sells out', team:'Shop', project:'', milestone:'', state:'Triage', priority:'No priority', gist:'## What happens\nThe list reflows under the pointer, and a shopper can book the slot below the one they aimed at.', ageDays:2.3, task:'slot-rush' },
  { ref:'SHOP-361', title:'Brand filter is empty for own-label goods', team:'Shop', project:'', milestone:'', state:'Triage', priority:'No priority', gist:'Own-label products have no brand set, so the filter shows nothing and the search feed complains', ageDays:2.1, task:'search-latency' },
  { ref:'SHOP-364', title:'Coupon box accepts spaces and then fails', team:'Shop', project:'', milestone:'', state:'Triage', priority:'No priority', gist:'A pasted code with a trailing space is refused without saying why.', ageDays:1.9, task:'coupons-stack' },
  { ref:'SHOP-366', title:'Decide the default photo for bundles', team:'Shop', project:'', milestone:'', state:'Triage', priority:'No priority', gist:'Bundles show the first item only, which reads as a mistake on the listing.', ageDays:1.8, task:'image-sizes' },
  { ref:'PLAT-124', title:'Document the staging refresh steps', team:'Platform', project:'', milestone:'', state:'Todo', priority:'No priority', gist:'Only one person knows the order of the steps.', ageDays:1.2, task:'' },
  { ref:'OPS-58', title:'Add depot opening hours to the returns page', team:'Depot', project:'Returns', milestone:'', state:'Triage', priority:'No priority', gist:'Shoppers arrive to a closed depot with a crate in the car.', ageDays:0.8, task:'' },
];

const OTHERS = [
  { id:'renew-cert', project:'storefront', topic:'Money paths', zone:'Checkout', stage:'building', need:'nothing', move:'nobody', source:'task', name:'Renew the payment gateway certificate', what:'The gateway certificate runs out in six weeks.', where:'The request is with the vendor. Nothing to do until the file arrives.', left:'Install the new certificate', ask:'', link:{ label:'Issue #6271', url:buildIssueUrl(REPOS.storefront, 6271), state:'open' } },
  { id:'load-test', project:'platform', initiative:'scheduler', zone:'Staging', stage:'planned', need:'quick', move:'you', source:'task', name:'Book a load test for the spring sale', what:'Reserve a window to rehearse sale traffic on staging.', where:'Two dates are free. The job runner move should be finished by then.', left:'Pick a date', ask:'Take the first free date?', link:null },
  { id:'old-exports', project:'Insights', topic:'Reporting', zone:'Reports', stage:'exploring', need:'think', move:'you', source:'signal', name:'What to do with the old report exports', what:'Three teams still download a file nobody maintains.', where:'The export breaks about once a month. A replacement would take a week.', left:'Keep it, replace it, or switch it off', ask:'Ask the three teams what they use it for?', link:null },
];

const ERROR_PIECE = { id:'search-feed-errors', project:'storefront', initiative:'search', zone:'Search', stage:'exploring', need:'think', move:'you', name:'Search feed errors after the brand change', what:'The search index feed started dropping products with no brand.', where:'Sentry shows the error back on every feed run since the brand field became required.', left:'Find the bad records and decide on a default', ask:'Fix the records, or relax the rule?', options:['Fix the records at the source', 'Relax the rule for own-label goods', 'Skip them and report the count'] };

// Issues that a simulated triage raised, each cluster with its Sentry issues.
const CLUSTERS = [
  { id:'c-coupons', title:'Coupon codes refused after the last release', why:'Marked fixed two weeks ago and started again on Monday, in the step that applies a coupon to a basket.', initiative:'', project:'checkout-api', issues:[['CHECKOUT-API-3H1', 'CouponRuleError: rule set missing for market "default"', 212, 19, 0, 'came back']] },
  { id:'c-search', title:'Search feed drops products with no brand', why:'The loudest error in the shop right now. It came back when the brand field became required, and every feed run hits it.', initiative:'search', project:'search-api', issues:[['SEARCH-API-1Z4', 'FeedRecordError: product 7741 has no brand to fill a required column', 1480, 73, 1, 'came back']] },
  { id:'c-photos', title:'Photo carousel crashes on old tablets', why:'Seven errors with one cause: the carousel assumes a browser feature that old tablets lack. One shopper hit most of them.', initiative:'', project:'storefront-web', issues:[
    ['STOREFRONT-WEB-2K9', 'TypeError: slideWatcher.observe is not a function', 38, 1, 2, ''],
    ['STOREFRONT-WEB-2KA', 'TypeError: carousel.next is not a function', 21, 1, 3, ''],
    ['STOREFRONT-WEB-2KF', 'ReferenceError: ResizeWatcher is not defined', 14, 1, 3, ''],
    ['STOREFRONT-WEB-2KG', 'TypeError: photo.decode is not a function', 11, 1, 5, ''],
    ['STOREFRONT-WEB-2L1', 'RangeError: invalid slide index -1', 6, 1, 6, ''],
    ['STOREFRONT-WEB-2L4', 'TypeError: null is not an object (evaluating slide.width)', 4, 1, 8, ''],
    ['STOREFRONT-WEB-2L9', 'Error: carousel mounted twice', 2, 1, 9, ''],
  ] },
  { id:'c-slots', title:'Delivery slots double-booked at one depot', why:'Few shoppers so far, but the count doubled this week and every case means a missed delivery.', initiative:'', project:'delivery-api', issues:[['DELIVERY-API-7Q2', 'SlotConflictError: slot 19:00 already held by another order', 14, 3, 4, 'escalating']] },
];

/** Returns a whole piece, with every field in the order the views' contract lists them. */
function buildPiece(fields) {
  return {
    id:fields.id, name:fields.name, project:fields.project, what:fields.what, where:fields.where, left:fields.left, ask:fields.ask ?? '',
    context:fields.context ?? [], options:fields.options ?? [], move:fields.move, need:fields.need, stage:fields.stage,
    stalled:!!fields.stalled, whyStalled:fields.why ?? '', links:fields.links ?? [], threads:fields.threads ?? [], confidence:fields.confidence,
    createdAt:fields.createdAt, lastActivityAt:fields.lastActivityAt, initiative:fields.initiative ?? '', kind:fields.kind, source:fields.source,
    topic:fields.topic ?? '', zone:fields.zone,
  };
}

/** Returns a created and a last-activity day: a stalled piece has been quiet for a long time, and any other piece was touched recently. */
function pickDates(stalled) {
  const quiet = stalled ? between(8, 30) : between(0, 6);
  return { createdAt:dayAgo(Math.min(34, quiet + between(0, 12))), lastActivityAt:dayAgo(quiet) };
}

const nextIssueNumber = (() => { let number = 3604; return () => (number += between(1, 9)); })();
const nextTicketNumber = (() => { let number = 120; return () => (number += between(1, 7)); })();

/** Returns one invented link for a thread, of a kind picked at random. */
function buildThreadLink(project) {
  const repo = REPOS[project], number = nextIssueNumber(), ref = `${project === 'storefront' ? 'SHOP' : project === 'ops' ? 'OPS' : 'PLAT'}-${nextTicketNumber()}`;
  return pick([
    () => ({ label:`PR #${number} ${pick(['Small fix', 'First slice', 'Clean-up', 'Spike', 'Draft'])}`, url:buildPrUrl(repo, number), state:pick(['open', 'open', 'merged', 'merged', 'closed']) }),
    () => ({ label:`Issue #${number}`, url:buildIssueUrl(repo, number), state:pick(['open', 'open', 'open', 'closed', 'unknown']) }),
    () => ({ label:ref, url:buildTicketUrl(ref), state:pick(['Todo', 'Triage']) }),
    () => ({ label:`Sentry ${project.toUpperCase()}-${hex(3).toUpperCase()}`, url:'', state:'in Intake' }),
    () => ({ label:`Issue #${number}`, url:buildIssueUrl(repo, number), state:'open' }),
  ])();
}

function buildThreadPieces() {
  // A landed thread needs no options or notes, so the zero counts go to those first.
  const landedFirst = [...THREADS].sort((a, b) => (b.stage === 'landed') - (a.stage === 'landed'));
  const contextCounts = [...repeat(0, 8), ...shuffle([2, ...repeat(3, 22)])];
  const optionCounts = [...repeat(0, 12), ...shuffle([...repeat(2, 7), ...repeat(3, 12)])];
  const linkCounts = shuffle([...repeat(0, 12), 1, ...repeat(2, 6), ...repeat(3, 5), ...repeat(4, 4), 6, 6, 9]);
  const threadCounts = shuffle([...repeat(1, 22), ...repeat(2, 7), 3, 4]);
  const confidences = shuffle([...repeat('high', 2), ...repeat('medium', 20), ...repeat('low', 9)]);
  return landedFirst.map((row, n) => buildPiece({
    ...row, kind:'thread', source:'thread', confidence:confidences[n], ...pickDates(row.stalled),
    context:shuffle(CONTEXT_LINES).slice(0, contextCounts[n]).map(line => line.replace('{n}', between(3, 40))),
    options:shuffle(OPTIONS).slice(0, optionCounts[n]),
    links:Array.from({ length:linkCounts[n] }, () => buildThreadLink(row.project)),
    threads:Array.from({ length:threadCounts[n] }, (_, at) => ({ title:at ? `${pick(THREAD_PREFIXES)} ${lowerFirst(row.name)}` : row.name, id:hex(8) })),
  }));
}

function buildReviews() {
  const pieces = [], cards = [];
  for (const [number, title, author, hours, rereview, approvedBy, changesBy, checks, hold, topic, zone] of REVIEWS) {
    const id = `rv-${number}`, day = dayAgo(Math.round(hours / 24)), url = buildPrUrl(REPOS.storefront, number), stalled = hours > 100;
    pieces.push(buildPiece({
      id, name:title, project:'storefront', what:'A pull request is waiting for your review.', where:`Review requested by ${author} on ${day}. Nobody has picked it up.`, left:'A review',
      ask:'Hand it to the review workflow?', options:['Hand it to the review workflow', 'Read it yourself'], move:'you', need:'quick', stage:'reviewing', stalled,
      why:stalled ? 'It looks long, and each visit ends before the end of the diff.' : '', links:[{ label:`PR #${number}`, url, state:'open' }], confidence:'high',
      createdAt:day, lastActivityAt:day, kind:'review', source:'signal', topic, zone,
    }));
    const earlier = rereview ? [{ label:'Review requested', at:dayAgo(Math.round(hours / 24) + 3), open:false, outcome:'Handed to Agent review' }] : [];
    cards.push({ id, ref:`#${number}`, title, url, author, waitingHours:hours, rereview, approvedBy, changesBy, checks, hold, task:'', signals:[...earlier, { label:'Review requested', at:day, open:true, outcome:'' }] });
  }
  return { pieces, cards };
}

/** Returns the signals on one of the reader's pull requests: failed checks when they failed, and some older failures that were dealt with. */
function buildOwnSignals(checks, ageDays, n) {
  if (checks === 'failure') return [{ label:'Checks failed', at:dayAgo(Math.floor(ageDays / 2)), open:true, outcome:'' }];
  return n % 6 === 0 ? [{ label:'Checks failed', at:dayAgo(Math.floor(ageDays)), open:false, outcome:'Closed, no action' }] : [];
}

function buildOwnPullRequests() {
  const pieces = [], cards = [];
  OWN_PRS.forEach(([id, project, initiative, topic, zone, number, title, need, move, ageDays, checks, next, approvedBy, changesBy, stalled], n) => {
    const repo = REPOS[project], url = buildPrUrl(repo, number), opened = dayAgo(Math.round(ageDays));
    pieces.push(buildPiece({
      id, name:title, project, what:`${title}.`, where:`PR #${number} open since ${opened}. ${next}.`, left:next === READY ? 'Press merge' : 'Get it reviewed, then merge', ask:move === 'you' ? `${next} on #${number}?` : '',
      options:n < 2 ? ['Merge as it is', 'Split it first'] : [], move, need, stage:'reviewing', stalled, why:stalled ? 'No one was asked directly, so it waits for a volunteer.' : '',
      links:[{ label:`PR #${number}`, url, state:'open' }], confidence:'high', createdAt:opened, lastActivityAt:dayAgo(stalled ? between(8, 12) : between(0, 3)), initiative, kind:'pr', source:'pr', topic, zone,
    }));
    cards.push({ id:`my-${number}`, ref:`${repo}#${number}`, repo, title, url, ageDays, checks, approvedBy, changesBy, next, task:id, signals:buildOwnSignals(checks, ageDays, n) });
  });
  SHARED_PRS.forEach(([number, title, task, ageDays, checks], n) => {
    const repo = REPOS.platform;
    cards.push({ id:`my-${number}`, ref:`${repo}#${number}`, repo, title, url:buildPrUrl(repo, number), ageDays, checks, approvedBy:[], changesBy:[], next:WAITING, task, signals:buildOwnSignals(checks, ageDays, n + 1) });
  });
  return { pieces, cards };
}

function buildMentions() {
  const pieces = [], cards = [];
  for (const { number, title, author, ageDays, stage, need, move, topic, zone, open } of MENTIONS) {
    const id = `mn-${number}`, day = dayAgo(Math.round(ageDays)), url = buildPrUrl(REPOS.storefront, number);
    pieces.push(buildPiece({
      id, name:title, project:'storefront', what:'Someone tagged you on this PR.', where:`You were tagged on ${day}. ${open ? 'The PR has not merged.' : 'The PR has merged since.'}`, left:open ? 'Read the comment' : 'Nothing', ask:open ? 'Read the comment. Does it need you?' : '',
      move, need, stage, links:[{ label:`PR #${number}`, url, state:open ? 'open' : 'merged' }], confidence:'high', createdAt:day, lastActivityAt:day, kind:'mention', source:'signal', topic, zone,
    }));
    if (open) cards.push({ id, ref:`#${number}`, title, url, author, ageDays, signals:[{ label:'Review requested', at:dayAgo(Math.round(ageDays) + 2), open:false, outcome:'Handed to Agent review' }, { label:'You were mentioned', at:day, open:true, outcome:'' }] });
  }
  return { pieces, cards };
}

function buildTickets() {
  const pieces = [], cards = [];
  TICKETS.forEach((ticket, n) => {
    const { piece, ref, title, ageDays, gist } = ticket, day = dayAgo(Math.round(ageDays));
    if (piece) {
      pieces.push(buildPiece({
        ...piece, project:piece.project ?? 'ops', topic:piece.topic ?? (piece.initiative ? '' : 'Clean-up'), name:title, what:`${title} (${ref}).`, where:`On your list since ${day}. No work has started.`, left:'Everything',
        ask:piece.move === 'you' ? 'Let an agent take it as written, or tighten it first?' : '', options:n === 0 || n === 6 ? ['Let an agent take it', 'Tighten it first'] : [],
        why:piece.stalled && n < 2 ? 'It has no answer yet on what the depot tool can send.' : '', links:[{ label:ref, url:buildTicketUrl(ref), state:ticket.state === 'Todo' ? 'Todo' : 'Triage' }],
        confidence:'medium', createdAt:day, lastActivityAt:dayAgo(piece.stalled ? between(9, 16) : between(0, 3)), kind:'ticket',
      }));
    }
    const signals = n % 5 === 0 ? [{ label:'Added to your issues', at:day, open:true, outcome:'' }, { label:'Assigned to you', at:day, open:true, outcome:'' }] : [{ label:'Added to your issues', at:day, open:n % 3 !== 0, outcome:'' }];
    cards.push({ id:`li-${ref}`, ref, title, team:ticket.team, project:ticket.project, milestone:ticket.milestone, state:ticket.state, priority:ticket.priority, assignee:OWNER, gist, ageDays, task:piece ? piece.id : ticket.task, signals });
  });
  return { pieces, cards };
}

function buildClusters() {
  return CLUSTERS.map(({ id, title, why, initiative, project, issues }) => {
    const rows = issues.map(([ref, issueTitle, events, users, daysAgo, state]) => ({ ref, title:issueTitle, events, users, last:dayAgo(daysAgo), state }));
    return { id, title, why, initiative, project, issues:rows, events:rows.reduce((sum, row) => sum + row.events, 0), users:Math.max(...rows.map(row => row.users)), last:rows.map(row => row.last).sort().at(-1) };
  });
}

const RELATIONS = [
  { from:'sched-cutover', to:'sched-retries', kind:'blockedBy' },
  { from:'t-depot-refund', to:'t-crate-scan', kind:'blockedBy' },
  { from:'t-return-reason', to:'t-crate-scan', kind:'blockedBy' },
  { from:'pr-breakdown', to:'pr-weighed', kind:'blockedBy' },
  { from:'pr-weighed', to:'price-rounding', kind:'blockedBy' },
  { from:'flake-parallel', to:'flake-seeds', kind:'blockedBy' },
  { from:'cart-focus', to:'contrast-audit', kind:'linked' },
  { from:'search-latency', to:'image-sizes', kind:'linked' },
  { from:'search-synonyms', to:'search-feed-errors', kind:'linked' },
  { from:'slot-rush', to:'rv-6204', kind:'linked' },
  { from:'substitutions', to:'route-order', kind:'linked' },
  { from:'offline-proof', to:'image-sizes', kind:'linked' },
  { from:'flake-browser', to:'basket-restore', kind:'linked' },
  { from:'cost-logs', to:'pr-gateway-debug', kind:'linked' },
  { from:'staging-data', to:'load-test', kind:'linked' },
  { from:'old-exports', to:'sched-dashboards', kind:'linked' },
  { from:'guest-checkout', to:'basket-restore', kind:'blockedBy', sample:true },
  { from:'coupons-stack', to:'rv-6257', kind:'blockedBy', sample:true },
];

const THREAD_VERBS = ['Look into', 'Plan', 'Review', 'Sketch a fix for', 'Compare options for', 'Write up', 'Measure', 'Tidy', 'Question', 'Walk through', 'Check', 'Rethink', 'Draft notes on', 'Agree on'];
const PR_VERBS = ['Add', 'Fix', 'Remove', 'Simplify', 'Speed up', 'Rename', 'Rework', 'Cover', 'Harden', 'Document', 'Bump', 'Split up'];
const QUALIFIERS = ['before the spring sale', 'on staging', 'at peak hours', 'after the last release', 'for new starters', 'in the nightly run', 'on older phones', 'across all depots', 'for the finance team', 'during the freeze', 'with the on-call team', 'for next quarter'];
const SUBJECTS = {
  platform:['queue depth alerts', 'retry storms after a deploy', 'the staging refresh', 'token rotation', 'the gateway timeout budget', 'log retention per service', 'job runner health checks', 'database failover drills', 'the release checklist', 'feature flag clean-up', 'the on-call rota', 'cache eviction rules', 'shared client retries', 'rate limits on the public API', 'container base images', 'build cache misses', 'test shard balance', 'disk alerts on the worker pool', 'the secrets audit', 'API version sunset', 'webhook delivery retries', 'schema change reviews', 'backup restore timing', 'the service ownership list', 'dead letter queue handling', 'load test scenarios', 'tracing for slow requests', 'error budget reporting', 'image registry clean-up', 'the pipeline lint step'],
  storefront:['basket totals', 'the address finder', 'coupon error messages', 'multi-buy labels', 'the order history page', 'product page load time', 'search result ranking', 'the slot picker layout', 'payment retry copy', 'the newsletter sign-up', 'sale badge colours', 'mobile menu focus', 'checkout form validation', 'loyalty point display', 'favourites syncing', 'receipt emails', 'stock warnings in the basket', 'the cookie banner', 'price per kilo labels', 'review stars on listings', 'recipe page links', 'the store locator map'],
  insights:['the weekly sales rollup', 'basket size trends', 'depot throughput charts', 'the churn estimate', 'the delivery delay report', 'promo uplift numbers', 'the supplier scorecard', 'the stock-out forecast', 'the finance export', 'the data dictionary'],
};
const SPANS_MS = { a:[1 * MINUTE_MS, 15 * MINUTE_MS], b:[15 * MINUTE_MS, HOUR_MS], c:[HOUR_MS, 4 * HOUR_MS], d:[4 * HOUR_MS, DAY_MS], e:[DAY_MS, 3 * DAY_MS], f:[3 * DAY_MS, 7 * DAY_MS], g:[7 * DAY_MS, 11 * DAY_MS] };
const STEADY_THREAD_SPANS = { a:85, b:67, c:80, d:80, e:10 };
const TIDIED_THREAD_SPANS = { c:7, d:37, e:19, f:80, g:4 };
const PR_SPANS = { a:71, b:86, c:62, d:58, e:16, f:5 };
// How many threads each tidy-up marks Done at once. A run of four or more within minutes reads as a tidy-up on the track view.
const TIDY_UP_SIZES = [44, 24, 21, 17, 14, 12, 9, 7, 6, 6, 5, 5, 5, 5, 5, 5, 5, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4];
const DELIVERED_FIRST_MS = Date.parse('2026-10-08T07:00:00Z'), DELIVERED_LAST_MS = Date.parse('2026-11-04T17:40:00Z');

/** Picks a duration in milliseconds, from buckets weighted by how often each one occurs. */
function pickSpan(weights) {
  const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
  let roll = random() * total;
  for (const [bucket, weight] of Object.entries(weights)) {
    roll -= weight;
    if (roll <= 0) return between(...SPANS_MS[bucket]);
  }
  return between(...SPANS_MS.a);
}

/** Picks a moment within working hours. Weekdays are far likelier than weekends, as they are for people. */
function pickWorkingMoment() {
  for (;;) {
    const day = Math.floor(between(DELIVERED_FIRST_MS, DELIVERED_LAST_MS) / DAY_MS) * DAY_MS, weekday = new Date(day).getUTCDay();
    if ((weekday === 0 || weekday === 6) && random() > .12) continue;
    const moment = day + between(7 * 60, 18 * 60) * MINUTE_MS + between(0, 59) * 1000;
    if (moment <= DELIVERED_LAST_MS) return moment;
  }
}

const usedNames = new Set();
/** Returns a title no other delivered item has, made from a verb, a subject and sometimes a qualifier. */
function buildDeliveredName(verbs, subjects) {
  for (;;) {
    const name = `${pick(verbs)} ${pick(subjects)}${random() < .72 ? ` ${pick(QUALIFIERS)}` : ''}`;
    if (usedNames.has(name)) continue;
    usedNames.add(name);
    return name;
  }
}

function buildDeliveredRow({ id, kind, name, project, initiative = '', endMs, spanMs, url = '' }) {
  const startMs = Math.max(endMs - spanMs, DELIVERED_FIRST_MS - 8 * HOUR_MS);
  return { id, kind, name, project, initiative, start:new Date(startMs).toISOString(), end:new Date(endMs).toISOString(), url, days:+((endMs - startMs) / DAY_MS).toFixed(2) };
}

function buildDelivered() {
  const threadProjects = shuffle([...repeat('platform', 352), ...repeat('storefront', 81), ...repeat('Insights', 36)]);
  const tidiedCount = TIDY_UP_SIZES.reduce((sum, size) => sum + size, 0);
  // The tracks view reads these end moments to find tidy-ups: each run has gaps under three minutes.
  const tidiedEnds = TIDY_UP_SIZES.flatMap(size => {
    let moment = pickWorkingMoment();
    return Array.from({ length:size }, () => (moment = Math.min(moment + between(2, 14) * 1000, DELIVERED_LAST_MS)));
  });
  const threads = threadProjects.map((project, n) => {
    const isTidied = n < tidiedCount;
    return buildDeliveredRow({
      id:hex(8), kind:'thread', project, name:buildDeliveredName(THREAD_VERBS, SUBJECTS[project === 'Insights' ? 'insights' : project]),
      endMs:isTidied ? tidiedEnds[n] : pickWorkingMoment(), spanMs:pickSpan(isTidied ? TIDIED_THREAD_SPANS : STEADY_THREAD_SPANS),
    });
  });
  const prProjects = shuffle([...repeat(['platform', 'platform-core'], 188), ...repeat(['storefront', 'storefront-web'], 66), ...repeat(['insights', 'insights-jobs'], 44)]);
  const nextNumber = { 'platform-core':3400, 'storefront-web':6300, 'insights-jobs':1500 };
  const pullRequests = prProjects.map(([project, repo]) => {
    const number = (nextNumber[repo] += between(1, 3));
    return buildDeliveredRow({
      id:`${ORG}/${repo}#${number}`, kind:'pr', project, name:buildDeliveredName(PR_VERBS, SUBJECTS[project]),
      endMs:pickWorkingMoment(), spanMs:pickSpan(PR_SPANS), url:buildPrUrl(repo, number),
    });
  });
  // Only work on the shop's own plans carries an initiative, as a small part of what was delivered.
  const onPlan = shuffle([...threads, ...pullRequests].filter(row => row.project === 'storefront')).slice(0, 27);
  for (const row of onPlan) row.initiative = pick(['priceengine', 'a11y', 'search']);
  return [...threads, ...pullRequests].sort((a, b) => b.start.localeCompare(a.start));
}

const threadPieces = buildThreadPieces();
const reviews = buildReviews(), ownPrs = buildOwnPullRequests(), mentions = buildMentions(), tickets = buildTickets();
const otherPieces = OTHERS.map(({ link, ...row }) => buildPiece({ ...row, kind:'other', confidence:'medium', links:link ? [link] : [], ...pickDates(false) }));
const errorPiece = buildPiece({ ...ERROR_PIECE, kind:'errors', source:'signal', confidence:'medium', links:[{ label:'Sentry SEARCH-API-1Z4', url:'', state:'in Intake' }], ...pickDates(false) });
const WORK = [...threadPieces, ...reviews.pieces, ...ownPrs.pieces, ...mentions.pieces, ...tickets.pieces, ...otherPieces, errorPiece];

const raised = buildClusters();
const INBOX = {
  reviews:reviews.cards, mine:ownPrs.cards, mentions:mentions.cards, tickets:tickets.cards, raised,
  intakeLeft:24, sentryTotal:24 + raised.reduce((sum, cluster) => sum + cluster.issues.length, 0),
  sample:[{ id:'mail-1', kind:'gmail/thread', title:'Decision needed: freeze dates for the spring sale', from_:'Tessa Lindqvist', state:'You owe a reply', deadline:'Thursday', age:'2d', signals:[{ label:'Asks you to decide', at:dayAgo(2), open:true, outcome:'' }] }],
};
const DELIVERED = buildDelivered();

/** Returns the pieces of one list as a line-per-field array literal, the way the views' data files read. */
const writeList = list => `[\n${list.map(row => JSON.stringify(row, null, 1)).join(',\n')}\n]`;
const HEADER = '// Invented data, written by generate-data.mjs. Change that script and run it, rather than editing this file.\n';
const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(here, 'data.js'), `${HEADER}const WORK = ${writeList(WORK)};\nconst INITIATIVES = ${writeList(INITIATIVES)};\nconst RELATIONS = ${JSON.stringify(RELATIONS)};\n`);
writeFileSync(join(here, 'delivered.js'), `${HEADER}const DELIVERED = [\n${DELIVERED.map(row => JSON.stringify(row)).join(',\n')}\n];\n`);
writeFileSync(join(here, 'inbox.js'), `${HEADER}const INBOX = ${JSON.stringify(INBOX, null, 1)};\n`);
console.log(`Wrote ${WORK.length} pieces, ${INITIATIVES.length} initiatives, ${RELATIONS.length} relations and ${DELIVERED.length} delivered items.`);
