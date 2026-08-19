#!/usr/bin/env bash
# Install one Playwright browser and its system dependencies, bounded.
#
# Why this exists: `playwright install --with-deps` shells out to `apt-get`,
# which has no timeout of its own. On 2026-08-19 the runner's Azure mirror was
# skipped, apt fell back to the public archive, and the WebKit job sat silent for
# 3h05m. A later run with bounds measured the same degradation across the board:
# WebKit 6m59s, Firefox 15m42s, Chromium still unfinished at 20m.
#
# So the two halves are separated and treated differently:
#
#   1. The browser binaries come from the Playwright CDN and are cacheable, so a
#      cache hit skips this entirely. Failure here is fatal: without the browser
#      there is nothing to test.
#   2. The system packages come from apt, cannot be cached across runs, and are
#      the part that actually hangs. They are bounded and retried, and if apt is
#      unreachable the step warns and continues rather than blocking the whole
#      pipeline. The runner image already carries most of these libraries; if one
#      is genuinely missing, the browser fails to launch and the test step says so
#      loudly. That is a better failure than a green-less pipeline during an
#      upstream mirror outage.
#
# Keep the total budget below the job's `timeout-minutes`, or the job timeout
# kills a retry that could still have succeeded.
set -euo pipefail

project="${1:?usage: install-playwright.sh <chromium|webkit|firefox>}"
attempt_timeout="${PLAYWRIGHT_ATTEMPT_TIMEOUT_SECONDS:-240}"
attempts="${PLAYWRIGHT_ATTEMPTS:-3}"

run_bounded() {
  # Capture the command's own status: after an `if` block `$?` is the status of
  # the `if` itself, which is 0 even when the condition failed.
  local label="$1"; shift
  local status
  for attempt in $(seq 1 "$attempts"); do
    status=0
    timeout --signal=TERM --kill-after=30s "$attempt_timeout" "$@" || status=$?
    if [ "$status" -eq 0 ]; then
      echo "${label} succeeded for ${project} on attempt ${attempt}"
      return 0
    fi
    echo "${label} attempt ${attempt} for ${project} failed with status ${status}" >&2
    if [ "$attempt" -lt "$attempts" ]; then
      # A killed apt can leave dpkg mid-transaction and the lock held; clear both
      # so the retry starts from a consistent state rather than failing the same way.
      sudo pkill -f 'apt-get|dpkg' 2>/dev/null || true
      sudo rm -f /var/lib/apt/lists/lock /var/cache/apt/archives/lock /var/lib/dpkg/lock-frontend || true
      sudo dpkg --configure -a || true
      sleep $(( attempt * 10 ))
    fi
  done
  return "$status"
}

# Browser binaries: cacheable, and required.
run_bounded "browser download" npx --no-install playwright install "$project"

# System packages: not cacheable, and the part that hangs upstream.
if ! run_bounded "system dependency install" npx --no-install playwright install-deps "$project"; then
  echo "::warning title=Playwright system dependencies::apt did not complete for ${project} after ${attempts} attempts; continuing. If a library is genuinely missing the browser will fail to launch and the test step will report it."
fi
