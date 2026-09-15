import http from 'node:http';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';

const key = process.env.MCP_API_KEY;
if (!key || key.length < 32) {
  console.error('Set MCP_API_KEY to a random secret of at least 32 characters.');
  process.exit(1);
}
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 8000) {
  console.error('PORT must be a valid port other than the internal bridge port 8000.');
  process.exit(1);
}
const bridge = spawn('supergateway', [
  '--stdio', 'node dist/index.js',
  '--outputTransport', 'streamableHttp',
  '--stateful', '--sessionTimeout', '3600000',
  '--port', '8000', '--streamableHttpPath', '/mcp'
], { stdio: 'inherit', env: process.env });
bridge.on('error', () => {
  console.error('Unable to start the HTTP bridge.');
  process.exit(1);
});
bridge.on('exit', (code) => process.exit(code || 1));

const expected = Buffer.from(`Bearer ${key}`);
const server = http.createServer((req, res) => {
  // This probes the HTTP bridge only, not Meta token validity.
  if (req.url === '/health' && req.method === 'GET') {
    const probe = http.get('http://127.0.0.1:8000/mcp', (upstream) => {
      upstream.resume();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"ok","check":"http-bridge"}');
    });
    probe.setTimeout(3000, () => probe.destroy());
    probe.on('error', () => { res.writeHead(503); res.end('Bridge not ready'); });
    return;
  }
  const supplied = Buffer.from(req.headers.authorization || '');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Bearer' });
    res.end('Unauthorized');
    return;
  }
  if (req.url?.split('?')[0] !== '/mcp') {
    res.writeHead(404); res.end('Not found'); return;
  }
  const headers = { ...req.headers, host: '127.0.0.1:8000' };
  delete headers.authorization;
  const upstream = http.request({
    hostname: '127.0.0.1', port: 8000,
    path: req.url, method: req.method, headers
  }, (response) => {
    res.writeHead(response.statusCode || 502, response.headers);
    response.pipe(res);
  });
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end('Bridge unavailable');
  });
  req.on('aborted', () => upstream.destroy());
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
});
server.requestTimeout = 0;
server.listen(port, '0.0.0.0', () => {
  console.log(`Authenticated MCP endpoint listening on 0.0.0.0:${port}/mcp`);
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    bridge.kill(signal);
    server.close();
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
