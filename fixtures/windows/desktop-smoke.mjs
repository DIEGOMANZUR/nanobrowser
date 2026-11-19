import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'nb-visual-test-'));
const compiler = join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const fixture = join(scratch, 'DesktopFixture.exe');
const output = spawnSync(
  compiler,
  [
    '/nologo',
    '/target:winexe',
    '/reference:System.Windows.Forms.dll',
    '/reference:System.Drawing.dll',
    '/out:' + fixture,
    resolve(here, 'DesktopFixture.cs'),
  ],
  { encoding: 'utf8' },
);
if (output.status !== 0) throw new Error(output.stdout + output.stderr);
const files = ['clicks.txt', 'text.txt', 'ready.txt', 'key.txt', 'scroll.txt'].map(name => join(scratch, name));
const app = spawn(fixture, files, { stdio: 'ignore' });
const binary = join(process.env.LOCALAPPDATA, 'NanobrowserWorkspace', 'NativeHost', 'WorkspaceHost.exe');
const host = spawn(binary, [], { windowsHide: true });
let buffer = Buffer.alloc(0);
let waiting;
host.stdout.on('data', bytes => {
  buffer = Buffer.concat([buffer, bytes]);
  if (buffer.length < 4 || buffer.length < 4 + buffer.readUInt32LE()) return;
  const end = 4 + buffer.readUInt32LE();
  const reply = JSON.parse(buffer.subarray(4, end));
  buffer = buffer.subarray(end);
  if (reply.error) waiting?.reject(new Error(reply.error));
  else waiting?.resolve(reply.data);
});
host.on('error', error => waiting?.reject(error));
host.on('exit', code => waiting?.reject(new Error('The host exited with code ' + code)));

const request = message =>
  new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(message));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    const timeout = setTimeout(() => reject(new Error('The host did not respond.')), 20_000);
    waiting = {
      resolve: data => {
        clearTimeout(timeout);
        resolve(data);
      },
      reject: error => {
        clearTimeout(timeout);
        reject(error);
      },
    };
    host.stdin.write(Buffer.concat([header, body]));
  });

async function waitFor(file, expected, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (existsSync(file) && readFileSync(file, 'utf8') === expected) return;
    await delay(100);
  }
  throw new Error('The synthetic Windows app did not record the expected result.');
}

try {
  await waitFor(files[2], 'ready');
  async function fixtureWindow() {
    const response = await request({ op: 'desktop-windows' });
    return response.windows.find(item => item.app === 'DesktopFixture' && item.title === 'Nanobrowser Visual Fixture');
  }
  let window = await fixtureWindow();
  assert(window, 'The Windows fixture was not enumerated.');
  console.log('Fixture ready. Windows foreground at enumeration: ' + window.foreground);
  if (process.argv.includes('--await-focus')) {
    console.log('Focus Nanobrowser Visual Fixture to continue.');
    for (let attempt = 0; attempt < 400 && !window?.foreground; attempt++) {
      await delay(200);
      window = await fixtureWindow();
    }
    assert(window?.foreground, 'Windows did not bring the synthetic fixture to the foreground.');
  }
  const capture = () => request({ op: 'desktop-snapshot', windowId: window.id });
  const first = await capture();
  console.log('Captured fixture.');
  assert(first.width > 0 && first.height > 0 && Buffer.from(first.data, 'base64').readUInt16BE() === 0xffd8);
  const typed = await request({
    op: 'desktop-act',
    action: 'type',
    snapshotId: first.snapshotId,
    text: 'Nota de prueba á',
  });
  assert(typed.complete);
  await waitFor(files[1], 'Nota de prueba á');
  console.log('Verified inserted text.');
  const keyFrame = await capture();
  assert(
    (await request({ op: 'desktop-act', action: 'key', snapshotId: keyFrame.snapshotId, key: 'ArrowRight' })).complete,
  );
  await waitFor(files[3], 'key');
  const scrollFrame = await capture();
  assert(
    (
      await request({
        op: 'desktop-act',
        action: 'scroll',
        snapshotId: scrollFrame.snapshotId,
        x: Math.floor((scrollFrame.width * 105) / 520),
        y: Math.floor((scrollFrame.height * 69) / 320),
        scroll: -1,
      })
    ).complete,
  );
  await waitFor(files[4], 'scroll');
  const second = await capture();
  const clicked = await request({
    op: 'desktop-act',
    action: 'click',
    snapshotId: second.snapshotId,
    x: Math.floor((second.width * 115) / 520),
    y: Math.floor((second.height * 144) / 320),
  });
  assert(clicked.complete);
  await waitFor(files[0], 'click\n');
  await assert.rejects(
    request({ op: 'desktop-act', action: 'click', snapshotId: second.snapshotId, x: 100, y: 144 }),
    /screenshot/i,
  );
  assert((await capture()).snapshotId !== second.snapshotId);
  console.log(
    'PASS visual Windows fixture: window, screenshot, Unicode text, click, key, scroll, stale capture refusal',
  );
} finally {
  host.stdin.end();
  host.kill();
  app.kill();
}
