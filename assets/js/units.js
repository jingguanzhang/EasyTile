/*************************************************************************
 * 全局长度单位  v4.7.1（v4.7.2 起 CAD 也随全局单位）
 * - 工程内部一律以 mm（或世界像素）存储；界面显示 / 输入按全局单位 mm、cm、m 换算
 * - 所有位于 [data-unit="mm"] 容器内、或带 data-len 属性的 number 输入框自动接管：
 *   读取 .value 返回 mm，写入 .value 接受 mm，界面上显示为当前单位，min/max/step 同步换算
 * - 已有代码继续按 mm 读写输入框，无需改动
 *************************************************************************/
const Units = (() => {
    const FACTOR = { mm: 1, cm: 10, m: 1000 };
    const DEC = { mm: 1, cm: 2, m: 4 };        // 输入框显示精度（保证 0.1 mm）
    const DIM_DEC = { mm: 0, cm: 1, m: 2 };    // 图面标注精度
    const NAME = { mm: '毫米 (mm)', cm: '厘米 (cm)', m: '米 (m)' };
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    const descNum = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'valueAsNumber');
    const patched = new Set();

    const cur = () => (typeof STATE !== 'undefined' && FACTOR[STATE.unit]) ? STATE.unit : 'mm';
    const f = () => FACTOR[cur()];
    const trim = (x, d) => { const s = Number(x).toFixed(d); return String(Number(s)); };

    /** mm → 当前单位的数值字符串（输入框用） */
    const toUnitStr = mm => trim(Number(mm) / f(), DEC[cur()]);
    /** 当前单位数值 → mm */
    const toMM = v => Math.round(Number(v) * f() * 10) / 10;
    /** 图面标注：mm 不带单位（CAD 惯例），cm / m 带单位 */
    const dim = mm => {
        const u = cur();
        const v = trim(Number(mm) / FACTOR[u], DIM_DEC[u]);
        return u === 'mm' ? v : `${v}${u}`;
    };
    /** 正文：数值 + 空格 + 单位 */
    const text = mm => `${toUnitStr(mm)} ${cur()}`;
    /** 正文：仅数值（单位另写） */
    const val = mm => toUnitStr(mm);

    function scaleAttrs(inp) {
        for (const a of ['min', 'max', 'step']) {
            const key = 'mm' + a[0].toUpperCase() + a.slice(1);
            if (inp.dataset[key] == null) inp.dataset[key] = inp.getAttribute(a) ?? '';
            const base = inp.dataset[key];
            if (base === '' || base === 'any') continue;
            let v = Number(base) / f();
            if (a === 'step') v = cur() === 'mm' ? Number(base) : Math.max(v, 1 / Math.pow(10, DEC[cur()]));
            inp.setAttribute(a, trim(v, DEC[cur()] + 1));
        }
        if (inp.dataset.mmPlaceholder == null) inp.dataset.mmPlaceholder = inp.getAttribute('placeholder') || '';
        const ph = inp.dataset.mmPlaceholder;
        if (ph) inp.setAttribute('placeholder', ph.replace(/(\d+(?:\.\d+)?)\s*$/, (m, n) => toUnitStr(n)));
        const wrap = inp.closest('[data-unit]');
        if (wrap) wrap.setAttribute('data-unit', cur());
    }

    function patch(inp) {
        if (patched.has(inp) || inp.type !== 'number' || inp.hasAttribute('data-no-unit')) return;
        patched.add(inp);
        const mmNow = desc.get.call(inp);    // 接管前的显示值按 mm 记
        Object.defineProperty(inp, 'value', {
            configurable: true,
            get() {
                const s = desc.get.call(this);
                if (s === '') return '';
                const n = Number(s);
                return Number.isFinite(n) ? String(toMM(n)) : s;
            },
            set(v) {
                if (v === '' || v == null) { desc.set.call(this, ''); return; }
                const n = Number(v);
                desc.set.call(this, Number.isFinite(n) ? toUnitStr(n) : v);
            }
        });
        Object.defineProperty(inp, 'valueAsNumber', {
            configurable: true,
            get() { const n = descNum.get.call(this); return Number.isFinite(n) ? toMM(n) : n; },
            set(v) { inp.value = v; }
        });
        scaleAttrs(inp);
        if (mmNow !== '') inp.value = mmNow;
    }

    const SEL = '[data-unit] input[type=number], input[type=number][data-len]';
    function scan(root = document) {
        if (root.matches && root.matches(SEL)) patch(root);
        if (root.querySelectorAll) root.querySelectorAll(SEL).forEach(patch);
    }

    /** 切换全局单位：输入框内容按 mm 保持不变，只改显示 */
    function setUnit(u) {
        if (!FACTOR[u]) u = 'mm';
        const live = [...patched].filter(i => i.isConnected);
        const vals = live.map(i => i.value);       // 旧单位下读出 mm
        STATE.unit = u;
        live.forEach((i, k) => { scaleAttrs(i); i.value = vals[k]; });
        for (const i of [...patched]) if (!i.isConnected) patched.delete(i);
        try { if (typeof StorageDB !== 'undefined') StorageDB.set('tilecalc.unit', u); } catch (e) { /* 忽略 */ }
        document.querySelectorAll('input[name="unit"]').forEach(r => { r.checked = r.value === u; });
        document.querySelectorAll('[data-unit-text]').forEach(el => { el.textContent = u; });
        document.dispatchEvent(new CustomEvent('unitchange', { detail: u }));
    }

    function init() {
        let saved = null;
        try { saved = typeof StorageDB !== 'undefined' ? StorageDB.get('tilecalc.unit') : null; } catch (e) { /* 忽略 */ }
        if (saved && FACTOR[saved]) STATE.unit = saved;
        scan();
        new MutationObserver(ms => { for (const m of ms) m.addedNodes.forEach(n => n.nodeType === 1 && scan(n)); })
            .observe(document.body, { childList: true, subtree: true });
        setUnit(cur());
    }

    return { init, setUnit, toMM, toUnitStr, dim, text, val, scan, cur, factor: f, NAME };
})();
