/*
 * The Workflows pages' shared drawing: the Ship release workflow's graph, with or without a run on it,
 * a day of its runs on the timeline, the day stepper, and a run's steps on the run's own timeline.
 *
 * - Workflows.drawGraph(el, { run, openNode }) draws the graph into el. run is a key of Workflows.RUNS;
 *   without one the graph is the workflow as saved. openNode opens that node's card once the graph is drawn.
 * - Workflows.drawRunDay(el, { day }) draws one day of runs: its axis, then its tracks. day is a key of
 *   DAYS below, "today" by default.
 * - Workflows.drawDayStepper(el, { day }) draws the day stepper. Its buttons are links that set ?day= on
 *   the page's URL, so a page that reads ?day= and passes it to both calls steps through the days.
 * - Workflows.drawStepTimeline(headEl, rowsEl, { run }) draws a run's steps on its timeline: the column heads
 *   with the run's axis into headEl, then a row per step record and a muted row per plan step not reached.
 * - Workflows.RUNS holds the runs by key, so the run page can draw a run's header from the same record.
 *
 * The positions of the cards, edges and labels were read from the prototype's rendered graph, which the
 * app's layout drew, so the book draws exactly what the app will.
 */
(function () {
  "use strict";

  // The workflow as saved. A node's kind is event, schedule, signal, agent or action; waitsForAll marks a step
  // that waits for every edge into it. An edge's name is "from>to", and the last edge is the stub to the end dot.
  // A label sits at the centre of the edge it labels; condition is the full condition, shown as its title.
  var GRAPH = {
    width: 1511,
    height: 257.5,
    bus: [216, 142.25],
    end: [1505, 132.5],
    nodes: [
      { id: "release_issue", kind: "event", left: 0, top: 84.25, detail: "github.issue.labeled" },
      { id: "release_train", kind: "schedule", left: 0, top: 152.25, detail: "Fridays at 14:00" },
      { id: "pr_merged", kind: "signal", left: 883, top: 108.5, detail: "github.pr.merged" },
      { id: "changelog", kind: "agent", left: 256, top: 209.5, detail: "Writer" },
      { id: "security", kind: "agent", left: 256, top: 141.5, detail: "Auditor" },
      { id: "test", kind: "agent", left: 256, top: 73.5, detail: "Tester" },
      { id: "review", kind: "agent", left: 256, top: 5.5, detail: "Reviewer" },
      { id: "fix", kind: "agent", left: 619, top: 0, detail: "Coder" },
      { id: "open_pr", kind: "action", left: 619, top: 108.5, detail: "Open a GitHub pull request", waitsForAll: true },
      { id: "announce", kind: "agent", left: 1099, top: 108.5, detail: "Writer" },
      { id: "notify", kind: "action", left: 1315, top: 108.5, detail: "Send a notification" },
    ],
    edges: [
      { name: "release_issue>bus", path: "M176,108.3 L177.3,108.3 C178.7,108.3 181.3,108.3 184.7,108.3 C188,108.3 192,108.3 196,113.9 C200,119.6 204,130.9 207.3,136.6 C210.7,142.3 213.3,142.3 214.7,142.3 L216,142.3" },
      { name: "release_train>bus", path: "M176,176.3 L177.3,176.3 C178.7,176.3 181.3,176.3 184.7,176.3 C188,176.3 192,176.3 196,170.6 C200,164.9 204,153.6 207.3,147.9 C210.7,142.3 213.3,142.3 214.7,142.3 L216,142.3" },
      { name: "bus>changelog", arrow: true, path: "M216,142.3 L217.3,142.3 C218.7,142.3 221.3,142.3 224.7,157.5 C228,172.7 232,203.1 236,218.3 C240,233.5 244,233.5 247.3,233.5 C250.7,233.5 253.3,233.5 254.7,233.5 L256,233.5" },
      { name: "bus>security", arrow: true, path: "M216,142.3 L217.3,142.3 C218.7,142.3 221.3,142.3 224.7,146.1 C228,150 232,157.8 236,161.6 C240,165.5 244,165.5 247.3,165.5 C250.7,165.5 253.3,165.5 254.7,165.5 L256,165.5" },
      { name: "bus>test", arrow: true, path: "M216,142.3 L217.3,142.3 C218.7,142.3 221.3,142.3 224.7,134.8 C228,127.3 232,112.4 236,105 C240,97.5 244,97.5 247.3,97.5 C250.7,97.5 253.3,97.5 254.7,97.5 L256,97.5" },
      { name: "bus>review", arrow: true, path: "M216,142.3 L217.3,142.3 C218.7,142.3 221.3,142.3 224.7,123.5 C228,104.7 232,67.1 236,48.3 C240,29.5 244,29.5 247.3,29.5 C250.7,29.5 253.3,29.5 254.7,29.5 L256,29.5" },
      { name: "changelog>open_pr", arrow: true, path: "M432,233.5 L433.3,233.5 C434.7,233.5 437.3,233.5 440.7,233.5 C444,233.5 448,233.5 450,233.5 C452,233.5 452,233.5 476.5,233.5 C501,233.5 550,233.5 574.5,233.5 C599,233.5 599,233.5 601,218.7 C603,203.8 607,174.2 610.3,159.3 C613.7,144.5 616.3,144.5 617.7,144.5 L619,144.5" },
      { name: "test>open_pr", arrow: true, path: "M432,97.5 L433.3,97.5 C434.7,97.5 437.3,97.5 440.7,97.5 C444,97.5 448,97.5 450,97.5 C452,97.5 452,97.5 476.5,97.5 C501,97.5 550,97.5 574.5,97.5 C599,97.5 599,97.5 601,102.7 C603,107.8 607,118.2 610.3,123.3 C613.7,128.5 616.3,128.5 617.7,128.5 L619,128.5" },
      { name: "security>open_pr", arrow: true, path: "M432,165.5 L433.3,165.5 C434.7,165.5 437.3,165.5 440.7,165.5 C444,165.5 448,165.5 450,165.5 C452,165.5 452,165.5 476.5,165.5 C501,165.5 550,165.5 574.5,165.5 C599,165.5 599,165.5 601,160.7 C603,155.8 607,146.2 610.3,141.3 C613.7,136.5 616.3,136.5 617.7,136.5 L619,136.5" },
      { name: "review>open_pr", arrow: true, path: "M432,41.5 L433.3,41.5 C434.7,41.5 437.3,41.5 440.7,45.8 C444,50.1 448,58.7 450,63 C452,67.3 452,67.3 476.5,67.3 C501,67.3 550,67.3 574.5,67.3 C599,67.3 599,67.3 601,76.1 C603,85 607,102.8 610.3,111.6 C613.7,120.5 616.3,120.5 617.7,120.5 L619,120.5" },
      { name: "review>fix", arrow: true, path: "M432,29.5 L433.3,29.5 C434.7,29.5 437.3,29.5 440.7,31.3 C444,33.1 448,36.7 450,38.5 C452,40.3 452,40.3 476.5,40.3 C501,40.3 550,40.3 574.5,40.3 C599,40.3 599,40.3 601,39.5 C603,38.8 607,37.4 610.3,36.7 C613.7,36 616.3,36 617.7,36 L619,36" },
      { name: "fix>review", arrow: true, path: "M619,12 L617.7,12 C616.3,12 613.7,12 610.3,12.2 C607,12.4 603,12.8 601,13 C599,13.3 599,13.3 574.5,13.3 C550,13.3 501,13.3 476.5,13.3 C452,13.3 452,13.3 450,14 C448,14.7 444,16.1 440.7,16.8 C437.3,17.5 434.7,17.5 433.3,17.5 L432,17.5" },
      { name: "pr_merged>announce", arrow: true, path: "M1059,132.5 L1060.3,132.5 C1061.7,132.5 1064.3,132.5 1067.7,132.5 C1071,132.5 1075,132.5 1079,132.5 C1083,132.5 1087,132.5 1090.3,132.5 C1093.7,132.5 1096.3,132.5 1097.7,132.5 L1099,132.5" },
      { name: "announce>notify", arrow: true, path: "M1275,132.5 L1276.3,132.5 C1277.7,132.5 1280.3,132.5 1283.7,132.5 C1287,132.5 1291,132.5 1295,132.5 C1299,132.5 1303,132.5 1306.3,132.5 C1309.7,132.5 1312.3,132.5 1313.7,132.5 L1315,132.5" },
      { name: "open_pr>pr_merged", signal: true, path: "M795,132.5 L796.3,132.5 C797.7,132.5 800.3,132.5 803.7,132.5 C807,132.5 811,132.5 813,132.5 C815,132.5 815,132.5 823,132.5 C831,132.5 847,132.5 855,132.5 C863,132.5 863,132.5 865,132.5 C867,132.5 871,132.5 874.3,132.5 C877.7,132.5 880.3,132.5 881.7,132.5 L883,132.5" },
      { name: "notify>end", path: "M1491 132.5h10" },
    ],
    labels: [
      { name: "approved", x: 525.5, y: 67.25, text: "verdict == \"approved\"", condition: "steps.review.output.verdict == \"approved\"" },
      { name: "changes", x: 525.5, y: 40.25, text: "verdict == \"changes\"", condition: "steps.review.output.verdict == \"changes\"" },
      { name: "limit", x: 525.5, y: 13.25, text: "≤ 3", isCount: true },
      { name: "number", x: 839, y: 132.5, text: "number", condition: "event.payload.number == steps.open_pr.output.number" },
    ],
  };

  // The card of details of each node of the workflow as saved, with no run. A fact's "as" sets its style: code or fail.
  var DEFINITION = {
    release_issue: {
      facts: [
        { term: "Fires on", value: "github.issue.labeled · any connection" },
        { term: "Filter", value: "event.payload.label.name == \"release\"", as: "code" },
      ],
    },
    release_train: {
      facts: [
        { term: "Fires on", value: "0 14 * * 5", as: "code" },
        { term: "Next", value: "Fri 14:00" },
        { term: "Last fired", value: "Fri" },
      ],
    },
    pr_merged: {
      facts: [
        { term: "Listens for", value: "github.pr.merged · any connection" },
        { term: "Matches", value: "event.payload.number == steps.open_pr.output.number", as: "code" },
      ],
    },
    changelog: {
      facts: [
        { term: "Agent", value: "Writer" },
        { term: "Access", value: "Approval required, from the Agent" },
      ],
      prompt: "Write the changelog for {{ inputs.version }} from the merged pull requests.",
    },
    security: {
      facts: [
        { term: "Agent", value: "Auditor" },
        { term: "Access", value: "Approval required, from the Agent" },
      ],
      prompt: "Audit the dependencies and fix what you can.",
    },
    test: {
      facts: [
        { term: "Agent", value: "Tester" },
        { term: "Access", value: "Approval required, from the Agent" },
      ],
      prompt: "Run the full test suite and the end-to-end tests.",
    },
    review: {
      facts: [
        { term: "Agent", value: "Reviewer" },
        { term: "Access", value: "Approval required, from the Agent" },
        { term: "Returns", value: "verdict", as: "code" },
      ],
      prompt: "Review the release diff. Answer approved or changes.",
    },
    fix: {
      facts: [
        { term: "Agent", value: "Coder" },
        { term: "Access", value: "Approval required, from the Agent" },
      ],
      prompt: "Make the changes the review asked for.",
    },
    open_pr: {
      facts: [
        { term: "Action", value: "Open a GitHub pull request" },
        { term: "connection", value: "any", as: "code" },
        { term: "title", value: "Release {{ inputs.version }}", as: "code" },
        { term: "head", value: "release/{{ inputs.version }}", as: "code" },
        { term: "base", value: "main", as: "code" },
        { term: "Waits for", value: "Every step before it" },
      ],
    },
    announce: {
      facts: [
        { term: "Agent", value: "Writer" },
        { term: "Access", value: "Approval required, from the Agent" },
      ],
      prompt: "Write the release announcement from the changelog.",
    },
    notify: {
      facts: [
        { term: "Action", value: "Send a notification" },
        { term: "title", value: "Released {{ inputs.version }}", as: "code" },
        { term: "Ends the run", value: "When it completes" },
      ],
    },
  };

  // The runs of Ship release that the run page shows, by the key its ?state= takes. On a run:
  // - nodes gives each node's state, its mark, and how many times the run came to it;
  // - edges and labels give each edge's and label's tone, by name, and limitCount is the limit label's count;
  // - rows are the step timeline's rows: a step record has a mark and a bar; a plan step not reached has neither;
  // - cards are the nodes' cards, each led by its status line.
  var RUNS = {
    "waiting": {
      time: "Today 09:12",
      live: true,
      mark: "waiting",
      title: "Waiting on you",
      took: "29m 0s",
      gist: { tone: "you", text: "security asks: Run npm audit fix --force?", opensThread: true },
      startedBy: { icon: "bolt", text: "Started by release_issue" },
      inputs: [{ name: "version", value: "2.14.0" }],
      note: null,
      nodes: {
        release_issue: { state: "fired", mark: "done" },
        release_train: { state: "quiet" },
        pr_merged: { state: "quiet" },
        changelog: { state: "done", mark: "done" },
        security: { state: "waiting", mark: "waiting" },
        test: { state: "done", mark: "done" },
        review: { state: "done", mark: "done", times: "×2" },
        fix: { state: "done", mark: "done" },
        open_pr: { state: "pending" },
        announce: { state: "unreached" },
        notify: { state: "unreached" },
      },
      edges: { "release_issue>bus": "active", "release_train>bus": "not-yet", "bus>changelog": "fired", "bus>security": "active", "bus>test": "fired", "bus>review": "fired", "changelog>open_pr": "fired", "test>open_pr": "fired", "security>open_pr": "not-yet", "review>open_pr": "fired", "review>fix": "fired", "fix>review": "fired", "pr_merged>announce": "not-yet", "announce>notify": "not-yet", "open_pr>pr_merged": "not-yet", "notify>end": "not-yet" },
      labels: { approved: "fired", changes: "fired", limit: "fired", number: "not-yet" },
      limitCount: "1/3",
      ticks: [{ at: 0, text: "0" }, { at: 17.236, text: "5m" }, { at: 34.473, text: "10m" }, { at: 51.709, text: "15m" }, { at: 68.946, text: "20m" }, { at: 86.182, text: "25m" }],
      now: "now 29m 0s",
      rows: [
        { step: "changelog", mark: "done", at: 0, span: 10.342, took: "3m 0s", opensThread: true },
        { step: "test", mark: "done", at: 0, span: 27.578, took: "8m 0s", opensThread: true },
        { step: "security", mark: "waiting", at: 0, span: 100, tone: "you", took: "29m 0s", opensThread: true },
        { step: "review", iteration: "#1", mark: "done", at: 0, span: 17.236, took: "5m 0s", opensThread: true },
        { step: "fix", mark: "done", at: 17.236, span: 34.473, took: "10m 0s", opensThread: true },
        { step: "review", iteration: "#2", mark: "done", at: 51.709, span: 13.789, took: "4m 0s", opensThread: true },
        { step: "open_pr", note: "Waiting to start" },
        { step: "announce" },
        { step: "notify" },
      ],
      cards: {
        release_issue: {
          status: { mark: "done", text: "Started this run" },
          facts: [
            { term: "Fires on", value: "github.issue.labeled · any connection" },
            { term: "Filter", value: "event.payload.label.name == \"release\"", as: "code" },
          ],
        },
        release_train: {
          status: { text: "Did not start this run" },
          facts: [
            { term: "Fires on", value: "0 14 * * 5", as: "code" },
          ],
        },
        pr_merged: {
          status: { text: "Has not fired" },
          facts: [
            { term: "Listens for", value: "github.pr.merged · any connection" },
            { term: "Matches", value: "event.payload.number == steps.open_pr.output.number", as: "code" },
          ],
        },
        changelog: {
          status: { mark: "done", text: "Done" },
          facts: [
            { term: "Started", value: "Today 09:12" },
            { term: "Took", value: "3m 0s" },
            { term: "Output", value: "{\"changelog\":\"…\"}", as: "code" },
            { term: "Model", value: "Claude Sonnet 5" },
            { term: "Tokens", value: "49.7k" },
            { term: "Tool calls", value: "46" },
            { term: "Cost", value: "$0.12" },
          ],
          prompt: "Write the changelog for {{ inputs.version }} from the merged pull requests.",
          opensThread: true,
        },
        security: {
          status: { tone: "you", mark: "waiting", text: "Waiting on you", ask: "Run npm audit fix --force?" },
          facts: [
            { term: "Started", value: "Today 09:12" },
            { term: "Running for", value: "29m 0s" },
            { term: "Model", value: "Claude Sonnet 5" },
            { term: "Tokens", value: "49.9k" },
            { term: "Tool calls", value: "2" },
            { term: "Cost", value: "$0.12" },
          ],
          prompt: "Audit the dependencies and fix what you can.",
          opensThread: true,
        },
        test: {
          status: { mark: "done", text: "Done" },
          facts: [
            { term: "Started", value: "Today 09:12" },
            { term: "Took", value: "8m 0s" },
            { term: "Output", value: "{\"passed\":true}", as: "code" },
            { term: "Model", value: "Claude Sonnet 5" },
            { term: "Tokens", value: "49.8k" },
            { term: "Tool calls", value: "47" },
            { term: "Cost", value: "$0.12" },
          ],
          prompt: "Run the full test suite and the end-to-end tests.",
          opensThread: true,
        },
        review: {
          status: { mark: "done", text: "Done" },
          facts: [
            { term: "Started", value: "Today 09:27" },
            { term: "Took", value: "4m 0s" },
            { term: "Output", value: "{\"verdict\":\"approved\"}", as: "code" },
            { term: "Model", value: "Claude Sonnet 5" },
            { term: "Tokens", value: "49.6k" },
            { term: "Tool calls", value: "45" },
            { term: "Cost", value: "$0.12" },
          ],
          prompt: "Review the release diff. Answer approved or changes.",
          times: { title: "Ran 2 times", rows: [{ mark: "done", iteration: "#1", text: "Done", took: "5m 0s" }, { mark: "done", iteration: "#2", text: "Done", took: "4m 0s" }] },
          opensThread: true,
        },
        fix: {
          status: { mark: "done", text: "Done" },
          facts: [
            { term: "Started", value: "Today 09:17" },
            { term: "Took", value: "10m 0s" },
            { term: "Output", value: "{\"commits\":2}", as: "code" },
            { term: "Model", value: "Claude Sonnet 5" },
            { term: "Tokens", value: "50.0k" },
            { term: "Tool calls", value: "3" },
            { term: "Cost", value: "$0.12" },
          ],
          prompt: "Make the changes the review asked for.",
          opensThread: true,
        },
        open_pr: {
          status: { text: "Waiting to start" },
        },
        announce: {
          status: { text: "Not reached in this run" },
          prompt: "Write the release announcement from the changelog.",
        },
        notify: {
          status: { text: "Not reached in this run" },
        },
      },
    },
    "failed": {
      time: "Fri 14:00",
      live: false,
      mark: "failed",
      title: "Failed",
      took: "40m 0s",
      gist: { tone: "fail", text: "Iteration limit at review. The run would follow review → fix a fourth time, past its limit of 3." },
      startedBy: { icon: "clock", text: "Started by release_train" },
      inputs: [{ name: "version", value: "2.13.0" }],
      note: null,
      nodes: {
        release_issue: { state: "quiet" },
        release_train: { state: "fired", mark: "done" },
        pr_merged: { state: "quiet" },
        changelog: { state: "done", mark: "done" },
        security: { state: "done", mark: "done" },
        test: { state: "done", mark: "done" },
        review: { state: "done", mark: "done", times: "×4" },
        fix: { state: "done", mark: "done", times: "×3" },
        open_pr: { state: "unreached" },
        announce: { state: "unreached" },
        notify: { state: "unreached" },
      },
      edges: { "release_issue>bus": "not-taken", "release_train>bus": "fired", "bus>changelog": "fired", "bus>security": "fired", "bus>test": "fired", "bus>review": "fired", "changelog>open_pr": "fired", "test>open_pr": "fired", "security>open_pr": "fired", "review>open_pr": "not-taken", "review>fix": "failed", "fix>review": "fired", "pr_merged>announce": "not-taken", "announce>notify": "not-taken", "open_pr>pr_merged": "not-taken", "notify>end": "not-yet" },
      labels: { approved: "", changes: "failed", limit: "fired", number: "" },
      limitCount: "3/3",
      ticks: [{ at: 0, text: "0" }, { at: 25, text: "10m" }, { at: 50, text: "20m" }, { at: 75, text: "30m" }, { at: 100, text: "40m" }],
      now: null,
      rows: [
        { step: "changelog", mark: "done", at: 0, span: 10, took: "4m 0s", opensThread: true },
        { step: "security", mark: "done", at: 0, span: 15, took: "6m 0s", opensThread: true },
        { step: "test", mark: "done", at: 0, span: 22.5, took: "9m 0s", opensThread: true },
        { step: "review", iteration: "#1", mark: "done", at: 0, span: 10, took: "4m 0s", opensThread: true },
        { step: "fix", iteration: "#1", mark: "done", at: 10, span: 20, took: "8m 0s", opensThread: true },
        { step: "review", iteration: "#2", mark: "done", at: 30, span: 10, took: "4m 0s", opensThread: true },
        { step: "fix", iteration: "#2", mark: "done", at: 40, span: 20, took: "8m 0s", opensThread: true },
        { step: "review", iteration: "#3", mark: "done", at: 60, span: 10, took: "4m 0s", opensThread: true },
        { step: "fix", iteration: "#3", mark: "done", at: 70, span: 20, took: "8m 0s", opensThread: true },
        { step: "review", iteration: "#4", mark: "done", at: 90, span: 10, took: "4m 0s", opensThread: true },
        { step: "open_pr" },
        { step: "announce" },
        { step: "notify" },
      ],
      cards: {
        release_issue: {
          status: { text: "Did not start this run" },
          facts: [
            { term: "Fires on", value: "github.issue.labeled · any connection" },
            { term: "Filter", value: "event.payload.label.name == \"release\"", as: "code" },
          ],
        },
        release_train: {
          status: { mark: "done", text: "Started this run" },
          facts: [
            { term: "Fires on", value: "0 14 * * 5", as: "code" },
          ],
        },
        pr_merged: {
          status: { text: "Has not fired" },
          facts: [
            { term: "Listens for", value: "github.pr.merged · any connection" },
            { term: "Matches", value: "event.payload.number == steps.open_pr.output.number", as: "code" },
          ],
        },
        changelog: {
          status: { mark: "done", text: "Done" },
          facts: [
            { term: "Started", value: "Fri 14:00" },
            { term: "Took", value: "4m 0s" },
            { term: "Output", value: "{\"changelog\":\"…\"}", as: "code" },
            { term: "Model", value: "Claude Sonnet 5" },
            { term: "Tokens", value: "54.7k" },
            { term: "Tool calls", value: "3" },
            { term: "Cost", value: "$0.14" },
          ],
          prompt: "Write the changelog for {{ inputs.version }} from the merged pull requests.",
          opensThread: true,
        },
        security: {
          status: { mark: "done", text: "Done" },
          facts: [
            { term: "Started", value: "Fri 14:00" },
            { term: "Took", value: "6m 0s" },
            { term: "Output", value: "{\"findings\":0}", as: "code" },
            { term: "Model", value: "Claude Sonnet 5" },
            { term: "Tokens", value: "54.8k" },
            { term: "Tool calls", value: "4" },
            { term: "Cost", value: "$0.14" },
          ],
          prompt: "Audit the dependencies and fix what you can.",
          opensThread: true,
        },
        test: {
          status: { mark: "done", text: "Done" },
          facts: [
            { term: "Started", value: "Fri 14:00" },
            { term: "Took", value: "9m 0s" },
            { term: "Output", value: "{\"passed\":true}", as: "code" },
            { term: "Model", value: "Claude Sonnet 5" },
            { term: "Tokens", value: "54.9k" },
            { term: "Tool calls", value: "5" },
            { term: "Cost", value: "$0.14" },
          ],
          prompt: "Run the full test suite and the end-to-end tests.",
          opensThread: true,
        },
        review: {
          status: { mark: "done", text: "Done" },
          facts: [
            { term: "Started", value: "Fri 14:36" },
            { term: "Took", value: "4m 0s" },
            { term: "Output", value: "{\"verdict\":\"changes\"}", as: "code" },
            { term: "Model", value: "Claude Sonnet 5" },
            { term: "Tokens", value: "54.5k" },
            { term: "Tool calls", value: "47" },
            { term: "Cost", value: "$0.13" },
          ],
          prompt: "Review the release diff. Answer approved or changes.",
          times: { title: "Ran 4 times", rows: [{ mark: "done", iteration: "#1", text: "Done", took: "4m 0s" }, { mark: "done", iteration: "#2", text: "Done", took: "4m 0s" }, { mark: "done", iteration: "#3", text: "Done", took: "4m 0s" }, { mark: "done", iteration: "#4", text: "Done", took: "4m 0s" }] },
          opensThread: true,
        },
        fix: {
          status: { mark: "done", text: "Done" },
          facts: [
            { term: "Started", value: "Fri 14:28" },
            { term: "Took", value: "8m 0s" },
            { term: "Output", value: "{\"commits\":1}", as: "code" },
            { term: "Model", value: "Claude Sonnet 5" },
            { term: "Tokens", value: "54.6k" },
            { term: "Tool calls", value: "2" },
            { term: "Cost", value: "$0.14" },
          ],
          prompt: "Make the changes the review asked for.",
          times: { title: "Ran 3 times", rows: [{ mark: "done", iteration: "#1", text: "Done", took: "8m 0s" }, { mark: "done", iteration: "#2", text: "Done", took: "8m 0s" }, { mark: "done", iteration: "#3", text: "Done", took: "8m 0s" }] },
          opensThread: true,
        },
        open_pr: {
          status: { text: "Not reached in this run" },
        },
        announce: {
          status: { text: "Not reached in this run" },
          prompt: "Write the release announcement from the changelog.",
        },
        notify: {
          status: { text: "Not reached in this run" },
        },
      },
    },
    "step-failed": {
      time: "10 Sep 03:50",
      live: false,
      mark: "failed",
      title: "Failed",
      took: "11m 0s",
      gist: { tone: "fail", text: "Session failed at test. The session ended its turn with an error: 3 end-to-end tests failed." },
      startedBy: { icon: "bolt", text: "Started by release_issue" },
      inputs: [{ name: "version", value: "2.11.3" }],
      note: null,
      nodes: {
        release_issue: { state: "fired", mark: "done" },
        release_train: { state: "quiet" },
        pr_merged: { state: "quiet" },
        changelog: { state: "done", mark: "done" },
        security: { state: "done", mark: "done" },
        test: { state: "failed", mark: "failed" },
        review: { state: "done", mark: "done" },
        fix: { state: "unreached" },
        open_pr: { state: "unreached" },
        announce: { state: "unreached" },
        notify: { state: "unreached" },
      },
      edges: { "release_issue>bus": "fired", "release_train>bus": "not-taken", "bus>changelog": "fired", "bus>security": "fired", "bus>test": "fired", "bus>review": "fired", "changelog>open_pr": "fired", "test>open_pr": "not-taken", "security>open_pr": "fired", "review>open_pr": "fired", "review>fix": "not-taken", "fix>review": "not-taken", "pr_merged>announce": "not-taken", "announce>notify": "not-taken", "open_pr>pr_merged": "not-taken", "notify>end": "not-yet" },
      labels: { approved: "fired", changes: "", limit: "", number: "" },
      limitCount: "0/3",
      ticks: [{ at: 0, text: "0" }, { at: 18.182, text: "2m" }, { at: 36.364, text: "4m" }, { at: 54.545, text: "6m" }, { at: 72.727, text: "8m" }, { at: 90.909, text: "10m" }],
      now: null,
      rows: [
        { step: "changelog", mark: "done", at: 0, span: 36.364, took: "4m 0s", opensThread: true },
        { step: "security", mark: "done", at: 0, span: 63.636, took: "7m 0s", opensThread: true },
        { step: "test", mark: "failed", error: "The session ended its turn with an error: 3 end-to-end tests failed.", at: 0, span: 100, tone: "fail", took: "11m 0s", opensThread: true },
        { step: "review", mark: "done", at: 0, span: 54.545, took: "6m 0s", opensThread: true },
        { step: "fix" },
        { step: "open_pr" },
        { step: "announce" },
        { step: "notify" },
      ],
      cards: {
        release_issue: {
          status: { mark: "done", text: "Started this run" },
          facts: [
            { term: "Fires on", value: "github.issue.labeled · any connection" },
            { term: "Filter", value: "event.payload.label.name == \"release\"", as: "code" },
          ],
        },
        release_train: {
          status: { text: "Did not start this run" },
          facts: [
            { term: "Fires on", value: "0 14 * * 5", as: "code" },
          ],
        },
        pr_merged: {
          status: { text: "Has not fired" },
          facts: [
            { term: "Listens for", value: "github.pr.merged · any connection" },
            { term: "Matches", value: "event.payload.number == steps.open_pr.output.number", as: "code" },
          ],
        },
        changelog: {
          status: { mark: "done", text: "Done" },
          facts: [
            { term: "Started", value: "10 Sep 03:50" },
            { term: "Took", value: "4m 0s" },
            { term: "Output", value: "{\"changelog\":\"…\"}", as: "code" },
            { term: "Model", value: "Claude Sonnet 5" },
            { term: "Tokens", value: "56.2k" },
            { term: "Tool calls", value: "17" },
            { term: "Cost", value: "$0.14" },
          ],
          prompt: "Write the changelog for {{ inputs.version }} from the merged pull requests.",
          opensThread: true,
        },
        security: {
          status: { mark: "done", text: "Done" },
          facts: [
            { term: "Started", value: "10 Sep 03:50" },
            { term: "Took", value: "7m 0s" },
            { term: "Output", value: "{\"findings\":0}", as: "code" },
            { term: "Model", value: "Claude Sonnet 5" },
            { term: "Tokens", value: "56.3k" },
            { term: "Tool calls", value: "18" },
            { term: "Cost", value: "$0.14" },
          ],
          prompt: "Audit the dependencies and fix what you can.",
          opensThread: true,
        },
        test: {
          status: { tone: "fail", mark: "failed", text: "Failed" },
          facts: [
            { term: "Started", value: "10 Sep 03:50" },
            { term: "Took", value: "11m 0s" },
            { term: "Error", value: "The session ended its turn with an error: 3 end-to-end tests failed.", as: "fail" },
            { term: "Model", value: "Claude Sonnet 5" },
            { term: "Tokens", value: "56.4k" },
            { term: "Tool calls", value: "19" },
            { term: "Cost", value: "$0.14" },
          ],
          prompt: "Run the full test suite and the end-to-end tests.",
          opensThread: true,
        },
        review: {
          status: { mark: "done", text: "Done" },
          facts: [
            { term: "Started", value: "10 Sep 03:50" },
            { term: "Took", value: "6m 0s" },
            { term: "Output", value: "{\"verdict\":\"approved\"}", as: "code" },
            { term: "Model", value: "Claude Sonnet 5" },
            { term: "Tokens", value: "56.5k" },
            { term: "Tool calls", value: "20" },
            { term: "Cost", value: "$0.14" },
          ],
          prompt: "Review the release diff. Answer approved or changes.",
          opensThread: true,
        },
        fix: {
          status: { text: "Not reached in this run" },
          prompt: "Make the changes the review asked for.",
        },
        open_pr: {
          status: { text: "Not reached in this run" },
        },
        announce: {
          status: { text: "Not reached in this run" },
          prompt: "Write the release announcement from the changelog.",
        },
        notify: {
          status: { text: "Not reached in this run" },
        },
      },
    },
    "listening": {
      time: "Mon 05:41",
      live: true,
      mark: "working",
      title: "Running",
      took: "28h 0m",
      gist: null,
      startedBy: { text: "Started by you" },
      inputs: [{ name: "version", value: "2.13.1" }],
      note: null,
      nodes: {
        release_issue: { state: "quiet" },
        release_train: { state: "quiet" },
        pr_merged: { state: "listening", mark: "idle" },
        changelog: { state: "done", mark: "done" },
        security: { state: "done", mark: "done" },
        test: { state: "done", mark: "done" },
        review: { state: "done", mark: "done" },
        fix: { state: "unreached" },
        open_pr: { state: "done", mark: "done" },
        announce: { state: "unreached" },
        notify: { state: "unreached" },
      },
      edges: { "release_issue>bus": "not-yet", "release_train>bus": "not-yet", "bus>changelog": "not-yet", "bus>security": "not-yet", "bus>test": "not-yet", "bus>review": "not-yet", "changelog>open_pr": "fired", "test>open_pr": "fired", "security>open_pr": "fired", "review>open_pr": "fired", "review>fix": "not-taken", "fix>review": "not-yet", "pr_merged>announce": "not-yet", "announce>notify": "not-yet", "open_pr>pr_merged": "fired", "notify>end": "not-yet" },
      labels: { approved: "fired", changes: "", limit: "not-yet", number: "fired" },
      limitCount: "0/3",
      ticks: [{ at: 0, text: "0" }, { at: 21.429, text: "6h" }, { at: 42.857, text: "12h" }, { at: 64.286, text: "18h" }, { at: 85.714, text: "24h" }],
      now: "now 28h 0m",
      rows: [
        { step: "changelog", mark: "done", at: 0, span: 0.238, took: "4m 0s", opensThread: true },
        { step: "security", mark: "done", at: 0, span: 0.417, took: "7m 0s", opensThread: true },
        { step: "test", mark: "done", at: 0, span: 0.536, took: "9m 0s", opensThread: true },
        { step: "review", mark: "done", at: 0, span: 0.357, took: "6m 0s", opensThread: true },
        { step: "open_pr", mark: "done", at: 0.536, span: 0.06, took: "1m 0s" },
        { step: "fix" },
        { step: "announce" },
        { step: "notify" },
      ],
      cards: {
        release_issue: {
          status: { text: "Did not start this run" },
          facts: [
            { term: "Fires on", value: "github.issue.labeled · any connection" },
            { term: "Filter", value: "event.payload.label.name == \"release\"", as: "code" },
          ],
        },
        release_train: {
          status: { text: "Did not start this run" },
          facts: [
            { term: "Fires on", value: "0 14 * * 5", as: "code" },
          ],
        },
        pr_merged: {
          status: { mark: "idle", text: "Listening for its event" },
          facts: [
            { term: "Listens for", value: "github.pr.merged · any connection" },
            { term: "Matches", value: "event.payload.number == steps.open_pr.output.number", as: "code" },
          ],
        },
        changelog: {
          status: { mark: "done", text: "Done" },
          facts: [
            { term: "Started", value: "Mon 05:41" },
            { term: "Took", value: "4m 0s" },
            { term: "Output", value: "{\"changelog\":\"…\"}", as: "code" },
            { term: "Model", value: "Claude Sonnet 5" },
            { term: "Tokens", value: "50.1k" },
            { term: "Tool calls", value: "4" },
            { term: "Cost", value: "$0.12" },
          ],
          prompt: "Write the changelog for {{ inputs.version }} from the merged pull requests.",
          opensThread: true,
        },
        security: {
          status: { mark: "done", text: "Done" },
          facts: [
            { term: "Started", value: "Mon 05:41" },
            { term: "Took", value: "7m 0s" },
            { term: "Output", value: "{\"findings\":0}", as: "code" },
            { term: "Model", value: "Claude Sonnet 5" },
            { term: "Tokens", value: "50.2k" },
            { term: "Tool calls", value: "5" },
            { term: "Cost", value: "$0.12" },
          ],
          prompt: "Audit the dependencies and fix what you can.",
          opensThread: true,
        },
        test: {
          status: { mark: "done", text: "Done" },
          facts: [
            { term: "Started", value: "Mon 05:41" },
            { term: "Took", value: "9m 0s" },
            { term: "Output", value: "{\"passed\":true}", as: "code" },
            { term: "Model", value: "Claude Sonnet 5" },
            { term: "Tokens", value: "50.3k" },
            { term: "Tool calls", value: "6" },
            { term: "Cost", value: "$0.12" },
          ],
          prompt: "Run the full test suite and the end-to-end tests.",
          opensThread: true,
        },
        review: {
          status: { mark: "done", text: "Done" },
          facts: [
            { term: "Started", value: "Mon 05:41" },
            { term: "Took", value: "6m 0s" },
            { term: "Output", value: "{\"verdict\":\"approved\"}", as: "code" },
            { term: "Model", value: "Claude Sonnet 5" },
            { term: "Tokens", value: "50.4k" },
            { term: "Tool calls", value: "7" },
            { term: "Cost", value: "$0.12" },
          ],
          prompt: "Review the release diff. Answer approved or changes.",
          opensThread: true,
        },
        fix: {
          status: { text: "Not reached in this run" },
          prompt: "Make the changes the review asked for.",
        },
        open_pr: {
          status: { mark: "done", text: "Done" },
          facts: [
            { term: "Started", value: "Mon 05:50" },
            { term: "Took", value: "1m 0s" },
            { term: "Output", value: "{\"number\":4810}", as: "code" },
          ],
        },
        announce: {
          status: { text: "Not reached in this run" },
          prompt: "Write the release announcement from the changelog.",
        },
        notify: {
          status: { text: "Not reached in this run" },
        },
      },
    },
    "completed": {
      time: "22 Sep 05:00",
      live: false,
      mark: "done",
      title: "Completed",
      took: "1h 23m",
      gist: null,
      startedBy: { icon: "bolt", text: "Started by release_issue" },
      inputs: [{ name: "version", value: "2.12.3" }],
      note: null,
      nodes: {
        release_issue: { state: "fired", mark: "done" },
        release_train: { state: "quiet" },
        pr_merged: { state: "fired", mark: "done" },
        changelog: { state: "done", mark: "done" },
        security: { state: "done", mark: "done" },
        test: { state: "done", mark: "done" },
        review: { state: "done", mark: "done" },
        fix: { state: "unreached" },
        open_pr: { state: "done", mark: "done" },
        announce: { state: "done", mark: "done" },
        notify: { state: "done", mark: "done" },
      },
      edges: { "release_issue>bus": "fired", "release_train>bus": "not-taken", "bus>changelog": "fired", "bus>security": "fired", "bus>test": "fired", "bus>review": "fired", "changelog>open_pr": "fired", "test>open_pr": "fired", "security>open_pr": "fired", "review>open_pr": "fired", "review>fix": "not-taken", "fix>review": "not-taken", "pr_merged>announce": "fired", "announce>notify": "fired", "open_pr>pr_merged": "fired", "notify>end": "fired" },
      labels: { approved: "fired", changes: "", limit: "", number: "fired" },
      limitCount: "0/3",
      ticks: [{ at: 0, text: "0" }, { at: 18.072, text: "15m" }, { at: 36.145, text: "30m" }, { at: 54.217, text: "45m" }, { at: 72.289, text: "1h" }, { at: 90.361, text: "1h 15m" }],
      now: null,
      rows: [
        { step: "changelog", mark: "done", at: 0, span: 4.819, took: "4m 0s", opensThread: true },
        { step: "security", mark: "done", at: 0, span: 8.434, took: "7m 0s", opensThread: true },
        { step: "test", mark: "done", at: 0, span: 10.843, took: "9m 0s", opensThread: true },
        { step: "review", mark: "done", at: 0, span: 7.229, took: "6m 0s", opensThread: true },
        { step: "open_pr", mark: "done", at: 10.843, span: 1.205, took: "1m 0s" },
        { step: "pr_merged", mark: "done", at: 96.386, span: 0 },
        { step: "announce", mark: "done", at: 96.386, span: 3.614, took: "3m 0s", opensThread: true },
        { step: "notify", mark: "done", at: 100, span: 0, took: "0ms" },
        { step: "fix" },
      ],
      cards: {
        release_issue: {
          status: { mark: "done", text: "Started this run" },
          facts: [
            { term: "Fires on", value: "github.issue.labeled · any connection" },
            { term: "Filter", value: "event.payload.label.name == \"release\"", as: "code" },
          ],
        },
        release_train: {
          status: { text: "Did not start this run" },
          facts: [
            { term: "Fires on", value: "0 14 * * 5", as: "code" },
          ],
        },
        pr_merged: {
          status: { mark: "done", text: "Fired" },
          facts: [
            { term: "Started", value: "22 Sep 06:20" },
            { term: "Took", value: "0ms" },
            { term: "Output", value: "{\"number\":4797}", as: "code" },
            { term: "Listens for", value: "github.pr.merged · any connection" },
            { term: "Matches", value: "event.payload.number == steps.open_pr.output.number", as: "code" },
          ],
        },
        changelog: {
          status: { mark: "done", text: "Done" },
          facts: [
            { term: "Started", value: "22 Sep 05:00" },
            { term: "Took", value: "4m 0s" },
            { term: "Output", value: "{\"changelog\":\"…\"}", as: "code" },
            { term: "Model", value: "Claude Sonnet 5" },
            { term: "Tokens", value: "55.0k" },
            { term: "Tool calls", value: "6" },
            { term: "Cost", value: "$0.14" },
          ],
          prompt: "Write the changelog for {{ inputs.version }} from the merged pull requests.",
          opensThread: true,
        },
        security: {
          status: { mark: "done", text: "Done" },
          facts: [
            { term: "Started", value: "22 Sep 05:00" },
            { term: "Took", value: "7m 0s" },
            { term: "Output", value: "{\"findings\":0}", as: "code" },
            { term: "Model", value: "Claude Sonnet 5" },
            { term: "Tokens", value: "52.7k" },
            { term: "Tool calls", value: "29" },
            { term: "Cost", value: "$0.13" },
          ],
          prompt: "Audit the dependencies and fix what you can.",
          opensThread: true,
        },
        test: {
          status: { mark: "done", text: "Done" },
          facts: [
            { term: "Started", value: "22 Sep 05:00" },
            { term: "Took", value: "9m 0s" },
            { term: "Output", value: "{\"passed\":true}", as: "code" },
            { term: "Model", value: "Claude Sonnet 5" },
            { term: "Tokens", value: "52.8k" },
            { term: "Tool calls", value: "30" },
            { term: "Cost", value: "$0.13" },
          ],
          prompt: "Run the full test suite and the end-to-end tests.",
          opensThread: true,
        },
        review: {
          status: { mark: "done", text: "Done" },
          facts: [
            { term: "Started", value: "22 Sep 05:00" },
            { term: "Took", value: "6m 0s" },
            { term: "Output", value: "{\"verdict\":\"approved\"}", as: "code" },
            { term: "Model", value: "Claude Sonnet 5" },
            { term: "Tokens", value: "52.9k" },
            { term: "Tool calls", value: "31" },
            { term: "Cost", value: "$0.13" },
          ],
          prompt: "Review the release diff. Answer approved or changes.",
          opensThread: true,
        },
        fix: {
          status: { text: "Not reached in this run" },
          prompt: "Make the changes the review asked for.",
        },
        open_pr: {
          status: { mark: "done", text: "Done" },
          facts: [
            { term: "Started", value: "22 Sep 05:09" },
            { term: "Took", value: "1m 0s" },
            { term: "Output", value: "{\"number\":4810}", as: "code" },
          ],
        },
        announce: {
          status: { mark: "done", text: "Done" },
          facts: [
            { term: "Started", value: "22 Sep 06:20" },
            { term: "Took", value: "3m 0s" },
            { term: "Output", value: "{\"posted\":true}", as: "code" },
            { term: "Model", value: "Claude Sonnet 5" },
            { term: "Tokens", value: "53.0k" },
            { term: "Tool calls", value: "32" },
            { term: "Cost", value: "$0.13" },
          ],
          prompt: "Write the release announcement from the changelog.",
          opensThread: true,
        },
        notify: {
          status: { mark: "done", text: "Done" },
          facts: [
            { term: "Started", value: "22 Sep 06:23" },
            { term: "Took", value: "0ms" },
          ],
        },
      },
    },
    "cancelled": {
      time: "Sun 11:20",
      live: false,
      mark: null,
      title: "Cancelled",
      took: "3m 0s",
      gist: null,
      startedBy: { text: "Started by you" },
      inputs: [{ name: "version", value: "2.13.1" }],
      note: null,
      nodes: {
        release_issue: { state: "quiet" },
        release_train: { state: "quiet" },
        pr_merged: { state: "quiet" },
        changelog: { state: "cancelled" },
        security: { state: "cancelled" },
        test: { state: "cancelled" },
        review: { state: "cancelled" },
        fix: { state: "unreached" },
        open_pr: { state: "unreached" },
        announce: { state: "unreached" },
        notify: { state: "unreached" },
      },
      edges: { "release_issue>bus": "not-yet", "release_train>bus": "not-yet", "bus>changelog": "not-yet", "bus>security": "not-yet", "bus>test": "not-yet", "bus>review": "not-yet", "changelog>open_pr": "not-yet", "test>open_pr": "not-yet", "security>open_pr": "not-yet", "review>open_pr": "not-yet", "review>fix": "not-yet", "fix>review": "not-yet", "pr_merged>announce": "not-yet", "announce>notify": "not-yet", "open_pr>pr_merged": "not-yet", "notify>end": "not-yet" },
      labels: { approved: "", changes: "", limit: "", number: "" },
      limitCount: "0/3",
      ticks: [{ at: 0, text: "0" }, { at: 33.333, text: "1m" }, { at: 66.667, text: "2m" }, { at: 100, text: "3m" }],
      now: null,
      rows: [
        { step: "changelog", at: 0, span: 100, took: "3m 0s", opensThread: true },
        { step: "security", at: 0, span: 100, took: "3m 0s", opensThread: true },
        { step: "test", at: 0, span: 100, took: "3m 0s", opensThread: true },
        { step: "review", at: 0, span: 100, took: "3m 0s", opensThread: true },
        { step: "fix" },
        { step: "open_pr" },
        { step: "announce" },
        { step: "notify" },
      ],
      cards: {
        release_issue: {
          status: { text: "Did not start this run" },
          facts: [
            { term: "Fires on", value: "github.issue.labeled · any connection" },
            { term: "Filter", value: "event.payload.label.name == \"release\"", as: "code" },
          ],
        },
        release_train: {
          status: { text: "Did not start this run" },
          facts: [
            { term: "Fires on", value: "0 14 * * 5", as: "code" },
          ],
        },
        pr_merged: {
          status: { text: "Has not fired" },
          facts: [
            { term: "Listens for", value: "github.pr.merged · any connection" },
            { term: "Matches", value: "event.payload.number == steps.open_pr.output.number", as: "code" },
          ],
        },
        changelog: {
          status: { text: "Cancelled" },
          facts: [
            { term: "Started", value: "Sun 11:20" },
            { term: "Took", value: "3m 0s" },
            { term: "Model", value: "Claude Sonnet 5" },
            { term: "Tokens", value: "8.1k" },
            { term: "Tool calls", value: "5" },
            { term: "Cost", value: "$0.02" },
          ],
          prompt: "Write the changelog for {{ inputs.version }} from the merged pull requests.",
          opensThread: true,
        },
        security: {
          status: { text: "Cancelled" },
          facts: [
            { term: "Started", value: "Sun 11:20" },
            { term: "Took", value: "3m 0s" },
            { term: "Model", value: "Claude Sonnet 5" },
            { term: "Tokens", value: "7.9k" },
            { term: "Tool calls", value: "4" },
            { term: "Cost", value: "$0.02" },
          ],
          prompt: "Audit the dependencies and fix what you can.",
          opensThread: true,
        },
        test: {
          status: { text: "Cancelled" },
          facts: [
            { term: "Started", value: "Sun 11:20" },
            { term: "Took", value: "3m 0s" },
            { term: "Model", value: "Claude Sonnet 5" },
            { term: "Tokens", value: "8.4k" },
            { term: "Tool calls", value: "6" },
            { term: "Cost", value: "$0.02" },
          ],
          prompt: "Run the full test suite and the end-to-end tests.",
          opensThread: true,
        },
        review: {
          status: { text: "Cancelled" },
          facts: [
            { term: "Started", value: "Sun 11:20" },
            { term: "Took", value: "3m 0s" },
            { term: "Model", value: "Claude Sonnet 5" },
            { term: "Tokens", value: "7.6k" },
            { term: "Tool calls", value: "3" },
            { term: "Cost", value: "$0.02" },
          ],
          prompt: "Review the release diff. Answer approved or changes.",
          opensThread: true,
        },
        fix: {
          status: { text: "Not reached in this run" },
          prompt: "Make the changes the review asked for.",
        },
        open_pr: {
          status: { text: "Not reached in this run" },
        },
        announce: {
          status: { text: "Not reached in this run" },
          prompt: "Write the release announcement from the changelog.",
        },
        notify: {
          status: { text: "Not reached in this run" },
        },
      },
    },
    "earlier": {
      time: "14 Aug 03:50",
      live: false,
      mark: "done",
      title: "Completed",
      took: "1h 23m",
      gist: null,
      startedBy: { icon: "bolt", text: "Started by release_issue" },
      inputs: [{ name: "version", value: "2.8.0" }],
      note: "This run followed an earlier version of Ship release. Its steps are shown as they were then.",
      // The run's plan differs from the workflow as saved now: it had no security step, so changelog sat in its place.
      plan: {
        height: 201,
        nodes: { security: null, changelog: { left: 256, top: 141.5 } },
        edges: {
          "bus>security": null,
          "security>open_pr": null,
          "bus>changelog": "M216,142.3 L217.3,142.3 C218.7,142.3 221.3,142.3 224.7,146.1 C228,150 232,157.8 236,161.6 C240,165.5 244,165.5 247.3,165.5 C250.7,165.5 253.3,165.5 254.7,165.5 L256,165.5",
          "changelog>open_pr": "M432,165.5 L433.3,165.5 C434.7,165.5 437.3,165.5 440.7,165.5 C444,165.5 448,165.5 450,165.5 C452,165.5 452,165.5 476.5,165.5 C501,165.5 550,165.5 574.5,165.5 C599,165.5 599,165.5 601,160.7 C603,155.8 607,146.2 610.3,141.3 C613.7,136.5 616.3,136.5 617.7,136.5 L619,136.5",
        },
      },
      nodes: {
        release_issue: { state: "fired", mark: "done" },
        release_train: { state: "quiet" },
        pr_merged: { state: "fired", mark: "done" },
        changelog: { state: "done", mark: "done" },
        test: { state: "done", mark: "done" },
        review: { state: "done", mark: "done" },
        fix: { state: "unreached" },
        open_pr: { state: "done", mark: "done" },
        announce: { state: "done", mark: "done" },
        notify: { state: "done", mark: "done" },
      },
      edges: { "release_issue>bus": "fired", "release_train>bus": "not-taken", "bus>changelog": "fired", "bus>test": "fired", "bus>review": "fired", "changelog>open_pr": "fired", "test>open_pr": "fired", "review>open_pr": "fired", "review>fix": "not-taken", "fix>review": "not-taken", "pr_merged>announce": "fired", "announce>notify": "fired", "open_pr>pr_merged": "fired", "notify>end": "fired" },
      labels: { approved: "fired", changes: "", limit: "", number: "fired" },
      limitCount: "0/3",
      ticks: [{ at: 0, text: "0" }, { at: 18.072, text: "15m" }, { at: 36.145, text: "30m" }, { at: 54.217, text: "45m" }, { at: 72.289, text: "1h" }, { at: 90.361, text: "1h 15m" }],
      now: null,
      rows: [
        { step: "changelog", mark: "done", at: 0, span: 4.819, took: "4m 0s", opensThread: true },
        { step: "test", mark: "done", at: 0, span: 10.843, took: "9m 0s", opensThread: true },
        { step: "review", mark: "done", at: 0, span: 7.229, took: "6m 0s", opensThread: true },
        { step: "open_pr", mark: "done", at: 10.843, span: 1.205, took: "1m 0s" },
        { step: "pr_merged", mark: "done", at: 96.386, span: 0 },
        { step: "announce", mark: "done", at: 96.386, span: 3.614, took: "3m 0s", opensThread: true },
        { step: "notify", mark: "done", at: 100, span: 0, took: "0ms" },
        { step: "fix" },
      ],
      cards: {
        release_issue: {
          status: { mark: "done", text: "Started this run" },
          facts: [
            { term: "Fires on", value: "github.issue.labeled · any connection" },
            { term: "Filter", value: "event.payload.label.name == \"release\"", as: "code" },
          ],
        },
        release_train: {
          status: { text: "Did not start this run" },
          facts: [
            { term: "Fires on", value: "0 14 * * 5", as: "code" },
          ],
        },
        pr_merged: {
          status: { mark: "done", text: "Fired" },
          facts: [
            { term: "Started", value: "14 Aug 05:10" },
            { term: "Took", value: "0ms" },
            { term: "Output", value: "{\"number\":4784}", as: "code" },
            { term: "Listens for", value: "github.pr.merged · any connection" },
            { term: "Matches", value: "event.payload.number == steps.open_pr.output.number", as: "code" },
          ],
        },
        changelog: {
          status: { mark: "done", text: "Done" },
          facts: [
            { term: "Started", value: "14 Aug 03:50" },
            { term: "Took", value: "4m 0s" },
            { term: "Output", value: "{\"changelog\":\"…\"}", as: "code" },
            { term: "Model", value: "Claude Sonnet 5" },
            { term: "Tokens", value: "47.7k" },
            { term: "Tool calls", value: "37" },
            { term: "Cost", value: "$0.17" },
          ],
          prompt: "Write the changelog for {{ inputs.version }} from the merged pull requests.",
          opensThread: true,
        },
        test: {
          status: { mark: "done", text: "Done" },
          facts: [
            { term: "Started", value: "14 Aug 03:50" },
            { term: "Took", value: "9m 0s" },
            { term: "Output", value: "{\"passed\":true}", as: "code" },
            { term: "Model", value: "Claude Sonnet 5" },
            { term: "Tokens", value: "45.4k" },
            { term: "Tool calls", value: "15" },
            { term: "Cost", value: "$0.17" },
          ],
          prompt: "Run the full test suite.",
          opensThread: true,
        },
        review: {
          status: { mark: "done", text: "Done" },
          facts: [
            { term: "Started", value: "14 Aug 03:50" },
            { term: "Took", value: "6m 0s" },
            { term: "Output", value: "{\"verdict\":\"approved\"}", as: "code" },
            { term: "Model", value: "Claude Sonnet 5" },
            { term: "Tokens", value: "45.5k" },
            { term: "Tool calls", value: "16" },
            { term: "Cost", value: "$0.17" },
          ],
          prompt: "Review the release diff. Answer approved or changes.",
          opensThread: true,
        },
        fix: {
          status: { text: "Not reached in this run" },
          prompt: "Make the changes the review asked for.",
        },
        open_pr: {
          status: { mark: "done", text: "Done" },
          facts: [
            { term: "Started", value: "14 Aug 03:59" },
            { term: "Took", value: "1m 0s" },
            { term: "Output", value: "{\"number\":4810}", as: "code" },
          ],
        },
        announce: {
          status: { mark: "done", text: "Done" },
          facts: [
            { term: "Started", value: "14 Aug 05:10" },
            { term: "Took", value: "3m 0s" },
            { term: "Output", value: "{\"posted\":true}", as: "code" },
            { term: "Model", value: "Claude Sonnet 5" },
            { term: "Tokens", value: "45.6k" },
            { term: "Tool calls", value: "17" },
            { term: "Cost", value: "$0.17" },
          ],
          prompt: "Write the release announcement from the changelog.",
          opensThread: true,
        },
        notify: {
          status: { mark: "done", text: "Done" },
          facts: [
            { term: "Started", value: "14 Aug 05:13" },
            { term: "Took", value: "0ms" },
          ],
        },
      },
    },
  };

  // One day of the workflow's runs, by the key its ?day= takes. A bar's at and span are percentages of the day.
  // Its tone is "you" or "fail" when the run waits on the user or failed, and its mark is null for a cancelled or
  // starting run, which has none. cut is "start" or "end" when the run went on past that edge of the day.
  var DAYS = {
    today: {
      name: "Today",
      before: "yesterday",
      after: null,
      now: { at: 40.347, text: "09:41" },
      tracks: 2,
      bars: [
        { at: 0, span: 40.347, track: 0, mark: "working", title: "Running, started by you, Mon 05:41, running for 28h 0m", run: "listening", cut: "start" },
        { tone: "you", at: 38.333, span: 2.014, track: 1, mark: "waiting", title: "security asks: Run npm audit fix --force?, started by release_issue, 09:12, running for 29m 0s", run: "waiting" },
      ],
    },
    yesterday: {
      name: "Yesterday",
      before: "27-sep",
      after: "today",
      tracks: 1,
      bars: [{ at: 23.681, span: 76.319, track: 0, mark: "working", title: "Running, started by you, Mon 05:41, running for 28h 0m", run: "listening", cut: "end" }],
    },
    "27-sep": {
      name: "27 Sep",
      before: "26-sep",
      after: "yesterday",
      tracks: 1,
      bars: [{ at: 47.222, span: 0.208, track: 0, mark: null, title: "Cancelled, started by you, Sun 11:20, took 3m 0s", run: "cancelled" }],
    },
    "26-sep": { name: "26 Sep", before: "25-sep", after: "27-sep", tracks: 1, bars: [] },
    "25-sep": {
      name: "25 Sep",
      before: "24-sep",
      after: "26-sep",
      tracks: 1,
      bars: [{ tone: "fail", at: 58.333, span: 2.778, track: 0, mark: "failed", title: "Iteration limit at review, started by release_train, Fri 14:00, took 40m 0s", run: "failed" }],
    },
    "24-sep": { name: "24 Sep", before: null, after: "25-sep", tracks: 1, bars: [] },
  };

  var PANE_PADDING = 12;
  var ZOOM_BAR = 40;
  var MIN_SCALE = 0.25;
  var MAX_SCALE = 2;
  var ZOOM_STEP = 1.25;
  var OPENING_SCALE = 0.8;
  var CARD_GAP = 6;
  var WINDOW_MARGIN = 8;
  var ARROW_TONES = ["", "fired", "active", "not-yet", "failed"];
  var RINGED = { waiting: true, failed: true, listening: true };
  var KINDS = {
    event: { icon: "bolt", name: "Start trigger" },
    schedule: { icon: "clock", name: "Start trigger" },
    signal: { icon: "bolt", name: "Signal trigger" },
    agent: { icon: "agent", name: "Agent step" },
    action: { icon: "puzzle", name: "Action step" },
  };
  var THREAD_PAGE = "session-active.html";

  /** Returns text with &, <, > and " escaped, so it can sit in markup and in attribute values. */
  function escapeHtml(text) {
    return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /** Returns the class that gives an edge, an arrow or a label its tone, or "" for the plain tone. */
  function toneClass(tone) {
    return tone ? " is-" + tone : "";
  }

  /**
   * Returns the graph to draw for a run, or for the workflow as saved when run is null. A run that followed an
   * earlier version of the workflow carries a plan: a node or an edge it sets to null is left out, and one it
   * sets to a place or a path is drawn there instead.
   */
  function buildLayout(run) {
    var plan = (run && run.plan) || { nodes: {}, edges: {} };
    return {
      width: GRAPH.width,
      height: plan.height || GRAPH.height,
      nodes: GRAPH.nodes
        .filter(function (node) {
          return plan.nodes[node.id] !== null;
        })
        .map(function (node) {
          return Object.assign({}, node, plan.nodes[node.id]);
        }),
      edges: GRAPH.edges
        .filter(function (edge) {
          return plan.edges[edge.name] !== null;
        })
        .map(function (edge) {
          return plan.edges[edge.name] ? Object.assign({}, edge, { path: plan.edges[edge.name] }) : edge;
        }),
    };
  }

  /** Returns the markup of the edges' SVG: an arrowhead per tone, the edges, the bus and the end dot. */
  function buildEdges(layout, run) {
    var markers = ARROW_TONES.map(function (tone) {
      return (
        '<marker id="arrow-' + (tone || "plain") + '" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
        '<path class="arrow' + toneClass(tone) + '" d="M1 1.2L7 4L1 6.8z"/></marker>'
      );
    });
    var paths = layout.edges.map(function (edge) {
      var tone = run ? run.edges[edge.name] : "";
      // A not-taken edge keeps the plain tone and only turns dashed, so its arrowhead is the plain one.
      var arrowTone = tone === "not-taken" ? "plain" : tone || "plain";
      return (
        '<path class="edge' + (edge.signal ? " edge--signal" : "") + toneClass(tone) + '" d="' + edge.path + '"' +
        (edge.arrow ? ' marker-end="url(#arrow-' + arrowTone + ')"' : "") + "/>"
      );
    });
    return (
      '<svg class="graph-edges" width="' + layout.width + '" height="' + layout.height + '" aria-hidden="true">' +
      "<defs>" + markers.join("") + "</defs>" + paths.join("") +
      '<circle class="bus" cx="' + GRAPH.bus[0] + '" cy="' + GRAPH.bus[1] + '" r="2.5"/>' +
      '<circle class="graph-end" cx="' + GRAPH.end[0] + '" cy="' + GRAPH.end[1] + '" r="4"/>' +
      "</svg>"
    );
  }

  /**
   * Returns the markup of the edges' labels, each centred on its edge. A condition is set in mono, as code;
   * the limit is a count, set in the UI font, and on a run it shows how many times the run came to it.
   */
  function buildLabels(run) {
    return GRAPH.labels
      .map(function (label) {
        var tone = run ? run.labels[label.name] : "";
        var text = run && label.isCount ? run.limitCount : label.text;
        return (
          '<span class="edge-label' + (label.isCount ? " edge-label--count" : "") + toneClass(tone) + '" style="left:' + label.x + "px;top:" + label.y + 'px"' +
          (label.condition ? ' title="' + escapeHtml(label.condition) + '"' : "") + ">" + escapeHtml(text) + "</span>"
        );
      })
      .join("");
  }

  /** Returns the markup of one node: its ring and tag, the lead icon, the id and detail, and the run's mark. */
  function buildNode(node, run) {
    var isStep = node.kind === "agent" || node.kind === "action";
    var state = run ? run.nodes[node.id] : null;
    var classes = "node " + (isStep ? "node--step" : "node--trigger") + (state ? " is-" + state.state : "");
    var label = node.id + ", " + node.detail + (run ? ", " + run.cards[node.id].status.text : "");
    return (
      '<button type="button" class="' + classes + '" style="left:' + node.left + "px;top:" + node.top + 'px" data-node="' + node.id + '"' +
      ' aria-label="' + escapeHtml(label) + '" title="' + escapeHtml(node.id + "\n" + node.detail) + '" aria-expanded="false">' +
      (state && RINGED[state.state] ? '<span class="node-ring"></span>' : "") +
      (node.waitsForAll ? '<span class="node-join">all</span>' : "") +
      '<span class="node-lead">' + Crew.icon(KINDS[node.kind].icon, 14) + "</span>" +
      '<span class="node-text"><span class="node-title"><b>' + node.id + "</b>" +
      (state && state.times ? '<span class="node-times">' + state.times + "</span>" : "") +
      '</span><span class="node-detail">' + escapeHtml(node.detail) + "</span></span>" +
      (state && state.mark ? '<span class="node-mark">' + Crew.mark(state.mark, 14) + "</span>" : "") +
      "</button>"
    );
  }

  /** Returns the markup of a card's status line: the node's mark, or the room of one, then its words and the question. */
  function buildCardStatus(status) {
    return (
      '<div class="pop-sec"><div class="line node-status' + (status.tone ? " is-" + status.tone : "") + '">' +
      (status.mark ? Crew.mark(status.mark, 14) : '<span class="no-mark"></span>') +
      '<span class="grow"><b>' + escapeHtml(status.text) + "</b>" + (status.ask ? "<small>" + escapeHtml(status.ask) + "</small>" : "") + "</span></div></div>"
    );
  }

  /** Returns the markup of a card's facts. A fact "as" code is set in mono, and one "as" fail in failure ink. */
  function buildCardFacts(facts) {
    return (
      '<div class="pop-sec"><dl class="node-facts">' +
      facts
        .map(function (fact) {
          return "<div><dt>" + escapeHtml(fact.term) + "</dt><dd" + (fact.as ? ' class="is-' + fact.as + '"' : "") + ">" + escapeHtml(fact.value) + "</dd></div>";
        })
        .join("") +
      "</dl></div>"
    );
  }

  /** Returns the markup of the times a run came to a step, each leading to that time's thread. */
  function buildCardTimes(times) {
    return (
      '<div class="pop-sec"><div class="q-h">' + escapeHtml(times.title) + "</div>" +
      times.rows
        .map(function (time) {
          return (
            '<a class="line" href="' + THREAD_PAGE + '">' + Crew.mark(time.mark, 14) +
            '<span class="grow"><b>' + time.iteration + "</b> " + escapeHtml(time.text) + '</span><span class="line-note">' + time.took + "</span>" +
            Crew.icon("chev-r", 13) + "</a>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  /** Returns the markup of a node's card: the id with the node's kind on the right, then its status, facts, prompt, times and thread. */
  function buildCard(node, run) {
    var card = run ? run.cards[node.id] : DEFINITION[node.id];
    var kind = KINDS[node.kind];
    return (
      '<div class="pop-h">' + Crew.icon(kind.icon, 14) + "<b>" + node.id + "</b><span>" + kind.name + "</span></div>" +
      (card.status ? buildCardStatus(card.status) : "") +
      (card.facts ? buildCardFacts(card.facts) : "") +
      (card.prompt ? '<div class="pop-sec"><div class="q-h">Prompt</div><p class="node-prompt">' + escapeHtml(card.prompt) + "</p></div>" : "") +
      (card.times ? buildCardTimes(card.times) : "") +
      (card.opensThread
        ? '<div class="pop-sec"><a class="line" href="' + THREAD_PAGE + '">' + Crew.icon("threads", 14) + '<span class="grow"><b>Open thread</b></span>' + Crew.icon("chev-r", 13) + "</a></div>"
        : "")
    );
  }

  /** Places the open card below its node, or above it when there is no room below, and inside the window. */
  function placeCard(card, nodeEl) {
    var rect = nodeEl.getBoundingClientRect();
    var height = card.offsetHeight;
    var below = rect.bottom + CARD_GAP;
    var top = below + height <= window.innerHeight - WINDOW_MARGIN ? below : Math.max(WINDOW_MARGIN, rect.top - CARD_GAP - height);
    var left = Math.min(Math.max(rect.left, WINDOW_MARGIN), window.innerWidth - WINDOW_MARGIN - card.offsetWidth);
    card.style.top = top + "px";
    card.style.left = left + "px";
  }

  /** Draws the graph into el, with the run on it when opts.run names one, and opens opts.openNode's card. Fails on an unknown run. */
  function drawGraph(el, opts) {
    var run = opts.run ? RUNS[opts.run] : null;
    if (opts.run && !run) throw new Error("Workflows has no run named " + opts.run);
    var layout = buildLayout(run);
    el.classList.add("graph");
    var frameWidth = el.clientWidth;
    var fit = Math.min(Math.max((frameWidth - 2 * PANE_PADDING) / layout.width, MIN_SCALE), 1);
    var canZoom = fit < 1;
    var scale = Math.max(fit, OPENING_SCALE);
    el.innerHTML =
      '<div class="graph-pane" tabindex="0" role="group" aria-label="The steps of Ship release">' +
      '<div class="graph-room"><div class="graph-draw" style="width:' + layout.width + "px;height:" + layout.height + 'px">' +
      buildEdges(layout, run) + buildLabels(run) +
      layout.nodes
        .map(function (node) {
          return buildNode(node, run);
        })
        .join("") +
      "</div></div></div>" +
      (canZoom
        ? '<div class="pill zoom">' +
          '<button type="button" class="icon-btn" data-zoom="out" aria-label="Zoom out" title="Zoom out (⌘−)">' + Crew.icon("minus", 14) + "</button>" +
          '<output aria-label="Zoom"></output>' +
          '<button type="button" class="icon-btn" data-zoom="in" aria-label="Zoom in" title="Zoom in (⌘+)">' + Crew.icon("plus", 14) + "</button>" +
          '<button type="button" class="btn btn--quiet btn--sm" data-zoom="fit" title="Fit the graph to the pane (⇧1)">Fit</button></div>'
        : "") +
      '<div class="pop node-pop" popover="auto" role="dialog"></div>';

    var pane = el.querySelector(".graph-pane");
    var room = el.querySelector(".graph-room");
    var drawing = el.querySelector(".graph-draw");
    var card = el.querySelector(".node-pop");

    /** Marks the side the pane cuts the graph at, so that side fades. */
    function markCutSides() {
      pane.classList.toggle("is-cut-left", pane.scrollLeft > 0);
      pane.classList.toggle("is-cut-right", pane.scrollLeft + pane.clientWidth < pane.scrollWidth - 1);
    }

    /** Sets the zoom, sizes the pane and its scroll room to the scaled graph, and updates the controls. */
    function zoomTo(next) {
      scale = Math.min(Math.max(next, MIN_SCALE), MAX_SCALE);
      var width = Math.ceil(layout.width * scale) + 2 * PANE_PADDING;
      var height = Math.ceil(layout.height * scale) + 2 * PANE_PADDING;
      drawing.style.transform = "translate(" + PANE_PADDING + "px, " + PANE_PADDING + "px) scale(" + scale + ")";
      room.style.width = width + "px";
      room.style.height = height + "px";
      // The zoom controls sit below the graph, in room of their own, so they never cover a card.
      pane.style.height = height + (canZoom ? ZOOM_BAR : 0) + "px";
      if (canZoom) {
        el.querySelector(".zoom output").textContent = Math.round(scale * 100) + "%";
        el.querySelector('[data-zoom="out"]').disabled = scale <= MIN_SCALE;
        el.querySelector('[data-zoom="in"]').disabled = scale >= MAX_SCALE;
      }
      markCutSides();
    }

    zoomTo(scale);
    pane.addEventListener("scroll", markCutSides);
    el.querySelectorAll("[data-zoom]").forEach(function (button) {
      button.addEventListener("click", function () {
        var how = button.dataset.zoom;
        zoomTo(how === "in" ? scale * ZOOM_STEP : how === "out" ? scale / ZOOM_STEP : fit);
      });
    });
    // ⌘+ and ⌘− zoom and ⌘0 sets 100%, as in a browser; ⇧1 fits the graph to the pane, as in Figma.
    pane.addEventListener("keydown", function (event) {
      if (!canZoom) return;
      var next;
      if (event.metaKey) next = { "=": scale * ZOOM_STEP, "+": scale * ZOOM_STEP, "-": scale / ZOOM_STEP, 0: 1 }[event.key];
      else if (event.shiftKey && event.code === "Digit1") next = fit;
      if (next === undefined) return;
      event.preventDefault();
      zoomTo(next);
    });

    var openId = null;
    var closingId = null;

    /** Opens the card of the node with this id beside it. Fails when the graph has no such node. */
    function openCard(id) {
      var node = layout.nodes.filter(function (n) {
        return n.id === id;
      })[0];
      if (!node) throw new Error("Ship release has no node named " + id);
      var nodeEl = el.querySelector('[data-node="' + id + '"]');
      card.innerHTML = buildCard(node, run);
      card.setAttribute("aria-label", id);
      card.showPopover();
      placeCard(card, nodeEl);
      nodeEl.classList.add("is-open");
      nodeEl.setAttribute("aria-expanded", "true");
      openId = id;
    }

    card.addEventListener("toggle", function (event) {
      if (event.newState !== "closed" || !openId) return;
      var nodeEl = el.querySelector('[data-node="' + openId + '"]');
      nodeEl.classList.remove("is-open");
      nodeEl.setAttribute("aria-expanded", "false");
      openId = null;
    });
    el.querySelectorAll("[data-node]").forEach(function (nodeEl) {
      // A press on the open node closes its card before the click arrives, so the click must not open it again.
      nodeEl.addEventListener("pointerdown", function () {
        closingId = openId === nodeEl.dataset.node ? openId : null;
      });
      nodeEl.addEventListener("click", function () {
        var id = nodeEl.dataset.node;
        if (closingId === id || openId === id) {
          closingId = null;
          if (openId) card.hidePopover();
          return;
        }
        openCard(id);
      });
    });
    if (opts.openNode) openCard(opts.openNode);
  }

  /** Returns a run's mark, or for a cancelled or starting run, which has none, a faint dot named by its words. */
  function buildMarkOrDot(mark, words) {
    return mark ? Crew.mark(mark, 14) : '<span class="dot dot--mark" role="img" aria-label="' + escapeHtml(words) + '"></span>';
  }

  /**
   * Returns the markup of a run's or a step's bar: its line, then its mark at the end, or a faint dot when it has
   * no mark. A bar the day cut at its end has no mark there, only a chevron: its mark is drawn on the day it ends.
   * opts holds tag ("a" or "span"), attrs (extra attribute markup), tone, at, span, track, mark, words (what the
   * dot is named when there is no mark), order (its place in the arrival) and cut ("start", "end" or none).
   */
  function buildBar(opts) {
    var cut = opts.cut;
    return (
      "<" + opts.tag + ' class="run-bar' + (opts.tone ? " run-bar--" + opts.tone : "") + (cut ? " is-cut-" + cut : "") + '"' +
      ' style="--at:' + opts.at + "%;--span:" + opts.span + "%;--track:" + (opts.track || 0) + ";--order:" + opts.order + '"' + (opts.attrs || "") + ">" +
      (cut ? '<span class="run-bar-cut run-bar-cut--' + cut + '">' + Crew.icon(cut === "start" ? "chev-l" : "chev-r", 12) + "</span>" : "") +
      '<span class="run-bar-line"></span>' + (cut === "end" ? "" : buildMarkOrDot(opts.mark, opts.words)) + "</" + opts.tag + ">"
    );
  }

  /** Returns the hour lines at these places on the axis. */
  function buildHourLines(places) {
    return places
      .map(function (at) {
        return '<span class="hour-line" style="--at:' + at + '%"></span>';
      })
      .join("");
  }

  /** Draws one day of runs into el: the day's axis, then its tracks with a bar per run. Fails on an unknown day. */
  function drawRunDay(el, opts) {
    var dayKey = opts.day || "today";
    var day = DAYS[dayKey];
    if (!day) throw new Error("Workflows has no day named " + dayKey);
    var hours = [];
    for (var h = 1; h < 24; h++) hours.push(h);
    var ticks = hours
      // An hour within 45 minutes of now gives its place to the now pill.
      .filter(function (hour) {
        return !day.now || Math.abs(hour / 24 - day.now.at / 100) * 24 * 60 >= 45;
      })
      .map(function (hour) {
        return '<span class="axis-tick' + (hour % 3 === 0 ? " is-major" : "") + '" style="--at:' + (hour / 24) * 100 + '%">' + String(hour).padStart(2, "0") + ":00</span>";
      });
    el.innerHTML =
      '<div class="axis">' + ticks.join("") + (day.now ? '<span class="axis-now" style="--at:' + day.now.at + '%">' + day.now.text + "</span>" : "") + "</div>" +
      '<div class="lanes" style="--tracks:' + day.tracks + '">' +
      buildHourLines(
        hours.map(function (hour) {
          return (hour / 24) * 100;
        }),
      ) +
      (day.now ? '<span class="now-line" style="--at:' + day.now.at + '%"></span>' : "") +
      (day.bars.length === 0 ? '<p class="lanes-empty">' + (dayKey === "today" ? "No runs today" : "No runs this day") + "</p>" : "") +
      day.bars
        .map(function (bar, order) {
          var href = "run.html" + (bar.run === "waiting" ? "" : "?state=" + bar.run);
          return buildBar({
            tag: "a",
            attrs: ' href="' + href + '" title="' + escapeHtml(bar.title) + '" aria-label="' + escapeHtml(bar.title) + '"',
            tone: bar.tone,
            at: bar.at,
            span: bar.span,
            track: bar.track,
            mark: bar.mark,
            words: RUNS[bar.run].title,
            order: order,
            cut: bar.cut,
          });
        })
        .join("") +
      "</div>";
  }

  /** Returns the page's URL with ?day= set to this day, or dropped for today. */
  function buildDayUrl(dayKey) {
    var url = new URL(location.href);
    if (dayKey === "today") url.searchParams.delete("day");
    else url.searchParams.set("day", dayKey);
    return url.search ? url.search : url.pathname.split("/").pop();
  }

  /** Returns a day stepper arrow: a link to the next day that way, or a disabled button at the end of the days. */
  function buildDayArrow(dayKey, label, iconName) {
    var inner = Crew.icon(iconName, 14);
    if (!dayKey) return '<button type="button" class="icon-btn" aria-label="' + label + '" disabled>' + inner + "</button>";
    return '<a class="icon-btn" href="' + buildDayUrl(dayKey) + '" aria-label="' + label + '" title="' + label + '">' + inner + "</a>";
  }

  /** Draws the day stepper into el: a Today button away from today, the arrows, and the day's name. Fails on an unknown day. */
  function drawDayStepper(el, opts) {
    var dayKey = opts.day || "today";
    var day = DAYS[dayKey];
    if (!day) throw new Error("Workflows has no day named " + dayKey);
    el.classList.add("stepper");
    el.innerHTML =
      (dayKey === "today" ? "" : '<a class="btn btn--quiet btn--sm" href="' + buildDayUrl("today") + '">Today</a>') +
      buildDayArrow(day.before, "Show the day before", "chev-l") +
      '<span class="stepper-day">' + day.name + "</span>" +
      buildDayArrow(day.after, "Show the day after", "chev-r");
  }

  /**
   * Draws a run's steps on the run's timeline: the column heads with the run's axis into headEl, then into rowsEl
   * a row per step record, with its bar, and a muted row per plan step the run has not reached, with no bar.
   * Fails on an unknown run.
   */
  function drawStepTimeline(headEl, rowsEl, opts) {
    var run = RUNS[opts.run];
    if (!run) throw new Error("Workflows has no run named " + opts.run);
    var places = run.ticks.map(function (tick) {
      return tick.at;
    });
    headEl.innerHTML =
      "<span></span><span>Step</span>" +
      '<span class="track">' +
      run.ticks
        .map(function (tick) {
          return '<span class="axis-tick" style="--at:' + tick.at + '%">' + tick.text + "</span>";
        })
        .join("") +
      (run.now ? '<span class="axis-now">' + run.now + "</span>" : "") +
      '</span><span class="table-num">Took</span>';
    rowsEl.innerHTML = run.rows
      .map(function (row, order) {
        var reached = row.at !== undefined;
        var words = run.cards[row.step].status.text;
        var cells =
          '<span class="table-mark">' + (reached ? buildMarkOrDot(row.mark, words) : "") + "</span>" +
          '<span class="record"><span class="record-name' + (reached ? "" : " is-quiet") + '">' + row.step + (row.iteration ? " <small>" + row.iteration + "</small>" : "") + "</span>" +
          (row.error ? '<span class="record-err">' + escapeHtml(row.error) + "</span>" : "") + "</span>" +
          '<span class="track">' + buildHourLines(places) +
          (run.now ? '<span class="now-line" style="--at:calc(100% - 1px)"></span>' : "") +
          (reached ? buildBar({ tag: "span", tone: row.tone, at: row.at, span: row.span, mark: row.mark, words: words, order: order }) : "") +
          (row.note ? '<span class="track-note">' + row.note + "</span>" : "") +
          '</span><span class="table-num">' + (row.took || "") + "</span>";
        return row.opensThread
          ? '<a class="table-row tbl-steps" href="' + THREAD_PAGE + '" title="Open ' + row.step + '’s thread">' + cells + "</a>"
          : '<div class="table-row tbl-steps">' + cells + "</div>";
      })
      .join("");
  }

  // Only what the pages use: run.html reads a run's header from RUNS and draws its steps; workflows.html draws the rest.
  window.Workflows = {
    RUNS: RUNS,
    drawGraph: drawGraph,
    drawRunDay: drawRunDay,
    drawDayStepper: drawDayStepper,
    drawStepTimeline: drawStepTimeline,
  };
})();
