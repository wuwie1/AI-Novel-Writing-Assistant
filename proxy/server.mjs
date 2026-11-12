import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProxyConfig, PROXY_PORT } from './infrastructure/config.mjs';
import { forwardRequest } from './infrastructure/forward.mjs';

export function createProxyServer({ upstream, owner = '' }) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ service: 'ai-novel-local-proxy', owner }));
      return;
    }
    forwardRequest(req, res, upstream);
  });
  server.requestTimeout = 0;
  server.on('clientError', (_error, socket) => socket.destroy());
  return server;
}

async function main() {
  const config = await loadProxyConfig(fileURLToPath(new URL('./config.toml', import.meta.url)));
  const server = createProxyServer({ ...config, owner: process.argv[2] ?? '' });
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  const stop = () => { server.close(); for (const socket of sockets) socket.destroy(); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PROXY_PORT, '127.0.0.1', resolve);
  });
  server.on('error', () => { stop(); process.exitCode = 1; });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // The proxy never writes access, error, body or credential logs.
  main().catch(() => { process.exitCode = 1; });
}
