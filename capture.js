/* BOARD Capture.
   A quick way in for BOARD when you're on the go: open it, point, done. Its own Home Screen app, beside BOARD for iPhone.
   Swipe sideways between ways of capturing: SCAN (a document scanner) and VOICE (a voice note). More can be added to the strip.

   Where things go: everything lands in Unsorted on Home, newest first, to be filed on the Mac.
   How it gets there: the same way BOARD for iPhone does it. The file goes straight into the BOARD folder in Dropbox (assets/),
   then a card for it is added to home.json. Nothing passes through any other server.
   Offline, or if Dropbox hiccups: what you captured waits on the phone (the queue) and goes up when the connection is back.

   The picture work (finding the page, flattening, cleaning, making the PDF) is in scan.js. */
(() => {
  'use strict';

  // ------------------------------------------------------------------ settings
  const APP_KEY = '44iohoedl3b6t4h'; // the same Dropbox app as BOARD for iPhone
  const ROOT = '/BOARD';
  const VERSION = 'capture-0.1';
  const REDIRECT_READY = false; // true once this page's address is on the Dropbox app's list of allowed return addresses; until then, sign in with a code
  const MAX_SIDE = 2200;        // a flattened page is at most this many pixels on its long side
  const STILL_FRAMES = 7;       // how many steady looks in a row before it takes the picture by itself
  // tests run against a pretend Dropbox on this computer; that switch only works on a local address
  const mockBase = (() => { const m = /[?&]mock=([^&]+)/.exec(location.search); return m && /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? decodeURIComponent(m[1]) : ''; })();
  const HOST = mockBase ? { api: mockBase, content: mockBase, www: mockBase } : { api: 'https://api.dropboxapi.com', content: 'https://content.dropboxapi.com', www: 'https://www.dropbox.com' };
  const REDIRECT = location.origin + location.pathname + (mockBase ? '?mock=' + encodeURIComponent(mockBase) : '');
  const SCAN = window.SCAN;

  // ------------------------------------------------------------------ small helpers
  const $ = (s, r) => (r || document).querySelector(s);
  const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-5);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  const store = { get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage off */ } }, del(k) { try { localStorage.removeItem(k); } catch (e) { /* fine */ } } };
  const toBlob = (canvas, type, q) => new Promise((res) => canvas.toBlob(res, type, q));
  const mmss = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
  const stampText = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) + ', ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  function humanSize(n) { // the same wording the Mac uses on a file card
    if (!(n > 0)) return ''; const u = ['bytes', 'KB', 'MB', 'GB']; let i = 0;
    while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
    return (i === 0 ? String(n) : n < 10 ? n.toFixed(1) : String(Math.round(n))) + ' ' + u[i];
  }
  const toastEl = $('#toast'), toastText = $('#toastText'), toastAct = $('#toastAct'); let toastT = 0;
  function toast(msg, action, fn, ms) {
    toastText.textContent = msg; toastEl.hidden = false; clearTimeout(toastT);
    toastAct.hidden = !action; toastAct.textContent = action || ''; toastAct.onclick = action ? () => { toastEl.hidden = true; fn(); } : null;
    toastT = setTimeout(() => { toastEl.hidden = true; }, ms || 2600);
  }

  // ------------------------------------------------------------------ what is waiting on this phone (IndexedDB)
  const DB = (() => {
    let dbp = null;
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      const r = indexedDB.open('board-capture', 1);
      r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains('queue')) d.createObjectStore('queue'); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }));
    const tx = async (mode, fn) => { const d = await open(); return new Promise((res, rej) => { const t = d.transaction('queue', mode); const s = t.objectStore('queue'); let out; Promise.resolve(fn(s)).then((v) => { out = v; }); t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); };
    const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    return {
      put: (k, v) => tx('readwrite', (st) => { st.put(v, k); }),
      del: (k) => tx('readwrite', (st) => { st.delete(k); }),
      all: () => tx('readonly', async (st) => { const vals = await req(st.getAll()); return vals.sort((a, b) => a.at - b.at); }),
    };
  })();

  // ------------------------------------------------------------------ signing in to Dropbox (the same sign-in as BOARD for iPhone; no password ever reaches this page)
  const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const standalone = () => !!(navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches));
  async function startSignIn(byCode) {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    store.set('capture.pkce', { verifier, byCode: !!byCode });
    const q = new URLSearchParams({ client_id: APP_KEY, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', token_access_type: 'offline' });
    if (!byCode) q.set('redirect_uri', REDIRECT);
    const url = HOST.www + '/oauth2/authorize?' + q;
    if (byCode) showCodeBox(url); else location.href = url;
  }
  async function finishSignIn(code) {
    const p = store.get('capture.pkce'); if (!p) throw new Error('Start the sign-in again.');
    const body = new URLSearchParams({ code: code.trim(), grant_type: 'authorization_code', client_id: APP_KEY, code_verifier: p.verifier });
    if (!p.byCode) body.set('redirect_uri', REDIRECT);
    let r; try { r = await fetch(HOST.api + '/oauth2/token', { method: 'POST', body }); } catch (e) { throw new Error('No connection. Try again when you are online.'); }
    if (!r.ok) throw new Error('Dropbox did not accept that code. Start the sign-in again.');
    const j = await r.json();
    store.set('board.auth', { access: j.access_token, refresh: j.refresh_token, exp: Date.now() + (j.expires_in || 14400) * 1000 - 60000, account: j.account_id || '' });
    store.del('capture.pkce');
  }
  let refreshing = null;
  async function token() {
    const a = store.get('board.auth'); if (!a) throw Object.assign(new Error('signed out'), { signedOut: true });
    if (a.exp > Date.now()) return a.access;
    if (!refreshing) refreshing = (async () => {
      let r; try { r = await fetch(HOST.api + '/oauth2/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: a.refresh, client_id: APP_KEY }) }); } catch (e) { throw Object.assign(new Error('offline'), { offline: true }); }
      if (r.status === 400 || r.status === 401) { store.del('board.auth'); throw Object.assign(new Error('signed out'), { signedOut: true }); }
      if (!r.ok) throw Object.assign(new Error('offline'), { offline: true });
      const j = await r.json(); a.access = j.access_token; a.exp = Date.now() + (j.expires_in || 14400) * 1000 - 60000; store.set('board.auth', a); return a.access;
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  // ------------------------------------------------------------------ talking to Dropbox
  const argHeader = (o) => JSON.stringify(o).replace(/[\u007f-￿]/g, (c) => '\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4)); // headers must be plain ASCII
  async function call(url, opts, retried) {
    const t = await token();
    const headers = Object.assign({ Authorization: 'Bearer ' + t }, opts.headers || {});
    let r;
    try { r = await fetch(url, Object.assign({}, opts, { headers })); } catch (e) { throw Object.assign(new Error('offline'), { offline: true }); }
    if (r.status === 401 && !retried) { const a = store.get('board.auth'); if (a) { a.exp = 0; store.set('board.auth', a); } return call(url, opts, true); }
    if (r.status === 429 || r.status >= 500) { await sleep(1500); if (!retried) return call(url, opts, true); }
    return r;
  }
  async function download(path) {
    const r = await call(HOST.content + '/2/files/download', { method: 'POST', headers: { 'Dropbox-API-Arg': argHeader({ path }) } });
    if (!r.ok) throw Object.assign(new Error('download ' + r.status), { status: r.status });
    let meta = {}; try { meta = JSON.parse(r.headers.get('Dropbox-API-Result') || '{}'); } catch (e) { meta = {}; }
    return { text: await r.text(), rev: meta.rev || '' };
  }
  async function upload(path, data, rev) {
    const mode = rev ? { '.tag': 'update', update: rev } : { '.tag': 'add' };
    const r = await call(HOST.content + '/2/files/upload', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': argHeader({ path, mode, autorename: false, mute: true, strict_conflict: !!rev }) }, body: data });
    if (r.status === 409) throw Object.assign(new Error('conflict'), { conflict: true });
    if (!r.ok) throw Object.assign(new Error('upload ' + r.status), { status: r.status });
    return r.json().catch(() => ({}));
  }

  // ------------------------------------------------------------------ the queue: captured things on their way to BOARD
  // One entry: { id, kind, label, at, hold, files: [{ name, blob }], up: [names already in Dropbox], cards: [the cards to add] }
  const S = { mode: 'scan', pages: [], filter: store.get('capture.filter') || 'doc', auto: store.get('capture.auto') !== false, format: store.get('capture.format') || 'pdf', queued: 0, state: 'idle', lastError: '' };
  const FILTERS = { doc: 'Document', board: 'Whiteboard', photo: 'Original' };
  async function enqueue(entry) {
    entry.id = entry.id || 'q' + rid(); entry.at = entry.at || Date.now(); entry.up = [];
    await DB.put(entry.id, entry); S.queued++; paintStatus();
    return entry.id;
  }
  // put cards at the top of Unsorted on Home. If the Mac (or the phone app) saved Home in the meantime, read it again and retry.
  async function addToHome(cards) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const { text, rev } = await download(ROOT + '/boards/home.json');
      const b = JSON.parse(text); if (!b || typeof b.cards !== 'object') throw new Error('Home is not readable');
      const have = new Set(Object.keys(b.cards)); const fresh = cards.filter((c) => !have.has(c.id)); // a second try must not add the same card twice
      if (!fresh.length) return;
      let tray = Object.values(b.cards).find((c) => c && c.type === 'column' && c.tray === true);
      const now = Date.now();
      if (!tray) { tray = { id: 'c' + rid(), type: 'column', tray: true, title: 'Unsorted', x: 0, y: 0, w: 304, z: 0, m: now }; b.cards[tray.id] = tray; }
      for (const c of Object.values(b.cards)) if (c.col === tray.id) c.ord = (c.ord || 0) + fresh.length; // newest first
      fresh.forEach((c, i) => { b.cards[c.id] = Object.assign({}, c, { col: tray.id, ord: i, x: 0, y: 0, z: 1, m: now, born: c.born || now }); });
      try { await upload(ROOT + '/boards/home.json', new Blob([JSON.stringify(b, null, 1)], { type: 'application/json' }), rev); return; }
      catch (e) { if (!e.conflict) throw e; }
    }
    throw new Error('Home kept changing');
  }
  let flushing = null;
  function flush() { if (!flushing) flushing = doFlush().finally(() => { flushing = null; }); return flushing; }
  async function doFlush() {
    if (!store.get('board.auth')) return;
    const all = await DB.all(); S.queued = all.length; if (!all.length) { paintStatus(); return; }
    S.state = 'sending'; paintStatus();
    try {
      for (const q of all) {
        if (q.hold && q.hold > Date.now()) continue; // still inside its "Discard" moment
        for (const f of q.files) {
          if (q.up.includes(f.name)) continue;
          try { await upload(ROOT + '/assets/' + f.name, f.blob, null); } catch (e) { if (!e.conflict) throw e; } // already there from an earlier try
          q.up.push(f.name); await DB.put(q.id, q);
        }
        await addToHome(q.cards);
        await DB.del(q.id); S.queued--; S.state = 'sending'; S.sentAt = Date.now(); paintStatus();
      }
      S.state = S.queued ? 'waiting' : 'sent'; S.lastError = '';
    } catch (e) {
      if (e.signedOut) { S.state = 'waiting'; showSignIn(); }
      else { S.state = e.offline ? 'waiting' : 'error'; S.lastError = e.offline ? '' : String(e.message || e); if (!e.offline) console.warn(e); }
    }
    paintStatus();
    if (S.queued && S.state !== 'error') { const left = await DB.all(); const next = Math.min(...left.map((q) => q.hold || 0)); if (next > Date.now()) setTimeout(flush, next - Date.now() + 50); }
  }
  function paintStatus() {
    const dot = $('#dot'), t = $('#statusText');
    if (S.state === 'sending') { dot.dataset.s = 'sending'; t.textContent = 'Sending' + (S.queued > 1 ? ' ' + S.queued : ''); }
    else if (S.queued) { dot.dataset.s = S.state === 'error' ? 'error' : 'waiting'; t.textContent = S.queued + ' waiting'; }
    else if (S.state === 'sent') { dot.dataset.s = 'sent'; t.textContent = 'Sent to BOARD'; }
    else { dot.dataset.s = 'idle'; t.textContent = 'Ready'; }
  }
  window.addEventListener('online', flush);

  // ------------------------------------------------------------------ SCAN: the camera
  const video = $('#video'), overlay = $('#overlay'), hint = $('#hint'), prog = $('#prog');
  const cam = { stream: null, on: false, starting: null };
  const look = { quad: null, shown: null, still: 0, miss: 0, armed: true, lastShot: null, busy: false };
  const small = document.createElement('canvas'), sctx = small.getContext('2d', { willReadFrequently: true });
  async function startCam() {
    if (cam.on || cam.starting) return cam.starting;
    cam.starting = (async () => {
      $('#camGate').hidden = true;
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('This browser has no camera access.');
        cam.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } } });
        video.srcObject = cam.stream; await video.play().catch(() => {});
        cam.on = true; look.still = 0; look.miss = 0; look.shown = null; requestAnimationFrame(tick);
      } catch (e) {
        cam.on = false; $('#camGate').hidden = false;
        $('#camMsg').textContent = e && e.name === 'NotAllowedError' ? 'BOARD Capture needs the camera to scan. Allow it, then try again.' : e && e.name === 'NotFoundError' ? 'No camera found on this device.' : 'The camera did not start.';
      }
    })().finally(() => { cam.starting = null; });
    return cam.starting;
  }
  function stopCam() { if (cam.stream) for (const t of cam.stream.getTracks()) t.stop(); cam.stream = null; cam.on = false; video.srcObject = null; look.shown = null; drawOverlay(); }
  const camWanted = () => S.mode === 'scan' && !document.hidden && $('#review').hidden && $('#editor').hidden && $('#gate').hidden;
  function camSync() { if (camWanted()) startCam(); else stopCam(); }
  // leaving the app: finish a recording, and don't make a voice note wait out its "Discard" moment
  async function releaseHolds() { for (const q of await DB.all()) if (q.hold) { q.hold = 0; await DB.put(q.id, q); } }
  document.addEventListener('visibilitychange', () => { if (document.hidden && rec.on) stopRec(); camSync(); if (document.hidden) releaseHolds().then(flush); else flush(); });
  $('#camBtn').addEventListener('click', startCam);

  // ---- looking for the page, a dozen times a second
  let lastLook = 0;
  function tick(now) {
    if (!cam.on) return;
    requestAnimationFrame(tick);
    if (now - lastLook < 75 || look.busy || !video.videoWidth) return; lastLook = now;
    const vw = video.videoWidth, vh = video.videoHeight, k = 320 / Math.max(vw, vh), sw = Math.round(vw * k), sh = Math.round(vh * k);
    if (small.width !== sw || small.height !== sh) { small.width = sw; small.height = sh; }
    sctx.drawImage(video, 0, 0, sw, sh);
    let r = null; try { r = SCAN.find(sctx.getImageData(0, 0, sw, sh).data, sw, sh); } catch (e) { r = null; }
    if (r) {
      const q = r.quad.map((p) => [p[0] / sw, p[1] / sh]);
      const moved = look.quad ? Math.max(...q.map((p, i) => Math.hypot(p[0] - look.quad[i][0], p[1] - look.quad[i][1]))) : 1;
      look.still = moved < 0.014 ? look.still + 1 : 0; look.miss = 0; look.quad = q;
      look.shown = look.shown && moved < 0.06 ? look.shown.map((p, i) => [p[0] + (q[i][0] - p[0]) * 0.55, p[1] + (q[i][1] - p[1]) * 0.55]) : q; // ease toward it, so the outline doesn't jitter
      if (!look.armed && look.lastShot && Math.max(...q.map((p, i) => Math.hypot(p[0] - look.lastShot[i][0], p[1] - look.lastShot[i][1]))) > 0.07) look.armed = true; // a different page (or the same one moved): ready again
    } else if (++look.miss > 3) { look.quad = null; look.shown = null; look.still = 0; if (look.miss > 6) look.armed = true; }
    const ready = S.auto && look.armed && look.quad;
    prog.style.strokeDashoffset = String(226.2 * (1 - (ready ? clamp(look.still / STILL_FRAMES, 0, 1) : 0)));
    hint.classList.remove('good');
    hint.textContent = !look.quad ? 'Point at a page' : !S.auto ? 'Tap the button' : !look.armed ? 'Got it. Next page?' : 'Hold still';
    if (!look.armed && look.quad) hint.classList.add('good');
    drawOverlay();
    if (ready && look.still >= STILL_FRAMES) shoot(true);
  }
  // the outline of the page, drawn over the picture (the picture is shown whole, so there may be bars at the sides)
  function drawOverlay() {
    const cw = overlay.clientWidth, ch = overlay.clientHeight, dpr = Math.min(3, window.devicePixelRatio || 1);
    if (overlay.width !== Math.round(cw * dpr) || overlay.height !== Math.round(ch * dpr)) { overlay.width = Math.round(cw * dpr); overlay.height = Math.round(ch * dpr); }
    const c = overlay.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, cw, ch);
    const q = look.shown, vw = video.videoWidth, vh = video.videoHeight; if (!q || !vw) return;
    const k = Math.min(cw / vw, ch / vh), ox = (cw - vw * k) / 2, oy = (ch - vh * k) / 2;
    const locking = S.auto && look.armed ? clamp(look.still / STILL_FRAMES, 0, 1) : 0, done = !look.armed;
    c.beginPath(); q.forEach((p, i) => { const x = ox + p[0] * vw * k, y = oy + p[1] * vh * k; if (i) c.lineTo(x, y); else c.moveTo(x, y); }); c.closePath();
    c.fillStyle = done ? 'rgba(48,192,108,.22)' : 'rgba(110,155,255,' + (0.16 + 0.14 * locking) + ')'; c.fill();
    c.lineWidth = 3; c.lineJoin = 'round'; c.strokeStyle = done || locking > 0.6 ? '#30c06c' : '#6e9bff'; c.stroke();
  }

  // ---- taking the picture
  async function shoot(byItself) {
    if (look.busy || !cam.on || !video.videoWidth) return;
    look.busy = true;
    try {
      const vw = video.videoWidth, vh = video.videoHeight;
      const full = document.createElement('canvas'); full.width = vw; full.height = vh;
      full.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0, vw, vh);
      const quad = look.quad ? look.quad.map((p) => p.slice()) : null;
      const fl = $('#flash'); fl.classList.remove('go'); void fl.offsetWidth; fl.classList.add('go');
      if (navigator.vibrate) navigator.vibrate(12);
      look.lastShot = quad; look.armed = false; look.still = 0; prog.style.strokeDashoffset = '226.2';
      const page = { id: 'p' + rid(), sw: vw, sh: vh, found: !!quad, quad: quad || [[0.06, 0.06], [0.94, 0.06], [0.94, 0.94], [0.06, 0.94]], mode: S.filter, rot: 0, src: null, out: null, ow: 0, oh: 0, url: '', busy: null };
      S.pages.push(page); paintStack();
      page.busy = (async () => {
        await frame();
        if (page.found) page.quad = tighten(full, page.quad);
        await develop(page, full);
        page.src = await toBlob(full, 'image/jpeg', 0.92);
      })().catch((e) => { console.warn(e); S.pages = S.pages.filter((p) => p !== page); toast('That page did not come out. Try again.'); }).finally(() => { page.busy = null; paintStack(); });
      if (!quad) toast('No page edges found. Open the page to set its corners.');
    } finally { look.busy = false; }
  }
  // the corners, nudged onto the true paper edge on a larger copy of the frame
  function tighten(full, quad) {
    const k = Math.min(1, 1280 / Math.max(full.width, full.height)), w = Math.round(full.width * k), hh = Math.round(full.height * k);
    const c = document.createElement('canvas'); c.width = w; c.height = hh; const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(full, 0, 0, w, hh);
    const q = SCAN.sharpen(x.getImageData(0, 0, w, hh).data, w, hh, quad.map((p) => [p[0] * w, p[1] * hh]));
    return q.map((p) => [p[0] / w, p[1] / hh]);
  }
  async function canvasFrom(blob) {
    const url = URL.createObjectURL(blob);
    try { const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; }); const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0); return c; }
    finally { URL.revokeObjectURL(url); }
  }
  // from the photo to the finished page: flatten, clean, turn, and keep it as a JPEG
  async function develop(page, full) {
    if (!full) full = await canvasFrom(page.src);
    const w = full.width, hh = full.height, data = full.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, hh).data;
    let q = SCAN.order(page.quad.map((p) => [p[0] * w, p[1] * hh]));
    const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
    q = q.map((p) => [p[0] + (cx - p[0]) * 0.006, p[1] + (cy - p[1]) * 0.006]); // a hair inside the edge, so no sliver of table comes with it
    const ps = SCAN.pageSize(q, w, hh, MAX_SIDE);
    const flat = SCAN.flatten(data, w, hh, q, ps.W, ps.H); SCAN.clean(flat, ps.W, ps.H, page.mode);
    let out = document.createElement('canvas'); out.width = ps.W; out.height = ps.H; out.getContext('2d').putImageData(new ImageData(flat, ps.W, ps.H), 0, 0);
    if (page.rot) { const r = document.createElement('canvas'); const swap = page.rot % 180 !== 0; r.width = swap ? ps.H : ps.W; r.height = swap ? ps.W : ps.H; const x = r.getContext('2d'); x.translate(r.width / 2, r.height / 2); x.rotate(page.rot * Math.PI / 180); x.drawImage(out, -ps.W / 2, -ps.H / 2); out = r; }
    page.out = await toBlob(out, 'image/jpeg', 0.82); page.ow = out.width; page.oh = out.height;
    if (page.url) URL.revokeObjectURL(page.url); page.url = URL.createObjectURL(page.out);
  }
  const settle = () => Promise.all(S.pages.map((p) => p.busy).filter(Boolean));
  function paintStack() {
    const n = S.pages.length, last = S.pages[n - 1];
    $('#stackBtn').hidden = !n; $('#sendBtn').hidden = !n; $('#stackN').textContent = String(n);
    $('#stackBtn').classList.toggle('busy', !!(last && last.busy));
    if (last && last.url) $('#stackImg').src = last.url; else if (!n) $('#stackImg').removeAttribute('src');
    if (!$('#review').hidden) paintReview();
  }

  // ---- sending the pages
  async function sendPages() {
    if (!S.pages.length) return;
    $('#sendBtn').disabled = true; $('#reviewSend').disabled = true;
    try {
      await settle();
      const pages = S.pages.filter((p) => p.out); if (!pages.length) return;
      const when = new Date(), title = 'Scan · ' + stampText(when);
      let entry;
      if (S.format === 'pdf') {
        const jpegs = []; for (const p of pages) jpegs.push({ jpeg: new Uint8Array(await p.out.arrayBuffer()), w: p.ow, h: p.oh });
        const bytes = SCAN.pdf(jpegs, title), name = 's' + rid() + '.pdf';
        entry = { kind: 'scan', label: title, files: [{ name, blob: new Blob([bytes], { type: 'application/pdf' }) }],
          cards: [{ id: 'c' + rid(), type: 'link', file: true, url: 'assets/' + name, title: title + '.pdf', site: ['PDF', humanSize(bytes.length)].join(' · '), w: 260, pages: pages.length, coverAr: +(pages[0].ow / pages[0].oh).toFixed(4) }] };
      } else {
        entry = { kind: 'scan', label: title, files: [], cards: [] };
        pages.forEach((p, i) => { const name = 's' + rid() + i + '.jpg'; entry.files.push({ name, blob: p.out }); entry.cards.push({ id: 'c' + rid() + i, type: 'image', src: 'assets/' + name, ar: +(p.ow / p.oh).toFixed(4), w: 320, caption: pages.length > 1 ? title + ' · ' + (i + 1) + ' of ' + pages.length : title }); });
      }
      await enqueue(entry);
      for (const p of S.pages) if (p.url) URL.revokeObjectURL(p.url);
      S.pages = []; closeReview(); paintStack();
      toast(navigator.onLine === false ? 'Saved. It goes to BOARD when you are back online.' : (pages.length === 1 ? '1 page' : pages.length + ' pages') + ' on the way to Unsorted');
      flush();
    } catch (e) { console.warn(e); toast('Could not put those pages together. Try again.'); }
    finally { $('#sendBtn').disabled = false; $('#reviewSend').disabled = false; }
  }

  // ------------------------------------------------------------------ SCAN: looking over the pages before they go
  const review = $('#review'), rgrid = $('#rgrid');
  function openReview() { review.hidden = false; paintReview(); camSync(); }
  function closeReview() { review.hidden = true; camSync(); }
  function paintReview() {
    const n = S.pages.length; if (!n) { closeReview(); return; }
    $('#reviewTitle').textContent = n === 1 ? '1 page' : n + ' pages';
    for (const b of $('#format').children) b.classList.toggle('on', b.dataset.f === S.format);
    const have = new Map([...rgrid.children].map((el) => [el.dataset.id, el]));
    S.pages.forEach((p, i) => {
      let el = have.get(p.id);
      if (!el) { el = h('div', 'rthumb'); el.dataset.id = p.id; el.append(h('img'), h('span', 'num')); }
      have.delete(p.id);
      const img = el.firstChild; if (p.url && img.getAttribute('src') !== p.url) img.src = p.url;
      el.classList.toggle('busy', !!p.busy); el.lastChild.textContent = String(i + 1);
      if (rgrid.children[i] !== el) rgrid.insertBefore(el, rgrid.children[i] || null);
    });
    for (const el of have.values()) el.remove();
  }
  // drag a page to a new place in the order; a tap opens it
  rgrid.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.rthumb'); if (!el) return;
    const sx = e.clientX, sy = e.clientY; let dragging = false, base = null, grab = null;
    try { rgrid.setPointerCapture(e.pointerId); } catch (err) { /* fine */ }
    const place = (x, y) => { el.style.transform = 'translate(' + (x - grab.x - base.left) + 'px,' + (y - grab.y - base.top) + 'px) scale(1.04)'; };
    const rebase = () => { const t = el.style.transform; el.style.transform = ''; base = el.getBoundingClientRect(); el.style.transform = t; };
    const move = (ev) => {
      if (!dragging) { if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 9) return; dragging = true; el.classList.add('drag'); base = el.getBoundingClientRect(); grab = { x: sx - base.left, y: sy - base.top }; }
      place(ev.clientX, ev.clientY);
      const others = [...rgrid.children].filter((x) => x !== el); let over = null;
      for (const o of others) { const r = o.getBoundingClientRect(); if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) { over = o; break; } }
      if (!over) return;
      const kids = [...rgrid.children], from = kids.indexOf(el), to = kids.indexOf(over);
      rgrid.insertBefore(el, from < to ? over.nextSibling : over);
      const pg = S.pages.splice(from, 1)[0]; S.pages.splice(to, 0, pg);
      [...rgrid.children].forEach((x, i) => { x.lastChild.textContent = String(i + 1); });
      rebase(); place(ev.clientX, ev.clientY);
    };
    const up = () => {
      rgrid.removeEventListener('pointermove', move); rgrid.removeEventListener('pointerup', up); rgrid.removeEventListener('pointercancel', up);
      el.classList.remove('drag'); el.style.transform = '';
      if (!dragging) openEditor(el.dataset.id); else paintStack();
    };
    rgrid.addEventListener('pointermove', move); rgrid.addEventListener('pointerup', up); rgrid.addEventListener('pointercancel', up);
  });
  $('#reviewClose').addEventListener('click', closeReview);
  $('#reviewAdd').addEventListener('click', closeReview);
  $('#reviewSend').addEventListener('click', sendPages);
  $('#format').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; S.format = b.dataset.f; store.set('capture.format', S.format); paintReview(); });
  $('#stackBtn').addEventListener('click', openReview);
  $('#sendBtn').addEventListener('click', sendPages);

  // ------------------------------------------------------------------ SCAN: one page, its corners and its look
  const editor = $('#editor'), edImg = $('#edImg'), edSvg = $('#edSvg'), edStage = $('#edStage');
  let ed = null; // { page, quad, mode, rot, url }
  async function openEditor(id) {
    const page = S.pages.find((p) => p.id === id); if (!page) return;
    if (page.busy) await page.busy; if (!page.src) return;
    ed = { page, quad: page.quad.map((p) => p.slice()), mode: page.mode, rot: page.rot, url: URL.createObjectURL(page.src) };
    edImg.src = ed.url; editor.hidden = false; $('#edTitle').textContent = 'Page ' + (S.pages.indexOf(page) + 1);
    paintEditor();
  }
  function edBox() { // where the photo sits inside the editing area (shown whole, with a margin for the corner handles)
    const pad = 22, W = edStage.clientWidth - pad * 2, H = edStage.clientHeight - pad * 2, k = Math.min(W / ed.page.sw, H / ed.page.sh);
    return { x: pad + (W - ed.page.sw * k) / 2, y: pad + (H - ed.page.sh * k) / 2, w: ed.page.sw * k, h: ed.page.sh * k };
  }
  function paintEditor() {
    if (!ed) return; const b = edBox(), NS = 'http://www.w3.org/2000/svg';
    const pts = ed.quad.map((p) => [b.x + p[0] * b.w, b.y + p[1] * b.h]);
    if (!edSvg.firstChild) { edSvg.append(document.createElementNS(NS, 'polygon')); for (let i = 0; i < 4; i++) { const c = document.createElementNS(NS, 'circle'); c.setAttribute('r', '15'); c.dataset.i = String(i); edSvg.append(c); } }
    edSvg.firstChild.setAttribute('points', pts.map((p) => p.join(',')).join(' '));
    [...edSvg.querySelectorAll('circle')].forEach((c, i) => { c.setAttribute('cx', pts[i][0]); c.setAttribute('cy', pts[i][1]); });
    for (const x of $('#edFilter').children) x.classList.toggle('on', x.dataset.m === ed.mode);
    $('#edRotate').textContent = ed.rot ? 'Rotate · ' + ed.rot + '°' : 'Rotate';
  }
  edStage.addEventListener('pointerdown', (e) => {
    if (!ed) return; const b = edBox(), r = edStage.getBoundingClientRect();
    const at = (ev) => [clamp((ev.clientX - r.left - b.x) / b.w, 0, 1), clamp((ev.clientY - r.top - b.y) / b.h, 0, 1)];
    const p0 = at(e); let i = 0, best = Infinity; ed.quad.forEach((p, k) => { const d = Math.hypot((p[0] - p0[0]) * b.w, (p[1] - p0[1]) * b.h); if (d < best) { best = d; i = k; } });
    if (best > 70) return; // nowhere near a corner
    const off = [ed.quad[i][0] - p0[0], ed.quad[i][1] - p0[1]]; const dot = edSvg.querySelectorAll('circle')[i]; dot.classList.add('hold');
    try { edStage.setPointerCapture(e.pointerId); } catch (err) { /* fine */ }
    const move = (ev) => { const p = at(ev); ed.quad[i] = [clamp(p[0] + off[0], 0, 1), clamp(p[1] + off[1], 0, 1)]; ed.touched = true; paintEditor(); };
    const up = () => { dot.classList.remove('hold'); edStage.removeEventListener('pointermove', move); edStage.removeEventListener('pointerup', up); edStage.removeEventListener('pointercancel', up); };
    edStage.addEventListener('pointermove', move); edStage.addEventListener('pointerup', up); edStage.addEventListener('pointercancel', up);
  });
  window.addEventListener('resize', () => { paintEditor(); drawOverlay(); });
  $('#edFilter').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b || !ed) return; ed.mode = b.dataset.m; paintEditor(); });
  $('#edRotate').addEventListener('click', () => { if (!ed) return; ed.rot = (ed.rot + 90) % 360; paintEditor(); });
  $('#edDelete').addEventListener('click', () => { if (!ed) return; const p = ed.page; if (p.url) URL.revokeObjectURL(p.url); S.pages = S.pages.filter((x) => x !== p); closeEditor(); paintStack(); });
  $('#edDone').addEventListener('click', () => {
    if (!ed) return; const p = ed.page;
    const changed = ed.touched || ed.mode !== p.mode || ed.rot !== p.rot;
    if (changed) { p.quad = ed.quad; p.mode = ed.mode; p.rot = ed.rot; p.busy = develop(p).catch((e) => console.warn(e)).finally(() => { p.busy = null; paintStack(); }); }
    closeEditor(); paintStack();
  });
  function closeEditor() { if (ed) URL.revokeObjectURL(ed.url); ed = null; editor.hidden = true; edImg.removeAttribute('src'); }

  // ------------------------------------------------------------------ VOICE: one tap to record, one to stop
  const rec = { on: false, mr: null, stream: null, chunks: [], t0: 0, timer: 0, ctx: null, an: null, levels: [], lock: null, mime: '' };
  const meter = $('#meter'), vtime = $('#vtime'), vhint = $('#vhint'), core = $('#core');
  const pickMime = () => { if (!window.MediaRecorder) return null; for (const m of ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']) if (MediaRecorder.isTypeSupported(m)) return m; return ''; };
  function shape(recording) { // the button: a round dot to start, a square to stop
    const a = recording ? { x: 26, y: 26, width: 28, height: 28, rx: 6 } : { x: 10, y: 10, width: 60, height: 60, rx: 30 };
    for (const k of Object.keys(a)) core.setAttribute(k, a[k]);
  }
  async function startRec() {
    if (rec.on) return;
    const mime = pickMime(); if (mime === null) { toast('This browser cannot record sound.'); return; }
    try { rec.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false }); }
    catch (e) { toast(e && e.name === 'NotAllowedError' ? 'Allow the microphone to record a voice note.' : 'The microphone did not start.'); return; }
    rec.mime = mime; rec.chunks = []; rec.levels = [];
    rec.mr = new MediaRecorder(rec.stream, mime ? { mimeType: mime, audioBitsPerSecond: 96000 } : undefined);
    rec.mr.ondataavailable = (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); };
    rec.mr.onstop = finishRec;
    rec.mr.start(1000);
    rec.on = true; rec.t0 = Date.now(); $('#app').classList.add('rec'); shape(true); vhint.textContent = 'Recording. Tap to finish.';
    try { const AC = window.AudioContext || window.webkitAudioContext; rec.ctx = new AC(); rec.an = rec.ctx.createAnalyser(); rec.an.fftSize = 512; rec.ctx.createMediaStreamSource(rec.stream).connect(rec.an); } catch (e) { rec.an = null; }
    try { if (navigator.wakeLock) rec.lock = await navigator.wakeLock.request('screen'); } catch (e) { rec.lock = null; }
    rec.timer = setInterval(paintRec, 80); paintRec();
  }
  function paintRec() {
    const s = (Date.now() - rec.t0) / 1000; vtime.textContent = mmss(s);
    if (rec.an) { const buf = new Uint8Array(rec.an.fftSize); rec.an.getByteTimeDomainData(buf); let pk = 0; for (let i = 0; i < buf.length; i++) pk = Math.max(pk, Math.abs(buf[i] - 128)); rec.levels.push(pk / 128); if (rec.levels.length > 64) rec.levels.shift(); }
    paintMeter();
  }
  function paintMeter() {
    const c = meter.getContext('2d'), W = meter.width, H = meter.height, n = 64, bw = W / n; c.clearRect(0, 0, W, H);
    for (let i = 0; i < n; i++) { const v = rec.levels[rec.levels.length - n + i] || 0, bh = Math.max(4, Math.min(1, v * 1.6) * (H - 8)); c.fillStyle = rec.on ? '#ff4d4f' : '#343841'; c.fillRect(i * bw + 2, (H - bh) / 2, bw - 4, bh); }
  }
  function stopRec() { if (!rec.on) return; rec.on = false; clearInterval(rec.timer); try { rec.mr.stop(); } catch (e) { finishRec(); } }
  async function finishRec() {
    const secs = Math.max(0, (Date.now() - rec.t0) / 1000);
    if (rec.stream) for (const t of rec.stream.getTracks()) t.stop(); rec.stream = null;
    if (rec.ctx) { try { rec.ctx.close(); } catch (e) { /* fine */ } rec.ctx = null; rec.an = null; }
    if (rec.lock) { try { rec.lock.release(); } catch (e) { /* fine */ } rec.lock = null; }
    $('#app').classList.remove('rec'); shape(false); vtime.textContent = '0:00'; vhint.textContent = 'Tap to record'; rec.levels = []; paintMeter();
    const type = (rec.mime || (rec.chunks[0] && rec.chunks[0].type) || 'audio/mp4').split(';')[0];
    const blob = new Blob(rec.chunks, { type }); rec.chunks = [];
    if (secs < 0.7 || !blob.size) { toast('Too short to keep.'); return; }
    const when = new Date(), title = 'Voice note · ' + stampText(when), name = 'v' + rid() + (/mp4|m4a|aac/.test(type) ? '.m4a' : /webm/.test(type) ? '.weba' : /ogg/.test(type) ? '.ogg' : '.m4a');
    const id = await enqueue({ kind: 'voice', label: title, hold: Date.now() + 5000, files: [{ name, blob }],
      cards: [{ id: 'c' + rid(), type: 'link', file: true, audio: true, url: 'assets/' + name, title, site: ['Voice note', mmss(Math.round(secs))].join(' · '), dur: Math.round(secs), w: 260 }] });
    toast('Voice note saved · ' + mmss(Math.round(secs)), 'Discard', async () => { await DB.del(id); S.queued = Math.max(0, S.queued - 1); paintStatus(); toast('Discarded'); }, 5000);
    setTimeout(flush, 5100);
  }

  // ------------------------------------------------------------------ the button, the strip of modes, and swiping between them
  const MODES = ['scan', 'voice'];
  function setMode(m) {
    if (rec.on || !MODES.includes(m) || m === S.mode) return;
    S.mode = m; $('#app').dataset.mode = m;
    for (const b of $('#modes').children) b.classList.toggle('on', b.dataset.mode === m);
    $('#shutter').setAttribute('aria-label', m === 'scan' ? 'Capture' : 'Record');
    camSync();
  }
  $('#modes').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setMode(b.dataset.mode); });
  $('#shutter').addEventListener('click', () => { if (S.mode === 'scan') shoot(false); else if (rec.on) stopRec(); else startRec(); });
  { // a sideways swipe anywhere on the picture area moves along the strip
    const stage = $('#stage'); let s = null;
    stage.addEventListener('pointerdown', (e) => { s = { x: e.clientX, y: e.clientY, t: Date.now() }; });
    stage.addEventListener('pointerup', (e) => {
      if (!s) return; const dx = e.clientX - s.x, dy = e.clientY - s.y, quick = Date.now() - s.t < 700; s = null;
      if (!quick || Math.abs(dx) < 56 || Math.abs(dy) > Math.abs(dx) * 0.7) return;
      const i = MODES.indexOf(S.mode) + (dx < 0 ? 1 : -1); if (MODES[i]) setMode(MODES[i]);
    });
    stage.addEventListener('pointercancel', () => { s = null; });
  }
  function paintChips() { $('#filterBtn').textContent = FILTERS[S.filter]; $('#autoBtn').classList.toggle('on', S.auto); $('#autoBtn').textContent = S.auto ? 'Auto' : 'Manual'; }
  $('#filterBtn').addEventListener('click', () => { const k = Object.keys(FILTERS); S.filter = k[(k.indexOf(S.filter) + 1) % k.length]; store.set('capture.filter', S.filter); paintChips(); });
  $('#autoBtn').addEventListener('click', () => { S.auto = !S.auto; store.set('capture.auto', S.auto); look.still = 0; paintChips(); });

  // ------------------------------------------------------------------ panels that slide up
  const sheet = $('#sheet'), sheetBody = $('#sheetBody'), shade = $('#shade');
  function openSheet(build) { sheetBody.textContent = ''; build(sheetBody); sheet.hidden = false; shade.hidden = false; requestAnimationFrame(() => sheet.classList.add('up')); }
  function closeSheet() { sheet.classList.remove('up'); shade.hidden = true; setTimeout(() => { sheet.hidden = true; sheetBody.textContent = ''; }, 200); }
  shade.addEventListener('click', closeSheet);
  const btn = (label, cls, fn) => { const b = h('button', 'sbtn' + (cls ? ' ' + cls : ''), label); b.type = 'button'; b.addEventListener('click', fn); return b; };
  async function menu() {
    const a = store.get('board.auth'), waiting = await DB.all();
    openSheet((body) => {
      body.append(h('div', 'stitle', 'BOARD Capture'));
      body.append(h('div', 'snote', a ? 'Signed in to Dropbox. Everything you capture lands in Unsorted on Home.' : 'Not signed in.'));
      if (waiting.length) {
        body.append(h('div', 'snote', (waiting.length === 1 ? '1 thing is' : waiting.length + ' things are') + ' waiting to go up' + (S.lastError ? ' (' + S.lastError + ')' : '') + ':'));
        for (const q of waiting) { const row = h('div', 'qrow'); row.append(h('span', '', q.label || q.kind), h('span', '', humanSize(q.files.reduce((n, f) => n + (f.blob ? f.blob.size : 0), 0)))); body.append(row); }
        body.append(btn('Send now', 'primary', () => { closeSheet(); flush(); }));
      }
      if (a) body.append(btn('Sign out of Dropbox', 'danger', () => { store.del('board.auth'); location.reload(); }));
      body.append(h('div', 'snote small', VERSION), btn('Close', 'quiet', closeSheet));
    });
  }
  $('#menuBtn').addEventListener('click', menu);
  $('#statusBtn').addEventListener('click', menu);

  // ------------------------------------------------------------------ signing in screens
  const gate = $('#gate');
  function showSignIn() {
    gate.hidden = false; gate.textContent = ''; camSync();
    gate.append(h('div', 'gtitle', 'BOARD Capture'), h('div', 'gnote', 'Scan a page or record a voice note, and it lands in BOARD. Sign in to the Dropbox that holds your BOARD folder.'));
    if (REDIRECT_READY) gate.append(btn('Sign in with Dropbox', 'primary', () => startSignIn(false)), btn('Sign in with a code instead', 'quiet', () => startSignIn(true)));
    else gate.append(btn('Sign in with Dropbox', 'primary', () => startSignIn(true)));
    if (!standalone()) gate.append(h('div', 'gnote small', 'Tip: use Share, then Add to Home Screen, to keep Capture as its own app. Sign in after you open it from there.'));
  }
  function showCodeBox(url) {
    gate.hidden = false; gate.textContent = '';
    gate.append(h('div', 'gtitle', 'Sign in'), h('div', 'gnote', 'Tap Open Dropbox, then Allow. Dropbox shows a code: copy it, come back here and paste it below.'));
    const a = h('a', 'sbtn primary', 'Open Dropbox'); a.href = url; a.target = '_blank'; a.rel = 'noopener'; gate.append(a);
    const inp = h('input', 'urlin'); inp.placeholder = 'Paste the code'; inp.autocapitalize = 'off'; inp.autocomplete = 'off';
    const ok = btn('Continue', 'primary', async () => { try { await finishSignIn(inp.value); gate.hidden = true; boot(); } catch (e) { toast(e.message); } });
    gate.append(inp, ok, btn('Start again', 'quiet', () => startSignIn(true)));
  }

  // ------------------------------------------------------------------ start
  async function boot() {
    const q = new URLSearchParams(location.search);
    if (q.get('code')) { try { await finishSignIn(q.get('code')); } catch (e) { toast(e.message); } history.replaceState(null, '', REDIRECT); }
    if (q.get('error')) history.replaceState(null, '', location.pathname);
    paintChips(); shape(false); paintMeter();
    S.queued = (await DB.all().catch(() => [])).length; paintStatus();
    if (!store.get('board.auth')) { showSignIn(); return; }
    gate.hidden = true; camSync(); flush();
  }
  window.BOARDCAPTURE = { S, look, cam, rec, DB, flush, shoot, setMode, settle, develop, version: VERSION };
  if ('serviceWorker' in navigator && !mockBase && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { /* works without it, just not offline */ });
  boot();
})();
