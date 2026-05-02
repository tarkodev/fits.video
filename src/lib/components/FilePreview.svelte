<script lang="ts">
  interface Props {
    file: File;
    previewUrl: string | null;
    aspectRatio: number;
    fileName: string;
    fileSize: string;
    onClear: (e: MouseEvent) => void;
    onVideoLoaded: (e: Event) => void;
    onImageLoaded: (e: Event) => void;
  }

  let {
    file,
    previewUrl,
    aspectRatio,
    fileName,
    fileSize,
    onClear,
    onVideoLoaded,
    onImageLoaded
  }: Props = $props();

  let videoEl = $state<HTMLVideoElement | null>(null);
  let isPlaying = $state(true);

  function togglePlay(e: MouseEvent) {
    e.stopPropagation();
    if (!previewUrl || !videoEl) return;
    if (videoEl.paused) {
      videoEl.play();
      isPlaying = true;
    } else {
      videoEl.pause();
      isPlaying = false;
    }
  }
</script>

<div class="file-preview-card fade-in" style="aspect-ratio: 100 / {Math.min(aspectRatio, 75)};">
  {#if previewUrl}
    {#if file.type.startsWith('video/')}
      <video
        bind:this={videoEl}
        src={previewUrl}
        muted
        playsinline
        loop
        autoplay
        class="bg-video"
        onloadedmetadata={onVideoLoaded}
      ></video>
    {:else if file.type.startsWith('image/')}
      <img
        src={previewUrl}
        alt="Preview"
        class="bg-video"
        onload={onImageLoaded}
      />
    {/if}
    <div class="video-overlay"></div>
  {/if}

  <div class="preview-content">
    <button
      type="button"
      class="file-icon"
      class:clickable={!!previewUrl}
      onclick={togglePlay}
      disabled={!previewUrl}
    >
      {#if previewUrl && file.type.startsWith('video/')}
        {#if isPlaying}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"/></svg>
        {:else}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        {/if}
      {:else}
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>
      {/if}
    </button>
    <div class="file-details">
      <span class="file-name">{fileName}</span>
      {#if fileSize}
        <span class="file-size">{fileSize}</span>
      {/if}
    </div>
    <button
      type="button"
      class="btn-clear"
      onclick={onClear}
      aria-label="Cancel"
    >×</button>
  </div>
</div>

<style>
  .file-preview-card {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    position: relative;
    overflow: hidden;
    border-radius: 16px;
    background: var(--bg-card);
  }

  .bg-video {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    opacity: 0.6;
  }

  .video-overlay {
    position: absolute;
    inset: 0;
    background: linear-gradient(to top, rgba(0,0,0,0.9), rgba(0,0,0,0.4));
  }

  .preview-content {
    position: relative;
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 20px;
    height: 100%;
    justify-content: space-between;
  }

  .file-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    background: rgba(255,255,255,0.15);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 8px;
    backdrop-filter: blur(4px);
    font-size: 1.25rem;
    color: white;
    line-height: 1;
    padding: 0;
  }

  .file-icon:disabled {
    cursor: default;
  }

  .file-icon.clickable {
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .file-icon.clickable:hover {
    background: rgba(255,255,255,0.2);
    transform: scale(1.05);
  }

  .file-details {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    gap: 4px;
    text-shadow: 0 2px 4px rgba(0,0,0,0.5);
  }

  .file-name {
    font-weight: 600;
    font-size: 1.1rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: white;
  }

  .file-size {
    font-size: 0.875rem;
    color: rgba(255,255,255,0.8);
  }

  .btn-clear {
    width: 36px;
    height: 36px;
    padding: 0;
    font-size: 1.5rem;
    line-height: 1;
    background: rgba(255,255,255,0.15);
    color: white;
    border-radius: 50%;
    backdrop-filter: blur(4px);
    cursor: pointer;
    transition: all var(--transition-fast);
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid rgba(255,255,255,0.1);
    padding-bottom: 3px; /* Visual correction for X */
  }

  .btn-clear:hover:not(:disabled) {
    background: var(--error);
    border-color: var(--error);
    transform: scale(1.05);
  }

  .btn-clear:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }
</style>
