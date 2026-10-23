#!/usr/bin/env bash
# Export the case parts as STL (out/) and refresh the preview images (renders/), using
# OpenSCAD in Docker.
set -euo pipefail
cd "$(dirname "$0")"

IMAGE=sar-openscad-render
docker build -q -t "$IMAGE" . >/dev/null
mkdir -p out renders
# Clear old output so a failed render shows up as a missing file, not a stale one.
rm -f out/* renders/*.png

# Git Bash would otherwise rewrite the container paths into Windows paths.
MSYS_NO_PATHCONV=1 docker run --rm -v "$PWD:/w" -w /w "$IMAGE" sh -ec '
  for p in base lid button led_spacer; do
    openscad --backend=manifold -D "part=\"$p\"" -o out/$p.stl sar-pager-case.scad
  done
  render() { xvfb-run -a openscad --colorscheme=Tomorrow "$@" sar-pager-case.scad; }
  render --imgsize=1400,1000 --camera=28,18,6,55,0,25,140 -D "part=\"assembly\"" -o renders/assembly.png
  render --imgsize=1400,1000 --camera=28,18,6,62,0,330,140 -D "part=\"assembly\"" -o renders/assembly-side.png
  render --imgsize=1600,900 --viewall --autocenter --camera=0,0,0,50,0,30,0 -D "part=\"all\"" -o renders/print-plate.png
' 2>&1 | grep -E "WARNING|ERROR" || true
ls out/*.stl
