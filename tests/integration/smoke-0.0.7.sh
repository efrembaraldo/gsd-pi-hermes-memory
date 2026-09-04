#!/usr/bin/env bash
# Smoke driver for the 0.0.7 release pipeline.
#
# Goal: prove in a fresh clone that the assembly chain
#   git clone -> npm install -> @gsd/* symlinks -> npm run check
#   -> npm test -> gsd -e ./src/index.ts
# runs end-to-end, and that the two idempotent steps
# (link-pi-sdks.mjs and npm install) are truly no-ops when re-run.
#
# Usage:
#   bash tests/integration/smoke-0.0.7.sh
#     # WORKTREE is auto-detected via `git rev-parse --show-toplevel`.
#   WORKTREE=/path/to/clone bash tests/integration/smoke-0.0.7.sh
#     # Explicit override (useful for CI without running inside a git worktree).
#
# Output:
#   $tmp/smoke-0.0.7.log
#       header  -> UTC timestamp + git HEAD SHA of the worktree (and clone)
#       body    -> one STEP block per pipeline step (exit code + excerpt)
#       footer  -> SMOKE PASS or SMOKE FAIL
#
# Exit code:
#   0  on SMOKE PASS
#   1  on SMOKE FAIL
#
# Environment variables (optional):
#   SMOKE_LOG_PATH  — if set, the log is ALSO copied to this path after
#                     the SUMMARY block is written, so consumers (the
#                     S05 T02 commit step) can grab the artifact
#                     through the EXIT trap that normally wipes $tmp.
#                     Without this, the log lives only in
#                     /tmp/tmp.XXXXXXXX/smoke-0.0.7.log and is
#                     unrecoverable once the script exits 0.
#
# IMPORTANT: this file is named smoke-0.0.7.sh (NOT smoke-0.0.7.test.sh) so
# tests/run-all.sh's `find -name '*.test.*' ! -name '*.test.sh'` glob does
# NOT collect it. The driver is run standalone via `bash smoke-0.0.7.sh`,
# matching the convention of the three migration-bridge *.test.sh files
# (which also rely on standalone bash invocation).
set -euo pipefail

tmp="$(mktemp -d -t smoke-XXXXXXXX)"
trap 'rm -rf "$tmp"' EXIT

# WORKTREE: prefer the env var (CI use case); fall back to git rev-parse.
if [[ -z "${WORKTREE:-}" ]]; then
	WORKTREE="$(git rev-parse --show-toplevel)"
fi
HEAD_SHA="$(git -C "$WORKTREE" rev-parse HEAD)"
LOG="$tmp/smoke-0.0.7.log"
START_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Header. Subsequent STEP appends go to the same file.
{
	printf '# gsd-pi-hermes-memory smoke log (release 0.0.7)\n'
	printf '# start_utc:  %s\n' "$START_TS"
	printf '# worktree:   %s\n' "$WORKTREE"
	printf '# head_sha:   %s\n' "$HEAD_SHA"
	printf '\n'
} > "$LOG"

# The 10 pipeline steps. Step ordering rationale:
#   1. clone: fresh checkout (no network — uses local path).
#   2. npm-install-1: install npm deps.
#   3. link-pi-sdks-1: explicit first link. Needed because npm install does
#      NOT create the top-level node_modules/@gsd/* symlinks (the
#      @opengsd/gsd-pi postinstall only seeds its own nested
#      node_modules/@gsd/). Without this call, steps 4-5 would see an
#      empty node_modules/@gsd/ and the slice contract (7 "symbolic link
#      to ..." lines) would fail. The first invocation is expected to
#      print `linked 7/7 symlinks ...`.
#   4-5. symlink-check / readlink-check: verify the 7 symlinks via
#      file(1) and readlink(1).
#   6-7. check / test: `npm run check` and `npm test` both trigger
#      `precheck` / `pretest` which re-run link-pi-sdks.mjs. Because the
#      symlinks are already present, those inner invocations will print
#      `7/7 symlinks already ready ... skipping` — second + third
#      idempotency proofs (on top of explicit step 8 below).
#   8. link-pi-sdks-2: explicit second invocation — same idempotent
#      `already ready ... skipping` message.
#   9. npm-install-2: second `npm install` — proves no-op behaviour.
#   10. gsd-e: exercise the extension via the CLI. Tolerates non-zero
#       exits (gsd is a TUI and may exit non-zero on stdin closure),
#       but FAILS if the captured output shows an import traceback
#       of one of: Cannot find module / TypeError / SyntaxError /
#       ReferenceError.
declare -a STEPS=(
	clone
	npm-install-1
	link-pi-sdks-1
	symlink-check
	readlink-check
	check
	test
	link-pi-sdks-2
	npm-install-2
	gsd-e
)
total="${#STEPS[@]}"
passed=0
failed_step=""

# run_step <name> <cwd> <cmd...>  — captures stdout+stderr of the inner
# command, runs the per-step PASS rule, writes a STEP block to the log,
# and returns the per-step PASS exit (0 = pass, 1 = fail).
run_step() {
	local name="$1" cwd="$2"
	shift 2
	local out_file="$tmp/$name.out"
	local ec_file="$tmp/$name.ec"
	local ts raw_ec step_ec
	local cmd_str=""
	local arg
	for arg in "$@"; do
		cmd_str+=" ${arg}"
	done

	ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

	set +e
	( cd "$cwd" && "$@" ) > "$out_file" 2>&1
	raw_ec=$?
	set -e
	printf '%s\n' "$raw_ec" > "$ec_file"

	case "$name" in
		gsd-e)
			# Tolerate raw nonzero exit; FAIL only when the captured
			# output contains one of the canonical import-failure
			# tokens. The `if/else` keeps grep's own exit code from
			# tripping `set -e`.
			if grep -qE 'Cannot find module|TypeError|SyntaxError|ReferenceError' "$out_file"; then
				step_ec=1
			else
				step_ec=0
			fi
			;;
		*)
			step_ec="$raw_ec"
			;;
	esac

	{
		printf '[%s] STEP %s: exit=%s\n' "$ts" "$name" "$step_ec"
		# Persist the literal command line in the log for the CLI
		# step so a downstream grep on `gsd -e` finds it (the
		# captured stdout otherwise contains only `[gsd] Error: ...`
		# because the CLI rejects the unknown option *before* any
		# import is attempted).
		if [[ "$name" == "gsd-e" ]]; then
			printf '# command: cd %s &&%s\n' "$cwd" "$cmd_str"
		fi
		# Diagnostic checks (file(1) / readlink) print short,
		# deterministic output — capture it whole so the log is
		# self-contained evidence. Pipeline steps may emit long logs
		# (npm install, npm test). For those, keep first 10 + last 10
		# lines so both the early output (e.g. postinstall warnings)
		# AND the trailing summary (e.g. "All N test files passed",
		# npm "removed N packages" tally) survive.
		if [[ "$name" == "symlink-check" || "$name" == "readlink-check" ]]; then
			cat "$out_file"
		elif [[ "$name" == "gsd-e" ]]; then
			# gsd is a TUI; output is short and the import-failure
			# tokens usually sit near the head. Keep the full thing.
			cat "$out_file"
		else
			line_count="$(wc -l < "$out_file")"
			if [[ "$line_count" -le 30 ]]; then
				cat "$out_file"
			else
				head -n 10 "$out_file"
				printf '... [truncated %d lines] ...\n' "$((line_count - 20))"
				tail -n 10 "$out_file"
			fi
		fi
		printf '\n'
	} >> "$LOG"

	return "$step_ec"
}

# record <name> <cwd> <cmd...>  — thin wrapper that keeps the script
# running past the first failed step (so the operator sees the full
# pipeline state) but tracks the first failure for the SUMMARY footer.
record() {
	rc=0
	run_step "$@" || rc=$?
	if [[ "$rc" -eq 0 ]]; then
		passed=$((passed + 1))
	elif [[ -z "$failed_step" ]]; then
		failed_step="$1"
	fi
}

# Step 1: clone (cwd = $tmp so $tmp/clone is created at top level).
record clone "$tmp" git clone --depth=1 "$WORKTREE" "$tmp/clone"

# Capture the HEAD SHA inside the clone for the footer summary.
CLONE_SHA="$(git -C "$tmp/clone" rev-parse HEAD)" || CLONE_SHA="(unknown)"

# Steps 2-10: each runs inside $tmp/clone.
record npm-install-1 "$tmp/clone" npm install --no-audit --no-fund --loglevel=error
record link-pi-sdks-1 "$tmp/clone" node scripts/link-pi-sdks.mjs
record symlink-check "$tmp/clone" bash -c 'for s in node_modules/@gsd/*; do file "$s"; done'
record readlink-check "$tmp/clone" bash -c 'for s in node_modules/@gsd/*; do readlink "$s"; done'
record check "$tmp/clone" npm run check
record test "$tmp/clone" npm test
record link-pi-sdks-2 "$tmp/clone" node scripts/link-pi-sdks.mjs
record npm-install-2 "$tmp/clone" npm install --no-audit --no-fund --loglevel=error
record gsd-e "$tmp/clone" timeout 10 gsd -e ./src/index.ts </dev/null

END_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
{
	printf '[%s] SUMMARY clone_sha=%s total=%d passed=%d\n' \
		"$END_TS" "$CLONE_SHA" "$total" "$passed"
	if [[ -z "$failed_step" ]]; then
		printf 'SMOKE PASS: %d/%d steps passed\n' "$passed" "$total"
	else
		printf 'SMOKE FAIL: %s\n' "$failed_step"
	fi
} >> "$LOG"

# Optional: persist the log to a caller-supplied location so it survives
# the EXIT trap that wipes $tmp. Created to make the deliverable of
# S05 T02 (commit tests/integration/SMOKE-0.0.7.log) reproducible.
if [[ -n "${SMOKE_LOG_PATH:-}" ]]; then
	mkdir -p "$(dirname "$SMOKE_LOG_PATH")"
	cp "$LOG" "$SMOKE_LOG_PATH"
	printf '[%s] SMOKE_LOG_PATH=%s\n' "$END_TS" "$SMOKE_LOG_PATH" >> "$LOG"
fi

if [[ -z "$failed_step" ]]; then
	echo "SMOKE PASS: $passed/$total steps passed"
	echo "log: $LOG"
	exit 0
fi
echo "SMOKE FAIL: $failed_step"
echo "log: $LOG"
exit 1
