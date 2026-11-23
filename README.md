[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/markdownify-mcp?utm_medium=integration&utm_source=button&utm_campaign=markdownify-mcp)

# Markdownify MCP on Railway

<img src="assets/icon.png" alt="Markdownify MCP" width="160" align="right">

One-click Railway template for [Markdownify MCP](https://github.com/zcaceres/markdownify-mcp) **1.1.0** (upstream commit `024f97c`, MIT), run as a **remote MCP server** over streamable HTTP and locked with a generated bearer token.

Upstream ships only a stdio server and publishes no Docker image. This repo builds upstream's pinned release on the official Bun image (`oven/bun:1.4.5-debian@sha256:3dddea58…`) with [MarkItDown](https://github.com/microsoft/markitdown) 0.1.9 (every Python package pinned in `requirements.txt`), and adds `http-server.ts`, a small front that:

- serves upstream's unchanged MCP server (11 tools) at `POST /mcp`, stateless, JSON responses;
- requires `Authorization: Bearer $MCP_AUTH_TOKEN` on everything except `GET /healthz`;
- adds an upload API (`PUT /files/<name>`, `POST /files` multipart, `GET /files`, `DELETE /files/<name>`) on the `/data` volume, so the file tools work remotely (they read server-side paths, restricted to `/data`);
- refuses web fetches to private, link-local and `*.railway.internal` addresses and caps download size;
- runs one conversion at a time and caps onnxruntime and repomix threads, so it fits Railway's 0.5 GB plan.

## What the template deploys

| Service | Source | Volume | Public |
|---|---|---|---|
| `Markdownify MCP` | this repo (`Dockerfile`) | `/data` (uploads) | yes, health check `/healthz` |

No database and no LLM key: conversions run locally with MarkItDown.

## Variables

| Variable | Default | Notes |
|---|---|---|
| `MCP_AUTH_TOKEN` | `${{secret(48)}}` | Bearer token for every request. Copy it from the service's Variables tab. |
| `PORT` | `8080` | Port the server listens on. |
| `MD_ALLOWED_PATHS` | `/data` (baked in) | Folders the file tools may read. |
| `MD_MAX_UPLOAD_BYTES`, `MD_MAX_DOWNLOAD_BYTES`, `MD_MAX_OUTPUT_BYTES` | from the memory limit | 25/25/20 MB under 900 MB RAM, else 100/100/50 MB. |
| `MD_MAX_CONCURRENT`, `MD_THREADS` | `1`, `1` | Raise them on bigger plans. |

## Connect a client

```sh
claude mcp add --transport http markdownify https://YOUR-DOMAIN/mcp --header "Authorization: Bearer YOUR-TOKEN"
```

```json
{ "mcpServers": { "markdownify": { "type": "http", "url": "https://YOUR-DOMAIN/mcp", "headers": { "Authorization": "Bearer YOUR-TOKEN" } } } }
```

Upload a file, then pass the returned path to a file tool:

```sh
curl -X PUT --data-binary @report.pdf -H "Authorization: Bearer YOUR-TOKEN" https://YOUR-DOMAIN/files/report.pdf
# {"path":"/data/uploads/report.pdf","size":123456}
```

## Memory

Idle use is about 60 MB; a 300-page PDF peaked at 184 MB in tests. Each conversion runs in a child process marked as the kernel's first OOM target, so a file too large for the plan fails that tool call instead of taking the server down. For very large files or parallel conversions, give the service 1 GB or more and raise `MD_MAX_CONCURRENT`.

## Updates

Railway shows an "update available" notice on deployed services when this repo's `main` changes. Read [CHANGELOG.md](CHANGELOG.md) before applying an update; breaking changes are listed first.
