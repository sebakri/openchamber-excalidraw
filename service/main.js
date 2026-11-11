// Local service for the Excalidraw extension: puts a PNG on the system
// clipboard. An extension frame has no image clipboard, so the editor sends
// the PNG here as base64 and this process copies it.
//
// The host starts it (node, no dependencies), binds it to 127.0.0.1 and passes
// OPENCHAMBER_SERVICE_PORT / OPENCHAMBER_SERVICE_TOKEN. Routes:
//   GET  /health
//   POST /copy-png  { data: <base64 PNG> }
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_BODY_BYTES = 40 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN;
if (!Number.isInteger(port) || !token) {
  console.error('OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required');
  process.exit(1);
}

const fail = (status, message) => Object.assign(new Error(message), { status });
const send = (response, status, body) => {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
};

const run = (command, args, input) => new Promise((resolve, reject) => {
  const child = execFile(command, args, { timeout: 15000 }, (error, _stdout, stderr) => {
    if (error) reject(new Error(`${command} failed: ${stderr.trim() || error.message}`));
    else resolve();
  });
  if (input) child.stdin.end(input);
});

/** Copies the PNG file at `file` to the clipboard using the platform's tools. */
const copyFile = async (file, bytes) => {
  if (process.platform === 'darwin') {
    await run('osascript', ['-e', `set the clipboard to (read (POSIX file "${file}") as «class PNGf»)`]);
  } else if (process.platform === 'win32') {
    await run('powershell', ['-NoProfile', '-Command',
      `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; [System.Windows.Forms.Clipboard]::SetImage([System.Drawing.Image]::FromFile('${file}'))`]);
  } else if (process.env.WAYLAND_DISPLAY) {
    await run('wl-copy', ['--type', 'image/png'], bytes);
  } else {
    await run('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-i', file]);
  }
};

const readBody = async (request) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw fail(413, 'Body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
};

const server = createServer(async (request, response) => {
  if (request.headers.authorization !== `Bearer ${token}`) return send(response, 401, { error: 'Unauthorized' });
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  try {
    if (request.method === 'GET' && url.pathname === '/health') return send(response, 200, { ok: true });
    if (request.method === 'POST' && url.pathname === '/copy-png') {
      const { data } = JSON.parse(await readBody(request));
      if (typeof data !== 'string') throw fail(400, 'data must be base64 text');
      const bytes = Buffer.from(data, 'base64');
      if (bytes.length < PNG_MAGIC.length || !bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) throw fail(400, 'data is not a PNG');
      const dir = await mkdtemp(join(tmpdir(), 'oc-excalidraw-'));
      try {
        const file = join(dir, 'drawing.png');
        await writeFile(file, bytes);
        await copyFile(file, bytes);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      return send(response, 200, { copied: true, bytes: bytes.length });
    }
    return send(response, 404, { error: 'Not found' });
  } catch (error) {
    const status = typeof error?.status === 'number' ? error.status : error instanceof SyntaxError ? 400 : 500;
    return send(response, status, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, '127.0.0.1');
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
