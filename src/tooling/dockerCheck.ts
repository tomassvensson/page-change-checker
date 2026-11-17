import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export type DockerRun = (args: string[]) => string;
export function checkDocker(
  run: DockerRun = (args) =>
    execFileSync('docker', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      timeout: 600000
    })
) {
  run(['compose', 'config', '--quiet']);
  const image = run(['build', '--quiet', '.']).trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(image))
    throw new Error('Docker did not return a content-addressed image ID');
  if (run(['run', '--rm', '--entrypoint', 'id', image, '-u']).trim() !== '1000')
    throw new Error('Docker runtime must use the non-root user');
  run(['run', '--rm', image, '--version']);
  run([
    'run',
    '--rm',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--shm-size',
    '1g',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=256m',
    '--tmpfs',
    '/home/node/.cache:rw,noexec,nosuid,size=128m',
    '--tmpfs',
    '/home/node/.config:rw,noexec,nosuid,size=16m',
    '--entrypoint',
    'node',
    image,
    '--input-type=module',
    '-e',
    "import { chromium } from 'playwright'; const context = await chromium.launchPersistentContext('/tmp/profile', { headless: true }); try { const page = await context.newPage(); await page.goto('data:text/html,<h1>ok</h1>'); if (await page.textContent('h1') !== 'ok') throw new Error('Unexpected browser content'); } finally { await context.close(); }"
  ]);
  console.log('Docker Compose, image build, non-root CLI and hardened Chromium passed.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  checkDocker();
