#!/bin/bash
# Rotated rounds of bench-wasm.mjs: main's committed bundle, this branch's with
# the option off and with it on.
M=$(cd "$(dirname "$0")" && pwd)
W=$M/..
OPTS='{"frequencyDictionary":"","frequencyOrder":"auto","primaryReading":""'
orders=("main off on" "off on main" "on main off" "main on off" "off main on" "on off main")
for round in 0 1 2 3 4 5; do
  for v in ${orders[$round]}; do
    case $v in
      main) dir=$W/wasm-main; opts="$OPTS}";;
      off) dir=$W/wasm-branch; opts="$OPTS,\"metadataOnlyTerms\":false}";;
      on) dir=$W/wasm-branch; opts="$OPTS,\"metadataOnlyTerms\":true}";;
    esac
    node "$M/bench-wasm.mjs" "$dir" "$M/imported" "$M/neko-windows.txt" "$v round $((round + 1))" "$opts"
  done
done
