import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { atomicWrite } from './journal.js';

/** Exclusive creation is the existence check. A competing writer cannot cause
 * overwrite or a check/use race; an already frozen archive remains unchanged. */
function writeOnce(path: string, content: Buffer) {
  try {
    writeFileSync(path, content, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

/** Content-addressed local archive. Metadata survives expiry; statistical history
 * is never pruned. No remote URL, filesystem path or executable input is accepted. */
export class EvidenceStore {
  constructor(
    private root: string,
    private days = 90
  ) {
    mkdirSync(root, { recursive: true });
  }
  put(bundle: unknown, png?: Buffer, now = new Date().toISOString()) {
    const json = JSON.stringify(bundle),
      id = createHash('sha256')
        .update(json)
        .update(png ?? '')
        .digest('hex');
    if (png) writeOnce(join(this.root, `${id}.png`), png);
    atomicWrite(
      join(this.root, `${id}.json`),
      JSON.stringify({
        id,
        created: now,
        expires: new Date(Date.parse(now) + this.days * 86400000).toISOString(),
        bundle,
        png: Boolean(png),
        expired: false
      })
    );
    return id;
  }
  get(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid evidence identity');
    return JSON.parse(readFileSync(join(this.root, `${id}.json`), 'utf8')) as {
      id: string;
      created: string;
      expires: string;
      bundle: unknown;
      png: boolean;
      expired: boolean;
    };
  }
  imagePath(id: string) {
    const meta = this.get(id);
    return meta.png && !meta.expired ? join(this.root, `${id}.png`) : null;
  }
  expire(now = new Date().toISOString(), retainIds: string[] = []) {
    const retained = new Set(retainIds);
    let count = 0;
    for (const file of readdirSync(this.root).filter((f) => /^[a-f0-9]{64}\.json$/.test(f))) {
      const id = file.slice(0, -5),
        meta = this.get(id);
      if (!meta.expired && meta.expires < now && !retained.has(id)) {
        rmSync(join(this.root, `${id}.png`), { force: true });
        atomicWrite(
          join(this.root, file),
          JSON.stringify({ ...meta, bundle: null, expired: true })
        );
        count++;
      }
    }
    return count;
  }
  archiveMail(id: string, payload: string) {
    const name = createHash('sha256').update(id).digest('hex') + '.mail.json.gz',
      path = join(this.root, name);
    writeOnce(path, gzipSync(payload));
    return name;
  }
}
