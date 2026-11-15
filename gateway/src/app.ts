import Fastify, { LogController, type FastifyReply, type FastifyRequest } from 'fastify';
import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import type { Config } from './config.js';
import { State } from './state.js';

const COOKIE = '__Host-fits_session';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL = new Set(['SUCCESS', 'FAILURE', 'REVOKED', 'CANCELED', 'CANCELLED', 'COMPLETED', 'DONE', 'FAILED']);
// These failures occur while resolving or connecting, before any HTTP body can
// reach the API. Timeouts, resets and server errors remain ambiguous.
const BEFORE_DISPATCH_ERRORS = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);
class PublicError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}
const invalid = () => new PublicError(400, 'Invalid request');
const unavailable = () => new PublicError(502, 'Compression service temporarily unavailable');

class Windows {
  readonly values = new Map<string, { count: number; until: number }>();
  take(key: string, limit: number, milliseconds: number): boolean {
    const now = Date.now();
    let item = this.values.get(key);
    if (!item || item.until < now) {
      if (this.values.size >= 20000) {
        for (const [key, value] of this.values) if (value.until < now) this.values.delete(key);
        if (this.values.size >= 20000) return false;
      }
      item = { count: 0, until: now + milliseconds };
      this.values.set(key, item);
    }
    return ++item.count <= limit;
  }
}

function validateQuery(raw: string, allowed: Record<string, [number, number]>) {
  const result = new URLSearchParams();
  const query = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : '';
  for (const [key, value] of new URLSearchParams(query)) {
    if (!Object.hasOwn(allowed, key) || result.has(key) || !/^\d+(?:\.\d+)?$/.test(value)) throw invalid();
    const num = Number(value), [min, max] = allowed[key];
    if (!Number.isFinite(num) || num < min || num > max) throw invalid();
    result.set(key, String(num));
  }
  return result.size ? `?${result.toString()}` : '';
}

function validateCompress(body: unknown, config: Config): { job_id: string; filename: string; target_size_mb: number; audio_bitrate_kbps?: number; video_codec?: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid();
  const data = body as Record<string, unknown>;
  const keys = ['job_id', 'filename', 'target_size_mb', 'audio_bitrate_kbps', 'video_codec'];
  if (Object.keys(data).some(key => !keys.includes(key))) throw invalid();
  if (typeof data.job_id !== 'string' || !UUID.test(data.job_id) || typeof data.filename !== 'string') throw invalid();
  if (typeof data.target_size_mb !== 'number' || !Number.isFinite(data.target_size_mb) || data.target_size_mb <= 0 || data.target_size_mb > config.maxTargetMb) throw invalid();
  if (data.audio_bitrate_kbps !== undefined && (typeof data.audio_bitrate_kbps !== 'number' || !Number.isInteger(data.audio_bitrate_kbps) || data.audio_bitrate_kbps < 0 || data.audio_bitrate_kbps > 2000)) throw invalid();
  if (data.video_codec !== undefined && (typeof data.video_codec !== 'string' || !/^(?:av1|hevc|h264)_(?:nvenc|qsv|vaapi|amf|mf|videotoolbox)$|^(?:libx264|libx265|libsvtav1|libaom-av1)$/.test(data.video_codec))) throw invalid();
  return data as ReturnType<typeof validateCompress>;
}

async function readJson(response: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response) {
    bytes += chunk.length;
    if (bytes > 65536) { response.destroy(); throw unavailable(); }
    chunks.push(chunk);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* never expose an upstream HTML/traceback body */ }
  throw unavailable();
}

function checkStatus(response: IncomingMessage) {
  const status = response.statusCode ?? 502;
  if (status >= 200 && status < 300) return;
  response.destroy();
  if (status === 404) throw new PublicError(404, 'Video not found or expired');
  if (status === 409 || status === 425) throw new PublicError(409, 'Video is not ready');
  if (status === 400 || status === 422) throw new PublicError(422, 'Invalid video or compression options');
  if (status === 413) throw new PublicError(413, 'Video exceeds the upload limit');
  if (status === 416) throw new PublicError(416, 'Requested byte range is unavailable');
  throw unavailable();
}

function sseFilter(task: string, finish: () => void) {
  let buffer = '';
  const decoder = new StringDecoder('utf8');
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      buffer = (buffer + decoder.write(chunk)).replace(/\r\n/g, '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        if (boundary > 65536) return callback(unavailable());
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const raw = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
        let data: Record<string, unknown>;
        try { data = JSON.parse(raw); } catch { continue; }
        if (!data || typeof data !== 'object') continue;
        const event: Record<string, unknown> = { type: data.type, task_id: task };
        if (data.task_id !== undefined && data.task_id !== task) continue;
        switch (data.type) {
          case 'connected': case 'ping': event.ts = Date.now() / 1000; break;
          case 'progress':
            if (typeof data.progress !== 'number' || !Number.isFinite(data.progress)) continue;
            event.progress = Math.max(0, Math.min(100, data.progress));
            if (['encoding', 'finalizing', 'done'].includes(String(data.phase))) event.phase = data.phase;
            for (const key of ['eta_seconds', 'speed_x']) if (typeof data[key] === 'number' && Number.isFinite(data[key])) event[key] = data[key];
            break;
          case 'done': case 'canceled': finish(); break;
          // A pub/sub transport error does not prove the compression stopped.
          // Capacity is released only after a terminal status or done/canceled.
          case 'error': event.message = 'Compression failed'; break;
          case 'retry': event.message = 'Retrying compression to match the target size'; break;
          default: continue; // FFmpeg logs, paths, telemetry and arbitrary upstream URLs stay private.
        }
        this.push(`data: ${JSON.stringify(event)}\n\n`);
      }
      if (buffer.length > 65536) return callback(unavailable());
      callback();
    }
  });
}

export function createApp(config: Config, options: { logger?: boolean } = {}) {
  const app = Fastify({ logger: options.logger ?? true, trustProxy: config.trustProxy, bodyLimit: 16384,
    requestTimeout: config.uploadTimeoutMs, connectionTimeout: 30000,
    forceCloseConnections: true,
    logController: new LogController({ disableRequestLogging: true }), routerOptions: { ignoreTrailingSlash: false, ignoreDuplicateSlashes: false } });
  const state = new State(config), limits = new Windows();
  const owners = new WeakMap<FastifyRequest, string>();
  const uploads = new Map<string, number>(), streams = new Map<string, number>();
  let uploadCount = 0, sweeping = false;
  const sweepAbort = new AbortController();
  app.addContentTypeParser(/^multipart\/form-data(?:;|$)/i, (_request, payload, done) => done(null, payload));

  function upstream(path: string, method: string, options: {
    body?: Readable; json?: unknown; headers?: OutgoingHttpHeaders; timeout?: number; signal?: AbortSignal; maxBytes?: number;
  } = {}): Promise<IncomingMessage> {
    const url = new URL(path, config.upstreamUrl);
    if (url.origin !== config.upstreamUrl || !path.startsWith('/api/')) throw invalid();
    const headers: OutgoingHttpHeaders = { ...options.headers };
    if (config.upstreamAuthorization) headers.authorization = config.upstreamAuthorization;
    let json: string | undefined;
    if (options.json !== undefined) {
      json = JSON.stringify(options.json); headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(json);
    }
    return new Promise((resolve, reject) => {
      let connected = false;
      const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method, headers, signal: options.signal }, response => {
        const abortResponse = () => response.destroy();
        options.signal?.addEventListener('abort', abortResponse, { once: true });
        response.once('close', () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abortResponse); });
        resolve(response);
      });
      req.once('socket', socket => {
        connected = !socket.connecting;
        socket.once('connect', () => { connected = true; });
      });
      const timer = setTimeout(() => req.destroy(new PublicError(504, 'Compression service timed out')), options.timeout ?? config.upstreamTimeoutMs);
      timer.unref();
      req.once('error', error => {
        clearTimeout(timer);
        const code = (error as NodeJS.ErrnoException).code;
        if (!connected && code && BEFORE_DISPATCH_ERRORS.has(code)) Object.assign(error, { beforeDispatch: true });
        reject(error);
      });
      if (options.body) {
        let count = 0;
        const counter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
          count += chunk.length;
          if (count > (options.maxBytes ?? config.maxUploadBytes)) {
            const error = new PublicError(413, 'Video exceeds the upload limit');
            reject(error); callback(error);
          } else callback(null, chunk);
        } });
        pipeline(options.body, counter, req).catch(error => { req.destroy(error); reject(error); });
      } else req.end(json);
    });
  }

  function clientSignal(request: FastifyRequest, reply: FastifyReply) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.raw.once('aborted', abort);
    reply.raw.once('close', () => { if (!reply.raw.writableEnded) abort(); request.raw.off('aborted', abort); });
    return controller.signal;
  }
  function owner(request: FastifyRequest) { return owners.get(request)!; }
  function taskFor(request: FastifyRequest): string {
    const task = (request.params as { task: string }).task;
    if (!UUID.test(task) || !state.getTask(task, owner(request))) throw new PublicError(404, 'Video not found or expired');
    return task;
  }

  app.addHook('onRequest', async (request, reply) => {
    reply.header('cache-control', 'no-store').header('x-content-type-options', 'nosniff').header('referrer-policy', 'no-referrer');
    const raw = request.raw.url ?? '', pathname = raw.split('?')[0];
    // Reject encoded separators, dot-segments, absolute-form and route aliases before routing.
    if (!/^\/api\/[A-Za-z0-9/-]+$/.test(pathname) || pathname.includes('//') || request.headers.authorization) throw invalid();
    if (pathname === '/api/health' && request.method === 'GET') { validateQuery(raw, {}); return; }
    const allowed = (request.method === 'GET' && /^\/api\/(?:session|jobs\/[0-9a-f-]+\/(?:status|download)|stream\/[0-9a-f-]+)$/i.test(pathname)) ||
      (request.method === 'POST' && /^\/api\/(?:upload|compress|jobs\/[0-9a-f-]+\/cancel)$/i.test(pathname));
    if (!allowed) throw new PublicError(404, 'Not found');
    const origin = request.headers.origin, site = request.headers['sec-fetch-site'];
    if ((origin !== undefined && origin !== config.publicOrigin) || (site !== undefined && site !== 'same-origin' && site !== 'none')) throw new PublicError(403, 'Cross-site request rejected');
    if (request.method === 'POST' && origin !== config.publicOrigin) throw new PublicError(403, 'Same-origin request required');
    if (!limits.take(`ip:${request.ip}`, config.maxRequestsPerMinute * 4, 60000)) throw new PublicError(429, 'Too many requests');
    const cookies = (request.headers.cookie ?? '').split(';').map(v => v.trim()).filter(v => v.startsWith(`${COOKIE}=`));
    if (cookies.length > 1) throw invalid();
    let id = cookies[0] ? state.findSession(cookies[0].slice(COOKIE.length + 1)) : undefined;
    if (pathname === '/api/session' && !id) {
      if (!limits.take(`new:${request.ip}`, config.maxSessionsPerHour, 3600000)) throw new PublicError(429, 'Too many new sessions');
      state.cleanup();
      const created = state.newSession(); id = created.id;
      reply.header('set-cookie', `${COOKIE}=${created.token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${config.sessionSeconds}`);
    }
    if (!id) throw new PublicError(401, 'Browser session missing or expired. Reload the page.');
    owners.set(request, id);
    if (!limits.take(`session:${id}`, config.maxRequestsPerMinute, 60000)) throw new PublicError(429, 'Too many requests');
  });

  app.get('/api/health', async () => ({ status: 'ok' }));
  app.get('/api/session', async request => {
    validateQuery(request.raw.url!, {});
    return { ready: true, limits: { max_upload_bytes: config.maxUploadBytes, max_target_mb: config.maxTargetMb } };
  });
  app.post('/api/upload', async (request, reply) => {
    const query = validateQuery(request.raw.url!, { target_size_mb: [0.01, config.maxTargetMb], audio_bitrate_kbps: [0, 2000] });
    const contentType = request.headers['content-type'] ?? '';
    if (!/^multipart\/form-data;\s*boundary=(?:[A-Za-z0-9'()+_,./:=?-]{1,100}|"[A-Za-z0-9'()+_,./:=?-]{1,100}")$/i.test(contentType)) throw invalid();
    const length = request.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > config.maxUploadBytes)) throw new PublicError(413, 'Video exceeds the upload limit');
    const id = owner(request);
    if (state.count() >= config.maxRecords || state.count(id) >= 30) throw new PublicError(429, 'Too many retained uploads. Please retry later.');
    if (uploadCount >= config.maxUploads || (uploads.get(id) ?? 0) >= config.maxUploadsPerSession) throw new PublicError(429, 'Too many simultaneous uploads');
    uploadCount++; uploads.set(id, (uploads.get(id) ?? 0) + 1);
    try {
      const response = await upstream(`/api/upload${query}`, 'POST', { body: request.body as Readable,
        headers: { 'content-type': contentType }, timeout: config.uploadTimeoutMs, signal: clientSignal(request, reply) });
      checkStatus(response);
      const data = await readJson(response);
      if (typeof data.job_id !== 'string' || !UUID.test(data.job_id) || typeof data.filename !== 'string' ||
        data.filename.length > 512 || !data.filename.startsWith(`${data.job_id}_`) || /[\x00-\x1f\x7f/\\]/.test(data.filename)) throw unavailable();
      state.upload(data.job_id, id, data.filename);
      const output: Record<string, unknown> = { job_id: data.job_id, filename: data.filename };
      for (const key of ['duration_s', 'original_video_bitrate_kbps', 'original_audio_bitrate_kbps', 'original_width', 'original_height', 'original_video_fps', 'estimate_total_kbps', 'estimate_video_kbps']) {
        if (typeof data[key] === 'number' && Number.isFinite(data[key])) output[key] = data[key];
      }
      if (typeof data.warn_low_quality === 'boolean') output.warn_low_quality = data.warn_low_quality;
      return output;
    } finally {
      uploadCount--;
      const remaining = (uploads.get(id) ?? 1) - 1;
      if (remaining) uploads.set(id, remaining); else uploads.delete(id);
    }
  });
  app.post('/api/compress', async (request, reply) => {
    validateQuery(request.raw.url!, {});
    const data = validateCompress(request.body, config), id = owner(request);
    const record = state.getUpload(data.job_id, id);
    if (!record || record.filename !== data.filename) throw new PublicError(404, 'Video not found or expired');
    if (state.count(undefined, true) >= config.maxActiveJobs || state.count(id, true) >= config.maxJobsPerSession) throw new PublicError(429, 'Too many active compressions');
    if (!state.claim(data.job_id, id)) throw new PublicError(409, 'This upload has already been submitted');
    try {
      // Dispatch is a non-idempotent mutation. Once sent, a browser disconnect
      // must not interrupt reading its task ID: upstream may already be running
      // FFmpeg. Persist the bounded upstream result even when the client left.
      const response = await upstream('/api/compress', 'POST', { json: { ...data, filename: record.filename } });
      if ([400, 401, 403, 404, 413, 422].includes(response.statusCode ?? 0)) state.release(data.job_id);
      checkStatus(response);
      const result = await readJson(response);
      if (typeof result.task_id !== 'string' || !UUID.test(result.task_id)) throw unavailable();
      state.dispatched(data.job_id, result.task_id);
      return { task_id: result.task_id };
    } catch (error) {
      if ((error as { beforeDispatch?: boolean }).beforeDispatch === true) state.release(data.job_id);
      else state.uncertain(data.job_id);
      throw error;
    }
  });
  app.get('/api/jobs/:task/status', async (request, reply) => {
    validateQuery(request.raw.url!, {});
    const task = taskFor(request);
    const response = await upstream(`/api/jobs/${task}/status`, 'GET', { signal: clientSignal(request, reply) });
    checkStatus(response);
    const data = await readJson(response);
    if (typeof data.state !== 'string' || data.state.length > 30) throw unavailable();
    if (TERMINAL.has(data.state.toUpperCase())) state.finish(task);
    return { state: data.state, progress: typeof data.progress === 'number' && Number.isFinite(data.progress) ? data.progress : null,
      detail: ['FAILURE', 'FAILED'].includes(data.state.toUpperCase()) ? 'Compression failed' : null };
  });
  app.post('/api/jobs/:task/cancel', async (request, reply) => {
    validateQuery(request.raw.url!, {});
    if (request.body !== undefined && request.body !== null) throw invalid();
    const task = taskFor(request);
    const response = await upstream(`/api/jobs/${task}/cancel`, 'POST', { signal: clientSignal(request, reply) });
    checkStatus(response); await readJson(response);
    // Acknowledgement is not proof that FFmpeg stopped. Release capacity on terminal status only.
    return { status: 'cancellation_requested' };
  });
  app.get('/api/jobs/:task/download', async (request, reply) => {
    const query = validateQuery(request.raw.url!, { wait: [0, 30] }), task = taskFor(request);
    const range = request.headers.range;
    if (range !== undefined && (typeof range !== 'string' || !/^bytes=(?:\d+-\d*|-\d+)$/.test(range))) throw invalid();
    const response = await upstream(`/api/jobs/${task}/download${query}`, 'GET', { headers: range ? { range } : {}, timeout: config.streamTimeoutMs, signal: clientSignal(request, reply) });
    checkStatus(response); state.finish(task);
    reply.code(response.statusCode!);
    for (const key of ['content-length', 'content-range', 'accept-ranges']) if (response.headers[key]) reply.header(key, response.headers[key]);
    const disposition = response.headers['content-disposition'];
    reply.header('content-type', 'application/octet-stream');
    if (typeof disposition === 'string' && disposition.length <= 2048 && !/[\r\n]/.test(disposition)) reply.header('content-disposition', disposition);
    else reply.header('content-disposition', 'attachment; filename="compressed-video.mp4"');
    return reply.send(response);
  });
  app.get('/api/stream/:task', async (request, reply) => {
    validateQuery(request.raw.url!, {});
    const task = taskFor(request), id = owner(request);
    if ((streams.get(id) ?? 0) >= config.maxStreamsPerSession) throw new PublicError(429, 'Too many progress streams');
    streams.set(id, (streams.get(id) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        const remaining = (streams.get(id) ?? 1) - 1;
        if (remaining) streams.set(id, remaining); else streams.delete(id);
      }
    };
    reply.raw.once('close', release);
    try {
      const response = await upstream(`/api/stream/${task}`, 'GET', { timeout: config.streamTimeoutMs, signal: clientSignal(request, reply) });
      checkStatus(response);
      if (!response.headers['content-type']?.startsWith('text/event-stream')) { response.destroy(); throw unavailable(); }
      reply.header('content-type', 'text/event-stream').header('x-accel-buffering', 'no');
      const filter = sseFilter(task, () => state.finish(task));
      pipeline(response, filter).catch(error => filter.destroy(error));
      return reply.send(filter);
    } catch (error) { release(); throw error; }
  });
  app.setNotFoundHandler(async () => { throw new PublicError(404, 'Not found'); });
  app.setErrorHandler((error, request, reply) => {
    const properties = error as { statusCode?: number; code?: string };
    const status = error instanceof PublicError ? error.statusCode : typeof properties.statusCode === 'number' && properties.statusCode >= 400 && properties.statusCode < 500 ? properties.statusCode : 502;
    if (status >= 500) request.log.warn({ requestId: request.id, code: properties.code ?? 'upstream_error' }, 'Gateway request failed');
    if (status === 429) reply.header('retry-after', '60');
    reply.code(status).send({ detail: error instanceof PublicError ? error.message : status === 413 ? 'Video exceeds the upload limit' : status < 500 ? 'Invalid request' : 'Compression service temporarily unavailable' });
  });
  const sweep = setInterval(async () => {
    if (sweeping) return; sweeping = true;
    try {
      state.cleanup();
      for (const task of state.activeTasks()) {
        try {
          if (sweepAbort.signal.aborted) break;
          const response = await upstream(`/api/jobs/${task}/status`, 'GET', { signal: sweepAbort.signal });
          if (response.statusCode === 404) { response.destroy(); state.finish(task); continue; }
          checkStatus(response); const data = await readJson(response);
          if (typeof data.state === 'string' && TERMINAL.has(data.state.toUpperCase())) state.finish(task);
        } catch { /* retry next sweep; an outage must not reopen dispatch capacity */ }
      }
    } finally { sweeping = false; }
  }, 30000); sweep.unref();
  app.addHook('onClose', async () => { clearInterval(sweep); sweepAbort.abort(); while (sweeping) await new Promise(resolve => setTimeout(resolve, 10)); state.close(); });
  return app;
}
