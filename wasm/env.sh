#!/bin/sh
# Shared Emscripten environment for every build entry point in this repo.
#
# emsdk's launchers run `python3` from PATH and require >= 3.10, but this host's
# /usr/bin/python3 is 3.9. EMSHIM puts a newer python3 first on PATH.
EMSDK_DIR="${EMSDK_DIR:-$HOME/emsdk}"
EMSHIM="${EMSHIM:-$HOME/.local/emshim}"

if [ ! -x "$EMSHIM/python3" ]; then
  mkdir -p "$EMSHIM"
  for v in 3.13 3.12 3.11 3.10; do
    if [ -x "$HOME/.local/bin/python$v" ]; then
      ln -sf "$HOME/.local/bin/python$v" "$EMSHIM/python3"
      break
    fi
  done
fi

PATH="$EMSHIM:$PATH"
export PATH
export EMSDK_PYTHON="$EMSHIM/python3"
# shellcheck disable=SC1091
. "$EMSDK_DIR/emsdk_env.sh" >/dev/null 2>&1
PATH="$EMSHIM:$PATH"
export PATH
