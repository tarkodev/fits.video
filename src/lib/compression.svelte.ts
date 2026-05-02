import {
	cancelJob,
	downloadCompletedFile,
	getJobStatus,
	openProgressStream,
	parseStreamEvent,
	startCompress,
	uploadFile,
	type ApiAuth
} from './api';
import { buildDownloadFilename, formatEta } from './format';

export type CompressionStatus = 'idle' | 'uploading' | 'compressing' | 'done' | 'error';

export interface StartOptions {
	file: File;
	targetSizeMb: number;
	audioBitrateKbps?: number;
	videoCodec?: string;
	auth?: ApiAuth | null;
}

interface TelemetryUpdate {
	phase?: string | null;
	etaSeconds?: number | null;
	speedX?: number | null;
}

/**
 * Drives one upload → compress → download cycle and exposes the reactive
 * state needed to render progress in the UI. A single instance is meant
 * to be reused across runs: each call to `start()` invalidates the
 * previous one (any in-flight upload is aborted, the SSE/polling
 * watchers are torn down, and an outstanding task gets a best-effort
 * cancel sent to the backend).
 */
export class CompressionJob {
	status = $state<CompressionStatus>('idle');
	errorMessage = $state('');
	uploadProgress = $state(0);
	compressProgress = $state(0);
	isFinalizing = $state(false);

	displayedProgress = $derived(this.compressProgress);

	compressionSummary = $derived.by(() => {
		const parts: string[] = [];
		if (this.finalizingRunToken !== null || this.isFinalizing || this.displayedProgress >= 99) {
			parts.push('Almost fits the video!');
		} else {
			if (this.etaLabel) parts.push(`~${this.etaLabel}`);
			if (this.currentSpeedX !== null) parts.push(`${this.currentSpeedX.toFixed(2)}x`);
		}
		parts.push(`${Math.ceil(this.displayedProgress)}%`);
		return parts.join(' • ');
	});

	private etaLabel = $state<string | null>(null);
	private currentSpeedX = $state<number | null>(null);
	private taskId: string | null = null;
	private eventSource: EventSource | null = null;
	private statusPollTimer: number | null = null;
	private uploadAbort: (() => void) | null = null;
	private activeRunToken = 0;
	private finalizingRunToken = $state<number | null>(null);
	private statusPollFailures = 0;
	private currentAuth: ApiAuth | null = null;

	async start(opts: StartOptions): Promise<void> {
		const auth = opts.auth ?? null;
		const audioKbps = opts.audioBitrateKbps ?? 128;
		const codec = opts.videoCodec ?? 'libx264';

		const runToken = ++this.activeRunToken;
		this.finalizingRunToken = null;
		this.statusPollFailures = 0;
		this.resetTelemetry();
		this.currentAuth = auth;

		try {
			this.status = 'uploading';
			this.uploadProgress = 0;
			this.errorMessage = '';

			// 5% safety margin to absorb MB/MiB rounding on the backend.
			const safeSize = opts.targetSizeMb * 0.95;
			const { promise, abort } = uploadFile(
				opts.file,
				safeSize,
				audioKbps,
				(pct) => {
					if (runToken !== this.activeRunToken) return;
					this.uploadProgress = pct;
				},
				auth
			);
			this.uploadAbort = abort;
			const uploadResp = await promise;
			if (runToken !== this.activeRunToken) return;
			this.uploadAbort = null;

			const jobId = uploadResp.job_id;
			const serverFilename = uploadResp.filename || opts.file.name;

			if (!jobId) {
				this.fail('Upload failed - no job ID', runToken);
				return;
			}

			this.status = 'compressing';

			const compressResp = await startCompress(
				{
					job_id: jobId,
					filename: serverFilename,
					target_size_mb: opts.targetSizeMb,
					audio_bitrate_kbps: audioKbps,
					video_codec: codec
				},
				auth
			);
			if (runToken !== this.activeRunToken) return;

			this.taskId = compressResp.task_id;
			if (!this.taskId) {
				this.fail('Compression failed to start', runToken);
				return;
			}

			const activeTaskId = this.taskId;
			const suggestedFilename = buildDownloadFilename(opts.file.name || serverFilename);

			// SSE is the primary channel; polling only kicks in if it dies.
			const es = openProgressStream(activeTaskId);
			this.eventSource = es;

			es.onmessage = (event) => {
				if (runToken !== this.activeRunToken) return;

				const data = parseStreamEvent(event.data);
				if (!data) return;

				this.statusPollFailures = 0;

				switch (data.type) {
					case 'ping':
					case 'connected':
					case 'log':
						return;
					case 'progress':
						this.updateTelemetry(data.progress, {
							phase: data.phase ?? null,
							etaSeconds: data.eta_seconds ?? null,
							speedX: data.speed_x ?? null
						});
						if (data.phase === 'done' || data.progress >= 100) {
							void this.finalizeDownload(activeTaskId, suggestedFilename, auth, runToken);
						}
						return;
					case 'retry':
						this.compressProgress = 1;
						this.isFinalizing = false;
						this.etaLabel = null;
						this.currentSpeedX = null;
						return;
					case 'canceled':
						this.fail('Compression cancelled', runToken);
						return;
					case 'done':
						this.updateTelemetry(100, { phase: 'done' });
						void this.finalizeDownload(activeTaskId, suggestedFilename, auth, runToken);
						return;
					case 'error':
						this.status = 'error';
						this.errorMessage = data.message || 'Compression failed';
						es.close();
						this.eventSource = null;
						return;
				}
			};

			es.onerror = () => {
				if (this.eventSource !== es) return;
				es.close();
				this.eventSource = null;
				this.startStatusPolling(activeTaskId, serverFilename, auth, runToken);
			};
		} catch (err) {
			if (err instanceof Error && err.message === 'Upload cancelled') return;
			if (runToken !== this.activeRunToken) return;
			this.status = 'error';
			this.errorMessage = err instanceof Error && err.message ? err.message : 'Something went wrong';
		}
	}

	/**
	 * Reset the job back to `idle`, aborting any in-flight upload, closing
	 * the SSE stream / polling fallback and best-effort cancelling the
	 * backend task. Safe to call from any state.
	 */
	reset(): void {
		this.activeRunToken += 1;
		this.finalizingRunToken = null;
		this.statusPollFailures = 0;
		this.resetTelemetry();
		if (this.uploadAbort) {
			this.uploadAbort();
			this.uploadAbort = null;
		}
		this.status = 'idle';
		this.uploadProgress = 0;
		this.errorMessage = '';
		if (this.taskId) {
			cancelJob(this.taskId, this.currentAuth).catch(() => {});
			this.taskId = null;
		}
		this.closeProgressWatchers();
	}

	/** Return to `idle` after an error without aborting in-flight work. */
	dismissError(): void {
		if (this.status !== 'error') return;
		this.status = 'idle';
		this.errorMessage = '';
	}

	/**
	 * Surface an error coming from outside the upload/compress lifecycle
	 * (typically file-type validation). Tears down any in-flight work and
	 * leaves the job in `error` with `message`.
	 */
	showError(message: string): void {
		this.reset();
		this.status = 'error';
		this.errorMessage = message;
	}

	private resetTelemetry(): void {
		this.compressProgress = 0;
		this.etaLabel = null;
		this.currentSpeedX = null;
		this.isFinalizing = false;
	}

	private updateTelemetry(progress: number, options: TelemetryUpdate = {}): void {
		const bounded = Math.max(0, Math.min(100, progress));
		this.compressProgress = bounded;

		const phase = options.phase ?? null;
		if (phase === 'finalizing') {
			this.isFinalizing = true;
			this.etaLabel = null;
			this.currentSpeedX = null;
		} else if (phase === 'encoding') {
			this.isFinalizing = false;
		}

		if (
			!this.isFinalizing &&
			typeof options.speedX === 'number' &&
			Number.isFinite(options.speedX) &&
			options.speedX > 0
		) {
			this.currentSpeedX = options.speedX;
		}

		if (
			!this.isFinalizing &&
			bounded < 99 &&
			typeof options.etaSeconds === 'number' &&
			Number.isFinite(options.etaSeconds) &&
			options.etaSeconds > 0
		) {
			this.etaLabel = formatEta(options.etaSeconds);
		} else if (this.isFinalizing || bounded >= 99) {
			this.etaLabel = null;
		}
	}

	private closeProgressWatchers(): void {
		if (this.eventSource) {
			this.eventSource.close();
			this.eventSource = null;
		}
		if (this.statusPollTimer !== null) {
			window.clearInterval(this.statusPollTimer);
			this.statusPollTimer = null;
		}
	}

	private fail(message: string, runToken: number): void {
		if (runToken !== this.activeRunToken) return;
		this.closeProgressWatchers();
		this.finalizingRunToken = null;
		this.etaLabel = null;
		this.currentSpeedX = null;
		this.isFinalizing = false;
		this.status = 'error';
		this.errorMessage = message;
	}

	private async finalizeDownload(
		completedTaskId: string,
		suggestedFilename: string,
		auth: ApiAuth | null,
		runToken: number
	): Promise<void> {
		if (runToken !== this.activeRunToken) return;
		if (this.finalizingRunToken === runToken || this.status === 'done') return;

		this.finalizingRunToken = runToken;
		this.closeProgressWatchers();
		this.compressProgress = 100;
		this.etaLabel = null;
		this.currentSpeedX = null;
		this.isFinalizing = true;

		try {
			await downloadCompletedFile(completedTaskId, suggestedFilename, auth, 5);
			if (runToken !== this.activeRunToken) return;
			this.status = 'done';
		} catch (err) {
			if (runToken !== this.activeRunToken) return;
			this.status = 'error';
			this.errorMessage = err instanceof Error && err.message ? err.message : 'Something went wrong';
		} finally {
			if (this.finalizingRunToken === runToken) {
				this.finalizingRunToken = null;
			}
		}
	}

	private async syncStatus(
		activeTaskId: string,
		serverFilename: string,
		auth: ApiAuth | null,
		runToken: number
	): Promise<void> {
		if (runToken !== this.activeRunToken || this.status !== 'compressing') return;

		try {
			const jobStatus = await getJobStatus(activeTaskId, auth);
			if (runToken !== this.activeRunToken || this.status !== 'compressing') return;

			this.statusPollFailures = 0;

			if (typeof jobStatus.progress === 'number') {
				this.updateTelemetry(jobStatus.progress);
			}

			const state = String(jobStatus.state || '').toUpperCase();
			const detail = String(jobStatus.detail || '').toLowerCase();

			if (state === 'SUCCESS' || detail === 'done') {
				this.updateTelemetry(100, { phase: 'done' });
				const suggested = buildDownloadFilename(serverFilename);
				await this.finalizeDownload(activeTaskId, suggested, auth, runToken);
				return;
			}

			if (state === 'FAILURE') {
				this.fail(jobStatus.detail || 'Compression failed', runToken);
				return;
			}

			if (state === 'REVOKED') {
				this.fail('Compression cancelled', runToken);
			}
		} catch {
			if (runToken !== this.activeRunToken || this.status !== 'compressing') return;
			this.statusPollFailures += 1;
			if (!this.eventSource && this.statusPollFailures >= 3) {
				this.fail('Connection lost', runToken);
			}
		}
	}

	private startStatusPolling(
		activeTaskId: string,
		serverFilename: string,
		auth: ApiAuth | null,
		runToken: number
	): void {
		if (this.statusPollTimer !== null) {
			window.clearInterval(this.statusPollTimer);
		}
		this.statusPollFailures = 0;
		void this.syncStatus(activeTaskId, serverFilename, auth, runToken);
		this.statusPollTimer = window.setInterval(() => {
			void this.syncStatus(activeTaskId, serverFilename, auth, runToken);
		}, 1000);
	}
}
