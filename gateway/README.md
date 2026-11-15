# fits.video public gateway

The static frontend calls this service on its own origin under `/api`. The gateway
relays a fixed allowlist to the private 8mb.local API. It does not serve the admin
interface and cannot select an upstream URL from a browser request.

## Runtime and configuration

Node.js 24+, TypeScript and Fastify 5. `npm ci`, `npm run check`, `npm test`,
`npm run build`, then `npm start`. Docker runs as the `node` user (UID 1000) and
listens on port 3000. Persist `/state` in a writable volume. SQLite uses WAL and
transactions/atomic updates, with no native addon dependency. The schema is
versioned; unknown versions fail startup. One gateway instance per state file is
supported; concurrency/stream counters are process-local.

Copy the keys from `.env.example` into the **server's** environment. Origin,
upstream URL, upstream auth mode and state path are required. There are no secret
fallbacks. When auth is enabled, both user and password are required, sent only
from gateway to upstream. With auth disabled, the upstream must be isolated by
network policy and the administrative hostname protected separately.

The gateway must not publish a host port. Nginx should relay `/api/` to
`http://gateway:3000` **without stripping the prefix**, preserve `Origin`, set
`X-Forwarded-For` from the actual peer, disable upload request buffering and SSE
response buffering, and permit the configured upload size (default 2 GiB total
multipart request). Only set `GATEWAY_TRUST_PROXY` to the dedicated frontend
proxy IP or isolated frontend subnet. The default does not trust forwarded IPs.
Do not use `true` or a broadly shared Docker network here.

The proxy-to-gateway connection can use HTTP on its private Docker network; the
public origin must use HTTPS. The session cookie is always Secure.

## Public API

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Process readiness only (does not reveal upstream configuration) |
| GET | `/api/session` | Create/reuse an anonymous session; returns public upload limits |
| POST | `/api/upload` | Stream a multipart upload; returns owned `job_id` and exact stored `filename` |
| POST | `/api/compress` | Submit an owned upload once; returns owned `task_id` |
| GET | `/api/jobs/:task_id/status` | Read only the current session's job |
| GET | `/api/stream/:task_id` | Filtered SSE progress for an owned job |
| GET | `/api/jobs/:task_id/download?wait=5` | Stream an owned output, including one HTTP byte range |
| POST | `/api/jobs/:task_id/cancel` | Request cancellation of an owned job |

Initialize `/api/session` before uploading. The cookie is a random 256-bit opaque
token, stored only as a hash in SQLite, `__Host-`, HttpOnly, Secure, SameSite=Strict
and Path=/. A session lasts seven days by default; ownership records last two
days. A visitor can recover only jobs created with that cookie. Losing the cookie
loses access. Existing 8mb.local jobs have no reliable owner and are not exposed;
administrators can still use the upstream interface to retrieve them. No backend
settings, credentials, history or files are migrated or rewritten.

Every mutation requires an exact matching `Origin`. Cross-site Fetch Metadata is
rejected. Methods, raw paths, queries and JSON fields are allowlisted. Client
Authorization, Cookie and administrative/proxy headers are never sent upstream;
only the fixed server Authorization, content type and validated byte range are
used. Upstream cookies, redirect locations, error bodies, FFmpeg logs, paths,
telemetry and arbitrary download URLs are not exposed.

Compress accepts only `job_id`, exact `filename`, `target_size_mb`, optional
`audio_bitrate_kbps`, optional `video_codec`. It validates the ownership tuple and
replaces the filename from server state. Atomic claiming rejects duplicate and
concurrent submissions. An interrupted dispatch is marked uncertain and is not
automatically retried: dispatch may already have reached upstream.

Uploads and downloads use Node streams with backpressure. Uploads count bytes
even without Content-Length and are terminated on overflow. Client disconnects
abort upstream uploads, downloads and SSE. Responses and requests have bounded
timeouts. No whole video is buffered in memory. JSON responses are capped at
64 KiB; individual SSE frames are capped at 64 KiB and filtered to the fields the
frontend uses.

Compression dispatch deliberately continues after a browser disconnect: it is a
small, non-idempotent JSON operation that may already have started FFmpeg. The
gateway still reads the bounded upstream response and persists the returned task
ID, allowing maintenance to observe completion and release capacity. Closing the
browser is not a request to cancel a compression; cancellation has its own route.
Upstream authentication rejections and DNS/connection failures known to occur
before dispatch release the upload for an explicit later request. Timeouts,
connection resets and 5xx responses remain uncertain. The gateway never retries
compression dispatch automatically.

## Limits and operational behavior

`.env.example` lists every configurable limit. Defaults: 2 GiB per upload,
8 concurrent uploads globally, 2 per session, 32 active jobs globally, 3 per
session, 6 SSE connections per session, 240 requests/minute/session and 4x that
per trusted client IP, 30 new sessions/hour/IP. At most 30 retained uploads per
session and 10,000 globally are admitted. Set reverse proxy connection/body
timeouts and deployment CPU/RAM/PID limits to match the workload.

Terminal status/SSE/downloads release active job capacity. A 30-second sweep
checks jobs whose browser disconnected. An upstream outage keeps those records
active until state can be confirmed; it does not silently reopen capacity.
Cancel acknowledgement alone does not prove FFmpeg has stopped, so it does not
release capacity until terminal status. Quotas do not alter 8mb.local settings.
Gateway retention only removes its authorization metadata, never upstream files;
the existing backend retention policy owns file cleanup.

The gateway does not make the upstream safe if another public route or host port
still bypasses it. Protect the entire administrative hostname with ExotiKorp SSO,
including API paths; remove any public access to the backend's direct host port.

## Verification

`npm test` starts real HTTP mock upstream and gateway servers. It covers the
complete public cycle, independent cookie sessions, ID/filename ownership,
forbidden routes and headers, CSRF, query/path validation, duplicate compression
races, byte ranges, restart persistence, active-job limits, oversized fixed and
chunked uploads, redirects, SSE/download abort propagation, forwarded-IP handling
and required configuration. These tests do not replace an actual browser and
FFmpeg end-to-end test against the dev deployment.
