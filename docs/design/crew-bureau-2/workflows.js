/*
 * The Workflows pages' shared drawing: the Ship release workflow's graph, with or without a run on it,
 * a day of its runs on the timeline, the day stepper, and a run's steps on the run's own timeline.
 *
 * - Workflows.drawGraph(el, { run, openNode }) draws the graph into el. run is a key of Workflows.RUNS;
 *   without one the graph is the workflow as saved. openNode opens that node's card once the graph is drawn.
 * - Workflows.drawRunDay(el, { day }) draws one day of runs: its axis, then its tracks. day is a key of
 *   Workflows.DAYS, "today" by default.
 * - Workflows.drawDayStepper(el, { day }) draws the day stepper. Its buttons are links that set ?day= on
 *   the page's URL, so a page that reads ?day= and passes it to both calls steps through the days.
 * - Workflows.drawStepTimeline(headEl, rowsEl, { run }) draws a run's step records: the column heads with
 *   the run's axis into headEl, and one row per record into rowsEl.
 *
 * The positions of the cards, edges and labels were read from the prototype's rendered graph, which the
 * app's layout drew, so the book draws exactly what the app will.
 */
(function () {
  "use strict";

  var GRAPH = {
    width: 1511,
    height: 257.5,
    bus: [216, 142.25],
    end: [1505, 132.5],
    // [id, kind (event, schedule, signal, agent or action), left, top, detail, waits for every edge into it]
    nodes: [
      ["release_issue", "event", 0, 84.25, "github.issue.labeled", false],
      ["release_train", "schedule", 0, 152.25, "Fridays at 14:00", false],
      ["pr_merged", "signal", 883, 108.5, "github.pr.merged", false],
      ["changelog", "agent", 256, 209.5, "Writer", false],
      ["security", "agent", 256, 141.5, "Auditor", false],
      ["test", "agent", 256, 73.5, "Tester", false],
      ["review", "agent", 256, 5.5, "Reviewer", false],
      ["fix", "agent", 619, 0, "Coder", false],
      ["open_pr", "action", 619, 108.5, "Open a GitHub pull request", true],
      ["announce", "agent", 1099, 108.5, "Writer", false],
      ["notify", "action", 1315, 108.5, "Send a notification", false]
    ],
    // [path, has an arrowhead, is a correlation edge]. The last edge is the stub to the end dot.
    edges: [
      ["M176,108.3 L177.3,108.3 C178.7,108.3 181.3,108.3 184.7,108.3 C188,108.3 192,108.3 196,113.9 C200,119.6 204,130.9 207.3,136.6 C210.7,142.3 213.3,142.3 214.7,142.3 L216,142.3", false, false],
      ["M176,176.3 L177.3,176.3 C178.7,176.3 181.3,176.3 184.7,176.3 C188,176.3 192,176.3 196,170.6 C200,164.9 204,153.6 207.3,147.9 C210.7,142.3 213.3,142.3 214.7,142.3 L216,142.3", false, false],
      ["M216,142.3 L217.3,142.3 C218.7,142.3 221.3,142.3 224.7,157.5 C228,172.7 232,203.1 236,218.3 C240,233.5 244,233.5 247.3,233.5 C250.7,233.5 253.3,233.5 254.7,233.5 L256,233.5", true, false],
      ["M216,142.3 L217.3,142.3 C218.7,142.3 221.3,142.3 224.7,146.1 C228,150 232,157.8 236,161.6 C240,165.5 244,165.5 247.3,165.5 C250.7,165.5 253.3,165.5 254.7,165.5 L256,165.5", true, false],
      ["M216,142.3 L217.3,142.3 C218.7,142.3 221.3,142.3 224.7,134.8 C228,127.3 232,112.4 236,105 C240,97.5 244,97.5 247.3,97.5 C250.7,97.5 253.3,97.5 254.7,97.5 L256,97.5", true, false],
      ["M216,142.3 L217.3,142.3 C218.7,142.3 221.3,142.3 224.7,123.5 C228,104.7 232,67.1 236,48.3 C240,29.5 244,29.5 247.3,29.5 C250.7,29.5 253.3,29.5 254.7,29.5 L256,29.5", true, false],
      ["M432,233.5 L433.3,233.5 C434.7,233.5 437.3,233.5 440.7,233.5 C444,233.5 448,233.5 450,233.5 C452,233.5 452,233.5 476.5,233.5 C501,233.5 550,233.5 574.5,233.5 C599,233.5 599,233.5 601,218.7 C603,203.8 607,174.2 610.3,159.3 C613.7,144.5 616.3,144.5 617.7,144.5 L619,144.5", true, false],
      ["M432,97.5 L433.3,97.5 C434.7,97.5 437.3,97.5 440.7,97.5 C444,97.5 448,97.5 450,97.5 C452,97.5 452,97.5 476.5,97.5 C501,97.5 550,97.5 574.5,97.5 C599,97.5 599,97.5 601,102.7 C603,107.8 607,118.2 610.3,123.3 C613.7,128.5 616.3,128.5 617.7,128.5 L619,128.5", true, false],
      ["M432,165.5 L433.3,165.5 C434.7,165.5 437.3,165.5 440.7,165.5 C444,165.5 448,165.5 450,165.5 C452,165.5 452,165.5 476.5,165.5 C501,165.5 550,165.5 574.5,165.5 C599,165.5 599,165.5 601,160.7 C603,155.8 607,146.2 610.3,141.3 C613.7,136.5 616.3,136.5 617.7,136.5 L619,136.5", true, false],
      ["M432,41.5 L433.3,41.5 C434.7,41.5 437.3,41.5 440.7,45.8 C444,50.1 448,58.7 450,63 C452,67.3 452,67.3 476.5,67.3 C501,67.3 550,67.3 574.5,67.3 C599,67.3 599,67.3 601,76.1 C603,85 607,102.8 610.3,111.6 C613.7,120.5 616.3,120.5 617.7,120.5 L619,120.5", true, false],
      ["M432,29.5 L433.3,29.5 C434.7,29.5 437.3,29.5 440.7,31.3 C444,33.1 448,36.7 450,38.5 C452,40.3 452,40.3 476.5,40.3 C501,40.3 550,40.3 574.5,40.3 C599,40.3 599,40.3 601,39.5 C603,38.8 607,37.4 610.3,36.7 C613.7,36 616.3,36 617.7,36 L619,36", true, false],
      ["M619,12 L617.7,12 C616.3,12 613.7,12 610.3,12.2 C607,12.4 603,12.8 601,13 C599,13.3 599,13.3 574.5,13.3 C550,13.3 501,13.3 476.5,13.3 C452,13.3 452,13.3 450,14 C448,14.7 444,16.1 440.7,16.8 C437.3,17.5 434.7,17.5 433.3,17.5 L432,17.5", true, false],
      ["M1059,132.5 L1060.3,132.5 C1061.7,132.5 1064.3,132.5 1067.7,132.5 C1071,132.5 1075,132.5 1079,132.5 C1083,132.5 1087,132.5 1090.3,132.5 C1093.7,132.5 1096.3,132.5 1097.7,132.5 L1099,132.5", true, false],
      ["M1275,132.5 L1276.3,132.5 C1277.7,132.5 1280.3,132.5 1283.7,132.5 C1287,132.5 1291,132.5 1295,132.5 C1299,132.5 1303,132.5 1306.3,132.5 C1309.7,132.5 1312.3,132.5 1313.7,132.5 L1315,132.5", true, false],
      ["M795,132.5 L796.3,132.5 C797.7,132.5 800.3,132.5 803.7,132.5 C807,132.5 811,132.5 813,132.5 C815,132.5 815,132.5 823,132.5 C831,132.5 847,132.5 855,132.5 C863,132.5 863,132.5 865,132.5 C867,132.5 871,132.5 874.3,132.5 C877.7,132.5 880.3,132.5 881.7,132.5 L883,132.5", false, true],
      ["M1491 132.5h10", false, false]
    ],
    // [x, y, text, the full condition] at the centre of the edge it labels.
    labels: [
      [525.5, 67.25, "verdict == \"approved\"", "steps.review.output.verdict == \"approved\""],
      [525.5, 40.25, "verdict == \"changes\"", "steps.review.output.verdict == \"changes\""],
      [525.5, 13.25, "≤ 3", ""],
      [839, 132.5, "number", "event.payload.number == steps.open_pr.output.number"]
    ],
  };

  // The card of details of each node of the workflow as saved, with no run.
  var DEFINITION = {
    release_issue: [["facts", [["Fires on", "github.issue.labeled · any connection"], ["Filter", "event.payload.label.name == \"release\"", "code"]]]],
    release_train: [["facts", [["Fires on", "0 14 * * 5", "code"], ["Next", "Fri 14:00"], ["Last fired", "Fri"]]]],
    pr_merged: [["facts", [["Listens for", "github.pr.merged · any connection"], ["Matches", "event.payload.number == steps.open_pr.output.number", "code"]]]],
    changelog: [["facts", [["Agent", "Writer"], ["Access", "Approval required, from the Agent"]]], ["prompt", "Write the changelog for {{ inputs.version }} from the merged pull requests."]],
    security: [["facts", [["Agent", "Auditor"], ["Access", "Approval required, from the Agent"]]], ["prompt", "Audit the dependencies and fix what you can."]],
    test: [["facts", [["Agent", "Tester"], ["Access", "Approval required, from the Agent"]]], ["prompt", "Run the full test suite and the end-to-end tests."]],
    review: [["facts", [["Agent", "Reviewer"], ["Access", "Approval required, from the Agent"], ["Returns", "verdict", "code"]]], ["prompt", "Review the release diff. Answer approved or changes."]],
    fix: [["facts", [["Agent", "Coder"], ["Access", "Approval required, from the Agent"]]], ["prompt", "Make the changes the review asked for."]],
    open_pr: [["facts", [["Action", "Open a GitHub pull request"], ["connection", "any", "code"], ["title", "Release {{ inputs.version }}", "code"], ["head", "release/{{ inputs.version }}", "code"], ["base", "main", "code"], ["Waits for", "Every step before it"]]]],
    announce: [["facts", [["Agent", "Writer"], ["Access", "Approval required, from the Agent"]]], ["prompt", "Write the release announcement from the changelog."]],
    notify: [["facts", [["Action", "Send a notification"], ["title", "Released {{ inputs.version }}", "code"], ["Ends the run", "When it completes"]]]],
  };

  var RUNS = {
    "waiting": {
      time: "Today 09:12",
      live: true,
      mark: "waiting",
      title: "Waiting on you",
      took: "29m 0s",
      gist: ["you", "security asks: Run npm audit fix --force?", true],
      by: ["bolt", "Started by release_issue"],
      inputs: [["version", "2.14.0"]],
      note: null,
      steps: 9,
      nodes: {
        release_issue: ["fired", "done", null],
        release_train: ["quiet", null, null],
        pr_merged: ["quiet", null, null],
        changelog: ["done", "done", null],
        security: ["waiting", "waiting", null],
        test: ["done", "done", null],
        review: ["done", "done", "×2"],
        fix: ["done", "done", null],
        open_pr: ["pending", null, null],
        announce: ["unreached", null, null],
        notify: ["unreached", null, null],
      },
      edges: ["active", "not-yet", "fired", "active", "fired", "fired", "fired", "fired", "not-yet", "fired", "fired", "fired", "not-yet", "not-yet", "not-yet", "not-yet"],
      labels: [["fired", "verdict == \"approved\""], ["fired", "verdict == \"changes\""], ["fired", "1/3"], ["not-yet", "number"]],
      ticks: [[0, "0"], [17.236, "5m"], [34.473, "10m"], [51.709, "15m"], [68.946, "20m"], [86.182, "25m"]],
      now: "now 29m 0s",
      rows: [
        ["done", "changelog", null, null, 0, 10.342, "", null, "3m 0s", true],
        ["done", "test", null, null, 0, 27.578, "", null, "8m 0s", true],
        ["waiting", "security", null, null, 0, 100, "you", null, "29m 0s", true],
        ["done", "review", "#1", null, 0, 17.236, "", null, "5m 0s", true],
        ["done", "fix", null, null, 17.236, 34.473, "", null, "10m 0s", true],
        ["done", "review", "#2", null, 51.709, 13.789, "", null, "4m 0s", true],
        [null, "open_pr", null, null, null, null, null, "pending", "", false],
        [null, "announce", null, null, null, null, null, null, "", false],
        [null, "notify", null, null, null, null, null, null, "", false],
      ],
      cards: {
        release_issue: [["status", "", "done", "Started this run"], ["facts", [["Fires on", "github.issue.labeled · any connection"], ["Filter", "event.payload.label.name == \"release\"", "code"]]]],
        release_train: [["status", "", null, "Did not start this run"], ["facts", [["Fires on", "0 14 * * 5", "code"]]]],
        pr_merged: [["status", "", null, "Has not fired"], ["facts", [["Listens for", "github.pr.merged · any connection"], ["Matches", "event.payload.number == steps.open_pr.output.number", "code"]]]],
        changelog: [["status", "", "done", "Done"], ["facts", [["Model", "Claude Sonnet 5"], ["Tokens", "49.7k"], ["Tool calls", "46"], ["Cost", "$0.12"], ["Started", "Today 09:12"], ["Took", "3m 0s"], ["Output", "{\"changelog\":\"…\"}", "code"]]], ["prompt", "Write the changelog for {{ inputs.version }} from the merged pull requests."], ["thread"]],
        security: [["status", "you", "waiting", "Waiting on you", "Run npm audit fix --force?"], ["facts", [["Model", "Claude Sonnet 5"], ["Tokens", "49.9k"], ["Tool calls", "2"], ["Cost", "$0.12"], ["Started", "Today 09:12"], ["Running for", "29m 0s"]]], ["prompt", "Audit the dependencies and fix what you can."], ["thread"]],
        test: [["status", "", "done", "Done"], ["facts", [["Model", "Claude Sonnet 5"], ["Tokens", "49.8k"], ["Tool calls", "47"], ["Cost", "$0.12"], ["Started", "Today 09:12"], ["Took", "8m 0s"], ["Output", "{\"passed\":true}", "code"]]], ["prompt", "Run the full test suite and the end-to-end tests."], ["thread"]],
        review: [["status", "", "done", "Done"], ["facts", [["Model", "Claude Sonnet 5"], ["Tokens", "49.6k"], ["Tool calls", "45"], ["Cost", "$0.12"], ["Started", "Today 09:27"], ["Took", "4m 0s"], ["Output", "{\"verdict\":\"approved\"}", "code"]]], ["prompt", "Review the release diff. Answer approved or changes."], ["times", "Ran 2 times", [["done", "#1", "Done", "5m 0s"], ["done", "#2", "Done", "4m 0s"]]], ["thread"]],
        fix: [["status", "", "done", "Done"], ["facts", [["Model", "Claude Sonnet 5"], ["Tokens", "50.0k"], ["Tool calls", "3"], ["Cost", "$0.12"], ["Started", "Today 09:17"], ["Took", "10m 0s"], ["Output", "{\"commits\":2}", "code"]]], ["prompt", "Make the changes the review asked for."], ["thread"]],
        open_pr: [["status", "", null, "Waiting to start"]],
        announce: [["status", "", null, "Not reached in this run"], ["prompt", "Write the release announcement from the changelog."]],
        notify: [["status", "", null, "Not reached in this run"]],
      },
    },
    "failed": {
      time: "25 Sep 14:00",
      live: false,
      mark: "failed",
      title: "Failed",
      took: "40m 0s",
      gist: ["fail", "Iteration limit at review. The run would follow review → fix a fourth time, past its limit of 3.", false],
      by: ["clock", "Started by release_train"],
      inputs: [["version", "2.13.0"]],
      note: null,
      steps: 13,
      nodes: {
        release_issue: ["quiet", null, null],
        release_train: ["fired", "done", null],
        pr_merged: ["quiet", null, null],
        changelog: ["done", "done", null],
        security: ["done", "done", null],
        test: ["done", "done", null],
        review: ["done", "done", "×4"],
        fix: ["done", "done", "×3"],
        open_pr: ["unreached", null, null],
        announce: ["unreached", null, null],
        notify: ["unreached", null, null],
      },
      edges: ["not-taken", "fired", "fired", "fired", "fired", "fired", "fired", "fired", "fired", "not-taken", "failed", "fired", "not-taken", "not-taken", "not-taken", "not-yet"],
      labels: [["", "verdict == \"approved\""], ["failed", "verdict == \"changes\""], ["fired", "3/3"], ["", "number"]],
      ticks: [[0, "0"], [25, "10m"], [50, "20m"], [75, "30m"], [100, "40m"]],
      now: null,
      rows: [
        ["done", "changelog", null, null, 0, 10, "", null, "4m 0s", true],
        ["done", "security", null, null, 0, 15, "", null, "6m 0s", true],
        ["done", "test", null, null, 0, 22.5, "", null, "9m 0s", true],
        ["done", "review", "#1", null, 0, 10, "", null, "4m 0s", true],
        ["done", "fix", "#1", null, 10, 20, "", null, "8m 0s", true],
        ["done", "review", "#2", null, 30, 10.0, "", null, "4m 0s", true],
        ["done", "fix", "#2", null, 40, 20.0, "", null, "8m 0s", true],
        ["done", "review", "#3", null, 60, 10.0, "", null, "4m 0s", true],
        ["done", "fix", "#3", null, 70, 20.0, "", null, "8m 0s", true],
        ["done", "review", "#4", null, 90, 10.0, "", null, "4m 0s", true],
        [null, "open_pr", null, null, null, null, null, "not reached", "", false],
        [null, "announce", null, null, null, null, null, "not reached", "", false],
        [null, "notify", null, null, null, null, null, "not reached", "", false],
      ],
      cards: {
        release_issue: [["status", "", null, "Did not start this run"], ["facts", [["Fires on", "github.issue.labeled · any connection"], ["Filter", "event.payload.label.name == \"release\"", "code"]]]],
        release_train: [["status", "", "done", "Started this run"], ["facts", [["Fires on", "0 14 * * 5", "code"]]]],
        pr_merged: [["status", "", null, "Has not fired"], ["facts", [["Listens for", "github.pr.merged · any connection"], ["Matches", "event.payload.number == steps.open_pr.output.number", "code"]]]],
        changelog: [["status", "", "done", "Done"], ["facts", [["Model", "Claude Sonnet 5"], ["Tokens", "54.7k"], ["Tool calls", "3"], ["Cost", "$0.14"], ["Started", "25 Sep 14:00"], ["Took", "4m 0s"], ["Output", "{\"changelog\":\"…\"}", "code"]]], ["prompt", "Write the changelog for {{ inputs.version }} from the merged pull requests."], ["thread"]],
        security: [["status", "", "done", "Done"], ["facts", [["Model", "Claude Sonnet 5"], ["Tokens", "54.8k"], ["Tool calls", "4"], ["Cost", "$0.14"], ["Started", "25 Sep 14:00"], ["Took", "6m 0s"], ["Output", "{\"findings\":0}", "code"]]], ["prompt", "Audit the dependencies and fix what you can."], ["thread"]],
        test: [["status", "", "done", "Done"], ["facts", [["Model", "Claude Sonnet 5"], ["Tokens", "54.9k"], ["Tool calls", "5"], ["Cost", "$0.14"], ["Started", "25 Sep 14:00"], ["Took", "9m 0s"], ["Output", "{\"passed\":true}", "code"]]], ["prompt", "Run the full test suite and the end-to-end tests."], ["thread"]],
        review: [["status", "", "done", "Done"], ["facts", [["Model", "Claude Sonnet 5"], ["Tokens", "54.5k"], ["Tool calls", "47"], ["Cost", "$0.13"], ["Started", "25 Sep 14:36"], ["Took", "4m 0s"], ["Output", "{\"verdict\":\"changes\"}", "code"]]], ["prompt", "Review the release diff. Answer approved or changes."], ["times", "Ran 4 times", [["done", "#1", "Done", "4m 0s"], ["done", "#2", "Done", "4m 0s"], ["done", "#3", "Done", "4m 0s"], ["done", "#4", "Done", "4m 0s"]]], ["thread"]],
        fix: [["status", "", "done", "Done"], ["facts", [["Model", "Claude Sonnet 5"], ["Tokens", "54.6k"], ["Tool calls", "2"], ["Cost", "$0.14"], ["Started", "25 Sep 14:28"], ["Took", "8m 0s"], ["Output", "{\"commits\":1}", "code"]]], ["prompt", "Make the changes the review asked for."], ["times", "Ran 3 times", [["done", "#1", "Done", "8m 0s"], ["done", "#2", "Done", "8m 0s"], ["done", "#3", "Done", "8m 0s"]]], ["thread"]],
        open_pr: [["status", "", null, "Not reached in this run"]],
        announce: [["status", "", null, "Not reached in this run"], ["prompt", "Write the release announcement from the changelog."]],
        notify: [["status", "", null, "Not reached in this run"]],
      },
    },
    "step-failed": {
      time: "10 Sep 03:50",
      live: false,
      mark: "failed",
      title: "Failed",
      took: "11m 0s",
      gist: ["fail", "Session failed at test. The session ended its turn with an error: 3 end-to-end tests failed.", false],
      by: ["bolt", "Started by release_issue"],
      inputs: [["version", "2.11.3"]],
      note: null,
      steps: 8,
      nodes: {
        release_issue: ["fired", "done", null],
        release_train: ["quiet", null, null],
        pr_merged: ["quiet", null, null],
        changelog: ["done", "done", null],
        security: ["done", "done", null],
        test: ["failed", "failed", null],
        review: ["done", "done", null],
        fix: ["unreached", null, null],
        open_pr: ["unreached", null, null],
        announce: ["unreached", null, null],
        notify: ["unreached", null, null],
      },
      edges: ["fired", "not-taken", "fired", "fired", "fired", "fired", "fired", "not-taken", "fired", "fired", "not-taken", "not-taken", "not-taken", "not-taken", "not-taken", "not-yet"],
      labels: [["fired", "verdict == \"approved\""], ["", "verdict == \"changes\""], ["", "0/3"], ["", "number"]],
      ticks: [[0, "0"], [18.182, "2m"], [36.364, "4m"], [54.545, "6m"], [72.727, "8m"], [90.909, "10m"]],
      now: null,
      rows: [
        ["done", "changelog", null, null, 0, 36.364, "", null, "4m 0s", true],
        ["done", "security", null, null, 0, 63.636, "", null, "7m 0s", true],
        ["failed", "test", null, "The session ended its turn with an error: 3 end-to-end tests failed.", 0, 100, "fail", null, "11m 0s", true],
        ["done", "review", null, null, 0, 54.545, "", null, "6m 0s", true],
        [null, "fix", null, null, null, null, null, "not reached", "", false],
        [null, "open_pr", null, null, null, null, null, "not reached", "", false],
        [null, "announce", null, null, null, null, null, "not reached", "", false],
        [null, "notify", null, null, null, null, null, "not reached", "", false],
      ],
      cards: {
        release_issue: [["status", "", "done", "Started this run"], ["facts", [["Fires on", "github.issue.labeled · any connection"], ["Filter", "event.payload.label.name == \"release\"", "code"]]]],
        release_train: [["status", "", null, "Did not start this run"], ["facts", [["Fires on", "0 14 * * 5", "code"]]]],
        pr_merged: [["status", "", null, "Has not fired"], ["facts", [["Listens for", "github.pr.merged · any connection"], ["Matches", "event.payload.number == steps.open_pr.output.number", "code"]]]],
        changelog: [["status", "", "done", "Done"], ["facts", [["Model", "Claude Sonnet 5"], ["Tokens", "56.2k"], ["Tool calls", "17"], ["Cost", "$0.14"], ["Started", "10 Sep 03:50"], ["Took", "4m 0s"], ["Output", "{\"changelog\":\"…\"}", "code"]]], ["prompt", "Write the changelog for {{ inputs.version }} from the merged pull requests."], ["thread"]],
        security: [["status", "", "done", "Done"], ["facts", [["Model", "Claude Sonnet 5"], ["Tokens", "56.3k"], ["Tool calls", "18"], ["Cost", "$0.14"], ["Started", "10 Sep 03:50"], ["Took", "7m 0s"], ["Output", "{\"findings\":0}", "code"]]], ["prompt", "Audit the dependencies and fix what you can."], ["thread"]],
        test: [["status", "fail", "failed", "Failed"], ["facts", [["Model", "Claude Sonnet 5"], ["Tokens", "56.4k"], ["Tool calls", "19"], ["Cost", "$0.14"], ["Started", "10 Sep 03:50"], ["Took", "11m 0s"], ["Error", "The session ended its turn with an error: 3 end-to-end tests failed.", "fail"]]], ["prompt", "Run the full test suite and the end-to-end tests."], ["thread"]],
        review: [["status", "", "done", "Done"], ["facts", [["Model", "Claude Sonnet 5"], ["Tokens", "56.5k"], ["Tool calls", "20"], ["Cost", "$0.14"], ["Started", "10 Sep 03:50"], ["Took", "6m 0s"], ["Output", "{\"verdict\":\"approved\"}", "code"]]], ["prompt", "Review the release diff. Answer approved or changes."], ["thread"]],
        fix: [["status", "", null, "Not reached in this run"], ["prompt", "Make the changes the review asked for."]],
        open_pr: [["status", "", null, "Not reached in this run"]],
        announce: [["status", "", null, "Not reached in this run"], ["prompt", "Write the release announcement from the changelog."]],
        notify: [["status", "", null, "Not reached in this run"]],
      },
    },
    "listening": {
      time: "Yesterday 05:41",
      live: true,
      mark: "working",
      title: "Running",
      took: "28h 0m",
      gist: null,
      by: [null, "Started by you"],
      inputs: [["version", "2.13.1"]],
      note: null,
      steps: 8,
      nodes: {
        release_issue: ["quiet", null, null],
        release_train: ["quiet", null, null],
        pr_merged: ["listening", "idle", null],
        changelog: ["done", "done", null],
        security: ["done", "done", null],
        test: ["done", "done", null],
        review: ["done", "done", null],
        fix: ["unreached", null, null],
        open_pr: ["done", "done", null],
        announce: ["unreached", null, null],
        notify: ["unreached", null, null],
      },
      edges: ["not-yet", "not-yet", "not-yet", "not-yet", "not-yet", "not-yet", "fired", "fired", "fired", "fired", "not-taken", "not-yet", "not-yet", "not-yet", "fired", "not-yet"],
      labels: [["fired", "verdict == \"approved\""], ["", "verdict == \"changes\""], ["not-yet", "0/3"], ["fired", "number"]],
      ticks: [[0, "0"], [21.429, "6h"], [42.857, "12h"], [64.286, "18h"], [85.714, "24h"]],
      now: "now 28h 0m",
      rows: [
        ["done", "changelog", null, null, 0, 0.238, "", null, "4m 0s", true],
        ["done", "security", null, null, 0, 0.417, "", null, "7m 0s", true],
        ["done", "test", null, null, 0, 0.536, "", null, "9m 0s", true],
        ["done", "review", null, null, 0, 0.357, "", null, "6m 0s", true],
        ["done", "open_pr", null, null, 0.536, 0.06, "", null, "1m 0s", false],
        [null, "fix", null, null, null, null, null, null, "", false],
        [null, "announce", null, null, null, null, null, null, "", false],
        [null, "notify", null, null, null, null, null, null, "", false],
      ],
      cards: {
        release_issue: [["status", "", null, "Did not start this run"], ["facts", [["Fires on", "github.issue.labeled · any connection"], ["Filter", "event.payload.label.name == \"release\"", "code"]]]],
        release_train: [["status", "", null, "Did not start this run"], ["facts", [["Fires on", "0 14 * * 5", "code"]]]],
        pr_merged: [["status", "", "idle", "Listening for its event"], ["facts", [["Listens for", "github.pr.merged · any connection"], ["Matches", "event.payload.number == steps.open_pr.output.number", "code"]]]],
        changelog: [["status", "", "done", "Done"], ["facts", [["Model", "Claude Sonnet 5"], ["Tokens", "50.1k"], ["Tool calls", "4"], ["Cost", "$0.12"], ["Started", "Yesterday 05:41"], ["Took", "4m 0s"], ["Output", "{\"changelog\":\"…\"}", "code"]]], ["prompt", "Write the changelog for {{ inputs.version }} from the merged pull requests."], ["thread"]],
        security: [["status", "", "done", "Done"], ["facts", [["Model", "Claude Sonnet 5"], ["Tokens", "50.2k"], ["Tool calls", "5"], ["Cost", "$0.12"], ["Started", "Yesterday 05:41"], ["Took", "7m 0s"], ["Output", "{\"findings\":0}", "code"]]], ["prompt", "Audit the dependencies and fix what you can."], ["thread"]],
        test: [["status", "", "done", "Done"], ["facts", [["Model", "Claude Sonnet 5"], ["Tokens", "50.3k"], ["Tool calls", "6"], ["Cost", "$0.12"], ["Started", "Yesterday 05:41"], ["Took", "9m 0s"], ["Output", "{\"passed\":true}", "code"]]], ["prompt", "Run the full test suite and the end-to-end tests."], ["thread"]],
        review: [["status", "", "done", "Done"], ["facts", [["Model", "Claude Sonnet 5"], ["Tokens", "50.4k"], ["Tool calls", "7"], ["Cost", "$0.12"], ["Started", "Yesterday 05:41"], ["Took", "6m 0s"], ["Output", "{\"verdict\":\"approved\"}", "code"]]], ["prompt", "Review the release diff. Answer approved or changes."], ["thread"]],
        fix: [["status", "", null, "Not reached in this run"], ["prompt", "Make the changes the review asked for."]],
        open_pr: [["status", "", "done", "Done"], ["facts", [["Started", "Yesterday 05:50"], ["Took", "1m 0s"], ["Output", "{\"number\":4810}", "code"]]]],
        announce: [["status", "", null, "Not reached in this run"], ["prompt", "Write the release announcement from the changelog."]],
        notify: [["status", "", null, "Not reached in this run"]],
      },
    },
    "completed": {
      time: "22 Sep 05:00",
      live: false,
      mark: "done",
      title: "Completed",
      took: "1h 23m",
      gist: null,
      by: ["bolt", "Started by release_issue"],
      inputs: [["version", "2.12.3"]],
      note: null,
      steps: 9,
      nodes: {
        release_issue: ["fired", "done", null],
        release_train: ["quiet", null, null],
        pr_merged: ["fired", "done", null],
        changelog: ["done", "done", null],
        security: ["done", "done", null],
        test: ["done", "done", null],
        review: ["done", "done", null],
        fix: ["unreached", null, null],
        open_pr: ["done", "done", null],
        announce: ["done", "done", null],
        notify: ["done", "done", null],
      },
      edges: ["fired", "not-taken", "fired", "fired", "fired", "fired", "fired", "fired", "fired", "fired", "not-taken", "not-taken", "fired", "fired", "fired", "fired"],
      labels: [["fired", "verdict == \"approved\""], ["", "verdict == \"changes\""], ["", "0/3"], ["fired", "number"]],
      ticks: [[0, "0"], [18.072, "15m"], [36.145, "30m"], [54.217, "45m"], [72.289, "1h"], [90.361, "1h 15m"]],
      now: null,
      rows: [
        ["done", "changelog", null, null, 0, 4.819, "", null, "4m 0s", true],
        ["done", "security", null, null, 0, 8.434, "", null, "7m 0s", true],
        ["done", "test", null, null, 0, 10.843, "", null, "9m 0s", true],
        ["done", "review", null, null, 0, 7.229, "", null, "6m 0s", true],
        ["done", "open_pr", null, null, 10.843, 1.205, "", null, "1m 0s", false],
        ["done", "pr_merged", null, null, 96.386, 0, "", null, "", false],
        ["done", "announce", null, null, 96.386, 3.614, "", null, "3m 0s", true],
        ["done", "notify", null, null, 100, 0, "", null, "0ms", false],
        [null, "fix", null, null, null, null, null, "not reached", "", false],
      ],
      cards: {
        release_issue: [["status", "", "done", "Started this run"], ["facts", [["Fires on", "github.issue.labeled · any connection"], ["Filter", "event.payload.label.name == \"release\"", "code"]]]],
        release_train: [["status", "", null, "Did not start this run"], ["facts", [["Fires on", "0 14 * * 5", "code"]]]],
        pr_merged: [["status", "", "done", "Fired"], ["facts", [["Started", "22 Sep 06:20"], ["Took", "0ms"], ["Output", "{\"number\":4797}", "code"], ["Listens for", "github.pr.merged · any connection"], ["Matches", "event.payload.number == steps.open_pr.output.number", "code"]]]],
        changelog: [["status", "", "done", "Done"], ["facts", [["Model", "Claude Sonnet 5"], ["Tokens", "55.0k"], ["Tool calls", "6"], ["Cost", "$0.14"], ["Started", "22 Sep 05:00"], ["Took", "4m 0s"], ["Output", "{\"changelog\":\"…\"}", "code"]]], ["prompt", "Write the changelog for {{ inputs.version }} from the merged pull requests."], ["thread"]],
        security: [["status", "", "done", "Done"], ["facts", [["Model", "Claude Sonnet 5"], ["Tokens", "52.7k"], ["Tool calls", "29"], ["Cost", "$0.13"], ["Started", "22 Sep 05:00"], ["Took", "7m 0s"], ["Output", "{\"findings\":0}", "code"]]], ["prompt", "Audit the dependencies and fix what you can."], ["thread"]],
        test: [["status", "", "done", "Done"], ["facts", [["Model", "Claude Sonnet 5"], ["Tokens", "52.8k"], ["Tool calls", "30"], ["Cost", "$0.13"], ["Started", "22 Sep 05:00"], ["Took", "9m 0s"], ["Output", "{\"passed\":true}", "code"]]], ["prompt", "Run the full test suite and the end-to-end tests."], ["thread"]],
        review: [["status", "", "done", "Done"], ["facts", [["Model", "Claude Sonnet 5"], ["Tokens", "52.9k"], ["Tool calls", "31"], ["Cost", "$0.13"], ["Started", "22 Sep 05:00"], ["Took", "6m 0s"], ["Output", "{\"verdict\":\"approved\"}", "code"]]], ["prompt", "Review the release diff. Answer approved or changes."], ["thread"]],
        fix: [["status", "", null, "Not reached in this run"], ["prompt", "Make the changes the review asked for."]],
        open_pr: [["status", "", "done", "Done"], ["facts", [["Started", "22 Sep 05:09"], ["Took", "1m 0s"], ["Output", "{\"number\":4810}", "code"]]]],
        announce: [["status", "", "done", "Done"], ["facts", [["Model", "Claude Sonnet 5"], ["Tokens", "53.0k"], ["Tool calls", "32"], ["Cost", "$0.13"], ["Started", "22 Sep 06:20"], ["Took", "3m 0s"], ["Output", "{\"posted\":true}", "code"]]], ["prompt", "Write the release announcement from the changelog."], ["thread"]],
        notify: [["status", "", "done", "Done"], ["facts", [["Started", "22 Sep 06:23"], ["Took", "0ms"]]]],
      },
    },
    "earlier": {
      time: "14 Aug 03:50",
      live: false,
      mark: "done",
      title: "Completed",
      took: "1h 23m",
      gist: null,
      by: ["bolt", "Started by release_issue"],
      inputs: [["version", "2.8.0"]],
      note: "This run followed an earlier version of Ship release. Its steps are shown as they were then.",
      steps: 9,
      nodes: {
        release_issue: ["fired", "done", null],
        release_train: ["quiet", null, null],
        pr_merged: ["fired", "done", null],
        changelog: ["done", "done", null],
        security: ["done", "done", null],
        test: ["done", "done", null],
        review: ["done", "done", null],
        fix: ["unreached", null, null],
        open_pr: ["done", "done", null],
        announce: ["done", "done", null],
        notify: ["done", "done", null],
      },
      edges: ["fired", "not-taken", "fired", "fired", "fired", "fired", "fired", "fired", "fired", "fired", "not-taken", "not-taken", "fired", "fired", "fired", "fired"],
      labels: [["fired", "verdict == \"approved\""], ["", "verdict == \"changes\""], ["", "0/3"], ["fired", "number"]],
      ticks: [[0, "0"], [18.072, "15m"], [36.145, "30m"], [54.217, "45m"], [72.289, "1h"], [90.361, "1h 15m"]],
      now: null,
      rows: [
        ["done", "changelog", null, null, 0, 4.819, "", null, "4m 0s", true],
        ["done", "security", null, null, 0, 8.434, "", null, "7m 0s", true],
        ["done", "test", null, null, 0, 10.843, "", null, "9m 0s", true],
        ["done", "review", null, null, 0, 7.229, "", null, "6m 0s", true],
        ["done", "open_pr", null, null, 10.843, 1.205, "", null, "1m 0s", false],
        ["done", "pr_merged", null, null, 96.386, 0, "", null, "", false],
        ["done", "announce", null, null, 96.386, 3.614, "", null, "3m 0s", true],
        ["done", "notify", null, null, 100, 0, "", null, "0ms", false],
        [null, "fix", null, null, null, null, null, "not reached", "", false],
      ],
      cards: {
        release_issue: [["status", "", "done", "Started this run"], ["facts", [["Fires on", "github.issue.labeled · any connection"], ["Filter", "event.payload.label.name == \"release\"", "code"]]]],
        release_train: [["status", "", null, "Did not start this run"], ["facts", [["Fires on", "0 14 * * 5", "code"]]]],
        pr_merged: [["status", "", "done", "Fired"], ["facts", [["Started", "14 Aug 05:10"], ["Took", "0ms"], ["Output", "{\"number\":4784}", "code"], ["Listens for", "github.pr.merged · any connection"], ["Matches", "event.payload.number == steps.open_pr.output.number", "code"]]]],
        changelog: [["status", "", "done", "Done"], ["facts", [["Model", "Claude Sonnet 5"], ["Tokens", "47.7k"], ["Tool calls", "37"], ["Cost", "$0.17"], ["Started", "14 Aug 03:50"], ["Took", "4m 0s"], ["Output", "{\"changelog\":\"…\"}", "code"]]], ["prompt", "Write the changelog for {{ inputs.version }} from the merged pull requests."], ["thread"]],
        security: [["status", "", "done", "Done"], ["facts", [["Model", "Claude Sonnet 5"], ["Tokens", "47.8k"], ["Tool calls", "38"], ["Cost", "$0.17"], ["Started", "14 Aug 03:50"], ["Took", "7m 0s"], ["Output", "{\"findings\":0}", "code"]]], ["prompt", "Audit the dependencies and fix what you can."], ["thread"]],
        test: [["status", "", "done", "Done"], ["facts", [["Model", "Claude Sonnet 5"], ["Tokens", "45.4k"], ["Tool calls", "15"], ["Cost", "$0.17"], ["Started", "14 Aug 03:50"], ["Took", "9m 0s"], ["Output", "{\"passed\":true}", "code"]]], ["prompt", "Run the full test suite."], ["thread"]],
        review: [["status", "", "done", "Done"], ["facts", [["Model", "Claude Sonnet 5"], ["Tokens", "45.5k"], ["Tool calls", "16"], ["Cost", "$0.17"], ["Started", "14 Aug 03:50"], ["Took", "6m 0s"], ["Output", "{\"verdict\":\"approved\"}", "code"]]], ["prompt", "Review the release diff. Answer approved or changes."], ["thread"]],
        fix: [["status", "", null, "Not reached in this run"], ["prompt", "Make the changes the review asked for."]],
        open_pr: [["status", "", "done", "Done"], ["facts", [["Started", "14 Aug 03:59"], ["Took", "1m 0s"], ["Output", "{\"number\":4810}", "code"]]]],
        announce: [["status", "", "done", "Done"], ["facts", [["Model", "Claude Sonnet 5"], ["Tokens", "45.6k"], ["Tool calls", "17"], ["Cost", "$0.17"], ["Started", "14 Aug 05:10"], ["Took", "3m 0s"], ["Output", "{\"posted\":true}", "code"]]], ["prompt", "Write the release announcement from the changelog."], ["thread"]],
        notify: [["status", "", "done", "Done"], ["facts", [["Started", "14 Aug 05:13"], ["Took", "0ms"]]]],
      },
    },
  };

  // One day of the workflow's runs. A bar is [tone, at, span, track, mark, title, run key, cut], with at
  // and span as percentages of the day; tone is "", "you" or "fail" and cut is "start" or "end".
  var DAYS = {
    today: {
      name: "Today",
      before: "yesterday",
      after: null,
      now: [40.347, "09:41"],
      tracks: 2,
      bars: [
        ["", 0, 40.347, 0, "working", "Running, started by you, yesterday 05:41, running for 28h 0m", "listening", "start"],
        ["you", 38.333, 2.014, 1, "waiting", "security asks: Run npm audit fix --force?, started by release_issue, 09:12, running for 29m 0s", "waiting", null],
      ],
    },
    yesterday: {
      name: "Yesterday",
      before: "27-sep",
      after: "today",
      tracks: 1,
      bars: [["", 23.681, 76.319, 0, "working", "Running, started by you, yesterday 05:41, running for 28h 0m", "listening", "end"]],
    },
    "27-sep": { name: "27 Sep", before: "26-sep", after: "yesterday", tracks: 1, bars: [] },
    "26-sep": { name: "26 Sep", before: "25-sep", after: "27-sep", tracks: 1, bars: [] },
    "25-sep": {
      name: "25 Sep",
      before: "24-sep",
      after: "26-sep",
      tracks: 1,
      bars: [["fail", 58.333, 2.778, 0, "failed", "Iteration limit at review, started by release_train, 25 Sep 14:00, took 40m 0s", "failed", null]],
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
    event: ["bolt", "Start trigger"],
    schedule: ["clock", "Start trigger"],
    signal: ["bolt", "Signal trigger"],
    agent: ["agent", "Agent step"],
    action: ["puzzle", "Action step"],
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

  /** Returns the markup of the edges' SVG: an arrowhead per tone, the edges, the bus and the end dot. */
  function buildEdges(run) {
    var markers = ARROW_TONES.map(function (tone) {
      return (
        '<marker id="arrow-' + (tone || "plain") + '" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
        '<path class="arrow' + toneClass(tone) + '" d="M1 1.2L7 4L1 6.8z"/></marker>'
      );
    });
    var paths = GRAPH.edges.map(function (edge, i) {
      var tone = run ? run.edges[i] : "";
      // A not-taken edge keeps the plain tone and only turns dashed, so its arrowhead is the plain one.
      var arrowTone = tone === "not-taken" ? "plain" : tone || "plain";
      return (
        '<path class="edge' + (edge[2] ? " edge--signal" : "") + toneClass(tone) + '" d="' + edge[0] + '"' +
        (edge[1] ? ' marker-end="url(#arrow-' + arrowTone + ')"' : "") + "/>"
      );
    });
    return (
      '<svg class="graph-edges" width="' + GRAPH.width + '" height="' + GRAPH.height + '" aria-hidden="true">' +
      "<defs>" + markers.join("") + "</defs>" + paths.join("") +
      '<circle class="bus" cx="' + GRAPH.bus[0] + '" cy="' + GRAPH.bus[1] + '" r="2.5"/>' +
      '<circle class="graph-end" cx="' + GRAPH.end[0] + '" cy="' + GRAPH.end[1] + '" r="4"/>' +
      "</svg>"
    );
  }

  /** Returns the markup of the edges' labels, each centred on its edge, with the run's counts when there is a run. */
  function buildLabels(run) {
    return GRAPH.labels
      .map(function (label, i) {
        var tone = run ? run.labels[i][0] : "";
        var text = run ? run.labels[i][1] : label[2];
        return (
          '<span class="edge-label' + toneClass(tone) + '" style="left:' + label[0] + "px;top:" + label[1] + 'px"' +
          (label[3] ? ' title="' + escapeHtml(label[3]) + '"' : "") + ">" + escapeHtml(text) + "</span>"
        );
      })
      .join("");
  }

  /** Returns the status words of a node on a run, read from its card, for the node's accessible name. */
  function readStatusWords(run, id) {
    var status = run.cards[id].filter(function (section) {
      return section[0] === "status";
    })[0];
    return status ? status[3] : "";
  }

  /** Returns the markup of one node: its ring and tag, the lead icon, the id and detail, and the run's mark. */
  function buildNode(node, run) {
    var id = node[0];
    var kind = node[1];
    var isStep = kind === "agent" || kind === "action";
    var state = run ? run.nodes[id] : null;
    var classes = "node " + (isStep ? "node--step" : "node--trigger") + (state ? " is-" + state[0] : "");
    var label = id + ", " + node[4] + (run ? ", " + readStatusWords(run, id) : "");
    return (
      '<button type="button" class="' + classes + '" style="left:' + node[2] + "px;top:" + node[3] + 'px" data-node="' + id + '"' +
      ' aria-label="' + escapeHtml(label) + '" title="' + escapeHtml(id + "\n" + node[4]) + '" aria-expanded="false">' +
      (state && RINGED[state[0]] ? '<span class="node-ring"></span>' : "") +
      (node[5] ? '<span class="node-join">all</span>' : "") +
      '<span class="node-lead">' + Crew.icon(KINDS[kind][0], 14) + "</span>" +
      '<span class="node-text"><span class="node-title"><b>' + id + "</b>" +
      (state && state[2] ? '<span class="node-times">' + state[2] + "</span>" : "") +
      '</span><span class="node-detail">' + escapeHtml(node[4]) + "</span></span>" +
      (state && state[1] ? '<span class="node-mark">' + Crew.mark(state[1], 14) + "</span>" : "") +
      "</button>"
    );
  }

  /** Returns the markup of one section of a node's card. */
  function buildCardSection(section) {
    switch (section[0]) {
      case "status":
        return (
          '<div class="pop-sec"><div class="line node-status' + (section[1] ? " is-" + section[1] : "") + '">' +
          (section[2] ? Crew.mark(section[2], 14) : '<span class="no-mark"></span>') +
          '<span class="grow"><b>' + escapeHtml(section[3]) + "</b>" + (section[4] ? "<small>" + escapeHtml(section[4]) + "</small>" : "") + "</span></div></div>"
        );
      case "facts":
        return (
          '<div class="pop-sec"><dl class="node-facts">' +
          section[1]
            .map(function (fact) {
              return "<div><dt>" + escapeHtml(fact[0]) + "</dt><dd" + (fact[2] ? ' class="is-' + fact[2] + '"' : "") + ">" + escapeHtml(fact[1]) + "</dd></div>";
            })
            .join("") +
          "</dl></div>"
        );
      case "prompt":
        return '<div class="pop-sec"><div class="q-h">Prompt</div><p class="node-prompt">' + escapeHtml(section[1]) + "</p></div>";
      case "times":
        return (
          '<div class="pop-sec"><div class="q-h">' + escapeHtml(section[1]) + "</div>" +
          section[2]
            .map(function (time) {
              return (
                '<a class="line" href="' + THREAD_PAGE + '">' + Crew.mark(time[0], 14) +
                '<span class="grow"><b>' + time[1] + "</b> " + escapeHtml(time[2]) + '</span><span class="line-note">' + time[3] + "</span>" +
                Crew.icon("chev-r", 13) + "</a>"
              );
            })
            .join("") +
          "</div>"
        );
      case "thread":
        return '<div class="pop-sec"><a class="line" href="' + THREAD_PAGE + '">' + Crew.icon("threads", 14) + '<span class="grow"><b>Open thread</b></span>' + Crew.icon("chev-r", 13) + "</a></div>";
    }
    throw new Error("A node's card has no section named " + section[0]);
  }

  /** Returns the markup of a node's card: the id with the node's kind on the right, then its sections. */
  function buildCard(node, run) {
    var sections = run ? run.cards[node[0]] : DEFINITION[node[0]];
    var kind = KINDS[node[1]];
    return '<div class="pop-h">' + Crew.icon(kind[0], 14) + "<b>" + node[0] + "</b><span>" + kind[1] + "</span></div>" + sections.map(buildCardSection).join("");
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

  /** Draws the graph into el, with the run on it when opts.run names one, and opens opts.openNode's card. */
  function drawGraph(el, opts) {
    var run = opts.run ? RUNS[opts.run] : null;
    if (opts.run && !run) throw new Error("Workflows has no run named " + opts.run);
    el.classList.add("graph");
    var frameWidth = el.clientWidth;
    var fit = Math.min(Math.max((frameWidth - 2 * PANE_PADDING) / GRAPH.width, MIN_SCALE), 1);
    var canZoom = fit < 1;
    var scale = Math.max(fit, OPENING_SCALE);
    el.innerHTML =
      '<div class="graph-pane" tabindex="0" role="group" aria-label="The steps of Ship release">' +
      '<div class="graph-room"><div class="graph-draw" style="width:' + GRAPH.width + "px;height:" + GRAPH.height + 'px">' +
      buildEdges(run) + buildLabels(run) +
      GRAPH.nodes.map(function (node) {
        return buildNode(node, run);
      }).join("") +
      "</div></div></div>" +
      (canZoom
        ? '<div class="pill zoom">' +
          '<button type="button" class="icon-btn" data-zoom="out" aria-label="Zoom out" title="Zoom out (⌘−)">' + Crew.icon("minus", 14) + "</button>" +
          '<output aria-label="Zoom"></output>' +
          '<button type="button" class="icon-btn" data-zoom="in" aria-label="Zoom in" title="Zoom in (⌘+)">' + Crew.icon("plus", 14) + "</button>" +
          '<button type="button" class="btn btn--quiet btn--sm" data-zoom="fit" title="Fit the graph to the pane (⌘9)">Fit</button></div>'
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
      var width = Math.ceil(GRAPH.width * scale) + 2 * PANE_PADDING;
      var height = Math.ceil(GRAPH.height * scale) + 2 * PANE_PADDING;
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
    pane.addEventListener("keydown", function (event) {
      if (!event.metaKey || !canZoom) return;
      var next = { "=": scale * ZOOM_STEP, "+": scale * ZOOM_STEP, "-": scale / ZOOM_STEP, 0: 1, 9: fit }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      zoomTo(next);
    });

    var openId = null;
    var closingId = null;

    /** Opens the card of the node with this id beside it. */
    function openCard(id) {
      var node = GRAPH.nodes.filter(function (n) {
        return n[0] === id;
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

  /** Returns the markup of a run's bar: its line, its mark at the end, and a chevron where the day cut it. */
  function buildBar(tag, attrs, tone, at, span, track, mark, order, cut) {
    return (
      "<" + tag + ' class="run-bar' + (tone ? " run-bar--" + tone : "") + (cut ? " is-cut-" + cut : "") + '"' +
      ' style="--at:' + at + "%;--span:" + span + "%;--track:" + track + ";--order:" + order + '"' + attrs + ">" +
      (cut ? '<span class="run-bar-cut run-bar-cut--' + cut + '">' + Crew.icon(cut === "start" ? "chev-l" : "chev-r", 12) + "</span>" : "") +
      '<span class="run-bar-line"></span>' + Crew.mark(mark, 14) + "</" + tag + ">"
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

  /** Draws one day of runs into el: the day's axis, then its tracks with a bar per run. */
  function drawRunDay(el, opts) {
    var dayKey = opts.day || "today";
    var day = DAYS[dayKey];
    if (!day) throw new Error("Workflows has no day named " + dayKey);
    var hours = [];
    for (var h = 1; h < 24; h++) hours.push(h);
    var ticks = hours
      // An hour within 45 minutes of now gives its place to the now pill.
      .filter(function (hour) {
        return !day.now || Math.abs(hour / 24 - day.now[0] / 100) * 24 * 60 >= 45;
      })
      .map(function (hour) {
        return '<span class="axis-tick' + (hour % 3 === 0 ? " is-major" : "") + '" style="--at:' + (hour / 24) * 100 + '%">' + String(hour).padStart(2, "0") + ":00</span>";
      });
    el.innerHTML =
      '<div class="axis">' + ticks.join("") + (day.now ? '<span class="axis-now" style="--at:' + day.now[0] + '%">' + day.now[1] + "</span>" : "") + "</div>" +
      '<div class="lanes" style="--tracks:' + day.tracks + '">' +
      buildHourLines(hours.map(function (hour) {
        return (hour / 24) * 100;
      })) +
      (day.now ? '<span class="now-line" style="--at:' + day.now[0] + '%"></span>' : "") +
      (day.bars.length === 0 ? '<p class="lanes-empty">' + (dayKey === "today" ? "No runs today" : "No runs this day") + "</p>" : "") +
      day.bars
        .map(function (bar, order) {
          var href = "run.html" + (bar[6] === "waiting" ? "" : "?state=" + bar[6]);
          return buildBar("a", ' href="' + href + '" title="' + escapeHtml(bar[5]) + '" aria-label="' + escapeHtml(bar[5]) + '"', bar[0], bar[1], bar[2], bar[3], bar[4], order, bar[7]);
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

  /** Draws the day stepper into el: a Today button away from today, the arrows, and the day's name. */
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

  /** Draws a run's step records: the column heads with the run's axis into headEl, and a row per record into rowsEl. */
  function drawStepTimeline(headEl, rowsEl, opts) {
    var run = RUNS[opts.run];
    if (!run) throw new Error("Workflows has no run named " + opts.run);
    var places = run.ticks.map(function (tick) {
      return tick[0];
    });
    headEl.innerHTML =
      "<span></span><span>Step</span>" +
      '<span class="track">' +
      run.ticks
        .map(function (tick) {
          return '<span class="axis-tick" style="--at:' + tick[0] + '%">' + tick[1] + "</span>";
        })
        .join("") +
      (run.now ? '<span class="axis-now">' + run.now + "</span>" : "") +
      '</span><span class="docket-num">Took</span>';
    rowsEl.innerHTML = run.rows
      .map(function (row, order) {
        var id = row[1];
        var reached = row[0] !== null;
        var cells =
          '<span class="docket-mark">' + (reached ? Crew.mark(row[0], 14) : "") + "</span>" +
          '<span class="record"><span class="record-name' + (reached ? "" : " is-quiet") + '">' + id + (row[2] ? " <small>" + row[2] + "</small>" : "") + "</span>" +
          (row[3] ? '<span class="record-err">' + escapeHtml(row[3]) + "</span>" : "") + "</span>" +
          '<span class="track">' + buildHourLines(places) +
          (run.now ? '<span class="now-line" style="--at:calc(100% - 1px)"></span>' : "") +
          (row[4] !== null ? buildBar("span", "", row[6], row[4], row[5], 0, row[0], order, null) : "") +
          (row[7] ? '<span class="track-note" style="--at:100%">' + row[7] + "</span>" : "") +
          '</span><span class="docket-num">' + row[8] + "</span>";
        return row[9]
          ? '<a class="docket-row tbl-steps" href="' + THREAD_PAGE + '" title="Open ' + id + '’s thread">' + cells + "</a>"
          : '<div class="docket-row tbl-steps">' + cells + "</div>";
      })
      .join("");
  }

  window.Workflows = {
    GRAPH: GRAPH,
    RUNS: RUNS,
    DAYS: DAYS,
    drawGraph: drawGraph,
    drawRunDay: drawRunDay,
    drawDayStepper: drawDayStepper,
    drawStepTimeline: drawStepTimeline,
  };
})();
