<script lang="ts">
  interface Props {
    sizePresets: number[];
    targetSize: number;
    customSize: string;
    isCustom: boolean;
    disabled: boolean;
    onSelectPreset: (size: number) => void;
    onEnableCustom: () => void;
    onCustomSizeChange: (value: string) => void;
  }

  let {
    sizePresets,
    targetSize,
    customSize,
    isCustom,
    disabled,
    onSelectPreset,
    onEnableCustom,
    onCustomSizeChange
  }: Props = $props();

  function sanitizeCustom(e: Event) {
    const raw = (e.target as HTMLInputElement).value;
    onCustomSizeChange(raw.replace(/[^0-9]/g, '').slice(0, 3));
  }
</script>

<div class="size-section">
  <div class="size-selector">
    <div class="size-track">
      {#each sizePresets as size}
        <button
          class="size-option"
          class:active={!isCustom && targetSize === size}
          onclick={() => onSelectPreset(size)}
          {disabled}
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
          value={customSize}
          onfocus={onEnableCustom}
          oninput={sanitizeCustom}
          {disabled}
        />
        <span class="size-unit">MB</span>
      </div>
    </div>
  </div>
</div>

<style>
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

  @media (max-width: 480px) {
    .size-option {
      min-width: 50px;
      padding: 8px 12px;
    }
  }
</style>
