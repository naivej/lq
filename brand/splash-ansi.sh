#!/usr/bin/env bash
# lq — terminal splash with ANSI colors matching the brand palette.
# Colors: red #c2410c, yellow #ffff00, blue #1f6feb, wordmark #f7f4ec.
# Truecolor keeps the splash aligned with the light brand icon across terminal themes.
# Keep in sync with the SPLASH constant in src/help_render.ts.

R=$'\e[38;2;194;65;12m'     # red-orange — caret
Y=$'\e[38;2;255;255;0m'     # pure yellow — caret
B=$'\e[38;2;31;111;235m'    # blue            — cursor
W=$'\e[38;2;247;244;236m'   # light           — wordmark
M=$'\e[38;5;246m'    # muted                — tagline
X=$'\e[0m'           # reset

cat <<EOF

  ${R}❯${X}${Y}❯${X} ${W}lq${X}${B} ▉${X}

EOF
