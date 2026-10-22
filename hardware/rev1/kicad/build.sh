#!/usr/bin/env bash
# Regenerate the rev 1 board draft from generate.py, autoroute it, check it and export
# fabrication files. Needs KiCad 10 and Docker (Freerouting runs in a Java container).
#
#   ./build.sh            generate + route + DRC + renders + fab files
#   ./build.sh fab        only DRC, renders and fab files for the board as it is now
#                         (use this once you've edited the board in KiCad)
#
# Output: fab/ (Gerbers + drill zip, JLCPCB BOM and CPL) and renders/ (PNG previews).
set -euo pipefail
cd "$(dirname "$0")"

KICAD=${KICAD:-"/c/Program Files/KiCad/10.0"}
PY="$KICAD/bin/python.exe"
CLI="$KICAD/bin/kicad-cli.exe"
FREEROUTING_VERSION=2.4.1
JAR=.tools/freerouting-$FREEROUTING_VERSION.jar
PCB=sar-pager.kicad_pcb

if [ "${1:-}" != fab ]; then
  "$PY" generate.py "$PCB"

  mkdir -p .tools
  [ -f "$JAR" ] || curl -sSL -o "$JAR" \
    "https://github.com/freerouting/freerouting/releases/download/v$FREEROUTING_VERSION/freerouting-$FREEROUTING_VERSION.jar"
  # Git Bash would otherwise rewrite the container paths into Windows paths.
  MSYS_NO_PATHCONV=1 docker run --rm -v "$PWD:/w" -w /w eclipse-temurin:25-jre \
    java -jar "$JAR" -de sar-pager.dsn -do sar-pager.ses -mp 40 --gui.enabled=false
  "$PY" finish.py "$PCB" sar-pager.ses
  rm -f sar-pager.dsn sar-pager.ses
fi

mkdir -p fab renders
"$CLI" pcb drc --severity-error --exit-code-violations -o fab/drc.rpt "$PCB" || {
  echo "DRC errors; see fab/drc.rpt" >&2
  exit 1
}

for side in top bottom; do
  "$CLI" pcb render --side "$side" --width 1600 --height 1000 --zoom 1 --quality high \
    -o "renders/$side.png" "$PCB" >/dev/null
done
"$CLI" pcb render --side top --rotate "-45,0,45" --perspective --width 1600 --height 1000 --zoom 0.9 \
  --quality high -o renders/angle.png "$PCB" >/dev/null

rm -rf fab/gerbers && mkdir -p fab/gerbers
"$CLI" pcb export gerbers --no-protel-ext \
  --layers F.Cu,B.Cu,F.Mask,B.Mask,F.Paste,F.Silkscreen,B.Silkscreen,Edge.Cuts -o fab/gerbers/ "$PCB" >/dev/null
"$CLI" pcb export drill --format excellon --excellon-separate-th -o fab/gerbers/ "$PCB" >/dev/null
"$PY" -c "import shutil; shutil.make_archive('fab/sar-pager-gerbers', 'zip', 'fab/gerbers')"
"$PY" jlcpcb.py "$PCB" fab
echo "Done: fab/ and renders/"
