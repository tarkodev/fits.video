import { env } from '$env/dynamic/public';

const RAW = (env.PUBLIC_API_URL as string | undefined) || '';
const API = RAW && RAW.trim() !== '' ? RAW.replace(/\/$/, '') : '';

export interface UploadResponse {
    task_id: string;
    original_name: string;
    size_bytes: number;
    duration: number;
}

export interface ProgressEvent {
    type: 'progress' | 'completed' | 'error' | 'log';
    percent?: number;
    eta?: string;
    message?: string;
    output_size?: number;
}

// Upload file to the API
export async function uploadFile(
    file: File,
    targetSizeMB: number,
    audioKbps = 128,
    onProgress?: (percent: number) => void
): Promise<UploadResponse> {
    return new Promise((resolve, reject) => {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('target_size_mb', String(targetSizeMB));
        fd.append('audio_bitrate_kbps', String(audioKbps));

        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${API}/api/upload`);

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
                } else {
                    reject(new Error(xhr.responseText || `HTTP ${xhr.status}`));
                }
            } catch (err) {
                reject(err);
            }
        };

        xhr.onerror = () => reject(new Error('Network error'));
        xhr.send(fd);
    });
}

// Start compression job
export async function startCompress(payload: {
    job_id: string;
    filename: string;
    target_size_mb: number;
    audio_bitrate_kbps?: number;
    video_codec?: string;
}): Promise<{ task_id: string }> {
    console.log('startCompress payload:', payload);
    const res = await fetch(`${API}/api/compress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    console.log('Compress response status:', res.status);
    if (!res.ok) {
        const errorText = await res.text();
        console.error('Compress error:', errorText);
        throw new Error(errorText);
    }
    const result = await res.json();
    console.log('Compress result:', result);
    return result;
}

// Open SSE stream for progress
export function openProgressStream(taskId: string): EventSource {
    const sseUrl = API ? `${API}/api/stream/${taskId}` : `/api/stream/${taskId}`;
    return new EventSource(sseUrl);
}

// Get download URL
export function getDownloadUrl(taskId: string): string {
    return `${API}/api/jobs/${taskId}/download`;
}

// Cancel a job
export async function cancelJob(taskId: string): Promise<void> {
    const res = await fetch(`${API}/api/jobs/${encodeURIComponent(taskId)}/cancel`, {
        method: 'POST'
    });
    if (!res.ok) throw new Error(await res.text());
}

// Get available codecs from server
export async function getCodecs(): Promise<{
    hardware_type: string;
    available_encoders: Record<string, string>;
    enabled_codecs: string[];
}> {
    const res = await fetch(`${API}/api/codecs/available`);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
}

// Get API version
export async function getVersion(): Promise<{ version: string }> {
    const res = await fetch(`${API}/api/version`);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
}
