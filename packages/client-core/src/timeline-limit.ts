/**
 * The most days back the timeline goes: ten years. The open workflow's search
 * validator refuses a `daysBack` above it, and `computeTimelineDay` clamps
 * to it, so the day is always one the platform's timezone data covers well.
 *
 * It has a module of its own because the search validator runs on the
 * desktop app's first screen: importing it from `run-timeline` would put the
 * whole timeline module there.
 */
export const MAX_TIMELINE_DAYS_BACK = 3650;
