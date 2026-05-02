import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
	// Load every variable from .env files (no PUBLIC_ prefix filter):
	// these are server-side dev knobs and are never bundled into the client.
	const env = loadEnv(mode, process.cwd(), '');

	const port = env.DEV_PORT ? Number(env.DEV_PORT) : 8002;
	const host = env.DEV_HOST?.trim() || '0.0.0.0';

	const allowedHostsRaw = env.DEV_ALLOWED_HOSTS?.trim();
	const allowedHosts: string[] | true =
		allowedHostsRaw === '*'
			? true
			: allowedHostsRaw
				? allowedHostsRaw.split(',').map((s) => s.trim()).filter(Boolean)
				: [];

	const hmrHost = env.DEV_HMR_HOST?.trim();
	const hmrProtocol = env.DEV_HMR_PROTOCOL?.trim() as 'ws' | 'wss' | undefined;
	const hmrClientPort = env.DEV_HMR_CLIENT_PORT
		? Number(env.DEV_HMR_CLIENT_PORT)
		: undefined;

	return {
		plugins: [sveltekit()],
		server: {
			port,
			host,
			allowedHosts,
			...(hmrHost
				? {
						hmr: {
							host: hmrHost,
							protocol: hmrProtocol,
							clientPort: hmrClientPort
						}
					}
				: {})
		}
	};
});
