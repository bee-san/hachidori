#!/bin/bash
# bench-wasm.sh: hdw_lookup over the 40,000 32-character hovers (neko-32.txt),
# main's committed threaded bundle and this branch's, option off and on; six
# rounds in rotated order, one process at a time, two passes each.
E=/local/home/skerraut/herd-synth3/reports/hachi-issue-658-evidence
export PATH=$HOME/.local/share/mise/installs/node/22.23.1/bin:$PATH
DICTS=/local/home/skerraut/herd-synth3/reports/audit-hachi-fix-620-evidence/imported
OPTS='{"frequencyDictionary":"","frequencyOrder":"auto","primaryReading":""'
V=(main-off main-on fix-off fix-on)
for round in 0 1 2 3 4 5; do
  for k in 0 1 2 3; do
    v=${V[$(( (k + round) % 4 ))]}
    case $v in
      main-*) dir=$E/wasm-main;;
      fix-*) dir=$E/wasm-branch;;
    esac
    case $v in
      *-off) opts="$OPTS,\"metadataOnlyTerms\":false}";;
      *-on) opts="$OPTS,\"metadataOnlyTerms\":true}";;
    esac
    node $E/bench-wasm.mjs "$dir" "$DICTS" "$E/neko-32.txt" "$v round $((round + 1))" "$opts"
  done
done
