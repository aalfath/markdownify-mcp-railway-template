# Deploy and Host Markdownify MCP on Railway

Markdownify MCP is an open-source Model Context Protocol (MCP) server that turns PDFs, Word, Excel and PowerPoint files, images, audio, web pages, YouTube videos, search results and Git repositories into Markdown. AI assistants such as Claude, Cursor or any MCP client call its tools and get clean text back.

## About Hosting Markdownify MCP

Upstream Markdownify MCP runs only over stdio on your own computer. This template runs version 1.1.0 as a remote MCP server: one service built from a public GitHub repo serves streamable HTTP at `/mcp` on Railway's public domain, behind a bearer token that Railway generates on deploy. Microsoft's MarkItDown does the conversions inside the same container, with no API key or paid service. Files you upload go to a volume at `/data`, so they survive restarts and redeploys. Conversions run one at a time and fit Railway's 0.5 GB plan for ordinary documents; very large files need more memory.

## Common Use Cases

* Give Claude, Cursor or another MCP client a tool that reads PDFs, Office files and web pages as Markdown
* Turn a Git repository, YouTube transcript or search results into Markdown context for an AI agent
* Run one shared, token-protected conversion server for a team instead of a local install on every laptop

## Dependencies for Markdownify MCP Hosting

* One Railway service built from `aalfath/markdownify-mcp-railway-template` (Bun, MarkItDown, ffmpeg, git)
* A Railway volume mounted at `/data` for uploaded files

### Deployment Dependencies

* Upstream project: https://github.com/zcaceres/markdownify-mcp (MIT)
* MarkItDown: https://github.com/microsoft/markitdown
* Template repo: https://github.com/aalfath/markdownify-mcp-railway-template

### Implementation Details

After deploy, open the service's **Variables** tab and copy `MCP_AUTH_TOKEN`. Every request except `GET /healthz` needs `Authorization: Bearer YOUR-TOKEN`.

Claude Code:

```sh
claude mcp add --transport http markdownify https://YOUR-DOMAIN/mcp --header "Authorization: Bearer YOUR-TOKEN"
```

Other clients (streamable HTTP):

```json
{ "mcpServers": { "markdownify": { "type": "http", "url": "https://YOUR-DOMAIN/mcp", "headers": { "Authorization": "Bearer YOUR-TOKEN" } } } }
```

The file tools (`pdf-to-markdown`, `docx-to-markdown`, `image-to-markdown`, `audio-to-markdown` and so on) read files on the server, so upload a file first and pass the returned path to the tool:

```sh
curl -X PUT --data-binary @report.pdf -H "Authorization: Bearer YOUR-TOKEN" https://YOUR-DOMAIN/files/report.pdf
# {"path":"/data/uploads/report.pdf","size":123456}
```

`GET /files` lists uploads and `DELETE /files/NAME` removes one. On a 0.5 GB service, uploads and downloads are capped at 25 MB (100 MB with 1 GB or more). Web tools refuse private and Railway-internal addresses. Updates: when the template repo moves to a new Markdownify release, Railway shows an "update available" notice on your service; read `CHANGELOG.md` in the repo before you apply it.

## Why Deploy Markdownify MCP on Railway?

<!-- Recommended: Keep this section as shown below -->
Railway is a singular platform to deploy your infrastructure stack. Railway will host your infrastructure so you don't have to deal with configuration, while allowing you to vertically and horizontally scale it.

By deploying Markdownify MCP on Railway, you are one step closer to supporting a complete full-stack application with minimal burden. Host your servers, databases, AI agents, and more on Railway.
<!-- End recommended section -->
