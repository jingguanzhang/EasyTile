/*************************************************************************
 * 墙面铺贴（立面设计）模块  v4.7.0
 * - 高度属性：层高（每层）、空间吊顶高度、门高、窗高与窗台离地高度
 * - 3D 预览：真实毫米高度；未选中空间 = 整层预览，选中空间 = 单空间（剖切近墙）预览
 * - 立面设计模式：画布中间显示当前空间的单面立面 / 展开全图，逐面设置墙砖、离底离顶、起铺
 * - 算量：墙面按空间、按墙汇总；CSV、CAD / PDF 立面排砖图
 * 依赖 app.js 全局：STATE、MaterialLib、StylePicker、getVertex、getWall、getRoom、mmToPx、saveHistory、markDirty、
 *                  render、renderCalculationResults、tileMarkColor、classifyTileCut、showToast、getUnitPrice 等
 * 坐标约定：立面坐标单位为 mm，x 为站在室内面向墙面时的从左到右，y 为离地高度（向上为正）
 *************************************************************************/
const Elevation = (() => {
    const $ = id => document.getElementById(id);
    const PX2MM = 1000 / SCALE_PIXELS_PER_METER;   // 世界坐标 1px = 20mm
    // 层高 / 门窗高度、墙砖常用规格、铺法、对齐方式、墙砖与踢脚线默认值：assets/data/presets.json → PRESETS.wall
    const W = () => PRESETS.wall;
    const WF = () => PRESETS.wall.face;

    /* ===================== 高度属性 ===================== */
    const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
    const floorH = () => num(STATE.floorHeightMM, 0) > 0 ? Number(STATE.floorHeightMM) : W().floorHeightMM;
    const roomH = room => (room && num(room.ceilingMM, 0) > 0) ? Number(room.ceilingMM) : floorH();
    const opHeight = op => num(op.heightMM, 0) > 0 ? Number(op.heightMM) : (op.type === 'window' ? W().windowHeightMM : W().doorHeightMM);
    const opSill = op => op.type === 'window' ? Math.max(0, num(op.sillMM, W().windowSillMM)) : 0;

    /* ===================== 墙面几何 ===================== */
    const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
    const dot = (a, b) => a.x * b.x + a.y * b.y;

    /**
     * 空间的各个墙面（共线墙段合并为一个面），返回墙内皮线段与洞口。
     * face: { key, label, a, b (左端/右端，世界坐标)，u (a→b 单位向量)，n (指向室内)，len (mm)，wallIds, openings[] }
     */
    function getRoomFaces(room) {
        const ids = room.vertexIds || [];
        const pts = ids.map(id => getVertex(id));
        const n = pts.length;
        if (n < 3 || pts.some(p => !p)) return [];
        const edges = [];
        for (let i = 0; i < n; i++) {
            const a = pts[i], b = pts[(i + 1) % n];
            const L = Math.hypot(b.x - a.x, b.y - a.y);
            if (L < 0.01) continue;
            const w = STATE.walls.find(w => (w.v1 === a.id && w.v2 === b.id) || (w.v1 === b.id && w.v2 === a.id));
            edges.push({ a, b, u: { x: (b.x - a.x) / L, y: (b.y - a.y) / L }, wall: w, half: (w ? (w.thickness || 12) : 12) / 2 });
        }
        if (edges.length < 3) return [];
        const coll = (e1, e2) => Math.abs(e1.u.x * e2.u.y - e1.u.y * e2.u.x) < 0.012 && dot(e1.u, e2.u) > 0;
        let start = edges.findIndex((e, i) => !coll(edges[(i - 1 + edges.length) % edges.length], e));
        if (start < 0) return [];
        const chains = [];
        for (let k = 0; k < edges.length; k++) {
            const e = edges[(start + k) % edges.length];
            const last = chains[chains.length - 1];
            if (last && coll(last.edges[last.edges.length - 1], e)) last.edges.push(e);
            else chains.push({ edges: [e] });
        }
        if (chains.length < 3) return [];
        // 多边形方向 → 指向室内的法线
        let area2 = 0;
        for (let i = 0; i < n; i++) { const p = pts[i], q = pts[(i + 1) % n]; area2 += p.x * q.y - q.x * p.y; }
        const sign = area2 >= 0 ? 1 : -1;
        for (const c of chains) {
            c.p0 = c.edges[0].a; c.p1 = c.edges[c.edges.length - 1].b;
            const L = Math.hypot(c.p1.x - c.p0.x, c.p1.y - c.p0.y) || 1;
            c.u = { x: (c.p1.x - c.p0.x) / L, y: (c.p1.y - c.p0.y) / L };
            c.n = { x: -sign * c.u.y, y: sign * c.u.x };
            c.half = Math.max(...c.edges.map(e => e.half));
            // 保险：法线须指向多边形内部
            const mid = { x: (c.p0.x + c.p1.x) / 2 + c.n.x * 2, y: (c.p0.y + c.p1.y) / 2 + c.n.y * 2 };
            if (!isPointInPolygon(mid, pts)) c.n = { x: -c.n.x, y: -c.n.y };
            c.o = { x: c.p0.x + c.n.x * c.half, y: c.p0.y + c.n.y * c.half };   // 内皮线上一点
        }
        const m = chains.length;
        const inner = [];
        for (let k = 0; k < m; k++) {
            const A = chains[(k - 1 + m) % m], B = chains[k];
            const cr = A.u.x * B.u.y - A.u.y * B.u.x;
            if (Math.abs(cr) < 1e-4) { inner.push({ x: B.o.x, y: B.o.y }); continue; }
            const t = ((B.o.x - A.o.x) * B.u.y - (B.o.y - A.o.y) * B.u.x) / cr;
            inner.push({ x: A.o.x + A.u.x * t, y: A.o.y + A.u.y * t });
        }
        const faces = chains.map((c, k) => {
            let a = inner[k], b = inner[(k + 1) % m];
            const right = { x: c.n.y, y: -c.n.x };     // 面向墙面时的右手方向
            let fwd = true;
            if (dot(sub(b, a), right) < 0) { const t = a; a = b; b = t; fwd = false; }
            const lenPx = Math.hypot(b.x - a.x, b.y - a.y);
            const u = lenPx > 0 ? { x: (b.x - a.x) / lenPx, y: (b.y - a.y) / lenPx } : right;
            const idsInChain = [c.edges[0].a.id, ...c.edges.map(e => e.b.id)];
            const key = [idsInChain[0], idsInChain[idsInChain.length - 1]].sort().join('|');
            const wallIds = new Set(c.edges.map(e => e.wall && e.wall.id).filter(Boolean));
            const lenMM = lenPx * PX2MM;
            const openings = [];
            for (const op of STATE.openings) {
                if (!wallIds.has(op.wallId)) continue;
                const w = getWall(op.wallId);
                const v1 = w && getVertex(w.v1), v2 = w && getVertex(w.v2);
                if (!v1 || !v2) continue;
                const c0 = { x: v1.x + (v2.x - v1.x) * op.t, y: v1.y + (v2.y - v1.y) * op.t };
                const xc = dot(sub(c0, a), u) * PX2MM;
                const hw = (op.width || 45) * PX2MM / 2;
                const x0 = Math.max(0, xc - hw), x1 = Math.min(lenMM, xc + hw);
                if (x1 - x0 < 1) continue;
                const y0 = opSill(op);
                openings.push({ op, type: op.type, x0, x1, y0, y1: y0 + opHeight(op) });
            }
            openings.sort((p, q) => p.x0 - q.x0);
            return { key, a, b, u, n: c.n, lenMM, wallIds, openings, fwd, idx: k };
        });
        // 展开顺序：站在室内顺时针转身，前一面的右端接下一面的左端
        const forward = faces[0].fwd;
        const ordered = forward ? faces.slice() : faces.slice().reverse();
        // 按指北针朝向命名：墙面所在方位（室内法线的反方向）→ 北 / 东北 / 东 …；从最接近正北的墙面开始顺时针展开
        ordered.forEach(f => { f.bearing = faceBearing(f); });
        let first = 0, best = Infinity;
        ordered.forEach((f, i) => {
            const d = Math.min(f.bearing, 360 - f.bearing) + (f.bearing > 180 ? 0.001 : 0);
            if (d < best - 1e-6) { best = d; first = i; }
        });
        const seq = ordered.slice(first).concat(ordered.slice(0, first));
        const bins = seq.map(f => Math.round(f.bearing / 45) % 8);
        const cnt = {}, used = {};
        bins.forEach(k => { cnt[k] = (cnt[k] || 0) + 1; });
        seq.forEach((f, i) => {
            const k = bins[i];
            f.dir = DIR8[k];
            f.label = cnt[k] > 1 ? `${DIR8[k]}${used[k] = (used[k] || 0) + 1}` : DIR8[k];
            f.order = i;
        });
        return seq;
    }
    const DIR8 = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
    /** 墙面朝向方位角（0 = 北，顺时针）：取墙面所在一侧，即室内法线的反方向，按画布指北针换算 */
    function faceBearing(f) {
        const th = (Number(STATE.northAngle) || 0) * Math.PI / 180;
        const N = { x: Math.sin(th), y: -Math.cos(th) }, E = { x: Math.cos(th), y: Math.sin(th) };
        const d = { x: -f.n.x, y: -f.n.y };
        return (Math.atan2(dot(d, E), dot(d, N)) * 180 / Math.PI + 360) % 360;
    }

    /* ===================== 墙面铺贴配置 ===================== */
    function defaultCfg() {
        return Object.assign({ styleId: null, bottom: 0, top: 0, origin: null }, JSON.parse(JSON.stringify(WF())));
    }
    function defaultSkirtingCfg(type = 'tile') {
        const t = type === 'wood' ? 'wood' : 'tile';
        return Object.assign({ enabled: false, type: t }, JSON.parse(JSON.stringify(W().skirting[t])));
    }
    const wt = room => (room.wallTiling && typeof room.wallTiling === 'object') ? room.wallTiling : null;
    function getCfg(room, key) {
        const w = wt(room);
        const c = w && w.faces && w.faces[key];
        if (!c) return null;
        return Object.assign(defaultCfg(), c);
    }
    function setCfg(room, key, cfg) {
        if (!room.wallTiling || typeof room.wallTiling !== 'object') room.wallTiling = { faces: {}, skirting: {} };
        if (!room.wallTiling.faces) room.wallTiling.faces = {};
        if (cfg) room.wallTiling.faces[key] = JSON.parse(JSON.stringify(cfg));
        else delete room.wallTiling.faces[key];
    }
    function getSkirtingCfg(room, key) {
        const w = wt(room);
        const raw = w && w.skirting && w.skirting[key];
        if (!raw) return defaultSkirtingCfg('tile');
        const base = defaultSkirtingCfg(raw.type === 'wood' ? 'wood' : 'tile');
        return Object.assign(base, raw);
    }
    function setSkirtingCfg(room, key, sk) {
        if (!room.wallTiling || typeof room.wallTiling !== 'object') room.wallTiling = { faces: {}, skirting: {} };
        if (!room.wallTiling.skirting) room.wallTiling.skirting = {};
        if (!sk || (!sk.enabled && !room.wallTiling.skirting[key])) {
            if (!sk) delete room.wallTiling.skirting[key];
            else room.wallTiling.skirting[key] = JSON.parse(JSON.stringify(sk));
        } else {
            room.wallTiling.skirting[key] = JSON.parse(JSON.stringify(sk));
        }
    }
    function hasAnySkirting(room) {
        return !room.cleared && getRoomFaces(room).some(f => getSkirtingCfg(room, f.key).enabled);
    }
    const hasAnyWallTiling = room => !room.cleared && (getRoomFaces(room).some(f => getCfg(room, f.key)) || hasAnySkirting(room));

    /* ===================== 排砖计算 ===================== */
    /** 轴对齐矩形减去若干矩形洞口：返回面积与边界环（坐标压缩法，支持 L 形、回字形） */
    function rectMinusHoles(r, holes) {
        const hs = holes.map(h => ({ x0: Math.max(h.x0, r.x0), y0: Math.max(h.y0, r.y0), x1: Math.min(h.x1, r.x1), y1: Math.min(h.y1, r.y1) }))
            .filter(h => h.x1 - h.x0 > 0.05 && h.y1 - h.y0 > 0.05);
        const rectLoop = q => [{ x: q.x0, y: q.y0 }, { x: q.x1, y: q.y0 }, { x: q.x1, y: q.y1 }, { x: q.x0, y: q.y1 }];
        if (!hs.length) return { area: (r.x1 - r.x0) * (r.y1 - r.y0), loops: [rectLoop(r)], bbox: r };
        const uniq = arr => [...new Set(arr.map(v => Math.round(v * 100) / 100))].sort((p, q) => p - q);
        const xs = uniq([r.x0, r.x1, ...hs.flatMap(h => [h.x0, h.x1])]);
        const ys = uniq([r.y0, r.y1, ...hs.flatMap(h => [h.y0, h.y1])]);
        const I = xs.length - 1, J = ys.length - 1;
        const inside = [];
        let area = 0;
        let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
        for (let i = 0; i < I; i++) {
            inside.push([]);
            for (let j = 0; j < J; j++) {
                const cx = (xs[i] + xs[i + 1]) / 2, cy = (ys[j] + ys[j + 1]) / 2;
                const inn = !hs.some(h => cx > h.x0 && cx < h.x1 && cy > h.y0 && cy < h.y1);
                inside[i].push(inn);
                if (inn) {
                    area += (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j]);
                    bx0 = Math.min(bx0, xs[i]); bx1 = Math.max(bx1, xs[i + 1]);
                    by0 = Math.min(by0, ys[j]); by1 = Math.max(by1, ys[j + 1]);
                }
            }
        }
        if (area <= 0) return { area: 0, loops: [], bbox: null };
        const isIn = (i, j) => i >= 0 && j >= 0 && i < I && j < J && inside[i][j];
        const out = new Map();
        const addE = (i1, j1, i2, j2) => { const k = i1 + ',' + j1; if (!out.has(k)) out.set(k, []); out.get(k).push([i2, j2]); };
        for (let i = 0; i < I; i++) for (let j = 0; j < J; j++) {
            if (!inside[i][j]) continue;
            if (!isIn(i, j - 1)) addE(i, j, i + 1, j);
            if (!isIn(i + 1, j)) addE(i + 1, j, i + 1, j + 1);
            if (!isIn(i, j + 1)) addE(i + 1, j + 1, i, j + 1);
            if (!isIn(i - 1, j)) addE(i, j + 1, i, j);
        }
        const loops = [];
        let guard = 0;
        while (out.size && guard++ < 1000) {
            const [k0, list0] = out.entries().next().value;
            let cur = k0.split(',').map(Number);
            const loop = [];
            const startKey = k0;
            let steps = 0;
            while (steps++ < 4000) {
                const k = cur[0] + ',' + cur[1];
                const list = out.get(k);
                if (!list || !list.length) break;
                const nx = list.shift();
                if (!list.length) out.delete(k);
                loop.push({ x: xs[cur[0]], y: ys[cur[1]] });
                cur = nx;
                if (cur[0] + ',' + cur[1] === startKey && !out.has(startKey)) break;
                if (cur[0] + ',' + cur[1] === startKey) break;
            }
            // 去共线点
            const cl = loop.filter((p, i) => {
                const a = loop[(i - 1 + loop.length) % loop.length], b = loop[(i + 1) % loop.length];
                return Math.abs((p.x - a.x) * (b.y - p.y) - (p.y - a.y) * (b.x - p.x)) > 1e-6;
            });
            if (cl.length >= 3) loops.push(cl);
            void list0;
        }
        return { area, loops, bbox: { x0: bx0, y0: by0, x1: bx1, y1: by1 } };
    }

    /** 墙面铺贴区：离底 ~ (吊顶 − 离顶) 一个区；高度不足时为空 */
    function faceZones(cfg, H) {
        const top = Math.max(0, H - Math.max(0, num(cfg.top, 0)));
        const bottom = Math.max(0, num(cfg.bottom, 0));
        if (top - bottom < 1) return [];
        return [{ kind: 'main', name: '墙砖', y0: bottom, y1: top, spec: { styleId: cfg.styleId, tileW: cfg.tileW, tileH: cfg.tileH, pattern: cfg.pattern }, alignV: cfg.alignV }];
    }

    const layoutCache = new Map();
    let numDirty = true;   // 墙面排砖结果变化后需重新按规格编号
    function ensureNumbers() {
        if (!numDirty || typeof renumberTiles !== 'function') return;
        numDirty = false;
        renumberTiles();
        numDirty = false;
    }
    /** 单个墙面的排砖结果：{ H, zones:[{..., tiles, stats}], stats, holes } */
    function computeFaceLayout(room, face, cfg) {
        cfg = cfg || getCfg(room, face.key);
        const H = roomH(room);
        if (!cfg) return null;
        const holes = face.openings.map(o => ({ x0: o.x0, x1: o.x1, y0: o.y0, y1: o.y1 }));
        const sig = JSON.stringify([face.lenMM.toFixed(1), H, holes.map(h => [h.x0, h.x1, h.y0, h.y1].map(v => v.toFixed(1))), cfg, reuseSmall()]);
        const ck = room.id + '/' + face.key;
        const hit = layoutCache.get(ck);
        if (hit && hit.sig === sig) return hit.res;
        numDirty = true;
        const L = face.lenMM;
        const gap = Math.max(0, num(cfg.gap, 1.5));
        const zones = faceZones(cfg, H);
        let seq = 0;
        for (const z of zones) {
            const tw = Math.max(20, num(z.spec.tileW, 300)), th = Math.max(20, num(z.spec.tileH, 600));
            const pX = tw + gap, pY = th + gap;
            const zr = { x0: 0, y0: z.y0, x1: L, y1: z.y1 };
            const org = validOrigin(cfg);
            let ox = org ? org.x : cfg.alignH === 'left' ? 0 : cfg.alignH === 'right' ? L - tw : (L - tw) / 2;
            let oy = z.alignV === 'top' ? z.y1 - th : z.alignV === 'center' ? (z.y0 + z.y1 - th) / 2 : z.y0;
            // 设置了起铺点时按起铺点竖向定位（起铺点可落在离底 / 离顶范围内）
            if (org) oy = org.y;
            const tiles = [];
            const pat = z.spec.pattern;
            const rowsLo = Math.floor((z.y0 - oy) / pY) - 1, rowsHi = Math.ceil((z.y1 - oy) / pY) + 1;
            for (let r = rowsLo; r <= rowsHi; r++) {
                const ty = oy + r * pY;
                // 竖向工字：奇数列整体上移半砖，行是否落在铺贴区内要按列判断（见下方 ty2），
                // 否则最下一行在偶数列完全出界时被整行跳过，奇数列底部就会留出半砖空白
                if (pat !== 'vbrick' && (ty >= z.y1 || ty + th <= z.y0)) continue;
                const shift = pat === 'brick' && (r & 1) ? pX / 2 : 0;
                const cLo = Math.floor((0 - ox - shift) / pX) - 1, cHi = Math.ceil((L - ox - shift) / pX) + 1;
                for (let c = cLo; c <= cHi; c++) {
                    const vshift = pat === 'vbrick' && (c & 1) ? pY / 2 : 0;
                    const tx = ox + shift + c * pX;
                    const ty2 = ty + vshift;
                    if (ty2 >= z.y1 || ty2 + th <= z.y0) continue;
                    const full = { x0: tx, y0: ty2, x1: tx + tw, y1: ty2 + th };
                    const cr = { x0: Math.max(full.x0, zr.x0), y0: Math.max(full.y0, zr.y0), x1: Math.min(full.x1, zr.x1), y1: Math.min(full.y1, zr.y1) };
                    if (cr.x1 - cr.x0 < 0.5 || cr.y1 - cr.y0 < 0.5) continue;
                    const reg = rectMinusHoles(cr, holes);
                    if (reg.area < 1 || !reg.loops.length) continue;
                    const ratio = reg.area / (tw * th);
                    if (ratio < 0.015) continue;
                    const bw = reg.bbox.x1 - reg.bbox.x0, bh = reg.bbox.y1 - reg.bbox.y0;
                    const category = classifyTileCut(ratio, bw, bh, tw, th);
                    tiles.push({ full, polys: reg.loops, area: reg.area, ratio, bw, bh, category, zone: z.kind });
                }
            }
            // 排序：自下而上、自左向右（砖号由 renumberTiles() 按规格统一编号）
            tiles.sort((p, q) => (p.full.y0 - q.full.y0) || (p.full.x0 - q.full.x0));
            for (const t of tiles) t.id = String(++seq);
            const st = { full: 0, large: 0, small: 0, area: 0 };
            for (const t of tiles) {
                if (t.category === 'FULL') st.full++; else if (t.category === 'CUT_LARGE') st.large++; else st.small++;
            }
            st.area = rectMinusHoles(zr, holes).area / 1e6;
            // 余料复用：墙面为正交裁剪，不存在斜切三角形（isTri: false，避免 L 形缺口砖被误判为三角形）
            const cuts = tiles.filter(t => t.category !== 'FULL').map(t => ({ a: t.bw, b: t.bh, area: t.polys.length === 1 ? t.area : 0, isTri: false }));
            const need = countTilesForCuts(cuts, tw, th, reuseSmall());
            st.saved = need.saved;
            st.buy = Math.ceil((st.full + need.tiles) * (1 + (num(cfg.wastage, 5)) / 100));
            Object.assign(z, { tiles, stats: st, tw, th });
        }
        const stats = zones.reduce((s, z) => {
            s.full += z.stats.full; s.large += z.stats.large; s.small += z.stats.small; s.area += z.stats.area; s.buy += z.stats.buy; return s;
        }, { full: 0, large: 0, small: 0, area: 0, buy: 0 });
        // 洞口扣减面积：按实际铺贴区毛面积 − 铺贴区净面积计算，自动遵循离地/离顶范围并去重重叠洞口
        const openArea = zones.reduce((s, z) => s + Math.max(0, ((z.y1 - z.y0) * L) / 1e6 - z.stats.area), 0);
        const res = { H, L, zones, stats, holes, openArea, gap };
        layoutCache.set(ck, { sig, res });
        return res;
    }
    const validOrigin = cfg => (cfg && cfg.origin && Number.isFinite(Number(cfg.origin.x)) && Number.isFinite(Number(cfg.origin.y))) ? { x: Number(cfg.origin.x), y: Number(cfg.origin.y) } : null;
    const reuseSmall = () => $('chk-small-cut-reuse')?.checked ?? true;

    function calcSkirtingMetrics(sk, netLenMM, deductMM, auxUnitPrice = WF().auxPrice) {
        const skDef = W().skirting[sk.type === 'wood' ? 'wood' : 'tile'];
        const lenMM = Math.max(50, num(sk.lenMM, skDef.lenMM));
        const thickMM = Math.max(1, num(sk.thickMM, skDef.thickMM));
        const heightMM = Math.max(10, num(sk.heightMM, skDef.heightMM));
        const wastage = Math.max(0, num(sk.wastage, skDef.wastage));
        const price = Math.max(0, num(sk.price, skDef.price));
        const priceUnit = sk.priceUnit || skDef.priceUnit;
        const safeNetMM = Math.max(0, Number(netLenMM) || 0);
        const netM = safeNetMM / 1000;
        const totalM = netM * (1 + wastage / 100);
        const buyCount = safeNetMM > 0 ? Math.ceil((safeNetMM / lenMM) * (1 + wastage / 100)) : 0;
        const buyLenM = buyCount * (lenMM / 1000);
        const buyAreaSqm = buyLenM * (heightMM / 1000);
        const netAreaSqm = (safeNetMM * heightMM) / 1e6;
        let cost = 0;
        if (priceUnit === 'piece') cost = buyCount * price;
        else if (priceUnit === 'm') cost = buyLenM * price;
        else cost = buyAreaSqm * price;
        const isTile = sk.type !== 'wood';
        const effAuxPrice = Math.max(0, num(auxUnitPrice, WF().auxPrice));
        const auxQty = isTile ? buyAreaSqm * (thickMM / 12) : buyAreaSqm * 0.25 * (thickMM / 15);
        const auxCost = auxQty * effAuxPrice;
        return {
            sk: { ...sk, lenMM, thickMM, heightMM, wastage, price, priceUnit },
            netLenMM: safeNetMM, deductMM: Math.max(0, Number(deductMM) || 0),
            deductM: Math.max(0, Number(deductMM) || 0) / 1000,
            netM, totalM, buyCount, buyLenM, buyAreaSqm, netAreaSqm,
            cost, auxQty, auxArea: auxQty, auxUnitPrice: effAuxPrice, auxCost
        };
    }

    function computeFaceSkirting(room, f, sk, auxUnitPrice = WF().auxPrice) {
        if (!sk || !sk.enabled) return null;
        const skDef = W().skirting[sk.type === 'wood' ? 'wood' : 'tile'];
        const heightMM = Math.max(10, num(sk.heightMM, skDef.heightMM));
        // 扣减低窗/落地窗与门洞（底部高于踢脚线高度的窗不扣减）
        const segs = [];
        for (const o of (f.openings || [])) {
            if (o.y0 < heightMM - 1) {
                const a = Math.max(0, o.x0), b = Math.min(f.lenMM, o.x1);
                if (b > a) segs.push([a, b]);
            }
        }
        segs.sort((p, q) => p[0] - q[0]);
        let deductMM = 0, curE = -1;
        for (const [a, b] of segs) {
            if (a > curE) { deductMM += b - a; curE = b; }
            else if (b > curE) { deductMM += b - curE; curE = b; }
        }
        const netLenMM = Math.max(0, f.lenMM - deductMM);
        return Object.assign({ room, face: f }, calcSkirtingMetrics(sk, netLenMM, deductMM, auxUnitPrice));
    }

    /** 墙面美缝截面系数：缝宽 × 经验缝深 / 基准截面，至少按 1 计（presets.json calc） */
    const groutCross = gapMM => Math.max(1.0, (gapMM * PRESETS.calc.groutDepthMM) / PRESETS.calc.groutCrossRef);
    const tileGroutLenM = (areaSqm, twMM, thMM, gapMM) => {
        if (!(areaSqm > 0)) return 0;
        const wM = twMM / 1000, hM = thMM / 1000, gM = Math.max(0, gapMM) / 1000;
        return areaSqm * ((wM + hM) / ((wM + gM) * (hM + gM)));
    };

    /** 当前层所有空间的墙面算量（含墙砖主材、墙面美缝、墙面辅料与踢脚线） */
    function computeAllWallStats() {
        const rows = [];
        const skirtingRows = [];
        const skirtingMerged = [];
        const groutGroups = [];
        const tot = {
            full: 0, large: 0, small: 0, area: 0, buyArea: 0, buy: 0, faces: 0, openArea: 0,
            tileCost: 0, cost: 0, groutLen: 0, groutTubes: 0, groutCost: 0,
            auxArea: 0, auxCost: 0
        };
        const skTot = {
            faces: 0, netM: 0, totalM: 0, buyLenM: 0, areaSqm: 0, netAreaSqm: 0,
            tileBuy: 0, woodBuy: 0, cost: 0, auxArea: 0, auxCost: 0
        };
        for (const room of STATE.rooms) {
            if (room.cleared) continue;
            const faces = getRoomFaces(room);
            const roomGroutGroups = new Map();
            const roomDefaultAuxPrice = num(room.wallAuxPrice, WF().auxPrice);
            for (const f of faces) {
                const cfg = getCfg(room, f.key);
                if (!cfg) continue;
                const lay = computeFaceLayout(room, f, cfg);
                if (!lay) continue;
                let faceCostRaw = 0;
                let faceBuyArea = 0;
                let faceGroutLen = 0;
                const gapMM = Math.max(0, num(cfg.gap, WF().gap));
                const wastage = Math.max(0, num(cfg.wastage, WF().wastage));
                for (const z of lay.zones) {
                    const zPrice = getSpecPrice('tile', z.spec.styleId, z.tw, z.th);
                    const zBuy = z.stats?.buy ?? 0;
                    const zBuyArea = zBuy * (z.tw * z.th / 1e6);
                    faceBuyArea += zBuyArea;
                    faceCostRaw += zBuyArea * zPrice;
                    if (cfg.groutEnabled !== false && gapMM > 0 && (z.stats?.area || 0) > 0) {
                        faceGroutLen += tileGroutLenM(z.stats.area, z.tw, z.th, gapMM);
                    }
                }
                const cost = Math.round(faceCostRaw);
                // 墙面辅料面积与报价单统一：净铺贴面积 × (1 + 损耗%)
                const faceAuxArea = lay.stats.area * (1 + wastage / 100);
                const faceAuxPrice = Math.max(0, num(cfg.auxPrice, roomDefaultAuxPrice));
                const faceAuxCost = faceAuxArea * faceAuxPrice;
                let faceGroutTubes = 0, faceGroutCost = 0, faceGroutArea = 0;
                const faceGroutPrice = Math.max(0, num(cfg.groutPrice, WF().groutPrice));
                if (faceGroutLen > 0) {
                    faceGroutArea = lay.stats.area;
                    const crossFactor = groutCross(gapMM);
                    const gColor = cfg.groutColor || WF().groutColor;
                    const gKey = `${gColor}|${faceGroutPrice}`;
                    const grp = roomGroutGroups.get(gKey) || { room, color: gColor, price: faceGroutPrice, area: 0, len: 0, weightedLen: 0, gaps: new Set(), faceKeys: [] };
                    grp.area += faceGroutArea;
                    grp.len += faceGroutLen;
                    grp.weightedLen += faceGroutLen * crossFactor;
                    grp.gaps.add(gapMM);
                    grp.faceKeys.push(f.key);
                    roomGroutGroups.set(gKey, grp);
                    faceGroutTubes = Math.ceil((faceGroutLen * crossFactor) / PRESETS.calc.groutMetersPerTube);
                    faceGroutCost = faceGroutArea * faceGroutPrice;
                }
                rows.push({
                    room, face: f, cfg, lay, cost, costRaw: faceCostRaw,
                    buyArea: faceBuyArea, groutLen: faceGroutLen, groutArea: faceGroutArea, groutTubes: faceGroutTubes,
                    groutCost: faceGroutCost, auxArea: faceAuxArea, auxCost: faceAuxCost
                });
                tot.full += lay.stats.full; tot.large += lay.stats.large; tot.small += lay.stats.small;
                tot.area += lay.stats.area; tot.buyArea += faceBuyArea; tot.buy += lay.stats.buy;
                tot.faces++; tot.openArea += lay.openArea;
                tot.tileCost += faceCostRaw; tot.cost += cost;
                tot.groutLen += faceGroutLen;
                tot.auxArea += faceAuxArea; tot.auxCost += faceAuxCost;
            }
            for (const grp of roomGroutGroups.values()) {
                const tubes = Math.ceil(grp.weightedLen / PRESETS.calc.groutMetersPerTube);
                tot.groutTubes += tubes;
                tot.groutCost += grp.area * grp.price;
                groutGroups.push({
                    room: grp.room, color: grp.color, price: grp.price,
                    area: grp.area, len: grp.len, weightedLen: grp.weightedLen, tubes,
                    gaps: Array.from(grp.gaps), faceKeys: grp.faceKeys
                });
            }
            // 踢脚线：记录单墙明细，同时按「房间 + 同规格 + 同单价」合并净长后统一取整，避免逐墙取整大幅高估采购量
            const roomSkGroups = new Map();
            for (const f of faces) {
                const sk = getSkirtingCfg(room, f.key);
                const faceCfg = getCfg(room, f.key);
                const auxP = faceCfg ? num(faceCfg.auxPrice, roomDefaultAuxPrice) : roomDefaultAuxPrice;
                const skRes = computeFaceSkirting(room, f, sk, auxP);
                if (!skRes) continue;
                skirtingRows.push(skRes);
                skTot.faces++;
                const s = skRes.sk;
                const skKey = `${s.type}|${s.lenMM}x${s.thickMM}x${s.heightMM}|${s.wastage}|${s.priceUnit}|${s.price}|${skRes.auxUnitPrice}`;
                const g = roomSkGroups.get(skKey) || { room, sk: s, auxUnitPrice: skRes.auxUnitPrice, netLenMM: 0, deductMM: 0, faces: [] };
                g.netLenMM += skRes.netLenMM;
                g.deductMM += skRes.deductMM;
                g.faces.push(f);
                roomSkGroups.set(skKey, g);
            }
            for (const g of roomSkGroups.values()) {
                const m = Object.assign({ room: g.room, faces: g.faces }, calcSkirtingMetrics(g.sk, g.netLenMM, g.deductMM, g.auxUnitPrice));
                skirtingMerged.push(m);
                skTot.netM += m.netM;
                skTot.totalM += m.totalM;
                skTot.buyLenM += m.buyLenM;
                skTot.areaSqm += m.buyAreaSqm;
                skTot.netAreaSqm += m.netAreaSqm;
                if (m.sk.type === 'wood') skTot.woodBuy += m.buyCount;
                else skTot.tileBuy += m.buyCount;
                skTot.cost += m.cost;
                skTot.auxArea += m.auxArea;
                skTot.auxCost += m.auxCost;
            }
        }
        return { rows, tot, skirtingRows, skirtingMerged, groutGroups, skTot };
    }

    /** 依次遍历当前层所有铺贴墙面的铺贴区（规格编号用；顺序与算量表一致） */
    function forEachWallZone(fn) {
        for (const room of STATE.rooms) {
            if (room.cleared) continue;
            for (const f of getRoomFaces(room)) {
                const cfg = getCfg(room, f.key);
                if (!cfg) continue;
                const lay = computeFaceLayout(room, f, cfg);
                if (lay) for (const z of lay.zones) fn(z, room, f, lay);
            }
        }
    }

    const styleOf = id => MaterialLib.get(id, 'tile');

    /* ===================== 3D 预览 ===================== */
    let lastFocusKey = '';
    let hits3d = [];
    let hover3d = null;
    function ptInPoly(px, py, poly) {
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
            if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / ((yj - yi) || 1e-9) + xi)) inside = !inside;
        }
        return inside;
    }
    function hit3D(sx, sy) {
        for (let i = hits3d.length - 1; i >= 0; i--) {
            if (ptInPoly(sx, sy, hits3d[i].poly2d)) return hits3d[i];
        }
        return null;
    }
    function setHover3D(hit) {
        const next = hit ? { roomId: hit.roomId, roomName: hit.roomName, faceKey: hit.faceKey, label: hit.label } : null;
        if (hover3d?.roomId === next?.roomId && hover3d?.faceKey === next?.faceKey) return;
        hover3d = next;
        render3D();
    }
    function focusRoom() {
        if (S.active) return getRoom(S.roomId) || null;
        if (STATE.selected?.type === 'room') return getRoom(STATE.selected.id) || null;
        return null;
    }
    function focusKey() { const r = focusRoom(); return (r ? r.id : '-') + (S.active ? '/' + S.faceKey : ''); }
    function checkFocusChange() {
        const k = focusKey();
        if (k !== lastFocusKey) render3D();
    }

    function render3D() {
        const c3d = $('iso-3d-canvas');
        if (!c3d) return;
        lastFocusKey = focusKey();
        const ctx3 = c3d.getContext('2d');
        const W = c3d.width, Hc = c3d.height;
        ctx3.clearRect(0, 0, W, Hc);
        const focus = focusRoom();
        syncElevButton(focus);
        if (STATE.vertices.length < 2) return;

        const yaw = isoYawAngle, cosA = Math.cos(yaw), sinA = Math.sin(yaw), tilt = 0.56;
        const basePts = focus ? getRoomPolygonVerts(focus) : STATE.vertices;
        if (!basePts.length) return;
        const { cx, cy } = pointsBounds(basePts);
        const zTopMM = focus ? roomH(focus) : floorH();
        const zTopPx = mmToPx(zTopMM);
        const raw = (x, y, zPx) => {
            const dx = x - cx, dy = y - cy;
            return { x: dx * cosA - dy * sinA, y: (dx * sinA + dy * cosA) * tilt - zPx };
        };
        let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
        for (const p of basePts) for (const z of [0, zTopPx]) {
            const q = raw(p.x, p.y, z);
            bx0 = Math.min(bx0, q.x); bx1 = Math.max(bx1, q.x); by0 = Math.min(by0, q.y); by1 = Math.max(by1, q.y);
        }
        const pad = 12;
        const s = Math.min((W - pad * 2) / Math.max(1, bx1 - bx0), (Hc - pad * 2 - 4) / Math.max(1, by1 - by0));
        const mx = (bx0 + bx1) / 2, my = (by0 + by1) / 2;
        const project = (x, y, zMM = 0) => {
            const q = raw(x, y, mmToPx(zMM));
            return { x: W / 2 + (q.x - mx) * s, y: Hc / 2 + (q.y - my) * s - 2 };
        };
        const viewDir = { x: sinA, y: cosA };   // 屏幕向下 = 朝向观察者
        const poly3 = (pts3, fill, stroke, lw = 0.8, alpha = 1) => {
            ctx3.save();
            ctx3.globalAlpha = alpha;
            ctx3.beginPath();
            pts3.forEach((p, i) => { const q = project(p[0], p[1], p[2]); if (i) ctx3.lineTo(q.x, q.y); else ctx3.moveTo(q.x, q.y); });
            ctx3.closePath();
            if (fill) { ctx3.fillStyle = fill; ctx3.fill(); }
            if (stroke) { ctx3.strokeStyle = stroke; ctx3.lineWidth = lw; ctx3.stroke(); }
            ctx3.restore();
        };

        // ---- 地面 ----
        const drawFloor = (room) => {
            const verts = getRoomPolygonVerts(room);
            if (verts.length < 3) return;
            const styleObj = MaterialLib.getForRoom(room);
            const hasGap = !room.cleared && (Number(room.expansionGap) || 0) > 0;
            const paving = hasGap ? getRoomPavingPolygonVerts(room) : verts;
            poly3(verts.map(p => [p.x, p.y, 0]), room.cleared ? '#e2e8f0' : (hasGap ? (room.materialType === 'wood' ? '#fef3c7' : '#cbd5e1') : styleObj.base));
            if (hasGap && paving.length >= 3) poly3(paving.map(p => [p.x, p.y, 0]), styleObj.base);
            if (!room.cleared && room.computedTiles) {
                ctx3.strokeStyle = room.materialType === 'tile' ? 'rgba(100, 116, 139, 0.38)' : 'rgba(120, 82, 55, 0.40)';
                ctx3.lineWidth = 0.5;
                const maxDraw = Math.min(room.computedTiles.length, focus ? 400 : 160);
                for (let i = 0; i < maxDraw; i++) {
                    for (const part of room.computedTiles[i].polys) {
                        ctx3.beginPath();
                        part.forEach((pt, idx) => { const q = project(pt.x, pt.y, 0); if (idx) ctx3.lineTo(q.x, q.y); else ctx3.moveTo(q.x, q.y); });
                        ctx3.closePath();
                        ctx3.stroke();
                    }
                }
            }
            if (!focus && room.id === STATE.selectedRoomId) poly3(verts.map(p => [p.x, p.y, 0]), 'rgba(53, 106, 230, 0.16)');
        };

        hits3d = [];
        if (focus) {
            drawFloor(focus);
            render3DRoom(focus, { project, poly3, ctx3, viewDir });
        } else {
            for (const room of STATE.rooms) drawFloor(room);
            render3DWholeFloor({ project, poly3, ctx3, viewDir });
        }
        syncElevButton(focus);
    }

    /** 整层预览：墙中线拉伸，门窗按真实高度开洞，并收集各空间可见内墙面供点击进入立面 */
    function render3DWholeFloor({ project, poly3, ctx3, viewDir }) {
        const H = floorH();
        const walls = STATE.walls.slice().sort((a, b) => {
            const va1 = getVertex(a.v1), va2 = getVertex(a.v2), vb1 = getVertex(b.v1), vb2 = getVertex(b.v2);
            if (!va1 || !va2 || !vb1 || !vb2) return 0;
            return project((va1.x + va2.x) / 2, (va1.y + va2.y) / 2).y - project((vb1.x + vb2.x) / 2, (vb1.y + vb2.y) / 2).y;
        });
        const WALL_FILL = 'rgba(248, 250, 252, 0.90)', WALL_STROKE = '#64748b';
        const quad = (x1, y1, x2, y2, z0, z1, fill, stroke, lw = 0.75) => poly3([[x1, y1, z0], [x2, y2, z0], [x2, y2, z1], [x1, y1, z1]], fill, stroke, lw);
        for (const w of walls) {
            const v1 = getVertex(w.v1), v2 = getVertex(w.v2);
            if (!v1 || !v2) continue;
            const len = dist(v1, v2);
            if (len < 1) continue;
            const ops = STATE.openings.filter(op => op.wallId === w.id).map(op => {
                const hr = Math.min(0.48, ((op.width || 45) / 2) / len);
                return { op, t0: Math.max(0.02, op.t - hr), t1: Math.min(0.98, op.t + hr) };
            }).filter(it => it.t1 - it.t0 > 0.02).sort((a, b) => a.t0 - b.t0);
            const at = t => ({ x: v1.x + (v2.x - v1.x) * t, y: v1.y + (v2.y - v1.y) * t });
            let cur = 0;
            for (const it of ops) {
                if (it.t0 > cur + 0.005) { const p = at(cur), q = at(it.t0); quad(p.x, p.y, q.x, q.y, 0, H, WALL_FILL, WALL_STROKE); }
                const p = at(it.t0), q = at(it.t1);
                const op = it.op;
                const isSel = STATE.selected?.type === 'opening' && STATE.selected.id === op.id;
                const y0 = Math.min(H, opSill(op)), y1 = Math.min(H, opSill(op) + opHeight(op));
                if (y0 > 0) quad(p.x, p.y, q.x, q.y, 0, y0, WALL_FILL, WALL_STROKE, 0.7);
                if (y1 < H) quad(p.x, p.y, q.x, q.y, y1, H, 'rgba(241, 245, 249, 0.92)', WALL_STROKE, 0.7);
                if (op.type === 'window') {
                    quad(p.x, p.y, q.x, q.y, y0, y1, isSel ? 'rgba(56, 189, 248, 0.68)' : 'rgba(125, 211, 252, 0.52)', isSel ? '#0284c7' : '#0ea5e9', isSel ? 1.5 : 1.1);
                    const mxp = (p.x + q.x) / 2, myp = (p.y + q.y) / 2;
                    const a0 = project(mxp, myp, y0), a1 = project(mxp, myp, y1);
                    ctx3.strokeStyle = '#0284c7'; ctx3.lineWidth = 0.9;
                    ctx3.beginPath(); ctx3.moveTo(a0.x, a0.y); ctx3.lineTo(a1.x, a1.y); ctx3.stroke();
                } else {
                    const f = [project(p.x, p.y, 0), project(p.x, p.y, y1), project(q.x, q.y, y1), project(q.x, q.y, 0)];
                    ctx3.strokeStyle = isSel ? '#356AE6' : '#78350f';
                    ctx3.lineWidth = isSel ? 1.6 : 1.2;
                    ctx3.beginPath(); f.forEach((pt, i) => i ? ctx3.lineTo(pt.x, pt.y) : ctx3.moveTo(pt.x, pt.y)); ctx3.stroke();
                    // 半开门扇
                    const ux = (v2.x - v1.x) / len, uy = (v2.y - v1.y) / len, nx = -uy, ny = ux;
                    const wpx = (it.t1 - it.t0) * len, fs = op.flip ? -1 : 1, hend = !!op.hinge;
                    const hx = hend ? q.x : p.x, hy = hend ? q.y : p.y, ds = hend ? -1 : 1, ang = Math.PI * 0.36;
                    const ex = hx + (ux * ds * Math.cos(ang) + nx * fs * Math.sin(ang)) * wpx;
                    const ey = hy + (uy * ds * Math.cos(ang) + ny * fs * Math.sin(ang)) * wpx;
                    quad(hx, hy, ex, ey, 0, y1, isSel ? 'rgba(59, 130, 246, 0.72)' : 'rgba(217, 119, 6, 0.78)', isSel ? '#2D5DD0' : '#78350f', 1.0);
                }
                cur = Math.max(cur, it.t1);
            }
            if (cur < 0.995) { const p = at(cur); quad(p.x, p.y, v2.x, v2.y, 0, H, WALL_FILL, WALL_STROKE); }
            const t1 = project(v1.x, v1.y, H), t2 = project(v2.x, v2.y, H);
            ctx3.strokeStyle = '#334155'; ctx3.lineWidth = 1.6;
            ctx3.beginPath(); ctx3.moveTo(t1.x, t1.y); ctx3.lineTo(t2.x, t2.y); ctx3.stroke();
        }
        // 记录所有房间可见内墙面点击区，供直接点击进入对应立面
        const faceItems = [];
        for (const room of STATE.rooms) {
            if (room.cleared) continue;
            const rH = roomH(room);
            for (const f of getRoomFaces(room)) {
                if (dot(f.n, viewDir) <= 0.02) continue;
                faceItems.push({
                    room, f, H: rH,
                    depth: project((f.a.x + f.b.x) / 2, (f.a.y + f.b.y) / 2).y
                });
            }
        }
        faceItems.sort((p, q) => p.depth - q.depth);
        for (const { room, f, H: rH } of faceItems) {
            const toW = (x, y) => { const k = x / PX2MM; return [f.a.x + f.u.x * k, f.a.y + f.u.y * k, y]; };
            const outline = [toW(0, 0), toW(f.lenMM, 0), toW(f.lenMM, rH), toW(0, rH)];
            const poly2d = outline.map(p => project(p[0], p[1], p[2]));
            hits3d.push({ roomId: room.id, roomName: room.name, faceKey: f.key, label: f.label, poly2d });
            if (hover3d && hover3d.roomId === room.id && hover3d.faceKey === f.key) {
                poly3(outline, 'rgba(53, 106, 230, 0.22)', '#2563eb', 1.8);
                const c = project(...toW(f.lenMM / 2, rH * 0.55));
                ctx3.font = `600 10px ${CANVAS_FONT_SANS}`;
                ctx3.fillStyle = '#1d4ed8';
                ctx3.textAlign = 'center'; ctx3.textBaseline = 'middle';
                ctx3.fillText(`${room.name}·${f.label}`, c.x, c.y);
            }
        }
    }

    /** 单空间预览：远侧墙面（看得到内侧）完整显示并贴砖，近侧墙面剖切为线框 */
    function render3DRoom(room, { project, poly3, ctx3, viewDir }) {
        const faces = getRoomFaces(room);
        const H = roomH(room);
        const toW = (f, x, y) => { const k = x / PX2MM; return [f.a.x + f.u.x * k, f.a.y + f.u.y * k, y]; };
        const items = faces.map(f => ({ f, vis: dot(f.n, viewDir) > 0.02, depth: project((f.a.x + f.b.x) / 2, (f.a.y + f.b.y) / 2).y }));
        items.sort((p, q) => p.depth - q.depth);
        for (const { f, vis } of items) {
            const isCur = S.active && S.faceKey === f.key;
            const isHover = hover3d && hover3d.roomId === room.id && hover3d.faceKey === f.key;
            const outline = [toW(f, 0, 0), toW(f, f.lenMM, 0), toW(f, f.lenMM, H), toW(f, 0, H)];
            if (!vis) {
                poly3(outline, null, isCur ? '#356AE6' : 'rgba(100, 116, 139, 0.55)', isCur ? 1.4 : 0.7);
                continue;
            }
            poly3(outline, '#f8fafc', null);
            const cfg = getCfg(room, f.key);
            const lay = cfg ? computeFaceLayout(room, f, cfg) : null;
            if (lay) {
                let budget = 900;
                for (const z of lay.zones) {
                    const base = styleOf(z.spec.styleId).base;
                    for (const t of z.tiles) {
                        if (budget-- <= 0) break;
                        for (const loop of t.polys) poly3(loop.map(p => toW(f, p.x, p.y)), base, 'rgba(100, 116, 139, 0.45)', 0.4);
                    }
                }
            }
            for (const o of f.openings) {
                const pts = [toW(f, o.x0, o.y0), toW(f, o.x1, o.y0), toW(f, o.x1, Math.min(H, o.y1)), toW(f, o.x0, Math.min(H, o.y1))];
                if (o.type === 'window') poly3(pts, 'rgba(186, 230, 253, 0.95)', '#0ea5e9', 1);
                else poly3(pts, '#e2e8f0', '#78350f', 1.1);
            }
            if (isHover) poly3(outline, 'rgba(53, 106, 230, 0.16)', '#2563eb', 1.8);
            else poly3(outline, null, isCur ? '#356AE6' : '#64748b', isCur ? 1.8 : 0.8);
            hits3d.push({
                roomId: room.id, roomName: room.name, faceKey: f.key, label: f.label,
                poly2d: outline.map(p => project(p[0], p[1], p[2]))
            });
            // 面标签
            const c = project(...toW(f, f.lenMM / 2, H * 0.9));
            ctx3.font = `600 10px ${CANVAS_FONT_SANS}`;
            ctx3.fillStyle = (isCur || isHover) ? '#2563eb' : '#475569';
            ctx3.textAlign = 'center'; ctx3.textBaseline = 'middle';
            ctx3.fillText(f.label, c.x, c.y);
        }
    }

    function syncElevButton(focus) {
        const hint = $('iso-3d-hint');
        if (!hint) return;
        if (hover3d) hint.textContent = `${hover3d.roomName} · ${hover3d.label}墙 (点击进入)`;
        else hint.textContent = focus ? focus.name : '整层预览';
    }

    function getScopeState(room, faces) {
        if (!room || !faces || !faces.length) return { f: null, all: true };
        const sel = S.faceKey ? faces.find(x => x.key === S.faceKey) || null : null;
        const f = S.view === 'single' ? (sel || faces[0] || null) : sel;
        return { f, all: !f };
    }

    /** 同步顶部「地面 / 立面」Tab、工具禁用状态、空状态提示与底部动作条 */
    function syncModeUi(room, faces) {
        const active = S.active;
        const btnFloor = $('btn-mode-floor'), btnElev = $('btn-mode-elev');
        if (btnFloor) {
            btnFloor.classList.toggle('is-active', !active);
            btnFloor.setAttribute('aria-selected', String(!active));
        }
        if (btnElev) {
            btnElev.classList.toggle('is-active', active);
            btnElev.setAttribute('aria-selected', String(active));
        }
        const btn3dToggle = $('btn-3d-mode-toggle');
        if (btn3dToggle) {
            btn3dToggle.classList.toggle('is-elev', active);
            btn3dToggle.title = active ? '返回平面视图' : '进入立面设计';
            btn3dToggle.setAttribute('aria-label', active ? '返回平面' : '立面设计');
            const icon = btn3dToggle.querySelector('i');
            if (icon) icon.className = active ? 'ph ph-squares-four' : 'ph ph-wall';
            const lbl = btn3dToggle.querySelector('span');
            if (lbl) lbl.textContent = active ? '返回平面' : '立面设计';
        }
        $('floor-mode-context')?.classList.toggle('hidden', active);
        $('elev-mode-context')?.classList.toggle('hidden', !active);
        document.querySelectorAll('.is-floor-tool').forEach(b => { b.disabled = active; });

        const hasFaces = !!(room && faces && faces.length);
        const emptyEl = $('elev-empty-state');
        const canvasBox = document.querySelector('#elev-view .elev-canvas-box');
        if (emptyEl) emptyEl.classList.toggle('hidden', !active || hasFaces);
        if (canvasBox) canvasBox.classList.toggle('hidden', !hasFaces);

        const applyBtn = $('btn-elev-apply-all'), clearBtn = $('btn-elev-clear');
        if (applyBtn || clearBtn) {
            const tiled = hasFaces ? faces.filter(x => getCfg(room, x.key)) : [];
            const { f, all } = hasFaces ? getScopeState(room, faces) : { f: null, all: true };
            const hasActiveTile = hasFaces && (all ? tiled.length > 0 : !!(f && getCfg(room, f.key)));
            const hasActiveSkirt = hasFaces && (all ? faces.some(x => getSkirtingCfg(room, x.key).enabled) : !!(f && getSkirtingCfg(room, f.key).enabled));
            if (applyBtn) applyBtn.disabled = !(hasActiveTile || hasActiveSkirt);
            if (clearBtn) {
                clearBtn.disabled = !(hasActiveTile || hasActiveSkirt);
                const lbl = clearBtn.querySelector('span');
                if (lbl) lbl.textContent = all ? '取消全墙' : '取消本墙';
            }
        }
        const roomSel = $('room-selector');
        if (roomSel && room) roomSel.value = String(room.id);
    }

    /* ===================== 立面设计模式 ===================== */
    const S = { active: false, picking: false, pickPreview: null, drag: null, roomId: null, faceKey: null, view: 'unfold', scale: 0.2, panX: 0, panY: 0, needFit: true, hits: [] };
    let elevSpecAdvOpen = false;
    const isActive = () => S.active;

    function enter(roomId, faceKey = null) {
        commitLiveEdit && commitLiveEdit();
        let room = roomId ? getRoom(roomId) : null;
        if (!room) room = focusRoom() || getSelectedRoom() || (STATE.rooms && STATE.rooms[0]) || null;
        S.active = true;
        S.picking = false;
        S.pickPreview = null;
        S.drag = null;
        elevSpecAdvOpen = false;
        S.view = faceKey ? 'single' : 'unfold';
        S.needFit = true;
        if (room) {
            const faces = getRoomFaces(room);
            S.roomId = room.id;
            STATE.selectedRoomId = room.id;
            STATE.selected = null;
            STATE.selectedWallIds.clear();
            S.faceKey = (faceKey && faces.some(f => f.key === faceKey)) ? faceKey : null;
            if (typeof initRoomSelectorDropdown === 'function') initRoomSelectorDropdown();
            if (typeof syncLeftPanelFromSelectedRoom === 'function') syncLeftPanelFromSelectedRoom();
        } else {
            S.roomId = null;
            S.faceKey = null;
        }
        document.body.classList.add('elev-mode');
        $('elev-view')?.classList.remove('hidden');
        if (STATE.tool === 'wall' || STATE.tool === 'door' || STATE.tool === 'window') {
            if (typeof setTool === 'function') setTool('select');
        }
        resizeElev();
        refresh({ calc: false });
        if (typeof syncUsageScope === 'function') syncUsageScope();   // 用量汇总切到当前立面空间
    }
    function selectFace(roomId, faceKey) {
        if (!S.active || S.roomId !== roomId) {
            enter(roomId, faceKey);
        } else {
            const room = getRoom(roomId);
            const faces = room ? getRoomFaces(room) : [];
            S.view = 'single';
            S.faceKey = faces.some(f => f.key === faceKey) ? faceKey : (faces[0]?.key || null);
            S.needFit = true;
            refresh({ calc: false });
        }
    }
    function exit() {
        if (!S.active) return;
        const rid = S.roomId;
        S.active = false; S.picking = false; S.pickPreview = null; S.drag = null; elevSpecAdvOpen = false;
        syncPickCursor();
        document.body.classList.remove('elev-mode');
        $('elev-view')?.classList.add('hidden');
        syncModeUi(null, []);
        if (getRoom(rid)) selectRoom(rid);
        else refreshViews({ panel: true, inspector: true, results: true, preview3d: true });
        updateZoomText();
        render();
    }
    function switchRoom(rid) {
        if (!S.active) return;
        const room = getRoom(rid);
        if (!room) {
            S.roomId = null;
            S.faceKey = null;
            refresh({ calc: false });
            return;
        }
        if (S.roomId === room.id) return;
        S.roomId = room.id;
        S.picking = false;
        S.pickPreview = null;
        S.drag = null;
        S.needFit = true;
        syncPickCursor();
        const faces = getRoomFaces(room);
        if (S.view === 'single') S.faceKey = faces.some(f => f.key === S.faceKey) ? S.faceKey : (faces[0]?.key || null);
        else S.faceKey = null;
        refresh({ calc: false });
        if (typeof syncUsageScope === 'function') syncUsageScope();
    }
    const curRoom = () => getRoom(S.roomId);

    function refresh({ calc = true } = {}) {
        if (!S.active) {
            syncModeUi(null, []);
            if (calc) renderCalculationResults();
            render3D();
            return;
        }
        let room = curRoom();
        if (!room && STATE.rooms && STATE.rooms.length) {
            room = focusRoom() || getSelectedRoom() || STATE.rooms[0];
            S.roomId = room.id;
            STATE.selectedRoomId = room.id;
        }
        const faces = room ? getRoomFaces(room) : [];
        if (room) {
            if (S.view === 'single') {
                if (!faces.some(f => f.key === S.faceKey)) S.faceKey = faces[0]?.key || null;
            } else if (S.faceKey && !faces.some(f => f.key === S.faceKey)) {
                S.faceKey = null;
            }
        }
        if (calc) numDirty = true;
        renderTabs(room, faces);
        renderPanel(room, faces);
        syncModeUi(room, faces);
        if (room && faces.length) drawElev();
        render3D();
        if (calc) renderCalculationResults();
    }

    function renderTabs(room, faces) {
        const box = $('elev-tabs');
        if (!box) return;
        if (!room || !faces.length) { box.innerHTML = ''; return; }
        const allOn = faces.length && faces.every(f => getCfg(room, f.key));
        box.innerHTML = `<button type="button" class="elev-tab elev-tab-unfold${S.view === 'unfold' && !S.faceKey ? ' is-active' : ''}${allOn ? ' has-tile' : ''}" data-face="__unfold" title="全部墙面连续展开（未选中单面墙时修改参数作用于全墙）"><i class="ph ph-arrows-out-line-horizontal"></i><span>全墙</span></button>` +
            faces.map(f => {
                const cfg = getCfg(room, f.key);
                const on = cfg ? ' has-tile' : '';
                const act = (S.view === 'single' && f.key === S.faceKey) || (S.view === 'unfold' && f.key === S.faceKey) ? ' is-active' : '';
                const st = cfg ? styleOf(cfg.styleId) : null;
                const infoText = cfg ? `（${SidePanel.esc(st?.name || '墙砖')} ${uSpec(cfg.tileW, cfg.tileH)}）` : '';
                return `<button type="button" class="elev-tab${act}${on}" data-face="${f.key}" title="${f.label}墙 · ${Units.text(f.lenMM)}"><b>${f.label}</b>${infoText ? `<span>${infoText}</span>` : ''}</button>`;
            }).join('');
    }

    /* ---- 左侧墙面铺贴面板 ---- */
    /** 新铺贴墙面的初始配置：沿用本空间已铺贴墙面的设置（不含起铺点），否则取默认 */
    function seedCfg(room, faces) {
        const t = faces.find(x => getCfg(room, x.key));
        const c = t ? getCfg(room, t.key) : defaultCfg();
        if (!t && room) {
            if (room.wallGroutEnabled !== undefined) c.groutEnabled = !!room.wallGroutEnabled;
            if (room.wallGroutColor) c.groutColor = room.wallGroutColor;
            if (room.wallGroutPrice != null) c.groutPrice = Number(room.wallGroutPrice);
            if (room.wallAuxPrice != null) c.auxPrice = Number(room.wallAuxPrice);
        }
        c.origin = null;
        return c;
    }
    function seedSkirtingCfg(room, faces) {
        const on = faces.find(x => getSkirtingCfg(room, x.key).enabled);
        return on ? getSkirtingCfg(room, on.key) : getSkirtingCfg(room, faces[0]?.key);
    }

    /** 墙面铺法（图标与地面铺法组一致；竖向工字 = 工字图标旋转 90°），见 presets.json wall.patterns */
    /** 左侧立面卡片：墙面材料与规格 / 铺贴方式与起铺点 / 墙面算量设置 */
    function renderPanel(room, faces) {
        const el = $('elev-panel');
        if (!el) return;
        if (!room || !faces || !faces.length) { el.innerHTML = ''; return; }
        const P = SidePanel;
        const { f, all } = getScopeState(room, faces);
        const tiled = faces.filter(x => getCfg(room, x.key));
        const enabled = all ? tiled.length > 0 : !!getCfg(room, f.key);
        const cfg = all ? seedCfg(room, faces) : (getCfg(room, f.key) || seedCfg(room, faces));
        const sk = all ? seedSkirtingCfg(room, faces) : getSkirtingCfg(room, f.key);
        const strip = c => { c = Object.assign({}, c); delete c.origin; return JSON.stringify(c); };
        const mixed = all && tiled.length > 1 && new Set(tiled.map(x => strip(getCfg(room, x.key)))).size > 1;
        const H = roomH(room);
        const totalL = faces.reduce((s, x) => s + x.lenMM, 0);
        const sizeOpts = (w, h) => {
            const m = W().sizes.find(s => s.w === Number(w) && s.h === Number(h));
            return W().sizes.map(s => `<option value="${s.w}x${s.h}"${m === s ? ' selected' : ''}>${s.label}</option>`).join('') +
                `<option value="custom"${m ? '' : ' selected'}>自定义 (${w} × ${h})</option>`;
        };
        const org = validOrigin(cfg);
        const nOrg = (all ? faces : [f]).filter(x => validOrigin(getCfg(room, x.key))).length;
        const meta = getSpecMeta('wall', 'tile', cfg.styleId);
        const targetFaces = all ? faces : [f];
        const shownLay = targetFaces.filter(x => getCfg(room, x.key)).map(x => computeFaceLayout(room, x)).filter(Boolean);
        ensureNumbers();
        const mainZone = shownLay.length ? shownLay[0].zones[0] : null;
        const specLbl = mainZone && mainZone.specLabel ? mainZone.specLabel : `${meta.prefix}?`;
        const specPrice = getSpecPrice('tile', cfg.styleId, cfg.tileW, cfg.tileH);

        const groutOn = cfg.groutEnabled !== false;
        const groutColor = cfg.groutColor || WF().groutColor;
        const groutPrice = num(cfg.groutPrice, WF().groutPrice);
        const auxPrice = num(cfg.auxPrice, WF().auxPrice);
        const reuseOn = reuseSmall();

        let html = '';
        // ① 墙面砖材（含单价与铺贴范围）
        const specHeaderRight = all
            ? `<span class="ui-badge ui-badge-solid font-mono">全墙 · ${faces.length} 面</span>`
            : `<div class="flex items-center gap-1"><span class="ui-badge ui-badge-solid font-mono">${f.label}墙</span>${S.view === 'unfold' ? `<button type="button" class="ui-btn ui-btn-sm ui-btn-icon" data-act="reset-all-scope" title="切回全墙统一编辑" aria-label="切回全墙"><i class="ph ph-stack"></i></button>` : ''}</div>`;
        html += P.card('elev-spec', '墙面砖材',
            specHeaderRight,
            `${all
                ? P.row('铺贴全墙', `<label class="elev-toggle flex-1"><input type="checkbox" data-f="enabled" class="accent-blue-600"${tiled.length === faces.length ? ' checked' : ''}><span class="font-mono text-slate-500">总长 ${Units.dim(totalL)}${mixed ? ' · 各墙略异' : ''}</span></label>`)
                : P.row('铺贴本墙', `<label class="elev-toggle flex-1"><input type="checkbox" data-f="enabled" class="accent-blue-600"${enabled ? ' checked' : ''}><span class="font-mono text-slate-500">${Units.dim(f.lenMM)} × ${Units.dim(H)} · ${Math.round(f.bearing)}°${f.openings.length ? ` · ${f.openings.length}洞` : ''}</span></label>`)}
            <div class="space-y-2">
            ${P.swatch('main', styleOf(cfg.styleId).name, '选择花色')}
            ${P.specNumberRow(specKindList('tile').map(k => k.kind), meta, specLbl + tileNumSep() + '1', '砖号 = 前缀 + 规格号 + 序号，铺贴后自动编号', { expanded: elevSpecAdvOpen })}
            ${P.row('常用规格', `<select data-f="size" class="ui-select flex-1 font-mono">${sizeOpts(cfg.tileW, cfg.tileH)}</select>`)}
            ${P.row('尺寸', `<div class="flex items-center gap-1 flex-1 min-w-0">
                    ${P.lenInput('tileW', cfg.tileW, '砖宽（水平）')}
                    <button type="button" data-act="swap" class="ui-btn px-1.5 shrink-0" title="宽高对调"><i class="ph ph-arrows-left-right text-[13px] text-slate-500"></i></button>
                    ${P.lenInput('tileH', cfg.tileH, '砖高（竖直）')}
                    <span data-unit-text class="spec-unit-tag">${Units.cur()}</span>
                </div>`)}
            ${P.row('单价', P.numInput('price', specPrice, { min: 0, max: 99999, step: 5, unit: '元/m²', title: '当前规格砖材单价（同花色与规格在地面和墙面间自动同步）' }), '同花色同规格在地面与墙面间同步单价')}
            ${P.row('砖缝', P.numInput('gap', cfg.gap, { min: 0, max: 20, step: 0.5, title: '砖缝宽度' }))}
            <div class="panel-sub-sep"></div>
            <div class="flex items-center justify-between">
                <span class="panel-sub-title">铺贴范围</span>
                <span class="text-[11px] text-slate-400 font-mono">${Units.dim(cfg.bottom)} ~ ${Units.dim(H - cfg.top)}</span>
            </div>
            ${P.row('离地高度', P.numInput('bottom', cfg.bottom, { min: 0, max: 3000, step: 10, title: '起铺离地高度' }), '铺贴起点离地面高度')}
            ${P.row('离顶预留', P.numInput('top', cfg.top, { min: 0, max: 3000, step: 10, title: '止点离吊顶距离（0 表示贴到吊顶）' }), '离吊顶预留距离；0 = 贴到吊顶')}
            ${P.row('有效高度', `<span class="flex-1 text-[12px] font-mono text-slate-600 text-center" title="吊顶 ${Units.text(H)} − 离地 − 离顶">${Units.text(Math.max(0, H - cfg.top - cfg.bottom))}</span>`)}
            </div>`);
        // ② 墙面铺贴
        html += P.card('elev-origin', '墙面铺贴',
            `<div class="flex items-center gap-1">
                <button type="button" class="ui-btn ui-btn-sm ui-btn-icon${S.picking ? ' is-active' : ''}" data-act="pick-origin" title="${S.picking ? '正在拾取起铺点（点击取消）' : '在立面图上拾取起铺点 (O)'}" aria-label="图上拾取起铺点"><i class="ph ph-crosshair"></i></button>
                <button type="button" class="ui-btn ui-btn-sm ui-btn-icon" data-act="clear-origin"${nOrg ? '' : ' disabled'} title="${all ? '清除全部墙面自定义起铺点' : '清除当前墙自定义起铺点'}" aria-label="清除自定义起铺点"><i class="ph ph-eraser"></i></button>
            </div>`,
            `<div class="space-y-2">
            ${P.patternGrid(W().patterns, cfg.pattern)}
            ${P.row('水平起铺', P.segRadio('ev-alignH', W().alignH, cfg.alignH, !!org))}
            ${P.row('竖向起铺', P.segRadio('ev-alignV', W().alignV, cfg.alignV, !!org))}
            ${!all && org ? `${P.row('距左端 X', P.numInput('originX', Math.round(org.x * 10) / 10, { min: -3000, max: 20000, step: 10, title: '起铺点距墙左端' }), '起铺点距墙面左端')}
            ${P.row('离地 Y', P.numInput('originY', Math.round(org.y * 10) / 10, { min: -3000, max: 10000, step: 10, title: '起铺点离地高度' }), '起铺点离地高度')}`
                : (all && nOrg ? `<div class="text-[11px] text-slate-400">已自定义 ${nOrg} 面起铺点</div>` : '')}
            </div>`);
        // ③ 墙面算量（损耗 / 辅料单价 / 余料复用 / 墙面美缝 / 踢脚线）
        let skStats = null;
        let wallGroutLen = 0, wallGroutTubes = 0;
        const panelGroutGroups = new Map();
        const panelSkGroups = new Map();
        for (const tf of targetFaces) {
            const tsk = getSkirtingCfg(room, tf.key);
            const tcfg = getCfg(room, tf.key);
            const skr = computeFaceSkirting(room, tf, tsk, tcfg ? num(tcfg.auxPrice, auxPrice) : auxPrice);
            if (skr) {
                const s = skr.sk;
                const skKey = `${s.type}|${s.lenMM}x${s.thickMM}x${s.heightMM}|${s.wastage}|${s.priceUnit}|${s.price}`;
                const g = panelSkGroups.get(skKey) || { sk: s, netLenMM: 0, deductMM: 0 };
                g.netLenMM += skr.netLenMM;
                g.deductMM += skr.deductMM;
                panelSkGroups.set(skKey, g);
            }
            if (tcfg && tcfg.groutEnabled !== false && num(tcfg.gap, WF().gap) > 0) {
                const gapMM = Math.max(0, num(tcfg.gap, WF().gap));
                const lay = computeFaceLayout(room, tf, tcfg);
                if (lay) {
                    let fLen = 0;
                    for (const z of lay.zones) if ((z.stats?.area || 0) > 0) fLen += tileGroutLenM(z.stats.area, z.tw, z.th, gapMM);
                    wallGroutLen += fLen;
                    if (fLen > 0) {
                        const gKey = `${tcfg.groutColor || WF().groutColor}|${Math.max(0, num(tcfg.groutPrice, WF().groutPrice))}`;
                        panelGroutGroups.set(gKey, (panelGroutGroups.get(gKey) || 0) + fLen * groutCross(gapMM));
                    }
                }
            }
        }
        for (const wLen of panelGroutGroups.values()) {
            wallGroutTubes += Math.ceil(wLen / PRESETS.calc.groutMetersPerTube);
        }
        for (const g of panelSkGroups.values()) {
            const m = calcSkirtingMetrics(g.sk, g.netLenMM, g.deductMM, auxPrice);
            if (!skStats) skStats = { netM: 0, buy: 0 };
            skStats.netM += m.netM;
            skStats.buy += m.buyCount;
        }
        let calcBody = `<div class="space-y-2">
            ${P.row('备用损耗', P.numInput('wastage', cfg.wastage, { min: 0, max: 30, step: 1, unit: '%', title: '墙砖备用损耗率' }))}
            ${P.row('辅料单价', P.numInput('auxPrice', auxPrice, { min: 0, max: 9999, step: 5, unit: '元/m²', title: '墙面铺贴辅料（瓷砖胶/背胶/砂浆等）单价' }), '墙面瓷砖胶 / 背胶 / 砂浆单价')}
            <div class="form-row">
                <label class="form-label cursor-pointer" title="将裁切产生的余料复用到其他裁切块（地面与墙面共用）">余料复用</label>
                <input type="checkbox" data-f="reuseSmall" class="accent-blue-600"${reuseOn ? ' checked' : ''}>
            </div>
            <div class="panel-card-subtle space-y-1.5">
                <div class="flex items-center justify-between">
                    <span class="panel-sub-title">墙面美缝</span>
                    <label class="flex items-center space-x-1 cursor-pointer text-[11px] text-slate-600">
                        <input type="checkbox" data-f="groutEnabled" class="accent-blue-600"${groutOn ? ' checked' : ''}>
                        <span>计入</span>
                    </label>
                </div>
                <div class="space-y-1.5${groutOn ? '' : ' opacity-50'}">
                    <div class="form-row">
                        <label class="form-label">缝色</label>
                        <div class="color-picker-wrapper flex-1" title="选择墙面美缝颜色">
                            <span class="color-swatch-box" style="background-color: ${P.esc(groutColor)};"></span>
                            <span class="color-hex-text">${P.esc(groutColor.toUpperCase())}</span>
                            <input type="color" data-f="groutColor" value="${P.esc(groutColor)}" aria-label="墙面美缝颜色">
                        </div>
                    </div>
                    ${P.row('单价', P.numInput('groutPrice', groutPrice, { min: 0, max: 9999, step: 1, unit: '元/m²', title: '墙面美缝单价 (元/m²)' }), '按墙砖铺贴面积计算（元/m²）')}
                </div>
            </div>
            <div class="panel-card-subtle space-y-1.5">
                <div class="flex items-center justify-between">
                    <span class="panel-sub-title">踢脚线</span>
                    <label class="flex items-center space-x-1 cursor-pointer text-[11px] text-slate-600">
                        <input type="checkbox" data-sk="enabled" class="accent-blue-600"${sk.enabled ? ' checked' : ''}>
                        <span>计入</span>
                    </label>
                </div>
                <div class="space-y-1.5${sk.enabled ? '' : ' opacity-50'}">
                    ${P.row('类型', `<select data-sk="type" class="ui-select flex-1"><option value="tile"${sk.type === 'tile' ? ' selected' : ''}>瓷砖踢脚线</option><option value="wood"${sk.type === 'wood' ? ' selected' : ''}>木质踢脚线</option></select>`)}
                    ${P.row('长×宽×高', `<div class="skirting-dims-row">
                        <input type="number" data-len data-sk="lenMM" min="50" max="5000" step="10" value="${sk.lenMM}" class="ui-input font-mono text-center" title="单块/单根长度">
                        <span class="skirting-dim-sep">×</span>
                        <input type="number" data-len data-sk="thickMM" min="1" max="100" step="1" value="${sk.thickMM}" class="ui-input font-mono text-center" title="踢脚线宽度(厚度)">
                        <span class="skirting-dim-sep">×</span>
                        <input type="number" data-len data-sk="heightMM" min="20" max="500" step="5" value="${sk.heightMM}" class="ui-input font-mono text-center" title="踢脚线高度">
                        <span data-unit-text class="spec-unit-tag">${Units.cur()}</span>
                    </div>`, '单块(根) 长度 × 厚度(宽) × 高度')}
                    ${P.row('损耗率', `<div class="input-unit flex-1" data-unit="%"><input type="number" data-no-unit data-sk="wastage" min="0" max="30" step="1" value="${sk.wastage}" class="ui-input font-mono w-full text-center" title="踢脚线裁切备用损耗 (%)"></div>`)}
                    ${P.row('单价', `<div class="skirting-price-row">
                        <input type="number" data-no-unit data-sk="price" min="0" max="99999" step="5" value="${sk.price}" class="ui-input font-mono text-center" title="踢脚线单价">
                        <select data-sk="priceUnit" class="ui-select" title="踢脚线计价单位">
                            <option value="sqm"${sk.priceUnit === 'sqm' ? ' selected' : ''}>元/m²</option>
                            <option value="piece"${sk.priceUnit === 'piece' ? ' selected' : ''}>${sk.type === 'wood' ? '元/根' : '元/块'}</option>
                            <option value="m"${sk.priceUnit === 'm' ? ' selected' : ''}>元/m</option>
                        </select>
                    </div>`, '支持按面积(元/m²)、按块/根或按延长米(元/m)计价')}
                </div>
            </div>
            </div>`;
        if (shownLay.length || skStats) {
            const st = shownLay.reduce((a, l) => { a.area += l.stats.area; a.buy += l.stats.buy; a.full += l.stats.full; a.large += l.stats.large; a.small += l.stats.small; a.open += l.openArea; return a; },
                { area: 0, buy: 0, full: 0, large: 0, small: 0, open: 0 });
            calcBody += `
            <div class="elev-stats">
                <div><span>墙砖面积</span><b>${st.area.toFixed(2)} m²</b></div>
                <div><span>墙砖采购</span><b>${st.buy} 块</b></div>
                <div><span>整 / 大裁 / 小角</span><b>${st.full} / ${st.large} / ${st.small}</b></div>
                <div><span>洞口扣减</span><b>${st.open.toFixed(2)} m²</b></div>
                ${wallGroutLen > 0 ? `<div><span>墙面美缝</span><b>${wallGroutLen.toFixed(1)}m (${wallGroutTubes}支)</b></div>` : ''}
                ${skStats ? `<div><span>踢脚线</span><b>${skStats.netM.toFixed(2)}m (${skStats.buy}${sk.type === 'wood' ? '根' : '块'})</b></div>` : ''}
            </div>`;
        }
        html += P.card('elev-calc', '墙面算量', '', calcBody);
        el.innerHTML = html;
        Units.scan(el);
        el.querySelectorAll('canvas[data-swatch]').forEach(cv => drawMaterialSwatch(cv, 'tile', styleOf(cfg.styleId)));
        P.bindDynamicCards(el);
        bindPanel(el, room, faces, f, cfg);
    }

    /** 将当前墙（或首个已铺墙）配置与踢脚线同步到当前空间所有墙面 */
    function applyToAllFaces() {
        const room = curRoom();
        if (!room) return;
        const faces = getRoomFaces(room);
        if (!faces.length) return;
        const { f } = getScopeState(room, faces);
        const baseFace = f && (getCfg(room, f.key) || getSkirtingCfg(room, f.key).enabled) ? f
            : (faces.find(x => getCfg(room, x.key)) || faces.find(x => getSkirtingCfg(room, x.key).enabled));
        const base = baseFace && getCfg(room, baseFace.key);
        const baseSk = baseFace && getSkirtingCfg(room, baseFace.key);
        if (!base && !(baseSk && baseSk.enabled)) { showToast('当前墙面尚未启用铺贴或踢脚线'); return; }
        saveHistory();
        for (const ff of faces) {
            if (base) {
                const old = getCfg(room, ff.key);
                const c = JSON.parse(JSON.stringify(base));
                c.origin = ff.key === baseFace.key ? base.origin : (old ? old.origin : null);
                setCfg(room, ff.key, c);
            }
            if (baseSk) setSkirtingCfg(room, ff.key, baseSk);
        }
        markDirty();
        refresh();
        showToast(`已同步到「${room.name}」全部 ${faces.length} 面墙`);
    }

    function bindPanel(el, room, faces, f, shown) {
        const all = !f;
        const targets = all ? faces : [f];
        const edit = (fn, opts = {}) => {
            saveHistory();
            const seed = seedCfg(room, faces);
            for (const ff of targets) {
                if (opts.remove) { setCfg(room, ff.key, null); continue; }
                const c = getCfg(room, ff.key) || JSON.parse(JSON.stringify(seed));
                fn(c, ff);
                setCfg(room, ff.key, c);
            }
            markDirty();
            refresh();
        };
        const editSkirting = (fn, { commit = true } = {}) => {
            if (commit) saveHistory();
            const refSk = all ? seedSkirtingCfg(room, faces) : getSkirtingCfg(room, f.key);
            for (const ff of targets) {
                const s = JSON.parse(JSON.stringify(all ? refSk : getSkirtingCfg(room, ff.key)));
                fn(s, ff);
                setSkirtingCfg(room, ff.key, s);
            }
            markDirty();
            if (commit) refresh();
            else { drawElev(); render3D(); renderCalculationResults(); }
        };
        el.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => {
            const act = b.getAttribute('data-act');
            if (act === 'reset-all-scope') { S.faceKey = null; refresh({ calc: false }); }
            else if (act === 'swap') edit(c => { const t = c.tileW; c.tileW = c.tileH; c.tileH = t; });
            else if (act === 'clear') edit(() => {}, { remove: true });
            else if (act === 'pick-origin') setPicking(!S.picking);
            else if (act === 'clear-origin') {
                saveHistory();
                for (const ff of targets) { const c = getCfg(room, ff.key); if (c && c.origin) { c.origin = null; setCfg(room, ff.key, c); } }
                markDirty(); refresh();
            } else if (act === 'spec-adv') {
                elevSpecAdvOpen = !elevSpecAdvOpen;
                b.setAttribute('aria-expanded', elevSpecAdvOpen ? 'true' : 'false');
                const adv = el.querySelector('.spec-adv-panel');
                if (adv) adv.classList.toggle('hidden', !elevSpecAdvOpen);
            } else if (act === 'apply-all') {
                applyToAllFaces();
            }
        }));
        el.querySelectorAll('[data-pattern]').forEach(b => b.addEventListener('click', () => {
            const v = b.getAttribute('data-pattern');
            edit(c => { c.pattern = v; });
        }));
        el.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => {
            StylePicker.openFor({
                type: 'tile', ctx: 'wall', selectedId: shown.styleId || null, crop: { w: shown.tileW, h: shown.tileH },
                sub: `应用到：${room.name} · ${all ? '全部墙面' : `${f.label}墙`}`,
                onPick: id => {
                    const st = MaterialLib.get(id, 'tile');
                    if (st && st.sep != null) STATE.tileNumSep = st.sep;
                    edit(c => {
                        c.styleId = id;
                        if (st && st.tileW > 0 && st.tileH > 0) {
                            c.tileW = st.tileW;
                            c.tileH = st.tileH;
                        }
                    });
                }
            });
        }));
        el.querySelectorAll('input[type=radio]').forEach(r => r.addEventListener('change', () => {
            const v = r.value;
            edit(c => {
                if (r.name === 'ev-alignH') { c.alignH = v; c.origin = null; }
                else if (r.name === 'ev-alignV') { c.alignV = v; c.origin = null; }
            });
        }));
        const updateSpecPriceForScope = (val) => {
            if (typeof setSpecPrice !== 'function') return;
            const nVal = Math.max(0, Number.isFinite(Number(val)) ? Number(val) : defaultSpecPrice());
            const seen = new Set();
            for (const ff of targets) {
                const c = getCfg(room, ff.key) || shown;
                const key = `${c.styleId || ''}|${c.tileW}|${c.tileH}`;
                if (seen.has(key)) continue;
                seen.add(key);
                setSpecPrice('tile', c.styleId, c.tileW, c.tileH, nVal);
            }
            if (typeof syncLeftPanelFromSelectedRoom === 'function') syncLeftPanelFromSelectedRoom();
        };
        el.querySelectorAll('[data-f]').forEach(inp => {
            const k = inp.getAttribute('data-f');
            if (inp.tagName === 'INPUT' && (inp.type === 'number' || inp.type === 'text' || inp.type === 'color')) {
                inp.addEventListener('input', () => {
                    const v = inp.value;
                    const n = Number(v);
                    if (k === 'specPrefix') {
                        const ids = new Set((all ? faces.map(ff => getCfg(room, ff.key)).filter(Boolean) : [shown]).map(c => c.styleId));
                        if (!ids.size) ids.add(shown.styleId);
                        for (const id of ids) setSpecMeta('wall', 'tile', id, { prefix: v });
                        numDirty = true; markDirty(); drawElev(); render3D(); renderCalculationResults();
                        return;
                    }
                    if (k === 'price') {
                        if (Number.isFinite(n) && n >= 0) updateSpecPriceForScope(n);
                        markDirty(); renderCalculationResults();
                        return;
                    }
                    if (k === 'groutColor') {
                        const wrap = inp.closest('.color-picker-wrapper');
                        if (wrap) {
                            const sw = wrap.querySelector('.color-swatch-box'); if (sw) sw.style.backgroundColor = v;
                            const hx = wrap.querySelector('.color-hex-text'); if (hx) hx.textContent = (v || '').toUpperCase();
                        }
                        if (all) room.wallGroutColor = v;
                    }
                    if (k === 'groutPrice' && all && Number.isFinite(n) && n >= 0) room.wallGroutPrice = n;
                    if (k === 'auxPrice' && all && Number.isFinite(n) && n >= 0) room.wallAuxPrice = n;
                    const seed = seedCfg(room, faces);
                    for (const ff of targets) {
                        const existing = getCfg(room, ff.key);
                        if (!existing && (k === 'groutColor' || k === 'groutPrice' || k === 'auxPrice')) continue;
                        const c = existing || JSON.parse(JSON.stringify(seed));
                        switch (k) {
                            case 'tileW': if (n >= 20) c.tileW = Math.round(n); break;
                            case 'tileH': if (n >= 20) c.tileH = Math.round(n); break;
                            case 'gap': if (Number.isFinite(n) && n >= 0) c.gap = n; break;
                            case 'bottom': if (Number.isFinite(n) && n >= 0) c.bottom = Math.round(n); break;
                            case 'top': if (Number.isFinite(n) && n >= 0) c.top = Math.round(n); break;
                            case 'originX': if (Number.isFinite(n) && c.origin) c.origin.x = n; break;
                            case 'originY': if (Number.isFinite(n) && c.origin) c.origin.y = n; break;
                            case 'wastage': if (Number.isFinite(n) && n >= 0) c.wastage = Math.min(50, n); break;
                            case 'groutColor': c.groutColor = v; break;
                            case 'groutPrice': if (Number.isFinite(n) && n >= 0) c.groutPrice = n; break;
                            case 'auxPrice': if (Number.isFinite(n) && n >= 0) c.auxPrice = n; break;
                        }
                        setCfg(room, ff.key, c);
                    }
                    numDirty = true; markDirty(); drawElev(); render3D(); renderCalculationResults();
                });
            }
            inp.addEventListener('change', () => {
                const v = inp.type === 'checkbox' ? inp.checked : inp.value;
                const n = Number(v);
                if (k === 'enabled') {
                    if (v) edit(() => {}); else edit(() => {}, { remove: true });
                    return;
                }
                if (k === 'reuseSmall') {
                    const chkFloor = $('chk-small-cut-reuse');
                    if (chkFloor && chkFloor.checked !== !!v) chkFloor.checked = !!v;
                    if (typeof recomputeAllRoomTiling === 'function') recomputeAllRoomTiling();
                    refresh({ calc: true });
                    return;
                }
                if (k === 'price') {
                    saveHistory();
                    updateSpecPriceForScope(Number.isFinite(n) && n >= 0 ? n : defaultSpecPrice());
                    markDirty(); refresh({ calc: true });
                    return;
                }
                if (k === 'specKind' || k === 'specPrefix') {
                    saveHistory();
                    const ids = new Set((all ? faces.map(ff => getCfg(room, ff.key)).filter(Boolean) : [shown]).map(c => c.styleId));
                    if (!ids.size) ids.add(shown.styleId);
                    for (const id of ids) setSpecMeta('wall', 'tile', id, k === 'specKind' ? { kind: v } : { prefix: v });
                    markDirty(); refresh();
                    return;
                }
                if (all) {
                    if (k === 'groutEnabled') room.wallGroutEnabled = !!v;
                    if (k === 'groutColor') room.wallGroutColor = v;
                    if (k === 'groutPrice' && Number.isFinite(n) && n >= 0) room.wallGroutPrice = n;
                    if (k === 'auxPrice' && Number.isFinite(n) && n >= 0) room.wallAuxPrice = n;
                }
                saveHistory();
                const seed = seedCfg(room, faces);
                const pos = (x, d) => Number.isFinite(x) && x > 0 ? Math.round(x) : d;
                for (const ff of targets) {
                    const existing = getCfg(room, ff.key);
                    if (!existing && (k === 'groutEnabled' || k === 'groutColor' || k === 'groutPrice' || k === 'auxPrice')) continue;
                    const c = existing || JSON.parse(JSON.stringify(seed));
                    switch (k) {
                        case 'size': if (v !== 'custom') { const [w, h] = v.split('x').map(Number); c.tileW = w; c.tileH = h; } break;
                        case 'tileW': c.tileW = pos(n, c.tileW); break;
                        case 'tileH': c.tileH = pos(n, c.tileH); break;
                        case 'gap': c.gap = Math.max(0, Number.isFinite(n) ? n : WF().gap); break;
                        case 'bottom': c.bottom = Math.max(0, Math.round(n) || 0); break;
                        case 'top': c.top = Math.max(0, Math.round(n) || 0); break;
                        case 'originX': if (Number.isFinite(n) && c.origin) c.origin.x = n; break;
                        case 'originY': if (Number.isFinite(n) && c.origin) c.origin.y = n; break;
                        case 'wastage': c.wastage = Math.max(0, Math.min(50, Number.isFinite(n) ? n : 5)); break;
                        case 'groutEnabled': c.groutEnabled = !!v; break;
                        case 'groutColor': c.groutColor = v; break;
                        case 'groutPrice': c.groutPrice = Math.max(0, Number.isFinite(n) ? n : 45); break;
                        case 'auxPrice': c.auxPrice = Math.max(0, Number.isFinite(n) ? n : 45); break;
                    }
                    setCfg(room, ff.key, c);
                }
                markDirty();
                refresh();
            });
        });
        el.querySelectorAll('[data-sk]').forEach(inp => {
            const k = inp.getAttribute('data-sk');
            if (inp.tagName === 'INPUT' && inp.type === 'number') {
                inp.addEventListener('input', () => {
                    const n = Number(inp.value);
                    if (!Number.isFinite(n) || n < 0) return;
                    editSkirting(s => {
                        if (k === 'lenMM' && n >= 50) s.lenMM = Math.round(n);
                        else if (k === 'thickMM' && n >= 1) s.thickMM = Math.round(n * 10) / 10;
                        else if (k === 'heightMM' && n >= 10) s.heightMM = Math.round(n);
                        else if (k === 'wastage') s.wastage = Math.min(50, n);
                        else if (k === 'price') s.price = n;
                    }, { commit: false });
                });
            }
            inp.addEventListener('change', () => {
                const v = inp.type === 'checkbox' ? inp.checked : inp.value;
                const n = Number(v);
                editSkirting(s => {
                    if (k === 'enabled') s.enabled = !!v;
                    else if (k === 'type') {
                        const prev = s.type;
                        s.type = v === 'wood' ? 'wood' : 'tile';
                        if (prev !== s.type) {
                            const prevDef = defaultSkirtingCfg(prev);
                            const nextDef = defaultSkirtingCfg(s.type);
                            if (s.lenMM === prevDef.lenMM) s.lenMM = nextDef.lenMM;
                            if (s.thickMM === prevDef.thickMM) s.thickMM = nextDef.thickMM;
                            if (s.heightMM === prevDef.heightMM) s.heightMM = nextDef.heightMM;
                        }
                    }
                    else if (k === 'lenMM') s.lenMM = Math.max(50, Math.round(n) || 800);
                    else if (k === 'thickMM') s.thickMM = Math.max(1, Number.isFinite(n) ? Math.round(n * 10) / 10 : 12);
                    else if (k === 'heightMM') s.heightMM = Math.max(10, Math.round(n) || 100);
                    else if (k === 'wastage') s.wastage = Math.max(0, Math.min(50, Number.isFinite(n) ? n : 5));
                    else if (k === 'price') s.price = Math.max(0, Number.isFinite(n) ? n : W().skirting[s.type === 'wood' ? 'wood' : 'tile'].price);
                    else if (k === 'priceUnit') s.priceUnit = (v === 'piece' || v === 'm') ? v : 'sqm';
                }, { commit: true });
            });
        });
    }

    /* ---- 起铺点拾取 / 拖动 ---- */
    function syncPickCursor() {
        $('elev-canvas')?.classList.toggle('is-picking', !!S.picking);
        // 工具栏按钮高亮与立面拾取状态同步：拾取中高亮「起铺点(O)」，否则高亮当前工具
        const tool = S.active && S.picking ? 'origin' : STATE.tool;
        document.querySelectorAll('.tool-btn').forEach(btn => btn.classList.toggle('active', btn.getAttribute('data-tool') === tool));
    }
    /** 进入 / 退出立面起铺点拾取（左侧「图上拾取」、工具栏「起铺点(O)」、O 键共用） */
    function setPicking(on) {
        if (!S.active || S.picking === !!on) return;
        S.picking = !!on;
        if (!S.picking) S.pickPreview = null;
        syncPickCursor();
        refresh({ calc: false });
        if (S.picking) showToast(S.view === 'unfold' ? '在立面上点按拾取起铺点（自动吸附墙角/洞口），拖动微调' : '在墙面上点按拾取起铺点（自动吸附墙角/洞口），拖动微调');
    }
    /** 屏幕坐标 → 命中墙面及其立面坐标（mm），支持墙角优先吸附与墙边/洞口吸附 */
    function hitFacePoint(sx, sy, slack = 0, allowSnap = true) {
        const room = curRoom();
        const h = S.hits.find(h => sx >= h.x0 - slack && sx <= h.x1 + slack && sy >= h.y0 - slack && sy <= h.y1 + slack);
        if (!room || !h) return null;
        const f = h.f, sc = S.scale, H = roomH(room);
        const rawX = Math.max(0, Math.min(f.lenMM, (sx - S.panX) / sc - h.ox));
        const rawY = Math.max(0, Math.min(H, (S.panY - sy) / sc));
        if (!allowSnap) {
            return { f, x: Math.round(rawX), y: Math.round(rawY), rawX, rawY, snapped: { x: false, y: false }, snapType: null, snapLabel: '' };
        }
        const cornerTol = 16 / sc;
        const edgeTol = 10 / sc;
        const cfg = getCfg(room, f.key);
        const sk = getSkirtingCfg(room, f.key);
        const corners = [
            { x: 0, y: 0, label: '墙角吸附' },
            { x: f.lenMM, y: 0, label: '墙角吸附' },
            { x: 0, y: H, label: '墙角吸附' },
            { x: f.lenMM, y: H, label: '墙角吸附' }
        ];
        const xs = [0, f.lenMM], ys = [0, H];
        for (const o of f.openings) {
            const oy1 = Math.min(H, o.y1);
            xs.push(o.x0, o.x1); ys.push(o.y0, oy1);
            corners.push(
                { x: o.x0, y: o.y0, label: '洞口角点' },
                { x: o.x1, y: o.y0, label: '洞口角点' },
                { x: o.x0, y: oy1, label: '洞口角点' },
                { x: o.x1, y: oy1, label: '洞口角点' }
            );
        }
        if (cfg) {
            const lay = computeFaceLayout(room, f, cfg);
            if (lay) {
                for (const z of lay.zones) {
                    ys.push(z.y0, z.y1);
                    corners.push(
                        { x: 0, y: z.y0, label: '区域墙角' }, { x: f.lenMM, y: z.y0, label: '区域墙角' },
                        { x: 0, y: z.y1, label: '区域墙角' }, { x: f.lenMM, y: z.y1, label: '区域墙角' }
                    );
                }
            }
        }
        if (sk && sk.enabled) {
            const sh = Math.max(10, num(sk.heightMM, 100));
            ys.push(sh);
            corners.push({ x: 0, y: sh, label: '踢脚线角点' }, { x: f.lenMM, y: sh, label: '踢脚线角点' });
        }
        let bestCorner = null, bestDist = cornerTol;
        for (const c of corners) {
            const d = Math.hypot(rawX - c.x, rawY - c.y);
            if (d < bestDist) { bestDist = d; bestCorner = c; }
        }
        if (bestCorner) {
            return {
                f, x: Math.max(0, Math.min(f.lenMM, bestCorner.x)), y: Math.max(0, Math.min(H, bestCorner.y)),
                rawX, rawY, snapped: { x: true, y: true }, snapType: 'corner', snapLabel: bestCorner.label
            };
        }
        const snapped = { x: false, y: false };
        const snapAxis = (v, arr, ax) => {
            let b = null, d = edgeTol;
            for (const a of arr) { const dd = Math.abs(a - v); if (dd < d) { d = dd; b = a; } }
            if (b != null) snapped[ax] = true;
            return b == null ? Math.round(v) : b;
        };
        const x = Math.max(0, Math.min(f.lenMM, snapAxis(rawX, xs, 'x')));
        const y = Math.max(0, Math.min(H, snapAxis(rawY, ys, 'y')));
        let snapType = null, snapLabel = '';
        if (snapped.x && snapped.y) { snapType = 'corner'; snapLabel = '墙角吸附'; }
        else if (snapped.x || snapped.y) { snapType = 'edge'; snapLabel = '墙边吸附'; }
        return { f, x, y, rawX, rawY, snapped, snapType, snapLabel };
    }

    /* ---- 起铺点拖动：砖缝对齐吸附 ----
     * 横缝（Y）：本空间其它已铺贴墙面的横缝高度，用于各墙横缝同高；
     * 竖缝（X）：① 地面砖缝与本墙交线（墙地对缝，仅轴向墙面）；② 相邻墙面在共用墙角处的竖缝向本墙延续（两墙砖宽 + 缝相同时）。
     * 本墙网格是周期性的，“目标缝线 − 本墙缝线相位”对缝距取模即得起铺点平移量。 */
    const wrapPeriod = (d, p) => { if (!(p > 0)) return d; d = ((d % p) + p) % p; return d > p / 2 ? d - p : d; };
    function faceJointLines(lay) {
        const xs = new Set(), ys = new Set(), g = lay.gap / 2;
        for (const z of lay.zones) for (const t of z.tiles) {
            xs.add(Math.round((t.full.x0 - g) * 10) / 10); xs.add(Math.round((t.full.x1 + g) * 10) / 10);
            ys.add(Math.round((t.full.y0 - g) * 10) / 10); ys.add(Math.round((t.full.y1 + g) * 10) / 10);
        }
        return { xs: [...xs].sort((a, b) => a - b), ys: [...ys].sort((a, b) => a - b) };
    }
    /** 拖动开始时收集一次参照缝线（面内坐标 mm） */
    function collectElevGroutRefs(room, f) {
        const faces = getRoomFaces(room);
        const H = roomH(room);
        const my = getCfg(room, f.key);
        const pX = my ? Math.max(20, num(my.tileW, 300)) + Math.max(0, num(my.gap, 1.5)) : 0;
        const ys = [], xs = [];
        const i = faces.findIndex(g => g.key === f.key);
        faces.forEach((g, k) => {
            if (g.key === f.key) return;
            const cfg = getCfg(room, g.key);
            const lay = cfg ? computeFaceLayout(room, g, cfg) : null;
            if (!lay) return;
            const jl = faceJointLines(lay);
            for (const y of jl.ys) if (y > 0.5 && y < H - 0.5) ys.push({ v: y, name: g.label + '墙' });
            // 相邻墙面（展开图中前一面 / 后一面）：砖宽 + 缝相同时，竖缝绕过墙角延续到本墙
            const gp = Math.max(20, num(cfg.tileW, 300)) + Math.max(0, num(cfg.gap, 1.5));
            if (!(pX > 0) || Math.abs(gp - pX) > 0.5 || faces.length < 2) return;
            if (k === (i - 1 + faces.length) % faces.length) {
                for (const x of jl.xs) if (x <= g.lenMM + 0.5 && x >= g.lenMM - pX) xs.push({ v: x - g.lenMM, name: g.label + '墙转角', corner: 'left' });
            }
            if (k === (i + 1) % faces.length) {
                for (const x of jl.xs) if (x >= -0.5 && x <= pX) xs.push({ v: f.lenMM + x, name: g.label + '墙转角', corner: 'right' });
            }
        });
        // 墙地对缝：地面砖缝（非斜铺）与本墙的交线
        try {
            const ux = Math.abs(f.u.x), uy = Math.abs(f.u.y);
            if (!room.cleared && room.pattern !== 'diagonal' && room.computedTiles && room.computedTiles.length && (ux > 0.9999 || uy > 0.9999)
                && typeof createPavingLattice === 'function' && typeof getRoomOriginWorld === 'function') {
                const pv = getRoomPavingPolygonVerts(room);
                const b = pointsBounds(pv);
                const master = typeof getOriginMasterRoom === 'function' ? getOriginMasterRoom(room) : room;
                const G = createPavingLattice(room, getRoomOriginWorld(master), b);
                const alongX = ux > 0.9999;
                const step = alongX ? G.stepX : G.stepY;
                const phases = alongX ? [G.origX - G.jointPx / 2] : [G.origY - G.jointPx / 2];
                if (alongX && room.pattern === 'brick') phases.push(phases[0] + G.stepX / 2);
                if (alongX && room.pattern === 'stagger_369') phases.push(phases[0] + G.stepX / 3, phases[0] + G.stepX * 2 / 3);
                const a0 = alongX ? f.a.x : f.a.y, sgn = alongX ? Math.sign(f.u.x) : Math.sign(f.u.y);
                const lo = Math.min(a0, a0 + sgn * f.lenMM / PX2MM), hi = Math.max(a0, a0 + sgn * f.lenMM / PX2MM);
                if (step > 0) for (const ph of phases) {
                    for (let k = Math.ceil((lo - ph) / step); ph + k * step <= hi && xs.length < 600; k++) {
                        xs.push({ v: (ph + k * step - a0) * sgn * PX2MM, name: '地面砖缝' });
                    }
                }
            }
        } catch (e) { /* 地面网格不可用时仅按墙面吸附 */ }
        return { xs, ys, pX };
    }
    /** 以 (x, y) 为起铺点时的吸附：返回 { dx, dy, guides } 或 null（lockX / lockY = 该轴已吸附到墙端 / 洞口 / 区域边） */
    function snapElevGrout(room, f, x, y, refs, lockX, lockY) {
        const cfg = getCfg(room, f.key);
        if (!cfg || !refs || (lockX && lockY)) return null;
        const tw = Math.max(20, num(cfg.tileW, 300)), th = Math.max(20, num(cfg.tileH, 600)), gap = Math.max(0, num(cfg.gap, 1.5));
        const pX = tw + gap, pY = th + gap;
        const phX = [x - gap / 2], phY = [y - gap / 2];
        if (cfg.pattern === 'brick') phX.push(x - gap / 2 + pX / 2);
        if (cfg.pattern === 'vbrick') phY.push(y - gap / 2 + pY / 2);
        const tol = 6 / Math.max(1e-6, S.scale);   // 屏幕 6 px
        const pick = (targets, phases, step) => {
            let best = null;
            for (const t of targets) for (const ph of phases) {
                const d = wrapPeriod(t.v - ph, step);
                if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, t };
            }
            return best;
        };
        const bx = lockX ? null : pick(refs.xs, phX, pX);
        const by = lockY ? null : pick(refs.ys, phY, pY);
        if (!bx && !by) return null;
        const guides = [];
        if (bx) {
            // 竖向提示线画在本墙上距起铺点最近的那条对齐竖缝处
            const xr = bx.t.corner === 'left' ? (x + bx.d) - gap / 2 + Math.ceil(((gap / 2) - (x + bx.d)) / pX) * pX
                : bx.t.corner === 'right' ? (x + bx.d) - gap / 2 + Math.floor((f.lenMM - (x + bx.d) + gap / 2) / pX) * pX
                : bx.t.v;
            guides.push({ axis: 'x', v: xr, key: f.key, name: bx.t.name });
        }
        if (by) guides.push({ axis: 'y', v: by.t.v, key: f.key, name: by.t.name });
        return { dx: bx ? bx.d : 0, dy: by ? by.d : 0, guides };
    }
    /** 吸附提示线：横缝贯穿整个展开图，竖缝画在本墙上 */
    function drawGroutGuides(c) {
        const gs = S.drag && S.drag.guides;
        if (!gs || !gs.length) return;
        const X = x => S.panX + x * S.scale, Y = y => S.panY - y * S.scale;
        c.save();
        c.strokeStyle = '#356AE6'; c.lineWidth = 1; c.setLineDash([6, 4]);
        c.font = `600 10px ${CANVAS_FONT_SANS}`; c.textBaseline = 'middle'; c.textAlign = 'left';
        for (const g of gs) {
            const h = S.hits.find(q => q.key === g.key);
            if (!h) continue;
            let lx, ly;
            c.beginPath();
            if (g.axis === 'y') {
                const x0 = Math.min(...S.hits.map(q => q.x0)), x1 = Math.max(...S.hits.map(q => q.x1));
                c.moveTo(x0 - 16, Y(g.v)); c.lineTo(x1 + 16, Y(g.v));
                lx = x1 + 20; ly = Y(g.v);
            } else {
                const sx = X(h.ox + g.v);
                c.moveTo(sx, h.y0 - 16); c.lineTo(sx, h.y1 + 16);
                lx = sx + 4; ly = h.y0 - 24;
            }
            c.stroke();
            const label = `砖缝对齐 · ${g.name}`;
            const w = c.measureText(label).width + 8;
            const cw = c.canvas.width / (window.devicePixelRatio || 1);
            lx = Math.max(4, Math.min(lx, cw - w - 4)); ly = Math.max(12, ly);
            c.setLineDash([]);
            c.fillStyle = 'rgba(255,255,255,0.95)'; c.fillRect(lx, ly - 8, w, 16);
            c.strokeRect(lx, ly - 8, w, 16);
            c.fillStyle = '#1e3a8a'; c.fillText(label, lx + 4, ly);
            c.setLineDash([6, 4]);
        }
        c.restore();
    }
    /** 拖动 / 拾取中设置起铺点：先按墙角 / 墙端 / 洞口吸附，未吸附的轴再按砖缝对齐吸附（按住 Alt 暂停） */
    function dragOriginTo(q, alt) {
        const room = curRoom();
        const d = S.drag;
        let x = q.x, y = q.y;
        d.guides = null;
        if (!alt) {
            if (!d.refs || d.refsKey !== q.f.key) { d.refs = collectElevGroutRefs(room, q.f); d.refsKey = q.f.key; }
            if (!getCfg(room, q.f.key)) setOriginAt(q.f, x, y, false);
            const gs = snapElevGrout(room, q.f, x, y, d.refs, q.snapped && q.snapped.x, q.snapped && q.snapped.y);
            if (gs) { x += gs.dx; y += gs.dy; d.guides = gs.guides; }
        }
        setOriginAt(q.f, x, y, false);
        S.pickPreview = {
            f: q.f, rawX: q.rawX ?? q.x, rawY: q.rawY ?? q.y, x, y,
            snapType: q.snapType || (d.guides?.length ? 'grout' : null),
            snapLabel: q.snapLabel || (d.guides?.length ? '砖缝对齐' : '')
        };
    }
    function setOriginAt(f, x, y, history = true) {
        const room = curRoom();
        if (history) saveHistory();
        const c = getCfg(room, f.key) || seedCfg(room, getRoomFaces(room));
        c.origin = { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
        setCfg(room, f.key, c);
        markDirty();
    }

    /**
     * 立面模式下的「清空」：当选中单墙时仅清空该墙面，否则清空当前显示作用域的铺贴与踢脚线
     */
    function clearCanvas() {
        const room = curRoom();
        if (!room) return;
        const faces = getRoomFaces(room);
        const { f, all } = getScopeState(room, faces);
        const scopeFaces = all ? viewFaces(room).map(it => it.f) : (f ? [f] : []);
        const activeFaces = scopeFaces.filter(ff => getCfg(room, ff.key) || getSkirtingCfg(room, ff.key).enabled);
        if (!activeFaces.length) { showToast('当前范围没有墙面铺贴或踢脚线'); return; }
        saveHistory();
        for (const ff of activeFaces) {
            setCfg(room, ff.key, null);
            setSkirtingCfg(room, ff.key, null);
        }
        S.picking = false; S.pickPreview = null; S.drag = null; syncPickCursor();
        markDirty();
        refresh();
        showToast(`已清空${S.view === 'single' ? `「${room.name}」${shown[0].label}墙` : `「${room.name}」全部 ${shown.length} 面墙`}的铺贴 · Ctrl+Z 可撤销`);
    }

    /* ---- 立面画布 ---- */
    function resizeElev() {
        const cv = $('elev-canvas');
        if (!cv || !cv.parentElement) return false;
        const box = cv.parentElement.getBoundingClientRect();
        if (box.width < 40 || box.height < 40) return false;
        const dpr = window.devicePixelRatio || 1;
        const w = Math.round(box.width * dpr), h = Math.round(box.height * dpr);
        if (cv.width !== w || cv.height !== h) {
            cv.width = w;
            cv.height = h;
            cv.style.width = box.width + 'px';
            cv.style.height = box.height + 'px';
            return true;
        }
        return false;
    }

    /** 当前视图需要绘制的面：单面 = 当前面；展开 = 全部面依次相接 */
    function viewFaces(room) {
        const faces = getRoomFaces(room);
        if (S.view === 'single') { const f = faces.find(x => x.key === S.faceKey); return f ? [{ f, ox: 0 }] : []; }
        let ox = 0;
        return faces.map(f => { const it = { f, ox }; ox += f.lenMM; return it; });
    }

    function fitElev() {
        const room = curRoom();
        const cv = $('elev-canvas');
        if (!room || !cv) return;
        const dpr = window.devicePixelRatio || 1;
        const W = cv.width / dpr, Hh = cv.height / dpr;
        if (W < 40 || Hh < 40) return;
        const items = viewFaces(room);
        const L = items.reduce((s, it) => Math.max(s, it.ox + it.f.lenMM), 0) || 1000;
        const H = roomH(room);
        const mL = 90, mR = 90, mT = 70, mB = 90;
        S.scale = Math.max(0.02, Math.min((W - mL - mR) / L, (Hh - mT - mB) / H));
        S.panX = mL + ((W - mL - mR) - L * S.scale) / 2;
        S.panY = mT + ((Hh - mT - mB) + H * S.scale) / 2;
        S.needFit = false;
        updateZoomTextElev();
    }
    function zoomBy(factor, cx, cy) {
        const cv = $('elev-canvas');
        const dpr = window.devicePixelRatio || 1;
        if (cx == null) { cx = cv.width / dpr / 2; cy = cv.height / dpr / 2; }
        const ns = Math.max(0.01, Math.min(5, S.scale * factor));
        const k = ns / S.scale;
        S.panX = cx - (cx - S.panX) * k;
        S.panY = cy - (cy - S.panY) * k;
        S.scale = ns;
        updateZoomTextElev();
        drawElev();
    }
    function updateZoomTextElev() {
        const t = $('zoom-level-text');
        if (t) t.textContent = `1:${Math.max(1, Math.round(1 / (S.scale * 0.264583)))}`;
    }

    function drawElev() {
        const cv = $('elev-canvas');
        const room = curRoom();
        if (!cv || !room) return;
        if (resizeElev()) S.needFit = true;
        const dpr = window.devicePixelRatio || 1;
        if (cv.width / dpr < 40 || cv.height / dpr < 40) return;
        if (S.needFit) fitElev();
        forEachWallZone(() => {});   // 先算好全部墙面，编号才能跨墙连续
        ensureNumbers();
        const c = cv.getContext('2d');
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        const W = cv.width / dpr, Hh = cv.height / dpr;
        c.fillStyle = '#ffffff';
        c.fillRect(0, 0, W, Hh);
        const H = roomH(room);
        const sc = S.scale;
        const X = x => S.panX + x * sc, Y = y => S.panY - y * sc;
        if (STATE.showGrid !== false) {
            const stepMM = sc >= 0.12 ? 500 : 1000;
            const stepPx = stepMM * sc;
            if (stepPx >= 10) {
                const startX = ((S.panX % stepPx) + stepPx) % stepPx;
                const startY = ((S.panY % stepPx) + stepPx) % stepPx;
                c.save();
                c.strokeStyle = 'rgba(226, 232, 240, 0.72)';
                c.lineWidth = 1;
                c.beginPath();
                for (let gx = startX; gx < W; gx += stepPx) { c.moveTo(gx, 0); c.lineTo(gx, Hh); }
                for (let gy = startY; gy < Hh; gy += stepPx) { c.moveTo(0, gy); c.lineTo(W, gy); }
                c.stroke();
                c.restore();
            }
        }
        S.hits = [];
        const items = viewFaces(room);
        const totalL = items.reduce((s, it) => Math.max(s, it.ox + it.f.lenMM), 0);

        // 地面线 / 吊顶线（文本标签放左侧，竖向尺寸放右侧）
        c.strokeStyle = '#334155'; c.lineWidth = 2;
        c.beginPath(); c.moveTo(X(0) - 60, Y(0)); c.lineTo(X(totalL) + 30, Y(0)); c.stroke();
        c.save(); c.setLineDash([6, 4]); c.strokeStyle = '#94a3b8'; c.lineWidth = 1;
        c.beginPath(); c.moveTo(X(0) - 60, Y(H)); c.lineTo(X(totalL) + 30, Y(H)); c.stroke(); c.restore();
        if (STATE.showDimensions !== false) {
            c.font = `11px ${CANVAS_FONT_SANS}`; c.fillStyle = '#64748b'; c.textAlign = 'right'; c.textBaseline = 'bottom';
            c.fillText(`吊顶 ${Units.dim(H)}`, X(0) - 6, Y(H) - 2);
            c.fillText('地面 ±0', X(0) - 6, Y(0) - 2);
        }

        for (const { f, ox } of items) {
            const cfg = getCfg(room, f.key);
            const sk = getSkirtingCfg(room, f.key);
            const lay = cfg ? computeFaceLayout(room, f, cfg) : null;
            const fx = x => X(ox + x);
            const isCur = f.key === S.faceKey;
            // 墙面底色
            c.fillStyle = '#f8fafc';
            c.fillRect(fx(0), Y(H), f.lenMM * sc, H * sc);
            if (lay && STATE.showPaving !== false) drawFaceTiles(c, f, lay, fx, Y, sc);
            if (sk && sk.enabled && STATE.showPaving !== false) drawFaceSkirting(c, f, sk, fx, Y, sc, H);
            // 洞口
            for (const o of f.openings) drawOpeningElev(c, o, fx, Y, sc, H);
            // 墙面外框
            c.strokeStyle = isCur && S.view === 'unfold' ? '#356AE6' : '#475569';
            c.lineWidth = isCur && S.view === 'unfold' ? 2 : 1.2;
            c.strokeRect(fx(0), Y(H), f.lenMM * sc, H * sc);
            if (S.picking || S.drag) {
                const cPts = [[0, 0], [f.lenMM, 0], [0, H], [f.lenMM, H]];
                for (const o of f.openings) cPts.push([o.x0, o.y0], [o.x1, o.y0], [o.x0, Math.min(H, o.y1)], [o.x1, Math.min(H, o.y1)]);
                c.save();
                c.fillStyle = 'rgba(22, 163, 74, 0.16)';
                c.strokeStyle = 'rgba(22, 163, 74, 0.72)';
                c.lineWidth = 1;
                for (const [cxp, cyp] of cPts) {
                    c.beginPath(); c.arc(fx(cxp), Y(cyp), 4.2, 0, Math.PI * 2); c.fill(); c.stroke();
                }
                c.restore();
            }
            // 面标签
            if (STATE.showRoomLabels !== false) {
                c.font = `600 13px ${CANVAS_FONT_SANS}`; c.textAlign = 'center'; c.textBaseline = 'bottom';
                c.fillStyle = isCur ? '#356AE6' : '#334155';
                c.fillText(`${f.label}墙${lay ? '' : '（未铺贴）'}`, fx(f.lenMM / 2), Y(H) - 26);
            }
            S.hits.push({ key: f.key, f, ox, x0: fx(0), x1: fx(f.lenMM), y0: Y(H), y1: Y(0) });
            const org = validOrigin(cfg);
            if (org && (STATE.showOrigins || S.picking || S.drag)) drawOriginMark(c, fx(org.x), Y(org.y));
            if (STATE.showDimensions !== false) {
                // 尺寸：墙长 + 洞口定位
                dimH(c, fx(0), fx(f.lenMM), Y(0) + 44, Units.dim(f.lenMM));
                if (f.openings.length) {
                    const stops = [0];
                    for (const o of f.openings) stops.push(o.x0, o.x1);
                    stops.push(f.lenMM);
                    for (let i = 0; i < stops.length - 1; i++) {
                        const a = stops[i], b = stops[i + 1];
                        if (b - a > 1) dimH(c, fx(a), fx(b), Y(0) + 22, Units.dim(b - a), true);
                    }
                }
                if (S.view === 'single') {
                    // 竖向尺寸链（右侧）：离底 / 铺贴区 / 离顶 + 总高
                    const xrBase = fx(f.lenMM);
                    const ys = [0];
                    if (lay) { for (const z of lay.zones) ys.push(z.y0, z.y1); }
                    ys.push(H);
                    const uniq = [...new Set(ys.map(v => Math.round(v)))].sort((p, q) => p - q);
                    for (let i = 0; i < uniq.length - 1; i++) dimV(c, xrBase + 22, Y(uniq[i]), Y(uniq[i + 1]), Units.dim(uniq[i + 1] - uniq[i]), true);
                    dimV(c, xrBase + 46, Y(0), Y(H), Units.dim(H));
                    // 洞口高度标注
                    for (const o of f.openings) {
                        const xr = fx(o.x1) + 10;
                        if (o.y0 > 1) dimV(c, xr, Y(0), Y(o.y0), Units.dim(o.y0), true);
                        dimV(c, xr, Y(o.y0), Y(Math.min(H, o.y1)), Units.dim(o.y1 - o.y0), true);
                    }
                }
            }
        }
        if (S.view === 'unfold' && STATE.showDimensions !== false) {
            dimH(c, X(0), X(totalL), Y(0) + 66, `展开总长 ${Units.dim(totalL)}`);
            dimV(c, X(totalL) + 22, Y(0), Y(H), Units.dim(H));
        }
        drawGroutGuides(c);
        if (S.pickPreview) drawOriginSnapPreview(c, S.pickPreview);
    }

    function drawFaceSkirting(c, f, sk, fx, Y, sc, H) {
        const sh = Math.min(H, Math.max(10, num(sk.heightMM, 100)));
        const slen = Math.max(50, num(sk.lenMM, sk.type === 'wood' ? 2400 : 800));
        const holes = (f.openings || []).filter(o => o.y0 < sh - 1)
            .map(o => [Math.max(0, o.x0), Math.min(f.lenMM, o.x1)]).filter(s => s[1] > s[0])
            .sort((a, b) => a[0] - b[0]);
        const segs = [];
        let cx = 0;
        for (const [a, b] of holes) {
            if (a > cx) segs.push([cx, a]);
            cx = Math.max(cx, b);
        }
        if (cx < f.lenMM) segs.push([cx, f.lenMM]);
        const isWood = sk.type === 'wood';
        c.save();
        for (const [a, b] of segs) {
            const x0 = fx(a), y0 = Y(sh), w = (b - a) * sc, h = sh * sc;
            c.fillStyle = isWood ? 'rgba(214, 184, 148, 0.88)' : 'rgba(219, 234, 254, 0.85)';
            c.fillRect(x0, y0, w, h);
            c.strokeStyle = isWood ? '#785237' : '#2563eb';
            c.lineWidth = 1.2;
            c.strokeRect(x0, y0, w, h);
            // 分块接缝刻度
            c.beginPath();
            for (let x = a + slen; x < b - 2; x += slen) {
                const sx = fx(x);
                c.moveTo(sx, y0); c.lineTo(sx, y0 + h);
            }
            c.strokeStyle = isWood ? 'rgba(120, 82, 55, 0.45)' : 'rgba(37, 99, 235, 0.45)';
            c.lineWidth = 0.8;
            c.stroke();
            if (w > 78 && h >= 10) {
                c.font = `600 9px ${CANVAS_FONT_SANS}`;
                c.fillStyle = isWood ? '#57361f' : '#1e40af';
                c.textAlign = 'center'; c.textBaseline = 'middle';
                c.fillText(`踢脚线 ${Units.dim(sh)}`, x0 + w / 2, y0 + h / 2);
            }
        }
        c.restore();
    }

    function drawOriginSnapPreview(c, pv) {
        if (!pv || !pv.f) return;
        const h = S.hits.find(q => q.key === pv.f.key);
        if (!h) return;
        const sx = S.panX + (h.ox + pv.x) * S.scale, sy = S.panY - pv.y * S.scale;
        const rx = S.panX + (h.ox + pv.rawX) * S.scale, ry = S.panY - pv.rawY * S.scale;
        const isCorner = pv.snapType === 'corner';
        const isEdge = pv.snapType === 'edge';
        const color = isCorner ? '#16a34a' : (isEdge ? '#0891b2' : '#356AE6');
        c.save();
        if (pv.snapType && Math.hypot(rx - sx, ry - sy) > 2) {
            c.strokeStyle = color;
            c.lineWidth = 1.2;
            c.setLineDash([4, 3]);
            c.beginPath(); c.moveTo(rx, ry); c.lineTo(sx, sy); c.stroke();
            c.setLineDash([]);
        }
        if (isCorner) {
            c.fillStyle = 'rgba(22, 163, 74, 0.22)';
            c.beginPath(); c.arc(sx, sy, 10, 0, Math.PI * 2); c.fill();
            c.save();
            c.translate(sx, sy); c.rotate(Math.PI / 4);
            c.fillStyle = '#16a34a'; c.strokeStyle = '#ffffff'; c.lineWidth = 1.6;
            c.fillRect(-5, -5, 10, 10); c.strokeRect(-5, -5, 10, 10);
            c.restore();
        } else if (isEdge) {
            c.fillStyle = '#0891b2'; c.strokeStyle = '#ffffff'; c.lineWidth = 1.6;
            c.beginPath(); c.arc(sx, sy, 5, 0, Math.PI * 2); c.fill(); c.stroke();
        } else {
            c.strokeStyle = '#356AE6'; c.lineWidth = 1.4;
            c.beginPath(); c.moveTo(sx - 9, sy); c.lineTo(sx + 9, sy); c.moveTo(sx, sy - 9); c.lineTo(sx, sy + 9); c.stroke();
            c.beginPath(); c.arc(sx, sy, 3.5, 0, Math.PI * 2); c.fillStyle = '#ffffff'; c.fill(); c.stroke();
        }
        const label = pv.snapLabel || `(${Units.dim(pv.x)}, ${Units.dim(pv.y)})`;
        c.font = `600 10.5px ${CANVAS_FONT_SANS}`;
        const tw = c.measureText(label).width;
        const pw = tw + 12, ph = 18;
        const cw = c.canvas.width / (window.devicePixelRatio || 1);
        const px = Math.max(6, Math.min(cw - pw - 6, sx + 12));
        const py = Math.max(22, sy - 10);
        c.fillStyle = 'rgba(15, 23, 42, 0.88)';
        c.beginPath(); c.roundRect(px, py - ph, pw, ph, 4); c.fill();
        c.fillStyle = isCorner ? '#bbf7d0' : (isEdge ? '#cffafe' : '#e2e8f0');
        c.textAlign = 'left'; c.textBaseline = 'middle';
        c.fillText(label, px + 6, py - ph / 2);
        c.restore();
    }

    function drawOriginMark(c, x, y) {
        c.save();
        c.strokeStyle = '#dc2626'; c.lineWidth = 1.6;
        c.beginPath(); c.moveTo(x - 11, y); c.lineTo(x + 11, y); c.moveTo(x, y - 11); c.lineTo(x, y + 11); c.stroke();
        c.beginPath(); c.arc(x, y, 4.5, 0, Math.PI * 2); c.fillStyle = '#ffffff'; c.fill(); c.stroke();
        c.font = `500 10px ${CANVAS_FONT_SANS}`; c.fillStyle = '#b91c1c'; c.textAlign = 'left'; c.textBaseline = 'bottom';
        c.fillText('起铺点', x + 7, y - 5);
        c.restore();
    }

    function drawFaceTiles(c, f, lay, fx, Y, sc) {
        const gapPx = Math.max(1, lay.gap * sc);
        const trace = (loop) => { loop.forEach((p, i) => i ? c.lineTo(fx(p.x), Y(p.y)) : c.moveTo(fx(p.x), Y(p.y))); c.closePath(); };
        for (const z of lay.zones) {
            const st = styleOf(z.spec.styleId);
            for (const t of z.tiles) {
                c.save();
                c.beginPath();
                for (const loop of t.polys) trace(loop);
                c.fillStyle = st.base;
                c.fill('evenodd');
                if (st.img) {
                    c.clip('evenodd');
                    c.drawImage(st.img, fx(t.full.x0), Y(t.full.y1), (t.full.x1 - t.full.x0) * sc, (t.full.y1 - t.full.y0) * sc);
                }
                if (STATE.showTileMarks) {
                    const mk = tileMarkColor(t.category);
                    if (mk.fill) { c.fillStyle = mk.fill; c.fill('evenodd'); }
                }
                c.restore();
                c.beginPath();
                for (const loop of t.polys) trace(loop);
                c.strokeStyle = STATE.showTileMarks ? tileMarkColor(t.category).stroke : 'rgba(100, 116, 139, 0.8)';
                c.lineWidth = gapPx;
                c.stroke();
                // 砖号
                const bw = t.bw * sc, bh = t.bh * sc;
                if (STATE.showTileMarks && Math.min(bw, bh) > 18) {
                    const cx = fx((t.full.x0 + t.full.x1) / 2), cy = Y((t.full.y0 + t.full.y1) / 2);
                    const bx0 = fx(Math.max(t.full.x0, 0)), bx1 = fx(Math.min(t.full.x1, lay.L));
                    const px = Math.min(Math.max(cx, bx0 + 10), bx1 - 10);
                    c.font = `500 ${Math.max(8, Math.min(11, Math.min(bw, bh) * 0.3))}px ${CANVAS_FONT_MONO}`;
                    c.textAlign = 'center'; c.textBaseline = 'middle';
                    c.lineWidth = 2.2; c.strokeStyle = 'rgba(255,255,255,0.8)';
                    const tyc = Math.min(Math.max(cy, Y(z.y1) + 8), Y(z.y0) - 8);
                    c.strokeText(t.id, px, tyc);
                    c.fillStyle = tileMarkColor(t.category).label;
                    c.fillText(t.id, px, tyc);
                }
            }
        }
        // 未铺贴区（离底、离顶）斜线示意
        const zs = lay.zones;
        const hatch = (y0, y1) => {
            if (y1 - y0 < 1) return;
            c.save();
            c.beginPath(); c.rect(fx(0), Y(y1), lay.L * sc, (y1 - y0) * sc); c.clip();
            c.strokeStyle = 'rgba(148, 163, 184, 0.45)'; c.lineWidth = 1;
            const x0 = fx(0), x1 = fx(lay.L), yt = Y(y1), yb = Y(y0);
            for (let x = x0 - (yb - yt); x < x1; x += 8) { c.beginPath(); c.moveTo(x, yb); c.lineTo(x + (yb - yt), yt); c.stroke(); }
            c.restore();
        };
        if (zs.length) { hatch(0, zs[0].y0); hatch(zs[zs.length - 1].y1, lay.H); }
    }

    function drawOpeningElev(c, o, fx, Y, sc, H) {
        const x0 = fx(o.x0), x1 = fx(o.x1), yb = Y(o.y0), yt = Y(Math.min(H, o.y1));
        c.fillStyle = o.type === 'window' ? '#e0f2fe' : '#ffffff';
        c.fillRect(x0, yt, x1 - x0, yb - yt);
        c.strokeStyle = o.type === 'window' ? '#0284c7' : '#92400e';
        c.lineWidth = 1.4;
        c.strokeRect(x0, yt, x1 - x0, yb - yt);
        c.lineWidth = 0.8;
        c.beginPath();
        if (o.type === 'window') {
            c.moveTo((x0 + x1) / 2, yt); c.lineTo((x0 + x1) / 2, yb);
            c.moveTo(x0, (yt + yb) / 2); c.lineTo(x1, (yt + yb) / 2);
        } else if (STATE.showDoorLeaves !== false) {
            // 立面门开启线（铰链侧顶点指向门把手侧）
            const hingeRight = !!o.op.hinge;
            const hx = hingeRight ? x1 : x0, ox = hingeRight ? x0 : x1;
            c.setLineDash([5, 3]);
            c.moveTo(hx, yt); c.lineTo(ox, (yt + yb) / 2); c.lineTo(hx, yb);
        }
        c.stroke();
        c.setLineDash([]);
        c.font = `11px ${CANVAS_FONT_SANS}`; c.fillStyle = o.type === 'window' ? '#0369a1' : '#78350f';
        c.textAlign = 'center'; c.textBaseline = 'top';
        c.fillText(`${o.type === 'window' ? '窗' : '门'} ${Units.dim(o.x1 - o.x0)}×${Units.dim(o.y1 - o.y0)}`, (x0 + x1) / 2, yt + 4);
    }

    function dimH(c, x0, x1, y, text, small = false) {
        if (Math.abs(x1 - x0) < 4) return;
        c.strokeStyle = '#2F8F6B'; c.lineWidth = 0.8;
        c.beginPath(); c.moveTo(x0, y); c.lineTo(x1, y);
        c.moveTo(x0, y - 4); c.lineTo(x0, y + 4); c.moveTo(x1, y - 4); c.lineTo(x1, y + 4);
        c.moveTo(x0 - 3, y + 3); c.lineTo(x0 + 3, y - 3); c.moveTo(x1 - 3, y + 3); c.lineTo(x1 + 3, y - 3);
        c.stroke();
        c.font = `${small ? 10 : 11}px ${CANVAS_FONT_MONO}`; c.fillStyle = '#22684F'; c.textAlign = 'center'; c.textBaseline = 'bottom';
        if (c.measureText(text).width < Math.abs(x1 - x0) + 30) c.fillText(text, (x0 + x1) / 2, y - 2);
    }
    function dimV(c, x, y0, y1, text, small = false) {
        if (Math.abs(y1 - y0) < 4) return;
        c.strokeStyle = '#2F8F6B'; c.lineWidth = 0.8;
        c.beginPath(); c.moveTo(x, y0); c.lineTo(x, y1);
        c.moveTo(x - 4, y0); c.lineTo(x + 4, y0); c.moveTo(x - 4, y1); c.lineTo(x + 4, y1);
        c.moveTo(x - 3, y0 + 3); c.lineTo(x + 3, y0 - 3); c.moveTo(x - 3, y1 + 3); c.lineTo(x + 3, y1 - 3);
        c.stroke();
        c.save();
        c.translate(x - 3, (y0 + y1) / 2); c.rotate(-Math.PI / 2);
        c.font = `${small ? 10 : 11}px ${CANVAS_FONT_MONO}`; c.fillStyle = '#22684F'; c.textAlign = 'center'; c.textBaseline = 'bottom';
        if (c.measureText(text).width < Math.abs(y1 - y0) + 20) c.fillText(text, 0, 0);
        c.restore();
    }

    function bindElevCanvas() {
        const cv = $('elev-canvas');
        let drag = null;
        // 鼠标操作与平面画布一致：滚轮缩放（同一步长）；中键拖动 / 按住空格左键拖动 / 平移工具(H) 左键拖动 = 平移；
        // 左键单击 = 选择墙面 / 拾取起铺点，左键拖动起铺点 = 移动起铺点；右键不弹菜单
        const wantsPan = e => e.button === 1 || (e.button === 0 && (STATE.isSpacePressed || STATE.tool === 'pan'));
        const idleCursor = () => { cv.style.cursor = S.picking ? '' : (STATE.isSpacePressed || STATE.tool === 'pan') ? 'grab' : ''; };
        cv.addEventListener('wheel', e => {
            e.preventDefault();
            const r = cv.getBoundingClientRect();
            zoomBy(e.deltaY < 0 ? 1.12 : 0.89, e.clientX - r.left, e.clientY - r.top);
        }, { passive: false });
        cv.addEventListener('contextmenu', e => e.preventDefault());
        const local = e => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
        cv.addEventListener('mousedown', e => {
            if (wantsPan(e)) {
                e.preventDefault();
                drag = { x: e.clientX, y: e.clientY, px: S.panX, py: S.panY, moved: true, pan: true };
                cv.style.cursor = 'grabbing';
                return;
            }
            if (e.button !== 0) return;
            const p = local(e);
            // 拾取起铺点：按下即设置，按住拖动实时预览铺贴，松开确定
            if (S.picking) {
                const q = hitFacePoint(p.x, p.y, 12, !e.altKey);
                if (!q) { showToast('请在墙面范围内按下鼠标'); return; }
                const h = S.hits.find(x => x.key === q.f.key);
                saveHistory();
                setOriginAt(q.f, q.x, q.y, false);
                S.drag = { hit: h, picking: true };
                dragOriginTo(q, e.altKey);
                drawElev();
                return;
            }
            // 拖动已有起铺点
            {
                const room = curRoom();
                for (const h of S.hits) {
                    const org = validOrigin(getCfg(room, h.f.key));
                    if (!org) continue;
                    const ox = S.panX + (h.ox + org.x) * S.scale, oy = S.panY - org.y * S.scale;
                    if (Math.hypot(p.x - ox, p.y - oy) <= 9) { saveHistory(); S.drag = { hit: h }; cv.classList.add('is-picking'); return; }
                }
            }
            drag = { x: e.clientX, y: e.clientY, moved: false, pan: false };
        });
        cv.addEventListener('mouseleave', () => {
            if (S.pickPreview && !S.drag) { S.pickPreview = null; drawElev(); }
        });
        window.addEventListener('mousemove', e => {
            if (S.drag) {
                const p = local(e);
                const h = S.drag.hit;
                const q = hitFacePoint(Math.max(h.x0, Math.min(h.x1, p.x)), Math.max(h.y0, Math.min(h.y1, p.y)), 0, !e.altKey);
                if (q && q.f.key === h.f.key) { dragOriginTo(q, e.altKey); drawElev(); }
                return;
            }
            if (S.active && S.picking && !drag) {
                const p = local(e);
                const q = hitFacePoint(p.x, p.y, 12, !e.altKey);
                S.pickPreview = q ? { f: q.f, rawX: q.rawX, rawY: q.rawY, x: q.x, y: q.y, snapType: q.snapType, snapLabel: q.snapLabel } : null;
                drawElev();
                return;
            }
            if (!drag) { if (S.active && e.target === cv) idleCursor(); return; }
            const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
            if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
            if (!drag.pan) return;
            S.panX = drag.px + dx; S.panY = drag.py + dy;
            drawElev();
        });
        window.addEventListener('mouseup', e => {
            if (S.drag) {
                const d = S.drag;
                S.drag = null;
                S.pickPreview = null;
                if (d.picking) {
                    S.picking = false;
                    if (S.view === 'single') S.faceKey = d.hit.key;
                    const org = validOrigin(getCfg(curRoom(), d.hit.key));
                    if (org) showToast(`${d.hit.f.label}墙起铺点：距左 ${Units.text(org.x)}，离地 ${Units.text(org.y)}`);
                }
                syncPickCursor(); refresh();
                return;
            }
            if (!drag) return;
            const d = drag; drag = null;
            if (d.pan) { idleCursor(); return; }
            if (d.moved || !S.active) return;
            const p = local(e);
            const hit = S.hits.find(h => p.x >= h.x0 && p.x <= h.x1 && p.y >= h.y0 - 30 && p.y <= h.y1);
            if (hit) {
                if (hit.key !== S.faceKey) { S.faceKey = hit.key; refresh({ calc: false }); }
            } else if (S.view === 'unfold' && S.faceKey) {
                S.faceKey = null; refresh({ calc: false });
            }
        });
        cv.addEventListener('dblclick', e => {
            if (S.view !== 'unfold') return;
            const r = cv.getBoundingClientRect();
            const x = e.clientX - r.left, y = e.clientY - r.top;
            const hit = S.hits.find(h => x >= h.x0 && x <= h.x1 && y >= h.y0 - 30 && y <= h.y1);
            if (hit) { S.faceKey = hit.key; S.view = 'single'; S.needFit = true; refresh({ calc: false }); }
        });
        $('elev-tabs')?.addEventListener('wheel', e => {
            const box = e.currentTarget;
            if (box.scrollWidth > box.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
                box.scrollLeft += e.deltaY;
                e.preventDefault();
            }
        }, { passive: false });
        $('elev-tabs')?.addEventListener('click', e => {
            const b = e.target.closest('[data-face]');
            if (!b) return;
            const k = b.getAttribute('data-face');
            if (k === '__unfold') { S.view = 'unfold'; S.faceKey = null; } else { S.view = 'single'; S.faceKey = k; }
            S.needFit = true;
            refresh({ calc: false });
        });
        const boxEl = cv.parentElement || $('elev-view');
        if (boxEl) new ResizeObserver(() => { if (S.active && resizeElev()) { S.needFit = true; drawElev(); } }).observe(boxEl);
    }

    /* ===================== 算量面板：全部 / 地面 / 墙面切换汇总 ===================== */
    function setCalcMode(mode) {
        STATE.calcMode = (mode === 'floor' || mode === 'wall') ? mode : 'all';
        document.querySelectorAll('[data-calc-mode]').forEach(b => {
            b.classList.toggle('is-active', b.getAttribute('data-calc-mode') === STATE.calcMode);
        });
        renderCalculationResults();
    }

    function setLabel(id, text) { const el = $(id); if (el) el.textContent = text; }

    function renderWallResults() {
        renderCalculationResults();
    }

    function restoreFloorLabels() {
        setLabel('res-total-area-label', '铺贴总面积');
        setLabel('detail-col-room', '空间 / 部位');
        setLabel('res-grout-or-joint-label', '美缝用量');
    }

    /* ===================== 左侧属性：层高 / 吊顶 / 门窗高度 ===================== */
    function syncFloorInputs() {
        const el = $('floor-height-input');
        if (el && document.activeElement !== el) el.value = floorH();
        const lbl = $('floor-height-label');
        if (lbl) lbl.textContent = STATE.floorsEnabled ? `层高 · ${getCurrentFloor()?.name || '1F'}` : '层高';
    }
    function syncRoomInputs(room) {
        const el = $('room-ceiling-input');
        if (!el) return;
        el.placeholder = `同层高 ${Units.dim(floorH())}`;
        if (document.activeElement !== el) el.value = room && num(room.ceilingMM, 0) > 0 ? room.ceilingMM : '';
    }
    function syncOpeningInputs(op) {
        const h = $('opening-height-input'), s = $('opening-sill-input'), sb = $('opening-sill-block');
        if (!h) return;
        if (document.activeElement !== h) h.value = opHeight(op);
        if (sb) sb.classList.toggle('hidden', op.type !== 'window');
        if (s && document.activeElement !== s) s.value = opSill(op);
    }
    function bindPropertyInputs() {
        const onFloorH = (e, isCommit) => {
            const v = Math.round(Number(e.target.value));
            if (!(v >= 1500 && v <= 10000)) {
                if (isCommit) { syncFloorInputs(); showToast(`层高范围 ${Units.text(1500)} ~ ${Units.text(10000)}`); }
                return;
            }
            if (isCommit) saveHistory();
            STATE.floorHeightMM = v; markDirty();
            syncRoomInputs(getSelectedRoom()); refresh();
        };
        $('floor-height-input')?.addEventListener('input', e => onFloorH(e, false));
        $('floor-height-input')?.addEventListener('change', e => onFloorH(e, true));

        const onCeilingH = (e, isCommit) => {
            const room = getSelectedRoom();
            if (!room) return;
            const raw = String(e.target.value || '').trim();
            const v = Math.round(Number(raw));
            if (raw !== '' && !(v >= 1500 && v <= 10000) && !isCommit) return;
            if (isCommit) saveHistory();
            room.ceilingMM = v > 0 ? Math.min(10000, Math.max(1500, v)) : null; markDirty();
            if (isCommit) syncRoomInputs(room);
            refresh();
        };
        $('room-ceiling-input')?.addEventListener('input', e => onCeilingH(e, false));
        $('room-ceiling-input')?.addEventListener('change', e => onCeilingH(e, true));

        const opEdit = (fn, isCommit) => {
            const op = STATE.selected?.type === 'opening' && STATE.openings.find(o => o.id === STATE.selected.id);
            if (!op) return;
            if (isCommit) saveHistory();
            fn(op); markDirty();
            if (isCommit) syncOpeningInputs(op);
            refresh();
        };
        $('opening-height-input')?.addEventListener('input', e => {
            const v = Math.round(Number(e.target.value));
            if (v >= 200 && v <= 6000) opEdit(op => { op.heightMM = v; }, false);
        });
        $('opening-height-input')?.addEventListener('change', e => opEdit(op => {
            const v = Math.round(Number(e.target.value));
            op.heightMM = v > 0 ? Math.max(200, Math.min(6000, v)) : null;
        }, true));
        $('opening-sill-input')?.addEventListener('input', e => {
            const v = Math.round(Number(e.target.value));
            if (Number.isFinite(v) && v >= 0 && v <= 5000) opEdit(op => { op.sillMM = v; }, false);
        });
        $('opening-sill-input')?.addEventListener('change', e => opEdit(op => {
            const v = Math.round(Number(e.target.value));
            op.sillMM = Number.isFinite(v) ? Math.max(0, Math.min(5000, v)) : null;
        }, true));
    }

    /* ===================== CAD / PDF 立面排砖图 ===================== */
    const roomsWithWallTiling = () => STATE.rooms.filter(r => !r.cleared && getRoomPolygonVerts(r).length >= 3 && hasAnyWallTiling(r));

    /* ===================== CAD 施工图（分区索引图混排 · 无框 · 防溢出分页 · 离地/离顶标注） ===================== */
    const ELEV_CAD = {
        LEFT_DIM_PAD: 460,
        RIGHT_EXT_PAD: 180,
        KEY_EDGE_PAD: 80,
        WALL_GAP_MIN: 620,
        TOP_PAD: 360,
        BOT_PAD: 340,
        ROW_AIR: 240,
        K_MIN: 0.96,
        K_MAX: 2.60
    };

    function measureEmSafe(str) {
        if (typeof ChineseFontEngine !== 'undefined' && ChineseFontEngine.measureTextEm) {
            return ChineseFontEngine.measureTextEm(str);
        }
        return String(str || '').length * 0.92;
    }

    /** 计算立面图纸的内容可用包围盒（全宽排布分区索引图与各墙面立面图） */
    function computeElevationRegion(meta) {
        const matReserveH = meta.matReserveH != null ? meta.matReserveH : 3460;
        const bottomReserve = Math.max(meta.tbH || 0, matReserveH);
        const aLeft = meta.contentLeft + 240;
        const aRight = meta.contentRight - 240;
        const aBottom = meta.contentBottom + bottomReserve + 650;
        const aTop = meta.contentTop - 180;
        const aW = Math.max(6000, aRight - aLeft);
        const aH = Math.max(4000, aTop - aBottom);
        return {
            bottomReserve,
            elevBox: { left: aLeft, right: aRight, bottom: aBottom, top: aTop, width: aW, height: aH }
        };
    }

    /** 根据房间顶面比例估算「立面分区索引图」在当前行高 H 下的等效模型宽度(mm) */
    function computeKeyPlanModelWidth(room, H) {
        const pts = (room?.vertexIds || []).map(id => getVertex(id)).filter(Boolean);
        if (pts.length < 3) return Math.round(H);
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const p of pts) {
            if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
            if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
        }
        const ratio = (maxX - minX + 48) / Math.max(40, maxY - minY + 48);
        return Math.round(Math.max(H * 0.85, Math.min(H * 1.55, H * ratio)));
    }

    const itemModelLenMM = x => x.isKeyPlan ? Math.max(200, Math.round(x.lenMM)) : Math.max(100, Math.round(x.f.lenMM));

    function packItemsIntoLines(items, rows) {
        const wOf = x => itemModelLenMM(x) + 600;
        const total = items.reduce((s, x) => s + wOf(x), 0);
        const target = total / Math.max(1, rows);
        const lines = [[]];
        let acc = 0;
        for (const x of items) {
            const w = wOf(x);
            if (acc > 0 && acc + w * 0.55 > target && lines.length < rows) {
                lines.push([]);
                acc = 0;
            }
            lines[lines.length - 1].push(x);
            acc += w;
        }
        return lines;
    }

    /** 为同一页内的组合视图（分区索引图 + 墙面）计算最优比例与折行方案 */
    function solveChunkLayout(items, H, eW, eH) {
        if (!items.length || !(H > 0) || !(eW > 600) || !(eH > 600)) return null;
        let best = null;
        for (let rows = 1; rows <= items.length; rows++) {
            const minH = rows * (ELEV_CAD.TOP_PAD + ELEV_CAD.BOT_PAD) + (rows - 1) * ELEV_CAD.ROW_AIR;
            if (minH >= eH - 320) break;
            const lines = packItemsIntoLines(items, rows);
            const R = lines.length;
            const fixedH = R * (ELEV_CAD.TOP_PAD + ELEV_CAD.BOT_PAD) + (R - 1) * ELEV_CAD.ROW_AIR;
            const kH = (eH - fixedH) / (R * H);
            let kW = Infinity;
            for (const l of lines) {
                const lPad = l[0]?.isKeyPlan ? ELEV_CAD.KEY_EDGE_PAD : ELEV_CAD.LEFT_DIM_PAD;
                const rPad = l[l.length - 1]?.isKeyPlan ? ELEV_CAD.KEY_EDGE_PAD : ELEV_CAD.RIGHT_EXT_PAD;
                const sumL = Math.max(100, l.reduce((s, x) => s + itemModelLenMM(x), 0));
                const gaps = Math.max(0, l.length - 1);
                const availW = eW - lPad - rPad - gaps * ELEV_CAD.WALL_GAP_MIN;
                if (availW <= 100) { kW = -1; break; }
                const kFixedGap = availW / sumL;
                const kScaledGap = (eW - lPad - rPad) / (sumL + gaps * 680);
                kW = Math.min(kW, kFixedGap, kScaledGap);
            }
            if (kW <= 0 || kH <= 0) continue;
            const k = Math.min(ELEV_CAD.K_MAX, kW, kH);
            if (!best || k > best.k + 1e-6 || (Math.abs(k - best.k) <= 1e-6 && R < best.lines.length)) {
                best = { k, lines, gapSheet: Math.max(ELEV_CAD.WALL_GAP_MIN, Math.round(680 * k)) };
            }
        }
        if (best) return best;
        // 极端兜底
        const lPad = items[0]?.isKeyPlan ? ELEV_CAD.KEY_EDGE_PAD : ELEV_CAD.LEFT_DIM_PAD;
        const rPad = items[items.length - 1]?.isKeyPlan ? ELEV_CAD.KEY_EDGE_PAD : ELEV_CAD.RIGHT_EXT_PAD;
        const sumL = Math.max(100, items.reduce((s, x) => s + itemModelLenMM(x), 0));
        const availW = Math.max(200, eW - lPad - rPad - Math.max(0, items.length - 1) * ELEV_CAD.WALL_GAP_MIN);
        const k = Math.max(0.15, Math.min(ELEV_CAD.K_MAX, availW / sumL, (eH - ELEV_CAD.TOP_PAD - ELEV_CAD.BOT_PAD) / H));
        return { k, lines: [items], gapSheet: ELEV_CAD.WALL_GAP_MIN };
    }

    /** 自动分页：将每页墙面与该页分区索引图共同参与排布计算，避免溢出图框 */
    function paginateRoomItems(wallItems, keyPlanItem, H, eW, eH) {
        if (!wallItems.length) return [];
        const withKp = list => [keyPlanItem, ...list];
        const single = solveChunkLayout(withKp(wallItems), H, eW, eH);
        if (wallItems.length === 1 || (single && single.k >= ELEV_CAD.K_MIN)) {
            return [{ wallItems, layout: single }];
        }
        const greedyChunks = [];
        let cur = [];
        for (const item of wallItems) {
            const test = cur.concat(item);
            const lay = solveChunkLayout(withKp(test), H, eW, eH);
            if (cur.length > 0 && (!lay || lay.k < ELEV_CAD.K_MIN)) {
                greedyChunks.push(cur);
                cur = [item];
            } else {
                cur = test;
            }
        }
        if (cur.length) greedyChunks.push(cur);

        const P = greedyChunks.length;
        if (P > 1) {
            const balanced = packItemsIntoLines(wallItems, P);
            if (balanced.length === P) {
                const balancedSolved = balanced.map(chunk => ({ wallItems: chunk, layout: solveChunkLayout(withKp(chunk), H, eW, eH) }));
                if (balancedSolved.every(c => c.layout && (c.wallItems.length === 1 || c.layout.k >= ELEV_CAD.K_MIN))) {
                    return balancedSolved;
                }
            }
        }
        return greedyChunks.map(chunk => ({ wallItems: chunk, layout: solveChunkLayout(withKp(chunk), H, eW, eH) }));
    }

    /** 预先规划全部立面图纸页（供总图计算精确总页数 totalSheets，并复用于绘制） */
    function planElevationSheets(meta, rooms) {
        const reg = computeElevationRegion(meta);
        const pages = [];
        for (const room of (rooms || [])) {
            const faces = getRoomFaces(room);
            const H = roomH(room);
            const list = faces.map(f => ({ f, cfg: getCfg(room, f.key) }))
                .map(x => ({ ...x, lay: x.cfg ? computeFaceLayout(room, x.f, x.cfg) : null }));
            const tot = list.reduce((s, x) => {
                if (x.lay) { s.area += x.lay.stats.area; s.buy += x.lay.stats.buy; }
                return s;
            }, { area: 0, buy: 0 });
            const keyPlanItem = { isKeyPlan: true, room, lenMM: computeKeyPlanModelWidth(room, H) };
            const chunks = paginateRoomItems(list, keyPlanItem, H, reg.elevBox.width, reg.elevBox.height);
            const pageCount = Math.max(1, chunks.length);
            chunks.forEach((ch, pi) => {
                pages.push({
                    room,
                    H,
                    allList: list,
                    items: ch.wallItems,
                    layout: ch.layout,
                    tot,
                    tiledFacesCount: list.filter(x => x.lay).length,
                    pageNo: pi + 1,
                    pageCount
                });
            });
        }
        return { region: reg, pages };
    }

    /** 避开洞口寻找清晰的墙体水平中心段 */
    function findClearBandSpan(face, H, y0MM, y1MM) {
        const L = Math.round(face.lenMM);
        let spans = [[0, L]];
        for (const o of (face.openings || [])) {
            const oy0 = o.y0, oy1 = Math.min(H, o.y1);
            if (oy1 <= y0MM + 5 || oy0 >= y1MM - 5) continue;
            const ox0 = Math.max(0, o.x0 - 30), ox1 = Math.min(L, o.x1 + 30);
            const next = [];
            for (const [s0, s1] of spans) {
                if (ox1 <= s0 || ox0 >= s1) next.push([s0, s1]);
                else {
                    if (ox0 - s0 > 60) next.push([s0, ox0]);
                    if (s1 - ox1 > 60) next.push([ox1, s1]);
                }
            }
            spans = next;
        }
        if (!spans.length) return [0, L];
        spans.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));
        return spans[0];
    }

    /** 离地高度 != 0 时标注「踢脚线位置」，离顶预留 != 0 时标注「吊顶位置」（仅文字标注） */
    function drawWallSkirtingCeilingLabels(dxf, face, cfg, H, fx, fy, k, labelScale = 1) {
        if (!cfg || cfg.enabled === false) return;
        const bottomMM = Math.max(0, Math.round(num(cfg.bottom, 0)));
        const topMM = Math.max(0, Math.round(num(cfg.top, 0)));
        const drawBandText = (y0, y1, fullText, shortText) => {
            if (!(y1 > y0)) return;
            const [sx0, sx1] = findClearBandSpan(face, H, y0, y1);
            const spanSheetW = Math.max(60, (sx1 - sx0) * k);
            const bandSheetH = (y1 - y0) * k;
            const maxW = spanSheetW * 0.88;
            const useFull = maxW >= measureEmSafe(fullText) * 38;
            const txt = useFull ? fullText : shortText;
            const em = Math.max(1, measureEmSafe(txt));
            const hByBand = Math.max(24, Math.min(Math.round(bandSheetH * 0.8), Math.round(Math.max(32, Math.min(100, Math.round(bandSheetH * 0.56))) * labelScale)));
            const hByWidth = Math.max(18, Math.floor(maxW / em));
            const txtH = Math.min(hByBand, hByWidth);
            dxf.setActiveLayer('FLOOR_PLAN');
            dxf.drawText(fx((sx0 + sx1) * 0.5), fy((y0 + y1) * 0.5), txtH, txt, 0, true);
        };
        if (bottomMM > 0) {
            drawBandText(0, Math.min(H, bottomMM), `踢脚线位置 (${uLen(bottomMM)}${Units.cur()})`, '踢脚线位置');
        }
        if (topMM > 0) {
            drawBandText(Math.max(0, H - topMM), H, `吊顶位置 (${uLen(topMM)}${Units.cur()})`, '吊顶位置');
        }
    }

    /** 绘制严格在房间内的最优内接中心点（适配凹凸 L 形等复杂户型） */
    function findBestInteriorPoint(verts) {
        if (!verts || verts.length < 3) return { x: 0, y: 0, clearPx: 60 };
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        let sx = 0, sy = 0;
        for (const v of verts) {
            if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
            if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
            sx += v.x; sy += v.y;
        }
        const inside = (px, py) => {
            let hit = false;
            for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
                const xi = verts[i].x, yi = verts[i].y, xj = verts[j].x, yj = verts[j].y;
                if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / ((yj - yi) || 1e-9) + xi)) hit = !hit;
            }
            return hit;
        };
        const edgeDist = (px, py) => {
            let best = Infinity;
            for (let i = 0; i < verts.length; i++) {
                const a = verts[i], b = verts[(i + 1) % verts.length];
                const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
                const t = l2 > 1e-6 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / l2)) : 0;
                const d = Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
                if (d < best) best = d;
            }
            return best;
        };
        const cands = [{ x: sx / verts.length, y: sy / verts.length }];
        const N = 12;
        for (let ix = 1; ix < N; ix++) {
            for (let iy = 1; iy < N; iy++) {
                cands.push({ x: minX + (maxX - minX) * (ix / N), y: minY + (maxY - minY) * (iy / N) });
            }
        }
        let bestP = null, bestD = -1;
        for (const p of cands) {
            if (!inside(p.x, p.y)) continue;
            const d = edgeDist(p.x, p.y);
            if (d > bestD) { bestD = d; bestP = p; }
        }
        if (bestP) return { x: bestP.x, y: bestP.y, clearPx: bestD };
        return { x: (minX + maxX) * 0.5, y: (minY + maxY) * 0.5, clearPx: Math.min(maxX - minX, maxY - minY) * 0.25 };
    }

    /**
     * 绘制图 1 风格立面分区指向箭头符号：
     * 旋转 45° 黑色实心菱形箭头 + 4 个相切白圆 + 内部「北 / 东 / 南 / 西」方位文字（按 STATE.northAngle 旋转）。
     */
    function drawCardinalIndexSymbolDxf(dxf, cx, cy, outerR, northAngleDeg = 0) {
        const th = (Number(northAngleDeg) || 0) * Math.PI / 180;
        // DXF 为 Y 向上：正北在 northAngle=0 时指向上 (0, +1)
        const uN = [Math.sin(th), Math.cos(th)];
        const uE = [Math.cos(th), -Math.sin(th)];
        const uS = [-uN[0], -uN[1]];
        const uW = [-uE[0], -uE[1]];
        const dirs = [
            { u: uN, label: '北' },
            { u: uE, label: '东' },
            { u: uS, label: '南' },
            { u: uW, label: '西' }
        ];
        const SQ2 = Math.SQRT2;
        const r = outerR / (2 * SQ2);      // 相切圆半径，使 R = d + r*sqrt(2) = 2*r*sqrt(2)
        const d = r * SQ2;                 // 圆心距符号中心的距离
        const add = (a, b, sa = 1, sb = 1) => [a[0] * sa + b[0] * sb, a[1] * sa + b[1] * sb];
        const ptC = (dirU, angFromDir, rad = r) => {
            const perpU = [dirU[1], -dirU[0]]; // 顺时针旋转 90°
            const c = Math.cos(angFromDir), s = Math.sin(angFromDir);
            return [
                cx + d * dirU[0] + rad * (dirU[0] * c + perpU[0] * s),
                cy + d * dirU[1] + rad * (dirU[1] * c + perpU[1] * s)
            ];
        };
        const solidTri = (p0, p1, p2) => {
            dxf.push({ t: 'S', col: 7, p: [Math.round(p0[0] * 100) / 100, Math.round(p0[1] * 100) / 100, Math.round(p1[0] * 100) / 100, Math.round(p1[1] * 100) / 100, Math.round(p2[0] * 100) / 100, Math.round(p2[1] * 100) / 100, Math.round(p2[0] * 100) / 100, Math.round(p2[1] * 100) / 100] });
        };

        dxf.setActiveLayer('FLOOR_PLAN');
        const tips = dirs.map(it => [cx + it.u[0] * outerR, cy + it.u[1] * outerR]);
        const STEPS = 8;

        // 1. 四个菱形尖角（圆外箭头实心填充，不覆盖圆内部）
        for (let i = 0; i < 4; i++) {
            const u = dirs[i].u;
            const tip = tips[i];
            for (let s = 0; s < STEPS; s++) {
                const a0 = (-Math.PI / 4) + (Math.PI / 2) * (s / STEPS);
                const a1 = (-Math.PI / 4) + (Math.PI / 2) * ((s + 1) / STEPS);
                solidTri(tip, ptC(u, a0), ptC(u, a1));
            }
        }
        // 2. 四条斜边中点与相邻两圆之间的外楔角实心填充
        for (let i = 0; i < 4; i++) {
            const u0 = dirs[i].u, u1 = dirs[(i + 1) % 4].u;
            const midEdge = [(tips[i][0] + tips[(i + 1) % 4][0]) * 0.5, (tips[i][1] + tips[(i + 1) % 4][1]) * 0.5];
            for (let s = 0; s < STEPS; s++) {
                const a0 = (Math.PI / 4) + (Math.PI / 2) * (s / STEPS);
                const a1 = (Math.PI / 4) + (Math.PI / 2) * ((s + 1) / STEPS);
                solidTri(midEdge, ptC(u0, a0), ptC(u0, a1));
            }
            for (let s = 0; s < STEPS; s++) {
                const a0 = (-3 * Math.PI / 4) + (Math.PI / 2) * (s / STEPS);
                const a1 = (-3 * Math.PI / 4) + (Math.PI / 2) * ((s + 1) / STEPS);
                solidTri(midEdge, ptC(u1, a0), ptC(u1, a1));
            }
        }
        // 3. 中心四尖星缝隙实心填充
        const centerPt = [cx, cy];
        for (let i = 0; i < 4; i++) {
            const u = dirs[i].u;
            for (let s = 0; s < STEPS; s++) {
                const a0 = (3 * Math.PI / 4) + (Math.PI / 2) * (s / STEPS);
                const a1 = (3 * Math.PI / 4) + (Math.PI / 2) * ((s + 1) / STEPS);
                solidTri(centerPt, ptC(u, a0), ptC(u, a1));
            }
        }
        // 4. 外菱形轮廓与微出头角线、四个白圆边框及「北/东/南/西」文字
        dxf.drawPolyline(tips, true);
        const cornerExt = r * 0.16;
        for (let i = 0; i < 4; i++) {
            const tPrev = tips[(i + 3) % 4], tCur = tips[i], tNext = tips[(i + 1) % 4];
            const e1 = [tCur[0] - tPrev[0], tCur[1] - tPrev[1]], l1 = Math.hypot(e1[0], e1[1]) || 1;
            const e2 = [tCur[0] - tNext[0], tCur[1] - tNext[1]], l2 = Math.hypot(e2[0], e2[1]) || 1;
            dxf.drawLine(tCur[0], tCur[1], tCur[0] + e1[0] / l1 * cornerExt, tCur[1] + e1[1] / l1 * cornerExt);
            dxf.drawLine(tCur[0], tCur[1], tCur[0] + e2[0] / l2 * cornerExt, tCur[1] + e2[1] / l2 * cornerExt);
        }
        const txtH = Math.max(42, Math.round(r * 1.06));
        for (const it of dirs) {
            const cc = add([cx, cy], it.u, 1, d);
            dxf.drawCircle(cc[0], cc[1], r);
            dxf.drawText(cc[0], cc[1], txtH, it.label, 0, true);
        }
    }

    /** 绘制无边框「分区索引图」：空间顶面墙体/门窗结构 + 外圈尺寸（不含铺贴）+ 东西南北指向箭头，底部标字与其他图纸标题一致 */
    function drawRoomKeyPlanDxf(api, room, keyBox, pageInfo, dimTh) {
        const { dxf, getRoomInnerWallVerts, getRoomWallIdSet, buildRoomOuterDimensionPlan, drawWallPiecesDxf, drawOpeningSymbolsDxf, drawDimItemsDxf } = api;
        const verts = getRoomInnerWallVerts ? getRoomInnerWallVerts(room) : [];
        if (!verts || verts.length < 3) return;
        const roomWallIds = getRoomWallIdSet ? getRoomWallIdSet(room) : null;
        let vMinX = Infinity, vMinY = Infinity, vMaxX = -Infinity, vMaxY = -Infinity;
        for (const v of verts) {
            if (v.x < vMinX) vMinX = v.x; if (v.x > vMaxX) vMaxX = v.x;
            if (v.y < vMinY) vMinY = v.y; if (v.y > vMaxY) vMaxY = v.y;
        }
        const approxW = Math.max(400, (keyBox.right - keyBox.left) - 420);
        const approxH = Math.max(400, (keyBox.top - keyBox.bottom) - 380);
        const approxScale = Math.min(approxW / Math.max(60, vMaxX - vMinX + 60), approxH / Math.max(60, vMaxY - vMinY + 60));
        const outDistPx = Math.max(14, Math.round(135 / Math.max(0.5, approxScale)));
        const tierStepPx = Math.max(14, Math.round(165 / Math.max(0.5, approxScale)));
        const tickLenPx = Math.max(6.5, Math.round(44 / Math.max(0.5, approxScale)));
        const dims = buildRoomOuterDimensionPlan ? buildRoomOuterDimensionPlan(room, outDistPx, tickLenPx, tierStepPx) : [];

        let bMinX = Infinity, bMinY = Infinity, bMaxX = -Infinity, bMaxY = -Infinity;
        const expandPt = (px, py) => {
            if (px < bMinX) bMinX = px; if (px > bMaxX) bMaxX = px;
            if (py < bMinY) bMinY = py; if (py > bMaxY) bMaxY = py;
        };
        for (const v of verts) expandPt(v.x, v.y);
        for (const w of (STATE.walls || [])) {
            if (roomWallIds && !roomWallIds.has(w.id)) continue;
            const v1 = getVertex(w.v1), v2 = getVertex(w.v2);
            const th = w.thickness || 12;
            if (v1) { expandPt(v1.x - th * 0.6, v1.y - th * 0.6); expandPt(v1.x + th * 0.6, v1.y + th * 0.6); }
            if (v2) { expandPt(v2.x - th * 0.6, v2.y - th * 0.6); expandPt(v2.x + th * 0.6, v2.y + th * 0.6); }
        }
        for (const dm of dims) {
            expandPt(dm.p1.x, dm.p1.y); expandPt(dm.p2.x, dm.p2.y);
            expandPt(dm.e1a.x, dm.e1a.y); expandPt(dm.e1b.x, dm.e1b.y);
            expandPt(dm.e2a.x, dm.e2a.y); expandPt(dm.e2b.x, dm.e2b.y);
        }

        const padL = 180, padR = 160, padT = 180, padB = 110;
        const iW = Math.max(360, (keyBox.right - padR) - (keyBox.left + padL));
        const iH = Math.max(360, (keyBox.top - padT) - (keyBox.bottom + padB));
        const rScale = Math.min(iW / Math.max(40, bMaxX - bMinX), iH / Math.max(40, bMaxY - bMinY));
        const rCx = (keyBox.left + padL) + (iW - (bMaxX - bMinX) * rScale) * 0.5;
        const rCy = (keyBox.bottom + padB) + (iH - (bMaxY - bMinY) * rScale) * 0.5;
        const kfx = px => rCx + (px - bMinX) * rScale;
        const kfy = py => rCy + (bMaxY - py) * rScale;

        if (drawWallPiecesDxf) drawWallPiecesDxf(kfx, kfy, rScale, roomWallIds);
        if (drawOpeningSymbolsDxf) drawOpeningSymbolsDxf(kfx, kfy, roomWallIds);
        if (drawDimItemsDxf && dims.length) {
            const dimScale = ((api.fontScales && api.fontScales.dimension) || 100) / 100;
            const kpDimH2 = Math.max(30, Math.min(Math.round(72 * Math.max(1, dimScale)), Math.round((dimTh || 110) * 0.62)));
            const kpDimH1 = Math.max(28, Math.min(Math.round(64 * Math.max(1, dimScale)), Math.round((dimTh || 110) * 0.54)));
            drawDimItemsDxf(dims, kfx, kfy, (span, dm) => dm?.kind === 'outer-total' ? kpDimH2 : kpDimH1, dm => {
                const v = uLen(dm.mmVal);
                if (dm?.kind === 'opening-window') return `窗${v}`;
                if (dm?.kind === 'opening-door') return `门${v}`;
                return v;
            });
        }

        const bestPt = findBestInteriorPoint(verts);
        const clearSheet = bestPt.clearPx * rScale;
        const symR = Math.max(140, Math.min(720, Math.round(clearSheet * 0.62), Math.round(Math.min(iW, iH) * 0.28)));
        drawCardinalIndexSymbolDxf(dxf, kfx(bestPt.x), kfy(bestPt.y), symR, STATE.northAngle || 0);

        // 底部标题字：无边框、带下划线，与其他图纸标题样式及水平线对齐一致
        const capLabel = pageInfo.pageCount > 1 ? `立面分区索引图 (${pageInfo.pageNo}/${pageInfo.pageCount})` : '立面分区索引图';
        const capCx = (keyBox.left + keyBox.right) * 0.5;
        const capY = keyBox.bottom - 205;
        const capEm = Math.max(1, measureEmSafe(capLabel));
        const titleScale = ((api.fontScales && api.fontScales.sheetTitle) || 100) / 100;
        const rawCapH = Math.max(90, Math.min(165, Math.round((dimTh || 120) * 1.25)));
        const capH = Math.max(60, Math.min(Math.round(rawCapH * titleScale), Math.floor(((keyBox.right - keyBox.left) + 180) / capEm)));
        const capW = capEm * capH;
        dxf.setActiveLayer('SHEET_FRAME');
        dxf.drawText(capCx, capY, capH, capLabel, 0, true);
        const ulY = capY - capH * 0.58;
        dxf.drawLine(capCx - capW * 0.52, ulY, capCx + capW * 0.52, ulY);
    }

    /** 墙面上方名称标签（超窄墙自动紧凑化并钳制边界，防止与邻墙或图框碰撞） */
    function drawWallHeaderLabelDxf(dxf, face, lay, L, H, fx, fy, leftLimit, rightLimit, k, labelScale = 1) {
        const fullLbl = `${face.label}墙${lay ? `  ${lay.zones.map(z => `${z.specLabel ? z.specLabel + ' ' : ''}${uSpec(z.tw, z.th)}`).join(' / ')}` : '（不铺贴）'}`;
        const midLbl = `${face.label}墙${lay && lay.zones[0] ? ` ${uSpec(lay.zones[0].tw, lay.zones[0].th)}` : ''}`;
        const shortLbl = `${face.label}墙`;
        const maxBoxW = Math.max(300, rightLimit - leftLimit);
        const preferredMaxW = Math.min(maxBoxW, Math.max(L * k + 340, 1200));
        const baseH = Math.max(50, Math.round(Math.max(88, Math.min(170, Math.round(170 * Math.min(1.15, k)))) * labelScale));
        let text = fullLbl;
        if (measureEmSafe(text) * 76 > preferredMaxW) text = midLbl;
        if (measureEmSafe(text) * 72 > preferredMaxW) text = shortLbl;
        const em = Math.max(1, measureEmSafe(text));
        const lblH = Math.max(46, Math.min(baseH, Math.floor(preferredMaxW / em)));
        const halfW = em * lblH * 0.5;
        const cx = Math.max(leftLimit + halfW, Math.min(rightLimit - halfW, fx(L / 2)));
        dxf.setActiveLayer('FLOOR_PLAN');
        dxf.drawText(cx, fy(H) + 175, lblH, text, 0, true);
    }

    /** 墙面在立面图纸上的起铺点（自定义点优先，未设点时取主区域 alignH/alignV 基准角） */
    function getWallEffectiveOrigin(f, cfg, lay) {
        if (!cfg || !lay || !lay.zones || !lay.zones.length) return null;
        const org = validOrigin(cfg);
        if (org) return { x: org.x, y: org.y };
        const z0 = lay.zones[0];
        const L = Math.round(f.lenMM);
        const ox = cfg.alignH === 'left' ? 0 : cfg.alignH === 'right' ? L : Math.max(0, (L - z0.tw) * 0.5);
        const oy = cfg.alignV === 'top' ? z0.y1 : cfg.alignV === 'center' ? (z0.y0 + z0.y1 - z0.th) * 0.5 : z0.y0;
        return { x: ox, y: oy };
    }

    /**
     * 在 buildProjectDrawing 中追加各空间的墙面立面排砖详图（含左侧分区索引图、自动分页防溢出、离地/离顶标注）。
     */
    function drawElevationSheetsDxf(api, rooms) {
        const { dxf, drawCadSheetFrame, drawMaterialSpecTableDxf, drawSheetBottomTitleDxf, getSkirtingSpecItems, getWallGroutAndAuxItems, getTileSpecLayer, drawOriginTargetDxf, pagePlans, accumulateSpecItem, wallZoneSpecBase, groutDesc } = api;
        const optShowTileMarks = api.showTileMarks !== false;
        const fScales = api.fontScales || {};
        const fScale = (key) => (Number(fScales[key]) || 100) / 100;
        const pages = Array.isArray(pagePlans) ? pagePlans : planElevationSheets(api.sheetMeta || {}, rooms).pages;
        pages.forEach((pg, pi) => {
            const { room, H, items: pageItems, layout, tot, tiledFacesCount, pageNo, pageCount } = pg;
            const sheetIdx = api.startIdx + pi;
            const title = pageCount > 1 ? `【${room.name}】墙面立面排砖详图 (${pageNo}/${pageCount})` : `【${room.name}】墙面立面排砖详图`;
            const sub = `墙面展开 ${tiledFacesCount} 面${pageCount > 1 ? ` · 第 ${pageNo}/${pageCount} 页` : ''} · 吊顶 ${uLen(H)}${Units.cur()} · 墙砖 ${tot.area.toFixed(2)}m² · 采购 ${tot.buy} 块`;
            const frame = drawCadSheetFrame(sheetIdx, title, sub, room);

            const specItems = [];
            const byCode = new Map();
            const elevColorSpecs = [];
            const seenColorCodes = new Set();
            const sourceList = pageCount > 1 ? pg.items : pg.allList;
            for (const { cfg, lay } of sourceList) {
                if (!lay || !cfg) continue;
                const desc = groutDesc(Math.max(0, num(cfg.gap, 1.5)), cfg.groutEnabled !== false);
                for (const z of lay.zones) {
                    const meta = getSpecMeta('wall', 'tile', z.spec.styleId);
                    const zCode = z.specLabel || `${meta.prefix}1`;
                    if (zCode && !seenColorCodes.has(zCode)) {
                        seenColorCodes.add(zCode);
                        const stObj = styleOf(z.spec.styleId);
                        const dispName = typeof formatLegendMaterialName === 'function'
                            ? formatLegendMaterialName('wall', meta.kind, 'tile', stObj?.name)
                            : (() => {
                                const k = (!meta.kind || meta.kind === '瓷砖') ? '墙砖' : meta.kind;
                                const n = String(stObj?.name || '').trim();
                                return !n ? k : (n.includes(k) ? n : `${k}·${n}`);
                            })();
                        elevColorSpecs.push({
                            code: zCode,
                            name: dispName || zCode,
                            layer: getTileSpecLayer ? getTileSpecLayer(zCode) : 'TILE'
                        });
                    }
                    accumulateSpecItem(byCode, specItems, wallZoneSpecBase(z, desc),
                        z.stats?.area ?? 0, z.stats?.buy ?? (z.tiles ? z.tiles.length : 0));
                }
            }
            // 本空间启用了踢脚线与墙面辅材时，一并列入左下角材料说明
            if (typeof getSkirtingSpecItems === 'function') specItems.push(...getSkirtingSpecItems(room));
            if (typeof getWallGroutAndAuxItems === 'function') specItems.push(...getWallGroutAndAuxItems(room, sourceList));
            const matH = drawMaterialSpecTableDxf ? drawMaterialSpecTableDxf(frame, specItems, {
                legend: {
                    mode: 'elev',
                    sampleCode: elevColorSpecs[0]?.code || 'W1',
                    colorSpecs: elevColorSpecs
                }
            }) : 0;
            const { elevBox, bottomReserve } = computeElevationRegion({
                contentLeft: frame.contentLeft,
                contentRight: frame.contentRight,
                contentBottom: frame.contentBottom,
                contentTop: frame.contentTop,
                tbH: frame.tbH,
                matReserveH: matH || 3460
            });

            // 全宽混合排布「立面分区索引图」与各墙面立面展开排砖图（无大立柱、无外边框）
            const { k, lines, gapSheet } = layout;
            const R = lines.length;
            const totalBlockH = R * (H * k + ELEV_CAD.TOP_PAD + ELEV_CAD.BOT_PAD) + Math.max(0, R - 1) * ELEV_CAD.ROW_AIR;
            let rowTop = elevBox.bottom + (elevBox.height + totalBlockH) * 0.5;
            const groundExt = Math.min(125, Math.max(60, Math.round(125 * k)));
            const dimTh = Math.max(40, Math.round(Math.max(62, Math.min(135, Math.round(135 * Math.min(1.1, k)))) * fScale('dimension')));

            for (const line of lines) {
                const lPad = line[0]?.isKeyPlan ? ELEV_CAD.KEY_EDGE_PAD : ELEV_CAD.LEFT_DIM_PAD;
                const rPad = line[line.length - 1]?.isKeyPlan ? ELEV_CAD.KEY_EDGE_PAD : ELEV_CAD.RIGHT_EXT_PAD;
                const sumItemSheet = line.reduce((s, x) => s + itemModelLenMM(x) * k, 0);
                const rowActualW = lPad + sumItemSheet + Math.max(0, line.length - 1) * gapSheet + rPad;
                let cx = elevBox.left + Math.max(0, (elevBox.width - rowActualW) * 0.5) + lPad;
                const baseY = rowTop - ELEV_CAD.TOP_PAD - H * k;

                line.forEach((item, wi) => {
                    if (item.isKeyPlan) {
                        const kpW = Math.round(item.lenMM * k);
                        drawRoomKeyPlanDxf(api, room, { left: cx, right: cx + kpW, bottom: baseY, top: baseY + H * k }, { pageNo, pageCount }, dimTh);
                        cx += kpW + gapSheet;
                        return;
                    }
                    const { f, cfg, lay } = item;
                    const L = Math.round(f.lenMM);
                    const fx = x => cx + x * k, fy = y => baseY + y * k;

                    // 铺贴砖块（按墙砖规格编码独立分图层 TILE_<编码>）
                    if (lay) {
                        for (const z of lay.zones) {
                            const meta = getSpecMeta('wall', 'tile', z.spec.styleId);
                            const zoneCode = z.specLabel || `${meta.prefix}1`;
                            const zoneLayer = getTileSpecLayer ? getTileSpecLayer(zoneCode) : 'TILE';
                            for (const t of z.tiles) {
                                dxf.setActiveLayer(zoneLayer);
                                for (const loop of t.polys) dxf.drawPolyline(loop.map(p => [fx(p.x), fy(p.y)]), true);
                                const bw = t.bw * k, bh = t.bh * k;
                                if (optShowTileMarks && Math.min(bw, bh) >= 60) {
                                    dxf.setActiveLayer(zoneLayer);
                                    const baseTxtH = Math.max(20, Math.min(90, Math.round(Math.min(bh * 0.34, bw * 0.7 / Math.max(t.id.length * 0.75, 1.8)))));
                                    const txtH = Math.max(16, Math.min(Math.round(Math.min(bw, bh) * 0.72), Math.round(baseTxtH * fScale('tileMark'))));
                                    const bx = (Math.max(t.full.x0, 0) + Math.min(t.full.x1, lay.L)) / 2;
                                    const by = (Math.max(t.full.y0, z.y0) + Math.min(t.full.y1, z.y1)) / 2;
                                    dxf.drawText(fx(bx), fy(by), txtH, t.id, 0, true);
                                }
                            }
                        }
                    }

                    // 墙面轮廓与地面线
                    dxf.setActiveLayer('FLOOR_PLAN');
                    dxf.drawRect(fx(0), fy(0), fx(L), fy(H));
                    dxf.drawLine(fx(0) - groundExt, fy(0), fx(L) + groundExt, fy(0));

                    // 门窗洞口与门窗标记（类型 + 宽×高，窗户附加窗台高）
                    dxf.setActiveLayer('FLOOR_PLAN');
                    for (const o of f.openings) {
                        const y1 = Math.min(H, o.y1);
                        dxf.drawRect(fx(o.x0), fy(o.y0), fx(o.x1), fy(y1));
                        if (o.type === 'window') {
                            dxf.drawLine(fx((o.x0 + o.x1) / 2), fy(o.y0), fx((o.x0 + o.x1) / 2), fy(y1));
                            dxf.drawLine(fx(o.x0), fy((o.y0 + y1) / 2), fx(o.x1), fy((o.y0 + y1) / 2));
                        } else {
                            const hr = !!o.op.hinge, hx = hr ? o.x1 : o.x0, ox = hr ? o.x0 : o.x1;
                            dxf.drawPolyline([[fx(hx), fy(y1)], [fx(ox), fy((o.y0 + y1) / 2)], [fx(hx), fy(o.y0)]], false);
                        }
                        const opW = (o.x1 - o.x0) * k;
                        const opH = (y1 - o.y0) * k;
                        if (opW > 40 && opH > 40) {
                            const owMM = Math.round(o.x1 - o.x0);
                            const ohMM = Math.round(o.y1 - o.y0);
                            const opLabel = `${o.type === 'window' ? '窗' : '门'} ${uLen(owMM)}×${uLen(ohMM)}`;
                            const em = measureEmSafe(opLabel);
                            const rawH = Math.max(46, Math.min(92, Math.round(dimTh * 0.92)));
                            const txtH = Math.max(26, Math.min(rawH, Math.round((opW * 0.88) / Math.max(em, 2)), Math.round(opH * 0.22)));
                            const labelCx = fx((o.x0 + o.x1) * 0.5);
                            const labelCy = fy(y1) - Math.max(txtH * 1.15, opH * 0.14);
                            dxf.drawText(labelCx, labelCy, txtH, opLabel, 0, true);
                            if (o.type === 'window' && o.y0 > 0 && opH >= txtH * 4.2) {
                                const sillLabel = `窗台 ${uLen(Math.round(o.y0))}`;
                                const sillH = Math.max(24, Math.min(Math.round(txtH * 0.88), Math.round((opW * 0.86) / Math.max(measureEmSafe(sillLabel), 2))));
                                dxf.drawText(labelCx, fy(o.y0) + Math.max(sillH * 1.15, opH * 0.14), sillH, sillLabel, 0, true);
                            }
                        }
                    }

                    // 离地高度 != 0 标「踢脚线位置」，离顶预留 != 0 标「吊顶位置」（纯文字标注）
                    if (lay && cfg) drawWallSkirtingCeilingLabels(dxf, f, cfg, H, fx, fy, k, fScale('roomLabel'));

                    // 墙面起铺点靶标（红色十字圆环 + 起铺点标注）
                    if (lay && cfg && typeof drawOriginTargetDxf === 'function') {
                        const wallOrig = getWallEffectiveOrigin(f, cfg, lay);
                        if (wallOrig) {
                            const orad = Math.max(55, Math.min(125, Math.round(92 * Math.min(1.25, k))));
                            const oTxtH = Math.max(30, Math.round(Math.max(52, Math.min(110, Math.round(82 * Math.min(1.25, k)))) * fScale('originLabel')));
                            drawOriginTargetDxf(wallOrig, fx, fy, orad, Math.round(orad * 0.38), Math.round(orad * 1.6), {
                                label: '起铺点',
                                txtH: oTxtH,
                                dirX: wallOrig.x <= L * 0.5 ? 1 : -1,
                                dirY: wallOrig.y <= H * 0.5 ? 1 : -1
                            });
                        }
                    }

                    // 墙面上方名称标签（限制水平范围避免碰撞邻墙或溢出图框）
                    const leftLblLim = wi === 0 ? (elevBox.left + 40) : (cx - gapSheet * 0.45);
                    const rightLblLim = wi === line.length - 1 ? (elevBox.right - 40) : (fx(L) + gapSheet * 0.45);
                    drawWallHeaderLabelDxf(dxf, f, lay, L, H, fx, fy, leftLblLim, rightLblLim, k, fScale('roomLabel'));

                    // 下方净长尺寸（有门窗时附加内层门窗分段定位尺寸） & 左侧竖向分区尺寸
                    dxf.setActiveLayer('FLOOR_PLAN');
                    if (f.openings.length > 0) {
                        const segs = [];
                        let curX = 0;
                        for (const o of f.openings) {
                            if (o.x0 - curX > 1) segs.push({ a: curX, b: o.x0, prefix: '' });
                            const oa = Math.max(curX, o.x0);
                            if (o.x1 - oa > 1) segs.push({ a: oa, b: o.x1, prefix: o.type === 'window' ? '窗' : '门' });
                            curX = Math.max(curX, o.x1);
                        }
                        if (L - curX > 1) segs.push({ a: curX, b: L, prefix: '' });
                        const segDimTh = Math.max(36, Math.round(dimTh * 0.82));
                        const dyInner = fy(0) - 145;
                        for (const sg of segs) {
                            const segSpan = (sg.b - sg.a) * k;
                            const txt = `${sg.prefix}${uLen(sg.b - sg.a)}`;
                            dxf.drawDimension(fx(sg.a), dyInner, fx(sg.b), dyInner, segSpan > segDimTh * 1.8 ? txt : '', segDimTh, 50);
                        }
                        const dyOuter = fy(0) - 305;
                        dxf.drawDimension(fx(0), dyOuter, fx(L), dyOuter, uLen(L), dimTh, 65);
                    } else {
                        const dy = fy(0) - 210;
                        dxf.drawDimension(fx(0), dy, fx(L), dy, uLen(L), dimTh, 65);
                    }
                    if (lay) {
                        const xs = fx(0) - 190;
                        const ys = [...new Set([0, ...lay.zones.flatMap(z => [z.y0, z.y1]), H].map(v => Math.round(v)))].sort((p, q) => p - q);
                        for (let yi = 0; yi < ys.length - 1; yi++) {
                            const span = (ys[yi + 1] - ys[yi]) * k;
                            dxf.drawDimension(xs, fy(ys[yi]), xs, fy(ys[yi + 1]), span > dimTh * 2.1 ? uLen(ys[yi + 1] - ys[yi]) : '', dimTh, 60);
                        }
                    }
                    cx += L * k + gapSheet;
                });

                rowTop -= (ELEV_CAD.TOP_PAD + H * k + ELEV_CAD.BOT_PAD + ELEV_CAD.ROW_AIR);
            }

            if (drawSheetBottomTitleDxf) {
                const blockBottom = elevBox.bottom + (elevBox.height - totalBlockH) * 0.5;
                const capY = Math.max(frame.contentBottom + bottomReserve + 220, blockBottom - 260);
                drawSheetBottomTitleDxf((elevBox.left + elevBox.right) * 0.5, capY, title, 100 / k);
            }
        });
    }

    /* ===================== 生命周期 ===================== */
    function resetCacheForExport() {
        layoutCache.clear();
        numDirty = true;
    }
    function onStateRestored() {
        layoutCache.clear();
        hover3d = null;
        S.pickPreview = null;
        syncFloorInputs();
        if (S.active) {
            if (!getRoom(S.roomId)) S.roomId = (STATE.rooms && STATE.rooms[0]?.id) || null;
            refresh({ calc: false });
        } else {
            syncModeUi(null, []);
        }
    }

    function init() {
        bindElevCanvas();
        bindPropertyInputs();
        $('btn-mode-floor')?.addEventListener('click', () => exit());
        $('btn-mode-elev')?.addEventListener('click', () => { if (!S.active) enter(); });
        $('btn-3d-mode-toggle')?.addEventListener('click', () => { if (S.active) exit(); else enter(); });
        $('btn-elev-go-floor')?.addEventListener('click', () => exit());
        $('btn-elev-apply-all')?.addEventListener('click', applyToAllFaces);
        $('btn-elev-clear')?.addEventListener('click', clearCanvas);
        document.querySelectorAll('[data-calc-mode]').forEach(b => b.addEventListener('click', () => setCalcMode(b.getAttribute('data-calc-mode'))));
        // 立面模式下拦截平面编辑快捷键（Delete、工具切换等），保留 Ctrl 组合键（撤销/保存）
        window.addEventListener('keydown', e => {
            if (!S.active) return;
            const t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
            if (e.ctrlKey || e.metaKey) return;
            if (document.querySelector('#style-picker-modal:not(.hidden), #modal-backdrop:not(.hidden)')) return;
            if (e.code === 'Space') {   // 与平面一致：按住空格 + 左键拖动平移
                if (!STATE.isSpacePressed) { STATE.isSpacePressed = true; if (!S.picking) $('elev-canvas').style.cursor = 'grab'; }
                e.preventDefault(); e.stopImmediatePropagation(); return;
            }
            if (e.key === 'Escape') { e.preventDefault(); if (S.picking) setPicking(false); else exit(); }
            else if (e.key === 'o' || e.key === 'O') setPicking(!S.picking);
            else if (e.key === '0' || e.key === 'Home') { S.needFit = true; drawElev(); }
            else if (e.key === '+' || e.key === '=') zoomBy(1.25);
            else if (e.key === '-') zoomBy(0.8);
            else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                const room = curRoom();
                const faces = room ? getRoomFaces(room) : [];
                if (!faces.length) return;
                // 顺序：全墙 → 各面墙 → 全墙
                const i = S.view === 'unfold' ? -1 : faces.findIndex(f => f.key === S.faceKey);
                const n = faces.length + 1;
                const ni = ((i + 1) + (e.key === 'ArrowRight' ? 1 : -1) + n) % n - 1;
                if (ni < 0) S.view = 'unfold'; else { S.faceKey = faces[ni].key; S.view = 'single'; }
                S.needFit = true; refresh({ calc: false });
            }
            e.stopImmediatePropagation();
            e.preventDefault();
        }, true);
        syncFloorInputs();
        syncModeUi(null, []);
    }

    /** 导出当前立面空间的高清彩图 Canvas（支持全部墙面展开或当前单墙面） */
    function renderColorExportCanvas(opts = {}) {
        const room = curRoom();
        if (!room) return null;
        forEachWallZone(() => {});
        ensureNumbers();
        const faces = getRoomFaces(room);
        if (!faces.length) return null;
        const viewMode = opts.viewMode === 'single' ? 'single' : 'unfold';
        const showTileMarks = opts.showTileMarks != null ? !!opts.showTileMarks : !!STATE.showTileMarks;
        const showDimensions = opts.showDimensions !== false;
        const showRoomLabels = opts.showRoomLabels !== false;
        const showOrigin = opts.showOrigin !== false;
        const maxSide = Math.max(1800, Math.min(4000, Number(opts.resolution) || 3000));

        let items = [];
        let activeFace = null;
        if (viewMode === 'single') {
            activeFace = faces.find(f => f.key === S.faceKey) || faces[0];
            items = [{ f: activeFace, ox: 0 }];
        } else {
            let ox = 0;
            for (const f of faces) { items.push({ f, ox }); ox += f.lenMM + UNFOLD_GAP; }
        }
        const H = roomH(room);
        const totalL = Math.max(100, items.reduce((s, it) => Math.max(s, it.ox + it.f.lenMM), 0));

        const padL = 160, padR = 140, padT = 130, padB = 220;
        const drawMaxW = maxSide - padL - padR;
        const drawMaxH = Math.round(maxSide * 0.68) - padT - padB;
        const sc = Math.min(drawMaxW / totalL, drawMaxH / Math.max(H, 1000));
        const W = Math.max(1400, Math.round(totalL * sc + padL + padR));
        const Hh = Math.max(960, Math.round(H * sc + padT + padB));

        const exportCanvas = document.createElement('canvas');
        exportCanvas.width = W;
        exportCanvas.height = Hh;
        const c = exportCanvas.getContext('2d');
        c.fillStyle = '#ffffff';
        c.fillRect(0, 0, W, Hh);

        const ox0 = Math.round((W - totalL * sc) * 0.5);
        const oy0 = Math.round(padT + H * sc);
        const X = x => ox0 + x * sc;
        const Y = y => oy0 - y * sc;

        const prevShowMarks = STATE.showTileMarks;
        STATE.showTileMarks = showTileMarks;
        try {
            // 地面线 / 吊顶线
            c.strokeStyle = '#334155'; c.lineWidth = 2.5;
            c.beginPath(); c.moveTo(X(0) - 70, Y(0)); c.lineTo(X(totalL) + 40, Y(0)); c.stroke();
            c.save(); c.setLineDash([8, 5]); c.strokeStyle = '#94a3b8'; c.lineWidth = 1.4;
            c.beginPath(); c.moveTo(X(0) - 70, Y(H)); c.lineTo(X(totalL) + 40, Y(H)); c.stroke(); c.restore();
            if (showDimensions) {
                c.font = `500 15px ${CANVAS_FONT_SANS}`; c.fillStyle = '#64748b'; c.textAlign = 'right'; c.textBaseline = 'bottom';
                c.fillText(`吊顶 ${Units.dim(H)}`, X(0) - 10, Y(H) - 4);
                c.fillText('地面 ±0', X(0) - 10, Y(0) - 4);
            }

            for (const { f, ox } of items) {
                const cfg = getCfg(room, f.key);
                const sk = getSkirtingCfg(room, f.key);
                const lay = cfg ? computeFaceLayout(room, f, cfg) : null;
                const fx = x => X(ox + x);

                c.fillStyle = '#f8fafc';
                c.fillRect(fx(0), Y(H), f.lenMM * sc, H * sc);
                if (lay) drawFaceTiles(c, f, lay, fx, Y, sc);
                if (sk && sk.enabled) drawFaceSkirting(c, f, sk, fx, Y, sc, H);
                for (const o of f.openings) drawOpeningElev(c, o, fx, Y, sc, H);

                c.strokeStyle = '#334155';
                c.lineWidth = 1.8;
                c.strokeRect(fx(0), Y(H), f.lenMM * sc, H * sc);

                if (showRoomLabels) {
                    c.font = `600 18px ${CANVAS_FONT_SANS}`; c.textAlign = 'center'; c.textBaseline = 'bottom';
                    c.fillStyle = '#1e293b';
                    c.fillText(`${f.label}墙${lay ? '' : '（未铺贴）'}`, fx(f.lenMM / 2), Y(H) - 24);
                }
                const org = validOrigin(cfg);
                if (org && showOrigin) drawOriginMark(c, fx(org.x), Y(org.y));

                if (showDimensions) {
                    dimH(c, fx(0), fx(f.lenMM), Y(0) + 46, Units.dim(f.lenMM));
                    if (f.openings.length) {
                        const stops = [0];
                        for (const o of f.openings) stops.push(o.x0, o.x1);
                        stops.push(f.lenMM);
                        for (let i = 0; i < stops.length - 1; i++) {
                            const a = stops[i], b = stops[i + 1];
                            if (b - a > 1) dimH(c, fx(a), fx(b), Y(0) + 22, Units.dim(b - a), true);
                        }
                    }
                    if (viewMode === 'single') {
                        const xrBase = fx(f.lenMM);
                        const ys = [0];
                        if (lay) { for (const z of lay.zones) ys.push(z.y0, z.y1); }
                        ys.push(H);
                        const uniq = [...new Set(ys.map(v => Math.round(v)))].sort((p, q) => p - q);
                        for (let i = 0; i < uniq.length - 1; i++) dimV(c, xrBase + 24, Y(uniq[i]), Y(uniq[i + 1]), Units.dim(uniq[i + 1] - uniq[i]), true);
                        dimV(c, xrBase + 52, Y(0), Y(H), Units.dim(H));
                        for (const o of f.openings) {
                            const xr = fx(o.x1) + 12;
                            if (o.y0 > 1) dimV(c, xr, Y(0), Y(o.y0), Units.dim(o.y0), true);
                            dimV(c, xr, Y(o.y0), Y(Math.min(H, o.y1)), Units.dim(o.y1 - o.y0), true);
                        }
                    }
                }
            }
            if (viewMode === 'unfold' && showDimensions) {
                dimH(c, X(0), X(totalL), Y(0) + 72, `展开总长 ${Units.dim(totalL)}`);
                dimV(c, X(totalL) + 28, Y(0), Y(H), Units.dim(H));
            }
        } finally {
            STATE.showTileMarks = prevShowMarks;
        }

        // 底部标题栏
        const floorPrefix = STATE.floorsEnabled && typeof getCurrentFloor === 'function' && getCurrentFloor()?.name
            ? `${getCurrentFloor().name} · ` : '';
        const viewTitle = viewMode === 'single' && activeFace ? `${activeFace.label}墙立面` : '全墙面展开立面';
        const mainTitle = `${floorPrefix}${room.name || '未命名空间'} · ${viewTitle}`;
        const subTitle = `层高/吊顶 ${Units.dim(H)}  |  ${viewMode === 'single' && activeFace ? `墙长 ${Units.dim(activeFace.lenMM)}` : `共 ${faces.length} 面墙 · 展开总长 ${Units.dim(totalL)}`}`;
        const titleY = oy0 + 132;
        c.save();
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.font = `700 32px ${CANVAS_FONT_SANS}`;
        c.fillStyle = '#0f172a';
        c.fillText(mainTitle, W * 0.5, titleY);
        const tw = c.measureText(mainTitle).width;
        c.strokeStyle = '#334155';
        c.lineWidth = 2;
        c.beginPath();
        c.moveTo(W * 0.5 - tw * 0.55, titleY + 24);
        c.lineTo(W * 0.5 + tw * 0.55, titleY + 24);
        c.stroke();
        c.font = `500 18px ${CANVAS_FONT_SANS}`;
        c.fillStyle = '#64748b';
        c.fillText(subTitle, W * 0.5, titleY + 48);
        c.restore();

        return {
            canvas: exportCanvas,
            room,
            viewMode,
            faceLabel: activeFace ? `${activeFace.label}墙` : '展开立面'
        };
    }

    return {
        init, isActive, enter, selectFace, exit, switchRoom, applyToAllFaces, refresh, setPicking, clearCanvas, render3D, hit3D, setHover3D, checkFocusChange, zoomBy, fit: () => { S.needFit = true; drawElev(); },
        updateZoomText: updateZoomTextElev, renderWallResults, restoreFloorLabels, setCalcMode, syncModeUi,
        syncFloorInputs, syncRoomInputs, syncOpeningInputs, onStateRestored, resetCacheForExport,
        curSelection: () => ({ active: S.active, roomId: S.roomId, faceKey: S.faceKey, view: S.view }),
        getCurrentRoom: curRoom,
        renderColorExportCanvas,
        getRoomFaces, computeFaceLayout, computeAllWallStats, forEachWallZone, ensureNumbers, getCfg, setCfg, defaultCfg, defaultSkirtingCfg, getSkirtingCfg, setSkirtingCfg, roomsWithWallTiling, planElevationSheets, drawElevationSheetsDxf,
        floorH, roomH, opHeight, opSill,
        // 回归测试用：砖缝吸附计算与当前视图（只读）
        _grout: { collectElevGroutRefs, snapElevGrout, view: () => ({ scale: S.scale, panX: S.panX, panY: S.panY, hits: S.hits.map(h => ({ key: h.key, ox: h.ox, x0: h.x0, x1: h.x1, y0: h.y0, y1: h.y1 })), guides: S.drag && S.drag.guides }) }
    };
})();
