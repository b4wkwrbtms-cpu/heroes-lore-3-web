import { isTauri } from "@tauri-apps/api/core";

export interface LibraryApp {
  id: string;
  title: string;
  filename: string;
  icon?: Blob;
  addedAt: number;
}

export interface Settings {
  midiVolume: number;
  pcmVolume: number;
  helpDismissed: boolean;
  welcomeSeen: boolean;
}

export type SessionEvent =
  | { type: "ready" }
  | { type: "frame" }
  | { type: "suspended"; suspended: boolean }
  | { type: "warning"; message: string }
  | { type: "stopped"; failed: boolean }
  | { type: "error"; message: string; cause?: unknown };

/** Live guest-memory access for the cheat tool. Values are unsigned; `width` is 1, 2 or 4 bytes. */
export interface CheatApi {
  memorySize(): number;
  /** Flattened [start, size, start, size, ...] of mapped guest memory. */
  memoryRanges(): Uint32Array;
  dump(address: number, size: number): Uint8Array;
  writeBytes(address: number, data: Uint8Array): void;
  search(value: number, width: number, bigEndian: boolean, previous?: Uint32Array): Uint32Array;
  read(address: number, width: number, bigEndian: boolean): number;
  write(address: number, width: number, bigEndian: boolean, value: number): void;
  freeze(address: number, width: number, bigEndian: boolean, value: number): void;
  unfreeze(address: number): void;
  clearFreezes(): void;
}

export interface PlayerSession {
  key(key: string, pressed: boolean): Promise<void>;
  releaseKeys(): Promise<void>;
  stop(): Promise<void>;
  cheats?: CheatApi;
  /** Original imported resources; available on the browser/WASM backend. */
  readResources?(prefixes: string[]): Map<string, Uint8Array>;
  /** Holds the game still for a moment (a hit-stop); available on the browser/WASM backend. */
  hold?(ms: number): void;
}

export interface Wie {
  readonly rendering: "canvas" | "native";
  listApps(): Promise<LibraryApp[]>;
  importApp(file: File): Promise<void>;
  deleteApp(id: string): Promise<void>;
  readSettings(): Promise<Settings>;
  writeSettings(settings: Settings): Promise<void>;
  startApp(id: string, onEvent: (event: SessionEvent) => void): Promise<PlayerSession | undefined>;
}

export const initializeWie = async (): Promise<Wie> => {
  const backend = isTauri()
    ? await import("./backend/tauri")
    : await import("./backend/browser");

  return backend.initializeWie();
};
