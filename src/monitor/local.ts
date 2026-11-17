import { resolve } from 'node:path';

import { runLocalMonitor } from './runtime.js';

const args = process.argv.slice(2);
const rootIndex = args.indexOf('--monitor-root');
let root = process.env.PAGE_MONITOR_ROOT ?? resolve('data/local-monitor');
if (rootIndex >= 0) {
  const value = args[rootIndex + 1];
  if (!value) throw new Error('--monitor-root needs a directory');
  root = resolve(value);
  args.splice(rootIndex, 2);
}
await runLocalMonitor(root, args);
