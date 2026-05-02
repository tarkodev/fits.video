<script lang="ts">
  interface Props {
    url: string;
    onUrlChange: (value: string) => void;
  }

  let { url, onUrlChange }: Props = $props();

  function handleInput(e: Event) {
    onUrlChange((e.target as HTMLInputElement).value);
  }
</script>

<div class="drop-content">
  <div class="drop-icon">📁</div>
  <p class="drop-text">
    <strong>Drag & Drop</strong> your video here
  </p>
  <p class="drop-subtext text-muted text-sm">or click to choose from your device</p>

  <div class="divider">
    <span>OR</span>
  </div>

  <div class="url-input-wrapper">
    <span class="url-icon">🔗</span>
    <input
      type="url"
      placeholder="Paste a direct video URL"
      value={url}
      oninput={handleInput}
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
    />
  </div>
</div>

<style>
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
</style>
