#!/usr/bin/env bash
# Install one Playwright browser and its system dependencies, bounded.
#
# `playwright install --with-deps` shells out to `apt-get`, which has no timeout
# of its own. On 2026-08-19 the runner's Azure mirror was skipped, apt fell back
# to the public archive, and the call sat silent for 3h05m on the WebKit job
# while Chromium's identical step merely slowed to 5m54s. WebKit needs by far the
# most packages, so a degraded mirror turns "slow" into "hung" there first.
#
# Two changes make that survivable: the browser download is skipped entirely on a
# cache hit, and every apt attempt is bounded so a stall fails fast and retries
# instead of burning the 360-minute GitHub default.
set -euo pipefail

project="${1:?usage: install-playwright.sh <chromium|webkit|firefox>}"
deps_timeout="${PLAYWRIGHT_DEPS_TIMEOUT_SECONDS:-420}"
attempts="${PLAYWRIGHT_DEPS_ATTEMPTS:-3}"

for attempt in $(seq 1 "$attempts"); do
  # Capture the command's own status: after an `if` block `$?` is the status of
  # the `if` itself, which is 0 even when the condition failed.
  status=0
  timeout --signal=TERM --kill-after=30s "$deps_timeout" \
    npx --no-install playwright install --with-deps "$project" || status=$?
  if [ "$status" -eq 0 ]; then
    echo "playwright install succeeded for ${project} on attempt ${attempt}"
    exit 0
  fi
  if [ "$attempt" -eq "$attempts" ]; then
    echo "playwright install failed for ${project} after ${attempts} attempts (last status ${status})" >&2
    exit "$status"
  fi
  echo "playwright install attempt ${attempt} for ${project} failed with status ${status}; retrying" >&2
  # A killed apt can leave dpkg mid-transaction and the lock held; clear both so
  # the retry starts from a consistent state rather than failing the same way.
  sudo pkill -f 'apt-get|dpkg' 2>/dev/null || true
  sudo rm -f /var/lib/apt/lists/lock /var/cache/apt/archives/lock /var/lib/dpkg/lock-frontend || true
  sudo dpkg --configure -a || true
  sleep $(( attempt * 15 ))
done
