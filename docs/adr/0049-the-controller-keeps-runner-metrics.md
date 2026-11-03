# 49. The controller keeps a history of Runner Metrics

Date: 2026-11-02

## Status

Accepted by [Desktop Fleet: the design and its tickets (#972)](https://github.com/theagenticage/hercule/issues/972), decided with Rogier on 2026-11-02 in the grilling after the prototype on `prototype/fleet-page`.

## Context

Until now a runner reported two numbers every 60 seconds, its free disk and its available memory, and the controller kept only the latest, as one JSON document on the runner row. That is enough to decide placement against the disk limit. It is not enough for the Fleet screen, which shows how a machine was used over the last day and when its disk will reach its limit:

- a graph needs the values of the past, not only the latest one;
- a forecast needs several days of free space;
- CPU was not reported at all;
- on macOS, the available memory the runner reported was the free pages alone, which is close to zero on any Mac that has run for a while.

The report was called the watermark, which is also the name of the disk limit the controller holds. One word for two things made the code hard to read.

## Decision

**The runner reports its metrics every minute, and the controller keeps one row per runner per minute for 14 days.**

- **The name.** The fluctuating report is the **Runner Metrics**: free disk, available memory and CPU. "Watermark" now means only the disk limit. The rename is made in code and docs; on the wire the frame keeps its old tag and key until the next protocol version raise, so runners and controllers of either age still read each other.
- **CPU** is read once a second and reported per minute as its average and its peak, so a short spike is not lost between reports. Memory on macOS ~~counts the free, inactive and purgeable pages, as the system itself does~~. *(Amended 2026-11-03, [#982](https://github.com/theagenticage/hercule/issues/982).)* Memory on macOS is total RAM minus Activity Monitor's "Memory Used", so the gauge agrees with what the user sees there ([spec 03](../spec/03-controller-and-runners.md) section 4.1).
- **The disk's size** joins the Runner Facts, because it does not change from minute to minute.
- **One row per runner per minute**, with that minute's session counts taken from the controller's own records, in its own table in the one database. A minute with no report has no row.
- **Kept 14 days** by default, as the controller setting `retention.runnerMetrics`, with no screen to change it in v1. The prune is built with the table, once an hour.
- **Read as points of five minutes or one hour**, with each point's mean, lowest available memory and highest CPU, so a graph of a day is one page and the peak bands survive.
- **Live by nudge.** ~~Every row written nudges the `runner` topic~~ *(Amended 2026-11-03, [#983](https://github.com/theagenticage/hercule/issues/983).)* Every row written nudges a topic of its own, `runnerMetrics`, not `runner`: a routine report changes no Runner record, and nudging `runner` would make every runner read refetch once a minute per runner ([spec 03](../spec/03-controller-and-runners.md) section 4.3). A client reads only the points after the newest it holds. Nothing polls.
- **The forecast is the client's:** a straight line through 7 days of hourly points, in `@hercule/client-core`, where its rules can be tested beside the screen that shows them.

## Considered options

- **Keep only the latest values, and let the screen draw from what it sees while open.** Rejected: the screen would show nothing for a machine the user did not watch, and no forecast at all.
- **Export to OpenTelemetry and leave history to a metrics system.** Rejected for v1: it makes a second system a requirement for one screen. Exporting the same metrics is post-v1 ([#978](https://github.com/theagenticage/hercule/issues/978)), and the names already match what such a system would call them.
- **Keep the metrics on the runner, and ask for them when a page opens.** Rejected: an offline machine is exactly the one whose recent history matters, and it could not answer.
- **Per-session memory and CPU.** Rejected: a session's tools, such as a build or a container, run outside the session's process tree in ways the runner cannot follow, and the number would blame the wrong session. The memory graph is the whole machine's.
- **A longer default, such as 90 days.** Rejected for now: the graphs cover 24 hours and 14 days, and the forecast reads 7. *(Amended 2026-11-03, [#1005](https://github.com/theagenticage/hercule/issues/1005), decided by Rogier: the machine page's 14-day Disk graph is gone, so the desktop app's Fleet screens read at most 7 days of hour points now, the disk forecast's. CLI and API callers can still read hour points up to the retention. The 14-day default is unchanged.)* About 15 MB for five machines is a cost worth paying; three months is not.

## Consequences

- The database grows by about 3 MB per machine and holds steady after 14 days.
- The controller writes one small row per runner per minute and deletes as many once an hour. Neither waits on anything outside the database.
- The runner gains one timer, a CPU read each second.
- Placement is unchanged: it still reads free disk against the disk limit, and CPU and memory take no part in it.
- The web app reads the renamed `metrics` key with the slice that renames it; showing the history there is [#977](https://github.com/theagenticage/hercule/issues/977).
