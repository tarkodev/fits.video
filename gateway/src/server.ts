import { loadConfig } from './config.js';
import { createApp } from './app.js';
const config = loadConfig();
const app = createApp(config);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.close(); });
await app.listen({ port: config.port, host: '0.0.0.0' });
