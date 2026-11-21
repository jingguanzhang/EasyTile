/*************************************************************************
 * 统一本地存储与图片资源库（IndexedDB）
 * - 数据库：tilecalc (v2)
 *   - styles：MaterialLib 自定义花色贴图（兼容原 v1 数据库，既有花色无损保留）
 *   - kv：程序全部配置、草稿、最近工程、商家信息、报价单与图框缓存（统一替代 localStorage）
 *   - images：除导入底图外的所有上传图片（商家 Logo、图框图片等），内置尺寸/体积限制
 *             与替换/删除/孤儿清理机制，避免残留僵尸资源占用空间
 * - 初始化：启动时 await StorageDB.init() 预热内存缓存并自动迁移旧 localStorage 数据
 *************************************************************************/
const StorageDB = (() => {
    const DB_NAME = 'tilecalc';
    const DB_VERSION = 2;
    const STORE_STYLES = 'styles';
    const STORE_KV = 'kv';
    const STORE_IMAGES = 'images';
    const SYNC_CHANNEL = 'tilecalc-storage-sync';

    const DEFAULT_LIMITS = {
        maxInputBytes: 5 * 1024 * 1024,   // 单张原始文件最大 5 MB
        maxWidth: 1024,
        maxHeight: 1024,
        maxOutputBytes: 512 * 1024        // 入库压缩后最大 512 KB
    };

    const KNOWN_LEGACY_KEYS = [
        'tilecalc.unit',
        'tilecalc.collapsedCards',
        'tilecalc.merchantInfo',
        'tilecalc.quoteData',
        'tilecalc.draft',
        'tilecalc.cadExportFontScales',
        'tilecalc.recentProjects',
        'tilecalc.hideWelcome',
        'tilecalc-applied-frame-v1',
        'tilecalc-frame-context-v1',
        'goukuang-cad-frame-v2'
    ];

    let dbPromise = null;
    let initPromise = null;
    let initialized = false;
    const kvCache = new Map();          // key -> string value
    const dataUrlCache = new Map();     // imageId -> dataUrl string
    const changeListeners = new Set();
    let bc = null;

    function openDb() {
        if (!dbPromise) {
            dbPromise = new Promise((resolve, reject) => {
                if (typeof indexedDB === 'undefined') {
                    return reject(new Error('当前环境不支持 IndexedDB'));
                }
                const req = indexedDB.open(DB_NAME, DB_VERSION);
                req.onupgradeneeded = () => {
                    const db = req.result;
                    if (!db.objectStoreNames.contains(STORE_STYLES)) {
                        db.createObjectStore(STORE_STYLES, { keyPath: 'id' });
                    }
                    if (!db.objectStoreNames.contains(STORE_KV)) {
                        db.createObjectStore(STORE_KV, { keyPath: 'key' });
                    }
                    if (!db.objectStoreNames.contains(STORE_IMAGES)) {
                        const imgStore = db.createObjectStore(STORE_IMAGES, { keyPath: 'id' });
                        imgStore.createIndex('owner', 'owner', { unique: false });
                    }
                };
                req.onsuccess = () => {
                    const db = req.result;
                    db.onversionchange = () => {
                        db.close();
                        dbPromise = null;
                    };
                    resolve(db);
                };
                req.onerror = () => reject(req.error);
            });
            dbPromise.catch(() => { dbPromise = null; });
        }
        return dbPromise;
    }

    async function txRun(storeName, mode, fn) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, mode);
            const store = tx.objectStore(storeName);
            let req = null;
            try {
                req = fn(store, tx);
            } catch (err) {
                try { tx.abort(); } catch (e) { }
                return reject(err);
            }
            tx.oncomplete = () => resolve(req ? req.result : undefined);
            tx.onerror = tx.onabort = () => reject(tx.error || (req && req.error));
        });
    }

    function emitChange(key, value) {
        changeListeners.forEach(fn => {
            try { fn(key, value); } catch (e) { console.warn('[StorageDB] listener error', e); }
        });
    }

    function broadcastChange(key, action, value) {
        if (!bc) return;
        try {
            bc.postMessage({ key, action, value: action === 'set' ? value : null });
        } catch (e) { }
    }

    function setupSyncChannel() {
        if (bc || typeof BroadcastChannel === 'undefined') return;
        try {
            bc = new BroadcastChannel(SYNC_CHANNEL);
            bc.onmessage = (ev) => {
                const msg = ev && ev.data;
                if (!msg || !msg.key) return;
                if (msg.action === 'set') {
                    kvCache.set(msg.key, String(msg.value));
                    emitChange(msg.key, kvCache.get(msg.key));
                } else if (msg.action === 'remove') {
                    kvCache.delete(msg.key);
                    emitChange(msg.key, null);
                } else if (msg.action === 'image-delete') {
                    dataUrlCache.delete(msg.key);
                }
            };
        } catch (e) { bc = null; }
    }

    /* ---------- 图片编解码与压缩限制 ---------- */
    function blobToDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => resolve(String(fr.result || ''));
            fr.onerror = () => reject(fr.error || new Error('读取图片失败'));
            fr.readAsDataURL(blob);
        });
    }

    function dataUrlToBlob(dataUrl) {
        const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(dataUrl || ''));
        if (!m) return Promise.reject(new Error('无效的图片数据'));
        const mime = m[1] || 'image/png';
        const isB64 = !!m[2];
        const body = m[3] || '';
        if (isB64) {
            const bin = atob(body);
            const u8 = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
            return Promise.resolve(new Blob([u8], { type: mime }));
        }
        return Promise.resolve(new Blob([decodeURIComponent(body)], { type: mime }));
    }

    function canvasToBlob(cv, type, quality) {
        return new Promise((resolve) => {
            if (cv.toBlob) {
                cv.toBlob((b) => resolve(b), type, quality);
            } else {
                try {
                    const du = cv.toDataURL(type, quality);
                    dataUrlToBlob(du).then(resolve, () => resolve(null));
                } catch (e) { resolve(null); }
            }
        });
    }

    function loadHtmlImage(src) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('图片解码失败，请确认文件未损坏'));
            img.src = src;
        });
    }

    function formatSizeMB(bytes) {
        return (bytes / (1024 * 1024)).toFixed(bytes >= 1024 * 1024 ? 1 : 2) + 'MB';
    }

    /**
     * 将 File / Blob / dataUrl 规范化为满足尺寸与体积上限的 Blob
     * @returns {Promise<{ blob: Blob, mime: string, width: number, height: number }>}
     */
    async function normalizeImageInput(input, opts = {}) {
        const maxInputBytes = Number(opts.maxInputBytes) || DEFAULT_LIMITS.maxInputBytes;
        const maxWidth = Number(opts.maxWidth) || DEFAULT_LIMITS.maxWidth;
        const maxHeight = Number(opts.maxHeight) || DEFAULT_LIMITS.maxHeight;
        const maxOutputBytes = Number(opts.maxOutputBytes) || DEFAULT_LIMITS.maxOutputBytes;
        const preferPng = opts.preferPng !== false;

        let srcBlob = null;
        let srcDataUrl = '';
        if (typeof input === 'string') {
            if (!input.startsWith('data:image/')) {
                const err = new Error('仅支持图片格式（PNG / JPG / WebP / SVG）');
                err.code = 'INVALID_IMAGE';
                throw err;
            }
            srcBlob = await dataUrlToBlob(input);
            srcDataUrl = input;
        } else if (input instanceof Blob) {
            if (input.type && !input.type.startsWith('image/')) {
                const err = new Error('仅支持图片格式（PNG / JPG / WebP / SVG）');
                err.code = 'INVALID_IMAGE';
                throw err;
            }
            srcBlob = input;
        } else {
            const err = new Error('无效的图片输入');
            err.code = 'INVALID_IMAGE';
            throw err;
        }

        if (srcBlob.size > maxInputBytes) {
            const err = new Error(`图片文件过大（上限 ${formatSizeMB(maxInputBytes)}），请压缩或裁剪后重新上传`);
            err.code = 'IMAGE_TOO_LARGE';
            throw err;
        }

        if (!srcDataUrl) srcDataUrl = await blobToDataUrl(srcBlob);
        const img = await loadHtmlImage(srcDataUrl);
        const nw = img.naturalWidth || img.width || 1;
        const nh = img.naturalHeight || img.height || 1;

        let scale = Math.min(1, maxWidth / nw, maxHeight / nh);
        let tw = Math.max(1, Math.round(nw * scale));
        let th = Math.max(1, Math.round(nh * scale));

        const srcMime = (srcBlob.type || '').toLowerCase();
        const isLossySource = srcMime === 'image/jpeg' || srcMime === 'image/jpg';

        const renderAt = async (w, h, mime, quality, fillWhiteBg) => {
            const cv = document.createElement('canvas');
            cv.width = w;
            cv.height = h;
            const ctx = cv.getContext('2d');
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            if (fillWhiteBg) {
                ctx.fillStyle = '#FFFFFF';
                ctx.fillRect(0, 0, w, h);
            }
            ctx.drawImage(img, 0, 0, w, h);
            return await canvasToBlob(cv, mime, quality);
        };

        let outBlob = null;
        let outMime = 'image/png';

        // 原图未超尺寸且体积合规（非 SVG，SVG 统一栅格化为 PNG 以兼容 Excel/PDF/CAD）
        if (scale === 1 && srcBlob.size <= maxOutputBytes && (srcMime === 'image/png' || srcMime === 'image/jpeg' || srcMime === 'image/webp')) {
            outBlob = srcBlob;
            outMime = srcMime;
        } else if (!isLossySource && preferPng) {
            outBlob = await renderAt(tw, th, 'image/png', undefined, false);
            outMime = 'image/png';
            if (outBlob && outBlob.size > maxOutputBytes) {
                // 优先尝试保留透明通道的 WebP
                for (const q of [0.88, 0.76, 0.62]) {
                    const wb = await renderAt(tw, th, 'image/webp', q, false);
                    if (wb && wb.type === 'image/webp' && wb.size <= maxOutputBytes) {
                        outBlob = wb;
                        outMime = 'image/webp';
                        break;
                    }
                }
            }
        } else {
            outBlob = await renderAt(tw, th, 'image/jpeg', 0.88, true);
            outMime = 'image/jpeg';
        }

        // 若仍超出体积上限，逐步降质量或缩放至合规
        if (!outBlob || outBlob.size > maxOutputBytes) {
            for (const q of [0.85, 0.74, 0.62, 0.50]) {
                const jb = await renderAt(tw, th, 'image/jpeg', q, true);
                if (jb && (!outBlob || jb.size < outBlob.size)) {
                    outBlob = jb;
                    outMime = 'image/jpeg';
                }
                if (outBlob && outBlob.size <= maxOutputBytes) break;
            }
        }
        let guard = 0;
        while (outBlob && outBlob.size > maxOutputBytes && tw > 96 && th > 96 && guard < 4) {
            guard++;
            tw = Math.max(64, Math.round(tw * 0.78));
            th = Math.max(64, Math.round(th * 0.78));
            const jb = await renderAt(tw, th, 'image/jpeg', 0.72, true);
            if (jb) {
                outBlob = jb;
                outMime = 'image/jpeg';
            }
        }

        if (!outBlob || outBlob.size > maxOutputBytes) {
            const err = new Error(`图片压缩后仍超出体积限制（上限 ${Math.round(maxOutputBytes / 1024)}KB），请更换更小的图片`);
            err.code = 'IMAGE_TOO_LARGE';
            throw err;
        }

        return { blob: outBlob, mime: outBlob.type || outMime, width: tw, height: th };
    }

    /* ---------- 一次性从旧 localStorage 迁移 ---------- */
    async function migrateFromLegacyLocalStorage() {
        let ls = null;
        try { ls = window.localStorage; } catch (e) { return; }
        if (!ls) return;

        const keysToMigrate = new Set();
        try {
            for (let i = 0; i < ls.length; i++) {
                const k = ls.key(i);
                if (!k) continue;
                if (k.startsWith('tilecalc.') || KNOWN_LEGACY_KEYS.includes(k)) {
                    keysToMigrate.add(k);
                }
            }
        } catch (e) { }

        for (const k of keysToMigrate) {
            let raw = null;
            try { raw = ls.getItem(k); } catch (e) { continue; }
            if (raw != null && !kvCache.has(k)) {
                kvCache.set(k, raw);
                try {
                    await txRun(STORE_KV, 'readwrite', s => s.put({ key: k, value: raw, updatedAt: Date.now() }));
                } catch (e) { /* 忽略单条迁移错误 */ }
            }
            try { ls.removeItem(k); } catch (e) { }
        }

        // 若商家信息中仍残留旧版内联 logoDataUrl，自动转存至 images 表并清理 KV 中的 base64
        const mRaw = kvCache.get('tilecalc.merchantInfo');
        if (mRaw) {
            try {
                const m = JSON.parse(mRaw);
                if (m && typeof m === 'object' && m.logoDataUrl && !m.logoImageId) {
                    const saved = await saveImage(m.logoDataUrl, {
                        owner: 'merchant-logo',
                        maxWidth: 480,
                        maxHeight: 180,
                        maxOutputBytes: 300 * 1024
                    });
                    delete m.logoDataUrl;
                    m.logoImageId = saved.id;
                    m.logoWidth = saved.width;
                    m.logoHeight = saved.height;
                    await setJSON('tilecalc.merchantInfo', m);
                }
            } catch (e) { /* 忽略损坏旧图 */ }
        }
    }

    /* ---------- 初始化 ---------- */
    function init() {
        if (initialized) return Promise.resolve();
        if (initPromise) return initPromise;
        setupSyncChannel();
        initPromise = (async () => {
            try {
                const recs = await txRun(STORE_KV, 'readonly', s => s.getAll());
                if (Array.isArray(recs)) {
                    for (const rec of recs) {
                        if (rec && typeof rec.key === 'string') {
                            kvCache.set(rec.key, rec.value == null ? '' : String(rec.value));
                        }
                    }
                }
                await migrateFromLegacyLocalStorage();
            } catch (err) {
                console.warn('[StorageDB] IndexedDB 初始化降级为内存模式：', err);
            }
            initialized = true;
        })();
        return initPromise;
    }

    /* ---------- KV 读写接口 ---------- */
    function get(key, fallback = null) {
        return kvCache.has(key) ? kvCache.get(key) : fallback;
    }

    function getJSON(key, fallback = null) {
        const raw = get(key, null);
        if (raw == null || raw === '') return fallback;
        try { return JSON.parse(raw); } catch (e) { return fallback; }
    }

    function set(key, value) {
        const str = value == null ? '' : String(value);
        kvCache.set(key, str);
        broadcastChange(key, 'set', str);
        return txRun(STORE_KV, 'readwrite', s => s.put({ key, value: str, updatedAt: Date.now() }))
            .catch(err => { console.warn('[StorageDB] set failed:', key, err); });
    }

    function setJSON(key, obj) {
        return set(key, JSON.stringify(obj));
    }

    function remove(key) {
        kvCache.delete(key);
        broadcastChange(key, 'remove', null);
        return txRun(STORE_KV, 'readwrite', s => s.delete(key))
            .catch(err => { console.warn('[StorageDB] remove failed:', key, err); });
    }

    async function refreshKey(key) {
        try {
            const rec = await txRun(STORE_KV, 'readonly', s => s.get(key));
            if (rec && rec.value != null) {
                kvCache.set(key, String(rec.value));
                return kvCache.get(key);
            }
            kvCache.delete(key);
            return null;
        } catch (err) {
            return get(key, null);
        }
    }

    async function refreshJSON(key, fallback = null) {
        const raw = await refreshKey(key);
        if (raw == null || raw === '') return fallback;
        try { return JSON.parse(raw); } catch (e) { return fallback; }
    }

    function onChange(cb) {
        if (typeof cb === 'function') changeListeners.add(cb);
        return () => changeListeners.delete(cb);
    }

    /* ---------- 图片资源库接口（带尺寸/体积限制与防僵尸清理） ---------- */
    async function saveImage(fileOrDataUrl, opts = {}) {
        const norm = await normalizeImageInput(fileOrDataUrl, opts);
        const id = 'img_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
        const owner = String(opts.owner || 'general');
        const rec = {
            id,
            owner,
            blob: norm.blob,
            mime: norm.mime,
            width: norm.width,
            height: norm.height,
            bytes: norm.blob.size,
            updatedAt: Date.now()
        };
        await txRun(STORE_IMAGES, 'readwrite', s => s.put(rec));
        const dataUrl = await blobToDataUrl(norm.blob);
        dataUrlCache.set(id, dataUrl);
        return { id, owner, dataUrl, width: rec.width, height: rec.height, bytes: rec.bytes, mime: rec.mime };
    }

    async function getImage(id) {
        if (!id) return null;
        try {
            const rec = await txRun(STORE_IMAGES, 'readonly', s => s.get(id));
            if (!rec || !rec.blob) return null;
            let dataUrl = dataUrlCache.get(id);
            if (!dataUrl) {
                dataUrl = await blobToDataUrl(rec.blob);
                dataUrlCache.set(id, dataUrl);
            }
            return {
                id: rec.id,
                owner: rec.owner,
                blob: rec.blob,
                dataUrl,
                mime: rec.mime,
                width: rec.width,
                height: rec.height,
                bytes: rec.bytes
            };
        } catch (err) {
            console.warn('[StorageDB] getImage failed:', id, err);
            return null;
        }
    }

    async function getImageDataUrl(id) {
        if (!id) return '';
        if (dataUrlCache.has(id)) return dataUrlCache.get(id);
        const rec = await getImage(id);
        return rec ? rec.dataUrl : '';
    }

    async function deleteImage(id) {
        if (!id) return;
        dataUrlCache.delete(id);
        broadcastChange(id, 'image-delete', null);
        try {
            await txRun(STORE_IMAGES, 'readwrite', s => s.delete(id));
        } catch (err) {
            console.warn('[StorageDB] deleteImage failed:', id, err);
        }
    }

    /** 先存新图、成功后立即删除旧图，保证替换失败时不丢旧图且不留僵尸图 */
    async function replaceImage(oldId, fileOrDataUrl, opts = {}) {
        const next = await saveImage(fileOrDataUrl, opts);
        if (oldId && oldId !== next.id) {
            await deleteImage(oldId);
        }
        return next;
    }

    /** 清理指定 owner 下未被 keepIds 引用的所有僵尸图片 */
    async function pruneOwnerImages(owner, keepIds = []) {
        if (!owner) return 0;
        const keep = keepIds instanceof Set ? keepIds : new Set(keepIds || []);
        let removed = 0;
        try {
            const db = await openDb();
            const staleIds = await new Promise((resolve, reject) => {
                const tx = db.transaction(STORE_IMAGES, 'readonly');
                const store = tx.objectStore(STORE_IMAGES);
                const req = store.indexNames.contains('owner')
                    ? store.index('owner').getAllKeys(owner)
                    : store.getAll();
                tx.oncomplete = () => {
                    const res = req.result || [];
                    if (store.indexNames.contains('owner')) {
                        resolve(res.filter(id => !keep.has(id)));
                    } else {
                        resolve(res.filter(r => r && r.owner === owner && !keep.has(r.id)).map(r => r.id));
                    }
                };
                tx.onerror = tx.onabort = () => reject(tx.error);
            });
            if (staleIds.length > 0) {
                await new Promise((resolve, reject) => {
                    const tx = db.transaction(STORE_IMAGES, 'readwrite');
                    const store = tx.objectStore(STORE_IMAGES);
                    for (const id of staleIds) {
                        store.delete(id);
                        dataUrlCache.delete(id);
                        broadcastChange(id, 'image-delete', null);
                    }
                    tx.oncomplete = () => resolve();
                    tx.onerror = tx.onabort = () => reject(tx.error);
                });
                removed = staleIds.length;
            }
        } catch (err) {
            console.warn('[StorageDB] pruneOwnerImages failed:', owner, err);
        }
        return removed;
    }

    return {
        DB_NAME,
        DB_VERSION,
        STORE_STYLES,
        STORE_KV,
        STORE_IMAGES,
        DEFAULT_LIMITS,
        openDb,
        init,
        get,
        getJSON,
        set,
        setJSON,
        remove,
        refreshKey,
        refreshJSON,
        onChange,
        saveImage,
        getImage,
        getImageDataUrl,
        deleteImage,
        replaceImage,
        pruneOwnerImages,
        blobToDataUrl,
        dataUrlToBlob
    };
})();
