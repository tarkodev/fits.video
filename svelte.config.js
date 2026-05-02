import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter({
			pages: 'build',
			assets: 'build',
			// Use a name other than index.html so the prerendered `/` page is
			// not overwritten by the SPA shell (silences adapter-static warning).
			// Nginx still uses index.html for `/` and try_files below.
			fallback: '200.html',
			precompress: false,
			strict: true
		}),
		env: {
			publicPrefix: 'PUBLIC_'
		}
	}
};

export default config;
