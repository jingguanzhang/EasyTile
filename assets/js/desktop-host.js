/*************************************************************************
 * 桌面宿主（WebView2 HostBridge）公共适配层
 * - 当运行在 WebView2 桌面壳内时，自动通过 window.HostBridge v2 API 提供：
 *   1. 原生文件打开 / 覆盖保存 / 另存为 / 文件关联启动与拖放打开
 *   2. 所有导出的原生保存弹窗（跳过浏览器默认下载栏，写入真实标准格式文件）
 *   3. 独立原生子窗体打开、关闭、父子窗体双向消息通信（替代 iframe 弹窗）
 * - 当运行在普通浏览器静态服务时，透明降级为 <input type="file"> / <a download> / iframe
 *************************************************************************/
const DesktopHost = (() => {
    function hb() {
        return typeof window !== 'undefined' && window.HostBridge ? window.HostBridge : null;
    }

    function isDesktop() {
        const b = hb();
        return !!(b && typeof b.available === 'function' && b.available());
    }

    function extOf(filename) {
        const m = /\.([^.\\/]+)$/.exec(String(filename || ''));
        return m ? ('.' + m[1].toLowerCase()) : '';
    }

    function buildFileFilter(filename) {
        const ext = extOf(filename);
        switch (ext) {
            case '.tcalc':
                return 'EasyTile 工程文件 (*.tcalc)|*.tcalc|JSON 文件 (*.json)|*.json|所有文件 (*.*)|*.*';
            case '.json':
                return 'JSON 文件 (*.json)|*.json|所有文件 (*.*)|*.*';
            case '.js':
                return 'JavaScript 文件 (*.js)|*.js|所有文件 (*.*)|*.*';
            case '.dxf':
                return 'AutoCAD DXF 图纸 (*.dxf)|*.dxf|所有文件 (*.*)|*.*';
            case '.dwg':
                return 'AutoCAD DWG 图纸 (*.dwg)|*.dwg|所有文件 (*.*)|*.*';
            case '.pdf':
                return 'PDF 文档 (*.pdf)|*.pdf|所有文件 (*.*)|*.*';
            case '.xlsx':
                return 'Excel 工作簿 (*.xlsx)|*.xlsx|所有文件 (*.*)|*.*';
            case '.jpg':
            case '.jpeg':
                return 'JPEG 高清图片 (*.jpg;*.jpeg)|*.jpg;*.jpeg|所有文件 (*.*)|*.*';
            case '.png':
                return 'PNG 图片 (*.png)|*.png|所有文件 (*.*)|*.*';
            default:
                return '所有文件 (*.*)|*.*';
        }
    }

    function blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const s = String(reader.result || '');
                const idx = s.indexOf(',');
                resolve(idx >= 0 ? s.slice(idx + 1) : s);
            };
            reader.onerror = () => reject(reader.error || new Error('读取文件数据失败'));
            reader.readAsDataURL(blob);
        });
    }

    async function uint8ToBase64(u8) {
        return blobToBase64(new Blob([u8]));
    }

    async function saveBlob(blobOrContent, filename, opts = {}) {
        const name = String(filename || 'export.bin');
        if (isDesktop() && hb().files) {
            const ext = extOf(name);
            const isTextExt = ext === '.tcalc' || ext === '.json' || ext === '.js' || ext === '.txt';
            let encoding = opts.encoding;
            let content = '';

            if (typeof blobOrContent === 'string') {
                encoding = encoding || 'utf8';
                if (encoding === 'base64') {
                    content = await blobToBase64(new Blob([blobOrContent], { type: 'text/plain;charset=utf-8' }));
                } else {
                    content = blobOrContent;
                }
            } else if (blobOrContent instanceof Blob) {
                if (encoding === 'utf8' || (isTextExt && !encoding)) {
                    encoding = 'utf8';
                    content = await blobOrContent.text();
                } else {
                    encoding = 'base64';
                    content = await blobToBase64(blobOrContent);
                }
            } else if (blobOrContent instanceof Uint8Array || blobOrContent instanceof ArrayBuffer) {
                const u8 = blobOrContent instanceof Uint8Array ? blobOrContent : new Uint8Array(blobOrContent);
                encoding = 'base64';
                content = await uint8ToBase64(u8);
            } else {
                const str = String(blobOrContent ?? '');
                encoding = encoding || 'utf8';
                content = encoding === 'base64'
                    ? await blobToBase64(new Blob([str], { type: 'text/plain;charset=utf-8' }))
                    : str;
            }

            const saveOpts = {
                encoding,
                filter: opts.filter || buildFileFilter(name),
                suggestedName: name,
                saveAs: opts.saveAs !== false,
                content
            };
            if (opts.path) saveOpts.path = opts.path;
            if (opts.revision != null) saveOpts.revision = opts.revision;

            const reply = await hb().files.save(saveOpts);
            if (!reply || reply.cancelled) {
                return { saved: false, cancelled: true, path: null, name, revision: null };
            }
            return {
                saved: true,
                cancelled: false,
                path: reply.path || null,
                name: reply.name || name,
                revision: reply.revision || null
            };
        }

        // 浏览器降级：创建临时 Blob 下载链接
        const blob = blobOrContent instanceof Blob
            ? blobOrContent
            : new Blob([blobOrContent], { type: opts.mime || 'application/octet-stream' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 600);
        return { saved: true, cancelled: false, path: null, name, revision: null };
    }

    async function openTextFile({ filter } = {}) {
        if (!isDesktop() || !hb().files) return null;
        const reply = await hb().files.open({
            encoding: 'utf8',
            filter: filter || '所有文件 (*.*)|*.*'
        });
        if (!reply || reply.cancelled) {
            return { cancelled: true, path: null, name: null, content: null, revision: null };
        }
        return {
            cancelled: false,
            path: reply.path || null,
            name: reply.name || '',
            content: reply.content || '',
            revision: reply.revision || null
        };
    }

    async function readTextFile(path) {
        if (!isDesktop() || !hb().files) return null;
        const reply = await hb().files.read({ path, encoding: 'utf8' });
        if (!reply || reply.cancelled) return null;
        return {
            path: reply.path || path,
            name: reply.name || '',
            content: reply.content || '',
            revision: reply.revision || null
        };
    }

    async function openChildWindow(options) {
        if (!isDesktop() || !hb().windows) return null;
        return await hb().windows.open(Object.assign({ frameless: true }, options));
    }

    async function closeChildWindow(id) {
        if (!isDesktop() || !hb().windows) return null;
        try {
            return await hb().windows.close(id);
        } catch (e) {
            return null;
        }
    }

    async function minimizeSelf() {
        if (!isDesktop()) return null;
        const b = hb();
        try {
            if (b.window && typeof b.window.minimize === 'function') return await b.window.minimize();
            if (typeof b.minimize === 'function') return await b.minimize();
        } catch (e) { }
        return null;
    }

    async function toggleMaximizeSelf() {
        if (!isDesktop()) return null;
        const b = hb();
        try {
            if (b.window && typeof b.window.toggleMaximize === 'function') return await b.window.toggleMaximize();
            if (typeof b.toggleMaximize === 'function') return await b.toggleMaximize();
        } catch (e) { }
        return null;
    }

    async function closeSelf() {
        if (isDesktop()) {
            const b = hb();
            try {
                if (b.window && typeof b.window.close === 'function') {
                    return await b.window.close();
                }
                if (typeof b.close === 'function') {
                    return await b.close();
                }
            } catch (e) {
                return null;
            }
        }
        if (window.parent && window.parent !== window) {
            try { window.parent.postMessage({ type: 'tilecalc-child-close' }, '*'); } catch (e) { }
            return null;
        }
        try { window.close(); } catch (e) { }
        return null;
    }

    function bindWindowControls({ minBtn, maxBtn, closeBtn } = {}) {
        const b = hb();
        if (maxBtn && isDesktop() && b) {
            const syncMax = (winState) => {
                const isMax = winState === 'maximized' || winState === 'fullscreen';
                const icon = maxBtn.querySelector('i');
                if (icon) icon.className = isMax ? 'ph ph-copy-simple' : 'ph ph-square';
                const label = isMax ? '还原窗口' : '最大化';
                maxBtn.title = label;
                maxBtn.setAttribute('aria-label', label);
            };
            if (b.window && typeof b.window.getState === 'function') {
                b.window.getState().then(syncMax).catch(() => {});
            } else if (typeof b.getWindowState === 'function') {
                b.getWindowState().then(syncMax).catch(() => {});
            }
            if (typeof b.onWindowStateChange === 'function') {
                b.onWindowStateChange(syncMax);
            }
        }
        if (minBtn && !minBtn.hasAttribute('data-host-action')) {
            minBtn.addEventListener('click', () => minimizeSelf());
        }
        if (maxBtn && !maxBtn.hasAttribute('data-host-action')) {
            maxBtn.addEventListener('click', () => toggleMaximizeSelf());
        }
        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                if (!isDesktop() || !closeBtn.hasAttribute('data-host-action')) {
                    closeSelf();
                }
            });
        }
    }

    async function postToChild(id, payload) {
        if (!isDesktop() || !hb().windows) return null;
        try {
            return await hb().windows.post(id, payload);
        } catch (e) {
            return null;
        }
    }

    async function postToOpener(payload) {
        if (isDesktop() && hb().windows) {
            try {
                return await hb().windows.postToOpener(payload);
            } catch (e) {
                return null;
            }
        }
        if (window.parent && window.parent !== window) {
            try { window.parent.postMessage(payload, '*'); } catch (e) { }
        }
        return null;
    }

    function onChildEvent(cb) {
        if (typeof cb !== 'function') return () => {};
        if (isDesktop() && hb().windows && typeof hb().windows.onEvent === 'function') {
            return hb().windows.onEvent(cb);
        }
        return () => {};
    }

    function onOpenerMessage(cb) {
        if (typeof cb !== 'function') return () => {};
        const unsubs = [];
        if (isDesktop() && hb().windows && typeof hb().windows.onEvent === 'function') {
            unsubs.push(hb().windows.onEvent((ev) => {
                if (ev && ev.event === 'message') cb(ev.payload, ev);
            }));
        }
        const winHandler = (e) => cb(e.data, e);
        window.addEventListener('message', winHandler);
        unsubs.push(() => window.removeEventListener('message', winHandler));
        return () => unsubs.forEach(u => { try { u(); } catch (e) { } });
    }

    function onUpdateAvailable(cb) {
        if (typeof cb !== 'function' || !isDesktop()) return () => {};
        const b = hb();
        if (b.updates && typeof b.updates.onAvailable === 'function') {
            return b.updates.onAvailable(cb);
        }
        if (b.events && typeof b.events.on === 'function') {
            return b.events.on('updateAvailable', cb);
        }
        return () => {};
    }

    function getLastUpdate() {
        if (!isDesktop()) return null;
        const b = hb();
        return (b.updates && typeof b.updates.getLast === 'function') ? b.updates.getLast() : null;
    }

    async function openExternalUrl(url) {
        const target = String(url || '').trim();
        if (!/^https?:\/\//i.test(target)) {
            throw new Error('仅支持打开有效的 HTTP / HTTPS 链接');
        }
        if (isDesktop()) {
            const b = hb();
            if (b.updates && typeof b.updates.openDownload === 'function') {
                return await b.updates.openDownload(target);
            }
            if (b.app && typeof b.app.openExternal === 'function') {
                return await b.app.openExternal(target);
            }
        }
        window.open(target, '_blank', 'noopener,noreferrer');
        return null;
    }

    function onFileOpen(cb) {
        if (typeof cb !== 'function' || !isDesktop()) return () => {};
        const b = hb();
        if (b.files && typeof b.files.onOpen === 'function') {
            return b.files.onOpen(cb);
        }
        return () => {};
    }

    function enableFileDrop(element, onError) {
        if (!isDesktop()) return () => {};
        const b = hb();
        if (b.files && typeof b.files.enableDrop === 'function') {
            return b.files.enableDrop(element || document.body, onError);
        }
        return () => {};
    }

    async function signalFilesReady() {
        if (!isDesktop()) return null;
        const b = hb();
        if (b.files && typeof b.files.ready === 'function') {
            return await b.files.ready();
        }
        return null;
    }

    const external = {
        async getDirs() {
            if (!isDesktop() || !hb().external || typeof hb().external.getDirs !== 'function') return [];
            return await hb().external.getDirs();
        },
        async listFiles(dir, options) {
            if (!isDesktop() || !hb().external || typeof hb().external.listFiles !== 'function') {
                return { dir: String(dir || ''), exists: false, files: [] };
            }
            return await hb().external.listFiles(dir, options);
        },
        async exists(dir, relativePath) {
            if (!isDesktop() || !hb().external || typeof hb().external.exists !== 'function') return false;
            return await hb().external.exists(dir, relativePath);
        },
        getUrl(dir, relativePath) {
            if (isDesktop() && hb().external && typeof hb().external.getUrl === 'function') {
                return hb().external.getUrl(dir, relativePath);
            }
            const segs = String(dir || '').replace(/\\/g, '/').split('/').filter(Boolean);
            if (relativePath != null && String(relativePath) !== '') {
                segs.push(...String(relativePath).replace(/\\/g, '/').split('/').filter(Boolean));
            }
            return './' + segs.map(encodeURIComponent).join('/');
        }
    };

    return {
        isDesktop,
        buildFileFilter,
        blobToBase64,
        saveBlob,
        openTextFile,
        readTextFile,
        openChildWindow,
        closeChildWindow,
        minimizeSelf,
        toggleMaximizeSelf,
        closeSelf,
        bindWindowControls,
        postToChild,
        postToOpener,
        onChildEvent,
        onOpenerMessage,
        onUpdateAvailable,
        getLastUpdate,
        openExternalUrl,
        onFileOpen,
        enableFileDrop,
        signalFilesReady,
        external
    };
})();
