#!/bin/sh
# Starts the Markdownify MCP HTTP front (Bun). tini (PID 1) passes on its exit code,
# so any crash exits non-zero and Railway's ON_FAILURE restart policy brings it back.
set -eu

: "${PORT:=8080}"
: "${MD_DATA_DIR:=/data}"
export PORT MD_DATA_DIR

if [ -z "${MCP_AUTH_TOKEN:-}" ] || [ "${#MCP_AUTH_TOKEN}" -lt 24 ]; then
  echo "MCP_AUTH_TOKEN must be set (at least 24 characters); the template generates one." >&2
  exit 1
fi

mkdir -p "$MD_DATA_DIR/uploads"
touch "$MD_DATA_DIR/.write-test" && rm "$MD_DATA_DIR/.write-test" || {
  echo "$MD_DATA_DIR is not writable: attach a volume at $MD_DATA_DIR." >&2
  exit 1
}

# Size limits from the container's memory limit (Railway Free/Trial: 0.5 GB).
limit=""
if [ -r /sys/fs/cgroup/memory.max ]; then
  limit=$(cat /sys/fs/cgroup/memory.max)
elif [ -r /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then
  limit=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes)
fi
case "$limit" in ''|max|*[!0-9]*) limit=0 ;; esac
mb=$((limit / 1048576))
if [ "$mb" -le 0 ] || [ "$mb" -gt 65536 ]; then mb=8192; fi
if [ "$mb" -lt 900 ]; then
  : "${MD_MAX_UPLOAD_BYTES:=26214400}"     # 25 MB
  : "${MD_MAX_DOWNLOAD_BYTES:=26214400}"   # 25 MB
  : "${MD_MAX_OUTPUT_BYTES:=20971520}"     # 20 MB of Markdown
else
  : "${MD_MAX_UPLOAD_BYTES:=104857600}"    # 100 MB
  : "${MD_MAX_DOWNLOAD_BYTES:=104857600}"
  : "${MD_MAX_OUTPUT_BYTES:=52428800}"
fi
: "${MD_MAX_CONCURRENT:=1}"
: "${MD_THREADS:=1}"
export MD_MAX_UPLOAD_BYTES MD_MAX_DOWNLOAD_BYTES MD_MAX_OUTPUT_BYTES MD_MAX_CONCURRENT MD_THREADS
echo "memory limit ${mb} MB: uploads/downloads up to $((MD_MAX_UPLOAD_BYTES / 1048576)) MB, ${MD_MAX_CONCURRENT} conversion(s) at a time, ${MD_THREADS} thread(s)"

cd /app
exec bun run /app/http-server.ts
