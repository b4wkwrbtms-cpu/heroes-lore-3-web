import { clearRetiredCheats } from "./cheat_policy";
import { isHeroesLore3 } from "./hl3";

const RESET_KEY = "wie_hl3_fresh_v8";

const deleteLegacyRecords = (pid: string): Promise<void> => new Promise((resolve, reject) => {
  const request = indexedDB.deleteDatabase(`wie_${pid}`);
  request.onsuccess = () => resolve();
  request.onerror = () => reject(request.error);
  request.onblocked = () => reject(new Error("다른 창에서 실행 중인 영웅서기 3을 닫고 다시 실행해 주세요."));
});

const clearProgressFiles = (pid: string): Promise<void> => new Promise((resolve, reject) => {
  // The normal save migration has already opened/created this database.
  const request = indexedDB.open("wie_filesystem", 2);
  request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const db = request.result;
    const tx = db.transaction("files", "readwrite");
    const store = tx.objectStore("files");
    // AID and title are not unique. Delete only this exact PID's files.
    const cursor = store.openCursor(IDBKeyRange.bound([pid], [pid, []]));
    cursor.onsuccess = () => {
      const row = cursor.result;
      if (!row) return;
      row.delete();
      row.continue();
    };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onabort = () => { db.close(); reject(tx.error); };
  };
});

/** User-requested fresh start, once for the recipient edition, never on later launches. */
export async function resetGameProgress(appId: string): Promise<boolean> {
  if (!isHeroesLore3(appId)) return false;
  return navigator.locks.request("wie-hl3-fresh-v8", async () => {
    if (window.localStorage.getItem(RESET_KEY) === "done") return false;
    // Check writable completion storage before touching progress. Without it,
    // a browser could erase each newly saved game again on every launch.
    window.localStorage.setItem(RESET_KEY, "pending");
    await deleteLegacyRecords(appId);
    await clearProgressFiles(appId);
    clearRetiredCheats(appId);
    window.localStorage.setItem(RESET_KEY, "done");
    return true;
  });
}
