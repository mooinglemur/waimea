# Downloads and verifies the pinned inputs listed in deploy/inputs.json.
FROM docker.io/library/node:26-trixie-slim AS inputs
RUN apt-get update \
 && apt-get install -y --no-install-recommends bzip2 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY deploy/inputs.json deploy/fetch-inputs.mjs /build/deploy/
RUN node /build/deploy/fetch-inputs.mjs /vendor

# Builds the core bundle under Pyodide, from the vendored inputs and Waimea's runtime modules.
FROM docker.io/library/node:26-trixie-slim AS core
COPY --from=inputs /vendor /vendor
COPY build/build-core.mjs build/build_core.py /build/build/
COPY runtime /build/runtime
RUN node /build/build/build-core.mjs /vendor /out

# The server needs only the Pyodide runtime and the bundle: Archipelago's sources, the fuzzer and the
# wheels are all inside core.zip.
FROM docker.io/library/node:26-trixie-slim
COPY --from=inputs /vendor/pyodide /app/vendor/pyodide
COPY --from=inputs /vendor/inputs.json /app/vendor/inputs.json
COPY --from=core /out/core.zip /out/core.json /app/build/out/
COPY server /app/server
COPY web /app/web
COPY deploy/calibration.json /app/deploy/calibration.json
ENV WAIMEA_PORT=8080
USER node
EXPOSE 8080
CMD ["node", "/app/server/main.mjs"]
