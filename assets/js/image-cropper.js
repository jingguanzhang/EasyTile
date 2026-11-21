/*************************************************************************
 * 图片上传裁剪窗口（基于本地 assets/vendor/cropperjs，Cropper.js v1.6.2）
 *
 * 用法：
 *   const file2 = await ImageCropDialog.pick(file, {
 *       title: '裁剪户型图',               // 窗口标题
 *       hint:  '框选需要识别的户型区域',     // 标题旁说明
 *       aspect: NaN,                       // 默认比例，NaN = 自由
 *       presets: [{ label: '砖块 800×800', ratio: 1 }],  // 额外比例选项
 *       maxSize: 4096,                     // 输出最长边上限 (px)
 *       step: '1 / 3'                      // 批量上传时显示的进度
 *   });
 *   // 返回裁剪后的 File；点「使用原图」返回原 File；取消返回 null
 *
 * 未加载 Cropper.js 时直接返回原文件，保证上传流程不被阻断。
 *************************************************************************/
const ImageCropDialog = (() => {
    let root = null;
    let cropper = null;
    let active = null;           // { resolve, file, url, opts }
    let scaleX = 1, scaleY = 1;

    const BASE_PRESETS = [
        { label: '自由', ratio: NaN },
        { label: '原图比例', ratio: 'original' },
        { label: '1 : 1', ratio: 1 },
        { label: '4 : 3', ratio: 4 / 3 },
        { label: '16 : 9', ratio: 16 / 9 }
    ];

    function build() {
        if (root) return root;
        root = document.createElement('div');
        root.id = 'crop-modal';
        root.className = 'crop-modal hidden';
        root.innerHTML = `
            <div class="crop-window" role="dialog" aria-modal="true" aria-labelledby="crop-title">
                <div class="crop-head">
                    <div class="crop-head-text">
                        <h3 id="crop-title" class="crop-title">裁剪图片</h3>
                        <span id="crop-hint" class="crop-hint"></span>
                    </div>
                    <span id="crop-step" class="ui-badge font-mono hidden"></span>
                    <button id="crop-close" type="button" class="ws-close" title="取消 (Esc)" aria-label="取消"><i class="ph ph-x text-xs"></i></button>
                </div>
                <div class="crop-toolbar">
                    <div id="crop-ratios" class="segmented-group-4 crop-ratios" role="group" aria-label="裁剪比例"></div>
                    <div class="crop-tools">
                        <button type="button" class="ui-btn ui-btn-sm crop-icon" data-act="rotate-l" title="向左旋转 90°"><i class="ph ph-arrow-counter-clockwise"></i></button>
                        <button type="button" class="ui-btn ui-btn-sm crop-icon" data-act="rotate-r" title="向右旋转 90°"><i class="ph ph-arrow-clockwise"></i></button>
                        <button type="button" class="ui-btn ui-btn-sm crop-icon" data-act="flip-h" title="水平翻转"><i class="ph ph-flip-horizontal"></i></button>
                        <button type="button" class="ui-btn ui-btn-sm crop-icon" data-act="flip-v" title="垂直翻转"><i class="ph ph-flip-vertical"></i></button>
                        <span class="crop-sep"></span>
                        <button type="button" class="ui-btn ui-btn-sm crop-icon" data-act="zoom-out" title="缩小"><i class="ph ph-magnifying-glass-minus"></i></button>
                        <button type="button" class="ui-btn ui-btn-sm crop-icon" data-act="zoom-in" title="放大"><i class="ph ph-magnifying-glass-plus"></i></button>
                        <button type="button" class="ui-btn ui-btn-sm" data-act="reset" title="恢复为整张图片">重置</button>
                    </div>
                </div>
                <div class="crop-stage"><img id="crop-img" alt="待裁剪图片"></div>
                <div class="crop-foot">
                    <span id="crop-info" class="crop-info font-mono"></span>
                    <div class="crop-actions">
                        <button id="crop-skip" type="button" class="ui-btn">使用原图</button>
                        <button id="crop-cancel" type="button" class="ui-btn">取消</button>
                        <button id="crop-ok" type="button" class="ui-btn ui-btn-primary">确定裁剪</button>
                    </div>
                </div>
            </div>`;
        document.body.appendChild(root);

        root.querySelector('#crop-close').addEventListener('click', () => finish(null));
        root.querySelector('#crop-cancel').addEventListener('click', () => finish(null));
        root.querySelector('#crop-skip').addEventListener('click', () => finish(active?.file || null));
        root.querySelector('#crop-ok').addEventListener('click', confirm);
        root.addEventListener('mousedown', e => { if (e.target === root) finish(null); });
        root.querySelector('.crop-tools').addEventListener('click', e => {
            const b = e.target.closest('[data-act]');
            if (!b || !cropper) return;
            switch (b.dataset.act) {
                case 'rotate-l': cropper.rotate(-90); break;
                case 'rotate-r': cropper.rotate(90); break;
                case 'flip-h': scaleX = -scaleX; cropper.scaleX(scaleX); break;
                case 'flip-v': scaleY = -scaleY; cropper.scaleY(scaleY); break;
                case 'zoom-in': cropper.zoom(0.1); break;
                case 'zoom-out': cropper.zoom(-0.1); break;
                case 'reset': scaleX = scaleY = 1; cropper.reset(); cropper.setCropBoxData(cropper.getCanvasData()); break;
            }
        });
        // 捕获阶段拦截键盘，避免触发画布快捷键（Esc / Delete / V 等）
        window.addEventListener('keydown', e => {
            if (!active) return;
            if (e.key === 'Escape') { e.preventDefault(); finish(null); }
            else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); confirm(); }
            e.stopImmediatePropagation();
        }, true);
        return root;
    }

    function renderRatios(opts) {
        const box = root.querySelector('#crop-ratios');
        const list = [...BASE_PRESETS, ...(opts.presets || [])];
        box.style.gridTemplateColumns = `repeat(${list.length}, auto)`;
        box.replaceChildren(...list.map((p, i) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'segmented-btn';
            b.textContent = p.label;
            b.dataset.idx = String(i);
            b.addEventListener('click', () => setRatio(p.ratio, b));
            return b;
        }));
        // 选中默认比例按钮
        const want = opts.aspect;
        let idx = list.findIndex(p => (Number.isNaN(want) && Number.isNaN(p.ratio)) || p.ratio === want);
        if (idx < 0) idx = 0;
        markRatio(box.children[idx]);
        return list[idx].ratio;
    }

    function markRatio(btn) {
        root.querySelectorAll('#crop-ratios .segmented-btn').forEach(b => b.classList.toggle('active-tile', b === btn));
    }

    function resolveRatio(r) {
        if (r === 'original') {
            const d = cropper ? cropper.getImageData() : null;
            return d && d.naturalHeight ? d.naturalWidth / d.naturalHeight : NaN;
        }
        return r;
    }

    function setRatio(r, btn) {
        markRatio(btn);
        if (cropper) cropper.setAspectRatio(resolveRatio(r));
    }

    function updateInfo() {
        if (!cropper) return;
        const d = cropper.getData(true);
        const img = cropper.getImageData();
        root.querySelector('#crop-info').textContent =
            `原图 ${img.naturalWidth}×${img.naturalHeight} px  ·  裁剪 ${Math.max(0, d.width)}×${Math.max(0, d.height)} px`;
    }

    function outputType(file) {
        const t = (file.type || '').toLowerCase();
        if (t === 'image/jpeg' || t === 'image/webp') return t;
        return 'image/png';
    }

    function confirm() {
        if (!active || !cropper) return;
        const { file, opts } = active;
        const type = outputType(file);
        const max = opts.maxSize || 4096;
        const canvas = cropper.getCroppedCanvas({
            maxWidth: max, maxHeight: max,
            imageSmoothingEnabled: true, imageSmoothingQuality: 'high',
            fillColor: type === 'image/png' ? 'transparent' : '#ffffff'
        });
        if (!canvas) { finish(file); return; }
        const okBtn = root.querySelector('#crop-ok');
        okBtn.disabled = true;
        canvas.toBlob(blob => {
            okBtn.disabled = false;
            if (!blob) { finish(file); return; }
            const ext = type === 'image/jpeg' ? '.jpg' : type === 'image/webp' ? '.webp' : '.png';
            const name = (file.name || 'image').replace(/\.[^/.]+$/, '') + ext;
            let out;
            try { out = new File([blob], name, { type, lastModified: Date.now() }); }
            catch (e) { out = blob; out.name = name; }
            finish(out);
        }, type, 0.92);
    }

    function finish(result) {
        if (!active) return;
        const { resolve, url } = active;
        active = null;
        if (cropper) { cropper.destroy(); cropper = null; }
        URL.revokeObjectURL(url);
        root.classList.add('hidden');
        resolve(result);
    }

    function pick(file, opts = {}) {
        if (!file) return Promise.resolve(null);
        if (typeof window.Cropper !== 'function') return Promise.resolve(file);   // 库缺失时不阻断上传
        if (active) finish(null);
        build();
        return new Promise(resolve => {
            const url = URL.createObjectURL(file);
            active = { resolve, file, url, opts };
            scaleX = scaleY = 1;
            root.querySelector('#crop-title').textContent = opts.title || '裁剪图片';
            root.querySelector('#crop-hint').textContent = opts.hint || '';
            const stepEl = root.querySelector('#crop-step');
            stepEl.textContent = opts.step || '';
            stepEl.classList.toggle('hidden', !opts.step);
            root.querySelector('#crop-info').textContent = '';
            const initRatio = renderRatios(opts);

            const img = root.querySelector('#crop-img');
            img.onerror = () => { if (typeof showToast === 'function') showToast('无法读取该图片'); finish(null); };
            img.onload = () => {
                if (!active || active.url !== url) return;
                cropper = new window.Cropper(img, {
                    viewMode: 1,
                    dragMode: 'move',
                    autoCropArea: 1,
                    background: true,
                    responsive: true,
                    restore: false,
                    toggleDragModeOnDblclick: false,
                    ready() {
                        if (!active) return;
                        cropper.setAspectRatio(resolveRatio(initRatio));
                        updateInfo();
                    },
                    crop: updateInfo
                });
            };
            root.classList.remove('hidden');
            img.src = url;
            setTimeout(() => root.querySelector('#crop-ok').focus(), 0);
        });
    }

    return { pick, isOpen: () => !!active };
})();
window.ImageCropDialog = ImageCropDialog;
