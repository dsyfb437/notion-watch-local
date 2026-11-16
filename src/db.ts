import type { Page, Update } from "./model";
const databases = new Map<string, Promise<IDBDatabase>>();
function openDatabase(name: string) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => {
      for (const name of ["pages", "updates", "state"])
        r.result.createObjectStore(name, { keyPath: "id" });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
let opened = openDatabase("notion-watch-local");
databases.set("", opened);
// The first subscription keeps the legacy database; later roots have isolated data.
export function activateDatabase(scope: string) {
  if (scope && !/^[a-f0-9]{32}$/.test(scope))
    throw Error("Invalid database scope");
  let database = databases.get(scope);
  if (!database) {
    database = openDatabase(`notion-watch-local-${scope}`);
    databases.set(scope, database);
  }
  opened = database;
}
export async function read<T>(
  store: string,
  id: string,
): Promise<T | undefined> {
  const db = await opened;
  return new Promise((resolve, reject) => {
    const r = db.transaction(store).objectStore(store).get(id);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function all<T>(store: string): Promise<T[]> {
  const db = await opened;
  return new Promise((resolve, reject) => {
    const r = db.transaction(store).objectStore(store).getAll();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function write(store: string, value: unknown) {
  const db = await opened;
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
}
export async function commit(page: Page, update?: Update, runId?: string) {
  const db = await opened;
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["pages", "updates", "state"], "readwrite");
    let reason: unknown;
    const put = () => {
      try {
        tx.objectStore("pages").put(page);
        if (update) {
          const updates = tx.objectStore("updates");
          const existing = updates.get(update.id);
          existing.onsuccess = () => {
            if (!existing.result) updates.put(update);
          };
        }
      } catch (error) {
        reason = error;
        tx.abort();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(reason || tx.error || Error("事务取消"));
    tx.onerror = () => reject(tx.error);
    if (!runId) {
      put();
      return;
    }
    const request = tx.objectStore("state").get("run");
    request.onsuccess = () => {
      if (
        request.result?.runId !== runId ||
        request.result?.status !== "running"
      ) {
        reason = Error("检查已停止");
        tx.abort();
      } else put();
    };
  });
}

// Check the run identity and status in the SAME transaction as the write.
// A stop arriving before this transaction can never be overwritten by a stale checkpoint.
export async function checkpointRun<
  T extends { id: string; runId: string; status: string },
>(next: T) {
  const db = await opened;
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction("state", "readwrite");
    let reason: unknown;
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(reason || tx.error || Error("事务取消"));
    tx.onerror = () => reject(tx.error);
    const request = tx.objectStore("state").get("run");
    request.onsuccess = () => {
      if (
        request.result?.runId !== next.runId ||
        request.result?.status !== "running"
      ) {
        reason = Error("检查已停止");
        tx.abort();
        return;
      }
      try {
        tx.objectStore("state").put(next);
      } catch (error) {
        reason = error;
        tx.abort();
      }
    };
  });
}

// Patch flags transactionally so reading an item cannot race a desktop notification.
export async function patchUpdateFlags(
  ids: string[],
  flags: { read?: boolean; notified?: boolean },
) {
  const db = await opened;
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction("updates", "readwrite");
    const store = tx.objectStore("updates");
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || Error("更新记录写入取消"));
    tx.onerror = () => reject(tx.error);
    for (const id of new Set(ids)) {
      const request = store.get(id);
      request.onsuccess = () => {
        if (request.result) store.put({ ...request.result, ...flags });
      };
    }
  });
}
