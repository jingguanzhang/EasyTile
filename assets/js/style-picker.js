/*************************************************************************
 * 花色选择管理器（弹窗）
 * - 系统预设（materials.json）与自定义花色（IndexedDB）显示在同一个列表中：
 *   系统预设带「系统」标签，不可删除/重命名；自定义花色带「自定义」标签，可重命名/删除
 * - “添加花色”：选择图片 → 裁剪窗口（Cropper.js）→ 命名保存
 * 依赖 app.js 全局：STATE、getSelectedRoom、saveHistory、render、render3DIsometricPreview、
 *                  syncLeftPanelFromSelectedRoom、drawMaterialSwatch、showToast
 *************************************************************************/
const StylePicker = (() => {
    const $ = id => document.getElementById(id);
    let addSession = null;       // 整合后的新增+裁剪弹窗会话 { file, url, cropper, scaleX, scaleY, resolve, isBatch }
    let armedDeleteId = null;    // 已点击一次删除、等待确认的花色
    // 非空间的选色目标（如门洞过门石）：{ type, selectedId, sub, crop:{w,h}, onPick(id) }
    let target = null;

    const modalType = () => target ? target.type : ((getSelectedRoom()?.materialType) || 'tile');
    const isOpen = () => !$('style-picker-modal').classList.contains('hidden');
    const isAddOpen = () => !!addSession;

    function el(tag, cls, text) {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined) n.textContent = text;
        return n;
    }

    function iconBtn(icon, title, onClick, extraCls = '') {
        const b = el('button', 'sp-icon-btn ' + extraCls);
        b.type = 'button';
        b.title = title;
        b.innerHTML = `<i class="ph ph-${icon}"></i>`;
        b.addEventListener('click', e => { e.stopPropagation(); onClick(b); });
        return b;
    }

    function makeCard(st, type, selectedId) {
        const card = el('div', 'sp-card' + (st.id === selectedId ? ' selected' : ''));
        card.tabIndex = 0;
        card.dataset.id = st.id;
        const cv = el('canvas', 'sp-card-cv');
        cv.width = 160; cv.height = 112;
        drawMaterialSwatch(cv, type, st);
        card.appendChild(cv);
        const meta = el('div', 'sp-card-meta');
        const name = el('div', 'sp-card-name', st.name);
        name.title = st.name;
        meta.appendChild(name);
        meta.appendChild(el('span', 'sp-tag' + (st.custom ? ' is-custom' : ''), st.custom ? '自定义' : '系统'));
        if (st.kind || st.prefix) {
            const pre = st.prefix || (typeof specKindPrefix === 'function' ? specKindPrefix(type, st.kind) : '');
            meta.appendChild(el('span', 'sp-tag sp-tag-kind', `${st.kind || ''} ${pre}`.trim()));
        }
        card.appendChild(meta);
        card.appendChild(el('div', 'sp-card-desc', st.desc || ' '));
        if (st.id === selectedId) card.appendChild(el('span', 'sp-check', '✓'));

        if (st.custom) {
            const acts = el('div', 'sp-card-actions');
            acts.appendChild(iconBtn('pencil-simple', '编辑花色', () => openEditDialog(st)));
            acts.appendChild(iconBtn('trash', '删除', b => onDelete(b, st), 'danger'));
            card.appendChild(acts);
        }
        const choose = () => applyStyle(st.id);
        card.addEventListener('click', choose);
        card.addEventListener('keydown', e => { if (e.target === card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); choose(); } });
        return card;
    }

    function makeAddCard() {
        const card = el('button', 'sp-card sp-add');
        card.type = 'button';
        card.innerHTML = '<i class="ph ph-plus"></i><span>添加花色</span><small>上传贴图 · 可拖入图片</small>';
        card.addEventListener('click', () => $('sp-file-input').click());
        return card;
    }

    function redraw() {
        const type = modalType();
        const room = getSelectedRoom();
        const selectedId = target ? target.selectedId : (room ? MaterialLib.getForRoom(room).id : null);
        $('sp-title').textContent = `选择花色 · ${MaterialLib.label(type)}`;
        $('sp-sub').textContent = target ? target.sub : (room ? `应用到：${room.name}` : '请先选中一个空间');

        // 系统预设在前、自定义花色在后；开启「只显示自定义」时仅展示用户自行上传创建的花色
        const onlyCustom = !!$('sp-only-custom')?.checked;
        const customs = MaterialLib.customs(type);
        const all = onlyCustom ? customs : [...MaterialLib.presets(type), ...customs];
        const q = ($('sp-search')?.value || '').trim().toLowerCase();
        const list = q ? all.filter(st => `${st.name} ${st.desc || ''} ${st.kind || ''} ${st.prefix || ''}`.toLowerCase().includes(q)) : all;
        const nCustom = customs.length;
        $('sp-count').textContent = q
            ? `找到 ${list.length} 个`
            : (onlyCustom ? `自定义 ${nCustom} 个` : `共 ${all.length} 个花色${nCustom ? `（自定义 ${nCustom} 个）` : ''}`);
        const cards = list.map(st => makeCard(st, type, selectedId));
        if (!list.length) {
            if (q) cards.push(el('div', 'sp-empty', '没有匹配的花色'));
            else if (onlyCustom) cards.push(el('div', 'sp-empty', '暂无自定义花色，点击左侧「添加花色」上传'));
        }
        $('sp-list').replaceChildren(makeAddCard(), ...cards);
    }

    function open() {
        target = null;
        if (!getSelectedRoom()) { showToast('请先在画布中选中一个空间'); return; }
        show();
    }

    /** 为非空间对象（门洞过门石等）打开同一个花色库 */
    function openFor(opts) {
        target = opts;
        show();
    }

    function show() {
        cancelAdd();
        if ($('sp-search')) $('sp-search').value = '';
        redraw();
        $('style-picker-modal').classList.remove('hidden');
    }

    function close() {
        $('style-picker-modal').classList.add('hidden');
        cancelAdd();
        armedDeleteId = null;
        target = null;
    }

    /* ---------- 应用 / 编辑 / 删除 ---------- */
    function refreshRoomViews() {
        if (typeof renumberTiles === 'function') renumberTiles();
        syncLeftPanelFromSelectedRoom();
        render3DIsometricPreview();
        render();
        if (typeof Elevation !== 'undefined' && Elevation.isActive?.()) {
            Elevation.refresh?.();
        }
    }

    function applyStyle(id) {
        if (target) {
            const t = target;
            close();
            t.onPick(id);
            return;
        }
        const room = getSelectedRoom();
        if (!room) return;
        saveHistory();
        room.cleared = false;
        room.styleId = id;
        const st = MaterialLib.get(id, room.materialType);
        let needRecompute = false;
        if (st && st.tileW > 0 && st.tileH > 0) {
            room.tileW = st.tileW;
            room.tileH = st.tileH;
            needRecompute = true;
        }
        if (st && st.sep != null) {
            STATE.tileNumSep = st.sep;
        }
        if (needRecompute && typeof recomputeAllRoomTiling === 'function') {
            recomputeAllRoomTiling();
        }
        refreshRoomViews();
        close();
    }

    async function onDelete(btn, st) {
        if (!st.custom) { showToast('系统预设花色不可删除'); return; }
        if (armedDeleteId !== st.id) {      // 第一次点击：二次确认
            armedDeleteId = st.id;
            btn.classList.add('armed');
            btn.innerHTML = '<span>确认删除</span>';
            setTimeout(() => { if (armedDeleteId === st.id) { armedDeleteId = null; redraw(); } }, 3000);
            return;
        }
        armedDeleteId = null;
        if (addSession && addSession.styleId === st.id) cancelAdd();
        await MaterialLib.remove(st.id);
        const clearRefs = state => {
            if (!state) return;
            (state.rooms || []).forEach(r => {
                if (r.styleId === st.id) r.styleId = null;
                const faces = r.wallTiling && r.wallTiling.faces;
                if (faces) {
                    for (const k of Object.keys(faces)) {
                        if (faces[k] && faces[k].styleId === st.id) faces[k].styleId = null;
                    }
                }
            });
            (state.openings || []).forEach(o => { if (o.thresholdStyleId === st.id) o.thresholdStyleId = null; });
            if (state.specMeta) {
                delete state.specMeta[`floor:${st.id}`];
                delete state.specMeta[`wall:${st.id}`];
            }
        };
        if (typeof allFloorStates === 'function') allFloorStates().forEach(clearRefs);
        else clearRefs(STATE);
        if (target && target.selectedId === st.id) target.selectedId = null;
        refreshRoomViews();
        redraw();
        showToast(`已删除花色【${st.name}】`);
    }

    /* ---------- 添加花色（参数配置 + 等比裁剪整合弹窗） ---------- */
    function formatRatioText(w, h) {
        const iw = Math.round(w), ih = Math.round(h);
        if (!(iw > 0 && ih > 0)) return '自由';
        const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
        const g = gcd(iw, ih);
        const rw = iw / g, rh = ih / g;
        if (rw <= 20 && rh <= 20) return `${rw}:${rh}`;
        return iw >= ih ? `${(iw / ih).toFixed(2)}:1` : `1:${(ih / iw).toFixed(2)}`;
    }

    function readAddDims() {
        const w = Number($('sa-w')?.value);
        const h = Number($('sa-h')?.value);
        const valid = Number.isFinite(w) && Number.isFinite(h) && w >= 50 && h >= 50;
        return { w: valid ? Math.round(w) : 0, h: valid ? Math.round(h) : 0, ratio: valid ? w / h : NaN };
    }

    function syncPresetSelection(w, h) {
        const sel = $('sa-size-preset');
        if (!sel) return;
        const val = `${Math.round(w)}x${Math.round(h)}`;
        const hasOpt = [...sel.options].some(o => o.value === val);
        sel.value = hasOpt ? val : 'custom';
    }

    function updateAddRatioBadge() {
        const { w, h, ratio } = readAddDims();
        const badge = $('sa-ratio-badge');
        if (badge) {
            badge.textContent = (w > 0 && h > 0)
                ? `比例 ${w}×${h} (${formatRatioText(w, h)})`
                : '自由比例';
        }
        syncPresetSelection(w, h);
        return { w, h, ratio };
    }

    function syncAddCropAspect() {
        const { ratio } = updateAddRatioBadge();
        if (addSession && addSession.cropper) {
            const cp = addSession.cropper;
            cp.setAspectRatio(ratio);
            if (Number.isFinite(ratio) && ratio > 0) {
                const cv = cp.getCanvasData();
                const ct = cp.getContainerData();
                const left = Math.max(0, cv.left);
                const top = Math.max(0, cv.top);
                const right = Math.min(ct.width, cv.left + cv.width);
                const bottom = Math.min(ct.height, cv.top + cv.height);
                const availW = Math.max(20, right - left);
                const availH = Math.max(20, bottom - top);
                let boxW = availW * 0.92;
                let boxH = boxW / ratio;
                if (boxH > availH * 0.92) {
                    boxH = availH * 0.92;
                    boxW = boxH * ratio;
                }
                cp.setCropBoxData({
                    left: left + (availW - boxW) / 2,
                    top: top + (availH - boxH) / 2,
                    width: boxW,
                    height: boxH
                });
            }
            updateAddCropInfo();
        }
    }

    function syncAddNumPreview() {
        const pv = $('sa-num-preview');
        if (!pv) return;
        const pre = String($('sa-prefix')?.value || '').replace(/\s+/g, '').slice(0, 6) || 'CT';
        const sep = String($('sa-sep')?.value ?? '-').replace(/\s+/g, '').slice(0, 3);
        pv.textContent = `${pre}1${sep}1`;
    }

    function updateAddCropInfo() {
        const info = $('sa-crop-info');
        if (!info || !addSession || !addSession.cropper) return;
        const d = addSession.cropper.getData(true);
        const img = addSession.cropper.getImageData();
        const legacyNote = (addSession.mode === 'edit' && !addSession.hasOriginal && !addSession.sourceChanged)
            ? '  ·  未存原图（可点「换图」重选）'
            : '';
        info.textContent = `原图 ${img.naturalWidth}×${img.naturalHeight} px  ·  裁剪 ${Math.max(0, d.width)}×${Math.max(0, d.height)} px${legacyNote}`;
    }

    function populateAddSizePresets(type, defW, defH) {
        const sel = $('sa-size-preset');
        if (!sel) return;
        const seen = new Set();
        const makeGroup = (label, list) => {
            const opts = [];
            for (const s of (list || [])) {
                const val = `${s.w}x${s.h}`;
                if (seen.has(val)) continue;
                seen.add(val);
                opts.push(`<option value="${val}">${s.label || `${s.w}×${s.h}`}</option>`);
            }
            return opts.length ? `<optgroup label="${label}">${opts.join('')}</optgroup>` : '';
        };
        const wallSizes = (typeof PRESETS !== 'undefined' && PRESETS.wall?.sizes) ? PRESETS.wall.sizes : [];
        const tileSizes = MaterialLib.sizes('tile') || [];
        const woodSizes = MaterialLib.sizes('wood') || [];
        const groups = [];
        if (target && target.ctx === 'wall') {
            groups.push(makeGroup('墙砖 / 墙板常用规格', wallSizes));
            groups.push(makeGroup('地砖 / 吊顶常用规格', tileSizes));
            groups.push(makeGroup('地板常用规格', woodSizes));
        } else if (type === 'wood') {
            groups.push(makeGroup('地板常用规格', woodSizes));
            groups.push(makeGroup('砖 / 岩板 / 墙板 / 吊顶规格', [...tileSizes, ...wallSizes]));
        } else {
            groups.push(makeGroup('砖 / 岩板 / 墙板 / 吊顶规格', [...tileSizes, ...wallSizes]));
            groups.push(makeGroup('地板常用规格', woodSizes));
        }
        sel.innerHTML = groups.filter(Boolean).join('') + '<option value="custom">自定义尺寸</option>';
        syncPresetSelection(defW, defH);
    }

    function exportCroppedFile(file, cropper) {
        if (!cropper) return Promise.resolve(file);
        const rawType = (file?.type || '').toLowerCase();
        const outType = (rawType === 'image/jpeg' || rawType === 'image/webp') ? rawType : 'image/png';
        const canvas = cropper.getCroppedCanvas({
            maxWidth: 2048,
            maxHeight: 2048,
            imageSmoothingEnabled: true,
            imageSmoothingQuality: 'high',
            fillColor: outType === 'image/png' ? 'transparent' : '#ffffff'
        });
        if (!canvas) return Promise.resolve(file);
        return new Promise(resolve => {
            canvas.toBlob(blob => {
                if (!blob) { resolve(file); return; }
                const ext = outType === 'image/jpeg' ? '.jpg' : outType === 'image/webp' ? '.webp' : '.png';
                const name = (file?.name || 'style').replace(/\.[^/.]+$/, '') + ext;
                try { resolve(new File([blob], name, { type: outType, lastModified: Date.now() })); }
                catch (e) { blob.name = name; resolve(blob); }
            }, outType, 0.92);
        });
    }

    function mountAddCropper(session, blobOrFile, restoreCropData = null) {
        const img = $('sa-crop-img');
        if (!img) return;
        if (session.cropper) {
            session.cropper.destroy();
            session.cropper = null;
        }
        if (session.url) {
            URL.revokeObjectURL(session.url);
            session.url = null;
        }
        const url = URL.createObjectURL(blobOrFile);
        session.url = url;
        session.scaleX = 1;
        session.scaleY = 1;
        $('sa-crop-info').textContent = '';

        img.onerror = () => {
            showToast('无法读取该图片');
            if (addSession === session && session.mode === 'add') cancelAdd();
        };
        img.onload = () => {
            if (addSession !== session) return;
            if (typeof window.Cropper !== 'function') return;
            const { ratio } = readAddDims();
            session.cropper = new window.Cropper(img, {
                aspectRatio: ratio,
                viewMode: 1,
                dragMode: 'move',
                autoCropArea: 0.92,
                background: true,
                responsive: true,
                restore: false,
                toggleDragModeOnDblclick: false,
                ready() {
                    if (addSession !== session) return;
                    if (restoreCropData && restoreCropData.width > 0 && restoreCropData.height > 0) {
                        session.scaleX = restoreCropData.scaleX === -1 ? -1 : 1;
                        session.scaleY = restoreCropData.scaleY === -1 ? -1 : 1;
                        session.cropper.setData(restoreCropData);
                        updateAddRatioBadge();
                        updateAddCropInfo();
                    } else {
                        syncAddCropAspect();
                    }
                },
                crop: updateAddCropInfo
            });
        };
        img.src = url;
    }

    function openStyleDialog({ mode = 'add', file = null, style = null, step = '', isBatch = false } = {}) {
        cancelAdd();
        return new Promise(resolve => {
            const modal = $('style-add-modal');
            const img = $('sa-crop-img');
            const isEdit = mode === 'edit' && !!style;
            const srcBlob = isEdit ? (style._srcBlob || style._blob) : file;
            if (!modal || !img || !srcBlob) { resolve(null); return; }

            const session = {
                mode: isEdit ? 'edit' : 'add',
                styleId: isEdit ? style.id : null,
                file: srcBlob,
                hasOriginal: isEdit ? !!style._srcBlob : true,
                sourceChanged: !isEdit,
                url: null,
                cropper: null,
                scaleX: 1,
                scaleY: 1,
                resolve,
                isBatch: !isEdit && isBatch
            };
            addSession = session;

            const type = isEdit ? (style.materialType || modalType()) : modalType();
            const room = getSelectedRoom();
            const fallbackW = Math.round(Number(target ? target.crop?.w : room?.tileW) || (type === 'wood' ? 1210 : 800));
            const fallbackH = Math.round(Number(target ? target.crop?.h : room?.tileH) || (type === 'wood' ? 195 : 800));
            const defW = (isEdit && style.tileW > 0) ? style.tileW : fallbackW;
            const defH = (isEdit && style.tileH > 0) ? style.tileH : fallbackH;

            const kinds = specKindList(type);
            const fallbackKind = type === 'wood' ? '地板' : (target && target.ctx === 'wall' ? '墙砖' : (target && target.ctx === 'stone' ? '石材' : '瓷砖'));
            const initKind = (isEdit && style.kind && kinds.some(k => k.kind === style.kind)) ? style.kind : fallbackKind;
            const initPrefix = (isEdit && style.prefix != null && style.prefix !== '') ? style.prefix : specKindPrefix(type, initKind);
            const initSep = (isEdit && style.sep != null) ? style.sep : (typeof tileNumSep === 'function' ? tileNumSep() : '-');

            $('sa-title').textContent = isEdit
                ? `编辑自定义花色 · ${MaterialLib.label(type)}`
                : `新增自定义花色 · ${MaterialLib.label(type)}`;
            const stepEl = $('sa-step');
            if (stepEl) {
                stepEl.textContent = step;
                stepEl.classList.toggle('hidden', !step);
            }
            $('sa-name').value = isEdit ? style.name : (file?.name || '').replace(/\.[^/.]+$/, '');
            $('sa-w').value = defW;
            $('sa-h').value = defH;
            populateAddSizePresets(type, defW, defH);

            $('sa-kind').innerHTML = kinds.map(k => `<option value="${k.kind}">${k.kind}</option>`).join('');
            $('sa-kind').value = initKind;
            $('sa-prefix').value = initPrefix;
            $('sa-sep').value = initSep;

            const saveApplyBtn = $('sa-save-apply');
            if (saveApplyBtn) {
                saveApplyBtn.textContent = session.isBatch ? '保存并下一张' : '保存并应用';
            }
            const saveBtn = $('sa-save');
            if (saveBtn) {
                saveBtn.textContent = isEdit ? '保存修改' : '仅保存';
            }

            syncAddNumPreview();
            updateAddRatioBadge();

            modal.classList.remove('hidden');
            mountAddCropper(session, srcBlob, (isEdit && style._srcBlob) ? style.cropData : null);
            setTimeout(() => { $('sa-name')?.focus(); $('sa-name')?.select(); }, 0);
        });
    }

    function openAddDialog(file, { step = '', isBatch = false } = {}) {
        return openStyleDialog({ mode: 'add', file, step, isBatch });
    }

    function openEditDialog(st) {
        const fresh = st && st.id && typeof MaterialLib.getCustom === 'function' ? MaterialLib.getCustom(st.id) : st;
        if (!fresh || !fresh.custom) return Promise.resolve(null);
        if (!fresh._srcBlob) {
            showToast('该花色为旧版保存（未含原图），可点右上角「换图」重新选择原图');
        }
        return openStyleDialog({ mode: 'edit', style: fresh });
    }

    function closeAddSession(result = null) {
        if (!addSession) {
            $('style-add-modal')?.classList.add('hidden');
            return;
        }
        const s = addSession;
        addSession = null;
        if (s.cropper) { s.cropper.destroy(); s.cropper = null; }
        if (s.url) { URL.revokeObjectURL(s.url); s.url = null; }
        const img = $('sa-crop-img');
        if (img) img.removeAttribute('src');
        $('style-add-modal')?.classList.add('hidden');
        s.resolve(result);
    }

    function cancelAdd() {
        closeAddSession(null);
    }

    async function confirmAdd(applyAfter) {
        if (!addSession) return;
        const s = addSession;
        const saveApplyBtn = $('sa-save-apply');
        const saveBtn = $('sa-save');
        if (saveApplyBtn) saveApplyBtn.disabled = true;
        if (saveBtn) saveBtn.disabled = true;
        try {
            const cropData = s.cropper ? s.cropper.getData(false) : null;
            const croppedFile = await exportCroppedFile(s.file, s.cropper);
            const meta = {
                kind: $('sa-kind').value,
                prefix: $('sa-prefix').value,
                sep: $('sa-sep') ? $('sa-sep').value : null,
                tileW: $('sa-w') ? $('sa-w').value : null,
                tileH: $('sa-h') ? $('sa-h').value : null,
                cropData
            };
            let st;
            if (s.mode === 'edit') {
                st = await MaterialLib.updateCustom(s.styleId, croppedFile, $('sa-name').value, {
                    ...meta,
                    sourceFile: s.sourceChanged ? s.file : null
                });
            } else {
                st = await MaterialLib.addCustom(croppedFile, modalType(), $('sa-name').value, {
                    ...meta,
                    sourceFile: s.file
                });
            }
            if (!st) { cancelAdd(); return; }
            const shouldApply = applyAfter && !s.isBatch;
            closeAddSession({ style: st, applyAfter: shouldApply });
            if (shouldApply) {
                applyStyle(st.id);
            } else {
                if (s.mode === 'edit') refreshRoomViews();
                redraw();
                showToast(s.mode === 'edit' ? `已更新花色【${st.name}】` : `已添加花色【${st.name}】`);
            }
        } catch (e) {
            console.error(e);
            showToast(e && e.code === 'IMAGE_TOO_LARGE' ? e.message : '保存失败，请检查浏览器是否允许本地存储');
        } finally {
            if (saveApplyBtn) saveApplyBtn.disabled = false;
            if (saveBtn) saveBtn.disabled = false;
        }
    }

    async function handleFiles(fileList) {
        const files = [...fileList].filter(f => f.type.startsWith('image/'));
        if (!files.length) { showToast('请选择图片文件'); return; }
        for (let i = 0; i < files.length; i++) {
            const res = await openAddDialog(files[i], {
                step: files.length > 1 ? `${i + 1} / ${files.length}` : '',
                isBatch: i < files.length - 1
            });
            if (res && res.applyAfter) return;
        }
    }

    /* ---------- 事件绑定 ---------- */
    function bind() {
        $('btn-open-style-picker').addEventListener('click', open);
        $('swatch-box').addEventListener('click', open);
        $('btn-close-style-picker').addEventListener('click', close);
        $('style-picker-modal').addEventListener('mousedown', e => { if (e.target.id === 'style-picker-modal') close(); });
        window.addEventListener('keydown', e => {
            if (isAddOpen()) {
                if (e.key === 'Escape') { e.preventDefault(); cancelAdd(); }
                else if (e.key === 'Enter' && !e.isComposing && !(e.target instanceof HTMLButtonElement) && !(e.target instanceof HTMLSelectElement)) {
                    e.preventDefault();
                    confirmAdd(true);
                }
                e.stopImmediatePropagation();
                return;
            }
            if (e.key === 'Escape' && isOpen() && !window.ImageCropDialog?.isOpen()) close();
        }, true);

        $('sp-search').addEventListener('input', redraw);
        $('sp-search').addEventListener('keydown', e => e.stopPropagation());
        const onlyCustomChk = $('sp-only-custom');
        if (onlyCustomChk) {
            try { onlyCustomChk.checked = typeof StorageDB !== 'undefined' && StorageDB.get('tilecalc.stylePickerOnlyCustom') === '1'; } catch (e) {}
            onlyCustomChk.addEventListener('change', () => {
                try { if (typeof StorageDB !== 'undefined') StorageDB.set('tilecalc.stylePickerOnlyCustom', onlyCustomChk.checked ? '1' : '0'); } catch (e) {}
                redraw();
            });
        }

        $('sp-file-input').addEventListener('change', e => { handleFiles(e.target.files); e.target.value = ''; });

        // 整合新增花色弹窗交互
        $('sa-close')?.addEventListener('click', cancelAdd);
        $('sa-cancel')?.addEventListener('click', cancelAdd);
        $('sa-save-apply')?.addEventListener('click', () => confirmAdd(true));
        $('sa-save')?.addEventListener('click', () => confirmAdd(false));
        $('style-add-modal')?.addEventListener('mousedown', e => { if (e.target.id === 'style-add-modal') cancelAdd(); });

        $('sa-size-preset')?.addEventListener('change', e => {
            const m = String(e.target.value || '').match(/^(\d+)x(\d+)$/);
            if (!m) return;
            $('sa-w').value = m[1];
            $('sa-h').value = m[2];
            syncAddCropAspect();
        });
        $('sa-w')?.addEventListener('input', syncAddCropAspect);
        $('sa-h')?.addEventListener('input', syncAddCropAspect);
        $('sa-swap-dim')?.addEventListener('click', () => {
            const wEl = $('sa-w'), hEl = $('sa-h');
            if (!wEl || !hEl) return;
            const tmp = wEl.value;
            wEl.value = hEl.value;
            hEl.value = tmp;
            syncAddCropAspect();
        });
        $('sa-kind')?.addEventListener('change', e => {
            $('sa-prefix').value = specKindPrefix(modalType(), e.target.value);
            syncAddNumPreview();
        });
        $('sa-prefix')?.addEventListener('input', syncAddNumPreview);
        $('sa-sep')?.addEventListener('input', syncAddNumPreview);

        $('sa-crop-tools')?.addEventListener('click', e => {
            const b = e.target.closest('[data-act]');
            if (!b || !addSession) return;
            if (b.dataset.act === 'replace-img') {
                $('sa-file-input')?.click();
                return;
            }
            if (!addSession.cropper) return;
            const cp = addSession.cropper;
            switch (b.dataset.act) {
                case 'rotate-l': cp.rotate(-90); break;
                case 'rotate-r': cp.rotate(90); break;
                case 'flip-h': addSession.scaleX = -addSession.scaleX; cp.scaleX(addSession.scaleX); break;
                case 'flip-v': addSession.scaleY = -addSession.scaleY; cp.scaleY(addSession.scaleY); break;
                case 'zoom-out': cp.zoom(-0.1); break;
                case 'zoom-in': cp.zoom(0.1); break;
                case 'reset':
                    addSession.scaleX = addSession.scaleY = 1;
                    cp.reset();
                    syncAddCropAspect();
                    break;
            }
        });
        $('sa-file-input')?.addEventListener('change', e => {
            const f = e.target.files && e.target.files[0];
            e.target.value = '';
            if (!f || !addSession) return;
            if (!f.type.startsWith('image/')) { showToast('请选择图片文件'); return; }
            addSession.file = f;
            addSession.sourceChanged = true;
            addSession.hasOriginal = true;
            mountAddCropper(addSession, f, null);
        });

        const body = $('sp-body');
        body.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); body.classList.add('dragging'); });
        body.addEventListener('dragleave', e => { if (!body.contains(e.relatedTarget)) body.classList.remove('dragging'); });
        body.addEventListener('drop', e => {
            e.preventDefault();
            e.stopPropagation();
            body.classList.remove('dragging');
            if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
        });
    }

    window.addEventListener('DOMContentLoaded', bind);
    return { open, openFor, close, redraw, isOpen: () => isOpen() || isAddOpen() };
})();
