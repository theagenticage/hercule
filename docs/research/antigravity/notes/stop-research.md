# Stop research (real agy)
Recordings: /tmp/hercule-1282/rec3/{stop-bg,stop-fg,stop-cancel,read-outside}.jsonl (stop-bg.jsonl was overwritten? no: bg, fg, cancel each own file). Scenarios: recorder/scenarios/stop-research.ts, stop-lib.ts, read-outside.ts.
1. SIGTERM to front agy (bg sleep 600 and fg sleep 600): front exits in 250-400 ms. Workers, shell, sleep all gone at +2 s and +5 s. No SIGKILL needed. Tree before: front -> 2 workers (`acp --worker`) -> `sleep 600` (sleep has its OWN pgid = its pid). Front and workers share the pgid of the parent that spawned the front (not their own group). All carry the unique TMPDIR in environ; the sleep too.
2. session/cancel while bg sleep runs: reply stopReason "cancelled"; the sleep was gone 5 s later (workers stay, front stays).
3. default mode: read_file of /etc/hostname asks permission (1 request, kind read); reading ../parent-secret.txt also asks (1 request).
