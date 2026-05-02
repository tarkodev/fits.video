<script lang="ts">
  import { getDefaultApiAuth } from '$lib/api';
  import { CompressionJob } from '$lib/compression.svelte';
  import { formatBytes, isAcceptedFile } from '$lib/format';
  import EmptyDropZone from '$lib/components/EmptyDropZone.svelte';
  import FilePreview from '$lib/components/FilePreview.svelte';
  import ProgressDisplay from '$lib/components/ProgressDisplay.svelte';
  import SizeSelector from '$lib/components/SizeSelector.svelte';

  // --- Input state ----------------------------------------------------------
  let file = $state<File | null>(null);
  let url = $state('');
  let previewUrl = $state<string | null>(null);
  let aspectRatio = $state(56.25); // Default 16:9 expressed as height/width %.
  let isDragging = $state(false);

  let targetSize = $state(10);
  let customSize = $state('');
  let isCustom = $state(false);
  const sizePresets = [8, 10, 25, 50, 100];

  // The whole upload → compress → download lifecycle lives in this class
  // so the page only owns "what file is selected" and "what size is asked".
  const job = new CompressionJob();

  // --- Derived --------------------------------------------------------------
  let selectedSize = $derived(isCustom ? (parseFloat(customSize) || 8) : targetSize);
  let canCompress = $derived(
    (file || url.trim()) && selectedSize > 0 && job.status === 'idle' && !(isCustom && !customSize.trim())
  );
  let fileName = $derived(file?.name || '');
  let fileSize = $derived(file ? formatBytes(file.size) : '');

  // --- File input handling --------------------------------------------------
  function canOpenFilePicker(): boolean {
    return job.status === 'idle' || job.status === 'done' || job.status === 'error';
  }

  function openFilePicker() {
    if (!canOpenFilePicker()) return;
    document.getElementById('file-input')?.click();
  }

  function handleDropZoneKey(e: KeyboardEvent) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLButtonElement) return;
    e.preventDefault();
    openFilePicker();
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    if (!canOpenFilePicker()) return;
    isDragging = true;
  }

  function handleDragLeave() {
    isDragging = false;
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    isDragging = false;
    if (!canOpenFilePicker()) return;
    const dropped = e.dataTransfer?.files?.[0];
    if (!dropped) return;
    if (!isAcceptedFile(dropped)) {
      job.showError('Unsupported file type. Drop a video or a GIF.');
      return;
    }
    setFile(dropped);
  }

  function handleFileSelect(e: Event) {
    const input = e.target as HTMLInputElement;
    const picked = input.files?.[0];
    // Reset input so the user can re-select the same file later.
    input.value = '';
    if (!picked) return;
    if (!isAcceptedFile(picked)) {
      job.showError('Unsupported file type. Drop a video or a GIF.');
      return;
    }
    setFile(picked);
  }

  function setFile(f: File) {
    job.reset();
    file = f;
    url = '';
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(f);
    aspectRatio = 56.25;
  }

  function handleVideoLoaded(e: Event) {
    const video = e.target as HTMLVideoElement;
    if (video.videoWidth && video.videoHeight) {
      aspectRatio = (video.videoHeight / video.videoWidth) * 100;
    }
  }

  function handleImageLoaded(e: Event) {
    const img = e.target as HTMLImageElement;
    if (img.naturalWidth && img.naturalHeight) {
      aspectRatio = (img.naturalHeight / img.naturalWidth) * 100;
    }
  }

  function clearFile(e?: MouseEvent) {
    e?.stopPropagation();
    job.reset();
    file = null;
    url = '';
    // Size preference (preset / custom) is intentionally kept across
    // clears and file swaps; only a full page reload resets it.
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = null;
    }
  }

  async function compress() {
    if (!canCompress) return;
    if (!file) {
      if (url.trim()) job.showError('URL upload not yet supported');
      return;
    }
    await job.start({
      file,
      targetSizeMb: selectedSize,
      auth: getDefaultApiAuth()
    });
  }
</script>

<div class="container">
  <header class="header">
    <h1 class="logo">fits<span class="accent">.video</span></h1>
    <p class="tagline">MP4, GIF, whatever: now it fits.</p>
  </header>

  <input
    id="file-input"
    type="file"
    accept="video/*,image/gif"
    class="file-input-hidden"
    onchange={handleFileSelect}
  />

  <div
    class="drop-zone card"
    class:dragging={isDragging}
    class:has-file={!!file}
    class:processing={job.status === 'uploading' || job.status === 'compressing'}
    ondragover={handleDragOver}
    ondragleave={handleDragLeave}
    ondrop={handleDrop}
    onclick={openFilePicker}
    onkeydown={handleDropZoneKey}
    role="button"
    tabindex="0"
    aria-label="Choose a video file"
  >
    {#if file}
      <FilePreview
        {file}
        {previewUrl}
        {aspectRatio}
        {fileName}
        {fileSize}
        onClear={clearFile}
        onVideoLoaded={handleVideoLoaded}
        onImageLoaded={handleImageLoaded}
      />
    {:else}
      <EmptyDropZone {url} onUrlChange={(v) => (url = v)} />
    {/if}
  </div>

  <SizeSelector
    {sizePresets}
    {targetSize}
    {customSize}
    {isCustom}
    disabled={job.status !== 'idle'}
    onSelectPreset={(size) => { targetSize = size; isCustom = false; customSize = ''; }}
    onEnableCustom={() => (isCustom = true)}
    onCustomSizeChange={(v) => (customSize = v)}
  />

  {#if job.status !== 'idle'}
    <ProgressDisplay
      status={job.status}
      uploadProgress={job.uploadProgress}
      compressionSummary={job.compressionSummary}
      displayedProgress={job.displayedProgress}
      errorMessage={job.errorMessage}
      onDismiss={() => job.dismissError()}
    />
  {/if}

  {#if job.status === 'idle'}
    <div class="action-section">
      <button
        class="btn-primary compress-btn"
        onclick={compress}
        disabled={!canCompress}
      >
        UPLOAD AND COMPRESS
      </button>
    </div>
  {/if}

  <footer class="footer">
    <div class="footer-powered">
      Powered by <a href="https://github.com/JMS1717/8mb.local" target="_blank" rel="noopener">8mb.local</a>
    </div>
    <div class="footer-links">
      <a href="https://github.com/tarkodev/fits.video" target="_blank" rel="noopener" aria-label="GitHub" title="GitHub">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
      </a>
      <a href="https://x.com/fitsvideo" target="_blank" rel="noopener" aria-label="Twitter" title="Twitter">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
      </a>
      <a href="https://discord.gg/QGGC8hEJA8" target="_blank" rel="noopener" aria-label="Discord" title="Discord">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189z"/></svg>
      </a>
    </div>
  </footer>
</div>

<style>
  .container {
    width: 100%;
    max-width: var(--max-width);
    display: flex;
    flex-direction: column;
    gap: 24px;
  }

  .header {
    text-align: center;
  }

  .logo {
    font-size: 2.5rem;
    font-weight: 700;
    letter-spacing: -1px;
  }

  .accent {
    color: var(--accent);
  }

  .tagline {
    color: var(--text-secondary);
    margin-top: 8px;
  }

  .drop-zone {
    position: relative;
    min-height: 200px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: all var(--transition);
    border: 2px dashed var(--glass-border);
  }

  .drop-zone:hover,
  .drop-zone.dragging {
    border-color: var(--accent);
    background: rgba(99, 102, 241, 0.05);
  }

  .drop-zone.has-file {
    border-style: solid;
    cursor: pointer;
  }

  .drop-zone.processing {
    cursor: wait;
    border-color: var(--accent-glow);
  }

  .file-input-hidden {
    position: fixed;
    top: -9999px;
    left: -9999px;
    opacity: 0;
    pointer-events: none;
  }

  /* Reuse the bg-video styling from the FilePreview component to keep the
     "dim while processing" cue when the preview is rendered as a child. */
  .drop-zone.processing :global(.bg-video) {
    opacity: 0.5;
  }

  .action-section {
    display: flex;
    justify-content: center;
  }

  .compress-btn {
    width: 100%;
    max-width: 400px;
    padding: 16px 32px;
    font-size: 1rem;
    font-weight: 700;
    letter-spacing: 1px;
    white-space: nowrap;
  }

  .footer {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
    margin-top: 20px;
    padding-top: 20px;
    border-top: 1px solid var(--glass-border);
  }

  .footer-powered {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .footer-powered a {
    color: var(--accent);
    text-decoration: none;
  }

  .footer-powered a:hover {
    text-decoration: underline;
  }

  .footer-links {
    display: flex;
    gap: 12px;
  }

  .footer-links a {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    background: var(--bg-card);
    border: 1px solid var(--glass-border);
    border-radius: 12px;
    color: var(--text-secondary);
    transition: all var(--transition-fast);
  }

  .footer-links a:hover {
    background: var(--accent);
    border-color: var(--accent);
    color: white;
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(99, 102, 241, 0.3);
  }

  .footer-links svg {
    width: 20px;
    height: 20px;
  }

  @media (max-width: 480px) {
    .logo {
      font-size: 2rem;
    }

    .drop-zone {
      min-height: 180px;
    }
  }
</style>
