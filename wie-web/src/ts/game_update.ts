import { unzipSync, zipSync } from "fflate";

import { isHeroesLore3 } from "./hl3";

interface BinaryUpdate {
  targetSha256: string;
  targetLength: number;
  sources: Record<string, { length: number; edits: Array<[number, string]> }>;
  resources: Record<string, { sha256: string; data: string }>;
}

let hl3Update: Promise<BinaryUpdate> | undefined;
const loadUpdate = (): Promise<BinaryUpdate> => {
  hl3Update ??= fetch(new URL("../../assets/hl3-normal-v8.json", import.meta.url)).then(async response => {
    if (!response.ok) throw new Error("영웅서기 3 업데이트를 불러오지 못했어요. 연결을 확인하고 다시 실행해 주세요.");
    return response.json() as Promise<BinaryUpdate>;
  }).catch(error => {
    hl3Update = undefined;
    throw error;
  });
  return hl3Update;
};

const digest = async (bytes: Uint8Array): Promise<string> => {
  const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, "0")).join("");
};

const decode = (base64: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(base64), value => value.charCodeAt(0));

/** Archive-only update. PID-scoped progress, display settings and other games stay separate. */
export async function prepareGameArchive(appId: string, archive: Uint8Array, suppliedUpdate?: BinaryUpdate): Promise<Uint8Array> {
  if (!isHeroesLore3(appId)) return archive;
  const update = suppliedUpdate ?? await loadUpdate();
  const outer = unzipSync(archive);
  const jar = outer["0002865E.jar"];
  if (!jar || !outer.app_info) throw new Error("영웅서기 3 정상화 v8 ZIP을 앱 추가로 다시 넣어 주세요. 저장 기록은 유지됩니다.");
  const files = unzipSync(jar);
  const binary = files["binary.mod"];
  if (!binary) throw new Error("영웅서기 3 실행 파일이 없어요.");
  const currentHash = await digest(binary);
  let changed = false;
  if (currentHash !== update.targetSha256) {
    const source = update.sources[currentHash];
    if (!source || source.length !== binary.length) {
      throw new Error("이 영웅서기 3 파일은 자동 갱신 대상과 달라요. 정상화 v8 ZIP을 앱 추가로 넣어 주세요. 저장 기록은 유지됩니다.");
    }
    const next = new Uint8Array(update.targetLength);
    next.set(binary.subarray(0, next.length));
    for (const [offset, bytes] of source.edits) next.set(decode(bytes), offset);
    if (await digest(next) !== update.targetSha256) throw new Error("영웅서기 3 업데이트 검증에 실패했어요. 기존 파일은 변경하지 않았습니다.");
    files["binary.mod"] = next;
    changed = true;
  }
  for (const [name, resource] of Object.entries(update.resources)) {
    if (files[name] && await digest(files[name]) === resource.sha256) continue;
    const next = decode(resource.data);
    if (await digest(next) !== resource.sha256) throw new Error("영웅서기 3 자료 검증에 실패했어요. 다시 실행해 주세요.");
    files[name] = next;
    changed = true;
  }
  if (!changed) return archive;
  outer["0002865E.jar"] = zipSync(files, { level: 6 });
  // app_info is CP949, so edit its ASCII size field without decoding Korean.
  let metadata = Array.from(outer.app_info, value => String.fromCharCode(value)).join("");
  metadata = metadata.replace(/^FSize:\d+/m, `FSize:${outer["0002865E.jar"].length}`);
  outer.app_info = Uint8Array.from(metadata, value => value.charCodeAt(0));
  return zipSync(outer, { level: 0 });
}
