#!/bin/sh
set -eu
umask 077

data_dir=$(dirname "${DATABASE_PATH:-/app/data/open-bot.sqlite}")
mkdir -p "$data_dir"
exec 9>"$data_dir/container.lock"
if ! flock --exclusive --nonblock 9; then
  echo 'Open Bot cannot acquire its data-volume lock; another container may be running.' >&2
  exit 75
fi

# The kernel lock is held until this process exits. PID files from a previous
# container cannot establish liveness in this container's PID namespace.
rm -f "$data_dir/supervisor.lock"
exec node --enable-source-maps dist/server/src/server/index.js
