#!/usr/bin/env bash
# lq — terminal splash with ANSI colors matching the brand palette.
# Colors: red #c2410c → 202 (bold), yellow #e5a418 → 220 (bold), blue #1f6feb → 33
#         cream #f7f4ec → 230, muted → 246
# Keep in sync with the SPLASH constant in src/help_render.ts.

R=$'\e[1;38;5;202m'  # bold vivid red-orange — caret
Y=$'\e[1;38;5;220m'  # bold bright yellow   — caret
B=$'\e[38;5;33m'     # blue                 — cursor
W=$'\e[38;5;230m'    # cream                — wordmark
M=$'\e[38;5;246m'    # muted                — tagline
X=$'\e[0m'           # reset

cat <<EOF

  ${R}❯${X}${Y}❯${X} ${W}lq${X}${B} ▉${X}

EOF
