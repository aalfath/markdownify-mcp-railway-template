# Changelog

## 1.1.0 (2026-11-23)

First release of the Railway template.

- Markdownify MCP 1.1.0 (upstream commit `024f97cea9a94cd842c445eea4503c442c79bd71`) on `oven/bun:1.4.5-debian@sha256:3dddea58e1f8f2240eca906b023fedb944f9a8352515a35309fd0c879fe00aaa`, MarkItDown 0.1.9.
- Remote streamable-HTTP MCP endpoint at `/mcp`, bearer token from `MCP_AUTH_TOKEN`, health check at `/healthz`.
- Authenticated upload API on the `/data` volume for the file tools.
- Memory limits for Railway's 0.5 GB plan: one conversion at a time, single-threaded onnxruntime and repomix, size caps from the cgroup limit.
