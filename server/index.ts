import { createApp } from './app.js';

const configuredMode = process.env.PICKLE_MODE ?? 'local';
if (configuredMode !== 'local' && configuredMode !== 'demo')
  throw new Error('PICKLE_MODE must be local or demo.');
const port = Number(process.env.PORT ?? 3001);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT must be a valid TCP port.');
const app = createApp({
  mode: configuredMode,
  port,
  publicOrigin: process.env.PICKLE_PUBLIC_ORIGIN,
  staticDir: 'dist',
});
const server = app.listen(port, configuredMode === 'local' ? '127.0.0.1' : '0.0.0.0', () => {
  console.log(`Pickle ${configuredMode} service listening on port ${port}.`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    server.close();
    void app.dispose().then(() => process.exit(0));
  });
