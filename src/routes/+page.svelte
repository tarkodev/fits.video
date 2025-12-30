<script lang="ts">
  import { uploadFile, startCompress, openProgressStream, getDownloadUrl, cancelJob } from '$lib/api';

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
  let isPlaying = $state(true);
  let previewVideo = $state<HTMLVideoElement | null>(null);

  // Size presets
  const sizePresets = [8, 10, 25, 50, 100];

  // Computed
  let selectedSize = $derived(isCustom ? (parseFloat(customSize) || 8) : targetSize);
  let canCompress = $derived((file || url.trim()) && selectedSize > 0 && status === 'idle' && !(isCustom && !customSize.trim()));
  let fileName = $derived(file?.name || (url.trim() ? 'URL video' : ''));
  let fileSize = $derived(file ? formatBytes(file.size) : '');

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
  }

  function setFile(f: File) {
    file = f;
    url = ''; // Clear URL if file is selected
    
    // Create preview URL
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(f);
    isPlaying = true;
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
      cancelJob(taskId).catch(() => {});
      taskId = null;
    }
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = null;
    }
  }

  async function compress() {
    if (!canCompress) return;
    console.log('=== COMPRESS START ===');

    try {
      status = 'uploading';
      uploadProgress = 0;
      compressProgress = 0;
      errorMessage = '';

      // Upload file
      let jobId: string | undefined;
      let serverFilename: string = '';
      if (file) {
        console.log('Uploading file:', file.name);
        // Apply 5% safety margin for MB/MiB differences
        const safeSize = selectedSize * 0.95;
        const uploadResp = await uploadFile(file, safeSize, 128, (pct) => {
          uploadProgress = pct;
        });
        console.log('Upload response:', uploadResp);
        // API returns job_id from upload
        jobId = (uploadResp as any).job_id || uploadResp.task_id;
        serverFilename = (uploadResp as any).filename || file.name;
        console.log('Got job_id:', jobId, 'serverFilename:', serverFilename);
      } else if (url.trim()) {
        errorMessage = 'URL upload not yet supported';
        status = 'error';
        return;
      }

      if (!jobId) {
        console.error('No job_id received from upload!');
        status = 'error';
        errorMessage = 'Upload failed - no job ID';
        return;
      }

      // Start compression - use the filename returned by the server, not the original
      status = 'compressing';
      console.log('Starting compression with job_id:', jobId, 'filename:', serverFilename);
      
      const compressResp = await startCompress({
        job_id: jobId,
        filename: serverFilename,
        target_size_mb: selectedSize,
        audio_bitrate_kbps: 128,
        video_codec: 'libx264'  // Use CPU fallback codec for maximum compatibility
      });
      console.log('Compress response:', compressResp);
      
      // Compress returns the actual task_id for SSE
      taskId = compressResp.task_id;
      console.log('Got task_id for SSE:', taskId);

      if (!taskId) {
        console.error('No task_id received from compress!');
        status = 'error';
        errorMessage = 'Compression failed to start';
        return;
      }

      // Listen for progress via SSE
      console.log('Opening SSE stream for task:', taskId);
      const es = openProgressStream(taskId);
      eventSource = es;

      es.onopen = () => {
        console.log('SSE connection opened');
      };

      es.onmessage = (event) => {
        console.log('SSE raw data:', event.data);
        try {
          const data = JSON.parse(event.data);
          console.log('SSE parsed:', data);
          
          // Normalize type to lowercase for comparison
          const eventType = (data.type || '').toLowerCase();
          
          // Skip ping/connected events
          if (eventType === 'ping' || eventType === 'connected') {
            return;
          }
          
          // Handle progress events - API sends {type: 'progress', progress: 0-100}
          if (eventType === 'progress' && typeof data.progress === 'number') {
            console.log('Progress update:', data.progress);
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
            console.log('Compression completed!');
            status = 'done';
            compressProgress = 100;
            es.close();
            eventSource = null;
            
            // Auto-download with small delay to ensure file is ready
            if (taskId) {
              setTimeout(() => {
                const downloadUrl = getDownloadUrl(taskId!);
                console.log('Downloading from:', downloadUrl);
                const a = document.createElement('a');
                a.href = downloadUrl;
                a.download = file?.name?.replace(/\.[^/.]+$/, '') + '_compressed.mp4';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
              }, 500);
            }
          }
          // Handle errors
          if (eventType === 'error') {
            console.error('SSE error event:', data);
            status = 'error';
            errorMessage = data.message || 'Compression failed';
            es.close();
            eventSource = null;
          }
        } catch (err) {
          console.error('SSE parse error:', err, 'Raw:', event.data);
        }
      };

      es.onerror = (err) => {
        console.error('SSE connection error:', err);
        if (status === 'compressing') {
          status = 'error';
          errorMessage = 'Connection lost';
        }
        es.close();
        eventSource = null;
      };

    } catch (err: any) {
      status = 'error';
      errorMessage = err.message || 'Something went wrong';
    }
  }

  async function handleCancel() {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    if (taskId) {
      try {
        await cancelJob(taskId);
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
    class:has-file={!!file || !!url.trim()}
    class:processing={status === 'uploading' || status === 'compressing'}
    ondragover={handleDragOver}
    ondragleave={handleDragLeave}
    ondrop={handleDrop}
  >
    {#if file || url.trim()}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div class="file-preview-card fade-in" onclick={(e) => { e.stopPropagation(); e.preventDefault(); if (status === 'idle' || status === 'done' || status === 'error') document.getElementById('file-input')?.click(); }} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); if (status === 'idle' || status === 'done' || status === 'error') document.getElementById('file-input')?.click(); } }} role="button" tabindex="0">
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
            ></video>
          {:else if file?.type.startsWith('image/')}
            <img 
              src={previewUrl} 
              alt="Preview"
              class="bg-video"
            />
          {/if}
          <div class="video-overlay"></div>
        {/if}
        
        <div class="preview-content">
          <button 
            type="button"
            class="file-icon" 
            class:clickable={!!previewUrl}
            class:is-play-icon={previewUrl && file?.type.startsWith('video/') && !isPlaying}
            class:is-pause-icon={previewUrl && file?.type.startsWith('video/') && isPlaying}
            onclick={previewUrl ? togglePreview : undefined}
            disabled={!previewUrl}
          >
            {previewUrl && file?.type.startsWith('video/') ? (isPlaying ? '⏸' : '▶') : '📹'}
          </button>
          <div class="file-details">
            <span class="file-name">{fileName}</span>
            {#if fileSize}
              <span class="file-size">{fileSize}</span>
            {/if}
          </div>
          <button 
            class="btn-clear" 
            onclick={(e) => { e.preventDefault(); e.stopPropagation(); if (status !== 'uploading' && status !== 'compressing') clearFile(); }}
            disabled={status === 'uploading' || status === 'compressing'}
            aria-label="Clear file"
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
          <span>Compressing...</span>
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
          <span class="status-icon">❌</span>
          <span>{errorMessage || 'An error occurred'}</span>
        </div>
      {/if}
    </div>
  {/if}

  <!-- Action Button -->
  <div class="action-section">
    {#if status === 'idle'}
      <button 
        class="btn-primary compress-btn" 
        onclick={compress}
        disabled={!canCompress}
      >
        COMPRESS
      </button>
    {:else if status === 'uploading' || status === 'compressing'}
      <button class="btn-secondary compress-btn" onclick={handleCancel}>
        CANCEL
      </button>
    {:else}
      <button class="btn-primary compress-btn" onclick={clearFile}>
        COMPRESS ANOTHER
      </button>
    {/if}
  </div>

  <!-- Footer -->
  <footer class="footer text-muted text-xs">
    Powered by <a href="https://github.com/JMS1717/8mb.local" target="_blank" rel="noopener">8mb.local</a>
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
    width: 48px;
    height: 48px;
    background: rgba(255,255,255,0.1);
    border: none;
    border-radius: 12px;
    backdrop-filter: blur(4px);
    font-size: 1.5rem;
    color: white;
    line-height: 1;
  }

  .file-icon:disabled {
    cursor: default;
  }

  .file-icon.is-play-icon {
    padding-left: 3px; /* Center play icon visually */
  }

  .file-icon.is-pause-icon {
    padding-bottom: 3px; /* Move pause icon slightly up */
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
    background: rgba(239, 68, 68, 0.1);
    color: var(--error);
  }

  .status-icon {
    font-size: 1.25rem;
  }

  /* Action Section */
  .action-section {
    display: flex;
    justify-content: center;
  }

  .compress-btn {
    width: 100%;
    max-width: 300px;
    padding: 16px 32px;
    font-size: 1.1rem;
    font-weight: 700;
    letter-spacing: 1px;
  }

  /* Footer */
  .footer {
    text-align: center;
    margin-top: 12px;
  }

  .footer a {
    color: var(--accent);
    text-decoration: none;
  }

  .footer a:hover {
    text-decoration: underline;
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
