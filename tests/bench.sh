#!/usr/bin/env bash
# lq bench — Performance benchmark suite for all lq CLI commands
# Usage: RUNS=5 WARMUP=2 ./bench.sh
# Output: table with avg/min/max timings (ms) per test case

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNS=${RUNS:-5}
WARMUP=${WARMUP:-1}
LQ="deno run -A --no-check $SCRIPT_DIR/../main.ts"
TMPDIR="${TMPDIR:-/tmp/lq_bench}"
RESULTS_FILE="$TMPDIR/results.tsv"

# Fixtures (relative to this script's location)
SMALL="$SCRIPT_DIR/fixtures/my_template.lyx"
MEDIUM="$SCRIPT_DIR/fixtures/Articles/Springer_Nature_Journals.lyx"
LARGE="$SCRIPT_DIR/fixtures/Modules/Fancy_Colored_Boxes.lyx"
BIB_FIXTURE="$SCRIPT_DIR/fixtures/Books/KOMA-Script_Book.lyx"

# Raw LyX snippet for --raw insert tests
RAW_SNIPPET='\\begin_layout Standard\nbenchmark\n\\end_layout\n'

say() { printf "%s\n" "$*" >&2; }
die() { say "ERROR: $*"; exit 1; }

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------
mkdir -p "$TMPDIR"
: > "$RESULTS_FILE"

# ---------------------------------------------------------------------------
# Timing helper — runs a command, returns elapsed wall-clock in milliseconds
# ---------------------------------------------------------------------------
timer() {
  local start end
  start=$(date +%s%3N 2>/dev/null || python3 -c 'import time;print(int(time.time()*1000))' 2>/dev/null)
  "$@" > /dev/null 2>&1
  end=$(date +%s%3N 2>/dev/null || python3 -c 'import time;print(int(time.time()*1000))' 2>/dev/null)
  echo $(( end - start ))
}

# ---------------------------------------------------------------------------
# Calculate statistics from a list of numbers (one per line)
# ---------------------------------------------------------------------------
stats() {
  python3 -c "
import sys, statistics
vals = [int(x) for x in sys.stdin.read().strip().split() if x]
if not vals: sys.exit(1)
print(f'{statistics.mean(vals):.0f}\t{min(vals)}\t{max(vals)}')
"
}

# ---------------------------------------------------------------------------
# Run a single test case N times and report
# Args: label  command_args...
# The label should be: "Command | Fixture | Detail"
# ---------------------------------------------------------------------------
bench() {
  local label="$1"
  shift
  local times=""

  say "  [$RUNS×] $label"

  # Warmup
  for ((i = 0; i < WARMUP; i++)); do
    "$@" > /dev/null 2>&1 || true
  done

  # Measured runs
  for ((i = 0; i < RUNS; i++)); do
    local t
    t=$(timer "$@")
    times="$times$t "
  done

  local stats_line
  stats_line=$(echo "$times" | stats)
  printf '%s\t%s\t%s\t%s\n' "$label" $stats_line >> "$RESULTS_FILE"
}

# ---------------------------------------------------------------------------
# Mutation test helper — copies fixture to temp, runs command, checks, cleans up
# Usage: bench_mutate label fixture cmd arg1 arg2 ...
# The temp file path is auto-inserted as the first arg after the command.
# ---------------------------------------------------------------------------
bench_mutate() {
  local label="$1"
  local fixture="$2"
  shift 2
  local tmp="$TMPDIR/$(basename "$fixture")"
  local times=""

  say "  [$RUNS×] $label"

  # Warmup
  for ((i = 0; i < WARMUP; i++)); do
    cp "$fixture" "$tmp"
    "$@" "$tmp" > /dev/null 2>&1 || true
    rm -f "$tmp"
  done

  # Measured runs
  for ((i = 0; i < RUNS; i++)); do
    cp "$fixture" "$tmp"
    local t
    t=$(timer "$@" "$tmp")
    $LQ read "$tmp" "layout" > /dev/null 2>&1 || die "mutation left file unreadable: $label"
    rm -f "$tmp"
    times="$times$t "
  done

  local stats_line
  stats_line=$(echo "$times" | stats)
  printf '%s\t%s\t%s\t%s\n' "$label" $stats_line >> "$RESULTS_FILE"
}

# ===========================================================================
say "=== lq bench — $(date) ==="
say "Runs: $RUNS | Warmup: $WARMUP | Deno: $(deno --version | head -1)"
say ""

# --- READ ------------------------------------------------------------------
say "--- read ---"

bench "read | small  | layout            | $SMALL" \
  $LQ read "$SMALL" "layout"

bench "read | medium | layout[Standard]  | $MEDIUM" \
  $LQ read "$MEDIUM" "layout[Standard]"

bench "read | large  | layout            | $LARGE" \
  $LQ read "$LARGE" "layout"

bench "read | large  | :contains(a)      | $LARGE" \
  $LQ read "$LARGE" ':contains(a)'

bench "read | small  | :contains(the)    | $SMALL" \
  $LQ read "$SMALL" ':contains(the)'

bench "read | medium | :first            | $MEDIUM" \
  $LQ read "$MEDIUM" 'layout:first'

# --- DUMP ------------------------------------------------------------------
say "--- dump ---"

bench "dump | small  | full CST          | $SMALL" \
  $LQ dump "$SMALL"

bench "dump | medium | full CST          | $MEDIUM" \
  $LQ dump "$MEDIUM"

bench "dump | large  | full CST          | $LARGE" \
  $LQ dump "$LARGE"

# --- SET -------------------------------------------------------------------
say "--- set ---"

bench_mutate "set  | small  | property text     | $SMALL" "$SMALL" \
  $LQ set "property[author]" "Benchmark Author"

bench_mutate "set  | medium | property text     | $MEDIUM" "$MEDIUM" \
  $LQ set "property[author]" "Benchmark Author"

# --- DELETE ----------------------------------------------------------------
say "--- delete ---"

bench_mutate "delete | small | layout textnode | $SMALL" "$SMALL" \
  $LQ delete "layout > text:first"

# --- INSERT ----------------------------------------------------------------
say "--- insert ---"

bench_mutate "insert | small | --raw 11 nodes   | $SMALL" "$SMALL" \
  $LQ insert "layout[Standard]" after --raw "$RAW_SNIPPET"

bench_mutate "insert | medium| --raw 45 nodes   | $MEDIUM" "$MEDIUM" \
  $LQ insert "layout[Standard]" after --raw "$RAW_SNIPPET"

bench_mutate "insert | small | --layout 1 node  | $SMALL" "$SMALL" \
  $LQ insert "layout[Standard]:first" after --layout Standard --text "bench"

# --- SCHEMA ----------------------------------------------------------------
say "--- schema ---"

bench "schema | small  | article class    | $SMALL" \
  $LQ schema "$SMALL"

bench "schema | large  | custom module    | $LARGE" \
  $LQ schema "$LARGE"

# --- BIB -------------------------------------------------------------------
say "--- bib ---"

bench "bib   | book   | extract keys     | $BIB_FIXTURE" \
  $LQ bib "$BIB_FIXTURE"

# ===========================================================================
# Report
# ===========================================================================
say ""
say "========================================"
say "              RESULTS (ms)"
say "========================================"
say ""
printf "%-45s %8s %8s %8s\n" "Test" "Avg" "Min" "Max"
printf "%-45s %8s %8s %8s\n" "----" "---" "---" "---"
sort "$RESULTS_FILE" | while IFS=$'\t' read -r label avg min max; do
  [ -n "$label" ] || continue
  printf "%-45s %8s %8s %8s\n" "$label" "${avg:-N/A}" "${min:-N/A}" "${max:-N/A}"
done
say ""
say "Done."
