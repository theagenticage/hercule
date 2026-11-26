#!/bin/sh
# usage: run.sh name mode hookcmd [timeout]
S=/var/tmp/hercule-1282-t12
cd /tmp/hercule-1282/recorder/scenarios
exec env -i PATH=/home/<user>/n/bin:/usr/local/bin:/usr/bin:/bin HOME=$S/fakehome TMPDIR=$S/tmp KEEPLOG=1 /home/<user>/n/bin/bun t12-run.ts "$@"
