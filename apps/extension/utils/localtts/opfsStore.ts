import type { ModelReader, ModelStore, PartWriter } from '@nvt/core';

const DONE_FILE = '_done.json';
const fname = (path: string): string => path.replaceAll('/', '__');
const hex = (buf: ArrayBuffer): string => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Model files in the extension origin's OPFS (persistent, survives browser restarts, no size cap besides disk quota).
 * One directory per model revision; older revisions are removed by pruneOld(). Completion is tracked in _done.json.
 */
export class OpfsModelStore implements ModelStore, ModelReader {
  private done: Set<string> | undefined;
  private readonly dirName: string;

  constructor(
    private readonly pack: string,
    rev: string,
  ) {
    this.dirName = `nvt-${pack}-${rev.slice(0, 12)}`;
  }

  private async dir(): Promise<FileSystemDirectoryHandle> {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle(this.dirName, { create: true });
  }

  private async file(path: string, create = false): Promise<FileSystemFileHandle | null> {
    try {
      return await (await this.dir()).getFileHandle(fname(path), { create });
    } catch (e) {
      if ((e as DOMException).name === 'NotFoundError') return null;
      throw e;
    }
  }

  private async doneSet(): Promise<Set<string>> {
    if (this.done) return this.done;
    const fh = await this.file(DONE_FILE);
    let arr: string[] = [];
    if (fh) {
      try {
        arr = JSON.parse(await (await fh.getFile()).text()) as string[];
      } catch {
        arr = [];
      }
    }
    return (this.done = new Set(arr));
  }

  private async saveDone(): Promise<void> {
    const fh = (await this.file(DONE_FILE, true))!;
    const w = await fh.createWritable();
    await w.write(JSON.stringify([...(await this.doneSet())]));
    await w.close();
  }

  async size(path: string): Promise<number> {
    const fh = await this.file(path);
    return fh ? (await fh.getFile()).size : 0;
  }

  async isDone(path: string): Promise<boolean> {
    return (await this.doneSet()).has(path);
  }

  async markDone(path: string): Promise<void> {
    (await this.doneSet()).add(path);
    await this.saveDone();
  }

  async open(path: string, offset: number): Promise<PartWriter> {
    const fh = (await this.file(path, true))!;
    if ((await this.doneSet()).delete(path)) await this.saveDone();
    const openAt = async (keep: boolean, pos: number): Promise<FileSystemWritableFileStream> => {
      const w = await fh.createWritable({ keepExistingData: keep });
      if (keep) await w.truncate(pos);
      await w.seek(pos);
      return w;
    };
    let pos = offset;
    let w = await openAt(offset > 0, offset);
    return {
      async write(chunk) {
        await w.write(chunk as unknown as FileSystemWriteChunkType);
        pos += chunk.length;
      },
      async checkpoint() {
        await w.close(); // OPFS writables only become visible on close
        w = await openAt(true, pos);
      },
      async close() {
        await w.close();
      },
    };
  }

  async remove(path: string): Promise<void> {
    try {
      await (await this.dir()).removeEntry(fname(path));
    } catch (e) {
      if ((e as DOMException).name !== 'NotFoundError') throw e;
    }
    if ((await this.doneSet()).delete(path)) await this.saveDone();
  }

  async sha256(path: string): Promise<string> {
    const fh = await this.file(path);
    if (!fh) throw new Error(`missing ${path}`);
    return hex(await crypto.subtle.digest('SHA-256', await (await fh.getFile()).arrayBuffer()));
  }

  async read(path: string): Promise<ArrayBuffer> {
    const fh = await this.file(path);
    if (!fh) throw new Error(`missing ${path}`);
    return (await fh.getFile()).arrayBuffer();
  }

  /** deletes this revision's files (model removal) */
  async clear(): Promise<void> {
    this.done = undefined;
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(this.dirName, { recursive: true }).catch(() => {});
  }

  /** removes directories of other model revisions */
  async pruneOld(): Promise<void> {
    const root = (await navigator.storage.getDirectory()) as FileSystemDirectoryHandle & { keys(): AsyncIterable<string> };
    for await (const k of root.keys()) if (k.startsWith(`nvt-${this.pack}-`) && k !== this.dirName) await root.removeEntry(k, { recursive: true }).catch(() => {});
  }
}
