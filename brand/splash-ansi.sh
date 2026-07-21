#!/usr/bin/env bash
# lq — terminal splash with ANSI colors matching the brand palette.
# Colors: red #c2410c → 208, yellow #e5a418 → 214, blue #1f6feb → 33
#         cream #f7f4ec → 230, muted → 246

R=$'\e[38;5;208m'   # brick red
Y=$'\e[38;5;214m'   # mustard yellow
B=$'\e[38;5;33m'    # blue
W=$'\e[38;5;230m'   # cream
M=$'\e[38;5;246m'   # muted / comment
X=$'\e[0m'          # reset

cat <<EOF

  ${R}❭${X}${Y}❭${X} ${W}lq${X}${B}▉${X}

  ${M}// a companion for LyX
  // parse · query · mutate${X}

EOF
