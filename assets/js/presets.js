/*************************************************************************
 * 预设参数：assets/data/presets.json
 * 启动时先于其他模块加载（app.js 的 DOMContentLoaded 中 await PresetLib.load()），
 * 之后各模块通过全局 PRESETS 读取：空间命名、铺法、门洞连接形式、默认单价、
 * 立面规格 / 铺法 / 对齐方式、墙砖与踢脚线默认值、算量系数、示例工程、报价附加项等。
 * 花色与常用规格仍在 materials.json，图框模板在 frame-templates.json。
 *************************************************************************/
const PRESETS = {};

const PresetLib = (() => {
    const DATA_URL = 'assets/data/presets.json';
    let loading = null;

    function load() {
        if (!loading) {
            loading = fetch(DATA_URL, { cache: 'no-cache' })
                .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
                .then(data => { Object.assign(PRESETS, data); return PRESETS; });
        }
        return loading;
    }

    return { load, DATA_URL };
})();
