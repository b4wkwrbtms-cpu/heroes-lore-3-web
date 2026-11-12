/** Presentation choices use the same PID namespace as game saves. */
const keyFor = (appId: string, key: string): string => `wie_game_${encodeURIComponent(appId)}_${key}`;

export function loadGamePreference(appId: string | undefined, key: string, fallback: string, legacyKey?: string): string {
  if (!appId) return fallback;
  try {
    const storage = window.localStorage;
    const keyName = keyFor(appId, key);
    let value = storage.getItem(keyName);
    // Only the caller that owns a former shared setting may inherit it. Never delete old keys or saves.
    if (value === null && legacyKey) {
      value = storage.getItem(legacyKey);
      if (value !== null) storage.setItem(keyName, value);
    }
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

export function storeGamePreference(appId: string | undefined, key: string, value: string): void {
  if (!appId) return;
  try {
    window.localStorage.setItem(keyFor(appId, key), value);
  } catch {
    // The active session can still use the selected value when storage is unavailable.
  }
}
