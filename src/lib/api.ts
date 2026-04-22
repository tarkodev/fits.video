import { env } from '$env/dynamic/public';

const RAW = (env.PUBLIC_API_URL as string | undefined) || 'https://dev-local.fits.video';
const API = RAW && RAW.trim() !== '' ? RAW.replace(/\/$/, '') : '';
const DEFAULT_API_AUTH_USER = (env.PUBLIC_API_AUTH_USER as string | undefined) || 'admin';
const DEFAULT_API_AUTH_PASS = (env.PUBLIC_API_AUTH_PASS as string | undefined) || 'changeme';

export interface ApiAuth {
	user: string;
	pass: string;
}

export interface UploadResponse {
	job_id: string;
	filename: string;
	duration_s: number;
	original_video_bitrate_kbps?: number | null;
	original_audio_bitrate_kbps?: number | null;
	original_width?: number | null;
	original_height?: number | null;
	original_video_fps?: number | null;
	estimate_total_kbps: number;
	estimate_video_kbps: number;
	warn_low_quality: boolean;
}

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

	if (authorization) {
		result.set('Authorization', authorization);
	}

	return result;
}

async function readApiError(response: Response): Promise<string> {
	let text = '';

	try {
		text = await response.text();
	} catch {
		text = '';
	}

	if (response.status === 401) {
		return 'API authentication failed. Check the backend username and password.';
	}

	if (!text) {
		return `HTTP ${response.status}`;
	}

	try {
		const parsed = JSON.parse(text);
		const detail = parsed?.detail;

		if (typeof detail === 'string') {
			return detail;
		}

		if (detail?.error === 'file_not_ready') {
			return 'The output file is still finalizing. Please retry in a moment.';
		}

		if (typeof detail?.detail === 'string') {
			return detail.detail;
		}

		if (typeof detail?.message === 'string') {
			return detail.message;
		}
	} catch {
		// Fall back to the raw response body below.
	}

	return text;
}

function filenameFromDisposition(disposition: string | null): string | null {
	if (!disposition) return null;

	const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
	if (utf8Match?.[1]) {
		return decodeURIComponent(utf8Match[1]);
	}

	const plainMatch = disposition.match(/filename="?([^"]+)"?/i);
	return plainMatch?.[1] ?? null;
}

export function getDefaultApiAuth(): ApiAuth {
	return {
		user: DEFAULT_API_AUTH_USER,
		pass: DEFAULT_API_AUTH_PASS
	};
}

// Upload file to the API - returns promise and abort function
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
		fd.append('target_size_mb', String(targetSizeMB));
		fd.append('audio_bitrate_kbps', String(audioKbps));

		xhr.open('POST', toApiUrl('/api/upload'));

		const authorization = buildBasicAuthHeader(auth);
		if (authorization) {
			xhr.setRequestHeader('Authorization', authorization);
		}

		xhr.upload.onprogress = (e) => {
			if (e.lengthComputable && onProgress) {
				const pct = Math.max(0, Math.min(100, Math.round((e.loaded / e.total) * 100)));
				onProgress(pct);
			}
		};

		xhr.onload = () => {
			try {
				if (xhr.status >= 200 && xhr.status < 300) {
					resolve(JSON.parse(xhr.responseText || '{}'));
				} else if (xhr.status === 401) {
					reject(new Error('API authentication failed. Check the backend username and password.'));
				} else {
					reject(new Error(xhr.responseText || `HTTP ${xhr.status}`));
				}
			} catch (err) {
				reject(err);
			}
		};

		xhr.onerror = () => reject(new Error('Network error'));
		xhr.onabort = () => reject(new Error('Upload cancelled'));
		xhr.send(fd);
	});

	return { promise, abort: () => xhr.abort() };
}

// Start compression job
export async function startCompress(
	payload: {
		job_id: string;
		filename: string;
		target_size_mb: number;
		audio_bitrate_kbps?: number;
		video_codec?: string;
	},
	auth?: ApiAuth | null
): Promise<{ task_id: string }> {
	const res = await fetch(toApiUrl('/api/compress'), {
		method: 'POST',
		headers: withAuthHeaders(auth, { 'Content-Type': 'application/json' }),
		body: JSON.stringify(payload)
	});

	if (!res.ok) {
		throw new Error(await readApiError(res));
	}

	return res.json();
}

export async function getJobStatus(
	taskId: string,
	auth?: ApiAuth | null
): Promise<{
	state: string;
	progress?: number | null;
	detail?: string | null;
}> {
	const res = await fetch(toApiUrl(`/api/jobs/${encodeURIComponent(taskId)}/status`), {
		headers: withAuthHeaders(auth)
	});

	if (!res.ok) {
		throw new Error(await readApiError(res));
	}

	return res.json();
}

// Open SSE stream for progress
export function openProgressStream(taskId: string): EventSource {
	return new EventSource(toApiUrl(`/api/stream/${encodeURIComponent(taskId)}`));
}

// Cancel a job
export async function cancelJob(taskId: string, auth?: ApiAuth | null): Promise<void> {
	const res = await fetch(toApiUrl(`/api/jobs/${encodeURIComponent(taskId)}/cancel`), {
		method: 'POST',
		headers: withAuthHeaders(auth)
	});

	if (!res.ok) {
		throw new Error(await readApiError(res));
	}
}

// Download a completed job and trigger a browser download.
export async function downloadCompletedFile(
	taskId: string,
	suggestedFilename: string,
	auth?: ApiAuth | null,
	waitSeconds = 5
): Promise<void> {
	const downloadUrl = new URL(toApiUrl(`/api/jobs/${encodeURIComponent(taskId)}/download`), window.location.href);
	downloadUrl.searchParams.set('wait', String(waitSeconds));

	const res = await fetch(downloadUrl.toString(), {
		headers: withAuthHeaders(auth)
	});

	if (!res.ok) {
		throw new Error(await readApiError(res));
	}

	const blob = await res.blob();
	const blobUrl = URL.createObjectURL(blob);
	const filename = filenameFromDisposition(res.headers.get('Content-Disposition')) || suggestedFilename;
	const anchor = document.createElement('a');

	anchor.href = blobUrl;
	anchor.download = filename;
	document.body.appendChild(anchor);
	anchor.click();
	document.body.removeChild(anchor);

	window.setTimeout(() => {
		URL.revokeObjectURL(blobUrl);
	}, 1000);
}

// Get available codecs from server
export async function getCodecs(
	auth?: ApiAuth | null
): Promise<{
	hardware_type: string;
	available_encoders: Record<string, string>;
	enabled_codecs: string[];
}> {
	const res = await fetch(toApiUrl('/api/codecs/available'), {
		headers: withAuthHeaders(auth)
	});

	if (!res.ok) {
		throw new Error(await readApiError(res));
	}

	return res.json();
}

// Get API version
export async function getVersion(auth?: ApiAuth | null): Promise<{ version: string }> {
	const res = await fetch(toApiUrl('/api/version'), {
		headers: withAuthHeaders(auth)
	});

	if (!res.ok) {
		throw new Error(await readApiError(res));
	}

	return res.json();
}
