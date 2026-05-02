<script lang="ts">
  type Status = 'idle' | 'uploading' | 'compressing' | 'done' | 'error';

  interface Props {
    status: Status;
    uploadProgress: number;
    compressionSummary: string;
    displayedProgress: number;
    errorMessage: string;
    onDismiss: () => void;
  }

  let {
    status,
    uploadProgress,
    compressionSummary,
    displayedProgress,
    errorMessage,
    onDismiss
  }: Props = $props();
</script>

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
      <span class="font-mono">{compressionSummary}</span>
    </div>
    <div class="progress-container">
      <div class="progress-bar" style="width: {displayedProgress}%"></div>
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
      <button class="btn-dismiss" onclick={onDismiss} aria-label="Dismiss">×</button>
    </div>
  {/if}
</div>

<style>
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
</style>
