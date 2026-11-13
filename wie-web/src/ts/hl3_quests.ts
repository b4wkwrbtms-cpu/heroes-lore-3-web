import type { CheatApi } from "./backend";
import { isHeroesLore3, isHeroesLore3Binary, readBag } from "./hl3";
import { cameraOffset } from "./hl3_hits";

const G = 0x01503ab0;
const heap = (p: number) => p >= 0x40000000 && p < 0x50000000;
const s16 = (n: number) => (n << 16) >> 16;
const normalize = (s: string) => s.replace(/\s/g, "");
const decoder = new TextDecoder("euc-kr", { fatal: true });
const lengths = [3,3,2,2,2,1,2,2,5,4,4,4,3,2,2,1,1,1,3,4,3,4,1,4,1,1,4,1,1,3,1,4,4,1,2,2,1,1,2,1,4,1,1,4,2,2,4,3,2,1,1,2,1,1,3,5,4,3];

class Reader {
  offset = 0;
  constructor(readonly bytes: Uint8Array) {}
  take(size: number): Uint8Array {
    if (size < 0 || this.offset + size > this.bytes.length) throw new Error("Incomplete quest resource");
    const b = this.bytes.subarray(this.offset, this.offset + size);
    this.offset += size;
    return b;
  }
  byte(): number { return this.take(1)[0]; }
  text(size: number): string { return decoder.decode(this.take(size)).replace(/\0+$/, ""); }
}

export interface QuestText { title: string; description: string; location: string; category: string }
interface Action { commands: number[][]; choice: boolean }
export interface QuestScene {
  id: number;
  map: number;
  name: string;
  triggers: Uint8Array[];
  actions: Action[];
}

/** 0x54188/0x5439c: length-prefixed CP949 records from the player's original archive. */
export function parseQuestText(bytes: Uint8Array): QuestText[] {
  const r = new Reader(bytes), result: QuestText[] = [];
  while (r.offset < bytes.length) {
    const size = r.byte() | (r.byte() << 8), end = r.offset + size;
    const fields = Array.from({ length: 4 }, () => r.text(r.byte()));
    if (r.offset !== end) throw new Error("Unknown quest text format");
    result.push({ title: fields[0], description: fields[1], location: fields[2], category: fields[3] });
  }
  return result;
}

function parseAction(bytes: Uint8Array, depth = 0): Action {
  if (depth > 12) throw new Error("Invalid event nesting");
  const r = new Reader(bytes), commands: number[][] = [];
  let choice = false;
  while (r.offset < bytes.length) {
    const op = r.byte();
    if (op === 255) {
      choice = true;
      r.byte();
      const count = r.byte(), header = r.take(count * 2);
      for (let i = 0; i < count; i++) commands.push(...parseAction(r.take(header[i * 2 + 1]), depth + 1).commands);
    } else {
      if (op >= lengths.length) throw new Error("Unknown event command");
      commands.push([op, ...r.take(lengths[op])]);
    }
  }
  return { commands, choice };
}

/** 0x51f90: two length-indexed bytecode groups followed by the scene's strings. */
export function parseQuestScene(id: number, bytes: Uint8Array): QuestScene {
  const r = new Reader(bytes), header = r.take(9);
  const group = () => Array.from(r.take(r.byte()), size => r.take(size));
  const triggers = group(), actions = group().map(b => parseAction(b));
  const sizes = r.take(r.byte());
  const strings = Array.from(sizes, size => r.text(size));
  if (r.offset !== bytes.length) throw new Error("Unknown scene format");
  return { id, map: header[0], name: strings[0] ?? "", triggers, actions };
}

export interface QuestConditions {
  quest: Uint8Array;
  local: Uint8Array;
  level: number;
  gold: number;
  itemCount(category: number, index: number): number;
}

/** 0x52148/0x3beac. First matching branch wins. Unknown bytecode closes the route. */
export function resolveQuestTrigger(bytes: Uint8Array, state: QuestConditions, depth = 0): number[] | undefined {
  if (depth > 12) return undefined;
  const r = new Reader(bytes), actions: number[] = [];
  try {
    while (r.offset < bytes.length) {
      const token = r.byte();
      if (token === 255) {
        const sizes = r.take(r.byte());
        const branches = Array.from(sizes, size => r.take(size));
        for (const branch of branches) {
          const found = resolveQuestTrigger(branch, state, depth + 1);
          if (found === undefined) return undefined;
          if (found.length) { actions.push(...found); break; }
        }
      } else if (token >= 250) {
        let pass: boolean;
        if (token === 250 || token === 251) {
          const id = r.byte(), value = r.byte();
          pass = token === 250 ? state.local[id] === value : id === 0 || state.quest[id] === value;
        } else if (token === 253) {
          const level = r.byte(), comparison = r.byte();
          if (comparison > 1) return undefined;
          pass = comparison === 0 ? state.level < level : state.level >= level;
        } else if (token === 252) {
          const b = r.take(4), gold = new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true), comparison = r.byte();
          if (comparison > 1) return undefined;
          pass = comparison === 0 ? state.gold < gold : state.gold >= gold;
        } else {
          const category = r.byte(), index = r.byte(), count = r.byte();
          pass = state.itemCount(category, index) >= count;
        }
        if (!pass) return actions;
      } else if (token < 128) actions.push(token);
      else return undefined;
    }
    return actions;
  } catch { return undefined; }
}

export class Hl3QuestResources {
  readonly texts = new Map<string, QuestText[]>();
  readonly scenes = new Map<number, QuestScene>();
  constructor(resources: Map<string, Uint8Array>) {
    for (const [name, bytes] of resources) {
      const quest = /^res\/dat\/quest_([01][01])_dat$/.exec(name);
      const scene = /^res\/event\/e(\d{4})_scn$/.exec(name);
      if (quest) this.texts.set(quest[1], parseQuestText(bytes));
      if (scene) this.scenes.set(Number(scene[1]), parseQuestScene(Number(scene[1]), bytes));
    }
    if (this.texts.size !== 4 || !this.scenes.size) throw new Error("Quest resources unavailable");
  }
  text(character: number, id: number, threshold: number): QuestText | undefined {
    return this.texts.get(`${character}${id >= threshold ? 1 : 0}`)?.[(id >= threshold ? id - threshold : id) >> 1];
  }
}

export interface QuestProgress { current: number; required: number; monster?: number }
export interface ActiveQuest extends QuestText { id: number; progress: QuestProgress[] }
export interface QuestPoint { x: number; y: number; kind: "exit" | "target"; label: string }
export interface QuestSnapshot {
  quests: ActiveQuest[];
  mainQuestIds: number[];
  selected?: ActiveQuest;
  scene: number;
  character: number;
  region: string;
  guidance: string;
  point?: QuestPoint;
  player: { x: number; y: number };
  camera: { x: number; y: number };
}

/** 0x3f470 appends accepted quests and removes turned-in quests, preserving acceptance order. */
function readMainQuestIds(api: CheatApi, character: number): number[] | undefined {
  const read = (address: number, width = 4) => api.read(address, width, false);
  const menu = read(G + 0x9e00);
  if (!heap(menu) || character > 1) return undefined;
  const count = read(menu + 0x5c, 1), threshold = read(0x5e46c + character * 4);
  if (count > 20 || threshold !== [108, 84][character]) return undefined;
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const id = read(menu + 0x48 + i, 1) & ~1;
    if (id < threshold && !ids.includes(id) &&
      read(G + 0x9f98 + id, 1) === 1 && read(G + 0x9f98 + id + 1, 1) === 1) ids.push(id);
  }
  return ids;
}

/** A cached presentation is usable only while its native scene and accepted quest still match. */
export function isCurrentQuestSnapshot(appId: string, api: CheatApi, snapshot: QuestSnapshot): boolean {
  if (!isHeroesLore3(appId) || !isHeroesLore3Binary(api)) return false;
  try {
    const read = (address: number, width = 4) => api.read(address, width, false);
    if (read(G + 0x50) !== 4 || read(0x0150db48, 1) !== 3 ||
      read(G + 0x9e08, 2) !== snapshot.scene || read(G + 0xa314) !== snapshot.character) return false;
    const ids = readMainQuestIds(api, snapshot.character);
    return ids !== undefined && ids.length === snapshot.mainQuestIds.length &&
      ids.every((id, i) => id === snapshot.mainQuestIds[i]);
  } catch { return false; }
}

interface Route { scene: QuestScene; first?: QuestPoint; steps: number }

function reachable(resources: Hl3QuestResources, start: number, state: QuestConditions): Route[] {
  const scene = resources.scenes.get(start);
  if (!scene) return [];
  const routes: Route[] = [{ scene, steps: 0 }], visited = new Set([start]);
  for (let i = 0; i < routes.length; i++) {
    const route = routes[i];
    for (const trigger of route.scene.triggers) {
      if (trigger.length < 7 || ![3, 5, 6].includes(trigger[5])) continue;
      const selected = resolveQuestTrigger(trigger.subarray(6), state);
      // Dialog choices/cutscenes may change flags, so only a pure native warp is an edge.
      if (selected?.length !== 1) continue;
      const action = route.scene.actions[selected[0]];
      if (!action || action.choice || action.commands.length !== 1 || action.commands[0][0] !== 40) continue;
      const next = resources.scenes.get(action.commands[0][1]);
      if (!next || visited.has(next.id)) continue;
      visited.add(next.id);
      routes.push({ scene: next, steps: route.steps + 1, first: route.first ?? {
        x: trigger[0] * 16 + 8, y: trigger[1] * 16 + 16, kind: "exit", label: next.name,
      } });
    }
  }
  return routes;
}

/** Read-only main-quest projection. Acceptance, progress and story flags come from guest memory. */
export function readHl3Quests(appId: string, api: CheatApi, resources: Hl3QuestResources): QuestSnapshot | undefined {
  if (!isHeroesLore3(appId) || !isHeroesLore3Binary(api)) return undefined;
  const read = (a: number, width = 4) => api.read(a, width, false);
  // 0x3b1ba reads one byte; the following bytes are independent scene/event flags.
  if (read(G + 0x50) !== 4 || read(0x0150db48, 1) !== 3) return undefined;
  const menu = read(G + 0x9e00), map = read(G + 0x9c68), collider = read(G + 0x9ba4);
  if (!heap(menu) || !heap(map) || !heap(collider)) return undefined;
  const character = read(G + 0xa314), mainQuestIds = readMainQuestIds(api, character);
  if (!mainQuestIds) return undefined;
  const threshold = read(0x5e46c + character * 4);
  const mapWidth = s16(read(map + 0x50, 2)), mapHeight = s16(read(map + 0x52, 2));
  if (mapWidth <= 0 || mapHeight <= 0 || read(G + 0x44) !== 240 || read(G + 0x48) !== 320) return undefined;
  const quest = api.dump(G + 0x9f98, 256), local = api.dump(G + 0x9e98, 256);
  if (quest.length !== 256 || local.length !== 256) return undefined;
  let bag: ReturnType<typeof readBag> | undefined;
  const state: QuestConditions = {
    quest, local, level: read(G + 0xba, 2), gold: read(G + 0xa4),
    itemCount(category, index) {
      bag ??= readBag(api);
      return bag.filter(item => item.category === category && item.index === index).reduce((n, item) => n + item.count, 0);
    },
  };
  const quests: ActiveQuest[] = [];
  for (const id of mainQuestIds) {
    const text = resources.text(character, id, threshold);
    if (!text) continue;
    const progress: QuestProgress[] = [];
    const kills = read(G + 0xa2b1, 1), items = read(G + 0xa30d, 1);
    if (kills > 15 || items > 15) return undefined;
    for (let j = 0; j < kills; j++) if (read(G + 0xa2a2 + j, 1) === id) {
      progress.push({ monster: read(G + 0xa266 + j, 1), required: read(G + 0xa275 + j, 1), current: read(G + 0xa284 + j, 1) });
    }
    for (let j = 0; j < items; j++) if (read(G + 0xa2fe + j, 1) === id) {
      progress.push({ required: read(G + 0xa2d1 + j, 1), current: state.itemCount(read(G + 0xa2b3 + j, 1), read(G + 0xa2c2 + j, 1)) });
    }
    quests.push({ ...text, id, progress });
  }
  const scene = read(G + 0x9e08, 2), currentScene = resources.scenes.get(scene);
  if (!currentScene || currentScene.map !== read(G + 0x9e1c)) return undefined;
  const player = { x: s16(read(collider + 0x10, 2)), y: s16(read(collider + 0x12, 2)) };
  // Follow the latest accepted main quest, not a pinned selection or the highest numeric ID.
  const selected = quests.find(q => q.id === mainQuestIds.at(-1));
  const snapshot: QuestSnapshot = {
    quests, mainQuestIds, selected, scene, character, region: currentScene.name, player,
    camera: {
      x: cameraOffset(read(G + 0x9e6c) | 0, 240, mapWidth),
      y: cameraOffset(read(G + 0x9e70) | 0, 320, mapHeight),
    },
    guidance: selected ? "메인 퀘스트의 목표 지역을 확인하세요" : "메인 퀘스트를 받으면 여기에 안내가 표시됩니다",
  };
  if (!selected) return snapshot;
  const routes = reachable(resources, scene, state);
  const done = selected.progress.length > 0 && selected.progress.every(p => p.current >= p.required);
  const liveTargets = selected.progress.filter(p => p.monster !== undefined && p.current < p.required);
  const table = read(G + 0x9c94), monsters = s16(read(G + 0x9c98, 2));
  let closest = Infinity;
  if (liveTargets.length && heap(table) && monsters >= 0 && monsters <= 512 && table + monsters * 0x158 < 0x50000000) {
    for (let i = 0; i < monsters; i++) {
      const record = table + i * 0x158, entity = read(record);
      if (!heap(entity) || read(record + 0x7e, 2) === 0) continue;
      const p = read(entity + 0x18);
      if (!heap(p) || read(p + 4, 1) !== 5 || read(p + 0x0d, 1) === 255 || !liveTargets.some(t => t.monster === read(p + 0x0e, 1))) continue;
      const x = s16(read(p + 0x10, 2)), y = s16(read(p + 0x12, 2)), distance = (x - player.x) ** 2 + (y - player.y) ** 2;
      if (distance < closest) { closest = distance; snapshot.point = { x, y, kind: "target", label: "퀘스트 대상" }; }
    }
  }
  if (snapshot.point) { snapshot.guidance = "이 지역의 퀘스트 대상"; return snapshot; }
  // A finish action is only a destination when its native trigger is currently eligible.
  for (const route of routes) {
    const trigger = route.scene.triggers.find(t => t[5] !== 0 && t.length > 6 &&
      resolveQuestTrigger(t.subarray(6), state)?.some(index => route.scene.actions[index]?.commands.some(c => c[0] === 34 && c[1] === selected.id && c[2] === 0)));
    if (trigger && (done || !selected.progress.length)) {
      snapshot.point = route.first ?? { x: trigger[0] * 16 + 8, y: trigger[1] * 16 + 16, kind: "target", label: "퀘스트 진행 위치" };
      snapshot.guidance = route.first ? `${route.first.label} 방면 출구` : "표시된 위치에서 퀘스트 진행";
      return snapshot;
    }
  }
  const region = selected.location.split(";")[0].trim();
  const destination = region && routes.find(r => normalize(r.scene.name).startsWith(normalize(region)));
  if (destination) {
    snapshot.point = destination.first;
    snapshot.guidance = destination.first ? `${destination.first.label} 방면 출구` : done ? "목표 수량 달성 · 다음 진행 확인" : "목표 지역 도착 · 퀘스트를 진행하세요";
  } else snapshot.guidance = done ? "목표 수량 달성 · 퀘스트 설명 확인" : `${region || selected.location} · 연결 경로 확인 필요`;
  return snapshot;
}
