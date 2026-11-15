export interface Config {
  publicOrigin: string;
  upstreamUrl: string;
  upstreamAuthorization?: string;
  statePath: string;
  port: number;
  trustProxy: false | string[];
  sessionSeconds: number;
  recordSeconds: number;
  maxUploadBytes: number;
  maxUploads: number;
  maxUploadsPerSession: number;
  maxActiveJobs: number;
  maxJobsPerSession: number;
  maxRecords: number;
  maxRequestsPerMinute: number;
  maxSessionsPerHour: number;
  maxStreamsPerSession: number;
  upstreamTimeoutMs: number;
  uploadTimeoutMs: number;
  streamTimeoutMs: number;
  maxTargetMb: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  function required(name: string): string {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Missing required environment variable ${name}`);
    return value;
  }
  function number(name: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER) {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isFinite(value) || value < min || value > max || !Number.isInteger(value)) {
      throw new Error(`Invalid environment variable ${name}`);
    }
    return value;
  }
  const origin = new URL(required('GATEWAY_PUBLIC_ORIGIN'));
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('GATEWAY_PUBLIC_ORIGIN must be an HTTPS origin');
  }
  const upstream = new URL(required('GATEWAY_UPSTREAM_URL'));
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.pathname !== '/' || upstream.search || upstream.hash) {
    throw new Error('GATEWAY_UPSTREAM_URL must be a fixed HTTP(S) origin without credentials or paths');
  }
  const enabled = required('GATEWAY_UPSTREAM_AUTH_ENABLED');
  if (!['true', 'false'].includes(enabled)) throw new Error('GATEWAY_UPSTREAM_AUTH_ENABLED must be true or false');
  const user = enabled === 'true' ? required('GATEWAY_UPSTREAM_AUTH_USER') : '';
  const pass = enabled === 'true' ? required('GATEWAY_UPSTREAM_AUTH_PASS') : '';
  if (user.includes(':') || /[\r\n]/.test(user + pass)) throw new Error('Invalid upstream credentials');
  const sessionSeconds = number('GATEWAY_SESSION_SECONDS', 604800, 3600);
  const recordSeconds = number('GATEWAY_RECORD_SECONDS', 172800, 3600, sessionSeconds);
  return {
    publicOrigin: origin.origin, upstreamUrl: upstream.origin,
    upstreamAuthorization: enabled === 'true' ? `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` : undefined,
    statePath: required('GATEWAY_STATE_PATH'), port: number('GATEWAY_PORT', 3000, 1, 65535),
    trustProxy: env.GATEWAY_TRUST_PROXY?.trim() ? env.GATEWAY_TRUST_PROXY.split(',').map(v => v.trim()) : false,
    sessionSeconds, recordSeconds,
    maxUploadBytes: number('GATEWAY_MAX_UPLOAD_BYTES', 2147483648, 1024),
    maxUploads: number('GATEWAY_MAX_UPLOADS', 8), maxUploadsPerSession: number('GATEWAY_MAX_UPLOADS_PER_SESSION', 2),
    maxActiveJobs: number('GATEWAY_MAX_ACTIVE_JOBS', 32), maxJobsPerSession: number('GATEWAY_MAX_JOBS_PER_SESSION', 3),
    maxRecords: number('GATEWAY_MAX_RECORDS', 10000),
    maxRequestsPerMinute: number('GATEWAY_REQUESTS_PER_MINUTE', 240),
    maxSessionsPerHour: number('GATEWAY_SESSIONS_PER_IP_HOUR', 30),
    maxStreamsPerSession: number('GATEWAY_STREAMS_PER_SESSION', 6),
    upstreamTimeoutMs: number('GATEWAY_UPSTREAM_TIMEOUT_MS', 30000, 1000),
    uploadTimeoutMs: number('GATEWAY_UPLOAD_TIMEOUT_MS', 1800000, 1000),
    streamTimeoutMs: number('GATEWAY_STREAM_TIMEOUT_MS', 7200000, 1000),
    maxTargetMb: number('GATEWAY_MAX_TARGET_MB', 2048, 1, 51200)
  };
}
