import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, loadEnv } from 'vite';

function required(env: Record<string, string>, key: string): string {
	const value = env[key]?.trim();
	if (!value) {
		throw new Error(
			`Missing required env var ${key}. Copy .env.example to .env and fill it in.`
		);
	}
	return value;
}

export default defineConfig(({ mode }) => {
	// Load every variable from .env files (no PUBLIC_ prefix filter):
	// these are server-side dev knobs and are never bundled into the client.
	const env = loadEnv(mode, process.cwd(), '');

	const host = required(env, 'WEB_HOST');
	const port = Number(required(env, 'WEB_PORT'));
	if (!Number.isFinite(port) || port <= 0) {
		throw new Error(`Invalid WEB_PORT: ${env.WEB_PORT}`);
	}

	const allowedHostsRaw = required(env, 'DEV_ALLOWED_HOSTS');
	const allowedHosts: string[] | true =
		allowedHostsRaw === '*'
			? true
			: allowedHostsRaw.split(',').map((s) => s.trim()).filter(Boolean);

	return {
		plugins: [sveltekit()],
		server: {
			host,
			port,
			allowedHosts
		}
	};
});
