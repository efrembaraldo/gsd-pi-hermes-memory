#!/usr/bin/env bash
# Run each test file in its own process to avoid node:test runner hang.
#
# Supports two extensions:
#   - `*.test.ts` is run via `npx tsx --test` (TypeScript source for
#     extension behaviour tests; needs the project's TS toolchain).
#   - `*.test.mjs` is run via `node --test` directly (plain ESM test,
#     typically build-tool probes like `link-pi-sdks.test.mjs` that must
#     work even when the TS toolchain is broken).
#
# Adding a new extension? Add a `case` arm below — don't re-invent the
# `run_test_file` shell.
set -euo pipefail
PASS=0

TEST_TIMEOUT="${TEST_TIMEOUT:-120}"
if [[ ! "$TEST_TIMEOUT" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  echo "Invalid TEST_TIMEOUT: $TEST_TIMEOUT (expected a non-negative number of seconds)" >&2
  exit 2
fi

TIMEOUT_BIN=()
if [[ ! "$TEST_TIMEOUT" =~ ^0+([.]0+)?$ ]]; then
  if command -v timeout >/dev/null 2>&1; then
    TIMEOUT_BIN=(timeout)
  elif command -v gtimeout >/dev/null 2>&1; then
    TIMEOUT_BIN=(gtimeout)
  fi
fi

run_test_file() {
  local file="$1"
  local ext="${file##*.}"

  # Pick the runner based on extension. Plain `.mjs`/`.js`/`.cjs` use the
  # stock `node --test` runner; `.ts` uses tsx so the project's TypeScript
  # source compiles in-process.
  local runner=()
  case "$ext" in
    mjs|js|cjs) runner=(node --test) ;;
    ts)         runner=(npx tsx --test) ;;
    *)          echo "Unsupported test extension: $file" >&2; return 2 ;;
  esac

  if ((${#TIMEOUT_BIN[@]} > 0)); then
    "${TIMEOUT_BIN[@]}" --kill-after=5s "$TEST_TIMEOUT" "${runner[@]}" "$file"
  else
    "${runner[@]}" "$file"
  fi
}

# Collect every `*.test.<ext>` file under tests/, excluding `*.test.sh`
# which are integration tests run standalone via `bash <file>.test.sh`
# (they orchestrate `node --import tsx/esm` themselves and the runner
# here only supports `mjs|js|cjs|ts` extensions). Sorting keeps the
# order deterministic so CI output is reproducible across runs.
for f in $(find tests -name '*.test.*' ! -name '*.test.sh' | sort); do
  echo "--- $f ---"
  if run_test_file "$f"; then
    PASS=$((PASS + 1))
  else
    rc=$?
    if [[ "$rc" -eq 124 && ${#TIMEOUT_BIN[@]} -gt 0 ]]; then
      echo "TIMEOUT (>${TEST_TIMEOUT}s): $f"
    else
      echo "FAILED (exit $rc): $f"
    fi
    exit 1
  fi
done

echo "All $PASS test files passed"
