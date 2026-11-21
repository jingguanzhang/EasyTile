/*************************************************************************
 * DXF → PDF 转换模块（EasyTile）
 *
 * DXF 解析与图元展开、PDF 内容流生成改编自 dxf-pdf-viewer（pdf.html，MIT License，
 * Copyright (c) 2026 Steven Tibbs，许可证见 assets/vendor/dxf-pdf-viewer/LICENSE）。
 * 本工作站的改动：
 *   1. 去除查看器 UI，仅保留“DXF 文本 → 可绘制批次 → PDF”离线转换；
 *   2. 按调用方给定的图框区域逐页输出（每张图一页），而不是把整张模型空间挤在一页；
 *   3. 嵌入中文 TrueType 子集字体（Type0 / CIDFontType2 / Identity-H + ToUnicode），解决中文不显示；
 *   4. 支持 LWPOLYLINE 线宽（40/41/43），墙体等宽线按实心多边形输出。
 *
 * 用法：
 *   const bytes = await DxfPdf.convert(dxfText, {
 *       pages: [{ area: [x0, y0, x1, y1], title: '第 1 页' }, ...],   // 每页对应的 DXF 坐标范围
 *       paper: [841.89, 595.28],                                     // 页面尺寸 (pt)，默认 A4 横向
 *       margin: 0,                                                   // 页边距 (mm)
 *       font: ChineseFontEngine,                                     // 提供 charToGid / measureTextEm / buildSubsetTtf / advanceWidths / unitsPerEm
 *       capRatio: 1,                                                 // 文字高度 / 字号
 *       layerLw: { TILE_FULL: 0.1 },                                 // 按图层覆盖线宽 (mm)
 *       title: '文档标题'
 *   });
 *************************************************************************/
const DxfPdf = (() => {
/* ============================== math & constants ============================== */
const DEG = Math.PI / 180, TAU = Math.PI * 2, DESC = 0.212, MM = 72 / 25.4;
let CAP = 0.716;   // 文字高度 / 字号 比例；工作站导出的 DXF 按“字高 = em”排版，转换时会改为 1
// 按文字样式覆盖 CAP：TK_TEXT 是图框编辑器的文字（acadrust 已按黑体换算成 CAD 字高 = 大写字母高 178/256 em）
/** 屏幕口径文字样式（图框编辑器字体）的大写字母高 / em：TK_TEXT 黑体、TK_SIMSUN 宋体 … */
function defaultCapByStyle() {
  const out = { TK_TEXT: 178 / 256 };
  const list = (typeof window !== 'undefined' && window.CadShared && window.CadShared.CAD_FONTS) || [];
  for (const f of list) out[String(f.style).toUpperCase()] = f.cap;
  return out;
}
let CAP_BY_STYLE = defaultCapByStyle();
const capOf = (p) => CAP_BY_STYLE[String(p[7] || '').trim().toUpperCase()] || CAP;
const I6 = [1, 0, 0, 1, 0, 0];
const mul = (A, B) => [A[0]*B[0] + A[2]*B[1], A[1]*B[0] + A[3]*B[1], A[0]*B[2] + A[2]*B[3], A[1]*B[2] + A[3]*B[3],
  A[0]*B[4] + A[2]*B[5] + A[4], A[1]*B[4] + A[3]*B[5] + A[5]];
const tr = (x, y) => [1, 0, 0, 1, x, y];
const rot = a => { const c = Math.cos(a), s = Math.sin(a); return [c, s, -s, c, 0, 0]; };
const scl = (x, y) => [x, 0, 0, y, 0, 0];
const ap = (M, x, y) => [M[0]*x + M[2]*y + M[4], M[1]*x + M[3]*y + M[5]];
const hit = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const grow = (bb, x0, y0, x1, y1) => { if (x0 < bb[0]) bb[0] = x0; if (y0 < bb[1]) bb[1] = y0; if (x1 > bb[2]) bb[2] = x1; if (y1 > bb[3]) bb[3] = y1; };
const sweep = a => { while (a <= 1e-12) a += TAU; while (a > TAU + 1e-9) a -= TAU; return a; };

/* AutoCAD Color Index palette */
const ACI = (() => {
  const hsv = (h, s, v) => { const f = n => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
    return (Math.round(f(5) * 255) << 16) | (Math.round(f(3) * 255) << 8) | Math.round(f(1) * 255); };
  const t = [0, 0xff0000, 0xffff00, 0x00ff00, 0x00ffff, 0x0000ff, 0xff00ff, 0xffffff, 0x808080, 0xc0c0c0];
  const vs = [1, .8, .6, .5, .3];
  for (let i = 10; i < 250; i++) { const j = (i - 10) % 10; t[i] = hsv(Math.floor((i - 10) / 10) * 15, j & 1 ? .5 : 1, vs[j >> 1]); }
  [0x33, 0x50, 0x69, 0x82, 0xbe, 0xff].forEach((g, k) => t[250 + k] = g * 0x10101);
  return t;
})();

/* text metrics：由嵌入的中文字体 (chinese-font.ttf) 提供字宽，保证排版宽度与 PDF 中实际绘制的字形一致 */
let measureEm = s => s.length * 0.6;
const wcache = new Map();
function emW(s) { let w = wcache.get(s); if (w === undefined) { w = measureEm(s); if (wcache.size < 60000) wcache.set(s, w); } return w; }

/* ============================== DXF parsing ============================== */
let gc, gv;                                   // group codes / values of the file being parsed
const sv = k => (gv[k] || '').trim();

function records(b, e) {
  const out = [];
  for (let k = b; k < e;) {
    if (gc[k] === 0) { let j = k + 1; while (j < e && gc[j] !== 0) j++; out.push({ type: sv(k), s: k + 1, e: j }); k = j; }
    else k++;
  }
  return out;
}
function props(r) {
  const p = {};
  for (let k = r.s; k < r.e; k++) { const c = gc[k]; if (c >= 1000) break; if (p[c] === undefined) p[c] = gv[k]; }
  return p;
}
const N = (p, c, d = 0) => { const v = p[c]; if (v === undefined) return d; const x = +v; return x === x ? x : d; };

function readEnts(b, e) {
  const out = []; let par = null;
  for (const r of records(b, e)) {
    const t = r.type;
    if (t === 'VERTEX' || t === 'ATTRIB') { if (par) par.kids.push(r); }
    else if (t === 'SEQEND') par = null;
    else { out.push(r); if (t === 'POLYLINE' || t === 'INSERT') { r.kids = []; par = r; } else par = null; }
  }
  return out;
}

function parseDxf(text) {
  const L = text.split(/\r\n|\r|\n/);
  let st = 0; while (st < L.length && L[st].trim() === '') st++;
  const n = (L.length - st) >> 1;
  gc = new Int32Array(n); gv = new Array(n);
  for (let i = 0, j = st; i < n; i++, j += 2) { gc[i] = parseInt(L[j], 10); gv[i] = L[j + 1]; }
  const D = { header: {}, layers: new Map(), ltypes: new Map(), blocks: new Map(), brec: new Map(), layouts: new Map(), layerByHandle: new Map(), ents: [] };
  let i = 0, sections = 0;
  while (i < n) {
    if (gc[i] === 0 && sv(i) === 'SECTION') {
      sections++;
      const name = sv(i + 1).toUpperCase(); let e = i + 2;
      while (e < n && !(gc[e] === 0 && sv(e) === 'ENDSEC')) e++;
      const b = i + 2;
      if (name === 'HEADER') {
        let h = null;
        for (let k = b; k < e; k++) { if (gc[k] === 9) h = D.header[sv(k)] = {}; else if (h && h[gc[k]] === undefined) h[gc[k]] = gv[k]; }
      } else if (name === 'TABLES') {
        for (const r of records(b, e)) {
          if (r.type === 'LAYER') {
            const p = props(r), name = (p[2] || '0').trim(), c = parseInt(p[62] ?? 7) || 7, fl = parseInt(p[70] || 0);
            D.layers.set(name.toUpperCase(), { name, aci: Math.min(255, Math.abs(c)) || 7, rgb: p[420] !== undefined ? (+p[420]) & 0xffffff : null,
              off: c < 0, frozen: !!(fl & 1), lt: (p[6] || 'CONTINUOUS').trim().toUpperCase(), lw: p[370] !== undefined ? parseInt(p[370]) : -3 });
            if (p[5]) D.layerByHandle.set(p[5].trim().toUpperCase(), name.toUpperCase());
          } else if (r.type === 'LTYPE') {
            const p = props(r), el = [];
            for (let k = r.s; k < r.e; k++) if (gc[k] === 49) el.push(+gv[k]);
            D.ltypes.set((p[2] || '').trim().toUpperCase(), el);
          } else if (r.type === 'BLOCK_RECORD') {
            const p = props(r); if (p[5] && p[2]) D.brec.set(p[5].trim().toUpperCase(), p[2].trim());
          }
        }
      } else if (name === 'BLOCKS') {
        let cur = null;
        for (const r of records(b, e)) {
          if (r.type === 'BLOCK') { const p = props(r); cur = { name: (p[2] || p[3] || '').trim(), bx: N(p, 10), by: N(p, 20), flags: parseInt(p[70] || 0), owner: (p[330] || '').trim().toUpperCase(), s: r.e }; }
          else if (r.type === 'ENDBLK' && cur) { cur.ents = readEnts(cur.s, r.s - 1); D.blocks.set(cur.name.toUpperCase(), cur); cur = null; }
        }
      } else if (name === 'ENTITIES') D.ents = readEnts(b, e);
      else if (name === 'OBJECTS') {
        for (const r of records(b, e)) if (r.type === 'LAYOUT') {
          let inL = false, nm = null, ord = 0, h = null;
          for (let k = r.s; k < r.e; k++) {
            const c = gc[k];
            if (c === 100) inL = sv(k) === 'AcDbLayout';
            else if (inL) { if (c === 1 && nm === null) nm = sv(k); else if (c === 71) ord = +gv[k]; else if (c === 330 && h === null) h = sv(k).toUpperCase(); }
          }
          if (h) D.layouts.set(h, { name: nm, ord });
        }
      }
      i = e + 1;
    } else i++;
  }
  if (!sections) D.ents = readEnts(0, n);
  return D;
}

/* text cleanup */
function special(s) {
  if (s.indexOf('%%') >= 0) s = s.replace(/%%(\d{3}|.)/g, (m, c) => {
    if (c.length === 3) return String.fromCharCode(+c);
    switch (c.toLowerCase()) { case 'c': return 'Ø'; case 'd': return '°'; case 'p': return '±'; case '%': return '%'; default: return ''; }
  });
  if (s.indexOf('\\U+') >= 0) s = s.replace(/\\U\+([0-9a-fA-F]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
  return s;
}
function mclean(s) {
  let o = '';
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c === '\\') {
      const d = s[i + 1];
      if (d === 'P' || d === 'N') { o += '\n'; i += 2; }
      else if (d === '~') { o += ' '; i += 2; }
      else if (d === '\\' || d === '{' || d === '}') { o += d; i += 2; }
      else if (d === 'U' && s[i + 2] === '+') { o += String.fromCharCode(parseInt(s.substr(i + 3, 4), 16) || 63); i += 7; }
      else if (d === 'S') { const j = s.indexOf(';', i); o += s.slice(i + 2, j < 0 ? s.length : j).replace(/[\^#]/g, '/'); i = j < 0 ? s.length : j + 1; }
      else if ('ACcFfHQTWpabX'.includes(d)) { const j = s.indexOf(';', i); i = j < 0 ? s.length : j + 1; }
      else i += 2;
    } else if (c === '{' || c === '}') i++;
    else if (c === '^' && i + 1 < s.length) { const d = s[i + 1]; o += d === 'J' ? '\n' : d === 'I' ? ' ' : d === ' ' ? '^' : ''; i += 2; }
    else { o += c; i++; }
  }
  return special(o);
}

/* geometry helpers */
function arcPts(out, cx, cy, r, a0, sw) {
  const n = Math.max(3, Math.ceil(Math.abs(sw) * 10));
  for (let k = 0; k <= n; k++) { const a = a0 + sw * k / n; out.push(cx + r * Math.cos(a), cy + r * Math.sin(a)); }
  return out;
}
function ellPts(out, cx, cy, mx, my, vx, vy, t0, sw) {
  const n = Math.max(4, Math.ceil(Math.abs(sw) * 12));
  for (let k = 0; k <= n; k++) { const t = t0 + sw * k / n, c = Math.cos(t), s = Math.sin(t); out.push(cx + mx * c + vx * s, cy + my * c + vy * s); }
  return out;
}
function bulgeTo(out, x1, y1, x2, y2, bu) {
  const dx = x2 - x1, dy = y2 - y1, c = Math.hypot(dx, dy);
  if (!bu || c < 1e-12) { out.push(x2, y2); return; }
  const th = 4 * Math.atan(bu), d = c * (1 - bu * bu) / (4 * bu);
  const cx = (x1 + x2) / 2 - dy / c * d, cy = (y1 + y2) / 2 + dx / c * d;
  const r = Math.hypot(x1 - cx, y1 - cy), a0 = Math.atan2(y1 - cy, x1 - cx);
  const n = Math.max(2, Math.ceil(Math.abs(th) * 10));
  for (let k = 1; k < n; k++) { const a = a0 + th * k / n; out.push(cx + r * Math.cos(a), cy + r * Math.sin(a)); }
  out.push(x2, y2);
}
function polyPts(xy, bs, closed) {
  const n = xy.length / 2; if (n < 1) return [];
  const out = [xy[0], xy[1]], m = closed ? n : n - 1;
  for (let k = 0; k < m; k++) { const j = (k + 1) % n; bulgeTo(out, xy[2 * k], xy[2 * k + 1], xy[2 * j], xy[2 * j + 1], bs[k] || 0); }
  return out;
}
function splinePts(cp, w, kn, deg) {
  const n = cp.length / 2;
  if (deg < 1 || n <= deg || kn.length !== n + deg + 1) return null;
  const t0 = kn[deg], t1 = kn[n]; if (!(t1 > t0)) return null;
  const segs = Math.min(4000, Math.max(24, n * 12)), out = [];
  const dx = new Float64Array(deg + 1), dy = new Float64Array(deg + 1), dw = new Float64Array(deg + 1);
  let k = deg;
  for (let s = 0; s <= segs; s++) {
    const t = t0 + (t1 - t0) * s / segs;
    while (k < n - 1 && t >= kn[k + 1]) k++;
    for (let j = 0; j <= deg; j++) { const id = j + k - deg, ww = w ? (w[id] || 1) : 1; dx[j] = cp[2 * id] * ww; dy[j] = cp[2 * id + 1] * ww; dw[j] = ww; }
    for (let r = 1; r <= deg; r++) for (let j = deg; j >= r; j--) {
      const i0 = j + k - deg, den = kn[i0 + deg - r + 1] - kn[i0], al = den ? (t - kn[i0]) / den : 0;
      dx[j] = (1 - al) * dx[j - 1] + al * dx[j]; dy[j] = (1 - al) * dy[j - 1] + al * dy[j]; dw[j] = (1 - al) * dw[j - 1] + al * dw[j];
    }
    out.push(dx[deg] / dw[deg], dy[deg] / dw[deg]);
  }
  return out;
}
function catmull(pts, closed) {
  const n = pts.length / 2; if (n < 3) return pts;
  const P = i => { i = closed ? (i + n) % n : Math.max(0, Math.min(n - 1, i)); return [pts[2 * i], pts[2 * i + 1]]; };
  const out = [pts[0], pts[1]], m = closed ? n : n - 1;
  for (let i = 0; i < m; i++) {
    const [x0, y0] = P(i - 1), [x1, y1] = P(i), [x2, y2] = P(i + 1), [x3, y3] = P(i + 2);
    for (let s = 1; s <= 8; s++) {
      const t = s / 8, t2 = t * t, t3 = t2 * t;
      out.push(.5 * (2 * x1 + (x2 - x0) * t + (2 * x0 - 5 * x1 + 4 * x2 - x3) * t2 + (3 * x1 - x0 - 3 * x2 + x3) * t3),
               .5 * (2 * y1 + (y2 - y0) * t + (2 * y0 - 5 * y1 + 4 * y2 - y3) * t2 + (3 * y1 - y0 - 3 * y2 + y3) * t3));
    }
  }
  return out;
}
function ocs(p) {
  let nx = N(p, 210), ny = N(p, 220), nz = N(p, 230, 1);
  if (!nx && !ny && nz > 0) return null;
  const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
  let ax, ay, az;
  if (Math.abs(nx) < 1 / 64 && Math.abs(ny) < 1 / 64) { ax = nz; ay = 0; az = -nx; } else { ax = -ny; ay = nx; az = 0; }
  const al = Math.hypot(ax, ay, az) || 1; ax /= al; ay /= al; az /= al;
  return [ax, ay, ny * az - nz * ay, nz * ax - nx * az, 0, 0];
}
function dashArr(el, scale) {
  if (!el || !el.length) return null;
  const items = [];
  if (el[0] < 0) items.push([true, 0]);
  for (const v of el) { const on = v >= 0, len = Math.abs(v) * scale; if (items.length && items[items.length - 1][0] === on) items[items.length - 1][1] += len; else items.push([on, len]); }
  if (items.length % 2) { const last = items.pop(); items[0][1] += last[1]; }
  const d = items.map(x => x[1]);
  return d.length >= 2 && d.reduce((a, b) => a + b, 0) > 0 ? d : null;
}

/* hatch pattern lines clipped to boundary (even-odd) */
function hatchLines(rings, pl) {
  const ex = [];
  for (const r of rings) {
    for (let k = 0; k + 3 < r.length; k += 2) ex.push(r[k], r[k + 1], r[k + 2], r[k + 3]);
    if (r.length >= 4) ex.push(r[r.length - 2], r[r.length - 1], r[0], r[1]);
  }
  const out = []; let budget = 400000;
  for (const L of pl) {
    const ux = Math.cos(L.ang), uy = Math.sin(L.ang), nx = -uy, ny = ux;
    const d = L.ox * nx + L.oy * ny; if (Math.abs(d) < 1e-9) continue;
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < ex.length; k += 2) { const t = (ex[k] - L.bx) * nx + (ex[k + 1] - L.by) * ny; if (t < lo) lo = t; if (t > hi) hi = t; }
    const a = lo / d, b = hi / d, k0 = Math.ceil(Math.min(a, b)), k1 = Math.floor(Math.max(a, b));
    if (k1 - k0 > 20000) return null;
    const P = L.ds.reduce((s, v) => s + Math.abs(v), 0);
    for (let q = k0; q <= k1; q++) {
      const ox = L.bx + q * L.ox, oy = L.by + q * L.oy, xs = [];
      for (let k = 0; k < ex.length; k += 4) {
        const dp = (ex[k] - ox) * nx + (ex[k + 1] - oy) * ny, dq = (ex[k + 2] - ox) * nx + (ex[k + 3] - oy) * ny;
        if ((dp > 0) !== (dq > 0)) { const sp = (ex[k] - ox) * ux + (ex[k + 1] - oy) * uy, sq = (ex[k + 2] - ox) * ux + (ex[k + 3] - oy) * uy; xs.push(sp + (sq - sp) * dp / (dp - dq)); }
      }
      if (xs.length < 2) continue;
      xs.sort((x, y) => x - y);
      for (let z = 0; z + 1 < xs.length; z += 2) {
        const s0 = xs[z], s1 = xs[z + 1];
        if (!L.ds.length || P <= 0 || (s1 - s0) / P > 5000) { out.push(ox + ux * s0, oy + uy * s0, ox + ux * s1, oy + uy * s1); if (--budget < 0) return out; continue; }
        let s = Math.floor(s0 / P) * P;
        while (s < s1) {
          for (const dv of L.ds) {
            const len = Math.abs(dv);
            if (dv >= 0) {
              const e0 = s, e1 = dv > 0 ? s + len : s + P * 0.002;
              const c0 = Math.max(e0, s0), c1 = Math.min(e1, s1);
              if (c1 > c0) { out.push(ox + ux * c0, oy + uy * c0, ox + ux * c1, oy + uy * c1); if (--budget < 0) return out; }
            }
            s += len; if (s >= s1) break;
          }
        }
      }
    }
  }
  return out;
}

/* ============================== flatten to drawable batches ============================== */
function buildDrawing(D, name) {
  const H = D.header, hv = (v, c, d) => { const h = H[v]; const x = h && h[c] !== undefined ? +h[c] : NaN; return x === x ? x : d; };
  const LTS = hv('$LTSCALE', 40, 1) || 1;
  const F = { name, units: hv('$INSUNITS', 70, 0) | 0, layers: new Map(), spaces: [], skipped: {}, total: 0, errors: 0, truncated: false };
  for (const [key, l] of D.layers) F.layers.set(key, { key, name: l.name, rgb: l.rgb != null ? l.rgb : (l.aci === 7 ? -1 : ACI[l.aci] ?? -1),
    on: !l.off && !l.frozen, lt: l.lt, lw: l.lw, n: 0 });
  const layer = (key, nm) => { let L = F.layers.get(key); if (!L) { L = { key, name: nm, rgb: -1, on: true, lt: '', lw: -3, n: 0 }; F.layers.set(key, L); } return L; };
  let SP = null, budget = 16e6;

  function style(p, ctx) {
    const lname = (p[8] ?? '0').trim() || '0';
    let key = lname.toUpperCase(); if (key === '0' && ctx.lay) key = ctx.lay;
    const L = layer(key, lname);
    let col;
    if (p[420] !== undefined) col = (+p[420]) & 0xffffff;
    else { const a = p[62] !== undefined ? parseInt(p[62]) : 256; col = a === 0 ? ctx.col : (a >= 256 || a < 0 || !(a === a)) ? L.rgb : a === 7 ? -1 : ACI[a]; }
    let lt = (p[6] ?? 'BYLAYER').trim().toUpperCase();
    if (lt === 'BYLAYER') lt = L.lt; else if (lt === 'BYBLOCK') lt = ctx.lt;
    if (!lt || lt === 'CONTINUOUS' || lt === 'BYLAYER' || lt === 'BYBLOCK') lt = '';
    let lw = p[370] !== undefined ? parseInt(p[370]) : -1;
    if (lw === -1) lw = L.lw; else if (lw === -2) lw = ctx.lw;
    if (!(lw >= 0)) lw = -3;
    const lts = LTS * (N(p, 48, 1) || 1) * ctx.lts;
    return { key, col, lt, lts, lw };
  }
  function batch(st, ctx) {
    const key = st.key + '\x01' + ctx.anc + '\x01' + st.col + '\x01' + st.lt + (st.lt ? '@' + st.lts.toPrecision(3) : '') + '\x01' + st.lw;
    let b = SP.map.get(key);
    if (!b) {
      b = { lay: st.key, anc: ctx.ancArr, col: st.col, lw: st.lw, lt: st.lt, dash: null, dashLen: 0, lines: [], seg: [], lbb: [], types: [], blks: [],
        fills: [], texts: [], bb: [Infinity, Infinity, -Infinity, -Infinity], path: null, fpath: null, o: null };
      if (st.lt) { const d = dashArr(D.ltypes.get(st.lt), st.lts); if (d) { b.dash = d; b.dashLen = d.reduce((x, y) => x + y, 0); } }
      SP.map.set(key, b);
    }
    return b;
  }
  const B = (p, ctx) => batch(style(p, ctx), ctx);
  const mOf = (ctx, p) => { const o = ocs(p); return o ? mul(ctx.m, o) : ctx.m; };

  function addLine(b, pts, m, type, ctx, seg) {
    const n = pts.length; if (n < 4) return;
    if ((budget -= n) < 0) { F.truncated = true; return; }
    const a = new Float64Array(n), m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3], m4 = m[4], m5 = m[5];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < n; k += 2) {
      const x = pts[k], y = pts[k + 1], X = m0 * x + m2 * y + m4, Y = m1 * x + m3 * y + m5;
      if (!(Math.abs(X) < 1e14 && Math.abs(Y) < 1e14)) return;
      a[k] = X; a[k + 1] = Y; if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
    }
    b.lines.push(a); b.seg.push(!!seg); b.lbb.push(x0, y0, x1, y1); b.types.push(ctx.tag || type); b.blks.push(ctx.blk); grow(b.bb, x0, y0, x1, y1);
  }
  function addFill(b, rings, m, type, ctx) {
    const out = [], bb = [Infinity, Infinity, -Infinity, -Infinity];
    for (const r of rings) {
      if (r.length < 6) continue;
      if ((budget -= r.length) < 0) { F.truncated = true; return; }
      const a = new Float64Array(r.length);
      for (let k = 0; k < r.length; k += 2) { const X = m[0] * r[k] + m[2] * r[k + 1] + m[4], Y = m[1] * r[k] + m[3] * r[k + 1] + m[5]; if (!(Math.abs(X) < 1e14 && Math.abs(Y) < 1e14)) return; a[k] = X; a[k + 1] = Y; grow(bb, X, Y, X, Y); }
      out.push(a);
    }
    if (!out.length) return;
    out.bb = bb; out.type = ctx.tag || type; out.blk = ctx.blk;
    b.fills.push(out); grow(b.bb, bb[0], bb[1], bb[2], bb[3]);
  }
  function addText(b, M, s, w, type, ctx) {
    const bb = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [u, v] of [[0, -DESC], [w, -DESC], [w, .9], [0, .9]]) { const [x, y] = ap(M, u, v); grow(bb, x, y, x, y); }
    if (!(Math.abs(bb[0]) < 1e14 && Math.abs(bb[3]) < 1e14)) return;
    b.texts.push({ m: M, s, bb, type: ctx.tag || type, blk: ctx.blk }); grow(b.bb, bb[0], bb[1], bb[2], bb[3]);
  }

  function wideLw(b, xy, w0, w1, closed, m, ctx) {
    const n = xy.length / 2, segs = closed ? n : n - 1, rings = [];
    for (let k = 0; k < segs; k++) {
      const j = (k + 1) % n, ax = xy[2 * k], ay = xy[2 * k + 1], bx = xy[2 * j], by = xy[2 * j + 1];
      const len = Math.hypot(bx - ax, by - ay); if (len < 1e-9) continue;
      const ux = (bx - ax) / len, uy = (by - ay) / len, nx = -uy, ny = ux;
      const h0 = (w0[k] || 0) / 2, h1 = (w1[k] || 0) / 2;
      const e0 = (closed || k > 0) ? h0 : 0, e1 = (closed || k < segs - 1) ? h1 : 0;
      const sx = ax - ux * e0, sy = ay - uy * e0, tx = bx + ux * e1, ty = by + uy * e1;
      if (h0 <= 0 && h1 <= 0) { addLine(b, [ax, ay, bx, by], m, 'LWPOLYLINE', ctx); continue; }
      rings.push([sx + nx * h0, sy + ny * h0, tx + nx * h1, ty + ny * h1, tx - nx * h1, ty - ny * h1, sx - nx * h0, sy - ny * h0]);
    }
    for (const r of rings) addFill(b, [r], m, 'LWPOLYLINE', ctx);
  }
  function text(p, ctx, isAttr, type) {
    let s = p[1]; if (s === undefined) return; s = special(s).replace(/\t/g, ' '); if (!s.trim()) return;
    const b = B(p, ctx);
    let h = N(p, 40); if (!(h > 0)) h = 2.5;
    const cap = capOf(p);
    let fs = h / cap, wf = N(p, 41, 1) || 1, ang = N(p, 50) * DEG;
    const obl = N(p, 51) * DEG, ha = N(p, 72) | 0, va = N(p, isAttr ? 74 : 73) | 0, gen = N(p, 71) | 0;
    const x1 = N(p, 10), y1 = N(p, 20), has2 = p[11] !== undefined, x2 = N(p, 11, x1), y2 = N(p, 21, y1);
    const w = emW(s);
    let px = x1, py = y1, ox = 0, oy = 0;
    if (ha === 3 || ha === 5) {
      const d = Math.hypot(x2 - x1, y2 - y1);
      if (has2 && d > 0 && w > 0) { ang = Math.atan2(y2 - y1, x2 - x1); if (ha === 5) wf = d / (w * fs); else fs = d / (w * wf); }
    } else if (ha || va) {
      if (has2) { px = x2; py = y2; }
      const W = w * fs * wf; if (ha === 1 || ha === 4) ox = -W / 2; else if (ha === 2) ox = -W;
    }
    const hh = fs * cap;
    if (ha === 4) oy = -hh / 2; else if (va === 1) oy = DESC * fs; else if (va === 2) oy = -hh / 2; else if (va === 3) oy = -hh;
    let M = mul(mOf(ctx, p), mul(tr(px, py), mul(rot(ang), tr(ox, oy))));
    M = mul(M, scl(fs * wf * (gen & 2 ? -1 : 1), fs * (gen & 4 ? -1 : 1)));
    if (obl) M = mul(M, [1, 0, Math.tan(obl), 1, 0, 0]);
    addText(b, M, s, w, type, ctx);
  }
  function mtext(r, p, ctx) {
    let raw = '';
    for (let k = r.s; k < r.e; k++) { const c = gc[k]; if (c >= 1000 || c === 101) break; if (c === 3 || c === 1) raw += gv[k]; }
    const paras = mclean(raw).replace(/\t/g, ' ').split('\n');
    const h = N(p, 40, 2.5) || 2.5, fs = h / capOf(p), refW = N(p, 41), att = (N(p, 71, 1) | 0) || 1;
    const ang = p[11] !== undefined ? Math.atan2(N(p, 21), N(p, 11)) : N(p, 50) * DEG;
    const lsp = h * 5 / 3 * (N(p, 44, 1) || 1), lines = [];
    for (const ln of paras) {
      if (refW > 0 && emW(ln) * fs > refW * 1.02) {
        let cur = '';
        for (const wd of ln.split(' ')) { const t = cur ? cur + ' ' + wd : wd; if (cur && emW(t) * fs > refW * 1.02) { lines.push(cur); cur = wd; } else cur = t; }
        lines.push(cur);
      } else lines.push(ln);
    }
    const nL = lines.length, col = (att - 1) % 3, row = Math.floor((att - 1) / 3);
    const y0 = row === 0 ? -h : row === 1 ? -h + ((nL - 1) * lsp + h) / 2 : (nL - 1) * lsp;
    const b = B(p, ctx), base = mul(ctx.m, mul(tr(N(p, 10), N(p, 20)), rot(ang)));
    lines.forEach((ln, i) => {
      if (!ln.trim()) return;
      const w = emW(ln), W = w * fs, ox = col === 0 ? 0 : col === 1 ? -W / 2 : -W;
      addText(b, mul(base, mul(tr(ox, y0 - i * lsp), scl(fs, fs))), ln, w, 'MTEXT', ctx);
    });
  }
  function child(ctx, st, M, blkName, tag) {
    const ancArr = ctx.ancArr.includes(st.key) ? ctx.ancArr : ctx.ancArr.concat(st.key);
    return { m: M, lay: st.key, col: st.col, lt: st.lt, lw: st.lw, lts: ctx.lts, ancArr, anc: ancArr.join('\x02'),
      blk: blkName ? (ctx.blk ? ctx.blk + ' › ' + blkName : blkName) : ctx.blk, tag: tag || ctx.tag, depth: ctx.depth + 1, stack: ctx.stack };
  }
  function hatch(r, p, ctx) {
    let k = r.s; const e = r.e;
    while (k < e && !(gc[k] === 100 && sv(k) === 'AcDbHatch')) k++;
    if (k >= e) k = r.s; else k++;
    const get = code => { for (let j = k, lim = Math.min(e, k + 6); j < lim; j++) if (gc[j] === code) { k = j + 1; return +gv[j]; } return NaN; };
    const getS = code => { for (let j = k, lim = Math.min(e, k + 6); j < lim; j++) if (gc[j] === code) { k = j + 1; return gv[j]; } return ''; };
    get(10); get(20); get(30);
    const pat = getS(2).trim(), solid = get(70) === 1 || /^SOLID$/i.test(pat); get(71);
    const np = get(91) | 0, rings = [];
    const join = (ring, pts) => {
      let s = 0;
      if (ring.length && Math.abs(ring[ring.length - 2] - pts[0]) < 1e-9 && Math.abs(ring[ring.length - 1] - pts[1]) < 1e-9) s = 2;
      for (let q = s; q < pts.length; q++) ring.push(pts[q]);
    };
    for (let q = 0; q < np && k < e; q++) {
      const type = get(92) | 0, ring = [];
      if (type & 2) {
        const hasB = get(72) | 0; get(73); const nv = get(93) | 0, xy = [], bs = [];
        for (let v = 0; v < nv && k < e; v++) { xy.push(get(10), get(20)); bs.push(hasB && gc[k] === 42 ? +gv[k++] : 0); }
        rings.push(polyPts(xy, bs, true));
      } else {
        const ne = get(93) | 0;
        for (let ed = 0; ed < ne && k < e; ed++) {
          const et = get(72) | 0;
          if (et === 1) { const x1 = get(10), y1 = get(20), x2 = get(11), y2 = get(21); join(ring, [x1, y1, x2, y2]); }
          else if (et === 2) {
            const cx = get(10), cy = get(20), rr = get(40), a0 = get(50) * DEG, a1 = get(51) * DEG, ccw = get(73), sw = sweep(a1 - a0);
            join(ring, ccw ? arcPts([], cx, cy, rr, a0, sw) : arcPts([], cx, cy, rr, -a0, -sw));
          } else if (et === 3) {
            const cx = get(10), cy = get(20), mx = get(11), my = get(21), ra = get(40), a0 = get(50) * DEG, a1 = get(51) * DEG, ccw = get(73), sw = sweep(a1 - a0);
            join(ring, ellPts([], cx, cy, mx, my, -my * ra, mx * ra, ccw ? a0 : -a0, ccw ? sw : -sw));
          } else if (et === 4) {
            const deg = get(94) | 0; get(73); get(74); const nk = get(95) | 0, nc = get(96) | 0, kn = [], cp = [], w = [];
            for (let z = 0; z < nk; z++) kn.push(get(40));
            for (let z = 0; z < nc; z++) { cp.push(get(10), get(20)); if (gc[k] === 42) w.push(+gv[k++]); }
            if (gc[k] === 97 && [11, 12, 72, 97].includes(gc[k + 1])) {
              const nf = get(97) | 0; for (let z = 0; z < nf; z++) { get(11); get(21); }
              if (gc[k] === 12) k += 2; if (gc[k] === 13) k += 2;
            }
            join(ring, splinePts(cp, w.length === nc ? w : null, kn, deg) || cp);
          }
        }
        rings.push(ring);
      }
      const ns = get(97) | 0; for (let z = 0; z < ns; z++) get(330);
    }
    const m = mOf(ctx, p), b = B(p, ctx);
    if (solid) { addFill(b, rings, m, 'HATCH', ctx); return; }
    get(75); get(76); get(52); get(41); get(77);
    const nl = get(78) | 0, pl = [];
    for (let z = 0; z < nl && k < e; z++) {
      const ang = get(53) * DEG, bx = get(43), by = get(44), ox = get(45), oy = get(46), nd = get(79) | 0, ds = [];
      for (let d = 0; d < nd; d++) ds.push(get(49));
      if ([ang, bx, by, ox, oy].every(v => v === v)) pl.push({ ang, bx, by, ox, oy, ds });
    }
    const segs = pl.length ? hatchLines(rings, pl) : null;
    if (segs && segs.length) addLine(b, segs, m, 'HATCH', ctx, true);
    else for (const r of rings) addLine(b, r.concat(r.slice(0, 2)), m, 'HATCH', ctx);
  }

  function entity(r, ctx) {
    const t = r.type, p = props(r);
    if (N(p, 60) === 1) return;
    switch (t) {
      case 'LINE': addLine(B(p, ctx), [N(p, 10), N(p, 20), N(p, 11), N(p, 21)], ctx.m, t, ctx); break;
      case 'CIRCLE': { const R = N(p, 40); if (R > 0) addLine(B(p, ctx), arcPts([], N(p, 10), N(p, 20), R, 0, TAU), mOf(ctx, p), t, ctx); break; }
      case 'ARC': { const R = N(p, 40), a0 = N(p, 50) * DEG; if (R > 0) addLine(B(p, ctx), arcPts([], N(p, 10), N(p, 20), R, a0, sweep(N(p, 51) * DEG - a0)), mOf(ctx, p), t, ctx); break; }
      case 'ELLIPSE': {
        let nx = N(p, 210), ny = N(p, 220), nz = N(p, 230, 1); const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
        const mx = N(p, 11), my = N(p, 21), mz = N(p, 31), ra = N(p, 40, 1), t0 = N(p, 41), t1 = N(p, 42, TAU);
        addLine(B(p, ctx), ellPts([], N(p, 10), N(p, 20), mx, my, (ny * mz - nz * my) * ra, (nz * mx - nx * mz) * ra, t0, sweep(t1 - t0)), ctx.m, t, ctx); break;
      }
      case 'LWPOLYLINE': {
        const xy = [], bs = [], w0 = [], w1 = []; let fl = 0, cw = N(p, 43);
        for (let k = r.s; k < r.e; k++) {
          const c = gc[k]; if (c >= 1000) break;
          if (c === 10) { xy.push(+gv[k], 0); bs.push(0); w0.push(cw); w1.push(cw); } else if (c === 20 && xy.length) xy[xy.length - 1] = +gv[k];
          else if (c === 42 && bs.length) bs[bs.length - 1] = +gv[k]; else if (c === 70) fl = +gv[k] | 0;
          else if (c === 40 && w0.length) w0[w0.length - 1] = +gv[k]; else if (c === 41 && w1.length) w1[w1.length - 1] = +gv[k];
        }
        // 带线宽的多段线（如墙体）：按 CAD 外观生成实心四边形；中间拐点各延伸半个线宽补齐转角
        if (w0.some(v => v > 0) || w1.some(v => v > 0)) { wideLw(B(p, ctx), xy, w0, w1, !!(fl & 1), mOf(ctx, p), ctx); break; }
        addLine(B(p, ctx), polyPts(xy, bs, !!(fl & 1)), mOf(ctx, p), t, ctx); break;
      }
      case 'POLYLINE': {
        const fl = N(p, 70) | 0, b = B(p, ctx), vs = (r.kids || []).map(props);
        if (fl & 64) {
          const pts = [], segs = [];
          for (const v of vs) {
            const vf = N(v, 70) | 0;
            if ((vf & 128) && (vf & 64)) pts.push([N(v, 10), N(v, 20)]);
            else if (vf & 128) {
              const idx = [N(v, 71) | 0, N(v, 72) | 0, N(v, 73) | 0, N(v, 74) | 0].filter(x => x !== 0);
              for (let q = 0; q < idx.length; q++) { const a = idx[q], c = idx[(q + 1) % idx.length], P1 = pts[Math.abs(a) - 1], P2 = pts[Math.abs(c) - 1]; if (a > 0 && P1 && P2) segs.push(P1[0], P1[1], P2[0], P2[1]); }
            }
          }
          addLine(b, segs, ctx.m, 'POLYFACE', ctx, true);
        } else if (fl & 16) {
          const M_ = N(p, 71) | 0, N_ = N(p, 72) | 0, pts = vs.map(v => [N(v, 10), N(v, 20)]), segs = [];
          if (M_ * N_ === pts.length) {
            for (let i = 0; i < M_; i++) for (let j = 0; j < N_; j++) {
              const P0 = pts[i * N_ + j];
              if (j + 1 < N_ || (fl & 32)) { const P1 = pts[i * N_ + (j + 1) % N_]; segs.push(P0[0], P0[1], P1[0], P1[1]); }
              if (i + 1 < M_ || (fl & 1)) { const P1 = pts[((i + 1) % M_) * N_ + j]; segs.push(P0[0], P0[1], P1[0], P1[1]); }
            }
          }
          addLine(b, segs, ctx.m, 'MESH', ctx, true);
        } else {
          const is3d = !!(fl & 8), xy = [], bs = [];
          for (const v of vs) { const vf = N(v, 70) | 0; if ((fl & 4) && (vf & 16)) continue; xy.push(N(v, 10), N(v, 20)); bs.push(is3d ? 0 : N(v, 42)); }
          addLine(b, polyPts(xy, bs, !!(fl & 1)), is3d ? ctx.m : mOf(ctx, p), t, ctx);
        }
        break;
      }
      case 'SPLINE': {
        const cp = [], fp = [], kn = [], w = []; let deg = 3, fl = 0;
        for (let k = r.s; k < r.e; k++) {
          const c = gc[k], v = +gv[k]; if (c >= 1000) break;
          if (c === 10) cp.push(v, 0); else if (c === 20) cp[cp.length - 1] = v; else if (c === 11) fp.push(v, 0); else if (c === 21) fp[fp.length - 1] = v;
          else if (c === 40) kn.push(v); else if (c === 41) w.push(v); else if (c === 71) deg = v | 0; else if (c === 70) fl = v | 0;
        }
        let pts = cp.length >= 4 ? splinePts(cp, w.length === cp.length / 2 ? w : null, kn, deg) : null;
        if (!pts) pts = fp.length >= 6 ? catmull(fp, !!(fl & 1)) : fp.length >= 4 ? fp : cp;
        addLine(B(p, ctx), pts, ctx.m, t, ctx); break;
      }
      case 'TEXT': text(p, ctx, false, 'TEXT'); break;
      case 'MTEXT': mtext(r, p, ctx); break;
      case 'INSERT': case 'ACAD_TABLE': {
        const nm = (p[2] || '').trim(), blk = D.blocks.get(nm.toUpperCase()), st = style(p, ctx);
        let ch = null;
        if (blk && !(blk.flags & 4) && ctx.depth < 24 && !ctx.stack.includes(blk)) {
          // ACAD_TABLE 的 AcDbTable 段复用了 40/41（单元格边距）、70/71 等组码，不能当作块缩放 / 阵列读取；
          // 表格块本身即为实际尺寸，按 1:1 单次插入
          const isTb = t === 'ACAD_TABLE';
          const sx = isTb ? 1 : N(p, 41, 1), sy = isTb ? 1 : N(p, 42, 1), cols = isTb ? 1 : Math.max(1, N(p, 70, 1) | 0), rows = isTb ? 1 : Math.max(1, N(p, 71, 1) | 0), cs = isTb ? 0 : N(p, 44), rs = isTb ? 0 : N(p, 45);
          const base = mul(mOf(ctx, p), mul(tr(N(p, 10), N(p, 20)), rot(N(p, 50) * DEG))), tail = mul(scl(sx, sy), tr(-blk.bx, -blk.by));
          ch = child(ctx, st, null, blk.name.startsWith('*') ? '' : blk.name, t === 'ACAD_TABLE' ? 'TABLE' : '');
          ch.lts = ctx.lts * (Math.sqrt(Math.abs(sx * sy)) || 1); ch.stack = ctx.stack.concat(blk);
          const R = Math.min(rows, 200), Cn = Math.min(cols, 200);
          for (let i = 0; i < R; i++) for (let j = 0; j < Cn; j++) { ch.m = mul(base, mul(tr(j * cs, i * rs), tail)); list(blk.ents, ch); }
        }
        if (r.kids) {
          const actx = ch ? Object.assign({}, ch, { m: ctx.m, tag: '' }) : ctx;
          for (const a of r.kids) { const q = props(a); if (N(q, 60) === 1 || (N(q, 70) & 1)) continue; text(q, actx, true, 'ATTRIB'); }
        }
        break;
      }
      case 'DIMENSION': case 'ARC_DIMENSION': case 'LARGE_RADIAL_DIMENSION': {
        const blk = D.blocks.get((p[2] || '').trim().toUpperCase());
        if (blk && ctx.depth < 24 && !ctx.stack.includes(blk)) {
          const ch = child(ctx, style(p, ctx), ctx.m, '', 'DIMENSION'); ch.stack = ctx.stack.concat(blk);
          list(blk.ents, ch);
        } else F.skipped[t] = (F.skipped[t] || 0) + 1;
        break;
      }
      case 'SOLID': case 'TRACE': {
        const x3 = N(p, 12), y3 = N(p, 22);
        addFill(B(p, ctx), [[N(p, 10), N(p, 20), N(p, 11), N(p, 21), N(p, 13, x3), N(p, 23, y3), x3, y3]], mOf(ctx, p), t, ctx); break;
      }
      case '3DFACE': {
        const P = [[N(p, 10), N(p, 20)], [N(p, 11), N(p, 21)], [N(p, 12), N(p, 22)], [N(p, 13, N(p, 12)), N(p, 23, N(p, 22))]], fl = N(p, 70) | 0, segs = [];
        for (let q = 0; q < 4; q++) if (!(fl & (1 << q))) { const a = P[q], c = P[(q + 1) % 4]; segs.push(a[0], a[1], c[0], c[1]); }
        addLine(B(p, ctx), segs, ctx.m, t, ctx, true); break;
      }
      case 'HATCH': hatch(r, p, ctx); break;
      case 'LEADER': {
        const xy = []; for (let k = r.s; k < r.e; k++) { const c = gc[k]; if (c >= 1000) break; if (c === 10) xy.push(+gv[k], 0); else if (c === 20 && xy.length) xy[xy.length - 1] = +gv[k]; }
        addLine(B(p, ctx), xy, ctx.m, t, ctx); break;
      }
      case 'IMAGE': {
        const x = N(p, 10), y = N(p, 20), ux = N(p, 11), uy = N(p, 21), vx = N(p, 12), vy = N(p, 22), w = N(p, 13), h = N(p, 23);
        const ax = x + ux * w, ay = y + uy * w, bx = x + vx * h, by = y + vy * h;
        addLine(B(p, ctx), [x, y, ax, ay, ax + vx * h, ay + vy * h, bx, by, x, y, ax + vx * h, ay + vy * h], ctx.m, 'IMAGE (frame)', ctx); break;
      }
      case 'VIEWPORT': {
        if (SP.kind !== 'paper' || ctx.depth) break;
        const id = N(p, 69), stt = N(p, 68, 1);
        if (id === 1 || stt === 0) break;
        const frozen = new Set();
        for (let k = r.s; k < r.e; k++) if (gc[k] === 341) { const L = D.layerByHandle.get(sv(k).toUpperCase()); if (L) frozen.add(L); }
        const vp = { cx: N(p, 10), cy: N(p, 20), w: N(p, 40), h: N(p, 41), vcx: N(p, 12) + N(p, 17), vcy: N(p, 22) + N(p, 27), vh: N(p, 45), tw: N(p, 51) * DEG, frozen };
        if (vp.w > 0 && vp.h > 0 && vp.vh > 0) SP.viewports.push(vp);
        break;
      }
      case 'POINT': case 'ATTDEF': case 'SEQEND': case 'VERTEX': case 'ENDBLK': break;
      default: if (!ctx.depth) F.skipped[t] = (F.skipped[t] || 0) + 1;
    }
  }
  function list(ents, ctx) {
    for (const r of ents) {
      if (!ctx.depth) F.total++;
      try { entity(r, ctx); } catch (err) { F.errors++; if (F.errors < 5) console.warn('DXF entity skipped', r.type, err); }
    }
  }
  const mkSpace = (nm, kind) => ({ name: nm, kind, map: new Map(), batches: [], viewports: [], bb: null, origin: [0, 0] });
  function finalize(sp) {
    sp.batches = [...sp.map.values()].filter(b => b.lines.length || b.fills.length || b.texts.length); sp.map = null;
    const bb = [Infinity, Infinity, -Infinity, -Infinity];
    for (const b of sp.batches) grow(bb, b.bb[0], b.bb[1], b.bb[2], b.bb[3]);
    for (const vp of sp.viewports) grow(bb, vp.cx - vp.w / 2, vp.cy - vp.h / 2, vp.cx + vp.w / 2, vp.cy + vp.h / 2);
    sp.bb = bb[0] <= bb[2] ? bb : null;
    sp.origin = sp.bb ? [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2] : [0, 0];
    for (const b of sp.batches) { b.o = sp.origin; const L = F.layers.get(b.lay); if (L) L.n += b.lines.length + b.fills.length + b.texts.length; }
    return sp;
  }
  const ctx0 = { m: I6, lay: null, col: -1, lt: '', lw: -3, lts: 1, ancArr: [], anc: '', blk: '', tag: '', depth: 0, stack: [] };
  const mEnts = [], pEnts = [];
  for (const r of D.ents) { let ps = false; for (let k = r.s; k < r.e; k++) if (gc[k] === 67) { ps = +gv[k] === 1; break; } (ps ? pEnts : mEnts).push(r); }
  SP = mkSpace('Model', 'model'); list(mEnts, ctx0); F.spaces.push(finalize(SP));

  const lays = [];
  let activeH = null; for (const [h, nm] of D.brec) if (nm.toUpperCase() === '*PAPER_SPACE') activeH = h;
  const handleOf = up => { for (const [h, nm] of D.brec) if (nm.toUpperCase() === up) return h; return null; };
  if (pEnts.length) lays.push({ ents: pEnts, h: activeH });
  for (const [key, blk] of D.blocks) if (/^\*PAPER_SPACE\d+$/.test(key) && blk.ents.length) lays.push({ ents: blk.ents, h: blk.owner || handleOf(key) });
  lays.forEach((l, i) => { const info = l.h && D.layouts.get(l.h); l.name = (info && info.name) || 'Layout' + (i + 1); l.ord = info ? info.ord : 100 + i; });
  lays.sort((a, b) => a.ord - b.ord);
  for (const l of lays) { SP = mkSpace(l.name, 'paper'); const before = F.total; list(l.ents, ctx0); F.total = before; finalize(SP); if (SP.batches.length || SP.viewports.length) F.spaces.push(SP); }
  return F;
}

function loadDxfText(text, name) {
  const D = parseDxf(text);
  const F = buildDrawing(D, name);
  gc = gv = null;
  return F;
}

/* ============================== 中文字体嵌入的 PDF 写出 ============================== */
const r2 = v => { v = Math.round(v * 100) / 100; return v > 1e6 ? 1e6 : v < -1e6 ? -1e6 : v; };
const r4 = v => Math.round(v * 1e4) / 1e4;
const vpM = vp => { const s = vp.h / vp.vh; return mul(tr(vp.cx, vp.cy), mul(rot(-vp.tw), mul(scl(s, s), tr(-vp.vcx, -vp.vcy)))); };
const vpCull = vp => { if (vp.tw) return null; const s = vp.h / vp.vh; return [vp.vcx - vp.w / 2 / s, vp.vcy - vp.h / 2 / s, vp.vcx + vp.w / 2 / s, vp.vcy + vp.h / 2 / s]; };
const allVisible = F => b => { const l = F.layers.get(b.lay); if (l && !l.on) return false; for (const a of b.anc) { const x = F.layers.get(a); if (x && !x.on) return false; } return true; };
const pdfU16 = s => '<FEFF' + [...String(s)].map(ch => { const c = ch.codePointAt(0); return c > 0xffff ? '003F' : c.toString(16).padStart(4, '0'); }).join('').toUpperCase() + '>';

function pdfCol(col, mode, fill) {
  let r = 0, gg = 0, b = 0;
  if (col !== -1 && mode !== 'mono') {
    r = (col >> 16 & 255) / 255; gg = (col >> 8 & 255) / 255; b = (col & 255) / 255;
    const l = .299 * r + .587 * gg + .114 * b;
    if (mode === 'true') { /* 原色：图框图片等需保持彩色的图层 */ }
    else if (mode === 'gray') { r = gg = b = Math.min(.8, l * .8); } else if (l > .9) r = gg = b = 0; else if (l > .5) { const k = .5 / l; r *= k; gg *= k; b *= k; }
  }
  return `${r4(r)} ${r4(gg)} ${r4(b)} ${fill ? 'rg' : 'RG'}`;
}
function pdfLw(b, o) { const lay = o.layerLw && o.layerLw[b.lay]; const mm = lay ? lay : o.lw === 'fine' ? .1 : o.lw === 'bold' ? .35 : b.lw > 0 ? Math.max(.05, b.lw / 100) : .18; return r2(mm * MM) || .1; }
function pdfSpace(out, sp, P, cull, vis, o) {
  const s = Math.sqrt(Math.abs(P[0] * P[3] - P[1] * P[2]));
  const X = (x, y) => r2(P[0] * x + P[2] * y + P[4]) + ' ' + r2(P[1] * x + P[3] * y + P[5]);
  const bs = sp.batches.filter(b => vis(b) && (!cull || hit(b.bb, cull)));
  const modeOf = b => (o.colorLayers && o.colorLayers.has(b.lay)) ? 'true' : (o.darkColorLayers && o.darkColorLayers.has(b.lay)) ? 'dark' : o.color;
  for (const b of bs) if (b.fills.length) {
    out.push(pdfCol(b.col, modeOf(b), true));
    for (const rings of b.fills) {
      if (cull && !hit(rings.bb, cull)) continue;
      const parts = [];
      for (const a of rings) { parts.push(X(a[0], a[1]) + ' m'); for (let k = 2; k < a.length; k += 2) parts.push(X(a[k], a[k + 1]) + ' l'); parts.push('h'); }
      out.push(parts.join('\n'), 'f*');
    }
  }
  for (const b of bs) if (b.lines.length) {
    out.push(pdfCol(b.col, modeOf(b), false), pdfLw(b, o) + ' w', b.dash && b.dashLen * s > 2 ? `[${b.dash.map(d => r2(d * s)).join(' ')}] 0 d` : '[] 0 d');
    let parts = [];
    for (let i = 0; i < b.lines.length; i++) {
      if (cull) { const q = i * 4; if (b.lbb[q] > cull[2] || b.lbb[q + 2] < cull[0] || b.lbb[q + 1] > cull[3] || b.lbb[q + 3] < cull[1]) continue; }
      const a = b.lines[i];
      if (b.seg[i]) for (let k = 0; k + 3 < a.length; k += 4) parts.push(X(a[k], a[k + 1]) + ' m ' + X(a[k + 2], a[k + 3]) + ' l');
      else {
        let prev = X(a[0], a[1]), n = 0; parts.push(prev + ' m');
        for (let k = 2; k < a.length; k += 2) { const c = X(a[k], a[k + 1]); if (c !== prev) { parts.push(c + ' l'); prev = c; n++; } }
        if (!n) parts.push(prev + ' l');
      }
      if (parts.length > 4000) { out.push(parts.join('\n'), 'S'); parts = []; }
    }
    if (parts.length) out.push(parts.join('\n'), 'S');
  }
  for (const b of bs) if (b.texts.length) {
    let started = false;
    for (const t of b.texts) {
      if (cull && !hit(t.bb, cull)) continue;
      const Q = mul(P, t.m); if (Math.hypot(Q[2], Q[3]) < .5) continue;
      if (!started) { out.push(pdfCol(b.col, modeOf(b), true)); started = true; }
      out.push(`BT /F1 1 Tf ${r4(Q[0])} ${r4(Q[1])} ${r4(Q[2])} ${r4(Q[3])} ${r2(Q[4])} ${r2(Q[5])} Tm ${o.encText(t.s)} Tj ET`);
    }
  }
}

async function deflate(u8) {
  if (typeof CompressionStream === 'undefined') return null;
  const st = new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(st).arrayBuffer());
}

/** 文字编码器：字符 → 字形号 (GID) 十六进制串，同时记录用到的字形用于字体子集化 */
function makeTextEncoder(font) {
  const used = new Map();                     // gid -> unicode
  const sp = font.charToGid(0x20); if (sp > 0) used.set(sp, 0x20);
  const encText = s => {
    let hex = '<';
    for (const ch of String(s)) {
      const cp = ch.codePointAt(0);
      let gid = font.charToGid(cp) || 0;
      if (!gid && cp !== 0x20) gid = font.charToGid(0x25A1) || font.charToGid(0x3F) || 0;   // 缺字：□ 或 ?
      if (!used.has(gid)) used.set(gid, cp);
      hex += gid.toString(16).toUpperCase().padStart(4, '0');
    }
    return hex + '>';
  };
  return { encText, used };
}

function pageContent(F, area, PW, PH, marginPt, o) {
  const aw = Math.max(area[2] - area[0], 1e-9), ah = Math.max(area[3] - area[1], 1e-9);
  const bw = Math.max(20, PW - 2 * marginPt), bh = Math.max(20, PH - 2 * marginPt);
  const s = Math.min(bw / aw, bh / ah);
  const cx = (area[0] + area[2]) / 2, cy = (area[1] + area[3]) / 2;
  const P = [s, 0, 0, s, marginPt + bw / 2 - cx * s, marginPt + bh / 2 - cy * s];
  const cull = [cx - bw / 2 / s, cy - bh / 2 / s, cx + bw / 2 / s, cy + bh / 2 / s];
  const out = ['q', `${r2(marginPt)} ${r2(marginPt)} ${r2(bw)} ${r2(bh)} re W n`, '1 J 1 j'];
  const sp = F.spaces[0], vis = allVisible(F);
  pdfSpace(out, sp, P, cull, vis, o);
  for (const vp of sp.viewports) {
    const [x0, y0] = ap(P, vp.cx - vp.w / 2, vp.cy - vp.h / 2);
    out.push('q', `${r2(x0)} ${r2(y0)} ${r2(vp.w * s)} ${r2(vp.h * s)} re W n`);
    pdfSpace(out, F.spaces[0], mul(P, vpM(vp)), vpCull(vp), vis, o);
    out.push('Q');
  }
  // 位图（图框中的 Logo 等）：按模型坐标矩形放置，原图彩色输出
  (o.images || []).forEach((im, k) => {
    const a = im.area;
    if (a[2] < cull[0] || a[0] > cull[2] || a[3] < cull[1] || a[1] > cull[3]) return;
    const [x0, y0] = ap(P, a[0], a[1]), [x1, y1] = ap(P, a[2], a[3]);
    out.push('q', `${r4(x1 - x0)} 0 0 ${r4(y1 - y0)} ${r4(x0)} ${r4(y0)} cm`, `/Im${k} Do`, 'Q');
  });
  out.push('Q');
  return out.join('\n');
}

/** 位图解码为 PDF 图像数据：RGB 8 位 + Alpha 软蒙版（全不透明时省略） */
async function decodeImage(src, maxPx = 1200) {
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('图片解码失败')); img.src = src; });
  const nw = img.naturalWidth || img.width, nh = img.naturalHeight || img.height;
  if (!(nw > 0 && nh > 0)) throw new Error('图片尺寸无效');
  const k = Math.min(1, maxPx / Math.max(nw, nh));
  const w = Math.max(1, Math.round(nw * k)), h = Math.max(1, Math.round(nh * k));
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const c = cv.getContext('2d'); c.drawImage(img, 0, 0, w, h);
  const d = c.getImageData(0, 0, w, h).data;
  const rgb = new Uint8Array(w * h * 3), alpha = new Uint8Array(w * h);
  let opaque = true;
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    rgb[i * 3] = d[j]; rgb[i * 3 + 1] = d[j + 1]; rgb[i * 3 + 2] = d[j + 2]; alpha[i] = d[j + 3];
    if (d[j + 3] !== 255) opaque = false;
  }
  return { w, h, rgb, alpha: opaque ? null : alpha };
}

async function writePdf(pages, docTitle, font, used, images = []) {
  const enc = new TextEncoder(), parts = []; let pos = 0; const offs = [];
  const put = x => { const u = typeof x === 'string' ? enc.encode(x) : x; parts.push(u); pos += u.length; };
  const obj = (id, s) => { offs[id] = pos; put(`${id} 0 obj\n${s}\nendobj\n`); };
  const putStream = async (id, dict, raw, compress = true) => {
    const z = compress ? await deflate(raw) : null, body = z || raw;
    offs[id] = pos;
    put(`${id} 0 obj\n<< /Length ${body.length}${z ? ' /Filter /FlateDecode' : ''}${dict ? ' ' + dict : ''} >>\nstream\n`); put(body); put('\nendstream\nendobj\n');
  };
  const n = pages.length, FIRST = 10, IMG0 = FIRST + 3 * n, total = IMG0 + 2 * images.length, d = new Date(), p2 = x => String(x).padStart(2, '0');
  put('%PDF-1.4\n'); put(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  obj(1, `<< /Type /Catalog /Pages 2 0 R /Outlines 4 0 R /PageMode /UseOutlines >>`);
  obj(2, `<< /Type /Pages /Kids [${pages.map((_, i) => `${FIRST + 3 * i} 0 R`).join(' ')}] /Count ${n} >>`);

  // ---- 字体：Type0 + CIDFontType2 (Identity-H)，嵌入 chinese-font.ttf 的子集 ----
  const gids = [...used.keys()].sort((a, b) => a - b);
  const upem = font.unitsPerEm || 1000, adv = font.advanceWidths;
  const W = gids.map(g => `${g} [${adv ? Math.round((adv[g] || upem) * 1000 / upem) : 1000}]`).join(' ');
  obj(3, '<< /Type /Font /Subtype /Type0 /BaseFont /TileCalcCN /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 9 0 R >>');
  obj(4, `<< /Type /Outlines${n ? ` /First ${FIRST + 2} 0 R /Last ${FIRST + 3 * (n - 1) + 2} 0 R` : ''} /Count ${n} >>`);
  obj(5, `<< /Title ${pdfU16(docTitle)} /Producer (EasyTile DXF-PDF) /CreationDate (D:${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}) >>`);
  obj(6, `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /TileCalcCN /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 7 0 R /DW 1000 /W [${W}] /CIDToGIDMap /Identity >>`);
  const asc = Math.round((font.ascent || upem * 0.88) * 1000 / upem), dsc = Math.round((font.descent || -upem * 0.12) * 1000 / upem);
  obj(7, `<< /Type /FontDescriptor /FontName /TileCalcCN /Flags 4 /FontBBox [-200 ${dsc - 50} 1300 ${asc + 50}] /ItalicAngle 0 /Ascent ${asc} /Descent ${dsc} /CapHeight ${Math.round(asc * 0.8)} /StemV 80 /FontFile2 8 0 R >>`);
  const ttf = font.buildSubsetTtf(new Set(gids));
  await putStream(8, `/Length1 ${ttf.length}`, ttf);
  const bf = [];
  for (let i = 0; i < gids.length; i += 100) {
    const chunk = gids.slice(i, i + 100);
    bf.push(`${chunk.length} beginbfchar`);
    for (const g of chunk) {
      const cp = used.get(g) || 0x20;
      const u16 = cp > 0xffff ? (() => { const c = cp - 0x10000; return ((0xd800 + (c >> 10)).toString(16) + (0xdc00 + (c & 1023)).toString(16)); })() : cp.toString(16).padStart(4, '0');
      bf.push(`<${g.toString(16).toUpperCase().padStart(4, '0')}> <${u16.toUpperCase()}>`);
    }
    bf.push('endbfchar');
  }
  const cmap = ['/CIDInit /ProcSet findresource begin', '12 dict begin', 'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def', '/CMapName /Adobe-Identity-UCS def', '/CMapType 2 def',
    '1 begincodespacerange', '<0000> <FFFF>', 'endcodespacerange', bf.join('\n'), 'endcmap',
    'CMapName currentdict /CMap defineresource pop', 'end', 'end'].join('\n');
  await putStream(9, '', enc.encode(cmap));

  for (let k = 0; k < images.length; k++) {
    const im = images[k], id = IMG0 + 2 * k;
    await putStream(id, `/Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceRGB /BitsPerComponent 8${im.alpha ? ` /SMask ${id + 1} 0 R` : ''}`, im.rgb);
    if (im.alpha) await putStream(id + 1, `/Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceGray /BitsPerComponent 8`, im.alpha);
    else obj(id + 1, 'null');
  }
  const xobj = images.length ? ` /XObject << ${images.map((_, k) => `/Im${k} ${IMG0 + 2 * k} 0 R`).join(' ')} >>` : '';
  for (let i = 0; i < n; i++) {
    const pg = pages[i], id = FIRST + 3 * i;
    obj(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${r2(pg.w)} ${r2(pg.h)}] /Resources << /Font << /F1 3 0 R >>${xobj} >> /Contents ${id + 1} 0 R >>`);
    await putStream(id + 1, '', enc.encode(pg.content));
    obj(id + 2, `<< /Title ${pdfU16(pg.title || `第 ${i + 1} 页`)} /Parent 4 0 R${i ? ` /Prev ${id - 1} 0 R` : ''}${i < n - 1 ? ` /Next ${id + 5} 0 R` : ''} /Dest [${id} 0 R /Fit] >>`);
  }
  const xref = pos;
  let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let id = 1; id < total; id++) x += String(offs[id] || 0).padStart(10, '0') + ' 00000 n \n';
  put(x + `trailer\n<< /Size ${total} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const outB = new Uint8Array(pos); let q = 0; for (const u of parts) { outB.set(u, q); q += u.length; }
  return outB;
}

/**
 * 将 DXF 文本转换为多页 PDF。
 * opts.pages 未提供时，整张模型空间输出为一页。
 */
async function convert(dxfText, opts = {}) {
  const font = opts.font;
  if (!font || typeof font.charToGid !== 'function') throw new Error('缺少中文字体引擎，无法嵌入 PDF 字体');
  measureEm = s => font.measureTextEm(s);
  wcache.clear();
  CAP = opts.capRatio || 0.716;
  CAP_BY_STYLE = Object.assign(defaultCapByStyle(), opts.capRatioByStyle || {});
  const F = loadDxfText(dxfText, opts.title || 'drawing');
  const sp = F.spaces[0];
  const [PW, PH] = opts.paper || [841.89, 595.28];
  const marginPt = Math.max(0, +opts.margin || 0) * MM;
  const { encText, used } = makeTextEncoder(font);
  // colorLayers：这些图层保持原色（如图框图片的色块），其余按 color 模式
  // images：[{ area:[x0,y0,x1,y1] 模型坐标, src: dataURL }]，作为彩色位图嵌入；
  // imageLayers：图片全部解码成功时不再输出的图层（同一图片在 DXF 中的色块），任一失败则保留色块兜底
  const images = [], imgPlace = [];
  for (const im of (opts.images || [])) {
    try { const dec = await decodeImage(im.src); imgPlace.push({ area: im.area }); images.push(dec); } catch (e) { /* 解码失败：保留色块 */ }
  }
  if (images.length && images.length === (opts.images || []).length) {
    for (const ln of (opts.imageLayers || [])) { const L = F.layers.get(String(ln).toUpperCase()); if (L) L.on = false; }
  }
  const o = { color: opts.color || 'color', lw: opts.lw || 'auto', layerLw: opts.layerLw || null, encText,
    colorLayers: new Set((opts.colorLayers || []).map(x => String(x).toUpperCase())),
    darkColorLayers: new Set((opts.darkColorLayers || []).map(x => String(x).toUpperCase())),
    images: imgPlace };
  const list = (opts.pages && opts.pages.length) ? opts.pages : [{ area: sp.bb || [0, 0, 1, 1], title: opts.title }];
  const pages = [];
  for (let i = 0; i < list.length; i++) {
    const pg = list[i];
    const area = pg.area, aw = area[2] - area[0], ah = area[3] - area[1];
    const land = aw >= ah;
    const w = land ? Math.max(PW, PH) : Math.min(PW, PH), h = land ? Math.min(PW, PH) : Math.max(PW, PH);
    pages.push({ w, h, title: pg.title, content: pageContent(F, area, w, h, marginPt, o) });
    if (opts.onProgress) await opts.onProgress(i + 1, list.length);
  }
  return writePdf(pages, opts.title || 'drawing', font, used, images);
}

return { convert, parse: loadDxfText };
})();
window.DxfPdf = DxfPdf;
