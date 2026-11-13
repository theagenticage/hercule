Measure a change's performance cost with `pnpm --filter @hercule/desktop perf:counts --write-baseline` on `main`, then `perf:counts` on your branch (`perf:counts:container` on Linux without Chromium's libraries), and explain in the PR any count that went up.
CI runs the same check on every desktop PR and posts its report as a PR comment; it never fails on a count.
