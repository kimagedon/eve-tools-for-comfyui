/**
 * The session survives a reload: one IndexedDB record holding the stills,
 * plates, takes (as Blobs) and the plan (lights, cameras, cut) as plain
 * data. Best effort — a private window or a full disk just means no restore.
 */
const DB = "eve-tools";
const STORE = "session";
const KEY = "current";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function loadSession<T>(): Promise<T | null> {
  try { return ((await tx("readonly", (s) => s.get(KEY))) as T | undefined) ?? null; } catch { return null; }
}

export async function saveSession<T>(value: T): Promise<void> {
  try { await tx("readwrite", (s) => s.put(value, KEY)); } catch { /* no restore this time */ }
}

export async function clearSession(): Promise<void> {
  try { await tx("readwrite", (s) => s.delete(KEY)); } catch { /* nothing to clear */ }
}
