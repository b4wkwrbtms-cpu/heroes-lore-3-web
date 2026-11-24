// Game data for the 1.57 web build: dw.pack and the data/ folder are not published with this page. The
// player picks the zip of the web build they were given once; its game data is kept in this browser
// (Cache Storage) and read from there. Only data files are taken from the zip, never its program files.
'use strict';
window.DWDATA = (() => {
  const CACHE = 'dwweb-data';
  const wanted = (p) => p === 'dw.pack' || p.startsWith('data/');
  const key = (p) => new URL(p, location.href).href;
  const urls = {};
  const open = () => caches.open(CACHE);
  async function get(p) { return (await (await open()).match(key(p))) || new Response(null, { status: 404 }); }
  async function has() { return !!(await (await open()).match(key('dw.pack'))); }
  async function bytes(p) { const r = await get(p); if (!r.ok) throw new Error(p + ' 없음'); return new Uint8Array(await r.arrayBuffer()); }
  async function url(p) {
    if (!(p in urls)) { const r = await get(p); urls[p] = r.ok ? URL.createObjectURL(await r.blob()) : ''; }
    return urls[p];
  }
  async function inflate(raw) {
    const s = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }
  // a zip: end of central directory, then the central directory, then each entry's local header
  async function importZip(file, onp) {
    const buf = new Uint8Array(await file.arrayBuffer()), dv = new DataView(buf.buffer);
    let e = buf.length - 22;
    while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
    if (e < 0) throw new Error('압축 파일(zip)이 아니에요');
    const n = dv.getUint16(e + 10, true);
    let p = dv.getUint32(e + 16, true);
    const all = [];
    for (let i = 0; i < n; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('압축 파일이 손상됐어요');
      const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
      all.push({
        name: new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nl)).replace(/\\/g, '/'),
        method: dv.getUint16(p + 10, true), size: dv.getUint32(p + 20, true), off: dv.getUint32(p + 42, true),
      });
      p += 46 + nl + xl + cl;
    }
    const pack = all.find((x) => /(^|\/)dw\.pack$/.test(x.name));
    if (!pack) throw new Error('이 압축 파일에는 다크월드 웹판 자료(dw.pack)가 없어요');
    const root = pack.name.slice(0, -'dw.pack'.length);
    const files = all.filter((x) => x.name.startsWith(root) && !x.name.endsWith('/') && wanted(x.name.slice(root.length)));
    files.sort((a, b) => (a === pack) - (b === pack)); // dw.pack last: it marks the import complete
    const c = await open();
    await c.delete(key('dw.pack'));
    let done = 0;
    for (const x of files) {
      const h = x.off, start = h + 30 + dv.getUint16(h + 26, true) + dv.getUint16(h + 28, true);
      const raw = buf.subarray(start, start + x.size);
      let data;
      if (x.method === 0) data = raw;
      else if (x.method === 8) data = await inflate(raw);
      else throw new Error('지원하지 않는 압축 방식이에요');
      await c.put(key(x.name.slice(root.length)), new Response(new Blob([data])));
      onp(++done / files.length);
    }
  }
  // until the data is there: a button that picks the zip
  function ask(msg, prog) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.zip,application/zip';
      input.style.display = 'none';
      const b = document.createElement('button');
      b.className = 'pick';
      b.textContent = '압축 파일 고르기';
      msg.textContent = '처음 한 번만, 받은 다크월드 웹판 압축 파일\n(TalkFile_DarkWorld_WEB_….zip)을 골라 주세요.\n게임 자료는 이 기기에만 보관돼요.';
      msg.after(b);
      document.body.appendChild(input);
      b.onclick = () => input.click();
      input.onchange = async () => {
        const f = input.files[0];
        if (!f) return;
        b.disabled = true;
        msg.textContent = '게임 자료를 꺼내는 중…';
        try {
          await importZip(f, (k) => { prog.style.width = (k * 100).toFixed(0) + '%'; });
          b.remove();
          input.remove();
          resolve();
        } catch (err) {
          msg.textContent = '넣지 못했어요: ' + err.message + '\n다른 파일을 골라 주세요.';
          b.disabled = false;
          input.value = '';
        }
      };
    });
  }
  async function ready(msg, prog) {
    if (!(await has())) await ask(msg, prog);
    try { // the pixel font of the build, once its data is here
      const r = await get('data/runner/neodgm.ttf');
      if (r.ok) { const ff = new FontFace('NeoDunggeunmo', await r.arrayBuffer()); await ff.load(); document.fonts.add(ff); }
    } catch (e) {}
  }
  return { ready, get, bytes, url };
})();
