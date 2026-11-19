# Movera route server: OSRM with the map data baked into the image (car profile, MLD).
# Build:  ./build.sh            (whole Sweden)      or      BBOX=17.2,58.7,19.6,60.3 ./build.sh   (one city region)
# Three stages: 1 fetch the map (and cut a box out of it if asked), 2 prepare it for OSRM, 3 the small runtime image.
#
# OSRM_IMAGE: v5.25.0 from Docker Hub is the image proven on 2026-11-19 (see PROOF.md). The project now publishes at
# ghcr.io/project-osrm/osrm-backend (newest tag seen 2026-11-19: v26.11.0-debian). Same /route/v1 API. Try the new tag
# with --build-arg OSRM_IMAGE=... and run test/compare-routes.mjs before using it.
ARG OSRM_IMAGE=osrm/osrm-backend:v5.25.0

# ---------- 1. fetch ----------
FROM debian:bookworm-slim AS fetch
# Free OpenStreetMap extract of Sweden from Geofabrik (about 0.8 GB, rebuilt daily).
ARG PBF_URL=https://download.geofabrik.de/europe/sweden-latest.osm.pbf
# Optional box "west,south,east,north" (lng,lat,lng,lat). Empty = the whole file.
ARG BBOX=
# Change this value (e.g. 2026-12-01) to force a fresh map download; otherwise Docker reuses the cached layer.
ARG MAP_DATE=unset
# A file put at data/region.osm.pbf is used instead of downloading (offline builds, tests).
COPY data/ /in/
RUN set -eux; mkdir -p /out; \
    if [ -f /in/region.osm.pbf ]; then \
      cp /in/region.osm.pbf /out/full.osm.pbf; \
    else \
      apt-get update; apt-get install -y --no-install-recommends ca-certificates curl; \
      curl -fL --retry 5 --retry-delay 15 -o /out/full.osm.pbf "$PBF_URL"; \
    fi; \
    if [ -n "$BBOX" ]; then \
      apt-get update; apt-get install -y --no-install-recommends osmium-tool; \
      osmium extract --bbox "$BBOX" --strategy smart -o /out/region.osm.pbf /out/full.osm.pbf; \
      rm /out/full.osm.pbf; \
    else \
      mv /out/full.osm.pbf /out/region.osm.pbf; \
    fi; \
    printf 'map_date=%s\nsource=%s\nbbox=%s\nbuilt=%s\n' "$MAP_DATE" "$PBF_URL" "${BBOX:-whole file}" "$(date -u +%FT%TZ)" > /out/MAP_INFO; \
    ls -l /out

# ---------- 2. prepare (needs the most memory: about 7 x the map file size) ----------
FROM ${OSRM_IMAGE} AS prepare
COPY --from=fetch /out/ /data/
COPY build-data.sh /usr/local/bin/build-data.sh
RUN chmod +x /usr/local/bin/build-data.sh && build-data.sh /data/region.osm.pbf

# ---------- 3. runtime ----------
FROM ${OSRM_IMAGE}
COPY --from=prepare /data/ /data/
COPY start.sh healthcheck.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/start.sh /usr/local/bin/healthcheck.sh
ENV PORT=5000
EXPOSE 5000
# Docker-level check (docker run / compose). Render checks a private service by its open port instead; osrm-routed
# opens the port only after the map is loaded, so "port open" already means "ready".
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s CMD ["healthcheck.sh"]
CMD ["start.sh"]
