# OpenSCAD plus a virtual display, so it can render PNG previews headless (build.sh).
FROM openscad/openscad:trixie.2026-10-05
RUN apt-get update && apt-get install -y --no-install-recommends xvfb xauth libgl1-mesa-dri \
    && rm -rf /var/lib/apt/lists/*
