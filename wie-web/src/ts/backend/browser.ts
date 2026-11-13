import { extractAppMetadata, migrateSaves } from "@pkg";

import { AppLibraryStore } from "../app_library_store";
import type { LibraryApp, Wie } from "../backend";
import { configStore } from "../config_store";
import { resetGameProgress } from "../game_reset";
import { prepareGameArchive } from "../game_update";
import { t } from "../i18n";
import { setMasterVolume, setPcmVolume } from "../midi";
import { startWasmSession } from "./wasm";

export const initializeWie = async (): Promise<Wie> => {
  const store = await AppLibraryStore.open();

  const backend: Wie = {
    rendering: "canvas",
    listApps() {
      return store.list();
    },
    async importApp(file) {
      const archive = new Uint8Array(await file.arrayBuffer());
      const extracted = extractAppMetadata(file.name, archive);
      try {
        const icon = extracted.icon;
        const app: LibraryApp = {
          id: extracted.id,
          title: extracted.title,
          filename: file.name,
          addedAt: Date.now(),
          icon: icon.length ? new Blob([new Uint8Array(icon).buffer]) : undefined,
        };
        // Reimport replaces the archive atomically; PID-scoped saves live separately.
        await store.save(app, await prepareGameArchive(app.id, archive));
      } finally {
        extracted.free();
      }
    },
    deleteApp(id) {
      return store.delete(id);
    },
    async readSettings() {
      return {
        midiVolume: configStore.get("midiVolume"),
        pcmVolume: configStore.get("pcmVolume"),
        helpDismissed: configStore.get("helpDismissed"),
        welcomeSeen: configStore.get("welcomeSeen"),
      };
    },
    async writeSettings(settings) {
      configStore.set("midiVolume", settings.midiVolume);
      configStore.set("pcmVolume", settings.pcmVolume);
      configStore.set("helpDismissed", settings.helpDismissed);
      configStore.set("welcomeSeen", settings.welcomeSeen);
      setMasterVolume(settings.midiVolume);
      setPcmVolume(settings.pcmVolume);
    },
    async startApp(id, onEvent) {
      const [app, archive, settings, fontResponse] = await Promise.all([
        store.getApp(id),
        store.getArchive(id),
        backend.readSettings(),
        fetch(new URL("../../../../assets/neodgm.ttf", import.meta.url)),
      ]);
      if (!app || !archive) throw new Error(t("appFileMissing"));
      const readyArchive = await prepareGameArchive(app.id, archive);
      if (readyArchive !== archive) await store.save(app, readyArchive);
      if (!fontResponse.ok) throw new Error(`Failed to load font: ${fontResponse.status} ${fontResponse.statusText}`);
      const fontData = new Uint8Array(await fontResponse.arrayBuffer());
      await migrateSaves(app.filename, readyArchive, app.id);
      const reset = await resetGameProgress(app.id);
      setMasterVolume(settings.midiVolume);
      setPcmVolume(settings.pcmVolume);
      const session = await startWasmSession(app.filename, readyArchive, fontData, onEvent);
      if (reset) onEvent({ type: "warning", message: "영웅서기 3을 새 게임으로 초기화했어요. 돈 무한 · 제련석 없이 강화 · 성공률 80%" });
      return session;
    },
  };
  return backend;
};
