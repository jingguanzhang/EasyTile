/*************************************************************************
 * 通用确认对话框（与工作站主题一致）
 *   const ok = await UiDialogs.confirm({
 *       title: '删除空间', message: '确定删除…？', detail: '可 Ctrl+Z 撤销',
 *       okText: '删除', cancelText: '取消', danger: true
 *   });
 * Enter = 确认，Esc / 点遮罩 = 取消；打开期间拦截画布快捷键。
 *************************************************************************/
const UiDialogs = (() => {
    let root = null;
    let pending = null;

    function build() {
        if (root) return root;
        root = document.createElement('div');
        root.className = 'ui-dialog-mask hidden';
        root.innerHTML = `
            <div class="ui-dialog" role="alertdialog" aria-modal="true" aria-labelledby="ui-dialog-title" aria-describedby="ui-dialog-msg">
                <div class="ui-dialog-body">
                    <span class="ui-dialog-icon"><i class="ph ph-warning"></i></span>
                    <div class="ui-dialog-text">
                        <h3 id="ui-dialog-title" class="ui-dialog-title"></h3>
                        <p id="ui-dialog-msg" class="ui-dialog-msg"></p>
                        <p class="ui-dialog-detail"></p>
                        <input type="text" class="ui-input ui-dialog-input" maxlength="40" hidden>
                    </div>
                </div>
                <div class="ui-dialog-foot">
                    <button type="button" class="ui-btn" data-act="cancel"></button>
                    <button type="button" class="ui-btn ui-btn-danger" data-act="alt" hidden></button>
                    <button type="button" class="ui-btn ui-btn-primary" data-act="ok"></button>
                </div>
            </div>`;
        document.body.appendChild(root);
        root.addEventListener('mousedown', e => { if (e.target === root) close(pending?.isTriState ? 'cancel' : false); });
        root.querySelector('[data-act=cancel]').addEventListener('click', () => close(pending?.isTriState ? 'cancel' : false));
        root.querySelector('[data-act=alt]').addEventListener('click', () => close('discard'));
        root.querySelector('[data-act=ok]').addEventListener('click', () => close(pending?.isTriState ? 'save' : true));
        window.addEventListener('keydown', e => {
            if (!pending) return;
            if (e.key === 'Escape') { e.preventDefault(); close(pending.isTriState ? 'cancel' : false); }
            else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); close(pending.isTriState ? 'save' : true); }
            e.stopImmediatePropagation();
        }, true);
        return root;
    }

    function close(result) {
        if (!pending) return;
        const { resolve, prevFocus, isPrompt } = pending;
        if (isPrompt) result = result ? root.querySelector('.ui-dialog-input').value : null;
        pending = null;
        root.classList.add('hidden');
        try { prevFocus?.focus?.(); } catch (e) { /* ignore */ }
        resolve(result);
    }

    function confirm(opts = {}, isPrompt = false, isTriState = false) {
        build();
        if (pending) close(pending.isTriState ? 'cancel' : false);
        root.querySelector('.ui-dialog-title').textContent = opts.title || '请确认';
        root.querySelector('.ui-dialog-msg').textContent = opts.message || '';
        const detail = root.querySelector('.ui-dialog-detail');
        detail.textContent = opts.detail || '';
        detail.hidden = !opts.detail;
        const ok = root.querySelector('[data-act=ok]');
        ok.textContent = opts.okText || '确定';
        ok.classList.toggle('ui-btn-danger-solid', !!opts.danger);
        const alt = root.querySelector('[data-act=alt]');
        if (alt) {
            alt.hidden = !isTriState;
            alt.textContent = opts.altText || '不保存';
        }
        root.querySelector('[data-act=cancel]').textContent = opts.cancelText || '取消';
        root.querySelector('.ui-dialog').classList.toggle('is-danger', !!opts.danger);
        const input = root.querySelector('.ui-dialog-input');
        input.hidden = !isPrompt;
        input.value = isPrompt ? String(opts.value ?? '') : '';
        root.querySelector('.ui-dialog-icon i').className = `ph ${opts.icon || (isPrompt ? 'ph-pencil-simple' : 'ph-warning')}`;
        return new Promise(resolve => {
            pending = { resolve, prevFocus: document.activeElement, isPrompt, isTriState };
            root.classList.remove('hidden');
            setTimeout(() => { if (isPrompt) { input.focus(); input.select(); } else ok.focus(); }, 0);
        });
    }

    /** 单行输入对话框：确定返回输入文字，取消返回 null */
    const prompt = (opts = {}) => confirm(opts, true, false);

    /** 三态保存确认对话框：返回 'save' | 'discard' | 'cancel' */
    const confirmSave = (opts = {}) => confirm(Object.assign({ icon: 'ph-floppy-disk' }, opts), false, true);

    return { confirm, prompt, confirmSave, isOpen: () => !!pending };
})();
window.UiDialogs = UiDialogs;
