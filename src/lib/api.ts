import { env } from '$env/dynamic/public';

const RAW = (env.PUBLIC_API_URL as string | undefined) || 'https://dev-local.fits.video';
const API = RAW && RAW.trim() !== '' ? RAW.replace(/\/$/, '') : '';
const AUTH_ENABLED =
	((env.PUBLIC_API_AUTH_ENABLED as string | undefined) ?? '').trim().toLowerCase() === 'true';
const DEFAULT_API_AUTH_USER = (env.PUBLIC_API_AUTH_USER as string | undefined) ?? '';
const DEFAULT_API_AUTH_PASS = (env.PUBLIC_API_AUTH_PASS as string | undefined) ?? '';

export interface ApiAuth {
	user: string;
	pass: string;
}

export type ProgressPhase = 'encoding' | 'finalizing' | 'done';

export interface UploadResponse {
	job_id: string;
	filename: string;
}

export interface CompressRequest {
	job_id: string;
	filename: string;
	target_size_mb: number;
	audio_bitrate_kbps?: number;
	video_codec?: string;
}

export interface CompressResponse {
	task_id: string;
}

export interface JobStatusResponse {
	state: string;
	progress: number | null;
	detail: string | null;
}

// Backend SSE event shapes the UI cares about. Anything else is ignored.
export type StreamEvent =
	| { type: 'connected'; task_id: string; ts: number }
	| { type: 'ping'; ts: number }
	| {
			type: 'progress';
			task_id: string;
			progress: number;
			phase?: ProgressPhase;
			eta_seconds?: number;
			speed_x?: number;
	  }
	| { type: 'log'; task_id: string; message: string }
	| { type: 'done'; task_id: string }
	| { type: 'error'; message: string; task_id?: string }
	| { type: 'retry'; message: string; task_id?: string; overage_percent?: number }
	| { type: 'canceled'; task_id?: string };

function toApiUrl(path: string): string {
	return API ? `${API}${path}` : path;
}

function hasAuth(auth?: ApiAuth | null): auth is ApiAuth {
	return Boolean(auth?.user?.trim()) && typeof auth?.pass === 'string' && auth.pass.length > 0;
}

function buildBasicAuthHeader(auth?: ApiAuth | null): string | null {
	if (!hasAuth(auth)) return null;
	return `Basic ${btoa(`${auth.user}:${auth.pass}`)}`;
}

function withAuthHeaders(auth?: ApiAuth | null, headers?: HeadersInit): Headers {
	const result = new Headers(headers);
	const authorization = buildBasicAuthHeader(auth);
	if (authorization) result.set('Authorization', authorization);
	return result;
}

async function readApiError(response: Response): Promise<string> {
	if (response.status === 401) {
		return 'API authentication failed. Check the backend username and password.';
	}

	let text = '';
	try {
		text = await response.text();
	} catch {
		// no body
	}

	if (!text) return `HTTP ${response.status}`;

	try {
		const parsed = JSON.parse(text);
		const detail = parsed?.detail;
		if (typeof detail === 'string') return detail;
		if (detail?.error === 'file_not_ready') {
			return 'The output file is still finalizing. Please retry in a moment.';
		}
		if (typeof detail?.detail === 'string') return detail.detail;
		if (typeof detail?.message === 'string') return detail.message;
	} catch {
		// fall through to raw text
	}

	return text;
}

function filenameFromDisposition(disposition: string | null): string | null {
	if (!disposition) return null;
	const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
	if (utf8Match?.[1]) return decodeURIComponent(utf8Match[1]);
	const plainMatch = disposition.match(/filename="?([^"]+)"?/i);
	return plainMatch?.[1] ?? null;
}

export function getDefaultApiAuth(): ApiAuth | null {
	if (!AUTH_ENABLED) return null;
	return { user: DEFAULT_API_AUTH_USER, pass: DEFAULT_API_AUTH_PASS };
}

// Best-effort decoder for SSE payloads. Returns null on malformed JSON or a
// missing `type` field; the caller filters unknown event types itself.
export function parseStreamEvent(raw: string): StreamEvent | null {
	try {
		const data = JSON.parse(raw);
		if (data && typeof data === 'object' && typeof data.type === 'string') {
			return data as StreamEvent;
		}
	} catch {
		// not JSON
	}
	return null;
}

export function uploadFile(
	file: File,
	targetSizeMB: number,
	audioKbps = 128,
	onProgress?: (percent: number) => void,
	auth?: ApiAuth | null
): { promise: Promise<UploadResponse>; abort: () => void } {
	const xhr = new XMLHttpRequest();

	const promise = new Promise<UploadResponse>((resolve, reject) => {
		const fd = new FormData();
		fd.append('file', file);

		// FastAPI's /api/upload reads target_size_mb / audio_bitrate_kbps as
		// query params (no Form(...) on the backend signature), so the values
		// have to ride in the URL, not the form body.
		const params = new URLSearchParams({
			target_size_mb: String(targetSizeMB),
			audio_bitrate_kbps: String(audioKbps)
		});

		xhr.open('POST', toApiUrl(`/api/upload?${params.toString()}`));

		const authorization = buildBasicAuthHeader(auth);
		if (authorization) xhr.setRequestHeader('Authorization', authorization);

		xhr.upload.onprogress = (e) => {
			if (e.lengthComputable && onProgress) {
				const pct = Math.max(0, Math.min(100, Math.round((e.loaded / e.total) * 100)));
				onProgress(pct);
			}
		};

		xhr.onload = () => {
			if (xhr.status >= 200 && xhr.status < 300) {
				try {
					resolve(JSON.parse(xhr.responseText || '{}') as UploadResponse);
				} catch (err) {
					reject(err);
				}
			} else if (xhr.status === 401) {
				reject(new Error('API authentication failed. Check the backend username and password.'));
			} else {
				reject(new Error(xhr.responseText || `HTTP ${xhr.status}`));
			}
		};

		xhr.onerror = () => reject(new Error('Network error'));
		xhr.onabort = () => reject(new Error('Upload cancelled'));
		xhr.send(fd);
	});

	return { promise, abort: () => xhr.abort() };
}

export async function startCompress(
	payload: CompressRequest,
	auth?: ApiAuth | null
): Promise<CompressResponse> {
	const res = await fetch(toApiUrl('/api/compress'), {
		method: 'POST',
		headers: withAuthHeaders(auth, { 'Content-Type': 'application/json' }),
		body: JSON.stringify(payload)
	});

	if (!res.ok) throw new Error(await readApiError(res));

	return (await res.json()) as CompressResponse;
}

export async function getJobStatus(
	taskId: string,
	auth?: ApiAuth | null
): Promise<JobStatusResponse> {
	const res = await fetch(toApiUrl(`/api/jobs/${encodeURIComponent(taskId)}/status`), {
		headers: withAuthHeaders(auth)
	});

	if (!res.ok) throw new Error(await readApiError(res));

	return (await res.json()) as JobStatusResponse;
}

export function openProgressStream(taskId: string): EventSource {
	return new EventSource(toApiUrl(`/api/stream/${encodeURIComponent(taskId)}`));
}

export async function cancelJob(taskId: string, auth?: ApiAuth | null): Promise<void> {
	const res = await fetch(toApiUrl(`/api/jobs/${encodeURIComponent(taskId)}/cancel`), {
		method: 'POST',
		headers: withAuthHeaders(auth)
	});

	if (!res.ok) throw new Error(await readApiError(res));
}

export async function downloadCompletedFile(
	taskId: string,
	suggestedFilename: string,
	auth?: ApiAuth | null,
	waitSeconds = 5
): Promise<void> {
	const downloadUrl = new URL(
		toApiUrl(`/api/jobs/${encodeURIComponent(taskId)}/download`),
		window.location.href
	);
	downloadUrl.searchParams.set('wait', String(waitSeconds));

	const res = await fetch(downloadUrl.toString(), { headers: withAuthHeaders(auth) });
	if (!res.ok) throw new Error(await readApiError(res));

	const blob = await res.blob();
	const blobUrl = URL.createObjectURL(blob);
	const filename =
		filenameFromDisposition(res.headers.get('Content-Disposition')) || suggestedFilename;

	const anchor = document.createElement('a');
	anchor.href = blobUrl;
	anchor.download = filename;
	document.body.appendChild(anchor);
	anchor.click();
	document.body.removeChild(anchor);

	window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}
