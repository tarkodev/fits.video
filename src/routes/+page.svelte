<script lang="ts">
  import {
    cancelJob,
    downloadCompletedFile,
    getDefaultApiAuth,
    getJobStatus,
    openProgressStream,
    startCompress,
    uploadFile,
    type ApiAuth
  } from '$lib/api';

  // State
  let file = $state<File | null>(null);
  let url = $state('');
  let previewUrl = $state<string | null>(null);
  let targetSize = $state(10);
  let customSize = $state('');
  let isCustom = $state(false);
  
  // Upload / Compress state
  let taskId = $state<string | null>(null);
  let uploadProgress = $state(0);
  let compressProgress = $state(0);
  let status = $state<'idle' | 'uploading' | 'compressing' | 'done' | 'error'>('idle');
  let errorMessage = $state('');
  let isDragging = $state(false);
  let eventSource = $state<EventSource | null>(null);
  let statusPollTimer = $state<number | null>(null);
  let uploadAbort = $state<(() => void) | null>(null);
  let isPlaying = $state(true);
  let previewVideo = $state<HTMLVideoElement | null>(null);
  let aspectRatio = $state(56.25); // Default 16:9 (9/16 * 100)
  let activeRunToken = $state(0);
  let finalizingRunToken = $state<number | null>(null);
  let statusPollFailures = $state(0);
  let progressLabel = $state('Compressing...');

  // Size presets
  const sizePresets = [8, 10, 25, 50, 100];

  // Computed
  let selectedSize = $derived(isCustom ? (parseFloat(customSize) || 8) : targetSize);
  let canCompress = $derived((file || url.trim()) && selectedSize > 0 && status === 'idle' && !(isCustom && !customSize.trim()));
  let fileName = $derived(file?.name || '');
  let fileSize = $derived(file ? formatBytes(file.size) : '');

  function getApiAuth(): ApiAuth {
    return getDefaultApiAuth();
  }

  function getErrorMessage(err: unknown): string {
    if (err instanceof Error && err.message) return err.message;
    return 'Something went wrong';
  }

  function buildDownloadFilename(sourceName: string): string {
    const fallback = sourceName.trim() || 'video';
    const stem = fallback.replace(/\.[^/.]+$/, '') || fallback;
    return `${stem}_compressed.mp4`;
  }

  function closeProgressWatchers() {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }

    if (statusPollTimer !== null) {
      window.clearInterval(statusPollTimer);
      statusPollTimer = null;
    }
  }

  function failCompression(message: string, runToken: number) {
    if (runToken !== activeRunToken) return;
    closeProgressWatchers();
    finalizingRunToken = null;
    status = 'error';
    errorMessage = message;
  }

  async function finalizeDownload(
    completedTaskId: string,
    suggestedFilename: string,
    auth: ApiAuth | null,
    runToken: number
  ) {
    if (runToken !== activeRunToken) return;
    if (finalizingRunToken === runToken || status === 'done') return;

    finalizingRunToken = runToken;
    closeProgressWatchers();
    compressProgress = 100;
    progressLabel = 'Preparing download...';

    try {
      await downloadCompletedFile(completedTaskId, suggestedFilename, auth, 5);
      if (runToken !== activeRunToken) return;
      status = 'done';
    } catch (err) {
      if (runToken !== activeRunToken) return;
      status = 'error';
      errorMessage = getErrorMessage(err);
    } finally {
      if (finalizingRunToken === runToken) {
        finalizingRunToken = null;
      }
    }
  }

  async function syncJobStatus(
    activeTaskId: string,
    serverFilename: string,
    auth: ApiAuth | null,
    runToken: number
  ) {
    if (runToken !== activeRunToken || status !== 'compressing') return;

    try {
      const jobStatus = await getJobStatus(activeTaskId, auth);
      if (runToken !== activeRunToken || status !== 'compressing') return;

      statusPollFailures = 0;

      if (typeof jobStatus.progress === 'number') {
        compressProgress = Math.max(compressProgress, Math.round(jobStatus.progress));
      }

      const state = String(jobStatus.state || '').toUpperCase();
      const detail = String(jobStatus.detail || '').toLowerCase();

      if (state === 'SUCCESS' || detail === 'done') {
        const suggestedFilename = buildDownloadFilename(file?.name || serverFilename);
        await finalizeDownload(activeTaskId, suggestedFilename, auth, runToken);
        return;
      }

      if (state === 'FAILURE') {
        failCompression(jobStatus.detail || 'Compression failed', runToken);
        return;
      }

      if (state === 'REVOKED') {
        failCompression('Compression cancelled', runToken);
      }
    } catch {
      if (runToken !== activeRunToken || status !== 'compressing') return;
      statusPollFailures += 1;

      if (!eventSource && statusPollFailures >= 3) {
        failCompression('Connection lost', runToken);
      }
    }
  }

  function startJobStatusPolling(
    activeTaskId: string,
    serverFilename: string,
    auth: ApiAuth | null,
    runToken: number
  ) {
    if (statusPollTimer !== null) {
      window.clearInterval(statusPollTimer);
    }

    statusPollFailures = 0;
    void syncJobStatus(activeTaskId, serverFilename, auth, runToken);
    statusPollTimer = window.setInterval(() => {
      void syncJobStatus(activeTaskId, serverFilename, auth, runToken);
    }, 1500);
  }

  function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function selectPreset(size: number) {
    targetSize = size;
    isCustom = false;
    customSize = '';
  }

  function enableCustom() {
    isCustom = true;
  }

  // Drag & Drop handlers
  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    if (status !== 'idle' && status !== 'error' && status !== 'done') return; // Prevent drag during processing
    isDragging = true;
  }

  function handleDragLeave() {
    isDragging = false;
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    isDragging = false;
    const files = e.dataTransfer?.files;
    if (files?.length) {
      file = files[0];
      setFile(files[0]);
    }
  }

  function handleFileSelect(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      setFile(input.files[0]);
    }
    // Reset input to allow re-selecting the same file
    input.value = '';
  }

  function setFile(f: File) {
    file = f;
    url = ''; // Clear URL if file is selected
    
    // Create preview URL
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(f);
    isPlaying = true;
    aspectRatio = 56.25; // Reset to default while loading
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

  function togglePreview(e: Event) {
    e.stopPropagation();
    if (previewVideo) {
      if (previewVideo.paused) {
        previewVideo.play();
        isPlaying = true;
      } else {
        previewVideo.pause();
        isPlaying = false;
      }
    }
  }

  function clearFile() {
    activeRunToken += 1;
    finalizingRunToken = null;
    statusPollFailures = 0;
    progressLabel = 'Compressing...';
    // Abort ongoing upload if any
    if (uploadAbort) {
      uploadAbort();
      uploadAbort = null;
    }
    file = null;
    url = '';
    customSize = '';
    isCustom = false;
    targetSize = 10;
    status = 'idle';
    uploadProgress = 0;
    compressProgress = 0;
    errorMessage = '';
    if (taskId) {
      cancelJob(taskId, getApiAuth()).catch(() => {});
      taskId = null;
    }
    closeProgressWatchers();
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = null;
    }
  }

  async function compress() {
    if (!canCompress) return;

    const runToken = activeRunToken + 1;
    activeRunToken = runToken;
    finalizingRunToken = null;
    statusPollFailures = 0;
    progressLabel = 'Compressing...';
    const auth = getApiAuth();

    try {
      status = 'uploading';
      uploadProgress = 0;
      compressProgress = 0;
      errorMessage = '';

      // Upload file
      let jobId: string | undefined;
      let serverFilename: string = '';
      if (file) {
        // Apply 5% safety margin for MB/MiB differences
        const safeSize = selectedSize * 0.95;
        const { promise, abort } = uploadFile(
          file,
          safeSize,
          128,
          (pct) => {
            if (runToken !== activeRunToken) return;
            uploadProgress = pct;
          },
          auth
        );
        uploadAbort = abort;
        const uploadResp = await promise;
        if (runToken !== activeRunToken) return;
        uploadAbort = null;
        // API returns job_id from upload
        jobId = uploadResp.job_id;
        serverFilename = uploadResp.filename || file.name;
      } else if (url.trim()) {
        errorMessage = 'URL upload not yet supported';
        status = 'error';
        return;
      }

      if (!jobId) {
        status = 'error';
        errorMessage = 'Upload failed - no job ID';
        return;
      }

      // Start compression - use the filename returned by the server, not the original
      status = 'compressing';
      
      const compressResp = await startCompress({
        job_id: jobId,
        filename: serverFilename,
        target_size_mb: selectedSize,
        audio_bitrate_kbps: 128,
        video_codec: 'libx264'  // Use CPU fallback codec for maximum compatibility
      }, auth);
      if (runToken !== activeRunToken) return;
      
      // Compress returns the actual task_id for SSE
      taskId = compressResp.task_id;

      if (!taskId) {
        status = 'error';
        errorMessage = 'Compression failed to start';
        return;
      }

      // Listen for progress via SSE
      const activeTaskId = taskId;
      startJobStatusPolling(activeTaskId, serverFilename, auth, runToken);
      const es = openProgressStream(activeTaskId);
      eventSource = es;

      es.onmessage = (event) => {
        if (runToken !== activeRunToken) return;

        try {
          const data = JSON.parse(event.data);
          statusPollFailures = 0;
          
          // Normalize type to lowercase for comparison
          const eventType = (data.type || '').toLowerCase();
          
          // Skip ping/connected events
          if (eventType === 'ping' || eventType === 'connected') {
            return;
          }
          
          // Handle progress events - API sends {type: 'progress', progress: 0-100}
          if (eventType === 'progress' && typeof data.progress === 'number') {
            compressProgress = Math.round(data.progress);
          }
          
          // Handle log events - show that compression is active
          if (eventType === 'log' && compressProgress === 0) {
            // If we're receiving logs but no progress yet, show minimal progress
            compressProgress = 1;
          }
          
          // Handle completion - check multiple conditions
          const isCompleted = 
            eventType === 'completed' ||
            eventType === 'done' ||
            data.status === 'completed' ||
            data.phase === 'done' ||
            (eventType === 'progress' && data.progress >= 100);
          
          if (isCompleted) {
            compressProgress = 100;
            
            if (activeTaskId) {
              const suggestedFilename = buildDownloadFilename(file?.name || serverFilename);
              void finalizeDownload(activeTaskId, suggestedFilename, auth, runToken);
            }
          }
          // Handle errors
          if (eventType === 'error') {
            status = 'error';
            errorMessage = data.message || 'Compression failed';
            es.close();
            eventSource = null;
          }
        } catch (err) {
          errorMessage = getErrorMessage(err);
        }
      };

      es.onerror = () => {
        if (eventSource !== es) return;
        es.close();
        eventSource = null;
        void syncJobStatus(activeTaskId, serverFilename, auth, runToken);
      };

    } catch (err) {
      // Don't show error if user cancelled
      if (err instanceof Error && err.message === 'Upload cancelled') return;
      if (runToken !== activeRunToken) return;
      status = 'error';
      errorMessage = getErrorMessage(err);
    }
  }

  async function handleCancel() {
    activeRunToken += 1;
    finalizingRunToken = null;
    statusPollFailures = 0;
    closeProgressWatchers();
    if (taskId) {
      try {
        await cancelJob(taskId, getApiAuth());
      } catch (e) {
        // Ignore cancel errors
      }
    }
    clearFile();
  }
</script>

<div class="container">
  <!-- Header -->
  <header class="header">
    <h1 class="logo">fits<span class="accent">.video</span></h1>
    <p class="tagline">MP4, GIF, whatever: now it fits.</p>
  </header>

  <!-- Hidden file input always present -->
  <input 
    id="file-input"
    type="file" 
    accept="video/*,image/gif" 
    class="file-input-hidden" 
    onchange={handleFileSelect}
  />

  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <label 
    for="file-input"
    class="drop-zone card"
    class:dragging={isDragging}
    class:has-file={!!file}
    class:processing={status === 'uploading' || status === 'compressing'}
    ondragover={handleDragOver}
    ondragleave={handleDragLeave}
    ondrop={handleDrop}
  >
    {#if file}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div class="file-preview-card fade-in" style="aspect-ratio: 100 / {Math.min(aspectRatio, 75)};" onclick={(e) => { e.stopPropagation(); e.preventDefault(); if (status === 'idle' || status === 'done' || status === 'error') document.getElementById('file-input')?.click(); }} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); if (status === 'idle' || status === 'done' || status === 'error') document.getElementById('file-input')?.click(); } }} role="button" tabindex="0">
        {#if previewUrl}
          {#if file?.type.startsWith('video/')}
            <video 
              bind:this={previewVideo}
              src={previewUrl} 
              muted 
              playsinline 
              loop 
              autoplay 
              class="bg-video"
              onloadedmetadata={handleVideoLoaded}
            ></video>
          {:else if file?.type.startsWith('image/')}
            <img 
              src={previewUrl} 
              alt="Preview"
              class="bg-video"
              onload={handleImageLoaded}
            />
          {/if}
          <div class="video-overlay"></div>
        {/if}
        
        <div class="preview-content">
          <button 
            type="button"
            class="file-icon" 
            class:clickable={!!previewUrl}
            onclick={(e) => { e.preventDefault(); e.stopPropagation(); if (previewUrl) togglePreview(e); }}
            disabled={!previewUrl}
          >
            {#if previewUrl && file?.type.startsWith('video/')}
              {#if isPlaying}
                <!-- Pause Icon -->
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"/></svg>
              {:else}
                <!-- Play Icon -->
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
              {/if}
            {:else}
              <!-- Video Icon -->
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
            class="btn-clear" 
            onclick={(e) => { e.preventDefault(); e.stopPropagation(); clearFile(); }}
            aria-label="Cancel"
          >×</button>
        </div>
      </div>
    {:else}
      <div class="drop-content">
        <div class="drop-icon">📁</div>
        <p class="drop-text">
          <strong>Drag & Drop</strong> your video here
        </p>
        <p class="drop-subtext text-muted text-sm">or click to choose from your device</p>
        
        <div class="divider">
          <span>OR</span>
        </div>
        
        <div class="url-input-wrapper" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()} role="group">
          <span class="url-icon">🔗</span>
          <input 
            type="url" 
            placeholder="Paste a direct video URL" 
            bind:value={url}
            onclick={(e) => e.stopPropagation()}
          />
        </div>
      </div>
    {/if}
  </label>

  <!-- Size Selector -->
  <div class="size-section">
    <div class="size-selector">
      <div class="size-track">
        {#each sizePresets as size, i}
          <button 
            class="size-option"
            class:active={!isCustom && targetSize === size}
            onclick={() => selectPreset(size)}
            disabled={status !== 'idle'}
          >
            <span class="size-value">{size}</span>
            <span class="size-unit">MB</span>
          </button>
        {/each}
        <div class="size-option custom" class:active={isCustom}>
          <input 
            type="text" 
            inputmode="numeric"
            pattern="[0-9]*"
            maxlength="3"
            placeholder="..."
            bind:value={customSize}
            onfocus={enableCustom}
            oninput={(e) => { customSize = (e.target as HTMLInputElement).value.replace(/[^0-9]/g, '').slice(0, 3); }}
            disabled={status !== 'idle'}
          />
          <span class="size-unit">MB</span>
        </div>
      </div>
    </div>
  </div>

  <!-- Progress -->
  {#if status !== 'idle'}
    <div class="progress-section fade-in">
      {#if status === 'uploading'}
        <div class="progress-label">
          <span>Uploading...</span>
          <span class="font-mono">{uploadProgress}%</span>
        </div>
        <div class="progress-container">
          <div class="progress-bar" style="width: {uploadProgress}%"></div>
        </div>
      {:else if status === 'compressing'}
        <div class="progress-label">
          <span>{progressLabel}</span>
          <span class="font-mono">{compressProgress}%</span>
        </div>
        <div class="progress-container">
          <div class="progress-bar" style="width: {compressProgress}%"></div>
        </div>
      {:else if status === 'done'}
        <div class="status-done">
          <span class="status-icon">✅</span>
          <span>Done! Download started.</span>
        </div>
      {:else if status === 'error'}
        <div class="status-error">
          <span class="status-icon">💔</span>
          <span>{errorMessage || 'An error occurred'}</span>
          <button class="btn-dismiss" onclick={() => { status = 'idle'; errorMessage = ''; }} aria-label="Dismiss">×</button>
        </div>
      {/if}
    </div>
  {/if}

  <!-- Action Button -->
  {#if status === 'idle'}
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

  <!-- Footer -->
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
      <!-- <a href="/about" aria-label="About" title="About">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
      </a> -->
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

  /* Drop Zone */
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
    /* pointer-events: none; Removed to allow play button interaction */
    /* opacity: 0.7; Removed to keep video visible */
    border-color: var(--accent-glow); /* Add some visual cue it's processing */
  }

  .file-input-hidden {
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: pointer;
    pointer-events: none;
  }

  .file-input-hidden {
    position: fixed;
    top: -9999px;
    left: -9999px;
  }

  .drop-content {
    text-align: center;
    padding: 20px;
  }

  .drop-icon {
    font-size: 3rem;
    margin-bottom: 12px;
  }

  .drop-text {
    font-size: 1.1rem;
  }

  .drop-subtext {
    margin-top: 4px;
  }

  .divider {
    display: flex;
    align-items: center;
    margin: 20px 0;
    color: var(--text-muted);
    font-size: 0.75rem;
  }

  .divider::before,
  .divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--glass-border);
  }

  .divider span {
    padding: 0 12px;
  }

  .url-input-wrapper {
    position: relative;
    display: flex;
    align-items: center;
  }

  .url-icon {
    position: absolute;
    left: 12px;
    font-size: 1rem;
    pointer-events: none;
  }

  .url-input-wrapper input {
    padding-left: 40px;
  }

  /* File Info / Preview Card */
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

  .drop-zone.processing .bg-video {
    /* opacity: 0.3; Removed */
    /* filter: grayscale(1); Removed */
    opacity: 0.5; /* Just dim it slightly instead of grayscale */
  }

  /* Size Selector - Segmented Control Style */
  .size-section {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .size-selector {
    width: 100%;
  }

  .size-track {
    display: flex;
    background: var(--bg-card);
    border: 1px solid var(--glass-border);
    border-radius: 12px;
    padding: 4px;
    gap: 2px;
  }

  .size-option {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 2px;
    padding: 12px 8px;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    font-size: 0.95rem;
    font-weight: 500;
    border-radius: 8px;
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .size-option:hover:not(:disabled):not(.active) {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .size-option.active {
    background: linear-gradient(135deg, var(--accent), var(--accent-hover));
    color: white;
    font-weight: 600;
    box-shadow: 0 2px 8px rgba(99, 102, 241, 0.3);
  }

  .size-option:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .size-value {
    font-weight: inherit;
  }

  .size-unit {
    font-size: 0.7rem;
    opacity: 0.7;
    font-weight: 400;
  }

  .size-option.custom {
    min-width: 70px;
    flex: 0.8;
    padding: 8px;
    gap: 4px;
  }

  .size-option.custom input {
    width: 40px;
    background: transparent;
    border: none;
    color: inherit;
    font-size: 0.95rem;
    font-weight: inherit;
    text-align: center;
    padding: 0;
  }

  .size-option.custom input::placeholder {
    color: var(--text-muted);
  }

  .size-option.custom input:focus {
    outline: none;
  }

  .size-option.custom.active input {
    color: white;
  }

  .size-option.custom.active input::placeholder {
    color: rgba(255,255,255,0.6);
  }

  /* Progress Section */
  .progress-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .progress-label {
    display: flex;
    justify-content: space-between;
    font-size: 0.875rem;
  }

  .status-done,
  .status-error {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 12px;
    border-radius: var(--border-radius);
    font-weight: 500;
  }

  .status-done {
    background: rgba(34, 197, 94, 0.1);
    color: var(--success);
  }

  .status-error {
    position: relative;
    background: rgba(239, 68, 68, 0.1);
    color: var(--error);
    padding-right: 36px;
  }

  .status-icon {
    font-size: 1.25rem;
  }

  .btn-dismiss {
    position: absolute;
    right: 12px;
    top: 50%;
    transform: translateY(-50%);
    background: transparent;
    border: none;
    color: inherit;
    font-size: 1.25rem;
    cursor: pointer;
    opacity: 0.7;
    padding: 0 4px;
    line-height: 1;
  }

  .btn-dismiss:hover {
    opacity: 1;
  }

  /* Action Section */
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

  /* Footer */
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

  /* Responsive */
  @media (max-width: 480px) {
    .logo {
      font-size: 2rem;
    }

    .drop-zone {
      min-height: 180px;
    }

    .size-option {
      min-width: 50px;
      padding: 8px 12px;
    }
  }
</style>
