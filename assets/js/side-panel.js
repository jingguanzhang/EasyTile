/*************************************************************************
 * 左侧面板公共组件（地面模式与立面模式共用）  v4.8.1
 * - 分组卡片：标题栏 + 折叠（状态统一记在 IndexedDB「tilecalc.collapsedCards」）
 * - 表单行、带单位数字框、单选分段、花色色卡、规格编号、铺法图标组
 * 地面模式的卡片写在 index.html 中，立面模式的卡片由 elevation.js 用这里的函数生成，
 * 两者输出同一套 DOM 结构与样式类，保证左侧面板外观与交互一致。
 *************************************************************************/
const SidePanel = (() => {
    const KEY = 'tilecalc.collapsedCards';
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const attr = (name, v) => (v == null || v === '') ? '' : ` ${name}="${esc(v)}"`;

    function loadCollapsed() {
        try { return (typeof StorageDB !== 'undefined' ? StorageDB.getJSON(KEY, {}) : {}) || {}; } catch (e) { return {}; }
    }
    function saveCollapsed(key, collapsed) {
        const saved = loadCollapsed();
        saved[key] = collapsed;
        try { if (typeof StorageDB !== 'undefined') StorageDB.setJSON(KEY, saved); } catch (e) { /* 忽略 */ }
    }

    /** 分组卡片（可折叠）：id 为折叠状态的键；right 为标题栏右侧内容（按钮 / 徽标） */
    function card(id, title, right, body) {
        const collapsed = loadCollapsed()[id];
        return `<div class="panel-card space-y-2 collapsible${collapsed ? ' collapsed' : ''}" data-card="${esc(id)}">
                <div class="section-header"><span class="section-title"><span>${title}</span></span>${right || ''}</div>${body}</div>`;
    }

    /** 表单行：左侧标签 + 右侧控件 */
    const row = (label, ctl, title = '') => `<div class="form-row"><label class="form-label"${attr('title', title)}>${label}</label>${ctl}</div>`;

    /** 带单位后缀的数字框；unit = 'mm' 时随全局单位换算显示，其它单位（%、元/m²）不换算 */
    function numInput(field, val, { min, max, step, unit = 'mm', title = '', placeholder = '' } = {}) {
        return `<div class="input-unit flex-1" data-unit="${esc(unit)}"><input type="number" data-f="${esc(field)}"${unit === 'mm' ? '' : ' data-no-unit'} value="${esc(val)}"${attr('min', min)}${attr('max', max)}${attr('step', step)}${attr('placeholder', placeholder)} class="ui-input font-mono w-full text-center"${attr('title', title)}></div>`;
    }

    /** 长度输入（无单位后缀，标签中显示单位） */
    const lenInput = (field, val, title, { min = 20, max = 3600, step = 10 } = {}) =>
        `<input data-f="${esc(field)}" data-len type="number" min="${min}" max="${max}" step="${step}" value="${esc(val)}" class="ui-input font-mono flex-1 min-w-0 text-center" title="${esc(title)}">`;

    /** 单选分段控件 */
    const segRadio = (name, map, val, muted = false) => `<div class="seg-radio flex-1${muted ? ' is-muted' : ''}">${Object.entries(map).map(([k, v]) =>
        `<label><input type="radio" name="${esc(name)}" value="${esc(k)}"${k === val ? ' checked' : ''}><span>${v}</span></label>`).join('')}</div>`;

    /** 花色色卡 + 选择按钮（与地面「选择 / 管理花色」同一结构） */
    const swatch = (role, styleName, label) => `
            <div class="panel-card-subtle flex items-center gap-2.5">
                <div class="swatch-box" data-pick="${esc(role)}" title="点击选择花色"><canvas data-swatch="${esc(role)}" width="80" height="60" class="w-full h-full block"></canvas>
                    <span class="swatch-caption">${esc(styleName)}</span></div>
                <div class="flex-1 min-w-0"><button type="button" class="ui-btn ui-btn-sm w-full px-1.5" data-pick="${esc(role)}"><i class="ph ph-swatches text-[12px]"></i><span>${label}</span></button></div>
            </div>`;

    /**
     * 铺法图标组（与地面「正铺 / 工字铺 / 369铺 / 45°斜铺」同一样式）。
     * items: [{ value, label, icon, cls }]，cls 用于图标变体（如竖向工字 = 工字图标旋转 90°）
     */
    const patternGrid = (items, val) => `<div class="grid gap-1.5" style="grid-template-columns: repeat(${items.length}, minmax(0, 1fr))">${items.map(it =>
        `<button type="button" data-pattern="${esc(it.value)}" class="pattern-btn${it.value === val ? ' active' : ''}"><i class="ti ${esc(it.icon)} text-2xl mb-1${it.cls ? ' ' + it.cls : ''}"></i><span class="text-[11px]">${it.label}</span></button>`).join('')}</div>`;

    /** 「规格编号」控件：主行（大号编号预览 + 高级展开）与默认收起的类型/前缀子面板 */
    const specNumberRow = (kinds, meta, preview, title, { expanded = false } = {}) => `${row('规格编号', `<div class="flex items-center gap-1.5 flex-1 min-w-0">
                <span class="spec-preview-lg" title="当前编号预览">${esc(preview)}</span>
                <button type="button" data-act="spec-adv" class="ui-btn spec-adv-btn shrink-0" aria-expanded="${expanded ? 'true' : 'false'}" title="调整材料类型与编号前缀" aria-label="高级编号设置"><i class="ph ph-sliders-horizontal text-[13px]"></i></button>
            </div>`, title || '砖号 = 前缀 + 规格号 + 序号，铺贴后自动编号')}
            <div class="spec-adv-panel${expanded ? '' : ' hidden'}">
                <div class="form-row">
                    <label class="spec-adv-label" title="决定默认编号前缀">材料类型</label>
                    <select data-f="specKind" class="ui-select flex-1 px-1.5">${kinds.map(k => `<option value="${esc(k)}"${k === meta.kind ? ' selected' : ''}>${esc(k)}</option>`).join('')}</select>
                </div>
                <div class="form-row">
                    <label class="spec-adv-label" title="同花色共用；分隔符在地面「砖材」统一设置">编号前缀</label>
                    <input data-f="specPrefix" type="text" maxlength="6" value="${esc(meta.prefix)}" class="ui-input font-mono flex-1 px-1.5 text-center">
                </div>
            </div>`;

    /** 标题栏点击折叠：static = index.html 中的静态卡片（按 id 或序号记忆），dynamic = data-card 卡片 */
    function bindCollapse(cardEl, key) {
        const header = cardEl.querySelector(':scope > .section-header');
        if (!header || header.dataset.collapseBound) return;
        header.dataset.collapseBound = '1';
        header.addEventListener('click', e => {
            if (e.target.closest('button, select, input, a, label')) return;
            saveCollapsed(key, cardEl.classList.toggle('collapsed'));
        });
    }

    const rawValDesc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    const STEP_SVG_UP = '<svg viewBox="0 0 10 6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.5L5 1.5L8 4.5"/></svg>';
    const STEP_SVG_DN = '<svg viewBox="0 0 10 6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 1.5L5 4.5L8 1.5"/></svg>';

    /** 按输入框当前的 step / min / max 步进一次（兼容 Units.js 单位换算）；仅修改原始显示值 */
    function stepNumericInput(inp, dir) {
        if (!inp || inp.disabled || inp.readOnly) return false;
        const rawStr = rawValDesc ? rawValDesc.get.call(inp) : inp.value;
        const stepAttr = inp.getAttribute('step');
        const minAttr = inp.getAttribute('min');
        const maxAttr = inp.getAttribute('max');
        const step = (stepAttr && stepAttr !== 'any' && Number(stepAttr) > 0) ? Number(stepAttr) : 1;
        const hasMin = minAttr != null && minAttr !== '' && Number.isFinite(Number(minAttr));
        const hasMax = maxAttr != null && maxAttr !== '' && Number.isFinite(Number(maxAttr));
        const minV = hasMin ? Number(minAttr) : -Infinity;
        const maxV = hasMax ? Number(maxAttr) : Infinity;

        let cur;
        if (rawStr === '') {
            const ph = inp.getAttribute('placeholder') || '';
            const m = ph.match(/(-?\d+(?:\.\d+)?)\s*$/);
            cur = m ? Number(m[1]) : (hasMin ? Math.max(0, minV) : 0);
        } else {
            cur = Number(rawStr);
            if (!Number.isFinite(cur)) cur = hasMin ? minV : 0;
        }

        let next = cur + dir * step;
        next = Math.min(maxV, Math.max(minV, next));
        const stepDec = (String(step).split('.')[1] || '').length;
        const curDec = (String(cur).split('.')[1] || '').length;
        const dec = Math.min(6, Math.max(stepDec, curDec));
        next = Number(next.toFixed(dec));
        const nextStr = String(next);
        if (nextStr === rawStr) return false;

        if (rawValDesc) rawValDesc.set.call(inp, nextStr);
        else inp.value = nextStr;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
    }

    /** 创建并绑定带长按连发的上下调节按钮组 */
    function createSpinControls(inp) {
        const spin = document.createElement('span');
        spin.className = 'ui-spin';
        spin.setAttribute('aria-hidden', 'true');
        spin.innerHTML =
            `<button type="button" tabindex="-1" class="ui-spin-btn ui-spin-up" title="增加" aria-label="增加">${STEP_SVG_UP}</button>` +
            `<button type="button" tabindex="-1" class="ui-spin-btn ui-spin-down" title="减小" aria-label="减小">${STEP_SVG_DN}</button>`;

        const bindBtn = (btn, dir) => {
            btn.addEventListener('pointerdown', (e) => {
                if (e.button !== 0 || inp.disabled || inp.readOnly) return;
                e.preventDefault();
                if (document.activeElement !== inp) inp.focus({ preventScroll: true });
                let changed = stepNumericInput(inp, dir);
                let delayId = null;
                let repeatId = null;
                const stop = () => {
                    if (delayId) { clearTimeout(delayId); delayId = null; }
                    if (repeatId) { clearInterval(repeatId); repeatId = null; }
                    window.removeEventListener('pointerup', stop);
                    window.removeEventListener('pointercancel', stop);
                    window.removeEventListener('blur', stop);
                    if (changed && inp.isConnected) {
                        inp.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                };
                delayId = setTimeout(() => {
                    delayId = null;
                    repeatId = setInterval(() => {
                        if (!inp.isConnected || inp.disabled || inp.readOnly) { stop(); return; }
                        if (stepNumericInput(inp, dir)) changed = true;
                    }, 65);
                }, 380);
                window.addEventListener('pointerup', stop, { once: true });
                window.addEventListener('pointercancel', stop, { once: true });
                window.addEventListener('blur', stop, { once: true });
            });
        };
        bindBtn(spin.querySelector('.ui-spin-up'), 1);
        bindBtn(spin.querySelector('.ui-spin-down'), -1);
        return spin;
    }

    /** 为容器内所有数值输入框添加尾部单位前的上下箭头（幂等） */
    function enhanceNumberInputs(root) {
        if (!root || !root.querySelectorAll) return;
        const inputs = root.matches && root.matches('input[type="number"]')
            ? [root]
            : [...root.querySelectorAll('input[type="number"]')];
        inputs.forEach((inp) => {
            if (inp.dataset.spinBound) return;
            inp.dataset.spinBound = '1';
            const spin = createSpinControls(inp);
            const host = inp.closest('.input-unit, .combo-input');
            if (host) {
                inp.insertAdjacentElement('afterend', spin);
                return;
            }
            const parent = inp.parentElement;
            if (!parent) return;
            const box = document.createElement('span');
            box.className = 'ui-num-box';
            ['flex-1', 'min-w-0', 'w-full'].forEach(cls => {
                if (inp.classList.contains(cls)) box.classList.add(cls);
            });
            parent.insertBefore(box, inp);
            box.appendChild(inp);
            box.appendChild(spin);
        });
    }

    /** 左侧静态卡片初始化折叠（门窗 / 墙体属性卡片除外） */
    function initStaticCards(root) {
        const saved = loadCollapsed();
        [...root.querySelectorAll('.panel-card')]
            .filter(c => !c.closest('#elev-panel') && c.querySelector(':scope > .section-header') && !c.id.startsWith('inspector-'))
            .forEach((c, i) => {
                const key = c.dataset.card || c.id || `card${i}`;
                c.classList.add('collapsible');
                c.classList.toggle('collapsed', !!saved[key]);
                bindCollapse(c, key);
            });
        enhanceNumberInputs(root);
        if (root && !root.dataset.spinObserved && typeof MutationObserver !== 'undefined') {
            root.dataset.spinObserved = '1';
            new MutationObserver(ms => {
                for (const m of ms) {
                    m.addedNodes.forEach(n => {
                        if (n.nodeType === 1 && !n.classList.contains('ui-spin') && !n.classList.contains('ui-num-box')) {
                            enhanceNumberInputs(n);
                        }
                    });
                }
            }).observe(root, { childList: true, subtree: true });
        }
    }

    /** 动态生成的卡片（data-card）绑定折叠 */
    function bindDynamicCards(root) {
        root.querySelectorAll('[data-card]').forEach(c => bindCollapse(c, c.dataset.card));
        enhanceNumberInputs(root);
    }

    return { esc, card, row, numInput, lenInput, segRadio, swatch, patternGrid, specNumberRow, enhanceNumberInputs, initStaticCards, bindDynamicCards };
})();
