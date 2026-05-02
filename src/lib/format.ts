// Pure formatting / validation helpers shared by the page and its components.

const ACCEPTED_EXTENSIONS = /\.(mp4|mov|mkv|webm|avi|m4v|gif)$/i;

export function isAcceptedFile(file: File): boolean {
	if (file.type.startsWith('video/') || file.type === 'image/gif') return true;
	// Some OSes (notably Windows) hand us an empty MIME for `.mkv` / `.webm`,
	// fall back to the extension in that case.
	if (!file.type) return ACCEPTED_EXTENSIONS.test(file.name);
	return false;
}

export function formatBytes(bytes: number): string {
	const mb = Math.max(0, bytes) / (1024 * 1024);
	const roundedUp = Math.ceil(mb * 10) / 10;
	return `${roundedUp.toFixed(1)} MB`;
}

export function formatEta(seconds: number): string {
	const total = Math.max(1, Math.round(seconds));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const remaining = total % 60;

	if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`;
	if (minutes > 0) return `${minutes}m${String(remaining).padStart(2, '0')}s`;
	return `${remaining}s`;
}

export function buildDownloadFilename(sourceName: string): string {
	const fallback = sourceName.trim() || 'video';
	const stem = fallback.replace(/\.[^/.]+$/, '') || fallback;
	return `${stem}_compressed.mp4`;
}
