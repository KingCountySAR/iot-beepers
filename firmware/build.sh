#!/usr/bin/env bash
# Build one board's firmware in Docker and merge it into a single image for the server's
# Firmware page, which uses it for both OTA updates and the browser flasher.
#
#   ./build.sh [xiao-c3|xiao-c3-proto|devkit-v1]     (default xiao-c3)
#
# Output: dist/sar-beepers-<board>-<version>.bin
set -euo pipefail
cd "$(dirname "$0")"

board=${1:-xiao-c3}
case "$board" in
  xiao-c3)   target=esp32c3 dir=build        defaults="sdkconfig.defaults" ;;
  xiao-c3-proto) target=esp32c3 dir=build-xiao-proto defaults="sdkconfig.defaults;sdkconfig.defaults.xiao-proto" ;;
  devkit-v1) target=esp32   dir=build-devkit defaults="sdkconfig.defaults;sdkconfig.defaults.devkit" ;;
  *) echo "unknown board: $board (xiao-c3, xiao-c3-proto or devkit-v1)" >&2; exit 1 ;;
esac
version=$(tr -d '[:space:]' < version.txt)
out="dist/sar-beepers-$board-$version.bin"
mkdir -p dist

# Git Bash would otherwise rewrite the container paths below into Windows paths.
export MSYS_NO_PATHCONV=1
docker run --rm -v "$PWD:/project" -w /project espressif/idf:v5.5.1 sh -c "
  set -e
  idf.py -B $dir -DIDF_TARGET=$target -DSDKCONFIG=$dir/sdkconfig '-DSDKCONFIG_DEFAULTS=$defaults' build
  cd $dir && esptool.py --chip $target merge_bin -o ../$out @flash_args
"
echo "Built $out"
