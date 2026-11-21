/*************************************************************************
 * 材质库：系统预设（assets/data/materials.json）+ 用户自定义花色（IndexedDB）
 *
 * 统一的“花色”对象：
 *   { id, materialType, name, desc, base, vein, accent, img, custom, kind, prefix }
 *   - kind / prefix：规格编号用的材料类型与前缀（瓷砖 CT / 墙砖 WT / 石材 ST / 地板 WD），新建花色时选择
 *   - 预设：由 JSON 描述；若带 "image" 字段则同样会加载为贴图
 *   - 自定义：贴图 Blob 存于 IndexedDB(tilecalc/styles)，base 为贴图平均色
 * 房间只保存 room.styleId，渲染时统一通过 MaterialLib.get() 取得花色。
 *************************************************************************/
const MaterialLib = (() => {
    const DATA_URL = 'assets/data/materials.json';
    const DB_NAME = 'tilecalc';
    const STORE = 'styles';
    const MAX_TEX_SIDE = 1024;           // 裁剪后贴图最长边上限，超出则缩小存储
    const MAX_INPUT_BYTES = 10 * 1024 * 1024; // 单张原始贴图文件上限 10 MB
    const MAX_TEX_BYTES = 512 * 1024;    // 裁剪贴图压缩入库后体积上限 512 KB
    const MAX_SRC_SIDE = 2048;           // 保存原图的最长边上限（供二次编辑重新裁剪）
    const MAX_SRC_BYTES = 2 * 1024 * 1024; // 保存原图入库体积上限 2 MB

    let catalog = null;
    const presetStyles = new Map();   // id -> style
    const customStyles = new Map();   // id -> style（保持插入顺序 = 创建顺序）
    let dbPromise = null;
    let texturesReadyPromise = Promise.resolve();
    const textureListeners = new Set();

    function notifyTexturesReady() {
        for (const fn of textureListeners) {
            try { fn(); } catch (e) { console.warn('[MaterialLib] 贴图就绪回调异常', e); }
        }
    }

    function onTexturesReady(fn) {
        if (typeof fn !== 'function') return () => {};
        textureListeners.add(fn);
        return () => textureListeners.delete(fn);
    }

    function whenTexturesReady() {
        return texturesReadyPromise;
    }

    /* ---------- IndexedDB（与 StorageDB 共用同一数据库 tilecalc） ---------- */
    function openDb() {
        if (typeof StorageDB !== 'undefined' && StorageDB.openDb) {
            return StorageDB.openDb();
        }
        if (!dbPromise) {
            dbPromise = new Promise((resolve, reject) => {
                if (!window.indexedDB) return reject(new Error('IndexedDB unavailable'));
                const req = indexedDB.open(DB_NAME, 2);
                req.onupgradeneeded = () => {
                    const db = req.result;
                    if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
            dbPromise.catch(() => { dbPromise = null; });
        }
        return dbPromise;
    }

    async function dbRun(mode, fn) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, mode);
            const req = fn(tx.objectStore(STORE));
            tx.oncomplete = () => resolve(req ? req.result : undefined);
            tx.onerror = tx.onabort = () => reject(tx.error);
        });
    }

    /* ---------- 图片工具 ---------- */
    function blobToDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => resolve(fr.result);
            fr.onerror = () => reject(fr.error);
            fr.readAsDataURL(blob);
        });
    }

    async function dataUrlToBlob(dataUrl) {
        return (await fetch(dataUrl)).blob();
    }

    function canvasToBlob(cv, type, q) {
        return new Promise(res => cv.toBlob(res, type, q));
    }

    function averageColor(bitmap) {
        const S = 16;
        const cv = document.createElement('canvas');
        cv.width = cv.height = S;
        const c = cv.getContext('2d', { willReadFrequently: true });
        c.drawImage(bitmap, 0, 0, S, S);
        const d = c.getImageData(0, 0, S, S).data;
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < d.length; i += 4) {
            if (d[i + 3] < 8) continue;
            r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
        }
        const hex = v => Math.round(n ? v / n : 200).toString(16).padStart(2, '0');
        return `#${hex(r)}${hex(g)}${hex(b)}`;
    }

    // 过大的贴图缩小并压缩后存储，避免 IndexedDB 与内存膨胀
    async function normalizeBlob(file, bitmap) {
        if (file.size > MAX_INPUT_BYTES) {
            const err = new Error('贴图文件过大（上限 10MB），请压缩后重新上传');
            err.code = 'IMAGE_TOO_LARGE';
            throw err;
        }
        const side = Math.max(bitmap.width, bitmap.height);
        if (side <= MAX_TEX_SIDE && file.size <= MAX_TEX_BYTES) return file;
        let k = Math.min(1, MAX_TEX_SIDE / side);
        let tw = Math.max(1, Math.round(bitmap.width * k));
        let th = Math.max(1, Math.round(bitmap.height * k));
        const renderJpeg = (w, h, q) => {
            const cv = document.createElement('canvas');
            cv.width = w;
            cv.height = h;
            const ctx = cv.getContext('2d');
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(bitmap, 0, 0, w, h);
            return canvasToBlob(cv, 'image/jpeg', q);
        };
        let out = await renderJpeg(tw, th, 0.88);
        for (const q of [0.76, 0.64, 0.52]) {
            if (out && out.size <= MAX_TEX_BYTES) break;
            out = await renderJpeg(tw, th, q);
        }
        let guard = 0;
        while (out && out.size > MAX_TEX_BYTES && tw > 128 && th > 128 && guard < 3) {
            guard++;
            tw = Math.max(96, Math.round(tw * 0.78));
            th = Math.max(96, Math.round(th * 0.78));
            out = await renderJpeg(tw, th, 0.72);
        }
        return out;
    }

    // 保存未裁剪原图，便于日后修改尺寸/编辑花色时基于原图重新裁剪
    async function normalizeSourceBlob(file) {
        if (!file) return { blob: null, scale: 1 };
        if (file.size > MAX_INPUT_BYTES) {
            const err = new Error('贴图文件过大（上限 10MB），请压缩后重新上传');
            err.code = 'IMAGE_TOO_LARGE';
            throw err;
        }
        const bitmap = await createImageBitmap(file);
        try {
            const origW = bitmap.width, origH = bitmap.height;
            const side = Math.max(origW, origH);
            if (side <= MAX_SRC_SIDE && file.size <= MAX_SRC_BYTES) {
                // 将 File 转为独立 Blob，脱离外部文件句柄，确保 IndexedDB 持久可靠
                const buf = await file.arrayBuffer();
                return { blob: new Blob([buf], { type: file.type || 'image/png' }), scale: 1 };
            }
            let k = Math.min(1, MAX_SRC_SIDE / side);
            let tw = Math.max(1, Math.round(origW * k));
            let th = Math.max(1, Math.round(origH * k));
            const rawType = (file.type || '').toLowerCase();
            const renderOut = (w, h, mime, q) => {
                const cv = document.createElement('canvas');
                cv.width = w;
                cv.height = h;
                const ctx = cv.getContext('2d');
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = 'high';
                ctx.drawImage(bitmap, 0, 0, w, h);
                return canvasToBlob(cv, mime, q);
            };
            let out = rawType === 'image/png' ? await renderOut(tw, th, 'image/png') : await renderOut(tw, th, 'image/jpeg', 0.92);
            for (const q of [0.86, 0.78, 0.68]) {
                if (out && out.size <= MAX_SRC_BYTES) break;
                out = await renderOut(tw, th, 'image/jpeg', q);
            }
            let guard = 0;
            while (out && out.size > MAX_SRC_BYTES && tw > 512 && th > 512 && guard < 3) {
                guard++;
                tw = Math.max(256, Math.round(tw * 0.8));
                th = Math.max(256, Math.round(th * 0.8));
                out = await renderOut(tw, th, 'image/jpeg', 0.76);
            }
            return { blob: out || file, scale: origW > 0 ? tw / origW : 1 };
        } finally {
            bitmap.close();
        }
    }

    function normalizeCropData(d, scale = 1) {
        if (!d || !(Number(d.width) > 0 && Number(d.height) > 0)) return null;
        const k = Number.isFinite(scale) && scale > 0 ? scale : 1;
        return {
            x: Number(d.x || 0) * k,
            y: Number(d.y || 0) * k,
            width: Number(d.width) * k,
            height: Number(d.height) * k,
            rotate: Number(d.rotate || 0),
            scaleX: Number(d.scaleX) === -1 ? -1 : 1,
            scaleY: Number(d.scaleY) === -1 ? -1 : 1
        };
    }

    function shade(hex, f) {
        const n = parseInt(hex.slice(1), 16);
        const ch = s => Math.max(0, Math.min(255, Math.round(((n >> s) & 255) * f)));
        return '#' + [16, 8, 0].map(s => ch(s).toString(16).padStart(2, '0')).join('');
    }

    /* ---------- 花色对象构造 ---------- */
    const normDim = v => {
        const n = Math.round(Number(v));
        return (Number.isFinite(n) && n >= 50 && n <= 3600) ? n : null;
    };
    function createCustomStyleObject(rec, img) {
        const tileW = normDim(rec.tileW);
        const tileH = normDim(rec.tileH);
        const desc = (tileW && tileH) ? `${tileW}×${tileH}mm` : '自定义贴图';
        return {
            id: rec.id, materialType: rec.materialType, name: rec.name, desc,
            base: rec.base, vein: shade(rec.base, 0.85), accent: shade(rec.base, 1.08),
            img: img || null, custom: true, createdAt: rec.createdAt, _blob: rec.blob,
            _srcBlob: rec.srcBlob || null,
            cropData: rec.cropData || null,
            kind: rec.kind || null,
            prefix: rec.prefix != null ? rec.prefix : null,
            sep: rec.sep != null ? rec.sep : null,
            tileW,
            tileH
        };
    }

    async function buildCustomStyle(rec) {
        const img = await createImageBitmap(rec.blob);
        return createCustomStyleObject(rec, img);
    }

    function registerPresets(data) {
        catalog = data.materials;
        presetStyles.clear();
        const tasks = [];
        for (const [type, group] of Object.entries(catalog)) {
            for (const s of group.styles) {
                const st = { desc: '', vein: s.base, accent: s.base, ...s, materialType: type, img: null, custom: false };
                presetStyles.set(st.id, st);
                if (s.image) tasks.push({ st, url: s.image });
            }
        }
        return tasks;
    }

    /* ---------- 公共接口 ---------- */
    async function init() {
        const [data, recs] = await Promise.all([
            fetch(DATA_URL, { cache: 'no-cache' }).then(resp => {
                if (!resp.ok) throw new Error(`${DATA_URL}: HTTP ${resp.status}`);
                return resp.json();
            }),
            dbRun('readonly', s => s.getAll()).catch(e => {
                console.warn('[MaterialLib] 本地花色库不可用（仅预设可用）', e);
                return null;
            })
        ]);

        // 1. 先用纯色即时注册全部预设与自定义花色，避免阻塞首屏与欢迎页弹出
        const presetTasks = registerPresets(data);
        customStyles.clear();
        const customTasks = [];
        if (Array.isArray(recs)) {
            recs.sort((a, b) => a.createdAt - b.createdAt);
            for (const rec of recs) {
                if (!rec || !rec.id || !rec.blob) continue;
                const st = createCustomStyleObject(rec, null);
                customStyles.set(st.id, st);
                customTasks.push({ st, blob: rec.blob });
            }
        }

        // 2. 后台并发拉取并解码全部贴图，就绪后通知视图轻量刷新
        texturesReadyPromise = (async () => {
            let decoded = 0;
            await Promise.all([
                ...presetTasks.map(async ({ st, url }) => {
                    try {
                        const r = await fetch(url);
                        if (!r.ok) return;
                        const bmp = await createImageBitmap(await r.blob());
                        if (presetStyles.get(st.id) === st) {
                            st.img = bmp;
                            decoded++;
                        } else {
                            bmp.close?.();
                        }
                    } catch (e) { /* 贴图缺失时保持纯色渲染 */ }
                }),
                ...customTasks.map(async ({ st, blob }) => {
                    try {
                        const bmp = await createImageBitmap(blob);
                        if (customStyles.get(st.id) === st && !st.img) {
                            st.img = bmp;
                            decoded++;
                        } else {
                            bmp.close?.();
                        }
                    } catch (e) {
                        console.warn('[MaterialLib] 跳过损坏贴图', st.id, e);
                    }
                })
            ]);
            if (decoded > 0) notifyTexturesReady();
        })();
    }

    const sizes = type => (catalog[type] || catalog.tile).sizes;
    const label = type => (catalog[type] || catalog.tile).label;

    const presets = type => [...presetStyles.values()].filter(s => s.materialType === type);
    const customs = type => [...customStyles.values()].filter(s => s.materialType === type);
    const getCustom = id => customStyles.get(id) || null;

    // 取花色；id 缺失/已删除/材质类型不符时回退到该类型的第一个预设
    function get(id, type) {
        const st = presetStyles.get(id) || customStyles.get(id);
        if (st && st.materialType === type) return st;
        return presets(type)[0] || presets('tile')[0];
    }

    const getForRoom = room => get(room.styleId, room.materialType);

    const recOf = st => ({
        id: st.id, materialType: st.materialType, name: st.name, base: st.base, blob: st._blob,
        srcBlob: st._srcBlob || null, cropData: st.cropData || null, createdAt: st.createdAt,
        kind: st.kind || null, prefix: st.prefix ?? null, sep: st.sep ?? null, tileW: st.tileW ?? null, tileH: st.tileH ?? null
    });

    async function addCustom(file, materialType, name, meta = {}) {
        const bitmap = await createImageBitmap(file);
        let blob, base;
        try {
            blob = await normalizeBlob(file, bitmap);
            base = averageColor(bitmap);
        } finally {
            bitmap.close();
        }
        const src = meta.sourceFile ? await normalizeSourceBlob(meta.sourceFile) : { blob: null, scale: 1 };
        const rec = {
            id: 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            materialType,
            name: (name || '').trim() || (file.name || '').replace(/\.[^/.]+$/, '') || '自定义花色',
            base,
            blob,
            srcBlob: src.blob,
            cropData: src.blob ? normalizeCropData(meta.cropData, src.scale) : null,
            createdAt: Date.now(),
            kind: meta.kind || null,
            prefix: meta.prefix != null ? String(meta.prefix).replace(/\s+/g, '').slice(0, 6) : null,
            sep: meta.sep != null ? String(meta.sep).replace(/\s+/g, '').slice(0, 3) : null,
            tileW: normDim(meta.tileW),
            tileH: normDim(meta.tileH)
        };
        await dbRun('readwrite', s => s.put(rec));
        const st = await buildCustomStyle(rec);
        customStyles.set(st.id, st);
        return st;
    }

    async function updateCustom(id, file, name, meta = {}) {
        const old = customStyles.get(id);
        if (!old) return null;
        let blob = old._blob;
        let base = old.base;
        if (file) {
            const bitmap = await createImageBitmap(file);
            try {
                blob = await normalizeBlob(file, bitmap);
                base = averageColor(bitmap);
            } finally {
                bitmap.close();
            }
        }
        let srcBlob = old._srcBlob || null;
        let cropData = old.cropData || null;
        if (meta.sourceFile) {
            const src = await normalizeSourceBlob(meta.sourceFile);
            srcBlob = src.blob;
            cropData = srcBlob ? normalizeCropData(meta.cropData, src.scale) : null;
        } else if (srcBlob && meta.cropData) {
            cropData = normalizeCropData(meta.cropData, 1);
        }
        const rec = {
            id: old.id,
            materialType: old.materialType,
            name: (name || '').trim() || old.name || '自定义花色',
            base,
            blob,
            srcBlob,
            cropData,
            createdAt: old.createdAt,
            kind: meta.kind || null,
            prefix: meta.prefix != null ? String(meta.prefix).replace(/\s+/g, '').slice(0, 6) : null,
            sep: meta.sep != null ? String(meta.sep).replace(/\s+/g, '').slice(0, 3) : null,
            tileW: normDim(meta.tileW),
            tileH: normDim(meta.tileH)
        };
        await dbRun('readwrite', s => s.put(rec));
        const st = await buildCustomStyle(rec);
        customStyles.set(st.id, st);
        old.img?.close?.();
        old.img = null;
        old._blob = null;
        old._srcBlob = null;
        return st;
    }

    async function rename(id, name) {
        const st = customStyles.get(id);
        name = (name || '').trim();
        if (!st || !name) return false;
        await dbRun('readwrite', s => s.put({ ...recOf(st), name }));
        st.name = name;
        return true;
    }

    /** 修改自定义花色的材料类型 / 前缀 */
    async function setMeta(id, kind, prefix) {
        const st = customStyles.get(id);
        if (!st) return false;
        st.kind = kind || null;
        st.prefix = prefix != null ? String(prefix).trim().slice(0, 6) : null;
        await dbRun('readwrite', s => s.put(recOf(st)));
        return true;
    }

    async function remove(id) {
        const st = customStyles.get(id);
        if (!st) return;
        // IndexedDB 记录中同时存储裁剪贴图(blob)与原图(srcBlob)，删除记录时两张图片一并彻底清除
        await dbRun('readwrite', s => s.delete(id));
        st.img?.close?.();
        st.img = null;
        st._blob = null;
        st._srcBlob = null;
        st.cropData = null;
        customStyles.delete(id);
    }

    /* ---------- 工程文件互通 ---------- */
    // 导出：把工程用到的自定义花色一并写入工程 JSON，换电脑也能还原
    async function exportUsed(styleIds) {
        const out = [];
        for (const id of new Set(styleIds)) {
            const st = customStyles.get(id);
            if (st) out.push({
                id, materialType: st.materialType, name: st.name, base: st.base,
                dataUrl: await blobToDataUrl(st._blob),
                srcDataUrl: st._srcBlob ? await blobToDataUrl(st._srcBlob) : null,
                cropData: st.cropData || null,
                createdAt: st.createdAt,
                kind: st.kind || null, prefix: st.prefix ?? null, sep: st.sep ?? null,
                tileW: st.tileW ?? null, tileH: st.tileH ?? null
            });
        }
        return out;
    }

    // 导入：本地不存在的花色写入 IndexedDB
    async function importRecords(records) {
        for (const r of records || []) {
            if (!r || !r.id || !r.dataUrl || customStyles.has(r.id)) continue;
            try {
                const rec = {
                    id: r.id, materialType: r.materialType, name: r.name || '自定义花色', base: r.base || '#cccccc',
                    blob: await dataUrlToBlob(r.dataUrl),
                    srcBlob: r.srcDataUrl ? await dataUrlToBlob(r.srcDataUrl) : null,
                    cropData: r.srcDataUrl ? normalizeCropData(r.cropData, 1) : null,
                    createdAt: r.createdAt || Date.now(),
                    kind: r.kind || null, prefix: r.prefix ?? null, sep: r.sep ?? null,
                    tileW: normDim(r.tileW), tileH: normDim(r.tileH)
                };
                await dbRun('readwrite', s => s.put(rec));
                customStyles.set(rec.id, await buildCustomStyle(rec));
            } catch (e) { console.warn('[MaterialLib] 导入花色失败', r.id, e); }
        }
    }

    return { init, onTexturesReady, whenTexturesReady, sizes, label, presets, customs, getCustom, get, getForRoom, addCustom, updateCustom, rename, setMeta, remove, exportUsed, importRecords };
})();
