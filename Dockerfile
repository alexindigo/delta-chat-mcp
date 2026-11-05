# Linux amd64 manifests resolved from Docker Hub on 2026-11-05.
FROM --platform=linux/amd64 denoland/deno:debian-2.9.6@sha256:023603421f1a013d21a85de8a88a69160f7ca6184c168a4787e6a1b9df96b616 AS build
USER root
WORKDIR /work
ENV TMPDIR=/work/.test-state/release/tmp DENO_DIR=/work/.test-state/release/deno
RUN mkdir -p "$TMPDIR" "$DENO_DIR" && timeout 120 apt-get update && timeout 120 apt-get install -y --no-install-recommends binutils tar gzip ca-certificates && rm -rf /var/lib/apt/lists/*
COPY . .
RUN mkdir -p "$TMPDIR" "$DENO_DIR" && timeout 1200 deno run -A scripts/release/build.ts --output /out

FROM --platform=linux/amd64 debian:13-slim@sha256:7378260c0a098d27ac206225db5e7d92b8c7c84ea7afccc86eeb513756bbd392
ENV DCMCP_DATA_DIR=/data/state TMPDIR=/data/tmp XDG_DATA_HOME=/data/cache HOME=/data/home
RUN mkdir -p /app /data/state /data/tmp /data/cache /data/home \
    && timeout 120 apt-get update && timeout 120 apt-get install -y --no-install-recommends libc6 libgcc-s1 ca-certificates && rm -rf /var/lib/apt/lists/* \
    && chown -R 1000:1000 /data && chmod 0700 /data /data/state /data/tmp /data/cache /data/home
COPY --from=build /out/bin/delta-chat-mcp /app/delta-chat-mcp
COPY --from=build /out/source/licenses /app/licenses
COPY --from=build /work/LICENSE /work/THIRD-PARTY-NOTICES.md /out/PROVENANCE.json /out/ABI.txt /app/
RUN chmod -R a-w /app && chmod a+rx /app/delta-chat-mcp
LABEL org.opencontainers.image.source="https://github.com/alexindigo/delta-chat-mcp" \
      org.opencontainers.image.licenses="LGPL-3.0-only"
WORKDIR /data
USER 1000:1000
VOLUME ["/data"]
EXPOSE 8080
STOPSIGNAL SIGTERM
ENTRYPOINT ["/app/delta-chat-mcp"]
