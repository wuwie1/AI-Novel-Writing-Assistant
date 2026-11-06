import { createMacHttpServer } from './proxy.mjs';

const required = ['MAC_API_TARGET', 'MAC_RENDERER_ROOT', 'MAC_MODE', 'MAC_PORT'];
for (const key of required) if (!process.env[key]) throw new Error(`Missing ${key}`);
const server = createMacHttpServer({
  apiTarget: process.env.MAC_API_TARGET,
  rendererRoot: process.env.MAC_RENDERER_ROOT,
  appVersion: process.env.MAC_APP_VERSION ?? '0.0.0',
  mode: process.env.MAC_MODE,
  backendIdentity: process.env.MAC_BACKEND_IDENTITY ?? null,
  serviceReady: () => true,
});
server.listen(Number(process.env.MAC_PORT), '127.0.0.1');
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
