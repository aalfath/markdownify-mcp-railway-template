# Markdownify MCP for Railway: upstream zcaceres/markdownify-mcp v1.1.0 (stdio server),
# exposed as a remote streamable-HTTP MCP server behind a generated bearer token.
# Upstream publishes no versioned image, so we build its pinned release commit on the
# official Bun image, pinned by version and digest.
FROM oven/bun:1.4.5-debian@sha256:3dddea58e1f8f2240eca906b023fedb944f9a8352515a35309fd0c879fe00aaa

# Upstream release v1.1.0 = commit 024f97cea9a94cd842c445eea4503c442c79bd71
ARG MARKDOWNIFY_VERSION=1.1.0
ARG MARKDOWNIFY_COMMIT=024f97cea9a94cd842c445eea4503c442c79bd71

# python3 for markitdown, git for git-repo-to-markdown (repomix), ffmpeg for audio
# transcription of mp3/m4a, exiftool for image metadata.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git python3 python3-venv ffmpeg libimage-exiftool-perl tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN curl -fsSL "https://codeload.github.com/zcaceres/markdownify-mcp/tar.gz/${MARKDOWNIFY_COMMIT}" \
      | tar xz --strip-components=1 \
 && rm -f .python-version \
 && grep -q "\"version\": \"${MARKDOWNIFY_VERSION}\"" package.json

# markitdown 0.1.9 with the offline converters (no Azure extras), every Python
# package pinned in requirements.txt.
COPY requirements.txt /tmp/requirements.txt
RUN python3 -m venv .venv \
 && .venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt \
 && .venv/bin/markitdown --version

# Build upstream (bun install skips its preinstall venv step with --ignore-scripts:
# the venv above replaces it), then keep production dependencies only.
RUN bun install --frozen-lockfile --ignore-scripts \
 && bun run build \
 && rm -rf node_modules \
 && bun install --frozen-lockfile --ignore-scripts --production \
 && rm -rf /root/.bun/install/cache

# Let deployers cap the output size from the container's memory (see start.sh).
RUN sed -i 's/maxBuffer: 50 \* 1024 \* 1024/maxBuffer: Number(process.env.MD_MAX_OUTPUT_BYTES || 50 * 1024 * 1024)/' dist/Markdownify.js \
 && sed -i 's/maxBuffer: 100 \* 1024 \* 1024/maxBuffer: Number(process.env.MD_MAX_OUTPUT_BYTES || 100 * 1024 * 1024)/' dist/Markdownify.js \
 && test "$(grep -c MD_MAX_OUTPUT_BYTES dist/Markdownify.js)" = 2

COPY http-server.ts /app/http-server.ts
COPY bin/ /app/bin/
COPY start.sh /usr/local/bin/start.sh
COPY gitconfig /etc/gitconfig
RUN chmod 755 /usr/local/bin/start.sh /app/bin/*

ENV PORT=8080 \
    MD_DATA_DIR=/data \
    MD_ALLOWED_PATHS=/data \
    MARKITDOWN_PATH=/app/bin/markitdown \
    REPOMIX_PATH=/app/bin/repomix \
    PYTHONUTF8=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    OMP_NUM_THREADS=1 \
    OPENBLAS_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    NUMEXPR_NUM_THREADS=1 \
    MARKDOWNIFY_VERSION=${MARKDOWNIFY_VERSION}
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/start.sh"]
