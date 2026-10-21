cmake_minimum_required(VERSION 3.16)

# The app version comes from version.txt (bump it for every build you upload for OTA).
include($ENV{IDF_PATH}/tools/cmake/project.cmake)

# Must match FIRMWARE_PROJECT in server/src/firmware.ts; the server rejects images for other projects.
project(sar-notifier)
