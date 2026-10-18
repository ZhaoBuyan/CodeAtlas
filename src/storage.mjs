import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { rmFile } from './fsx.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const statVersion = (stat) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
export const fileVersion = (file) => statVersion(fs.statSync(file, { bigint: true }));

export function readStableJson(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const before = statVersion(fs.fstatSync(fd, { bigint: true }));
    const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (before !== statVersion(fs.fstatSync(fd, { bigint: true })) || before !== fileVersion(file)) {
      throw new Error('Bundle changed while being read; retrying on the next request');
    }
    return { value, version: before };
  } finally { fs.closeSync(fd); }
}

/** Each writer owns a unique marker. Dead markers cannot be confused with a new lock. */
export async function withOutputLock(outDir, action) {
  fs.mkdirSync(outDir, { recursive: true });
  let identity = fs.realpathSync(outDir);
  if (process.platform === 'win32') identity = identity.toLowerCase();
  const dir = path.join(os.tmpdir(), `codeatlas-writers-${createHash('sha256').update(identity).digest('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  const own = `writer-${process.pid}-${randomUUID()}.lock`;
  const marker = path.join(dir, own);
  fs.writeFileSync(marker, identity, { flag: 'wx' });
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name === own) continue;
      const match = /^writer-(\d+)-[0-9a-f-]{36}\.lock$/.exec(name);
      if (!match) continue;
      let alive = true;
      try { process.kill(Number(match[1]), 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (alive) throw new Error(`Output directory is already being scanned by process ${match[1]}: ${outDir}`);
      rmFile(path.join(dir, name));
    }
    return await action();
  } finally { rmFile(marker); }
}

/** Rename retries never fall back to truncating the published file. */
export async function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { flag: 'wx' });
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(temporary, file); return; }
      catch (error) {
        if (attempt >= 3 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        await delay([25, 75, 150][attempt]);
      }
    }
  } finally { rmFile(temporary); }
}
