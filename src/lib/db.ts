import type { Track } from "../types";

export interface StoredTrack extends Omit<Track, "src" | "cover"> {
  blob: Blob;
  coverBlob?: Blob;
  coverFallback?: string;
}

const DB_NAME = "matemusic";
const STORE = "tracks";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const req = fn(store);
    let result: T | undefined;
    if (req) req.onsuccess = () => (result = req.result);
    t.oncomplete = () => {
      db.close();
      resolve(result);
    };
    t.onerror = () => {
      db.close();
      reject(t.error);
    };
  });
}

export const db = {
  async all(): Promise<StoredTrack[]> {
    try {
      return ((await tx<StoredTrack[]>("readonly", (s) => s.getAll())) || []) as StoredTrack[];
    } catch {
      return [];
    }
  },
  async put(rec: StoredTrack) {
    try {
      await tx("readwrite", (s) => s.put(rec));
    } catch (e) {
      console.warn("[MateMusic] IndexedDB put failed", e);
    }
  },
  async patch(id: string, patch: Partial<StoredTrack>) {
    try {
      const cur = await tx<StoredTrack>("readonly", (s) => s.get(id));
      if (cur) await tx("readwrite", (s) => s.put({ ...cur, ...patch }));
    } catch (e) {
      console.warn("[MateMusic] IndexedDB patch failed", e);
    }
  },
  async remove(id: string) {
    try {
      await tx("readwrite", (s) => s.delete(id));
    } catch (e) {
      console.warn("[MateMusic] IndexedDB delete failed", e);
    }
  },
  async clear() {
    try {
      await tx("readwrite", (s) => s.clear());
    } catch (e) {
      console.warn("[MateMusic] IndexedDB clear failed", e);
    }
  },
};
