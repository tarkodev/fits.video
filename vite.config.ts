import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, loadEnv } from 'vite';

function required(env: Record<string, string | undefined>, key: string): string {
	const value = env[key]?.trim();
	if (!value) {
		throw new Error(
			`Missing required env var ${key}. Copy .env.example to .env and fill it in.`
		);
	}
	return value;
}

function requiredBoolean(env: Record<string, string | undefined>, key: string): string {
	const value = required(env, key).toLowerCase();
	if (value !== 'true' && value !== 'false') {
		throw new Error(`${key} must be "true" or "false"`);
	}
	return value;
}

export default defineConfig(({ mode }) => {
	// Load every variable from .env files (no PUBLIC_ prefix filter):
	// these are server-side dev knobs and are never bundled into the client.
	const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };

	required(env, 'PUBLIC_API_URL');
	const apiAuthEnabled = requiredBoolean(env, 'PUBLIC_API_AUTH_ENABLED') === 'true';
	if (apiAuthEnabled) {
		required(env, 'PUBLIC_API_AUTH_USER');
		required(env, 'PUBLIC_API_AUTH_PASS');
	}

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
