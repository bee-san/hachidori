#!/bin/bash
# run-dumps.sh: option off over all-inputs (494,276) for 35e2dab and the fix
# (sha256 only), option on over neko-32 (40,000) for both (kept), 4 processes.
. /local/home/skerraut/herd-synth3/reports/hachi-issue-658-evidence/env.sh
cd $E
(./probe-base dump $DICTS all-inputs.txt off | sha256sum > dump-off-base.sha256) &
(./probe-fix dump $DICTS all-inputs.txt off | sha256sum > dump-off-fix.sha256) &
./probe-base dump $DICTS neko-32.txt on > dump-on-neko-base.txt &
./probe-fix dump $DICTS neko-32.txt on > dump-on-neko-fix.txt &
wait
