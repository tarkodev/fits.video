<script lang="ts">
  import { uploadFile, startCompress, openProgressStream, getDownloadUrl, cancelJob } from '$lib/api';

  // State
  let file = $state<File | null>(null);
  let url = $state('');
  let targetSize = $state(8);
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

  // Size presets
  const sizePresets = [8, 10, 50, 100, 500];

  // Computed
  let selectedSize = $derived(isCustom ? (parseFloat(customSize) || 8) : targetSize);
  let canCompress = $derived((file || url.trim()) && selectedSize > 0 && status === 'idle');
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
      url = '';
    }
  }

  function handleFileSelect(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files?.length) {
      file = input.files[0];
      url = '';
    }
  }

  function clearFile() {
    file = null;
    url = '';
    status = 'idle';
    taskId = null;
    uploadProgress = 0;
    compressProgress = 0;
    errorMessage = '';
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
        const uploadResp = await uploadFile(file, selectedSize, 128, (pct) => {
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

  <!-- Drop Zone -->
  <div 
    class="drop-zone card"
    class:dragging={isDragging}
    class:has-file={!!file || !!url.trim()}
    ondragover={handleDragOver}
    ondragleave={handleDragLeave}
    ondrop={handleDrop}
    role="button"
    tabindex="0"
  >
    {#if file || url.trim()}
      <div class="file-info fade-in">
        <div class="file-icon">📹</div>
        <div class="file-details">
          <span class="file-name">{fileName}</span>
          {#if fileSize}
            <span class="file-size text-muted">{fileSize}</span>
          {/if}
        </div>
        <button class="btn-clear" onclick={clearFile} aria-label="Clear file">×</button>
      </div>
    {:else}
      <div class="drop-content">
        <div class="drop-icon">📁</div>
        <p class="drop-text">
          <strong>Drag & drop</strong> your video here
        </p>
        <p class="drop-subtext text-muted text-sm">or click to browse</p>
        
        <div class="divider">
          <span>OR</span>
        </div>
        
        <div class="url-input-wrapper">
          <span class="url-icon">🔗</span>
          <input 
            type="url" 
            placeholder="Paste video URL" 
            bind:value={url}
            onclick={(e) => e.stopPropagation()}
          />
        </div>
      </div>
      
      <input 
        type="file" 
        accept="video/*,image/gif" 
        class="file-input" 
        onchange={handleFileSelect}
      />
    {/if}
  </div>

  <!-- Size Selector -->
  <div class="size-section">
    <p class="section-label text-muted text-sm">Select target size:</p>
    <div class="size-buttons">
      {#each sizePresets as size}
        <button 
          class="btn-secondary size-btn"
          class:active={!isCustom && targetSize === size}
          onclick={() => selectPreset(size)}
          disabled={status !== 'idle'}
        >
          {size}<span class="unit">MB</span>
        </button>
      {/each}
      
      <div class="custom-size" class:active={isCustom}>
        <input 
          type="number" 
          placeholder="Custom"
          bind:value={customSize}
          onfocus={enableCustom}
          min="1"
          max="4096"
          disabled={status !== 'idle'}
        />
        <span class="unit">MB</span>
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
    cursor: default;
  }

  .file-input {
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: pointer;
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

  /* File Info */
  .file-info {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 8px;
  }

  .file-icon {
    font-size: 2rem;
  }

  .file-details {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .file-name {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-size {
    font-size: 0.875rem;
  }

  .btn-clear {
    width: 32px;
    height: 32px;
    padding: 0;
    font-size: 1.5rem;
    background: var(--bg-hover);
    color: var(--text-secondary);
  }

  .btn-clear:hover {
    background: var(--error);
    color: var(--text-primary);
  }

  /* Size Section */
  .size-section {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .section-label {
    text-align: center;
  }

  .size-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: center;
  }

  .size-btn {
    min-width: 60px;
    padding: 10px 14px;
    font-size: 1rem;
    font-weight: 600;
  }

  .size-btn .unit {
    font-size: 0.75rem;
    font-weight: 400;
    margin-left: 2px;
    opacity: 0.7;
  }

  .custom-size {
    display: flex;
    align-items: center;
    background: var(--bg-card);
    border: 1px solid var(--glass-border);
    border-radius: var(--border-radius);
    padding: 0 12px;
    gap: 4px;
    transition: all var(--transition-fast);
  }

  .custom-size.active {
    border-color: var(--accent);
    box-shadow: 0 0 12px var(--accent-glow);
  }

  .custom-size input {
    width: 70px;
    background: transparent;
    border: none;
    padding: 10px 4px;
    text-align: right;
    font-weight: 600;
  }

  .custom-size input:focus {
    box-shadow: none;
  }

  .custom-size .unit {
    font-size: 0.75rem;
    color: var(--text-muted);
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

    .size-btn {
      min-width: 50px;
      padding: 8px 12px;
    }

    .custom-size input {
      width: 60px;
    }
  }
</style>
