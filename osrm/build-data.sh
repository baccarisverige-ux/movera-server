#!/bin/bash
# Runs inside the OSRM image at build time: map file -> OSRM files (car profile, MLD).
set -euo pipefail
PBF="${1:?usage: build-data.sh /data/region.osm.pbf}"
BASE="${PBF%.osm.pbf}"
# car.lua sits in /opt in the old images and may sit elsewhere in new ones.
PROFILE="$(find /opt /usr/local/share /usr/share -name car.lua 2>/dev/null | head -n 1)"
[ -n "$PROFILE" ] || { echo "car.lua not found in this OSRM image" >&2; exit 1; }
echo "profile: $PROFILE   map: $(ls -l "$PBF")"
osrm-extract -p "$PROFILE" "$PBF"
osrm-partition "$BASE.osrm"
osrm-customize "$BASE.osrm"
rm -f "$PBF"                       # the raw map is not needed at run time
du -sh "$(dirname "$PBF")"
