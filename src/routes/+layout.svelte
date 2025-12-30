<script lang="ts">
  import '../app.css';
  
  interface Props {
    children: import('svelte').Snippet;
  }

  let { children }: Props = $props();
</script>

<svelte:head>
  <meta name="robots" content="index, follow" />
</svelte:head>

<main>
  {@render children()}
</main>

<style>
  main {
    min-height: 100vh;
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: var(--spacing);
    padding-top: calc(env(safe-area-inset-top) + var(--spacing));
    padding-bottom: calc(env(safe-area-inset-bottom) + var(--spacing));
  }
</style>
