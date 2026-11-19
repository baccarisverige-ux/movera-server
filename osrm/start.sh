#!/bin/bash
# Starts the route server. Listens on every interface of the PRIVATE network only (never publish this port).
set -euo pipefail
cat /data/MAP_INFO 2>/dev/null || true
exec osrm-routed --algorithm mld --ip 0.0.0.0 --port "${PORT:-5000}" --max-viaroute-size 100 /data/region.osrm
