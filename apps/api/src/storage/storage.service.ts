import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { Readable } from 'stream';
import { getAppConfig } from '../config/env';

/**
 * File storage for repair-order images (SRS 2.3). Every caller goes through this interface so the
 * local disk can later be swapped for object storage. Paths are always RELATIVE to the storage root;
 * the database stores only the relative path and no API response ever contains it.
 */
export interface StorageService {
  save(relPath: string, data: Buffer): Promise<void>;
  createReadStream(relPath: string): Readable;
  /** Deleting a file that does not exist is not an error. */
  delete(relPath: string): Promise<void>;
  exists(relPath: string): Promise<boolean>;
}

export class LocalDiskStorage implements StorageService {
  readonly root: string;

  constructor(rootDir: string) {
    this.root = path.resolve(rootDir);
  }

  /** Resolves a relative path and refuses anything that escapes the storage root (path traversal). */
  resolve(relPath: string): string {
    if (typeof relPath !== 'string' || relPath.length === 0 || path.isAbsolute(relPath) || relPath.includes('\0')) {
      throw new Error('Invalid storage path');
    }
    const full = path.resolve(this.root, relPath);
    const rel = path.relative(this.root, full);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error('Storage path escapes the storage root');
    }
    return full;
  }

  async save(relPath: string, data: Buffer): Promise<void> {
    const full = this.resolve(relPath);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    // 'wx': never overwrite an existing file
    await fsp.writeFile(full, data, { flag: 'wx' });
  }

  createReadStream(relPath: string): Readable {
    return fs.createReadStream(this.resolve(relPath));
  }

  async delete(relPath: string): Promise<void> {
    try {
      await fsp.unlink(this.resolve(relPath));
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }

  async exists(relPath: string): Promise<boolean> {
    try {
      const stat = await fsp.stat(this.resolve(relPath));
      return stat.isFile();
    } catch {
      return false;
    }
  }
}

let storage: StorageService | null = null;

/** Storage configured by IMAGE_STORAGE_DIR (relative to the API working directory). */
export function getStorage(): StorageService {
  if (!storage) storage = new LocalDiskStorage(getAppConfig().imageStorageDir);
  return storage;
}
