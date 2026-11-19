#!/bin/bash
# Builds the image on any machine with Docker.
#   ./build.sh                                  whole Sweden (needs ~8 GB memory and ~10 GB free disk while building)
#   BBOX=17.2,58.7,19.6,60.3 ./build.sh         only a box (example: Stockholm county and around)
#   PBF_URL=https://.../other.osm.pbf ./build.sh
#   OSRM_IMAGE=ghcr.io/project-osrm/osrm-backend:v26.11.0-debian ./build.sh
# A file at data/region.osm.pbf is used instead of downloading.
set -euo pipefail
cd "$(dirname "$0")"
TAG="${TAG:-movera-osrm:local}"
ARGS=(--build-arg "MAP_DATE=${MAP_DATE:-$(date -u +%F)}")
[ -n "${PBF_URL:-}" ] && ARGS+=(--build-arg "PBF_URL=$PBF_URL")
[ -n "${BBOX:-}" ] && ARGS+=(--build-arg "BBOX=$BBOX")
[ -n "${OSRM_IMAGE:-}" ] && ARGS+=(--build-arg "OSRM_IMAGE=$OSRM_IMAGE")
docker build "${ARGS[@]}" ${DOCKER_BUILD_EXTRA:-} -t "$TAG" .
echo
echo "Built $TAG. Try it:"
echo "  docker run --rm -p 127.0.0.1:5000:5000 $TAG"
echo "  curl 'http://127.0.0.1:5000/route/v1/driving/18.0686,59.3293;17.9186,59.6519?overview=false'"
