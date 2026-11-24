// 설정 메뉴(⚙), 치트 설정/상점, 몬스터대전 테스트 설정, 저장 내보내기/가져오기 (.dwsave, 폰·PC와 호환)
'use strict';
(() => {
const I = () => window.DWInternals;
const $ = (id) => document.getElementById(id);
const panel = $('menu'), box = $('menubox');
const CATS = ['', '대검', '낫', '크로', '너클', '망토', '상의', '투구', '어깨', '신발', '목걸이', '부적', '반지', '모험 장비', '가방', '소비 / 캐시 아이템', '재료', '퀘스트 아이템', '강화석', '마석', '신석', '분해 / 거래 도구'];
const SETTINGS = ['무적', '스킬 MP 소모 없음', '스킬 쿨타임 없음', '사용 아이템 수량 유지', '획득 경험치', '몬스터 획득 골드', '강화 100% 성공', '몬스터대전 테스트 설정', '변신 외형 숨기기 (듀란)'];
const MULT = ['기본', '2배', '5배', '10배', '50배', '100배'];
let catalog = null, pending = false, expected = 0;

async function loadCatalog() {
  if (catalog) return catalog;
  catalog = [];
  try {
    const t = await (await DWDATA.get('data/runner/catalog.tsv')).text();
    for (const l of t.split('\n')) {
      const f = l.replace('\r', '').split('\t'); if (f.length < 3) continue;
      catalog.push({ type: +f[0], index: +f[1], name: f[2], desc: (f[3] || '').replace(/\|/g, '\n') });
    }
  } catch (e) {}
  return catalog;
}
const note = (type, index) => { const c = (catalog || []).find((x) => x.type === type && x.index === index); return c ? c.desc : ''; };
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt !== undefined) e.textContent = txt; return e; };

let pauseGame = false;
// keyboard / gamepad navigation inside these windows (arrows · Enter/Z/A · Esc/X/B)
const nav = { line: 0, col: 0, title: '' };
function navLines() {
  const lines = [];
  for (const r of box.querySelectorAll('.row, .btns')) {
    const bs = [...r.querySelectorAll('button')];
    if (r.classList.contains('btns') || bs.length) lines.push(bs); else lines.push([r]);
  }
  return lines.filter((l) => l.length);
}
function navPaint() {
  for (const e of box.querySelectorAll('.navsel')) e.classList.remove('navsel');
  const L = navLines(); if (!L.length) return;
  nav.line = Math.max(0, Math.min(L.length - 1, nav.line)); nav.col = Math.max(0, Math.min(L[nav.line].length - 1, nav.col));
  const e = L[nav.line][nav.col]; e.classList.add('navsel'); e.scrollIntoView({ block: 'nearest' });
}
function navKey(k) {
  const L = navLines(); if (!L.length) return;
  const cur = L[Math.min(nav.line, L.length - 1)][nav.col];
  if (k === 'up' || k === 'down') { nav.line = (nav.line + (k === 'up' ? -1 : 1) + L.length) % L.length; }
  else if (k === 'left' || k === 'right') {
    const d = k === 'left' ? -1 : 1;
    if (cur && cur._lr) { cur._lr(d); return; }
    nav.col += d;
  } else if (k === 'ok') { if (cur) cur.click(); return; }
  else if (k === 'back') {
    const back = [...box.querySelectorAll('.btns button')].find((x) => x.textContent.startsWith('◀'));
    if (back) back.click(); else close();
    return;
  }
  navPaint();
}
function show(build, pause = false) {
  box.innerHTML = ''; build(box); panel.classList.add('open'); pauseGame = pause; I().setPaused(pause);
  const t = (box.querySelector('h2') || {}).firstChild?.textContent || '';
  if (t !== nav.title) { nav.title = t; nav.line = 0; nav.col = 0; }
  navPaint(); navPadLoop();
}
let navPadOn = false, navPrev = [], navRep = [0, 0, 0, 0];
function navPadLoop() {
  if (navPadOn) return; navPadOn = true;
  const step = (t) => {
    if (!panel.classList.contains('open')) { navPadOn = false; return; }
    const IN = window.DWInput;
    if (IN && !IN.padCapture && !(typeof capture !== 'undefined' && capture)) {
      const { raw, dir } = IN.padRaw();
      ['up', 'down', 'left', 'right'].forEach((k, i) => {
        if (dir[i] && !navPrev[12 + i]) { navKey(k); navRep[i] = t + 350; }
        else if (dir[i] && t > navRep[i]) { navKey(k); navRep[i] = t + 90; }
      });
      if (raw[0] && !navPrev[0]) navKey('ok');
      if (raw[1] && !navPrev[1]) navKey('back');
      navPrev = [...raw, ...dir];
    }
    requestAnimationFrame(step);
  };
  navPrev = (() => { const r = window.DWInput ? window.DWInput.padRaw() : { raw: [], dir: [] }; return [...r.raw, ...r.dir]; })();
  requestAnimationFrame(step);
}
function close() { panel.classList.remove('open'); box.innerHTML = ''; nav.title = ''; if (pauseGame) { I().setPaused(false); I().nextTickReset(); } pauseGame = false; }
panel.addEventListener('pointerdown', (e) => { if (e.target === panel) close(); });
function header(b, title, right) { const h = el('h2', '', title); if (right) h.appendChild(el('small', '', right)); b.appendChild(h); }
function row(b, label, value, onclick, onnote) {
  const r = el('div', 'row'); r.appendChild(el('span', '', label)); if (value !== undefined) r.appendChild(el('span', 'v', value));
  r.onclick = () => { onclick && onclick(r); }; if (onnote) r.onpointerenter = onnote; b.appendChild(r); return r;
}
function buttons(b, list) { const d = el('div', 'btns'); for (const [t, f] of list) { const x = el('button', '', t); x.onclick = f; d.appendChild(x); } b.appendChild(d); }
const S = () => I().settings;
const cheatOn = () => (S().cheat_flags & 1) !== 0;

// ---------------------------------------------------------------- 치트 설정
function xpIndex() { const f = S().cheat_flags; const v = ((f >> 5) & 3) | ((f >> 8) & 4); return v >= 6 ? 0 : v; }
function settingValue(i) {
  const f = S().cheat_flags;
  if (i === 7) return '열기';
  if (i === 8) return S().hide_transform ? 'ON' : 'OFF';
  if (i === 4) return MULT[xpIndex()];
  if (i === 5) return MULT[(f >> 7) & 3];
  if (i === 6) return (f & 0x200) ? 'ON' : 'OFF';
  return (f & (1 << (i + 1))) ? 'ON' : 'OFF';
}
function changeSetting(i, dir) {
  const s = S();
  if (i === 7) { openArena(); return; }
  if (i === 8) { s.hide_transform ^= 1; I().Runner.queue.push(0x5c00 + s.hide_transform); I().saveSettings(); return; }
  if (i === 4) { const v = ((xpIndex() + dir) % 6 + 6) % 6; s.cheat_flags = (s.cheat_flags & ~0x460) | ((v & 3) << 5) | ((v & 4) << 8); }
  else if (i === 5) { const v = ((((s.cheat_flags >> 7) & 3) + dir) & 3); s.cheat_flags = (s.cheat_flags & ~(3 << 7)) | (v << 7); }
  else if (i === 6) s.cheat_flags ^= 0x200;
  else s.cheat_flags ^= 1 << (i + 1);
  I().Runner.dirty = true; I().saveSettings();
}
async function openSettings() {
  await loadCatalog();
  show((b) => {
    header(b, '치트 설정', cheatOn() ? '치트 ON' : '치트 OFF');
    const n = el('div', 'note');
    SETTINGS.forEach((label, i) => {
      const r = row(b, label, settingValue(i), () => {
        changeSetting(i, 1); if (i !== 7) r.querySelector('.v').textContent = settingValue(i);
        n.textContent = i === 8 ? '듀란의 변신 외형을 숨기고 원래 모습으로 표시합니다.' : note(-1, i);
      });
      if (i === 4 || i === 5) {  // ◀ on the left half
        r.onclick = (e) => { const left = e.offsetX < r.clientWidth / 2 && e.detail > 0; changeSetting(i, left ? -1 : 1); r.querySelector('.v').textContent = settingValue(i); n.textContent = note(-1, i); };
        r._lr = (d) => { changeSetting(i, d); r.querySelector('.v').textContent = settingValue(i); n.textContent = note(-1, i); };
      }
    });
    n.textContent = '항목을 누르면 바뀝니다. (배율은 왼쪽 절반 ◀ / 오른쪽 절반 ▶)';
    b.appendChild(n);
    buttons(b, [['닫기', close]]);
  });
}

// ---------------------------------------------------------------- 치트 상점
async function openShop() {
  await loadCatalog();
  show((b) => {
    header(b, '치트 상점', cheatOn() ? '치트 ON' : '치트 OFF');
    for (let c = 1; c < CATS.length; c++) row(b, CATS[c], '›', () => openCategory(c));
    buttons(b, [['닫기', close]]);
  });
}
function openCategory(c) {
  const items = catalog.filter((x) => x.type === c);
  show((b) => {
    header(b, CATS[c], items.length + '개');
    for (const it of items) row(b, it.name, '›', () => openQty(c, it));
    buttons(b, [['◀ 뒤로', openShop], ['닫기', close]]);
  });
}
function openQty(c, it) {
  let q = 1;
  show((b) => {
    header(b, '수량 선택');
    row(b, it.name);
    const qr = el('div', 'row'); const minus = el('button', '', '−'), plus = el('button', '', '+'), m10 = el('button', '', '−10'), p10 = el('button', '', '+10');
    for (const x of [m10, minus, plus, p10]) Object.assign(x.style, { font: 'inherit', fontSize: '20px', color: '#ffe064', background: '#304333', border: '2px solid #d4b66b', minWidth: '52px' });
    const v = el('span', 'v', '1 개');
    const set = (d) => { q = Math.max(1, Math.min(99, q + d)); v.textContent = q + ' 개'; };
    m10.onclick = () => set(-10); minus.onclick = () => set(-1); plus.onclick = () => set(1); p10.onclick = () => set(10);
    qr.append(m10, minus, v, plus, p10); b.appendChild(qr);
    b.appendChild(el('div', 'note', it.desc));
    const st = el('div', 'status'); b.appendChild(st);
    buttons(b, [['◀ 뒤로', () => openCategory(c)], ['지급', () => {
      if (pending) { st.textContent = '지급 처리 중…'; return; }
      if (!cheatOn()) { st.textContent = '게임 안에서 치트가 꺼져 있습니다'; return; }
      pending = true; expected = q; status = st;
      I().Runner.queue.push((0x6f000000 | (it.type << 17) | (q << 10) | it.index) >>> 0);
      st.textContent = '지급 처리 중…';
    }]]);
  });
}
let status = null;
function granted(n) {
  pending = false;
  let m = n + '개 지급 완료';
  if (n < expected) m += ` (인벤토리 공간 부족 또는 지급 불가 ${expected - n}개)`;
  if (status) status.textContent = m;
}

// ---------------------------------------------------------------- 몬스터대전 테스트 설정
function openArena() {
  const s = S();
  let cfg = s.arena >>> 0;
  let my = cfg & 0xff, en = (cfg >> 8) & 0xff, cap = (cfg >> 16) & 0xff || 125, half = (cfg >> 24) & 1;
  let myOn = my > 0, enOn = en > 0; my = my || s.arena_my || 140; en = en || s.arena_en || 140;
  const commit = () => { s.arena = ((myOn ? my : 0) | ((enOn ? en : 0) << 8) | (cap << 16) | (half << 24)) >>> 0; s.arena_my = my; s.arena_en = en; I().saveSettings(); };
  const draw = () => show((b) => {
    header(b, '몬스터대전 테스트 설정');
    const lv = (label, get, setv, on) => {
      const r = el('div', 'row'); r.appendChild(el('span', '', label));
      const v = el('span', 'v', get() + (on === false ? ' (미사용)' : ''));
      const btn = (t, d) => { const x = el('button', '', t); Object.assign(x.style, { font: 'inherit', fontSize: '18px', color: '#ffe064', background: '#304333', border: '2px solid #d4b66b', minWidth: '44px' }); x.onclick = (e) => { e.stopPropagation(); setv(Math.max(1, Math.min(140, get() + d))); commit(); draw(); }; return x; };
      const g = el('span'); g.append(btn('−10', -10), btn('−', -1), v, btn('+', 1), btn('+10', 10)); g.style.display = 'flex'; g.style.gap = '4px'; g.style.alignItems = 'center';
      r.appendChild(g); b.appendChild(r);
    };
    row(b, '내 팀 레벨 직접 지정', myOn ? 'ON' : 'OFF', () => { myOn = !myOn; commit(); draw(); });
    lv('내 팀 레벨', () => my, (v) => { my = v; }, myOn);
    row(b, '상대 팀 레벨 직접 지정', enOn ? 'ON' : 'OFF', () => { enOn = !enOn; commit(); draw(); });
    lv('상대 팀 레벨', () => en, (v) => { en = v; }, enOn);
    lv('기존 레벨 상한', () => cap, (v) => { cap = v; });
    row(b, '내 소환수 받는 피해 50% 감소', half ? 'ON' : 'OFF', () => { half ^= 1; commit(); draw(); });
    row(b, '기본값 복원', '', () => { myOn = enOn = false; half = 0; my = en = 140; cap = 125; commit(); draw(); });
    b.appendChild(el('div', 'note', '치트 ON일 때 다음 대전부터 적용됩니다.\n저장된 레벨·경험치는 유지됩니다.' + (cheatOn() ? '' : '\n※ 지금은 치트가 꺼져 있어 적용되지 않습니다.')));
    buttons(b, [['◀ 치트 설정', openSettings], ['닫기', close]]);
  });
  draw();
}

// ---------------------------------------------------------------- .dwsave (phone runner 저장 내보내기 format)
const PREFIX = '/data/data/com.gamedoli.DarkWorldGoogle/';
const sha256 = async (u8) => new Uint8Array(await crypto.subtle.digest('SHA-256', u8));
async function exportSave() {
  const saves = window.DW.saves;
  if (!saves['_characterInfo.sav'] || !saves['_gameData_pub.sav']) { alert('먼저 게임 안에서 저장해 주세요.'); return; }
  const names = Object.keys(saves).sort((a, b) => (PREFIX + a < PREFIX + b ? -1 : 1));
  const enc = new TextEncoder(); const parts = [];
  const head = new Uint8Array(20); head.set([68, 87, 83, 86, 1, 0, 0, 0]);
  const dv = new DataView(head.buffer);
  const id = BigInt('0x' + I().M.UTF8ToString(I().M._dw_native_id()));
  dv.setBigUint64(8, id, true); dv.setUint32(16, names.length, true); parts.push(head);
  for (const n of names) {
    const nb = enc.encode(PREFIX + n), d = saves[n]; const h = new Uint8Array(8); const hv = new DataView(h.buffer);
    hv.setUint32(0, nb.length, true); hv.setUint32(4, d.length, true); parts.push(h, nb, d);
  }
  const len = parts.reduce((a, p) => a + p.length, 0); const payload = new Uint8Array(len); let o = 0; for (const p of parts) { payload.set(p, o); o += p.length; }
  const out = new Uint8Array(52 + len); const ov = new DataView(out.buffer);
  out.set([68, 87, 69, 88]); ov.setUint32(4, 1); ov.setBigUint64(8, BigInt(Date.now())); ov.setUint32(16, len);
  out.set(await sha256(payload), 20); out.set(payload, 52);
  const d = new Date(), pad = (x) => String(x).padStart(2, '0');
  const fname = `DarkWorld-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.dwsave`;
  const blob = new Blob([out], { type: 'application/octet-stream' });
  const file = new File([blob], fname, { type: 'application/octet-stream' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: fname }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fname; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
async function decodeSave(f) {
  let payload;
  const tag = String.fromCharCode(...f.slice(0, 4));
  if (tag === 'DWEX') {
    const dv = new DataView(f.buffer, f.byteOffset, f.length);
    if (f.length < 52 || dv.getUint32(4) !== 1) throw new Error('다크월드 내보내기 파일이 아닙니다');
    const len = dv.getUint32(16); if (len + 52 !== f.length) throw new Error('저장 파일 길이가 올바르지 않습니다');
    payload = f.slice(52);
    const h = await sha256(payload); for (let i = 0; i < 32; i++) if (h[i] !== f[20 + i]) throw new Error('파일이 손상되었습니다');
  } else if (tag === 'DWSV') payload = f; else throw new Error('다크월드 내보내기 파일(.dwsave)이 아닙니다');
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.length);
  const count = dv.getUint32(16, true); if (count > 128) throw new Error('저장 항목이 너무 많습니다');
  const out = {}; let o = 20; const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    const nl = dv.getUint32(o, true), sz = dv.getUint32(o + 4, true); o += 8;
    const name = dec.decode(payload.slice(o, o + nl)); o += nl;
    if (!name.startsWith(PREFIX)) throw new Error('저장 항목이 올바르지 않습니다');
    const base = name.slice(PREFIX.length); if (!base || base.includes('/')) throw new Error('저장 항목이 올바르지 않습니다');
    out[base] = payload.slice(o, o + sz); o += sz;
  }
  if (!out['_characterInfo.sav'] || !out['_gameData_pub.sav']) throw new Error('캐릭터 또는 공용 저장이 없습니다');
  return out;
}
const fileInput = $('file');
fileInput.onchange = async () => {
  const f = fileInput.files[0]; fileInput.value = ''; if (!f) return;
  try {
    const files = await decodeSave(new Uint8Array(await f.arrayBuffer()));
    if (!confirm('현재 진행 데이터를 선택한 파일로 교체합니다. 계속할까요?\n(현재 저장은 먼저 내보내 두는 것을 권장합니다)')) return;
    const keep = window.DW.saves['_gameOptioin.sav'];
    const db = idb();
    db.onsuccess = () => {
      const t = db.result.transaction(['saves', 'settings'], 'readwrite'); const s = t.objectStore('saves');
      t.objectStore('settings').put({ time: Date.now(), files: { ...window.DW.saves } }, 'backup');  // 가져오기 전 저장 (되돌리기용)
      s.clear();
      for (const [n, d] of Object.entries(files)) if (!(n === '_gameOptioin.sav' && keep)) s.put(d, n);
      if (keep) s.put(keep, '_gameOptioin.sav');
      t.oncomplete = () => { alert('저장을 가져왔습니다. 게임을 다시 시작합니다.'); location.reload(); };
    };
  } catch (e) { alert(e.message); }
};

// ---------------------------------------------------------------- ⚙ menu
function openMenu() {
  show((b) => {
    header(b, '설정');
    const s = S();
    row(b, '저장 내보내기 (.dwsave)', '›', exportSave);
    row(b, '저장 가져오기 (.dwsave)', '›', () => fileInput.click());
    row(b, '화면 업스케일 (xBR)', s.xbr ? '적용' : '미적용', (r) => { s.xbr ^= 1; I().saveSettings(); I().Runner.queue.push(0x5a00 + s.xbr); r.querySelector('.v').textContent = s.xbr ? '적용' : '미적용'; });
    row(b, '소리', s.mute ? '끔' : '켬', (r) => { s.mute ^= 1; I().saveSettings(); I().Audio.applyMute(); r.querySelector('.v').textContent = s.mute ? '끔' : '켬'; });
    row(b, '화면 버튼 표시', s.buttons === 0 ? '숨김' : '표시', (r) => { toggleButtons(); r.querySelector('.v').textContent = s.buttons === 0 ? '숨김' : '표시'; });
    row(b, '패드 UI (스킬 하단 배치)', s.padui ? '켬' : '끔', (r) => { togglePadUi(); r.querySelector('.v').textContent = s.padui ? '켬' : '끔'; });
    // this site's additions
    const flip = (k, r, a, b2) => { s[k] = s[k] === 0 ? 1 : 0; I().saveSettings(); r.querySelector('.v').textContent = s[k] === 0 ? b2 : a; };
    row(b, '움직임 부드럽게 (중간 프레임)', s.smooth === 0 ? '끔' : '켬', (r) => flip('smooth', r, '켬', '끔'));
    const IMPACT = ['끔', '보통', '강하게'];
    row(b, '타격 효과', IMPACT[s.impact === undefined ? 1 : s.impact], (r) => { s.impact = ((s.impact === undefined ? 1 : s.impact) + 1) % 3; I().saveSettings(); r.querySelector('.v').textContent = IMPACT[s.impact]; });
    row(b, '공격 연타 보정', s.combo === 0 ? '끔' : '켬', (r) => flip('combo', r, '켬', '끔'));
    row(b, '키 설정', '›', () => openKeys());
    row(b, '치트 설정', '›', openSettings);
    if (backupInfo) row(b, '가져오기 전 저장으로 되돌리기', new Date(backupInfo.time).toLocaleString(), restoreBackup);
    if (cheatOn()) row(b, '치트 상점', '›', openShop);
    b.appendChild(el('div', 'note', '저장은 이 브라우저에 자동 보관됩니다. 브라우저 데이터를 지우면 사라지니 가끔 내보내 두세요.\n아이폰: 공유 버튼 → "홈 화면에 추가"로 앱처럼 실행할 수 있습니다.'));
    buttons(b, [['닫기', close]]);
  }, true);
}
let backupInfo = null;
function idb() {  // same database as dw.js (creates the stores if this runs first)
  const r = indexedDB.open('darkworld', 1);
  r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains('saves')) d.createObjectStore('saves'); if (!d.objectStoreNames.contains('settings')) d.createObjectStore('settings'); };
  return r;
}
function loadBackupInfo() {
  const db = idb();
  db.onsuccess = () => { const g = db.result.transaction('settings', 'readonly').objectStore('settings').get('backup'); g.onsuccess = () => { backupInfo = g.result || null; }; };
}
setTimeout(loadBackupInfo, 3000);
function restoreBackup() {
  if (!backupInfo || !confirm('저장 가져오기 전 상태로 되돌립니다. 지금 진행은 덮어씌워집니다. 계속할까요?')) return;
  const db = idb();
  db.onsuccess = () => {
    const t = db.result.transaction(['saves', 'settings'], 'readwrite'); const s = t.objectStore('saves'); s.clear();
    for (const [n, d] of Object.entries(backupInfo.files)) s.put(d, n);
    t.objectStore('settings').delete('backup');
    t.oncomplete = () => { alert('되돌렸습니다. 게임을 다시 시작합니다.'); location.reload(); };
  };
}
function toggleButtons() { const s = S(); s.buttons = s.buttons === 0 ? 1 : 0; I().saveSettings(); I().toast(s.buttons ? '화면 버튼 표시' : '화면 버튼 숨김'); }
function togglePadUi() { const s = S(); s.padui = s.padui ? 0 : 1; I().saveSettings(); I().toast(s.padui ? '패드 UI 켬' : '패드 UI 끔'); }
$('gear').onclick = openMenu;

// ---------------------------------------------------------------- 키 설정 (F9, same idea as the PC version)
const IN = () => window.DWInput;
function keyName(c) {
  if (!c) return '-';
  const fixed = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'Space', Enter: 'Enter', Escape: 'Esc', Backspace: 'BkSp',
    Tab: 'Tab', ShiftLeft: 'Shift', ShiftRight: 'R-Shift', ControlLeft: 'Ctrl', ControlRight: 'R-Ctrl', AltLeft: 'Alt', AltRight: 'R-Alt',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\', BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=',
    Backquote: '`', CapsLock: 'Caps', Insert: 'Ins', Delete: 'Del', Home: 'Home', End: 'End', PageUp: 'PgUp', PageDown: 'PgDn' };
  if (fixed[c]) return fixed[c];
  if (c.startsWith('Key')) return c.slice(3);
  if (c.startsWith('Digit')) return c.slice(5);
  if (c.startsWith('Numpad')) return 'Num' + c.slice(6);
  return c;
}
function padNames(a) {
  if (a <= 3) return '십자키';
  const pad = IN().keymap().pad, n = [];
  pad.forEach((v, i) => { if (v === a) n.push(IN().PAD_NAMES[i]); });
  return n.length ? n.join('·') : '-';
}
let capture = null;  // { a, col }
function openKeys(sel) {
  const km = IN().keymap();
  show((b) => {
    header(b, '키 설정', '칸을 누르고 새 키 입력');
    const st = el('div', 'status');
    const cellStyle = { font: 'inherit', fontSize: '15px', color: '#eee7d1', background: '#1c2b22', border: '2px solid #5e6b56', minWidth: '84px', padding: '4px 6px' };
    IN().ACTIONS.forEach((name, a) => {
      const r = el('div', 'row'); r.style.cursor = 'default'; r.appendChild(el('span', '', name));
      const g = el('span'); Object.assign(g.style, { display: 'flex', gap: '6px' });
      for (let col = 0; col < 3; col++) {
        const x = el('button', '', col < 2 ? keyName(km.kb[a][col]) : padNames(a)); Object.assign(x.style, cellStyle);
        if (capture && capture.a === a && capture.col === col) { x.textContent = '입력 대기'; Object.assign(x.style, { background: '#6a5a2a', borderColor: '#ffdf72', color: '#ffe064' }); }
        x.onclick = (e) => {
          e.stopPropagation();
          if (col === 2 && a <= 3) { st.textContent = '패드 이동은 십자키와 왼쪽 스틱으로 고정입니다'; return; }
          capture = { a, col };
          if (col === 2) {
            const t0 = performance.now();
            IN().padCapture = (i) => { km.pad[i] = a; IN().padCapture = null; capture = null; I().saveSettings(); openKeys(); I().toast(IN().PAD_NAMES[i] + ' 지정'); };
            const timer = setInterval(() => {
              if (!capture || capture.col !== 2) { clearInterval(timer); return; }
              if (performance.now() - t0 > 6000) { clearInterval(timer); IN().padCapture = null; capture = null; openKeys(); }
            }, 200);
            I().setPaused(true);  // the game is paused, so poll the pad here
            const poll = () => { if (!IN().padCapture) return; const { raw } = IN().padRaw(); IN().__prev = IN().__prev || []; for (let i = 0; i < 12; i++) if (raw[i] && !IN().__prev[i]) { IN().__prev = raw; IN().padCapture(i); return; } IN().__prev = raw; requestAnimationFrame(poll); };
            IN().__prev = IN().padRaw().raw; requestAnimationFrame(poll);
          }
          IN().capturing = col < 2;
          openKeys();
        };
        g.appendChild(x);
      }
      r.appendChild(g); b.appendChild(r);
    });
    row(b, '기본 배치로 복원', '', () => { km.kb = IN().KB_DEFAULT.map((x) => x.slice()); km.pad = IN().PAD_DEFAULT.slice(); I().saveSettings(); openKeys(); I().toast('기본 배치로 복원했습니다'); });
    st.textContent = capture ? (capture.col < 2 ? '새 키를 누르세요  (Delete 지우기 · Esc 취소)' : '패드 버튼을 누르세요  (Esc 취소 · 6초 후 자동 취소)') : '같은 키를 다른 동작에 지정하면 원래 동작에서는 빠집니다.';
    b.appendChild(st);
    b.appendChild(el('div', 'note', 'Enter·Backspace는 비어 있으면 확인·취소로 동작합니다.\nF1~F4, F6~F12는 페이지 기능키라 지정할 수 없습니다. (F5는 지정 가능)'));
    buttons(b, [['닫기', () => { capture = null; IN().capturing = false; IN().padCapture = null; close(); }]]);
  }, true);
}
function keyCapture(e) {  // returns true when the key was used by 키 설정
  if (!capture) return false;
  e.preventDefault(); e.stopImmediatePropagation();
  if (e.repeat) return true;
  const km = IN().keymap(), { a, col } = capture;
  if (e.code === 'Escape') { capture = null; IN().capturing = false; IN().padCapture = null; openKeys(); return true; }
  if (col === 2) return true;
  if (e.code === 'Delete') { km.kb[a][col] = ''; }
  else {
    if (IN().RESERVED.test(e.code)) { I().toast(keyName(e.code) + ' 키는 지정할 수 없습니다'); return true; }
    km.kb.forEach((k, o) => { for (let c = 0; c < 2; c++) if (k[c] === e.code && !(o === a && c === col)) k[c] = ''; });
    km.kb[a][col] = e.code;
  }
  capture = null; IN().capturing = false; I().saveSettings(); openKeys();
  return true;
}

function openHelp() {
  show((b) => {
    header(b, '조작법', 'F9에서 변경');
    const km = IN().keymap();
    const keys = (a) => km.kb[a].filter(Boolean).map(keyName).join(', ') || '(없음)';
    row(b, '이동', `${keys(0)} / ${keys(1)} / ${keys(2)} / ${keys(3)}`);
    for (let a = 4; a < IN().ACTIONS.length; a++) row(b, IN().ACTIONS[a], keys(a) + '   ·   패드 ' + padNames(a));
    const lines = [['F1', '조작법'], ['F2', '화면 버튼 표시/숨김'], ['F3', '설정 메뉴 (⚙)'], ['F4', '소리 켜기/끄기'], ['F6', '패드 UI 켜기/끄기'], ['F7 / F8', '저장 가져오기 / 내보내기'],
      ['F9', '키 설정'], ['F10', '성능 표시'], ['F11', '전체화면 (브라우저 기능)']];
    for (const [k, v] of lines) row(b, k, v);
    b.appendChild(el('div', 'note', '화면 버튼 터치도 함께 쓸 수 있습니다.\n새로고침 대신 게임 안에서 저장한 뒤 닫아 주세요.'));
    buttons(b, [['키 설정', () => openKeys()], ['닫기', close]]);
  }, true);
}
function toggleMute() { const s = S(); s.mute ^= 1; I().saveSettings(); I().Audio.applyMute(); I().toast(s.mute ? '소리 끔' : '소리 켬'); }
function toggleFullscreen() {
  const d = document;
  if (d.fullscreenElement || d.webkitFullscreenElement) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
  else { const e = d.documentElement; const f = e.requestFullscreen || e.webkitRequestFullscreen; if (f) f.call(e).catch?.(() => {}); }
}
// block the browser's own function keys (F1 help, F3 find, F5 reload, F6/F7 caret browsing ...) and use them for the game
window.addEventListener('keydown', (e) => {
  if (/^F([1-9]|10)$/.test(e.key)) e.preventDefault();   // F11 (browser fullscreen) and F12 (developer tools) stay with the browser
  if ((e.ctrlKey || e.metaKey) && ['KeyR', 'KeyS', 'KeyP', 'KeyF', 'KeyG'].includes(e.code)) e.preventDefault();
  if (keyCapture(e)) return;
  const open = panel.classList.contains('open');
  if (open) {
    const k = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'ok', Space: 'ok', KeyZ: 'ok',
      Escape: 'back', Backspace: 'back', KeyX: 'back' }[e.code];
    if (k) { e.preventDefault(); e.stopImmediatePropagation(); if (!e.repeat || ['up', 'down', 'left', 'right'].includes(k)) navKey(k); return; }
  }
  if (e.repeat) return;
  switch (e.key) {
    case 'F1': if (open) close(); else openHelp(); break;
    case 'F2': toggleButtons(); break;
    case 'F3': if (open) close(); else openMenu(); break;
    case 'F6': togglePadUi(); break;
    case 'F4': toggleMute(); break;
    case 'F7': fileInput.click(); break;
    case 'F8': exportSave(); break;
    case 'F9': if (open) close(); else openKeys(); break;
    case 'F10': I().togglePerf(); break;
  }
}, true);

// 게임 시스템 메뉴 '저장 관리'
function openSave() {
  show((b) => {
    header(b, '저장 관리');
    row(b, '저장 내보내기 (.dwsave)', '›', exportSave);
    row(b, '저장 가져오기 (.dwsave)', '›', () => fileInput.click());
    if (backupInfo) row(b, '가져오기 전 저장으로 되돌리기', new Date(backupInfo.time).toLocaleString(), restoreBackup);
  });
}
window.DWCheat = { open(which) { if (which === 'shop') openShop(); else if (which === 'save') openSave(); else openSettings(); }, granted };
})();
