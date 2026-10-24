import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';

const SCRIPT = path.resolve(__dirname, '../../scripts/post-deploy-checks.sh');

function run(env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', [SCRIPT], {
      env: { ...process.env, SKIP_KUBE: '1', READY_CHECKS: '2', READY_INTERVAL: '0', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('post-deploy checks pass when readiness, lag and cursor are healthy', async () => {
  let cursor = 1000;
  const server = http.createServer((req, res) => {
    if (req.url === '/readyz') {
      res.writeHead(200).end('ok');
      return;
    }
    if (req.url === '/status') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ latestLedger: 1050, lastLedger: cursor++ }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const result = await run({
    API_URL: `http://127.0.0.1:${port}`,
    INDEXER_STATUS_URL: `http://127.0.0.1:${port}/status`,
    MAX_INDEXER_LAG_LEDGERS: '120',
  });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /readiness held/);
  assert.match(result.stdout, /indexer cursor advanced/);
});

test('post-deploy checks fail when readiness does not hold', async () => {
  const server = http.createServer((_req, res) => res.writeHead(500).end('no'));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const result = await run({ API_URL: `http://127.0.0.1:${port}` });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /readiness did not hold/);
});
