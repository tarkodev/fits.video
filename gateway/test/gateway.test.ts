import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';

const ORIGIN = 'https://dev.fits.video';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(overrides: Partial<Config> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'fits-gateway-'));
  const received: { method: string; path: string; headers: IncomingHttpHeaders; bytes: number }[] = [];
  const jobs = new Map<string, string>();
  const mode = { holdStream: false, streamError: false, holdUpload: false, holdDownload: false, redirect: false, invalidUpload: false, dropped: 0, compressDelay: 0, compressStatus: 200 };
  const upstream = createServer(async (request, response) => {
    const path = request.url!, record = { method: request.method!, path, headers: request.headers, bytes: 0 }; received.push(record);
    if (path.startsWith('/api/upload')) {
      request.on('data', (chunk: Buffer) => { record.bytes += chunk.length; });
      request.on('aborted', () => mode.dropped++);
      if (mode.holdUpload) { request.resume(); return; }
      try { await once(request, 'end'); } catch { return; }
      response.setHeader('content-type', 'application/json');
      const id = randomUUID(); response.end(JSON.stringify({ job_id: id, filename: mode.invalidUpload ? '../other.mp4' : `${id}_video.mp4`, duration_s: 10 })); return;
    }
    if (path === '/api/compress') {
      let body = ''; for await (const chunk of request) body += chunk;
      assert.ok(JSON.parse(body).filename.endsWith('_video.mp4'));
      if (mode.compressDelay) await sleep(mode.compressDelay);
      if (mode.compressStatus !== 200) { response.writeHead(mode.compressStatus); response.end('{"detail":"upstream private error"}'); return; }
      const task = randomUUID(); jobs.set(task, 'PROGRESS'); response.end(JSON.stringify({ task_id: task })); return;
    }
    const task = path.split('/')[3];
    if (path.endsWith('/status')) { response.end(JSON.stringify({ state: jobs.get(task), progress: 35, detail: '/secret/upstream/path' })); return; }
    if (path.endsWith('/cancel')) { jobs.set(task, 'REVOKED'); response.end('{"status":"cancellation_requested"}'); return; }
    if (path.startsWith('/api/stream/')) {
      response.setHeader('content-type', 'text/event-stream');
      response.on('close', () => mode.dropped++);
      response.write(`data: ${JSON.stringify({ type: 'connected', task_id: task })}\n\n`);
      response.write(`data: ${JSON.stringify({ type: 'log', message: 'secret ffmpeg /path' })}\n\n`);
      response.write(`data: ${JSON.stringify({ type: 'progress', task_id: task, progress: 45, phase: 'encoding' })}\n\n`);
      if (!mode.holdStream) response.end(`data: ${JSON.stringify(mode.streamError ? { type: 'error', message: 'secret /redis/path' } : { type: 'done', task_id: task, stats: { secret: '/path' } })}\n\n`);
      return;
    }
    if (path.includes('/download')) {
      response.on('close', () => mode.dropped++);
      if (mode.redirect) { response.writeHead(302, { location: 'http://localhost/admin', 'set-cookie': 'upstream=secret' }); response.end(); return; }
      response.setHeader('set-cookie', 'admin=secret');
      response.setHeader('content-disposition', 'attachment; filename="result.mp4"');
      response.setHeader('accept-ranges', 'bytes');
      if (request.headers.range) { response.writeHead(206, { 'content-range': 'bytes 1-3/6', 'content-length': '3' }); response.end('bcd'); }
      else if (mode.holdDownload) { response.write('abc'); }
      else response.end('abcdef');
      return;
    }
    response.writeHead(500); response.end('UNEXPECTED ROUTE');
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const address = upstream.address() as { port: number };
  const config = { ...loadConfig({ GATEWAY_PUBLIC_ORIGIN: ORIGIN, GATEWAY_UPSTREAM_URL: `http://127.0.0.1:${address.port}`, GATEWAY_UPSTREAM_AUTH_ENABLED: 'true', GATEWAY_UPSTREAM_AUTH_USER: 'service', GATEWAY_UPSTREAM_AUTH_PASS: 'server-only', GATEWAY_STATE_PATH: join(directory, 'state.sqlite') }), ...overrides };
  let app = createApp(config, { logger: false });
  let base = await app.listen({ port: 0, host: '127.0.0.1' });
  async function session() { const result = await fetch(`${base}/api/session`); assert.equal(result.status, 200); return result.headers.get('set-cookie')!.split(';')[0]; }
  async function call(path: string, cookie?: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
    return fetch(`${base}${path}`, { method, headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  }
  async function upload(cookie: string) {
    const form = new FormData(); form.append('file', new Blob(['video bytes'], { type: 'video/mp4' }), 'video.mp4');
    form.append('target_size_mb', '20'); form.append('audio_bitrate_kbps', '128');
    const result = await fetch(`${base}/api/upload?target_size_mb=20&audio_bitrate_kbps=128`, { method: 'POST', headers: { cookie, origin: ORIGIN }, body: form });
    assert.equal(result.status, 200, await result.clone().text());
    const data = await result.json() as { job_id: string; filename: string };
    return { job_id: data.job_id, filename: data.filename };
  }
  async function job(cookie: string) {
    const uploaded = await upload(cookie); const result = await call('/api/compress', cookie, 'POST', { ...uploaded, target_size_mb: 20 });
    assert.equal(result.status, 200, await result.clone().text()); return { ...uploaded, ...await result.json() as { task_id: string } };
  }
  return { config, received, mode, jobs, session, call, upload, job, base: () => base,
    restart: async () => { await app.close(); app = createApp(config, { logger: false }); base = await app.listen({ port: 0, host: '127.0.0.1' }); },
    close: async () => { await app.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
  };
}

test('full public cycle, private upstream authorization and safe response headers', async () => {
  const f = await fixture(); try {
    const response = await fetch(`${f.base()}/api/session`), cookieHeader = response.headers.get('set-cookie')!;
    assert.match(cookieHeader, /__Host-fits_session=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict/);
    const cookie = cookieHeader.split(';')[0], job = await f.job(cookie);
    assert.equal((await f.call(`/api/jobs/${job.task_id}/status`, cookie)).status, 200);
    const stream = await f.call(`/api/stream/${job.task_id}`, cookie), events = await stream.text();
    assert.match(events, /"progress":45/); assert.match(events, /"type":"done"/); assert.doesNotMatch(events, /secret|\/path|stats|log/);
    const result = await f.call(`/api/jobs/${job.task_id}/download?wait=5`, cookie);
    assert.equal(await result.text(), 'abcdef'); assert.equal(result.headers.get('set-cookie'), null); assert.match(result.headers.get('content-disposition')!, /result.mp4/);
    assert.equal((await f.call(`/api/jobs/${job.task_id}/cancel`, cookie, 'POST')).status, 200);
    for (const record of f.received) { assert.equal(record.headers.authorization, `Basic ${Buffer.from('service:server-only').toString('base64')}`); assert.equal(record.headers.cookie, undefined); }
  } finally { await f.close(); }
});

test('different sessions cannot read, download, stream, cancel or reuse uploads', async () => {
  const f = await fixture(); try {
    const a = await f.session(), b = await f.session(), job = await f.job(a), other = await f.upload(b), before = f.received.length;
    for (const [path, method] of [[`/api/jobs/${job.task_id}/status`, 'GET'], [`/api/jobs/${job.task_id}/download`, 'GET'], [`/api/stream/${job.task_id}`, 'GET'], [`/api/jobs/${job.task_id}/cancel`, 'POST']]) assert.equal((await f.call(path, b, method)).status, 404);
    assert.equal((await f.call('/api/compress', b, 'POST', { job_id: job.job_id, filename: job.filename, target_size_mb: 20 })).status, 404);
    assert.equal((await f.call('/api/compress', b, 'POST', { job_id: other.job_id, filename: job.filename, target_size_mb: 20 })).status, 404);
    assert.equal(f.received.length, before);
  } finally { await f.close(); }
});

test('strict allowlist blocks admin, path/query/header overrides and missing ownership', async () => {
  const f = await fixture(); try {
    const cookie = await f.session(), before = f.received.length;
    for (const path of ['/api/settings/auth', '/api/history', '/api/queue/status', '/api/queue/clear', '/api/batches/upload', '/api/upload/extra', '/api/%73ettings/auth', '/api//settings/auth']) assert.ok((await f.call(path, cookie)).status >= 400);
    assert.equal((await f.call('/api/compress?upstream=http://localhost', cookie, 'POST', {})).status, 400);
    assert.equal((await f.call('/api/session', cookie, 'GET', undefined, { authorization: 'Basic attacker' })).status, 400);
    assert.equal((await f.call(`/api/jobs/${randomUUID()}/status`, cookie)).status, 404);
    assert.equal((await f.call('/api/compress', undefined, 'POST', {})).status, 401);
    assert.equal(f.received.length, before);
  } finally { await f.close(); }
});

test('CSRF and fetch metadata checks reject browser cross-site requests', async () => {
  const f = await fixture(); try {
    const cookie = await f.session();
    assert.equal((await f.call('/api/compress', cookie, 'POST', {}, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await f.call('/api/session', cookie, 'GET', undefined, { 'sec-fetch-site': 'cross-site' })).status, 403);
    const missing = await fetch(`${f.base()}/api/compress`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(missing.status, 403); assert.equal(f.received.length, 0);
  } finally { await f.close(); }
});

test('range download and query validation preserve byte semantics', async () => {
  const f = await fixture(); try {
    const cookie = await f.session(), job = await f.job(cookie);
    const result = await f.call(`/api/jobs/${job.task_id}/download?wait=0`, cookie, 'GET', undefined, { range: 'bytes=1-3' });
    assert.equal(result.status, 206); assert.equal(result.headers.get('content-range'), 'bytes 1-3/6'); assert.equal(await result.text(), 'bcd');
    for (const query of ['?wait=31', '?wait=1&wait=2', '?url=http://evil', '?wait=NaN', '?__proto__=1', '?toString=1']) assert.equal((await f.call(`/api/jobs/${job.task_id}/download${query}`, cookie)).status, 400);
    assert.equal((await f.call(`/api/jobs/${job.task_id}/download`, cookie, 'GET', undefined, { range: 'bytes=0-1,3-4' })).status, 400);
  } finally { await f.close(); }
});

test('ownership and session survive application restart', async () => {
  const f = await fixture(); try {
    const cookie = await f.session(), job = await f.job(cookie); await f.restart();
    assert.equal((await f.call(`/api/jobs/${job.task_id}/status`, cookie)).status, 200);
    assert.equal(await (await f.call(`/api/jobs/${job.task_id}/download`, cookie)).text(), 'abcdef');
    assert.equal((await f.call(`/api/jobs/${job.task_id}/status`, await f.session())).status, 404);
  } finally { await f.close(); }
});

test('upload filename spoofing and arbitrary compression fields never reach upstream', async () => {
  const f = await fixture(); try {
    const cookie = await f.session(), upload = await f.upload(cookie), before = f.received.length;
    for (const extra of [{ filename: '../other.mp4' }, { filename: `${upload.job_id}_other.mp4` }, { input_path: '/etc/passwd' }, { output_path: '/tmp/a' }, { target_size_mb: 2049 }, { target_size_mb: -1 }]) assert.ok((await f.call('/api/compress', cookie, 'POST', { ...upload, target_size_mb: 20, ...extra })).status >= 400);
    assert.equal(f.received.length, before);
  } finally { await f.close(); }
});

test('double compression race dispatches only once', async () => {
  const f = await fixture(); try {
    const cookie = await f.session(), upload = await f.upload(cookie); f.mode.compressDelay = 80;
    const results = await Promise.all([f.call('/api/compress', cookie, 'POST', { ...upload, target_size_mb: 20 }), f.call('/api/compress', cookie, 'POST', { ...upload, target_size_mb: 20 })]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    assert.equal(f.received.filter(r => r.path === '/api/compress').length, 1);
  } finally { await f.close(); }
});

test('active job limits preserve backend settings and release on terminal status', async () => {
  const f = await fixture({ maxJobsPerSession: 1 }); try {
    const cookie = await f.session(), job = await f.job(cookie), upload = await f.upload(cookie);
    assert.equal((await f.call('/api/compress', cookie, 'POST', { ...upload, target_size_mb: 20 })).status, 429);
    await f.call(`/api/jobs/${job.task_id}/cancel`, cookie, 'POST'); await f.call(`/api/jobs/${job.task_id}/status`, cookie);
    assert.equal((await f.call('/api/compress', cookie, 'POST', { ...upload, target_size_mb: 20 })).status, 200);
  } finally { await f.close(); }
});

test('oversized uploads with Content-Length are rejected before upstream', async () => {
  const f = await fixture({ maxUploadBytes: 1024 }); try {
    const cookie = await f.session(); const form = new FormData(); form.append('file', new Blob([Buffer.alloc(2048)]), 'big.mp4');
    const response = await fetch(`${f.base()}/api/upload`, { method: 'POST', headers: { cookie, origin: ORIGIN }, body: form });
    assert.equal(response.status, 413); assert.equal(f.received.length, 0);
  } finally { await f.close(); }
});

test('chunked oversized uploads are cut off while streaming', async () => {
  const f = await fixture({ maxUploadBytes: 1024 }); try {
    const cookie = await f.session();
    const status = await new Promise<number>(resolve => {
      const request = httpRequest(`${f.base()}/api/upload`, { method: 'POST', headers: { cookie, origin: ORIGIN, 'content-type': 'multipart/form-data; boundary=test' } }, response => { response.resume(); resolve(response.statusCode!); });
      request.on('error', () => resolve(0)); request.write(Buffer.alloc(512)); setTimeout(() => request.end(Buffer.alloc(2048)), 30);
    });
    assert.ok(status === 0 || status === 413); await sleep(50);
    assert.ok(f.received.every(r => r.bytes <= 1024));
  } finally { await f.close(); }
});

test('upstream redirect and cookies never escape through gateway', async () => {
  const f = await fixture(); try {
    const cookie = await f.session(), job = await f.job(cookie); f.mode.redirect = true;
    const response = await f.call(`/api/jobs/${job.task_id}/download`, cookie);
    assert.equal(response.status, 502); assert.equal(response.headers.get('location'), null); assert.equal(response.headers.get('set-cookie'), null);
  } finally { await f.close(); }
});

test('client abort closes SSE upstream and frees connection quota', async () => {
  const f = await fixture({ maxStreamsPerSession: 1 }); try {
    const cookie = await f.session(), job = await f.job(cookie); f.mode.holdStream = true;
    const controller = new AbortController();
    const stream = await fetch(`${f.base()}/api/stream/${job.task_id}`, { headers: { cookie, origin: ORIGIN }, signal: controller.signal });
    const reader = stream.body!.getReader(); await reader.read();
    assert.equal((await f.call(`/api/stream/${job.task_id}`, cookie)).status, 429);
    controller.abort(); await reader.cancel().catch(() => {}); await sleep(80); assert.ok(f.mode.dropped >= 1);
    f.mode.holdStream = false;
    const next = await f.call(`/api/stream/${job.task_id}`, cookie); assert.equal(next.status, 200); await next.text();
  } finally { await f.close(); }
});

test('client abort closes streaming download upstream', async () => {
  const f = await fixture(); try {
    const cookie = await f.session(), job = await f.job(cookie); f.mode.holdDownload = true;
    const controller = new AbortController(), response = await fetch(`${f.base()}/api/jobs/${job.task_id}/download`, { headers: { cookie }, signal: controller.signal });
    const reader = response.body!.getReader(); await reader.read(); controller.abort(); await reader.cancel().catch(() => {}); await sleep(80);
    assert.ok(f.mode.dropped >= 1);
  } finally { await f.close(); }
});

test('SSE transport error does not free capacity while compression is still running', async () => {
  const f = await fixture({ maxJobsPerSession: 1 }); try {
    const cookie = await f.session(), job = await f.job(cookie), uploaded = await f.upload(cookie); f.mode.streamError = true;
    const result = await f.call(`/api/stream/${job.task_id}`, cookie), body = await result.text();
    assert.match(body, /Compression failed/); assert.doesNotMatch(body, /redis|secret/);
    assert.equal((await f.call('/api/compress', cookie, 'POST', { ...uploaded, target_size_mb: 20 })).status, 429);
    f.jobs.set(job.task_id, 'FAILURE'); await f.call(`/api/jobs/${job.task_id}/status`, cookie);
    assert.equal((await f.call('/api/compress', cookie, 'POST', { ...uploaded, target_size_mb: 20 })).status, 200);
  } finally { await f.close(); }
});

test('client upload abort closes upstream and releases simultaneous-upload capacity', async () => {
  const f = await fixture({ maxUploadsPerSession: 1 }); try {
    const cookie = await f.session(); f.mode.holdUpload = true;
    const request = httpRequest(`${f.base()}/api/upload`, { method: 'POST', headers: { cookie, origin: ORIGIN, 'content-type': 'multipart/form-data; boundary=test' } });
    request.on('error', () => {}); request.write('--test\r\nContent-Disposition: form-data; name="file"; filename="video.mp4"\r\n\r\npartialvideo');
    await sleep(50); request.destroy(); await sleep(80);
    assert.ok(f.mode.dropped >= 1); f.mode.holdUpload = false;
    assert.ok((await f.upload(cookie)).job_id);
  } finally { await f.close(); }
});

test('upstream timeout ends pending upload and frees transfer capacity', async () => {
  const f = await fixture({ uploadTimeoutMs: 100, maxUploadsPerSession: 1 }); try {
    const cookie = await f.session(); f.mode.holdUpload = true;
    const form = new FormData(); form.append('file', new Blob(['video']), 'video.mp4');
    const result = await fetch(`${f.base()}/api/upload`, { method: 'POST', headers: { cookie, origin: ORIGIN }, body: form });
    assert.equal(result.status, 504); f.mode.holdUpload = false;
    assert.ok((await f.upload(cookie)).job_id);
  } finally { await f.close(); }
});

test('client disconnect after compression dispatch preserves task ownership and sweep releases terminal capacity', async t => {
  // Only replace maintenance intervals; network and upstream-delay timers stay real.
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await fixture({ maxJobsPerSession: 1, maxActiveJobs: 1 }); try {
    const cookie = await f.session(), uploaded = await f.upload(cookie);
    f.mode.compressDelay = 150;
    const body = JSON.stringify({ ...uploaded, target_size_mb: 20 });
    const request = httpRequest(`${f.base()}/api/compress`, { method: 'POST', headers: {
      cookie, origin: ORIGIN, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body)
    } });
    request.on('error', () => {}); request.end(body);
    for (let attempt = 0; attempt < 100 && !f.received.some(record => record.path === '/api/compress'); attempt++) await sleep(5);
    assert.equal(f.received.filter(record => record.path === '/api/compress').length, 1);
    request.destroy(); // upstream has accepted the JSON, but has not replied yet
    await sleep(250);
    assert.equal(f.jobs.size, 1);
    const task = [...f.jobs.keys()][0];
    // The task ID is still bound to this cookie, despite no client response.
    assert.equal((await f.call(`/api/jobs/${task}/status`, cookie)).status, 200);
    assert.equal((await f.call(`/api/jobs/${task}/status`, await f.session())).status, 404);
    const next = await f.upload(cookie);
    assert.equal((await f.call('/api/compress', cookie, 'POST', { ...next, target_size_mb: 20 })).status, 429);
    f.jobs.set(task, 'SUCCESS');
    t.mock.timers.tick(30000); // no browser status request: maintenance owns recovery
    await sleep(80);
    assert.equal((await f.call('/api/compress', cookie, 'POST', { ...next, target_size_mb: 20 })).status, 200);
  } finally { await f.close(); }
});

test('upstream authentication rejection releases the upload without automatic dispatch retry', async () => {
  const f = await fixture(); try {
    const cookie = await f.session();
    for (const status of [401, 403]) {
      const uploaded = await f.upload(cookie); f.mode.compressStatus = status;
      const before = f.received.filter(record => record.path === '/api/compress').length;
      assert.equal((await f.call('/api/compress', cookie, 'POST', { ...uploaded, target_size_mb: 20 })).status, 502);
      assert.equal(f.received.filter(record => record.path === '/api/compress').length, before + 1);
      f.mode.compressStatus = 200;
      assert.equal((await f.call('/api/compress', cookie, 'POST', { ...uploaded, target_size_mb: 20 })).status, 200);
    }
  } finally { await f.close(); }
});

test('connection refused before dispatch releases ownership for an explicit later retry', async () => {
  const f = await fixture(); try {
    const cookie = await f.session(), uploaded = await f.upload(cookie), original = f.config.upstreamUrl;
    const unused = createServer(); unused.listen(0, '127.0.0.1'); await once(unused, 'listening');
    const port = (unused.address() as { port: number }).port;
    await new Promise<void>(resolve => unused.close(() => resolve()));
    f.config.upstreamUrl = `http://127.0.0.1:${port}`;
    assert.equal((await f.call('/api/compress', cookie, 'POST', { ...uploaded, target_size_mb: 20 })).status, 502);
    assert.equal(f.received.filter(record => record.path === '/api/compress').length, 0);
    f.config.upstreamUrl = original;
    assert.equal((await f.call('/api/compress', cookie, 'POST', { ...uploaded, target_size_mb: 20 })).status, 200);
    assert.equal(f.received.filter(record => record.path === '/api/compress').length, 1);
  } finally { await f.close(); }
});

test('ambiguous server failure stays uncertain and never automatically retries compression', async () => {
  const f = await fixture(); try {
    const cookie = await f.session(), uploaded = await f.upload(cookie); f.mode.compressStatus = 503;
    assert.equal((await f.call('/api/compress', cookie, 'POST', { ...uploaded, target_size_mb: 20 })).status, 502);
    f.mode.compressStatus = 200;
    assert.equal((await f.call('/api/compress', cookie, 'POST', { ...uploaded, target_size_mb: 20 })).status, 409);
    assert.equal(f.received.filter(record => record.path === '/api/compress').length, 1);
  } finally { await f.close(); }
});

test('new session rate limits do not trust client forwarded headers by default', async () => {
  const f = await fixture({ maxSessionsPerHour: 1 }); try {
    await f.session();
    assert.equal((await fetch(`${f.base()}/api/session`, { headers: { 'x-forwarded-for': '1.2.3.4' } })).status, 429);
    assert.equal((await fetch(`${f.base()}/api/session`, { headers: { 'x-forwarded-for': '5.6.7.8' } })).status, 429);
  } finally { await f.close(); }
});

test('required configuration fails closed and credentials stay server-only', () => {
  assert.throws(() => loadConfig({}), /GATEWAY_PUBLIC_ORIGIN/);
  assert.throws(() => loadConfig({ GATEWAY_PUBLIC_ORIGIN: 'http://dev.fits.video' }), /HTTPS origin/);
  assert.throws(() => loadConfig({ GATEWAY_PUBLIC_ORIGIN: ORIGIN, GATEWAY_UPSTREAM_URL: 'http://localhost/path' }), /fixed HTTP/);
  assert.throws(() => loadConfig({ GATEWAY_PUBLIC_ORIGIN: ORIGIN, GATEWAY_UPSTREAM_URL: 'http://localhost', GATEWAY_UPSTREAM_AUTH_ENABLED: 'true' }), /GATEWAY_UPSTREAM_AUTH_USER/);
});
