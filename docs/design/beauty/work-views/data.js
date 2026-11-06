// Invented data, written by generate-data.mjs. Change that script and run it, rather than editing this file.
const WORK = [
{
 "id": "flake-report",
 "name": "Weekly flake report",
 "project": "platform",
 "what": "Post the worst flaky tests to the team channel every Monday.",
 "where": "Done. The report has posted for three weeks and the team reads it.",
 "left": "Nothing",
 "ask": "",
 "context": [],
 "options": [],
 "move": "nobody",
 "need": "nothing",
 "stage": "landed",
 "stalled": false,
 "whyStalled": "",
 "links": [],
 "threads": [
  {
   "title": "Weekly flake report",
   "id": "261beea6"
  },
  {
   "title": "Follow-up on weekly flake report",
   "id": "fdf9c3a5"
  }
 ],
 "confidence": "medium",
 "createdAt": "2026-10-27",
 "lastActivityAt": "2026-11-01",
 "initiative": "flaky",
 "kind": "thread",
 "source": "thread",
 "topic": "",
 "zone": "Reports"
},
{
 "id": "dep-bumps",
 "name": "Batch dependency bumps weekly",
 "project": "platform",
 "what": "Group small library upgrades into one PR a week.",
 "where": "Landed. The weekly PR has merged twice without trouble.",
 "left": "Nothing",
 "ask": "",
 "context": [],
 "options": [],
 "move": "nobody",
 "need": "nothing",
 "stage": "landed",
 "stalled": false,
 "whyStalled": "",
 "links": [],
 "threads": [
  {
   "title": "Batch dependency bumps weekly",
   "id": "c2b1a19f"
  },
  {
   "title": "Second look at batch dependency bumps weekly",
   "id": "b1712dc1"
  }
 ],
 "confidence": "medium",
 "createdAt": "2026-10-20",
 "lastActivityAt": "2026-11-01",
 "initiative": "",
 "kind": "thread",
 "source": "thread",
 "topic": "Upkeep",
 "zone": "Shop front"
},
{
 "id": "contrast-audit",
 "name": "Contrast audit for sale badges",
 "project": "storefront",
 "what": "Check every sale badge against the contrast rules.",
 "where": "Done. All nine badge colours pass after the new palette.",
 "left": "Nothing",
 "ask": "Anything else to check before this closes?",
 "context": [],
 "options": [],
 "move": "you",
 "need": "look",
 "stage": "landed",
 "stalled": false,
 "whyStalled": "",
 "links": [],
 "threads": [
  {
   "title": "Contrast audit for sale badges",
   "id": "f919b7e1"
  }
 ],
 "confidence": "medium",
 "createdAt": "2026-10-29",
 "lastActivityAt": "2026-11-03",
 "initiative": "a11y",
 "kind": "thread",
 "source": "thread",
 "topic": "Clean-up",
 "zone": "Shop front"
},
{
 "id": "gift-receipt",
 "name": "Gift card balance on the receipt",
 "project": "storefront",
 "what": "Print the remaining balance on the email receipt.",
 "where": "Landed. Support contacts on this topic have stopped.",
 "left": "Nothing",
 "ask": "",
 "context": [],
 "options": [],
 "move": "nobody",
 "need": "nothing",
 "stage": "landed",
 "stalled": false,
 "whyStalled": "",
 "links": [
  {
   "label": "SHOP-121",
   "url": "https://tracker.example/northwind/issue/SHOP-121",
   "state": "Triage"
  },
  {
   "label": "PR #3613 Draft",
   "url": "https://github.example/northwind/storefront-web/pull/3613",
   "state": "merged"
  },
  {
   "label": "Issue #3617",
   "url": "https://github.example/northwind/storefront-web/issues/3617",
   "state": "open"
  }
 ],
 "threads": [
  {
   "title": "Gift card balance on the receipt",
   "id": "fc106a30"
  },
  {
   "title": "Second look at gift card balance on the receipt",
   "id": "e54542b4"
  }
 ],
 "confidence": "low",
 "createdAt": "2026-10-26",
 "lastActivityAt": "2026-10-30",
 "initiative": "",
 "kind": "thread",
 "source": "thread",
 "topic": "Money paths",
 "zone": "Checkout"
},
{
 "id": "route-order",
 "name": "Drivers reorder their own stops",
 "project": "field-app",
 "what": "Let a driver change the stop order when a road is closed.",
 "where": "Landed in the last app release. Drivers used it on 6% of routes in its first week.",
 "left": "Nothing",
 "ask": "Can this thread be closed?",
 "context": [],
 "options": [],
 "move": "you",
 "need": "nothing",
 "stage": "landed",
 "stalled": false,
 "whyStalled": "",
 "links": [],
 "threads": [
  {
   "title": "Drivers reorder their own stops",
   "id": "c6b9ba3a"
  }
 ],
 "confidence": "low",
 "createdAt": "2026-10-23",
 "lastActivityAt": "2026-11-01",
 "initiative": "",
 "kind": "thread",
 "source": "thread",
 "topic": "Driver tools",
 "zone": "Driver app"
},
{
 "id": "sched-inventory",
 "name": "List every job on the old scheduler",
 "project": "platform",
 "what": "Find out which jobs still run on the old scheduler and who owns each one.",
 "where": "Forty-one jobs found so far. Eleven have no clear owner, and three look unused since the summer.",
 "left": "Name an owner for the last eleven jobs",
 "ask": "Pick owners for the eleven orphan jobs, or say which can go.",
 "context": [],
 "options": [],
 "move": "you",
 "need": "quick",
 "stage": "planned",
 "stalled": true,
 "whyStalled": "Owners are a people question, and nobody wants a job they did not write.",
 "links": [
  {
   "label": "PR #3623 Small fix",
   "url": "https://github.example/northwind/platform-core/pull/3623",
   "state": "merged"
  },
  {
   "label": "Issue #3628",
   "url": "https://github.example/northwind/platform-core/issues/3628",
   "state": "open"
  },
  {
   "label": "PLAT-136",
   "url": "https://tracker.example/northwind/issue/PLAT-136",
   "state": "Todo"
  },
  {
   "label": "PLAT-142",
   "url": "https://tracker.example/northwind/issue/PLAT-142",
   "state": "Triage"
  }
 ],
 "threads": [
  {
   "title": "List every job on the old scheduler",
   "id": "2b5df832"
  }
 ],
 "confidence": "medium",
 "createdAt": "2026-10-11",
 "lastActivityAt": "2026-10-19",
 "initiative": "scheduler",
 "kind": "thread",
 "source": "thread",
 "topic": "",
 "zone": "Job runner"
},
{
 "id": "sched-retries",
 "name": "Retry policy for moved jobs",
 "project": "platform",
 "what": "Agree how a moved job retries when a downstream service is down.",
 "where": "Two drafts exist. One backs off for an hour, the other gives up after three tries and pages someone.",
 "left": "Choose one draft and write it down",
 "ask": "Choose between the two retry drafts.",
 "context": [],
 "options": [],
 "move": "you",
 "need": "think",
 "stage": "exploring",
 "stalled": false,
 "whyStalled": "",
 "links": [],
 "threads": [
  {
   "title": "Retry policy for moved jobs",
   "id": "d2886a0e"
  },
  {
   "title": "Notes on retry policy for moved jobs",
   "id": "b6972f82"
  }
 ],
 "confidence": "low",
 "createdAt": "2026-10-20",
 "lastActivityAt": "2026-10-31",
 "initiative": "scheduler",
 "kind": "thread",
 "source": "thread",
 "topic": "",
 "zone": "Job runner"
},
{
 "id": "sched-cutover",
 "name": "Cut over the invoice export",
 "project": "platform",
 "what": "Move the first real job, the invoice export, to the new job runner.",
 "where": "The move is in review as #3318. It ran clean on staging for five nights in a row.",
 "left": "Approve the cutover and watch one live run",
 "ask": "Approve the cutover for Monday night?",
 "context": [],
 "options": [],
 "move": "you",
 "need": "quick",
 "stage": "reviewing",
 "stalled": false,
 "whyStalled": "",
 "links": [
  {
   "label": "Issue #3645",
   "url": "https://github.example/northwind/platform-core/issues/3645",
   "state": "unknown"
  },
  {
   "label": "PLAT-155",
   "url": "https://tracker.example/northwind/issue/PLAT-155",
   "state": "Todo"
  }
 ],
 "threads": [
  {
   "title": "Cut over the invoice export",
   "id": "b4097af3"
  },
  {
   "title": "Follow-up on cut over the invoice export",
   "id": "da534e7a"
  }
 ],
 "confidence": "medium",
 "createdAt": "2026-10-27",
 "lastActivityAt": "2026-11-03",
 "initiative": "scheduler",
 "kind": "thread",
 "source": "thread",
 "topic": "Upkeep",
 "zone": "Job runner"
},
{
 "id": "sched-dashboards",
 "name": "Dashboards for job lag",
 "project": "platform",
 "what": "Show how late each job runs, so a slow run is seen before finance notices.",
 "where": "A rough board exists on staging. It has no alert yet and shows only the moved jobs.",
 "left": "Add an alert and the remaining jobs",
 "ask": "Say which lag should page someone.",
 "context": [
  "Two earlier threads reached this same question and stopped there",
  "The depot managers have not been asked yet",
  "The product team says a rival shop already does this"
 ],
 "options": [],
 "move": "you",
 "need": "quick",
 "stage": "planned",
 "stalled": true,
 "whyStalled": "Waiting on the job list, which is itself stuck on owners.",
 "links": [
  {
   "label": "Issue #3655",
   "url": "https://github.example/northwind/platform-core/issues/3655",
   "state": "open"
  },
  {
   "label": "Issue #3662",
   "url": "https://github.example/northwind/platform-core/issues/3662",
   "state": "open"
  },
  {
   "label": "PR #3667 First slice",
   "url": "https://github.example/northwind/platform-core/pull/3667",
   "state": "closed"
  },
  {
   "label": "Issue #3672",
   "url": "https://github.example/northwind/platform-core/issues/3672",
   "state": "open"
  },
  {
   "label": "Issue #3673",
   "url": "https://github.example/northwind/platform-core/issues/3673",
   "state": "open"
  },
  {
   "label": "Sentry PLATFORM-664",
   "url": "",
   "state": "in Intake"
  }
 ],
 "threads": [
  {
   "title": "Dashboards for job lag",
   "id": "9e25c2bd"
  },
  {
   "title": "Notes on dashboards for job lag",
   "id": "e14d26de"
  },
  {
   "title": "Follow-up on dashboards for job lag",
   "id": "fc180d57"
  },
  {
   "title": "Options for dashboards for job lag",
   "id": "20ca4eda"
  }
 ],
 "confidence": "medium",
 "createdAt": "2026-10-04",
 "lastActivityAt": "2026-10-13",
 "initiative": "scheduler",
 "kind": "thread",
 "source": "thread",
 "topic": "",
 "zone": "Reports"
},
{
 "id": "flake-quarantine",
 "name": "Quarantine list for flaky tests",
 "project": "platform",
 "what": "Move known flaky tests out of the blocking run until each one has an owner.",
 "where": "Six small PRs are open, one per test. Blocking runs failed on 9% of attempts last week.",
 "left": "Merge the six PRs",
 "ask": "Merge the quarantine PRs together, or one at a time?",
 "context": [
  "The depot managers have not been asked yet",
  "The product team says a rival shop already does this",
  "One of the two approaches needs a database change, the other does not"
 ],
 "options": [],
 "move": "you",
 "need": "quick",
 "stage": "reviewing",
 "stalled": false,
 "whyStalled": "",
 "links": [],
 "threads": [
  {
   "title": "Quarantine list for flaky tests",
   "id": "9f8cce7e"
  }
 ],
 "confidence": "medium",
 "createdAt": "2026-11-03",
 "lastActivityAt": "2026-11-03",
 "initiative": "flaky",
 "kind": "thread",
 "source": "thread",
 "topic": "Upkeep",
 "zone": "Test rigs"
},
{
 "id": "flake-clock",
 "name": "Tests that depend on the wall clock",
 "project": "platform",
 "what": "Replace real time in tests with a fake clock.",
 "where": "An agent is working through the order tests. About half are done.",
 "left": "The delivery and coupon tests",
 "ask": "",
 "context": [
  "Nothing here blocks the spring sale, but it gets harder to change afterwards",
  "Finance asked for a written rule before anything ships",
  "One of the two approaches needs a database change, the other does not"
 ],
 "options": [],
 "move": "agent",
 "need": "look",
 "stage": "building",
 "stalled": false,
 "whyStalled": "",
 "links": [
  {
   "label": "Issue #3679",
   "url": "https://github.example/northwind/platform-core/issues/3679",
   "state": "closed"
  },
  {
   "label": "Sentry PLATFORM-0E9",
   "url": "",
   "state": "in Intake"
  },
  {
   "label": "PLAT-178",
   "url": "https://tracker.example/northwind/issue/PLAT-178",
   "state": "Triage"
  },
  {
   "label": "Sentry PLATFORM-2F2",
   "url": "",
   "state": "in Intake"
  }
 ],
 "threads": [
  {
   "title": "Tests that depend on the wall clock",
   "id": "5dfed783"
  }
 ],
 "confidence": "high",
 "createdAt": "2026-10-25",
 "lastActivityAt": "2026-11-04",
 "initiative": "flaky",
 "kind": "thread",
 "source": "thread",
 "topic": "",
 "zone": "Test rigs"
},
{
 "id": "flake-seeds",
 "name": "Stable seed data for integration tests",
 "project": "platform",
 "what": "Give integration tests one fixed set of shoppers and products.",
 "where": "The seed file is drafted but not wired in. Two suites still build their own records.",
 "left": "Wire the seed file into both suites",
 "ask": "Is one shared seed file fine, or one per suite?",
 "context": [
  "About 28% of shoppers would notice, mostly on phones",
  "Whoever picks this up will need access to the staging tools",
  "Legal only needs a note if personal data moves"
 ],
 "options": [],
 "move": "you",
 "need": "quick",
 "stage": "planned",
 "stalled": true,
 "whyStalled": "The two suites have different owners, and each one expects the other to move first.",
 "links": [
  {
   "label": "PLAT-182",
   "url": "https://tracker.example/northwind/issue/PLAT-182",
   "state": "Triage"
  },
  {
   "label": "Issue #3703",
   "url": "https://github.example/northwind/platform-core/issues/3703",
   "state": "closed"
  }
 ],
 "threads": [
  {
   "title": "Stable seed data for integration tests",
   "id": "5d6b263c"
  }
 ],
 "confidence": "high",
 "createdAt": "2026-10-12",
 "lastActivityAt": "2026-10-23",
 "initiative": "flaky",
 "kind": "thread",
 "source": "thread",
 "topic": "",
 "zone": "Test rigs"
},
{
 "id": "flake-parallel",
 "name": "Run the slow suite in shards",
 "project": "platform",
 "what": "Split the 38-minute suite over four machines.",
 "where": "A trial brought it to eleven minutes, but shared fixtures collide. It needs the stable seed data first.",
 "left": "Decide on the shard count once the seeds land",
 "ask": "Is the extra runner cost worth 27 minutes per run?",
 "context": [
  "There is a cheap version that covers most cases",
  "Nothing here blocks the spring sale, but it gets harder to change afterwards",
  "About 24% of shoppers would notice, mostly on phones"
 ],
 "options": [
  "Try it at one depot",
  "Wait until after the spring sale",
  "Ship the small version first"
 ],
 "move": "you",
 "need": "think",
 "stage": "exploring",
 "stalled": true,
 "whyStalled": "Blocked by the seed data, and the cost question has no owner.",
 "links": [],
 "threads": [
  {
   "title": "Run the slow suite in shards",
   "id": "6ed0534b"
  }
 ],
 "confidence": "medium",
 "createdAt": "2026-10-16",
 "lastActivityAt": "2026-10-17",
 "initiative": "flaky",
 "kind": "thread",
 "source": "thread",
 "topic": "",
 "zone": "Test rigs"
},
{
 "id": "flake-browser",
 "name": "Browser tests that race the basket API",
 "project": "platform",
 "what": "Wait for the basket response instead of sleeping for two seconds.",
 "where": "Twelve sleeps found in the browser tests. Four are replaced on a branch.",
 "left": "Replace the last eight sleeps",
 "ask": "Hand the last eight to an agent?",
 "context": [
  "One of the two approaches needs a database change, the other does not",
  "There is a cheap version that covers most cases",
  "The change is small in code and large in what people must relearn"
 ],
 "options": [
  "Time-box it to one week",
  "Try it at one depot"
 ],
 "move": "you",
 "need": "quick",
 "stage": "planned",
 "stalled": false,
 "whyStalled": "",
 "links": [
  {
   "label": "Issue #3704",
   "url": "https://github.example/northwind/platform-core/issues/3704",
   "state": "closed"
  },
  {
   "label": "PLAT-194",
   "url": "https://tracker.example/northwind/issue/PLAT-194",
   "state": "Triage"
  },
  {
   "label": "Issue #3713",
   "url": "https://github.example/northwind/platform-core/issues/3713",
   "state": "open"
  },
  {
   "label": "Sentry PLATFORM-F65",
   "url": "",
   "state": "in Intake"
  }
 ],
 "threads": [
  {
   "title": "Browser tests that race the basket API",
   "id": "8ddcff22"
  },
  {
   "title": "Follow-up on browser tests that race the basket API",
   "id": "ef8b729d"
  }
 ],
 "confidence": "low",
 "createdAt": "2026-10-30",
 "lastActivityAt": "2026-11-03",
 "initiative": "flaky",
 "kind": "thread",
 "source": "thread",
 "topic": "",
 "zone": "Test rigs"
},
{
 "id": "cost-logs",
 "name": "Trim log storage cost",
 "project": "platform",
 "what": "Cut what we pay to keep logs nobody reads.",
 "where": "Debug logs from the gateway make up about 60% of the bill. Retention is 90 days for all of it.",
 "left": "Pick retention per log type",
 "ask": "How long must gateway logs stay?",
 "context": [
  "Legal only needs a note if personal data moves",
  "Nothing here blocks the spring sale, but it gets harder to change afterwards",
  "Support logged 36 contacts about this in the last month"
 ],
 "options": [
  "Let an agent try it",
  "Time-box it to one week"
 ],
 "move": "you",
 "need": "think",
 "stage": "exploring",
 "stalled": true,
 "whyStalled": "Nobody knows which logs the auditors expect.",
 "links": [],
 "threads": [
  {
   "title": "Trim log storage cost",
   "id": "7edf265a"
  }
 ],
 "confidence": "medium",
 "createdAt": "2026-10-11",
 "lastActivityAt": "2026-10-11",
 "initiative": "",
 "kind": "thread",
 "source": "thread",
 "topic": "Cost control",
 "zone": "Gateway"
},
{
 "id": "secrets-rotation",
 "name": "Rotate service tokens every quarter",
 "project": "platform",
 "what": "Stop long-lived tokens from staying in place for years.",
 "where": "Fourteen tokens are older than a year. Rotating them by hand takes most of a day.",
 "left": "Choose a rotation tool and a calendar",
 "ask": "Buy a tool, or script it ourselves?",
 "context": [
  "The numbers look better on weekdays, so a weekend trial may mislead",
  "The team would rather ship a small version first and learn from it",
  "The last attempt stopped when its owner moved teams"
 ],
 "options": [
  "Try it at one depot",
  "Let an agent try it",
  "Raise it at the Thursday planning call"
 ],
 "move": "you",
 "need": "think",
 "stage": "planned",
 "stalled": true,
 "whyStalled": "A purchase needs a budget line, and that conversation has not started.",
 "links": [
  {
   "label": "Issue #3721",
   "url": "https://github.example/northwind/platform-core/issues/3721",
   "state": "open"
  },
  {
   "label": "Issue #3728",
   "url": "https://github.example/northwind/platform-core/issues/3728",
   "state": "unknown"
  }
 ],
 "threads": [
  {
   "title": "Rotate service tokens every quarter",
   "id": "7651a7af"
  }
 ],
 "confidence": "medium",
 "createdAt": "2026-10-10",
 "lastActivityAt": "2026-10-19",
 "initiative": "",
 "kind": "thread",
 "source": "thread",
 "topic": "Secrets",
 "zone": "Secrets"
},
{
 "id": "oncall-runbook",
 "name": "Runbooks for the top ten alerts",
 "project": "platform",
 "what": "Give whoever is on call a short page for each noisy alert.",
 "where": "Seven are written. The queue backlog one is in review as an open PR.",
 "left": "Three more runbooks",
 "ask": "Read the queue backlog runbook?",
 "context": [
  "Whoever picks this up will need access to the staging tools",
  "Two earlier threads reached this same question and stopped there",
  "The product team says a rival shop already does this"
 ],
 "options": [
  "Raise it at the Thursday planning call",
  "Wait until after the spring sale",
  "Try it at one depot"
 ],
 "move": "you",
 "need": "quick",
 "stage": "reviewing",
 "stalled": false,
 "whyStalled": "",
 "links": [
  {
   "label": "Sentry PLATFORM-F0A",
   "url": "",
   "state": "in Intake"
  },
  {
   "label": "PLAT-213",
   "url": "https://tracker.example/northwind/issue/PLAT-213",
   "state": "Todo"
  },
  {
   "label": "PLAT-216",
   "url": "https://tracker.example/northwind/issue/PLAT-216",
   "state": "Triage"
  }
 ],
 "threads": [
  {
   "title": "Runbooks for the top ten alerts",
   "id": "70a766e8"
  }
 ],
 "confidence": "medium",
 "createdAt": "2026-10-24",
 "lastActivityAt": "2026-10-29",
 "initiative": "",
 "kind": "thread",
 "source": "thread",
 "topic": "On-call",
 "zone": "Gateway"
},
{
 "id": "staging-data",
 "name": "Staging data without customer records",
 "project": "platform",
 "what": "Refresh staging from production with every personal field replaced.",
 "where": "The masking script covers orders and addresses, not support notes. Legal want a sign-off before it runs.",
 "left": "Cover support notes and get the sign-off",
 "ask": "Who signs off the masking rules?",
 "context": [
  "One of the two approaches needs a database change, the other does not",
  "The depot managers have not been asked yet",
  "Whoever picks this up will need access to the staging tools"
 ],
 "options": [
  "Get a quote",
  "Try it at one depot",
  "Drop it for now"
 ],
 "move": "you",
 "need": "think",
 "stage": "exploring",
 "stalled": true,
 "whyStalled": "Sign-off sits with a person who has not been told yet.",
 "links": [
  {
   "label": "Issue #3756",
   "url": "https://github.example/northwind/platform-core/issues/3756",
   "state": "unknown"
  },
  {
   "label": "PLAT-221",
   "url": "https://tracker.example/northwind/issue/PLAT-221",
   "state": "Todo"
  },
  {
   "label": "Issue #3763",
   "url": "https://github.example/northwind/platform-core/issues/3763",
   "state": "open"
  }
 ],
 "threads": [
  {
   "title": "Staging data without customer records",
   "id": "4d34a269"
  },
  {
   "title": "Second look at staging data without customer records",
   "id": "951150e5"
  },
  {
   "title": "Second look at staging data without customer records",
   "id": "5086602d"
  }
 ],
 "confidence": "medium",
 "createdAt": "2026-10-10",
 "lastActivityAt": "2026-10-14",
 "initiative": "",
 "kind": "thread",
 "source": "thread",
 "topic": "Staging data",
 "zone": "Staging"
},
{
 "id": "price-rounding",
 "name": "Rounding rules for multi-buy offers",
 "project": "storefront",
 "what": "Decide how three-for-two rounds on weighed items.",
 "where": "Shop and finance disagree by a penny on about 2% of baskets. Both sides have a written case.",
 "left": "Pick one rule",
 "ask": "Round per line or per basket?",
 "context": [
  "The change is small in code and large in what people must relearn",
  "I found no owner for this in the team list",
  "Whoever picks this up will need access to the staging tools"
 ],
 "options": [
  "Get a quote",
  "Let an agent try it"
 ],
 "move": "you",
 "need": "think",
 "stage": "exploring",
 "stalled": true,
 "whyStalled": "Either answer annoys one team, so it waits for a meeting that has no date.",
 "links": [],
 "threads": [
  {
   "title": "Rounding rules for multi-buy offers",
   "id": "27530e8c"
  }
 ],
 "confidence": "medium",
 "createdAt": "2026-10-17",
 "lastActivityAt": "2026-10-25",
 "initiative": "priceengine",
 "kind": "thread",
 "source": "thread",
 "topic": "Money paths",
 "zone": "Price engine"
},
{
 "id": "price-rules-tests",
 "name": "Golden tests for price rules",
 "project": "storefront",
 "what": "Pin today's prices for 500 sample baskets before anything moves.",
 "where": "The sample baskets are in review. Eleven differ from the old engine and need a look.",
 "left": "Explain the eleven differences",
 "ask": "Are the eleven differences acceptable?",
 "context": [
  "A vendor sells this, at a price nobody has checked",
  "The team would rather ship a small version first and learn from it",
  "It would take roughly 33 days of agent time, plus review"
 ],
 "options": [
  "Wait until after the spring sale",
  "Drop it for now",
  "Try it at one depot"
 ],
 "move": "you",
 "need": "quick",
 "stage": "reviewing",
 "stalled": false,
 "whyStalled": "",
 "links": [
  {
   "label": "SHOP-227",
   "url": "https://tracker.example/northwind/issue/SHOP-227",
   "state": "Triage"
  },
  {
   "label": "Sentry STOREFRONT-672",
   "url": "",
   "state": "in Intake"
  }
 ],
 "threads": [
  {
   "title": "Golden tests for price rules",
   "id": "3da8c9f3"
  }
 ],
 "confidence": "low",
 "createdAt": "2026-10-29",
 "lastActivityAt": "2026-11-02",
 "initiative": "priceengine",
 "kind": "thread",
 "source": "thread",
 "topic": "",
 "zone": "Price engine"
},
{
 "id": "cart-focus",
 "name": "Keyboard focus in the basket drawer",
 "project": "storefront",
 "what": "Keep focus inside the drawer and return it when the drawer closes.",
 "where": "The fix is in review. It works with two screen readers and still needs a check on phones.",
 "left": "A phone check",
 "ask": "Test it on a phone, or ship and watch?",
 "context": [
  "Finance asked for a written rule before anything ships",
  "Support logged 13 contacts about this in the last month",
  "The depot managers have not been asked yet"
 ],
 "options": [
  "Let an agent try it",
  "Get a quote"
 ],
 "move": "you",
 "need": "quick",
 "stage": "reviewing",
 "stalled": false,
 "whyStalled": "",
 "links": [
  {
   "label": "Issue #3776",
   "url": "https://github.example/northwind/storefront-web/issues/3776",
   "state": "unknown"
  },
  {
   "label": "SHOP-234",
   "url": "https://tracker.example/northwind/issue/SHOP-234",
   "state": "Todo"
  },
  {
   "label": "SHOP-239",
   "url": "https://tracker.example/northwind/issue/SHOP-239",
   "state": "Todo"
  }
 ],
 "threads": [
  {
   "title": "Keyboard focus in the basket drawer",
   "id": "ee71ccea"
  }
 ],
 "confidence": "medium",
 "createdAt": "2026-11-02",
 "lastActivityAt": "2026-11-03",
 "initiative": "a11y",
 "kind": "thread",
 "source": "thread",
 "topic": "",
 "zone": "Basket"
},
{
 "id": "search-synonyms",
 "name": "Synonyms for everyday products",
 "project": "storefront",
 "what": "Make \"fizzy drink\" find soda and \"nappies\" find diapers.",
 "where": "A first list of 200 pairs is ready. The search team wants a way to edit it without a release.",
 "left": "An editing screen for the list",
 "ask": "Is a spreadsheet import good enough for now?",
 "context": [
  "I could not confirm the numbers: they come from a single week",
  "A vendor sells this, at a price nobody has checked",
  "The last attempt stopped when its owner moved teams"
 ],
 "options": [
  "Wait until after the spring sale",
  "Try it at one depot"
 ],
 "move": "you",
 "need": "quick",
 "stage": "planned",
 "stalled": true,
 "whyStalled": "Nobody has said who keeps the list up to date.",
 "links": [
  {
   "label": "Sentry STOREFRONT-92A",
   "url": "",
   "state": "in Intake"
  },
  {
   "label": "SHOP-252",
   "url": "https://tracker.example/northwind/issue/SHOP-252",
   "state": "Triage"
  },
  {
   "label": "Sentry STOREFRONT-DB7",
   "url": "",
   "state": "in Intake"
  },
  {
   "label": "Issue #3809",
   "url": "https://github.example/northwind/storefront-web/issues/3809",
   "state": "open"
  },
  {
   "label": "PR #3816 Clean-up",
   "url": "https://github.example/northwind/storefront-web/pull/3816",
   "state": "open"
  },
  {
   "label": "Sentry STOREFRONT-58B",
   "url": "",
   "state": "in Intake"
  }
 ],
 "threads": [
  {
   "title": "Synonyms for everyday products",
   "id": "feec25c4"
  }
 ],
 "confidence": "low",
 "createdAt": "2026-10-11",
 "lastActivityAt": "2026-10-17",
 "initiative": "search",
 "kind": "thread",
 "source": "thread",
 "topic": "Speed",
 "zone": "Search"
},
{
 "id": "search-latency",
 "name": "Search latency on slow phones",
 "project": "storefront",
 "what": "Find out why search takes over three seconds on older phones.",
 "where": "Most of the time goes on the first result image, not on the query. Two fixes look possible.",
 "left": "Choose a fix and measure it",
 "ask": "Drop images from the first paint, or shrink them?",
 "context": [
  "Finance asked for a written rule before anything ships",
  "Legal only needs a note if personal data moves",
  "Whoever picks this up will need access to the staging tools"
 ],
 "options": [
  "Raise it at the Thursday planning call",
  "Write the rule down first",
  "Let an agent try it"
 ],
 "move": "you",
 "need": "think",
 "stage": "exploring",
 "stalled": false,
 "whyStalled": "",
 "links": [
  {
   "label": "Sentry STOREFRONT-1FB",
   "url": "",
   "state": "in Intake"
  },
  {
   "label": "SHOP-285",
   "url": "https://tracker.example/northwind/issue/SHOP-285",
   "state": "Triage"
  }
 ],
 "threads": [
  {
   "title": "Search latency on slow phones",
   "id": "fee38075"
  }
 ],
 "confidence": "medium",
 "createdAt": "2026-10-26",
 "lastActivityAt": "2026-11-02",
 "initiative": "search",
 "kind": "thread",
 "source": "thread",
 "topic": "Speed",
 "zone": "Search"
},
{
 "id": "coupons-stack",
 "name": "Can coupons stack with loyalty points?",
 "project": "storefront",
 "what": "Settle whether a shopper can use both on one order.",
 "where": "Marketing says yes, finance says only above a minimum spend. The code allows it today by accident.",
 "left": "One answer from marketing and finance",
 "ask": "Bring both sides to one answer?",
 "context": [
  "One of the two approaches needs a database change, the other does not",
  "About 30% of shoppers would notice, mostly on phones",
  "The last attempt stopped when its owner moved teams"
 ],
 "options": [
  "Time-box it to one week",
  "Drop it for now",
  "Let an agent try it"
 ],
 "move": "you",
 "need": "think",
 "stage": "exploring",
 "stalled": true,
 "whyStalled": "The accident works in shoppers' favour, so nobody is in a hurry.",
 "links": [
  {
   "label": "PR #3830 Clean-up",
   "url": "https://github.example/northwind/storefront-web/pull/3830",
   "state": "merged"
  },
  {
   "label": "PR #3838 First slice",
   "url": "https://github.example/northwind/storefront-web/pull/3838",
   "state": "open"
  },
  {
   "label": "Sentry STOREFRONT-9DC",
   "url": "",
   "state": "in Intake"
  },
  {
   "label": "SHOP-302",
   "url": "https://tracker.example/northwind/issue/SHOP-302",
   "state": "Triage"
  }
 ],
 "threads": [
  {
   "title": "Can coupons stack with loyalty points?",
   "id": "b745da1d"
  }
 ],
 "confidence": "medium",
 "createdAt": "2026-10-01",
 "lastActivityAt": "2026-10-11",
 "initiative": "",
 "kind": "thread",
 "source": "thread",
 "topic": "Coupons and points",
 "zone": "Promotions"
},
{
 "id": "substitutions",
 "name": "Substitutions when an item runs out",
 "project": "storefront",
 "what": "Let shoppers accept or refuse a swap before the driver leaves.",
 "where": "Three designs sketched. Depot staff worry about the extra time at packing.",
 "left": "Pick a design and try it at one depot",
 "ask": "Which depot should try it first?",
 "context": [
  "One of the two approaches needs a database change, the other does not",
  "An agent read the code and found 25 places that would have to change",
  "About 28% of shoppers would notice, mostly on phones"
 ],
 "options": [
  "Wait until after the spring sale",
  "Get a quote",
  "Write the rule down first"
 ],
 "move": "you",
 "need": "think",
 "stage": "planned",
 "stalled": true,
 "whyStalled": "The depots were never asked, and each design changes their packing line.",
 "links": [
  {
   "label": "Issue #3850",
   "url": "https://github.example/northwind/storefront-web/issues/3850",
   "state": "open"
  },
  {
   "label": "SHOP-312",
   "url": "https://tracker.example/northwind/issue/SHOP-312",
   "state": "Todo"
  },
  {
   "label": "PR #3861 Draft",
   "url": "https://github.example/northwind/storefront-web/pull/3861",
   "state": "open"
  }
 ],
 "threads": [
  {
   "title": "Substitutions when an item runs out",
   "id": "7bd3061d"
  }
 ],
 "confidence": "low",
 "createdAt": "2026-10-09",
 "lastActivityAt": "2026-10-09",
 "initiative": "",
 "kind": "thread",
 "source": "thread",
 "topic": "Substitutions",
 "zone": "Delivery"
},
{
 "id": "slot-rush",
 "name": "Delivery slot page feels slow at noon",
 "project": "storefront",
 "what": "Find why the slot page crawls during the lunchtime rush.",
 "where": "A cache is in review. Slot lookups were 70% of the database load at peak.",
 "left": "Merge the cache and compare next Tuesday",
 "ask": "Is five minutes of stale slots acceptable?",
 "context": [
  "The numbers look better on weekdays, so a weekend trial may mislead",
  "The product team says a rival shop already does this",
  "There is a cheap version that covers most cases"
 ],
 "options": [
  "Raise it at the Thursday planning call",
  "Get a quote"
 ],
 "move": "you",
 "need": "quick",
 "stage": "reviewing",
 "stalled": false,
 "whyStalled": "",
 "links": [
  {
   "label": "Issue #3863",
   "url": "https://github.example/northwind/storefront-web/issues/3863",
   "state": "open"
  }
 ],
 "threads": [
  {
   "title": "Delivery slot page feels slow at noon",
   "id": "8ff7416d"
  }
 ],
 "confidence": "low",
 "createdAt": "2026-10-21",
 "lastActivityAt": "2026-10-31",
 "initiative": "",
 "kind": "thread",
 "source": "thread",
 "topic": "Delivery slots",
 "zone": "Delivery"
},
{
 "id": "image-sizes",
 "name": "Serve smaller product photos",
 "project": "storefront",
 "what": "Send each device a photo of the right size.",
 "where": "Started, then paused. The resizing service handles about half the range so far.",
 "left": "Move the remaining photos",
 "ask": "Keep the originals, or drop them after a month?",
 "context": [
  "Support logged 6 contacts about this in the last month",
  "It would take roughly 39 days of agent time, plus review",
  "Whoever picks this up will need access to the staging tools"
 ],
 "options": [
  "Raise it at the Thursday planning call",
  "Wait until after the spring sale",
  "Time-box it to one week"
 ],
 "move": "you",
 "need": "quick",
 "stage": "building",
 "stalled": true,
 "whyStalled": "",
 "links": [
  {
   "label": "Issue #3864",
   "url": "https://github.example/northwind/storefront-web/issues/3864",
   "state": "open"
  },
  {
   "label": "Issue #3865",
   "url": "https://github.example/northwind/storefront-web/issues/3865",
   "state": "open"
  },
  {
   "label": "Sentry STOREFRONT-E74",
   "url": "",
   "state": "in Intake"
  },
  {
   "label": "PR #3876 Small fix",
   "url": "https://github.example/northwind/storefront-web/pull/3876",
   "state": "open"
  },
  {
   "label": "PR #3880 Spike",
   "url": "https://github.example/northwind/storefront-web/pull/3880",
   "state": "open"
  },
  {
   "label": "SHOP-338",
   "url": "https://tracker.example/northwind/issue/SHOP-338",
   "state": "Triage"
  },
  {
   "label": "PR #3886 Small fix",
   "url": "https://github.example/northwind/storefront-web/pull/3886",
   "state": "closed"
  },
  {
   "label": "PR #3895 Spike",
   "url": "https://github.example/northwind/storefront-web/pull/3895",
   "state": "merged"
  },
  {
   "label": "Issue #3896",
   "url": "https://github.example/northwind/storefront-web/issues/3896",
   "state": "open"
  }
 ],
 "threads": [
  {
   "title": "Serve smaller product photos",
   "id": "fef9a6b2"
  },
  {
   "title": "Second look at serve smaller product photos",
   "id": "bc9bcbab"
  }
 ],
 "confidence": "low",
 "createdAt": "2026-10-01",
 "lastActivityAt": "2026-10-11",
 "initiative": "",
 "kind": "thread",
 "source": "thread",
 "topic": "Product photos",
 "zone": "Product photos"
},
{
 "id": "guest-checkout",
 "name": "Guest checkout without an account",
 "project": "storefront",
 "what": "Let a first-time shopper pay without creating an account.",
 "where": "Product wants it for the spring sale. Order history and returns need a plan for guests.",
 "left": "A plan for returns by guests",
 "ask": "Is an email link enough for guest returns?",
 "context": [
  "Two earlier threads reached this same question and stopped there",
  "One of the two approaches needs a database change, the other does not",
  "The last attempt stopped when its owner moved teams"
 ],
 "options": [
  "Raise it at the Thursday planning call",
  "Ship the small version first",
  "Wait until after the spring sale"
 ],
 "move": "you",
 "need": "quick",
 "stage": "planned",
 "stalled": true,
 "whyStalled": "It waits on the basket merge question.",
 "links": [],
 "threads": [
  {
   "title": "Guest checkout without an account",
   "id": "5521ec76"
  }
 ],
 "confidence": "medium",
 "createdAt": "2026-10-07",
 "lastActivityAt": "2026-10-19",
 "initiative": "",
 "kind": "thread",
 "source": "thread",
 "topic": "Guest shoppers",
 "zone": "Accounts"
},
{
 "id": "basket-restore",
 "name": "Restore a basket after sign-in",
 "project": "storefront",
 "what": "Merge a guest basket into the account basket on sign-in.",
 "where": "One question is left on the PR: which quantity wins when both baskets hold an item.",
 "left": "Answer the quantity question",
 "ask": "Highest quantity, or add them together?",
 "context": [
  "The depot managers have not been asked yet",
  "The product team says a rival shop already does this",
  "The team would rather ship a small version first and learn from it"
 ],
 "options": [
  "Try it at one depot",
  "Drop it for now"
 ],
 "move": "you",
 "need": "quick",
 "stage": "reviewing",
 "stalled": false,
 "whyStalled": "",
 "links": [],
 "threads": [
  {
   "title": "Restore a basket after sign-in",
   "id": "0223c931"
  }
 ],
 "confidence": "medium",
 "createdAt": "2026-10-23",
 "lastActivityAt": "2026-10-31",
 "initiative": "",
 "kind": "thread",
 "source": "thread",
 "topic": "Guest shoppers",
 "zone": "Basket"
},
{
 "id": "depot-labels",
 "name": "Return labels at the depot",
 "project": "ops",
 "what": "Let depot staff print a label for a return made in person.",
 "where": "Label printers are in two of five depots. The vendor quote is in the shared folder.",
 "left": "Look at the vendor quote",
 "ask": "Look over the printer quote.",
 "context": [
  "I could not confirm the numbers: they come from a single week",
  "There is a cheap version that covers most cases"
 ],
 "options": [
  "Wait until after the spring sale",
  "Raise it at the Thursday planning call",
  "Drop it for now"
 ],
 "move": "you",
 "need": "look",
 "stage": "planned",
 "stalled": true,
 "whyStalled": "The quote expired and nobody asked for a new one.",
 "links": [
  {
   "label": "Sentry OPS-8A3",
   "url": "",
   "state": "in Intake"
  },
  {
   "label": "PR #3906 Clean-up",
   "url": "https://github.example/northwind/ops-console/pull/3906",
   "state": "closed"
  }
 ],
 "threads": [
  {
   "title": "Return labels at the depot",
   "id": "5a4fddfa"
  }
 ],
 "confidence": "medium",
 "createdAt": "2026-10-07",
 "lastActivityAt": "2026-10-15",
 "initiative": "returns",
 "kind": "thread",
 "source": "thread",
 "topic": "Depot returns",
 "zone": "Depot tools"
},
{
 "id": "offline-proof",
 "name": "Proof of delivery while offline",
 "project": "field-app",
 "what": "Keep photos and signatures on the phone until the signal comes back.",
 "where": "Drivers lose about one proof in forty on rural routes. Storage on old phones is the open risk.",
 "left": "Decide how long the phone keeps a proof",
 "ask": "How many days should a phone keep proofs?",
 "context": [
  "Two earlier threads reached this same question and stopped there",
  "The depot managers have not been asked yet",
  "The change is small in code and large in what people must relearn"
 ],
 "options": [
  "Ship the small version first",
  "Wait until after the spring sale",
  "Drop it for now"
 ],
 "move": "you",
 "need": "think",
 "stage": "exploring",
 "stalled": true,
 "whyStalled": "Needs a look at the phones drivers really carry.",
 "links": [],
 "threads": [
  {
   "title": "Proof of delivery while offline",
   "id": "d3af460a"
  }
 ],
 "confidence": "medium",
 "createdAt": "2026-10-07",
 "lastActivityAt": "2026-10-10",
 "initiative": "",
 "kind": "thread",
 "source": "thread",
 "topic": "Driver tools",
 "zone": "Driver app"
},
{
 "id": "rv-6204",
 "name": "Cache delivery slot lookups for five minutes",
 "project": "storefront",
 "what": "A pull request is waiting for your review.",
 "where": "Review requested by juno-park on 2026-10-30. Nobody has picked it up.",
 "left": "A review",
 "ask": "Hand it to the review workflow?",
 "context": [],
 "options": [
  "Hand it to the review workflow",
  "Read it yourself"
 ],
 "move": "you",
 "need": "quick",
 "stage": "reviewing",
 "stalled": true,
 "whyStalled": "It looks long, and each visit ends before the end of the diff.",
 "links": [
  {
   "label": "PR #6204",
   "url": "https://github.example/northwind/storefront-web/pull/6204",
   "state": "open"
  }
 ],
 "threads": [],
 "confidence": "high",
 "createdAt": "2026-10-30",
 "lastActivityAt": "2026-10-30",
 "initiative": "",
 "kind": "review",
 "source": "signal",
 "topic": "Delivery slots",
 "zone": "Delivery"
},
{
 "id": "rv-6209",
 "name": "Split the basket summary into smaller components",
 "project": "storefront",
 "what": "A pull request is waiting for your review.",
 "where": "Review requested by felix-marsh on 2026-10-30. Nobody has picked it up.",
 "left": "A review",
 "ask": "Hand it to the review workflow?",
 "context": [],
 "options": [
  "Hand it to the review workflow",
  "Read it yourself"
 ],
 "move": "you",
 "need": "quick",
 "stage": "reviewing",
 "stalled": true,
 "whyStalled": "It looks long, and each visit ends before the end of the diff.",
 "links": [
  {
   "label": "PR #6209",
   "url": "https://github.example/northwind/storefront-web/pull/6209",
   "state": "open"
  }
 ],
 "threads": [],
 "confidence": "high",
 "createdAt": "2026-10-30",
 "lastActivityAt": "2026-10-30",
 "initiative": "",
 "kind": "review",
 "source": "signal",
 "topic": "Clean-up",
 "zone": "Basket"
},
{
 "id": "rv-6213",
 "name": "Show unit prices on multi-buy offers",
 "project": "storefront",
 "what": "A pull request is waiting for your review.",
 "where": "Review requested by felix-marsh on 2026-10-30. Nobody has picked it up.",
 "left": "A review",
 "ask": "Hand it to the review workflow?",
 "context": [],
 "options": [
  "Hand it to the review workflow",
  "Read it yourself"
 ],
 "move": "you",
 "need": "quick",
 "stage": "reviewing",
 "stalled": true,
 "whyStalled": "It looks long, and each visit ends before the end of the diff.",
 "links": [
  {
   "label": "PR #6213",
   "url": "https://github.example/northwind/storefront-web/pull/6213",
   "state": "open"
  }
 ],
 "threads": [],
 "confidence": "high",
 "createdAt": "2026-10-30",
 "lastActivityAt": "2026-10-30",
 "initiative": "",
 "kind": "review",
 "source": "signal",
 "topic": "Money paths",
 "zone": "Shop front"
},
{
 "id": "rv-6238",
 "name": "Retry card payments once on a gateway timeout",
 "project": "storefront",
 "what": "A pull request is waiting for your review.",
 "where": "Review requested by ines-carvalho on 2026-11-03. Nobody has picked it up.",
 "left": "A review",
 "ask": "Hand it to the review workflow?",
 "context": [],
 "options": [
  "Hand it to the review workflow",
  "Read it yourself"
 ],
 "move": "you",
 "need": "quick",
 "stage": "reviewing",
 "stalled": false,
 "whyStalled": "",
 "links": [
  {
   "label": "PR #6238",
   "url": "https://github.example/northwind/storefront-web/pull/6238",
   "state": "open"
  }
 ],
 "threads": [],
 "confidence": "high",
 "createdAt": "2026-11-03",
 "lastActivityAt": "2026-11-03",
 "initiative": "",
 "kind": "review",
 "source": "signal",
 "topic": "Money paths",
 "zone": "Checkout"
},
{
 "id": "rv-6241",
 "name": "Drop the unused wishlist endpoints",
 "project": "storefront",
 "what": "A pull request is waiting for your review.",
 "where": "Review requested by theo-brandt on 2026-11-03. Nobody has picked it up.",
 "left": "A review",
 "ask": "Hand it to the review workflow?",
 "context": [],
 "options": [
  "Hand it to the review workflow",
  "Read it yourself"
 ],
 "move": "you",
 "need": "quick",
 "stage": "reviewing",
 "stalled": false,
 "whyStalled": "",
 "links": [
  {
   "label": "PR #6241",
   "url": "https://github.example/northwind/storefront-web/pull/6241",
   "state": "open"
  }
 ],
 "threads": [],
 "confidence": "high",
 "createdAt": "2026-11-03",
 "lastActivityAt": "2026-11-03",
 "initiative": "",
 "kind": "review",
 "source": "signal",
 "topic": "Clean-up",
 "zone": "Accounts"
},
{
 "id": "rv-6252",
 "name": "Move promo banner copy into the content tool",
 "project": "storefront",
 "what": "A pull request is waiting for your review.",
 "where": "Review requested by wren-adeyemi on 2026-11-04. Nobody has picked it up.",
 "left": "A review",
 "ask": "Hand it to the review workflow?",
 "context": [],
 "options": [
  "Hand it to the review workflow",
  "Read it yourself"
 ],
 "move": "you",
 "need": "quick",
 "stage": "reviewing",
 "stalled": false,
 "whyStalled": "",
 "links": [
  {
   "label": "PR #6252",
   "url": "https://github.example/northwind/storefront-web/pull/6252",
   "state": "open"
  }
 ],
 "threads": [],
 "confidence": "high",
 "createdAt": "2026-11-04",
 "lastActivityAt": "2026-11-04",
 "initiative": "",
 "kind": "review",
 "source": "signal",
 "topic": "Clean-up",
 "zone": "Promotions"
},
{
 "id": "rv-6255",
 "name": "Add a loading state to the address finder",
 "project": "storefront",
 "what": "A pull request is waiting for your review.",
 "where": "Review requested by juno-park on 2026-11-04. Nobody has picked it up.",
 "left": "A review",
 "ask": "Hand it to the review workflow?",
 "context": [],
 "options": [
  "Hand it to the review workflow",
  "Read it yourself"
 ],
 "move": "you",
 "need": "quick",
 "stage": "reviewing",
 "stalled": false,
 "whyStalled": "",
 "links": [
  {
   "label": "PR #6255",
   "url": "https://github.example/northwind/storefront-web/pull/6255",
   "state": "open"
  }
 ],
 "threads": [],
 "confidence": "high",
 "createdAt": "2026-11-04",
 "lastActivityAt": "2026-11-04",
 "initiative": "",
 "kind": "review",
 "source": "signal",
 "topic": "Speed",
 "zone": "Checkout"
},
{
 "id": "rv-6257",
 "name": "Round loyalty points down at checkout",
 "project": "storefront",
 "what": "A pull request is waiting for your review.",
 "where": "Review requested by kofi-mensah on 2026-11-04. Nobody has picked it up.",
 "left": "A review",
 "ask": "Hand it to the review workflow?",
 "context": [],
 "options": [
  "Hand it to the review workflow",
  "Read it yourself"
 ],
 "move": "you",
 "need": "quick",
 "stage": "reviewing",
 "stalled": false,
 "whyStalled": "",
 "links": [
  {
   "label": "PR #6257",
   "url": "https://github.example/northwind/storefront-web/pull/6257",
   "state": "open"
  }
 ],
 "threads": [],
 "confidence": "high",
 "createdAt": "2026-11-04",
 "lastActivityAt": "2026-11-04",
 "initiative": "",
 "kind": "review",
 "source": "signal",
 "topic": "Coupons and points",
 "zone": "Promotions"
},
{
 "id": "rv-6258",
 "name": "Stop sending duplicate order emails",
 "project": "storefront",
 "what": "A pull request is waiting for your review.",
 "where": "Review requested by tessa-lindqvist on 2026-11-04. Nobody has picked it up.",
 "left": "A review",
 "ask": "Hand it to the review workflow?",
 "context": [],
 "options": [
  "Hand it to the review workflow",
  "Read it yourself"
 ],
 "move": "you",
 "need": "quick",
 "stage": "reviewing",
 "stalled": false,
 "whyStalled": "",
 "links": [
  {
   "label": "PR #6258",
   "url": "https://github.example/northwind/storefront-web/pull/6258",
   "state": "open"
  }
 ],
 "threads": [],
 "confidence": "high",
 "createdAt": "2026-11-04",
 "lastActivityAt": "2026-11-04",
 "initiative": "",
 "kind": "review",
 "source": "signal",
 "topic": "Clean-up",
 "zone": "Checkout"
},
{
 "id": "rv-6260",
 "name": "Log the reason when a coupon is refused",
 "project": "storefront",
 "what": "A pull request is waiting for your review.",
 "where": "Review requested by ines-carvalho on 2026-11-04. Nobody has picked it up.",
 "left": "A review",
 "ask": "Hand it to the review workflow?",
 "context": [],
 "options": [
  "Hand it to the review workflow",
  "Read it yourself"
 ],
 "move": "you",
 "need": "quick",
 "stage": "reviewing",
 "stalled": false,
 "whyStalled": "",
 "links": [
  {
   "label": "PR #6260",
   "url": "https://github.example/northwind/storefront-web/pull/6260",
   "state": "open"
  }
 ],
 "threads": [],
 "confidence": "high",
 "createdAt": "2026-11-04",
 "lastActivityAt": "2026-11-04",
 "initiative": "",
 "kind": "review",
 "source": "signal",
 "topic": "Coupons and points",
 "zone": "Promotions"
},
{
 "id": "rv-6263",
 "name": "Refund delivery on a fully returned order",
 "project": "storefront",
 "what": "A pull request is waiting for your review.",
 "where": "Review requested by kofi-mensah on 2026-11-04. Nobody has picked it up.",
 "left": "A review",
 "ask": "Hand it to the review workflow?",
 "context": [],
 "options": [
  "Hand it to the review workflow",
  "Read it yourself"
 ],
 "move": "you",
 "need": "quick",
 "stage": "reviewing",
 "stalled": false,
 "whyStalled": "",
 "links": [
  {
   "label": "PR #6263",
   "url": "https://github.example/northwind/storefront-web/pull/6263",
   "state": "open"
  }
 ],
 "threads": [],
 "confidence": "high",
 "createdAt": "2026-11-04",
 "lastActivityAt": "2026-11-04",
 "initiative": "",
 "kind": "review",
 "source": "signal",
 "topic": "Money paths",
 "zone": "Checkout"
},
{
 "id": "rv-6266",
 "name": "Remove the old store credit page",
 "project": "storefront",
 "what": "A pull request is waiting for your review.",
 "where": "Review requested by wren-adeyemi on 2026-11-04. Nobody has picked it up.",
 "left": "A review",
 "ask": "Hand it to the review workflow?",
 "context": [],
 "options": [
  "Hand it to the review workflow",
  "Read it yourself"
 ],
 "move": "you",
 "need": "quick",
 "stage": "reviewing",
 "stalled": false,
 "whyStalled": "",
 "links": [
  {
   "label": "PR #6266",
   "url": "https://github.example/northwind/storefront-web/pull/6266",
   "state": "open"
  }
 ],
 "threads": [],
 "confidence": "high",
 "createdAt": "2026-11-04",
 "lastActivityAt": "2026-11-04",
 "initiative": "",
 "kind": "review",
 "source": "signal",
 "topic": "Clean-up",
 "zone": "Accounts"
},
{
 "id": "pr-multibuy",
 "name": "Move multi-buy rules into the price engine",
 "project": "storefront",
 "what": "Move multi-buy rules into the price engine.",
 "where": "PR #6118 open since 2026-10-15. Fix the checks.",
 "left": "Get it reviewed, then merge",
 "ask": "Fix the checks on #6118?",
 "context": [],
 "options": [
  "Merge as it is",
  "Split it first"
 ],
 "move": "you",
 "need": "quick",
 "stage": "reviewing",
 "stalled": true,
 "whyStalled": "No one was asked directly, so it waits for a volunteer.",
 "links": [
  {
   "label": "PR #6118",
   "url": "https://github.example/northwind/storefront-web/pull/6118",
   "state": "open"
  }
 ],
 "threads": [],
 "confidence": "high",
 "createdAt": "2026-10-15",
 "lastActivityAt": "2026-10-27",
 "initiative": "priceengine",
 "kind": "pr",
 "source": "pr",
 "topic": "",
 "zone": "Price engine"
},
{
 "id": "pr-weighed",
 "name": "Price engine: handle weighed items",
 "project": "storefront",
 "what": "Price engine: handle weighed items.",
 "where": "PR #6147 open since 2026-10-22. Waiting for a review.",
 "left": "Get it reviewed, then merge",
 "ask": "",
 "context": [],
 "options": [
  "Merge as it is",
  "Split it first"
 ],
 "move": "others",
 "need": "look",
 "stage": "reviewing",
 "stalled": false,
 "whyStalled": "",
 "links": [
  {
   "label": "PR #6147",
   "url": "https://github.example/northwind/storefront-web/pull/6147",
   "state": "open"
  }
 ],
 "threads": [],
 "confidence": "high",
 "createdAt": "2026-10-22",
 "lastActivityAt": "2026-11-02",
 "initiative": "priceengine",
 "kind": "pr",
 "source": "pr",
 "topic": "",
 "zone": "Price engine"
},
{
 "id": "pr-breakdown",
 "name": "Show the price breakdown in the basket",
 "project": "storefront",
 "what": "Show the price breakdown in the basket.",
 "where": "PR #6171 open since 2026-10-27. Waiting for a review.",
 "left": "Get it reviewed, then merge",
 "ask": "",
 "context": [],
 "options": [],
 "move": "others",
 "need": "look",
 "stage": "reviewing",
 "stalled": false,
 "whyStalled": "",
 "links": [
  {
   "label": "PR #6171",
   "url": "https://github.example/northwind/storefront-web/pull/6171",
   "state": "open"
  }
 ],
 "threads": [],
 "confidence": "high",
 "createdAt": "2026-10-27",
 "lastActivityAt": "2026-11-04",
 "initiative": "priceengine",
 "kind": "pr",
 "source": "pr",
 "topic": "",
 "zone": "Basket"
},
{
 "id": "pr-qty-labels",
 "name": "Label the quantity buttons for screen readers",
 "project": "storefront",
 "what": "Label the quantity buttons for screen readers.",
 "where": "PR #6189 open since 2026-10-29. Ready to merge.",
 "left": "Press merge",
 "ask": "Ready to merge on #6189?",
 "context": [],
 "options": [],
 "move": "you",
 "need": "quick",
 "stage": "reviewing",
 "stalled": false,
 "whyStalled": "",
 "links": [
  {
   "label": "PR #6189",
   "url": "https://github.example/northwind/storefront-web/pull/6189",
   "state": "open"
  }
 ],
 "threads": [],
 "confidence": "high",
 "createdAt": "2026-10-29",
 "lastActivityAt": "2026-11-02",
 "initiative": "a11y",
 "kind": "pr",
 "source": "pr",
 "topic": "Clean-up",
 "zone": "Basket"
},
{
 "id": "pr-lazy-photos",
 "name": "Lazy-load photos below the fold",
 "project": "storefront",
 "what": "Lazy-load photos below the fold.",
 "where": "PR #6135 open since 2026-10-20. Waiting for a review.",
 "left": "Get it reviewed, then merge",
 "ask": "",
 "context": [],
 "options": [],
 "move": "others",
 "need": "look",
 "stage": "reviewing",
 "stalled": true,
 "whyStalled": "No one was asked directly, so it waits for a volunteer.",
 "links": [
  {
   "label": "PR #6135",
   "url": "https://github.example/northwind/storefront-web/pull/6135",
   "state": "open"
  }
 ],
 "threads": [],
 "confidence": "high",
 "createdAt": "2026-10-20",
 "lastActivityAt": "2026-10-24",
 "initiative": "",
 "kind": "pr",
 "source": "pr",
 "topic": "Product photos",
 "zone": "Product photos"
},
{
 "id": "pr-font",
 "name": "Preload the checkout font",
 "project": "storefront",
 "what": "Preload the checkout font.",
 "where": "PR #6162 open since 2026-10-25. Waiting for a review.",
 "left": "Get it reviewed, then merge",
 "ask": "",
 "context": [],
 "options": [],
 "move": "others",
 "need": "look",
 "stage": "reviewing",
 "stalled": false,
 "whyStalled": "",
 "links": [
  {
   "label": "PR #6162",
   "url": "https://github.example/northwind/storefront-web/pull/6162",
   "state": "open"
  }
 ],
 "threads": [],
 "confidence": "high",
 "createdAt": "2026-10-25",
 "lastActivityAt": "2026-11-04",
 "initiative": "",
 "kind": "pr",
 "source": "pr",
 "topic": "Speed",
 "zone": "Shop front"
},
{
 "id": "pr-address-form",
 "name": "Shorten the address form",
 "project": "storefront",
 "what": "Shorten the address form.",
 "where": "PR #6195 open since 2026-10-30. Address requested changes.",
 "left": "Get it reviewed, then merge",
 "ask": "Address requested changes on #6195?",
 "context": [],
 "options": [],
 "move": "you",
 "need": "quick",
 "stage": "reviewing",
 "stalled": false,
 "whyStalled": "",
 "links": [
  {
   "label": "PR #6195",
   "url": "https://github.example/northwind/storefront-web/pull/6195",
   "state": "open"
  }
 ],
 "threads": [],
 "confidence": "high",
 "createdAt": "2026-10-30",
 "lastActivityAt": "2026-11-02",
 "initiative": "",
 "kind": "pr",
 "source": "pr",
 "topic": "Speed",
 "zone": "Checkout"
},
{
 "id": "pr-report-runner",
 "name": "Run the invoice export on the new job runner",
 "project": "platform",
 "what": "Run the invoice export on the new job runner.",
 "where": "PR #3318 open since 2026-10-29. Fix the checks.",
 "left": "Get it reviewed, then merge",
 "ask": "Fix the checks on #3318?",
 "context": [],
 "options": [],
 "move": "you",
 "need": "quick",
 "stage": "reviewing",
 "stalled": false,
 "whyStalled": "",
 "links": [
  {
   "label": "PR #3318",
   "url": "https://github.example/northwind/platform-core/pull/3318",
   "state": "open"
  }
 ],
 "threads": [],
 "confidence": "high",
 "createdAt": "2026-10-29",
 "lastActivityAt": "2026-11-03",
 "initiative": "scheduler",
 "kind": "pr",
 "source": "pr",
 "topic": "",
 "zone": "Job runner"
},
{
 "id": "pr-fake-clock",
 "name": "Freeze time in the order expiry tests",
 "project": "platform",
 "what": "Freeze time in the order expiry tests.",
 "where": "PR #3331 open since 2026-11-02. Waiting for a review.",
 "left": "Get it reviewed, then merge",
 "ask": "",
 "context": [],
 "options": [],
 "move": "others",
 "need": "look",
 "stage": "reviewing",
 "stalled": false,
 "whyStalled": "",
 "links": [
  {
   "label": "PR #3331",
   "url": "https://github.example/northwind/platform-core/pull/3331",
   "state": "open"
  }
 ],
 "threads": [],
 "confidence": "high",
 "createdAt": "2026-11-02",
 "lastActivityAt": "2026-11-02",
 "initiative": "flaky",
 "kind": "pr",
 "source": "pr",
 "topic": "Upkeep",
 "zone": "Test rigs"
},
{
 "id": "pr-gateway-debug",
 "name": "Drop debug logging from the gateway",
 "project": "platform",
 "what": "Drop debug logging from the gateway.",
 "where": "PR #3299 open since 2026-10-23. Fix the checks.",
 "left": "Get it reviewed, then merge",
 "ask": "Fix the checks on #3299?",
 "context": [],
 "options": [],
 "move": "you",
 "need": "quick",
 "stage": "reviewing",
 "stalled": true,
 "whyStalled": "No one was asked directly, so it waits for a volunteer.",
 "links": [
  {
   "label": "PR #3299",
   "url": "https://github.example/northwind/platform-core/pull/3299",
   "state": "open"
  }
 ],
 "threads": [],
 "confidence": "high",
 "createdAt": "2026-10-23",
 "lastActivityAt": "2026-10-26",
 "initiative": "",
 "kind": "pr",
 "source": "pr",
 "topic": "Cost control",
 "zone": "Gateway"
},
{
 "id": "pr-rollup",
 "name": "Nightly basket size rollup",
 "project": "Insights",
 "what": "Nightly basket size rollup.",
 "where": "PR #1487 open since 2026-11-03. Waiting for a review.",
 "left": "Get it reviewed, then merge",
 "ask": "",
 "context": [],
 "options": [],
 "move": "others",
 "need": "look",
 "stage": "reviewing",
 "stalled": false,
 "whyStalled": "",
 "links": [
  {
   "label": "PR #1487",
   "url": "https://github.example/northwind/insights-jobs/pull/1487",
   "state": "open"
  }
 ],
 "threads": [],
 "confidence": "high",
 "createdAt": "2026-11-03",
 "lastActivityAt": "2026-11-04",
 "initiative": "",
 "kind": "pr",
 "source": "pr",
 "topic": "Reporting",
 "zone": "Reports"
},
{
 "id": "mn-6088",
 "name": "Agree a naming rule for feature flags",
 "project": "storefront",
 "what": "Someone tagged you on this PR.",
 "where": "You were tagged on 2026-10-23. The PR has not merged.",
 "left": "Read the comment",
 "ask": "Read the comment. Does it need you?",
 "context": [],
 "options": [],
 "move": "you",
 "need": "look",
 "stage": "reviewing",
 "stalled": false,
 "whyStalled": "",
 "links": [
  {
   "label": "PR #6088",
   "url": "https://github.example/northwind/storefront-web/pull/6088",
   "state": "open"
  }
 ],
 "threads": [],
 "confidence": "high",
 "createdAt": "2026-10-23",
 "lastActivityAt": "2026-10-23",
 "initiative": "",
 "kind": "mention",
 "source": "signal",
 "topic": "Clean-up",
 "zone": "Shop front"
},
{
 "id": "mn-6126",
 "name": "Move the order schema to the shared package",
 "project": "storefront",
 "what": "Someone tagged you on this PR.",
 "where": "You were tagged on 2026-10-31. The PR has not merged.",
 "left": "Read the comment",
 "ask": "Read the comment. Does it need you?",
 "context": [],
 "options": [],
 "move": "you",
 "need": "look",
 "stage": "reviewing",
 "stalled": false,
 "whyStalled": "",
 "links": [
  {
   "label": "PR #6126",
   "url": "https://github.example/northwind/storefront-web/pull/6126",
   "state": "open"
  }
 ],
 "threads": [],
 "confidence": "high",
 "createdAt": "2026-10-31",
 "lastActivityAt": "2026-10-31",
 "initiative": "",
 "kind": "mention",
 "source": "signal",
 "topic": "Clean-up",
 "zone": "Checkout"
},
{
 "id": "mn-6079",
 "name": "Reword the cookie banner",
 "project": "storefront",
 "what": "Someone tagged you on this PR.",
 "where": "You were tagged on 2026-10-18. The PR has merged since.",
 "left": "Nothing",
 "ask": "",
 "context": [],
 "options": [],
 "move": "nobody",
 "need": "nothing",
 "stage": "landed",
 "stalled": false,
 "whyStalled": "",
 "links": [
  {
   "label": "PR #6079",
   "url": "https://github.example/northwind/storefront-web/pull/6079",
   "state": "merged"
  }
 ],
 "threads": [],
 "confidence": "high",
 "createdAt": "2026-10-18",
 "lastActivityAt": "2026-10-18",
 "initiative": "",
 "kind": "mention",
 "source": "signal",
 "topic": "Clean-up",
 "zone": "Shop front"
},
{
 "id": "t-crate-scan",
 "name": "Scan a returned crate at the depot door",
 "project": "ops",
 "what": "Scan a returned crate at the depot door (OPS-41).",
 "where": "On your list since 2026-10-17. No work has started.",
 "left": "Everything",
 "ask": "Let an agent take it as written, or tighten it first?",
 "context": [],
 "options": [
  "Let an agent take it",
  "Tighten it first"
 ],
 "move": "you",
 "need": "think",
 "stage": "planned",
 "stalled": true,
 "whyStalled": "It has no answer yet on what the depot tool can send.",
 "links": [
  {
   "label": "OPS-41",
   "url": "https://tracker.example/northwind/issue/OPS-41",
   "state": "Triage"
  }
 ],
 "threads": [],
 "confidence": "medium",
 "createdAt": "2026-10-17",
 "lastActivityAt": "2026-10-26",
 "initiative": "returns",
 "kind": "ticket",
 "source": "task",
 "topic": "",
 "zone": "Depot tools"
},
{
 "id": "t-label-queue",
 "name": "Print a return label without a print queue",
 "project": "ops",
 "what": "Print a return label without a print queue (OPS-44).",
 "where": "On your list since 2026-10-18. No work has started.",
 "left": "Everything",
 "ask": "",
 "context": [],
 "options": [],
 "move": "nobody",
 "need": "nothing",
 "stage": "planned",
 "stalled": true,
 "whyStalled": "It has no answer yet on what the depot tool can send.",
 "links": [
  {
   "label": "OPS-44",
   "url": "https://tracker.example/northwind/issue/OPS-44",
   "state": "Triage"
  }
 ],
 "threads": [],
 "confidence": "medium",
 "createdAt": "2026-10-18",
 "lastActivityAt": "2026-10-25",
 "initiative": "returns",
 "kind": "ticket",
 "source": "task",
 "topic": "",
 "zone": "Depot tools"
},
{
 "id": "t-depot-refund",
 "name": "Start the refund when the depot confirms",
 "project": "ops",
 "what": "Start the refund when the depot confirms (OPS-47).",
 "where": "On your list since 2026-10-24. No work has started.",
 "left": "Everything",
 "ask": "",
 "context": [],
 "options": [],
 "move": "nobody",
 "need": "nothing",
 "stage": "planned",
 "stalled": true,
 "whyStalled": "",
 "links": [
  {
   "label": "OPS-47",
   "url": "https://tracker.example/northwind/issue/OPS-47",
   "state": "Triage"
  }
 ],
 "threads": [],
 "confidence": "medium",
 "createdAt": "2026-10-24",
 "lastActivityAt": "2026-10-21",
 "initiative": "returns",
 "kind": "ticket",
 "source": "task",
 "topic": "",
 "zone": "Depot tools"
},
{
 "id": "t-return-reason",
 "name": "Show depot staff why an item came back",
 "project": "ops",
 "what": "Show depot staff why an item came back (OPS-52).",
 "where": "On your list since 2026-10-26. No work has started.",
 "left": "Everything",
 "ask": "",
 "context": [],
 "options": [],
 "move": "nobody",
 "need": "nothing",
 "stage": "exploring",
 "stalled": false,
 "whyStalled": "",
 "links": [
  {
   "label": "OPS-52",
   "url": "https://tracker.example/northwind/issue/OPS-52",
   "state": "Todo"
  }
 ],
 "threads": [],
 "confidence": "medium",
 "createdAt": "2026-10-26",
 "lastActivityAt": "2026-11-02",
 "initiative": "returns",
 "kind": "ticket",
 "source": "signal",
 "topic": "",
 "zone": "Depot tools"
},
{
 "id": "t-browser-retry",
 "name": "Agree a retry rule for browser tests",
 "project": "platform",
 "what": "Agree a retry rule for browser tests (PLAT-118).",
 "where": "On your list since 2026-10-29. No work has started.",
 "left": "Everything",
 "ask": "Let an agent take it as written, or tighten it first?",
 "context": [],
 "options": [],
 "move": "you",
 "need": "quick",
 "stage": "planned",
 "stalled": false,
 "whyStalled": "",
 "links": [
  {
   "label": "PLAT-118",
   "url": "https://tracker.example/northwind/issue/PLAT-118",
   "state": "Triage"
  }
 ],
 "threads": [],
 "confidence": "medium",
 "createdAt": "2026-10-29",
 "lastActivityAt": "2026-11-01",
 "initiative": "flaky",
 "kind": "ticket",
 "source": "signal",
 "topic": "",
 "zone": "Test rigs"
},
{
 "id": "t-focus-trap",
 "name": "Basket drawer traps focus in one browser",
 "project": "storefront",
 "what": "Basket drawer traps focus in one browser (SHOP-318).",
 "where": "On your list since 2026-10-29. No work has started.",
 "left": "Everything",
 "ask": "Let an agent take it as written, or tighten it first?",
 "context": [],
 "options": [],
 "move": "you",
 "need": "quick",
 "stage": "planned",
 "stalled": false,
 "whyStalled": "",
 "links": [
  {
   "label": "SHOP-318",
   "url": "https://tracker.example/northwind/issue/SHOP-318",
   "state": "Triage"
  }
 ],
 "threads": [],
 "confidence": "medium",
 "createdAt": "2026-10-29",
 "lastActivityAt": "2026-11-03",
 "initiative": "a11y",
 "kind": "ticket",
 "source": "task",
 "topic": "",
 "zone": "Basket"
},
{
 "id": "t-typos",
 "name": "Typo tolerance for short search words",
 "project": "storefront",
 "what": "Typo tolerance for short search words (SHOP-342).",
 "where": "On your list since 2026-10-30. No work has started.",
 "left": "Everything",
 "ask": "Let an agent take it as written, or tighten it first?",
 "context": [],
 "options": [
  "Let an agent take it",
  "Tighten it first"
 ],
 "move": "you",
 "need": "think",
 "stage": "exploring",
 "stalled": false,
 "whyStalled": "",
 "links": [
  {
   "label": "SHOP-342",
   "url": "https://tracker.example/northwind/issue/SHOP-342",
   "state": "Todo"
  }
 ],
 "threads": [],
 "confidence": "medium",
 "createdAt": "2026-10-30",
 "lastActivityAt": "2026-11-01",
 "initiative": "search",
 "kind": "ticket",
 "source": "task",
 "topic": "Speed",
 "zone": "Search"
},
{
 "id": "t-cancelled",
 "name": "Order history hides cancelled items",
 "project": "storefront",
 "what": "Order history hides cancelled items (SHOP-355).",
 "where": "On your list since 2026-11-01. No work has started.",
 "left": "Everything",
 "ask": "",
 "context": [],
 "options": [],
 "move": "nobody",
 "need": "nothing",
 "stage": "planned",
 "stalled": false,
 "whyStalled": "",
 "links": [
  {
   "label": "SHOP-355",
   "url": "https://tracker.example/northwind/issue/SHOP-355",
   "state": "Triage"
  }
 ],
 "threads": [],
 "confidence": "medium",
 "createdAt": "2026-11-01",
 "lastActivityAt": "2026-11-01",
 "initiative": "",
 "kind": "ticket",
 "source": "signal",
 "topic": "Clean-up",
 "zone": "Accounts"
},
{
 "id": "renew-cert",
 "name": "Renew the payment gateway certificate",
 "project": "storefront",
 "what": "The gateway certificate runs out in six weeks.",
 "where": "The request is with the vendor. Nothing to do until the file arrives.",
 "left": "Install the new certificate",
 "ask": "",
 "context": [],
 "options": [],
 "move": "nobody",
 "need": "nothing",
 "stage": "building",
 "stalled": false,
 "whyStalled": "",
 "links": [
  {
   "label": "Issue #6271",
   "url": "https://github.example/northwind/storefront-web/issues/6271",
   "state": "open"
  }
 ],
 "threads": [],
 "confidence": "medium",
 "createdAt": "2026-10-25",
 "lastActivityAt": "2026-11-03",
 "initiative": "",
 "kind": "other",
 "source": "task",
 "topic": "Money paths",
 "zone": "Checkout"
},
{
 "id": "load-test",
 "name": "Book a load test for the spring sale",
 "project": "platform",
 "what": "Reserve a window to rehearse sale traffic on staging.",
 "where": "Two dates are free. The job runner move should be finished by then.",
 "left": "Pick a date",
 "ask": "Take the first free date?",
 "context": [],
 "options": [],
 "move": "you",
 "need": "quick",
 "stage": "planned",
 "stalled": false,
 "whyStalled": "",
 "links": [],
 "threads": [],
 "confidence": "medium",
 "createdAt": "2026-10-18",
 "lastActivityAt": "2026-10-29",
 "initiative": "scheduler",
 "kind": "other",
 "source": "task",
 "topic": "",
 "zone": "Staging"
},
{
 "id": "old-exports",
 "name": "What to do with the old report exports",
 "project": "Insights",
 "what": "Three teams still download a file nobody maintains.",
 "where": "The export breaks about once a month. A replacement would take a week.",
 "left": "Keep it, replace it, or switch it off",
 "ask": "Ask the three teams what they use it for?",
 "context": [],
 "options": [],
 "move": "you",
 "need": "think",
 "stage": "exploring",
 "stalled": false,
 "whyStalled": "",
 "links": [],
 "threads": [],
 "confidence": "medium",
 "createdAt": "2026-10-26",
 "lastActivityAt": "2026-11-03",
 "initiative": "",
 "kind": "other",
 "source": "signal",
 "topic": "Reporting",
 "zone": "Reports"
},
{
 "id": "search-feed-errors",
 "name": "Search feed errors after the brand change",
 "project": "storefront",
 "what": "The search index feed started dropping products with no brand.",
 "where": "Sentry shows the error back on every feed run since the brand field became required.",
 "left": "Find the bad records and decide on a default",
 "ask": "Fix the records, or relax the rule?",
 "context": [],
 "options": [
  "Fix the records at the source",
  "Relax the rule for own-label goods",
  "Skip them and report the count"
 ],
 "move": "you",
 "need": "think",
 "stage": "exploring",
 "stalled": false,
 "whyStalled": "",
 "links": [
  {
   "label": "Sentry SEARCH-API-1Z4",
   "url": "",
   "state": "in Intake"
  }
 ],
 "threads": [],
 "confidence": "medium",
 "createdAt": "2026-10-30",
 "lastActivityAt": "2026-11-02",
 "initiative": "search",
 "kind": "errors",
 "source": "signal",
 "topic": "",
 "zone": "Search"
}
];
const INITIATIVES = [
{
 "id": "scheduler",
 "name": "Retire the old job scheduler",
 "project": "platform",
 "intent": "Move every timed job to the new job runner, so the old box can be switched off.",
 "progress": "Job groups moved: 7 of 12",
 "done": 7,
 "total": 12
},
{
 "id": "flaky",
 "name": "Calm the test suite",
 "project": "platform",
 "intent": "Make a red build mean something again.",
 "progress": "Flaky tests fixed: 15 of 18",
 "done": 15,
 "total": 18
},
{
 "id": "priceengine",
 "name": "One price engine",
 "project": "storefront",
 "intent": "Work out every price in one place, for the shop, the basket and the receipt.",
 "progress": "Price rules moved: 11 of 16",
 "done": 11,
 "total": 16
},
{
 "id": "a11y",
 "name": "Accessible checkout",
 "project": "storefront",
 "intent": "Let anyone finish an order with a keyboard or a screen reader.",
 "target": "Every checkout step passes the audit",
 "progress": "Audit findings closed: 18 of 22",
 "done": 18,
 "total": 22
},
{
 "id": "search",
 "name": "Faster search on phones",
 "project": "storefront",
 "intent": "Show useful results quickly on the phones shoppers actually own.",
 "target": "First results within one second on a mid-range phone"
},
{
 "id": "returns",
 "name": "Self-service returns at the depots",
 "project": "ops",
 "intent": "Let a shopper hand a crate back at a depot and get the refund the same day.",
 "progress": "Depots live: 0 of 5",
 "done": 0,
 "total": 5
}
];
const RELATIONS = [{"from":"sched-cutover","to":"sched-retries","kind":"blockedBy"},{"from":"t-depot-refund","to":"t-crate-scan","kind":"blockedBy"},{"from":"t-return-reason","to":"t-crate-scan","kind":"blockedBy"},{"from":"pr-breakdown","to":"pr-weighed","kind":"blockedBy"},{"from":"pr-weighed","to":"price-rounding","kind":"blockedBy"},{"from":"flake-parallel","to":"flake-seeds","kind":"blockedBy"},{"from":"cart-focus","to":"contrast-audit","kind":"linked"},{"from":"search-latency","to":"image-sizes","kind":"linked"},{"from":"search-synonyms","to":"search-feed-errors","kind":"linked"},{"from":"slot-rush","to":"rv-6204","kind":"linked"},{"from":"substitutions","to":"route-order","kind":"linked"},{"from":"offline-proof","to":"image-sizes","kind":"linked"},{"from":"flake-browser","to":"basket-restore","kind":"linked"},{"from":"cost-logs","to":"pr-gateway-debug","kind":"linked"},{"from":"staging-data","to":"load-test","kind":"linked"},{"from":"old-exports","to":"sched-dashboards","kind":"linked"},{"from":"guest-checkout","to":"basket-restore","kind":"blockedBy","sample":true},{"from":"coupons-stack","to":"rv-6257","kind":"blockedBy","sample":true}];
