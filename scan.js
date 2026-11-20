/* BOARD Capture: the scanner's eyes and hands.
   Plain number work on pixels: no page, no camera, no network. The app (capture.js) feeds it frames; tests feed it made-up pictures.

   What is in here:
   - find(rgba, w, h)            where is the page in this small frame? Four corners, or null.
   - sharpen(rgba, w, h, quad)   nudge four corners onto the real paper edge, on a bigger copy of the frame
   - pageSize(quad, w, h, max)   how big the flattened page should be, with its true shape worked out from the perspective
   - flatten(rgba, w, h, quad, W, H)   pull the page out of the photo, straight and square
   - clean(rgba, w, h, mode)     even out the light and whiten the paper ('doc'), harder for a whiteboard ('board')
   - pdf(pages)                  JPEG pages in, one PDF out */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.SCAN = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------------ small pieces
  function gray(rgba, w, h) {
    const g = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
    return g;
  }
  // a soft blur: a box run across, then down (twice over is close to a true Gaussian)
  function blur(src, w, h, r) {
    const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h), win = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      let s = 0; const row = y * w;
      for (let x = -r; x <= r; x++) s += src[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) { tmp[row + x] = s / win; s += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)]; }
    }
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) { out[y * w + x] = s / win; s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]; }
    }
    return out;
  }
  // how hard the picture changes at each point, and which way (Sobel)
  function slopes(g, w, h) {
    const mag = new Float32Array(w * h), dir = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1] - g[i - w - 1] - 2 * g[i - 1] - g[i + w - 1];
      const gy = g[i + w - 1] + 2 * g[i + w] + g[i + w + 1] - g[i - w - 1] - 2 * g[i - w] - g[i - w + 1];
      const ax = Math.abs(gx), ay = Math.abs(gy);
      mag[i] = ax + ay;
      dir[i] = ay <= ax * 0.414 ? 0 : ax <= ay * 0.414 ? 2 : (gx > 0) === (gy > 0) ? 1 : 3; // across, down, or one of the diagonals
    }
    return { mag, dir };
  }
  // thin, joined-up edge lines (Canny): keep the ridge of each slope, keep faint parts only where they touch a strong part
  function edgeMap(g, w, h) {
    const { mag, dir } = slopes(g, w, h);
    const hist = new Uint32Array(256); let n = 0;
    for (let i = 0; i < mag.length; i++) { hist[Math.min(255, mag[i] >> 2)]++; n++; }
    // what counts as an edge is set against the strongest edges in this picture (a page border, print), so the grain of a table doesn't count
    let acc = 0, p = 255; for (let b = 255; b >= 0; b--) { acc += hist[b]; if (acc >= n * 0.005) { p = b; break; } }
    const hi = Math.max(30, Math.min(120, p * 4 * 0.22)), lo = hi * 0.45;
    const DX = [1, 1, 0, -1], DY = [0, 1, 1, 1];
    const e = new Uint8Array(w * h), stack = [];
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, m = mag[i]; if (m < lo) continue;
      const d = dir[i], o = DY[d] * w + DX[d];
      if (m < mag[i + o] || m < mag[i - o]) continue; // not the ridge
      if (m >= hi) { e[i] = 2; stack.push(i); } else e[i] = 1;
    }
    while (stack.length) {
      const i = stack.pop();
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const j = i + dy * w + dx; if (e[j] === 1) { e[j] = 2; stack.push(j); } }
    }
    const out = new Uint8Array(w * h); // one pixel fatter, so hairline gaps close
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x; if (e[i] !== 2) continue;
      out[i] = out[i - 1] = out[i + 1] = out[i - w] = out[i + w] = out[i - w - 1] = out[i - w + 1] = out[i + w - 1] = out[i + w + 1] = 1;
    }
    return { edge: out, mag, lo };
  }

  // ------------------------------------------------------------------ shapes
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  function hullOf(pts) { // the tightest rubber band round a set of points
    pts = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (pts.length < 3) return pts;
    const lower = [], upper = [];
    for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
    for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
    lower.pop(); upper.pop();
    return lower.concat(upper);
  }
  const areaOf = (poly) => { let a = 0; for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p[0] * q[1] - q[0] * p[1]; } return Math.abs(a) / 2; };
  function meet(p1, p2, p3, p4) { // where the line through p1,p2 crosses the line through p3,p4
    const d = (p1[0] - p2[0]) * (p3[1] - p4[1]) - (p1[1] - p2[1]) * (p3[0] - p4[0]);
    if (Math.abs(d) < 1e-9) return null;
    const a = p1[0] * p2[1] - p1[1] * p2[0], b = p3[0] * p4[1] - p3[1] * p4[0];
    return [(a * (p3[0] - p4[0]) - (p1[0] - p2[0]) * b) / d, (a * (p3[1] - p4[1]) - (p1[1] - p2[1]) * b) / d];
  }
  // a many-sided outline down to four sides: keep dropping the side that costs the least extra area when its neighbours are run on to meet
  function fourSides(hull) {
    let P = hull.slice();
    while (P.length > 4) {
      const n = P.length; let best = -1, bestArea = Infinity, bestX = null;
      for (let i = 0; i < n; i++) {
        const a = P[(i + n - 1) % n], b = P[i], c = P[(i + 1) % n], d = P[(i + 2) % n];
        const X = meet(a, b, c, d); if (!X) continue;
        // the neighbours have to close in on each other beyond this side, not behind it
        if ((X[0] - b[0]) * (b[0] - a[0]) + (X[1] - b[1]) * (b[1] - a[1]) < -1e-6) continue;
        if ((X[0] - c[0]) * (c[0] - d[0]) + (X[1] - c[1]) * (c[1] - d[1]) < -1e-6) continue;
        const add = Math.abs(cross(b, X, c)) / 2;
        if (add < bestArea) { bestArea = add; best = i; bestX = X; }
      }
      if (best < 0) return null;
      const next = [];
      for (let i = 0; i < n; i++) { if (i === best) next.push(bestX); else if (i !== (best + 1) % n) next.push(P[i]); }
      P = next;
    }
    return P.length === 4 ? P : null;
  }
  // corners in a fixed order: top-left, top-right, bottom-right, bottom-left
  function order(q) {
    const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
    const s = q.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx)); // clockwise on a screen
    let k = 0, m = Infinity; for (let i = 0; i < 4; i++) { const v = s[i][0] + s[i][1]; if (v < m) { m = v; k = i; } }
    return [s[k], s[(k + 1) % 4], s[(k + 2) % 4], s[(k + 3) % 4]];
  }
  function sane(q, w, h) { // does this look like a sheet of paper seen from somewhere sensible?
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
      if (cross(a, b, c) <= 0) return false; // must bulge outward all the way round
      const room = 0.015 * Math.min(w, h); if (a[0] < room || a[0] > w - room || a[1] < room || a[1] > h - room) return false; // a corner on the very edge of the frame means the page is cut off
      const ang = Math.acos(Math.max(-1, Math.min(1, ((a[0] - b[0]) * (c[0] - b[0]) + (a[1] - b[1]) * (c[1] - b[1])) / (dist(a, b) * dist(b, c) || 1)))) * 180 / Math.PI;
      if (ang < 38 || ang > 142) return false;
      if (dist(a, b) < 0.14 * Math.min(w, h)) return false;
    }
    const r1 = dist(q[0], q[1]) / dist(q[3], q[2]), r2 = dist(q[0], q[3]) / dist(q[1], q[2]);
    if (r1 < 0.4 || r1 > 2.5 || r2 < 0.4 || r2 > 2.5) return false;
    return areaOf(q) >= 0.09 * w * h;
  }

  // slide each side onto the strongest edge near it, then take the corners where the sides cross.
  // Also says how much of the outline really sits on an edge (0 to 1): the proof that this is a page and not a guess.
  function snap(q, mag, w, h, lo, reach) {
    const lines = [], support = []; let hits = 0, total = 0;
    for (let s = 0; s < 4; s++) {
      const a = q[s], b = q[(s + 1) % 4]; const len = dist(a, b); if (len < 4) return null;
      const tx = (b[0] - a[0]) / len, ty = (b[1] - a[1]) / len, nx = -ty, ny = tx;
      const N = Math.max(12, Math.min(90, Math.round(len / 2))); const pts = []; let ok = 0;
      for (let k = 0; k < N; k++) {
        const t = 0.07 + 0.86 * (k + 0.5) / N; const px = a[0] + tx * len * t, py = a[1] + ty * len * t;
        let bm = 0, bo = 0;
        for (let o = -reach; o <= reach; o += 0.5) {
          const x = Math.floor(px + nx * o), y = Math.floor(py + ny * o); if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
          const m = mag[y * w + x] - Math.abs(o) * 0.02; if (m > bm) { bm = m; bo = o; }
        }
        if (bm >= lo) pts.push([px + nx * bo, py + ny * bo]);
      }
      const all = pts.slice();
      let line = [a, b];
      if (pts.length >= 6) { // best straight line through the edge points, ignoring the ones that stray
        for (let pass = 0; pass < 2; pass++) {
          let mx = 0, my = 0; for (const p of pts) { mx += p[0]; my += p[1]; } mx /= pts.length; my /= pts.length;
          let sxx = 0, sxy = 0, syy = 0; for (const p of pts) { const dx = p[0] - mx, dy = p[1] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
          const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), ux = Math.cos(th), uy = Math.sin(th);
          line = [[mx - ux * len, my - uy * len], [mx + ux * len, my + uy * len]];
          if (pass === 0) { const keep = pts.filter((p) => Math.abs((p[0] - mx) * -uy + (p[1] - my) * ux) <= Math.max(1, reach * 0.35)); if (keep.length >= 6) { pts.length = 0; pts.push(...keep); } else break; }
        }
      }
      // a real paper edge is straight: only the points that sit on the line count. Scattered edges (wood grain, carpet) don't line up.
      { const lx = line[1][0] - line[0][0], ly = line[1][1] - line[0][1], ll = Math.hypot(lx, ly) || 1; ok = 0; for (const p of all) if (Math.abs((p[0] - line[0][0]) * ly - (p[1] - line[0][1]) * lx) / ll <= Math.max(1.3, reach * 0.12)) ok++; }
      support.push(ok / N); hits += ok; total += N;
      lines.push(line);
    }
    const out = [];
    for (let s = 0; s < 4; s++) { const X = meet(lines[(s + 3) % 4][0], lines[(s + 3) % 4][1], lines[s][0], lines[s][1]); if (!X) return null; out.push(X); }
    return { quad: out, support: hits / total, sides: support };
  }

  // ------------------------------------------------------------------ finding the page
  // Two ways of looking, best answer wins:
  //  A. the patch of the picture around the middle that is fenced in by edges on every side (the sheet, inside its own border)
  //  B. the biggest bright patch (paper on a darker table), found on a heavily blurred copy so print and ruled lines don't break it up
  function find(rgba, w, h) {
    const g0 = gray(rgba, w, h), g = blur(blur(g0, w, h, 1), w, h, 1);
    const { edge, mag, lo } = edgeMap(g, w, h);
    const cands = [];
    const consider = (rowMin, rowMax, count, touch) => {
      if (count < 0.08 * w * h || touch > 0.06 * 2 * (w + h)) return;
      const pts = []; for (let y = 0; y < h; y++) if (rowMax[y] >= 0) { pts.push([rowMin[y] + 0.5, y + 0.5]); if (rowMax[y] !== rowMin[y]) pts.push([rowMax[y] + 0.5, y + 0.5]); } // the middle of each pixel
      const hull = hullOf(pts); if (hull.length < 4) return;
      const q4 = fourSides(hull); if (!q4) return;
      const q = order(q4); if (!sane(q, w, h)) return;
      const s = snap(q, mag, w, h, lo, 4.5); if (!s) return;
      const q2 = order(s.quad); if (!sane(q2, w, h)) return;
      if (s.support < 0.62 || Math.min(...s.sides) < 0.3) return;
      cands.push({ quad: q2, support: s.support, score: areaOf(q2) / (w * h) * s.support * s.support });
    };
    const fill = (start, pass, label, lab) => { // flood out from one point; remember the left and right end of every row it reaches
      const rowMin = new Int32Array(h).fill(w), rowMax = new Int32Array(h).fill(-1); let count = 0, touch = 0;
      const stack = [start]; lab[start] = label;
      while (stack.length) {
        const i = stack.pop(), x = i % w, y = (i - x) / w; count++;
        if (x < rowMin[y]) rowMin[y] = x; if (x > rowMax[y]) rowMax[y] = x;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touch++;
        if (x > 0 && !lab[i - 1] && pass(i - 1)) { lab[i - 1] = label; stack.push(i - 1); }
        if (x < w - 1 && !lab[i + 1] && pass(i + 1)) { lab[i + 1] = label; stack.push(i + 1); }
        if (y > 0 && !lab[i - w] && pass(i - w)) { lab[i - w] = label; stack.push(i - w); }
        if (y < h - 1 && !lab[i + w] && pass(i + w)) { lab[i + w] = label; stack.push(i + w); }
      }
      return { rowMin, rowMax, count, touch };
    };
    // A
    const labA = new Uint8Array(w * h); let label = 0;
    for (const [fx, fy] of [[0.5, 0.5], [0.4, 0.4], [0.6, 0.4], [0.4, 0.6], [0.6, 0.6], [0.5, 0.32], [0.5, 0.68], [0.32, 0.5], [0.68, 0.5]]) {
      const i = Math.round(fy * h) * w + Math.round(fx * w); if (edge[i] || labA[i]) continue;
      const r = fill(i, (j) => !edge[j], ++label, labA); consider(r.rowMin, r.rowMax, r.count, r.touch);
    }
    // B
    const soft = blur(blur(g0, w, h, Math.max(2, Math.round(Math.max(w, h) / 90))), w, h, Math.max(2, Math.round(Math.max(w, h) / 90)));
    const hist = new Uint32Array(256); for (let i = 0; i < soft.length; i++) hist[soft[i]]++;
    let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sumB = 0, wB = 0, best = 0, cut = 127; const tot = soft.length;
    for (let t = 0; t < 256; t++) { wB += hist[t]; if (!wB) continue; const wF = tot - wB; if (!wF) break; sumB += t * hist[t]; const mB = sumB / wB, mF = (sum - sumB) / wF; const v = wB * wF * (mB - mF) * (mB - mF); if (v > best) { best = v; cut = t; } }
    const labB = new Uint8Array(w * h); let biggest = null;
    for (let y = 2; y < h - 2; y += 3) for (let x = 2; x < w - 2; x += 3) {
      const i = y * w + x; if (labB[i] || soft[i] <= cut) continue;
      const r = fill(i, (j) => soft[j] > cut, 1, labB); if (!biggest || r.count > biggest.count) biggest = r;
    }
    if (biggest) consider(biggest.rowMin, biggest.rowMax, biggest.count, biggest.touch);
    if (!cands.length) return null;
    cands.sort((a, b) => b.score - a.score);
    return { quad: cands[0].quad, support: cands[0].support };
  }

  // the same four corners, tightened up on a larger copy of the frame (called once, at the moment of capture)
  function sharpen(rgba, w, h, quad) {
    const g = blur(gray(rgba, w, h), w, h, 1); const { mag } = slopes(g, w, h);
    const reach = Math.max(4, Math.max(w, h) / 70);
    const s = snap(quad, mag, w, h, 26, reach); if (!s || s.support < 0.5) return quad;
    const q = order(s.quad); if (!sane(q, w, h)) return quad;
    for (let i = 0; i < 4; i++) if (dist(q[i], quad[i]) > reach * 2.5) return quad; // it jumped somewhere else: trust the first answer
    return q;
  }

  // ------------------------------------------------------------------ flattening
  // How big, and what shape, the real sheet is. A page seen at an angle looks squashed; the way its sides lean toward each other
  // gives away the true proportions (Zhang and He's whiteboard method), assuming the lens points at the middle of the frame.
  function pageSize(quad, w, h, maxSide) {
    const [tl, tr, br, bl] = quad;
    const Wm = Math.max(dist(tl, tr), dist(bl, br)), Hm = Math.max(dist(tl, bl), dist(tr, br));
    let ratio = Wm / Hm;
    const u0 = w / 2, v0 = h / 2;
    const m1 = [tl[0] - u0, tl[1] - v0, 1], m2 = [tr[0] - u0, tr[1] - v0, 1], m3 = [bl[0] - u0, bl[1] - v0, 1], m4 = [br[0] - u0, br[1] - v0, 1];
    const X = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], D = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const k2 = D(X(m1, m4), m3) / D(X(m2, m4), m3), k3 = D(X(m1, m4), m2) / D(X(m3, m4), m2);
    if (isFinite(k2) && isFinite(k3)) {
      const n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 - 1], n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 - 1];
      let r2 = 0;
      if (Math.abs(n2[2]) > 1e-4 && Math.abs(n3[2]) > 1e-4) {
        const f2 = -(n2[0] * n3[0] + n2[1] * n3[1]) / (n2[2] * n3[2]);
        const dia = Math.hypot(w, h);
        if (f2 > (0.35 * dia) * (0.35 * dia) && f2 < (4 * dia) * (4 * dia)) r2 = (n2[0] * n2[0] / f2 + n2[1] * n2[1] / f2 + n2[2] * n2[2]) / (n3[0] * n3[0] / f2 + n3[1] * n3[1] / f2 + n3[2] * n3[2]);
      }
      if (!r2) r2 = (n2[0] * n2[0] + n2[1] * n2[1]) / (n3[0] * n3[0] + n3[1] * n3[1]);
      const r = Math.sqrt(r2);
      if (isFinite(r) && r > ratio * 0.6 && r < ratio * 1.67) ratio = r; // believe it only when it is in the right neighbourhood
    }
    let W = Math.sqrt(Wm * Hm * ratio), H = W / ratio;
    const k = Math.min(1, (maxSide || 2400) / Math.max(W, H));
    return { W: Math.max(8, Math.round(W * k)), H: Math.max(8, Math.round(H * k)), ratio };
  }
  function solve(A, b) { // a small set of linear equations, by elimination
    const n = b.length;
    for (let c = 0; c < n; c++) {
      let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      if (Math.abs(A[p][c]) < 1e-12) return null;
      [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
      for (let r = c + 1; r < n; r++) { const f = A[r][c] / A[c][c]; for (let k = c; k < n; k++) A[r][k] -= f * A[c][k]; b[r] -= f * b[c]; }
    }
    const x = new Array(n);
    for (let r = n - 1; r >= 0; r--) { let s = b[r]; for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k]; x[r] = s / A[r][r]; }
    return x;
  }
  // the rule that carries a point on the flat page to its place in the photo
  function mapping(quad, W, H) {
    const dst = [[0, 0], [W, 0], [W, H], [0, H]], A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [u, v] = dst[i], [x, y] = quad[i];
      A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
      A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
    }
    return solve(A, b);
  }
  function flatten(rgba, w, h, quad, W, H) {
    const m = mapping(quad, W, H); const out = new Uint8ClampedArray(W * H * 4); if (!m) return out;
    for (let v = 0; v < H; v++) {
      const vv = v + 0.5; let o = v * W * 4;
      for (let u = 0; u < W; u++, o += 4) {
        const uu = u + 0.5, d = m[6] * uu + m[7] * vv + 1;
        let x = (m[0] * uu + m[1] * vv + m[2]) / d - 0.5, y = (m[3] * uu + m[4] * vv + m[5]) / d - 0.5;
        if (x < 0) x = 0; else if (x > w - 1.001) x = w - 1.001; if (y < 0) y = 0; else if (y > h - 1.001) y = h - 1.001;
        const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = (y0 * w + x0) * 4, j = i + w * 4;
        const a = (1 - fx) * (1 - fy), b = fx * (1 - fy), c = (1 - fx) * fy, e = fx * fy;
        out[o] = rgba[i] * a + rgba[i + 4] * b + rgba[j] * c + rgba[j + 4] * e;
        out[o + 1] = rgba[i + 1] * a + rgba[i + 5] * b + rgba[j + 1] * c + rgba[j + 5] * e;
        out[o + 2] = rgba[i + 2] * a + rgba[i + 6] * b + rgba[j + 2] * c + rgba[j + 6] * e;
        out[o + 3] = 255;
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ cleaning up
  // Work out what blank paper looks like in every part of the page (shadows, a lamp on one side, a warm bulb), divide it out so
  // the paper comes up even and white, then deepen the ink. 'board' pushes harder and brings marker colours up. Changes rgba in place.
  function clean(rgba, w, h, mode) {
    if (mode !== 'doc' && mode !== 'board') return rgba;
    const bs = Math.max(8, Math.round(Math.max(w, h) / 48)), gw = Math.ceil(w / bs), gh = Math.ceil(h / bs);
    const grid = [new Float32Array(gw * gh), new Float32Array(gw * gh), new Float32Array(gw * gh)];
    const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
      hist[0].fill(0); hist[1].fill(0); hist[2].fill(0); let n = 0;
      const y1 = Math.min(h, (gy + 1) * bs), x1 = Math.min(w, (gx + 1) * bs);
      for (let y = gy * bs; y < y1; y += 2) for (let x = gx * bs; x < x1; x += 2) { const i = (y * w + x) * 4; hist[0][rgba[i]]++; hist[1][rgba[i + 1]]++; hist[2][rgba[i + 2]]++; n++; }
      for (let c = 0; c < 3; c++) { let acc = 0, v = 255; for (; v > 0; v--) { acc += hist[c][v]; if (acc >= n * 0.15) break; } grid[c][gy * gw + gx] = v; } // the brighter end of the patch: the paper, not the ink
    }
    for (let c = 0; c < 3; c++) {
      const g = grid[c]; const sorted = Float32Array.from(g).sort(); const typical = sorted[Math.floor(sorted.length * 0.6)];
      for (let i = 0; i < g.length; i++) g[i] = Math.max(g[i], typical * 0.55, 24); // a patch with no paper in it (a photo, a dark logo) must not be bleached
      for (let pass = 0; pass < 2; pass++) { // smooth, so patches don't show as squares
        const t = Float32Array.from(g);
        for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) { let s = 0, k = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = y + dy, xx = x + dx; if (yy < 0 || xx < 0 || yy >= gh || xx >= gw) continue; s += t[yy * gw + xx]; k++; } g[y * gw + x] = s / k; }
      }
    }
    const black = mode === 'board' ? 38 : 22, white = mode === 'board' ? 214 : 232, gain = 255 / (white - black), sat = mode === 'board' ? 1.5 : 1.08;
    const colW = new Float32Array(w), colI = new Int32Array(w);
    for (let x = 0; x < w; x++) { const f = Math.max(0, Math.min(gw - 1.001, (x + 0.5) / bs - 0.5)); colI[x] = f | 0; colW[x] = f - colI[x]; }
    for (let y = 0; y < h; y++) {
      const f = Math.max(0, Math.min(gh - 1.001, (y + 0.5) / bs - 0.5)), gy = f | 0, fy = f - gy, r0 = gy * gw, r1 = Math.min(gh - 1, gy + 1) * gw;
      let o = y * w * 4;
      for (let x = 0; x < w; x++, o += 4) {
        const gx = colI[x], fx = colW[x], gx1 = Math.min(gw - 1, gx + 1);
        let r, g, b;
        { const G = grid[0]; const bg = (G[r0 + gx] * (1 - fx) + G[r0 + gx1] * fx) * (1 - fy) + (G[r1 + gx] * (1 - fx) + G[r1 + gx1] * fx) * fy; r = (rgba[o] * 255 / bg - black) * gain; }
        { const G = grid[1]; const bg = (G[r0 + gx] * (1 - fx) + G[r0 + gx1] * fx) * (1 - fy) + (G[r1 + gx] * (1 - fx) + G[r1 + gx1] * fx) * fy; g = (rgba[o + 1] * 255 / bg - black) * gain; }
        { const G = grid[2]; const bg = (G[r0 + gx] * (1 - fx) + G[r0 + gx1] * fx) * (1 - fy) + (G[r1 + gx] * (1 - fx) + G[r1 + gx1] * fx) * fy; b = (rgba[o + 2] * 255 / bg - black) * gain; }
        const m = (r + g + b) / 3;
        rgba[o] = m + (r - m) * sat; rgba[o + 1] = m + (g - m) * sat; rgba[o + 2] = m + (b - m) * sat;
      }
    }
    return rgba;
  }

  // ------------------------------------------------------------------ a PDF from JPEG pages
  // pages: [{ jpeg: Uint8Array, w, h }]. Each page is one picture filling the sheet; the long side is 11 inches.
  function pdf(pages, title) {
    const enc = (s) => { const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 255; return a; };
    const parts = [], offsets = []; let size = 0;
    const put = (x) => { const a = typeof x === 'string' ? enc(x) : x; parts.push(a); size += a.length; };
    const obj = (n, body) => { offsets[n] = size; put(n + ' 0 obj\n'); for (const b of body) put(b); put('\nendobj\n'); };
    put('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    const N = pages.length, kids = [];
    for (let i = 0; i < N; i++) kids.push((3 + i * 3) + ' 0 R');
    obj(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
    obj(2, ['<< /Type /Pages /Count ' + N + ' /Kids [' + kids.join(' ') + '] >>']);
    for (let i = 0; i < N; i++) {
      const p = pages[i], k = 792 / Math.max(p.w, p.h), pw = +(p.w * k).toFixed(2), ph = +(p.h * k).toFixed(2);
      const pageN = 3 + i * 3, contN = pageN + 1, imgN = pageN + 2;
      obj(pageN, ['<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pw + ' ' + ph + '] /Resources << /XObject << /P' + i + ' ' + imgN + ' 0 R >> >> /Contents ' + contN + ' 0 R >>']);
      const stream = 'q ' + pw + ' 0 0 ' + ph + ' 0 0 cm /P' + i + ' Do Q';
      obj(contN, ['<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream']);
      obj(imgN, ['<< /Type /XObject /Subtype /Image /Width ' + p.w + ' /Height ' + p.h + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + p.jpeg.length + ' >>\nstream\n', p.jpeg, '\nendstream']);
    }
    const infoN = 3 + N * 3;
    const safe = String(title || 'Scan').replace(/[^\x20-\x7e]/g, '').replace(/([\\()])/g, '\\$1');
    obj(infoN, ['<< /Title (' + safe + ') /Producer (BOARD Capture) >>']);
    const xref = size, count = infoN + 1;
    put('xref\n0 ' + count + '\n0000000000 65535 f \n');
    for (let n = 1; n < count; n++) put(String(offsets[n]).padStart(10, '0') + ' 00000 n \n');
    put('trailer\n<< /Size ' + count + ' /Root 1 0 R /Info ' + infoN + ' 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
    const out = new Uint8Array(size); let at = 0; for (const a of parts) { out.set(a, at); at += a.length; }
    return out;
  }

  return { find, sharpen, pageSize, flatten, clean, pdf, order, mapping, gray, blur, _: { edgeMap, hullOf, fourSides, sane, snap, areaOf } };
});
