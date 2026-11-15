import { PUBLIC_API_URL } from '$env/static/public';

function requiredPublicEnv(name: string, value: string): string {
	const trimmed = value.trim();
	if (!trimmed) {
		throw new Error(`Missing required public env var ${name}`);
	}
	return trimmed;
}

const API = requiredPublicEnv('PUBLIC_API_URL', PUBLIC_API_URL).replace(/\/$/, '');

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

async function readApiError(response: Response): Promise<string> {
	if (response.status === 401) {
		return 'Your upload session expired. Please select the file again.';
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
		if (typeof parsed?.message === 'string') return parsed.message;
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

let sessionRequest: Promise<void> | null = null;

function ensureSession(): Promise<void> {
	if (!sessionRequest) {
		sessionRequest = (async () => {
			const response = await fetch(toApiUrl('/api/session'), {
				credentials: 'same-origin',
				cache: 'no-store'
			});
			if (!response.ok) throw new Error(await readApiError(response));
		})().finally(() => {
			sessionRequest = null;
		});
	}
	return sessionRequest;
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
	onProgress?: (percent: number) => void
): { promise: Promise<UploadResponse>; abort: () => void } {
	const xhr = new XMLHttpRequest();
	let aborted = false;
	let rejectUpload: (error: Error) => void;

	const promise = new Promise<UploadResponse>((resolve, reject) => {
		rejectUpload = reject;
		void ensureSession().then(() => {
		if (aborted) return;
		const fd = new FormData();
		fd.append('file', file);
		fd.append('target_size_mb', String(targetSizeMB));
		fd.append('audio_bitrate_kbps', String(audioKbps));

		// Send form fields for 8mb.local142+ and retain query params for137.
		const params = new URLSearchParams({
			target_size_mb: String(targetSizeMB),
			audio_bitrate_kbps: String(audioKbps)
		});

		xhr.open('POST', toApiUrl(`/api/upload?${params.toString()}`));
		xhr.withCredentials = true;

		xhr.upload.onprogress = (e) => {
			if (e.lengthComputable && onProgress) {
				const pct = Math.max(0, Math.min(100, Math.round((e.loaded / e.total) * 100)));
				onProgress(pct);
			}
		};

		xhr.onload = async () => {
			if (xhr.status >= 200 && xhr.status < 300) {
				try {
					resolve(JSON.parse(xhr.responseText || '{}') as UploadResponse);
				} catch (err) {
					reject(err);
				}
			} else {
				const response = new Response(xhr.responseText, { status: xhr.status });
				reject(new Error(await readApiError(response)));
			}
		};

		xhr.onerror = () => reject(new Error('Network error'));
		xhr.onabort = () => reject(new Error('Upload cancelled'));
		xhr.send(fd);
		}).catch(reject);
	});

	return {
		promise,
		abort: () => {
			if (aborted) return;
			aborted = true;
			xhr.abort();
			rejectUpload(new Error('Upload cancelled'));
		}
	};
}

export async function startCompress(
	payload: CompressRequest
): Promise<CompressResponse> {
	const res = await fetch(toApiUrl('/api/compress'), {
		method: 'POST',
		credentials: 'same-origin',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload)
	});

	if (!res.ok) throw new Error(await readApiError(res));

	return (await res.json()) as CompressResponse;
}

export async function getJobStatus(
	taskId: string
): Promise<JobStatusResponse> {
	const res = await fetch(toApiUrl(`/api/jobs/${encodeURIComponent(taskId)}/status`), {
		credentials: 'same-origin'
	});

	if (!res.ok) throw new Error(await readApiError(res));

	return (await res.json()) as JobStatusResponse;
}

export function openProgressStream(taskId: string): EventSource {
	return new EventSource(toApiUrl(`/api/stream/${encodeURIComponent(taskId)}`));
}

export async function cancelJob(taskId: string): Promise<void> {
	const res = await fetch(toApiUrl(`/api/jobs/${encodeURIComponent(taskId)}/cancel`), {
		method: 'POST',
		credentials: 'same-origin'
	});

	if (!res.ok) throw new Error(await readApiError(res));
}

export async function downloadCompletedFile(
	taskId: string,
	suggestedFilename: string,
	waitSeconds = 5
): Promise<void> {
	const downloadUrl = new URL(
		toApiUrl(`/api/jobs/${encodeURIComponent(taskId)}/download`),
		window.location.href
	);
	downloadUrl.searchParams.set('wait', String(waitSeconds));

	const res = await fetch(downloadUrl.toString(), { credentials: 'same-origin' });
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
