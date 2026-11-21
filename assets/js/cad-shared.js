/* =============================================================================
 * 工作站 (app.js) 与图框编辑器 (tukuan.html) 共用的 CAD 工具：
 *  - acadrust WASM 按需加载
 *  - 图片 → 像素栅格（DXF/DWG 无法内嵌位图：acadrust 把栅格转成 ACI 色块 SOLID 图块）
 * ============================================================================= */
(function (global) {
    'use strict';

    /** 导出版本：DXF 与 DWG 均为 AutoCAD 2007 (AC1021) */
    const CAD_VERSION = { dxf: 1021, dwg: 1021 };
    // CAD 文字样式 STANDARD = 黑体 SimHei（em 256：A 高 178、上升 220、下降 36）。
    // 与 tools/acadrust-wasm/src/builder.rs 的 font 模块一致：编辑器画布按这组参数排版，
    // 导出时传屏幕字号 (em)，由 Rust 换算成 CAD 字高（CAD 字高 = 大写字母高 = 0.695 em）。
    const CAD_FONT = Object.freeze({ cap: 178 / 256, asc: 220 / 256, desc: 36 / 256, cellLh: (5 / 3) * (178 / 256) });

    /**
     * 图框编辑器可选的 Windows 预装中文字体。style = CAD 文字样式名（导出时按字体建样式），
     * cap / asc / desc = 大写字母高 / 上升 / 下降（相对 em）：AutoCAD TrueType 字高 = cap × 字号。
     * 黑体为实测值；宋体 / 新宋体 / 仿宋 / 楷体与黑体同属中易 256 单位字形；微软雅黑、等线为近似值。
     */
    const mk = (key, label, css, style, face, file, cap, asc, desc) =>
        Object.freeze({ key, label, css, style, face, file, cap, asc, desc, cellLh: (5 / 3) * cap });
    const CAD_FONTS = Object.freeze([
        mk('simhei', '黑体', '"SimHei","黑体",sans-serif', 'TK_TEXT', 'SimHei', 'simhei.ttf', 178 / 256, 220 / 256, 36 / 256),
        mk('simsun', '宋体', '"SimSun","宋体",serif', 'TK_SIMSUN', 'SimSun', 'simsun.ttc', 178 / 256, 220 / 256, 36 / 256),
        mk('nsimsun', '新宋体', '"NSimSun","新宋体",serif', 'TK_NSIMSUN', 'NSimSun', 'simsun.ttc', 178 / 256, 220 / 256, 36 / 256),
        mk('fangsong', '仿宋', '"FangSong","仿宋",serif', 'TK_FANGSONG', 'FangSong', 'simfang.ttf', 178 / 256, 220 / 256, 36 / 256),
        mk('kaiti', '楷体', '"KaiTi","楷体",serif', 'TK_KAITI', 'KaiTi', 'simkai.ttf', 178 / 256, 220 / 256, 36 / 256),
        mk('yahei', '微软雅黑', '"Microsoft YaHei","微软雅黑",sans-serif', 'TK_YAHEI', 'Microsoft YaHei', 'msyh.ttc', 0.716, 1.058, 0.262),
        mk('dengxian', '等线', '"DengXian","等线",sans-serif', 'TK_DENGXIAN', 'DengXian', 'Deng.ttf', 0.70, 0.86, 0.14)
    ]);
    const cadFont = (key) => CAD_FONTS.find((f) => f.key === key) || CAD_FONTS[0];

    /** 按需加载 acadrust WASM（约 7.4 MB，首次导出时加载；需经 HTTP / WebView2 虚拟主机访问） */
    let acadrustPromise = null;
    function loadAcadrust() {
        if (!acadrustPromise) {
            acadrustPromise = (async () => {
                // 动态 import 显式以页面地址为基准，兼容 WebView2 虚拟主机
                const mod = await import(new URL('assets/vendor/acadrust-wasm/acadrust_wasm.js', document.baseURI).href);
                await mod.default();
                if (typeof mod.buildDrawing !== 'function') throw new Error('acadrust-wasm 版本过旧：缺少 buildDrawing 接口');
                return mod;
            })().catch((err) => {
                acadrustPromise = null;
                if (location.protocol === 'file:') {
                    throw new Error('请通过本地 HTTP 服务打开页面以加载 acadrust WASM（file:// 下浏览器会拦截 .wasm 模块）');
                }
                throw err;
            });
        }
        return acadrustPromise;
    }

    /**
     * 图片 → 导出用像素栅格（IM 实体）。约 0.12 mm 一格、长边最多 260 格，按纸面尺寸重采样；
     * 索引色匹配、同色合并为矩形与图块写出均由 acadrust-wasm 完成。
     * source 为 Image / Canvas（srcW、srcH 为其像素尺寸），wMm × hMm 为纸面尺寸。
     * 返回 { gw, gh, px }（px 为 base64 RGBA），读取像素失败时返回 null。
     */
    function imageToRaster(source, srcW, srcH, wMm, hMm) {
        if (!source || !(wMm > 0.2) || !(hMm > 0.2)) return null;
        let gw = Math.max(1, Math.round(wMm / 0.12)), gh = Math.max(1, Math.round(hMm / 0.12));
        const k = Math.min(1, 260 / Math.max(gw, gh), (srcW || 256) / gw, (srcH || 256) / gh);
        gw = Math.max(1, Math.round(gw * k)); gh = Math.max(1, Math.round(gh * k));
        const cv = document.createElement('canvas');
        cv.width = gw; cv.height = gh;
        const ctx = cv.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(source, 0, 0, gw, gh);
        let data;
        try { data = ctx.getImageData(0, 0, gw, gh).data; } catch (e) { return null; }
        let bin = '';
        for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode.apply(null, data.subarray(i, i + 0x8000));
        return { gw, gh, px: btoa(bin) };
    }

    global.CadShared = { CAD_VERSION, CAD_FONT, CAD_FONTS, cadFont, loadAcadrust, imageToRaster };
})(window);
