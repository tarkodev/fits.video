import { env } from '$env/dynamic/public';

const RAW = (env.PUBLIC_API_URL as string | undefined) || 'https://dev-local.fits.video';
const API = RAW && RAW.trim() !== '' ? RAW.replace(/\/$/, '') : '';
const DEFAULT_API_AUTH_USER = (env.PUBLIC_API_AUTH_USER as string | undefined) || 'admin';
const DEFAULT_API_AUTH_PASS = (env.PUBLIC_API_AUTH_PASS as string | undefined) || 'changeme';

export interface ApiAuth {
	user: string;
	pass: string;
}

export type VideoCodec =
	| 'av1_nvenc'
	| 'hevc_nvenc'
	| 'h264_nvenc'
	| 'libx264'
	| 'libx265'
	| 'libsvtav1'
	| 'libaom-av1';

export type AudioCodec = 'libopus' | 'aac' | 'none';
export type EncoderPreset = 'p1' | 'p2' | 'p3' | 'p4' | 'p5' | 'p6' | 'p7' | 'extraquality';
export type OutputContainer = 'mp4' | 'mkv';
export type NvencTune = 'hq' | 'll' | 'ull' | 'lossless';
export type ProgressPhase = 'encoding' | 'finalizing' | 'done';

export interface UploadResponse {
	job_id: string;
	filename: string;
	duration_s: number;
	original_video_bitrate_kbps: number | null;
	original_audio_bitrate_kbps: number | null;
	original_width: number | null;
	original_height: number | null;
	original_video_fps: number | null;
	estimate_total_kbps: number;
	estimate_video_kbps: number;
	warn_low_quality: boolean;
}

export interface CompressRequest {
	job_id: string;
	filename: string;
	target_size_mb: number;
	target_video_bitrate_kbps?: number | null;
	video_codec?: VideoCodec;
	audio_codec?: AudioCodec;
	audio_bitrate_kbps?: number;
	preset?: EncoderPreset;
	container?: OutputContainer;
	tune?: NvencTune;
	max_width?: number | null;
	max_height?: number | null;
	start_time?: string | null;
	end_time?: string | null;
	force_hw_decode?: boolean;
	fast_mp4_finalize?: boolean;
	auto_resolution?: boolean;
	min_auto_resolution?: number | null;
	target_resolution?: number | null;
	audio_only?: boolean;
	max_output_fps?: number | null;
}

export interface CompressResponse {
	task_id: string;
}

export interface JobStatusResponse {
	state: string;
	progress: number | null;
	detail: string | null;
}

export interface CompressionStats {
	input_path: string;
	output_path: string;
	duration_s: number;
	target_size_mb: number;
	final_size_mb: number;
}

// Mirrors backend-api/app/models.py::ProgressEvent.
export interface BackendProgressEvent {
	type: 'progress' | 'log' | 'done' | 'error';
	task_id: string;
	progress: number | null;
	message: string | null;
	stats: Record<string, unknown> | null;
	download_url: string | null;
}

export interface StreamConnectedEvent {
	type: 'connected';
	task_id: string;
	ts: number;
}

export interface StreamPingEvent {
	type: 'ping';
	ts: number;
}

export interface StreamProgressEvent {
	type: 'progress';
	task_id: string;
	progress: number;
	phase?: ProgressPhase;
	eta_seconds?: number;
	speed_x?: number;
}

export interface StreamLogEvent {
	type: 'log';
	task_id: string;
	message: string;
}

export interface StreamDoneEvent {
	type: 'done';
	task_id: string;
	stats: CompressionStats;
}

export interface StreamErrorEvent {
	type: 'error';
	message: string;
	task_id?: string;
}

export interface StreamRetryEvent {
	type: 'retry';
	message: string;
	task_id?: string;
	overage_percent?: number;
}

export interface StreamCanceledEvent {
	type: 'canceled';
	task_id?: string;
}

export type StreamEvent =
	| StreamConnectedEvent
	| StreamPingEvent
	| StreamProgressEvent
	| StreamLogEvent
	| StreamDoneEvent
	| StreamErrorEvent
	| StreamRetryEvent
	| StreamCanceledEvent;

export interface AvailableCodecsResponse {
	hardware_type: string;
	available_encoders: Record<string, string>;
	enabled_codecs: string[];
}

function toApiUrl(path: string): string {
	return API ? `${API}${path}` : path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function readString(value: unknown, field: string): string {
	if (typeof value !== 'string') {
		throw new Error(`Invalid API response: expected "${field}" to be a string`);
	}
	return value;
}

function readNumber(value: unknown, field: string): number {
	if (typeof value !== 'number' || Number.isNaN(value)) {
		throw new Error(`Invalid API response: expected "${field}" to be a number`);
	}
	return value;
}

function readBoolean(value: unknown, field: string): boolean {
	if (typeof value !== 'boolean') {
		throw new Error(`Invalid API response: expected "${field}" to be a boolean`);
	}
	return value;
}

function readNullableNumber(value: unknown): number | null {
	if (value == null) return null;
	return readNumber(value, 'nullable_number');
}

function readNullableString(value: unknown): string | null {
	if (value == null) return null;
	return readString(value, 'nullable_string');
}

function parseUploadResponse(raw: string): UploadResponse {
	const parsed: unknown = JSON.parse(raw || '{}');
	if (!isRecord(parsed)) {
		throw new Error('Invalid API response: expected an upload payload object');
	}

	return {
		job_id: readString(parsed.job_id, 'job_id'),
		filename: readString(parsed.filename, 'filename'),
		duration_s: readNumber(parsed.duration_s, 'duration_s'),
		original_video_bitrate_kbps: readNullableNumber(parsed.original_video_bitrate_kbps),
		original_audio_bitrate_kbps: readNullableNumber(parsed.original_audio_bitrate_kbps),
		original_width: readNullableNumber(parsed.original_width),
		original_height: readNullableNumber(parsed.original_height),
		original_video_fps: readNullableNumber(parsed.original_video_fps),
		estimate_total_kbps: readNumber(parsed.estimate_total_kbps, 'estimate_total_kbps'),
		estimate_video_kbps: readNumber(parsed.estimate_video_kbps, 'estimate_video_kbps'),
		warn_low_quality: readBoolean(parsed.warn_low_quality, 'warn_low_quality')
	};
}

function parseCompressResponse(value: unknown): CompressResponse {
	if (!isRecord(value)) {
		throw new Error('Invalid API response: expected a compression payload object');
	}

	return {
		task_id: readString(value.task_id, 'task_id')
	};
}

function parseJobStatusResponse(value: unknown): JobStatusResponse {
	if (!isRecord(value)) {
		throw new Error('Invalid API response: expected a job-status payload object');
	}

	return {
		state: readString(value.state, 'state'),
		progress: readNullableNumber(value.progress),
		detail: readNullableString(value.detail)
	};
}

function parseCompressionStats(value: unknown): CompressionStats {
	if (!isRecord(value)) {
		throw new Error('Invalid API response: expected a compression stats object');
	}

	return {
		input_path: readString(value.input_path, 'input_path'),
		output_path: readString(value.output_path, 'output_path'),
		duration_s: readNumber(value.duration_s, 'duration_s'),
		target_size_mb: readNumber(value.target_size_mb, 'target_size_mb'),
		final_size_mb: readNumber(value.final_size_mb, 'final_size_mb')
	};
}

function parseAvailableCodecsResponse(value: unknown): AvailableCodecsResponse {
	if (!isRecord(value)) {
		throw new Error('Invalid API response: expected an available-codecs payload object');
	}

	const availableEncoders = value.available_encoders;
	const enabledCodecs = value.enabled_codecs;

	if (!isRecord(availableEncoders)) {
		throw new Error('Invalid API response: expected "available_encoders" to be an object');
	}

	if (!Array.isArray(enabledCodecs) || enabledCodecs.some((codec) => typeof codec !== 'string')) {
		throw new Error('Invalid API response: expected "enabled_codecs" to be a string array');
	}

	return {
		hardware_type: readString(value.hardware_type, 'hardware_type'),
		available_encoders: Object.fromEntries(
			Object.entries(availableEncoders).map(([key, encoder]) => [key, readString(encoder, `available_encoders.${key}`)])
		),
		enabled_codecs: enabledCodecs
	};
}

export function parseStreamEvent(raw: string): StreamEvent | null {
	let parsed: unknown;

	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}

	if (!isRecord(parsed) || typeof parsed.type !== 'string') {
		return null;
	}

	switch (parsed.type) {
		case 'connected':
			if (typeof parsed.task_id !== 'string' || typeof parsed.ts !== 'number') return null;
			return { type: 'connected', task_id: parsed.task_id, ts: parsed.ts };
		case 'ping':
			if (typeof parsed.ts !== 'number') return null;
			return { type: 'ping', ts: parsed.ts };
		case 'progress': {
			if (typeof parsed.task_id !== 'string' || typeof parsed.progress !== 'number') return null;
			const event: StreamProgressEvent = {
				type: 'progress',
				task_id: parsed.task_id,
				progress: parsed.progress
			};
			if (parsed.phase === 'encoding' || parsed.phase === 'finalizing' || parsed.phase === 'done') {
				event.phase = parsed.phase;
			}
			if (typeof parsed.eta_seconds === 'number') event.eta_seconds = parsed.eta_seconds;
			if (typeof parsed.speed_x === 'number') event.speed_x = parsed.speed_x;
			return event;
		}
		case 'log':
			if (typeof parsed.task_id !== 'string' || typeof parsed.message !== 'string') return null;
			return { type: 'log', task_id: parsed.task_id, message: parsed.message };
		case 'done':
			if (typeof parsed.task_id !== 'string') return null;
			try {
				return {
					type: 'done',
					task_id: parsed.task_id,
					stats: parseCompressionStats(parsed.stats)
				};
			} catch {
				return null;
			}
		case 'error':
			if (typeof parsed.message !== 'string') return null;
			return {
				type: 'error',
				message: parsed.message,
				task_id: typeof parsed.task_id === 'string' ? parsed.task_id : undefined
			};
		case 'retry':
			if (typeof parsed.message !== 'string') return null;
			return {
				type: 'retry',
				message: parsed.message,
				task_id: typeof parsed.task_id === 'string' ? parsed.task_id : undefined,
				overage_percent: typeof parsed.overage_percent === 'number' ? parsed.overage_percent : undefined
			};
		case 'canceled':
			return {
				type: 'canceled',
				task_id: typeof parsed.task_id === 'string' ? parsed.task_id : undefined
			};
		default:
			return null;
	}
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
						resolve(parseUploadResponse(xhr.responseText || '{}'));
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
	payload: CompressRequest,
	auth?: ApiAuth | null
): Promise<CompressResponse> {
	const res = await fetch(toApiUrl('/api/compress'), {
		method: 'POST',
		headers: withAuthHeaders(auth, { 'Content-Type': 'application/json' }),
		body: JSON.stringify(payload)
	});

	if (!res.ok) {
		throw new Error(await readApiError(res));
	}

	return parseCompressResponse(await res.json());
}

export async function getJobStatus(
	taskId: string,
	auth?: ApiAuth | null
): Promise<JobStatusResponse> {
	const res = await fetch(toApiUrl(`/api/jobs/${encodeURIComponent(taskId)}/status`), {
		headers: withAuthHeaders(auth)
	});

	if (!res.ok) {
		throw new Error(await readApiError(res));
	}

	return parseJobStatusResponse(await res.json());
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
): Promise<AvailableCodecsResponse> {
	const res = await fetch(toApiUrl('/api/codecs/available'), {
		headers: withAuthHeaders(auth)
	});

	if (!res.ok) {
		throw new Error(await readApiError(res));
	}

	return parseAvailableCodecsResponse(await res.json());
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
