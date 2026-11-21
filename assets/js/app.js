        // 材质/花色数据见 material-lib.js（预设来自 assets/data/materials.json，自定义花色存于 IndexedDB）

        /* 预设参数（铺法、门洞连接形式、默认单价、规格类型等）见 assets/data/presets.json，启动时由 PresetLib.load() 读入全局 PRESETS */
        const patternLabel = p => PRESETS.floor.patterns[p] || PRESETS.floor.patterns.straight;
        const matPreset = mt => PRESETS.floor.byMaterial[mt === 'wood' ? 'wood' : 'tile'];
        const defaultSpecPrice = () => PRESETS.floor.defaultSpecPrice;
        /** 单价类字段：有效非负数取原值，否则取预设默认 */
        const priceOr = (v, def) => (v != null && v !== '' && Number.isFinite(Number(v))) ? Math.max(0, Number(v)) : def;

        /*************************************************************************
         * 二维画布主题：与 style.css :root 中的 --cv-* 设计变量同源。
         * 启动时从 CSS 变量读取（读取失败时使用同值兜底），画布中的网格、瓷砖、墙体、
         * 尺寸标注、选中/悬停态统一引用这里，避免各处散落不一致的蓝色。
         *************************************************************************/
        const CANVAS_THEME = (() => {
            const t = {
                bg: '#F5F7FA', gridMinor: '#E7ECF2', gridMajor: '#D4DCE7',
                tileFill: '#F0F4F8', tileStroke: '#91A2B8', tileText: '#8E9DB2',
                tileHoverFill: 'rgba(53, 106, 230, 0.07)',
                tileSelectedFill: '#DCE9FF', tileSelectedStroke: '#356AE6',
                cutLargeFill: '#F5EFE4', cutLargeStroke: '#C2A77E', cutLargeText: '#9A7B4C',
                cutSmallFill: '#F7ECEC', cutSmallStroke: '#C99A9A', cutSmallText: '#A86565',
                wall: '#3E4C5F', wallHover: '#6B7A8F',
                accent: '#356AE6', accentDark: '#2D5DD0', accentSoft: '#EEF4FF', accentSubtle: '#F6F9FF', accentBorder: '#C7D7F8',
                dimLine: '#A3B0C2', dimText: '#55657B', dimPill: 'rgba(255, 255, 255, 0.94)', dimPillBorder: '#D4DCE7',
                guide: 'rgba(53, 106, 230, 0.45)',
                label: '#253449', label2: '#5A6A80', label3: '#8592A6',
                openingGap: '#F7F9FB', doorArc: '#97A4B6', doorLeaf: '#4A5A70',
                windowFill: 'rgba(220, 233, 255, 0.65)', windowLine: '#7C9CCB'
            };
            const map = {
                bg: '--cv-bg', gridMinor: '--cv-grid-minor', gridMajor: '--cv-grid-major',
                tileFill: '--cv-tile-fill', tileStroke: '--cv-tile-stroke', tileText: '--cv-tile-text',
                tileHoverFill: '--cv-tile-hover-fill', tileSelectedFill: '--cv-tile-selected-fill', tileSelectedStroke: '--cv-tile-selected-stroke',
                cutLargeFill: '--cv-cut-large-fill', cutLargeStroke: '--cv-cut-large-stroke', cutLargeText: '--cv-cut-large-text',
                cutSmallFill: '--cv-cut-small-fill', cutSmallStroke: '--cv-cut-small-stroke', cutSmallText: '--cv-cut-small-text',
                wall: '--cv-wall', wallHover: '--cv-wall-hover', accent: '--primary', accentDark: '--primary-hover',
                accentSoft: '--primary-soft', accentSubtle: '--primary-subtle', accentBorder: '--primary-border',
                dimLine: '--cv-dim-line', dimText: '--cv-dim-text', dimPill: '--cv-dim-pill', dimPillBorder: '--cv-dim-pill-border',
                guide: '--cv-guide', label: '--cv-label', label2: '--cv-label-2', label3: '--cv-label-3'
            };
            try {
                const cs = getComputedStyle(document.documentElement);
                for (const k in map) {
                    const v = cs.getPropertyValue(map[k]).trim();
                    if (v) t[k] = v;
                }
            } catch (e) { /* 非浏览器环境：保留兜底值 */ }
            return t;
        })();
        const CANVAS_FONT_MONO = '"Cascadia Mono", Consolas, "Segoe UI Mono", "TileCalcCN", monospace';
        const CANVAS_FONT_SANS = '"Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", "PingFang SC", "Noto Sans SC", "TileCalcCN", sans-serif';

        // 砖块分类标记统一配色（低饱和、近白填充 + 蓝灰描边；画布 / 门洞 / 导出图纸 / 图例共用）
        // label：主画布编号色（低对比）；text：导出图纸编号色（打印需更清晰，保持较深）
        const TILE_MARK_COLORS = {
            // fill：砖号模式下叠加在花色/贴图之上的半透明分类色（整砖不叠色，直接显示材质）
            FULL:      { fill: null,                        solid: CANVAS_THEME.tileFill,     stroke: CANVAS_THEME.tileStroke,     label: CANVAS_THEME.tileText,     text: '#4A5E7A' },
        };
        // v4.7.2：边角裁切块不再单独着色，与整砖保持一致（画布 / 立面 / 导出 / CAD 统一）
        TILE_MARK_COLORS.CUT_LARGE = TILE_MARK_COLORS.FULL;
        TILE_MARK_COLORS.CUT_SMALL = TILE_MARK_COLORS.FULL;
        const tileMarkColor = (category) => TILE_MARK_COLORS[category] || TILE_MARK_COLORS.FULL;
        /** 图纸 / CAD 中的长度文字：随全局单位（mm / cm / m），数值不带单位，单位写在表头或标题 */
        const uLen = mm => Units.val(mm);
        const uSpec = (w, h, sep = '×') => `${Units.val(w)}${sep}${Units.val(h)}`;

        /*************************************************************************
         * 规格编号 v4.7.2：砖号 = 前缀 + 规格号 + 后缀 + 序号，如 CT1-1
         *  - 前缀由材料类型决定（瓷砖 CT / 墙砖 WT / 石材 ST / 地板 WD），可按花色改写
         *  - 规格号：同前缀下按「花色 + 尺寸」首次出现顺序自动编号
         *  - 序号：同一规格在当前层内连续编号（先地面各空间，再各空间墙面）
         *************************************************************************/
        const allSpecKinds = () => {
            const out = [], seen = new Set();
            for (const grp of Object.values(PRESETS.specKinds || {})) {
                for (const item of (grp || [])) {
                    if (item && item.kind && !seen.has(item.kind)) {
                        seen.add(item.kind);
                        out.push(item);
                    }
                }
            }
            return out;
        };
        const specKindList = mt => {
            const all = allSpecKinds();
            return all.length ? all : (PRESETS.specKinds[mt === 'wood' ? 'wood' : 'tile'] || []);
        };
        const specKindPrefix = (mt, kind) => {
            const all = allSpecKinds();
            const hit = all.find(k => k.kind === kind);
            if (hit) return hit.prefix;
            const grp = PRESETS.specKinds[mt === 'wood' ? 'wood' : 'tile'] || all;
            return (grp[0] || { prefix: 'CT' }).prefix;
        };
        /** 花色在某用途（floor 地面 / wall 墙面）下的编号设置：工程内改写 → 花色自带 → 用途默认 */
        function getSpecMeta(ctx, materialType, styleId) {
            const mt = materialType === 'wood' ? 'wood' : 'tile';
            const st = MaterialLib.get(styleId, mt);
            const ov = (STATE.specMeta || {})[`${ctx}:${st.id}`];
            const defKind = mt === 'wood' ? '地板' : (ctx === 'wall' ? '墙砖' : '瓷砖');
            const kind = (ov && ov.kind) || st.kind || defKind;
            const known = specKindList(mt).some(k => k.kind === kind) ? kind : defKind;
            let prefix = ov && ov.prefix != null ? ov.prefix : (st.prefix != null && st.prefix !== '' && !(ov && ov.kind) ? st.prefix : specKindPrefix(mt, known));
            prefix = String(prefix).replace(/\s+/g, '').slice(0, 6);
            return { kind: known, prefix, styleId: st.id, materialType: mt };
        }
        /** 图示说明中的材料标签：始终明确指明材质类型（地砖 / 墙砖 / 木地板 / 石材 / 过门石）+ 花色名称 */
        function formatLegendMaterialName(ctx, metaKind, materialType, styleName) {
            let kind = String(metaKind || '').trim();
            if (ctx === 'threshold') {
                kind = '过门石';
            } else if (ctx === 'wall') {
                if (!kind || kind === '瓷砖') kind = '墙砖';
                else if (kind === '地板') kind = '木地板';
            } else {
                if (materialType === 'wood') kind = (!kind || kind === '地板') ? '木地板' : kind;
                else if (!kind || kind === '瓷砖') kind = '地砖';
            }
            const name = String(styleName || '').trim();
            if (!name) return kind;
            if (name.includes(kind)) return name;
            return `${kind}·${name}`;
        }
        function setSpecMeta(ctx, materialType, styleId, patch) {
            const st = MaterialLib.get(styleId, materialType === 'wood' ? 'wood' : 'tile');
            if (!STATE.specMeta) STATE.specMeta = {};
            const key = `${ctx}:${st.id}`;
            const cur = Object.assign({}, STATE.specMeta[key] || {});
            if (patch.kind) { cur.kind = patch.kind; cur.prefix = specKindPrefix(materialType, patch.kind); }
            if (patch.prefix != null) cur.prefix = String(patch.prefix).replace(/\s+/g, '').slice(0, 6);
            STATE.specMeta[key] = cur;
        }
        const tileNumSep = () => (STATE.tileNumSep == null ? '-' : String(STATE.tileNumSep));
        /** 全层重新编号：地面砖与墙面砖统一按规格编号；返回规格表 */
        function renumberTiles() {
            const sep = tileNumSep();
            const specs = new Map(), perPrefix = new Map();
            const specOf = (ctx, mt, styleId, w, h) => {
                const meta = getSpecMeta(ctx, mt, styleId);
                const a = Math.round(Number(w) || 0), b = Math.round(Number(h) || 0);
                const key = `${meta.prefix}|${meta.styleId}|${Math.min(a, b)}x${Math.max(a, b)}`;
                let sp = specs.get(key);
                if (!sp) {
                    const no = (perPrefix.get(meta.prefix) || 0) + 1;
                    perPrefix.set(meta.prefix, no);
                    sp = { key, prefix: meta.prefix, kind: meta.kind, no, label: `${meta.prefix}${no}`, styleId: meta.styleId, materialType: meta.materialType, w: a, h: b, count: 0 };
                    specs.set(key, sp);
                }
                return sp;
            };
            for (const room of STATE.rooms) {
                room.specLabel = '';
                if (room.cleared || !room.computedTiles || !room.computedTiles.length) continue;
                const sp = specOf('floor', room.materialType, room.styleId, room.tileW, room.tileH);
                room.specLabel = sp.label;
                for (const t of room.computedTiles) t.id = `${sp.label}${sep}${++sp.count}`;
            }
            if (typeof Elevation !== 'undefined' && Elevation.forEachWallZone) {
                Elevation.forEachWallZone(z => {
                    const sp = specOf('wall', 'tile', z.spec.styleId, z.tw, z.th);
                    z.specLabel = sp.label;
                    for (const t of z.tiles) t.id = `${sp.label}${sep}${++sp.count}`;
                });
            }
            STATE.specList = [...specs.values()];
            return STATE.specList;
        }
        /** 某空间地面规格的预览编号（未铺贴时按当前设置推算） */
        function previewRoomSpecLabel(room) {
            if (room && room.specLabel) return room.specLabel;
            const m = room ? getSpecMeta('floor', room.materialType, room.styleId) : { prefix: 'CT' };
            return `${m.prefix}?`;
        }

        const SCALE_PIXELS_PER_METER = 50; // 50px = 1m (20mm/px)
        const TILE_LABEL_MIN_PX = 24;      // 砖块短边在屏幕上小于此像素时隐藏编号（远景降噪）
        let g_uidCounter = 0;
        const uid = (prefix) => prefix + Date.now().toString(36) + '_' + (++g_uidCounter);

        /** DOM 快捷获取 */
        const $id = id => document.getElementById(id);
        /** 工程文件扩展名、工程名称 / 客户名称与材料单价 (元/m²) */
        const PROJECT_FILE_EXT = '.tcalc';
        const getProjectName = () => $id('project-name-input')?.value || PRESETS.project.defaultName;
        const getClientName = () => ($id('client-name-input')?.value || '').trim();
        const getCurrentFloor = () => STATE.floors.find(f => f.id === STATE.currentFloorId) || STATE.floors[0];
        /** 导出文件名：仅在启用楼层模式时附带当前层名称 */
        const getExportBaseName = () => (STATE.floorsEnabled && getCurrentFloor()?.name) ? `${getProjectName()}_${getCurrentFloor().name}` : getProjectName();
        function normalizeSpecKey(mt, styleId, w, h) {
            const t = mt === 'wood' ? 'wood' : 'tile';
            const st = MaterialLib.get(styleId, t);
            const a = Math.max(1, Math.round(Number(w) || 0));
            const b = Math.max(1, Math.round(Number(h) || 0));
            return `${t}|${st?.id || styleId || 'default'}|${Math.min(a, b)}x${Math.max(a, b)}`;
        }
        function getSpecPrice(mt, styleId, w, h) {
            const key = normalizeSpecKey(mt, styleId, w, h);
            const p = STATE.specPrices && STATE.specPrices[key];
            return (typeof p === 'number' && Number.isFinite(p) && p >= 0) ? p : defaultSpecPrice();
        }
        function setSpecPrice(mt, styleId, w, h, price) {
            if (!STATE.specPrices) STATE.specPrices = {};
            const key = normalizeSpecKey(mt, styleId, w, h);
            const v = Math.max(0, Number(price));
            STATE.specPrices[key] = Number.isFinite(v) ? v : defaultSpecPrice();
        }
        const getUnitPrice = (room = null) => {
            const r = room || getSelectedRoom();
            return r ? getSpecPrice(r.materialType, r.styleId, r.tileW, r.tileH) : defaultSpecPrice();
        };

        /*************************************************************************
         * 二、全局统一状态
         *************************************************************************/
        const STATE = {
            vertices: [],
            walls: [],
            openings: [],
            rooms: [],

            unit: 'mm',
            scale: 1.0,
            panX: 40,
            panY: 20,
            isPanning: false,
            panStart: { x: 0, y: 0 },
            isSpacePressed: false,

            tool: 'select',
            selected: null,
            selectedRoomId: null,
            selectedWallIds: new Set(),
            hovered: null,
            hoveredDimension: null,

            wallStartVertex: null,
            mouseWorldPos: { x: 0, y: 0 },
            originSnapPreview: null,
            openingSnapPreview: null,
            groutSnapGuides: null,   // 起铺点拖动时的砖缝对齐提示线
            specPrices: {},          // 主材规格单价：{ `${mt}|${styleId}|${minW}x${maxH}`: number }
            dragAltKey: false,
            isDragging: false,
            dragTarget: null,
            dragStartMouse: { x: 0, y: 0 },
            mergeCandidate: null,
            wallDraft: null,
            lastWallDraftDir: null,
            dimInputTyping: false,
            draftPopoverShown: false,
            draftPopoverDismissed: false,
            activeSnapLines: [],
            editingWallId: null,
            editingClearPx: null,
            editingDimKind: null,

            gridSnap: true,
            showGrid: true,
            gridSize: 20,
            snapRadius: 20,
            alignSnapRadius: 12,
            showDimensions: true,
            showPaving: true,
            showTileMarks: false,
            showDoorLeaves: true,
            showRoomLabels: true,
            showOrigins: false,
            showCompass: true,

            computedDoors: [],
            doorSummary: {
                thresholdCount: 0,
                thresholdAreaSqm: 0,
                stripCount: 0,
                stripLengthM: 0,
                doorExtraCost: 0
            },

            measurePoints: [],
            northAngle: 0,
            currentFilePath: null,
            currentFileRevision: null,
            specMeta: {},          // 规格编号改写：{ "floor:花色id" | "wall:花色id": { kind, prefix } }
            tileNumSep: '-',       // 砖号后缀（规格号与序号之间）
            compassHover: false,
            compassDragging: false,

            bgImage: null,
            imageWidth: 960,
            imageHeight: 860,
            bgWorldScale: 1.0,
            bgOffsetX: 0,
            bgOffsetY: 0,
            showBgImage: true,
            bgOpacity: 0.45,
            stage1Canvas: null,
            stage2Canvas: null,

            // 多层图纸（类似 Excel 多工作表）：每层独立的户型/排砖数据；STATE 中的 vertices/walls/... 始终为当前层
            floorsEnabled: false,  // 默认禁用楼层模式（单层且不显示下拉框、导出不加 *F 前缀）
            floors: [{ id: 'F1', name: '1F', snap: null, undo: [], redo: [], bg: null, view: null }],
            currentFloorId: 'F1',
            ghostLowerFloor: false, // 透显底层（紧邻下一层的墙体/门窗/房间参考）
            ghostLowerOpacity: 0.35, // 透显底层透明度 (0.10 ~ 0.85)
            floorHeightMM: 0,      // 当前层层高 (mm)，随层快照保存；启动时取 presets.json wall.floorHeightMM

            undoStack: [],   // 修改前的状态快照（栈顶 = 最近一次修改之前）
            redoStack: [],
            dirty: false     // 有未保存的修改
        };

        let isoYawAngle = 0.68;

        const canvas = $id('main-canvas');
        const ctx = canvas.getContext('2d');
        const container = $id('canvas-wrapper');

        /*************************************************************************
         * 三、基础几何与拓扑辅助函数
         *************************************************************************/
        function distSq(p1, p2) {
            const dx = p1.x - p2.x, dy = p1.y - p2.y;
            return dx * dx + dy * dy;
        }
        function dist(p1, p2) {
            return Math.hypot(p1.x - p2.x, p1.y - p2.y);
        }
        function getVertex(id) {
            return STATE.vertices.find(v => v.id === id);
        }
        function getWall(id) {
            return STATE.walls.find(w => w.id === id);
        }
        function isWallSelected(wallId) {
            return STATE.selectedWallIds.has(wallId) || (STATE.selected?.type === 'wall' && STATE.selected.id === wallId);
        }
        function toWorld(screenX, screenY) {
            return {
                x: (screenX - STATE.panX) / STATE.scale,
                y: (screenY - STATE.panY) / STATE.scale
            };
        }
        function toScreen(worldX, worldY) {
            return {
                x: worldX * STATE.scale + STATE.panX,
                y: worldY * STATE.scale + STATE.panY
            };
        }
        function projectPointToSegment(p, v1, v2) {
            const l2 = distSq(v1, v2);
            if (l2 === 0) return { t: 0, projPoint: { x: v1.x, y: v1.y }, distance: dist(p, v1) };
            let t = ((p.x - v1.x) * (v2.x - v1.x) + (p.y - v1.y) * (v2.y - v1.y)) / l2;
            t = Math.max(0, Math.min(1, t));
            const projPoint = {
                x: v1.x + t * (v2.x - v1.x),
                y: v1.y + t * (v2.y - v1.y)
            };
            return { t, projPoint, distance: dist(p, projPoint) };
        }
        /** 多边形有向面积 (px²，鞋带公式)；正负表示顶点绕向 */
        function polygonSignedArea(poly) {
            if (!poly || poly.length < 3) return 0;
            let s = 0;
            for (let i = 0, n = poly.length; i < n; i++) {
                const a = poly[i], b = poly[(i + 1) % n];
                s += a.x * b.y - b.x * a.y;
            }
            return s * 0.5;
        }
        // 注意：面积累加顺序会影响 50% 临界砖的分类，保持原有求和公式不变以确保算量结果稳定
        function computePolygonAreaPx(poly) {
            if (!poly || poly.length < 3) return 0;
            let area = 0;
            for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
                area += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y);
            }
            return Math.abs(area) / 2;
        }
        function computePolygonAreaMeters(vertices) {
            if (!vertices || vertices.length < 3) return 0;
            let area = 0;
            for (let i = 0; i < vertices.length; i++) {
                const j = (i + 1) % vertices.length;
                area += vertices[i].x * vertices[j].y;
                area -= vertices[j].x * vertices[i].y;
            }
            return (Math.abs(area) / 2) / (SCALE_PIXELS_PER_METER * SCALE_PIXELS_PER_METER);
        }
        /** 点集包围盒 */
        function pointsBounds(pts) {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const p of pts) {
                if (p.x < minX) minX = p.x;
                if (p.x > maxX) maxX = p.x;
                if (p.y < minY) minY = p.y;
                if (p.y > maxY) maxY = p.y;
            }
            return { minX, minY, maxX, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
        }
        /** 在 Canvas 上描出闭合多边形路径（不含 beginPath / fill / stroke） */
        function tracePolygon(c, pts) {
            c.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y);
            c.closePath();
        }
        function computePolygonCentroid(vertices) {
            if (!vertices || vertices.length === 0) return { x: 0, y: 0 };
            let cx = 0, cy = 0;
            for (const v of vertices) { cx += v.x; cy += v.y; }
            return { x: cx / vertices.length, y: cy / vertices.length };
        }
        function isPointInPolygon(point, vertices) {
            if (!vertices || vertices.length < 3) return false;
            let inside = false;
            for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
                const xi = vertices[i].x, yi = vertices[i].y;
                const xj = vertices[j].x, yj = vertices[j].y;
                const intersect = ((yi > point.y) !== (yj > point.y)) &&
                    (point.x < (xj - xi) * (point.y - yi) / ((yj - yi) || 1e-7) + xi);
                if (intersect) inside = !inside;
            }
            return inside;
        }
        function formatMeasureValue(meters) {
            if (STATE.unit === 'mm') return `${Math.round(meters * 1000)} mm`;
            if (STATE.unit === 'cm') return `${(meters * 100).toFixed(1)} cm`;
            return `${meters.toFixed(2)} m`;
        }

        /**
         * 数据变更后的统一刷新（按固定顺序）：重算排砖 → 左侧参数面板 → 属性面板 → 算量结果 → 3D 预览 → 画布。
         * 只传需要的项；canvas 默认刷新。
         */
        function refreshViews({ tiling = false, panel = false, inspector = false, results = false, preview3d = false, canvas = true } = {}) {
            if (tiling) recomputeAllRoomTiling();
            if (panel) syncLeftPanelFromSelectedRoom();
            if (inspector) updateInspector();
            if (results) renderCalculationResults();
            if (preview3d) render3DIsometricPreview();
            if (canvas) render();
        }

        /** 新空间的默认属性：presets.json 中 floor.room（通用）+ floor.byMaterial（按材质）+ wall.face（墙面美缝/辅料默认） */
        function createDefaultRoomProps(overrides = {}) {
            const fr = PRESETS.floor.room, mp = matPreset(overrides.materialType), wf = PRESETS.wall.face;
            return Object.assign({
                id: uid('r_'),
                name: '未命名空间',
                autoGenerated: true,
                vertexIds: [],
                materialType: 'tile',
                styleId: null,   // null = 当前材质类型的第一个预设花色
                tileW: mp.tileW,
                tileH: mp.tileH,
                gap: mp.gap,
                groutEnabled: fr.groutEnabled,
                groutColor: fr.groutColor,
                groutDepth: fr.groutDepth,
                groutPrice: fr.groutPrice,
                auxPrice: mp.auxPrice,
                // 墙面美缝 / 辅料：新建墙面铺贴时的初值（立面「全部墙面」修改时同步更新）
                wallGroutEnabled: wf.groutEnabled,
                wallGroutColor: wf.groutColor,
                wallGroutPrice: wf.groutPrice,
                wallAuxPrice: wf.auxPrice,
                expansionGap: mp.expansionGap,
                originMode: 'bl',
                originX: null,
                originY: null,
                originDoorAlign: null,   // 'x' / 'y'：起铺点位于门洞，砖在该方向对齐门洞
                originDoorId: null,      // 绑定的门洞 ID（移动门洞时起铺点自动跟随门中）
                originDoorOffset: 0,     // 门洞起铺沿门宽方向的优排偏移量 (px)
                pattern: mp.pattern,
                wastage: fr.wastage,
                cleared: false,
                computedTiles: [],
                stats: {
                    areaSqm: 0, buyAreaSqm: 0, fullCount: 0, cutLargeCount: 0, cutSmallCount: 0, buyCount: 0,
                    groutLengthM: 0, groutTubes: 0, groutCost: 0, auxArea: 0, auxCost: 0
                }
            }, overrides);
        }

        /*************************************************************************
         * 四、墙体吸附、闭合修复、共线合并与半边拓扑房间自动识别
         *************************************************************************/
        function findCollinearAndOrthoSnaps(currentVal, isXAxis, excludeVertexIds = [], snapRadius) {
            snapRadius = snapRadius || STATE.alignSnapRadius;
            let bestDiff = snapRadius + 1;
            let snapResult = null;
            const excludeSet = new Set(excludeVertexIds);

            const checkVert = (v) => {
                const targetVal = isXAxis ? v.x : v.y;
                const diff = Math.abs(currentVal - targetVal);
                if (diff <= snapRadius && diff < bestDiff) {
                    bestDiff = diff;
                    snapResult = {
                        snappedVal: targetVal,
                        type: isXAxis ? 'x' : 'y',
                        value: targetVal,
                        anchor: { x: v.x, y: v.y },
                        isCollinear: true
                    };
                }
            };
            for (const v of STATE.vertices) {
                if (excludeSet.has(v.id)) continue;
                checkVert(v);
            }
            const ghostLower = STATE.ghostLowerFloor ? getLowerFloor() : null;
            if (ghostLower?.snap?.vertices) {
                for (const v of ghostLower.snap.vertices) checkVert(v);
            }
            return snapResult;
        }

        function snapPos(pos) {
            STATE.activeSnapLines = [];
            let x = pos.x, y = pos.y;
            let axisLocked = false;

            const snapR = Math.max(10, Math.min(36, STATE.snapRadius / STATE.scale));
            const alignR = Math.max(6, Math.min(22, STATE.alignSnapRadius / STATE.scale));

            if (STATE.tool === 'wall' && STATE.wallStartVertex) {
                const start = STATE.wallStartVertex;
                const dx = pos.x - start.x, dy = pos.y - start.y;
                const threshold = 18 / STATE.scale;
                if (Math.abs(dy) <= threshold && Math.abs(dx) >= Math.abs(dy)) {
                    y = start.y; axisLocked = true;
                } else if (Math.abs(dx) <= threshold && Math.abs(dy) > Math.abs(dx)) {
                    x = start.x; axisLocked = true;
                }
            }

            if (STATE.tool === 'wall') {
                const exclude = STATE.wallStartVertex ? [STATE.wallStartVertex.id] : [];
                const alignX = findCollinearAndOrthoSnaps(x, true, exclude, alignR);
                if (alignX && Math.abs(alignX.snappedVal - x) <= alignR) {
                    x = alignX.snappedVal; axisLocked = true;
                    STATE.activeSnapLines.push(alignX);
                }
                const alignY = findCollinearAndOrthoSnaps(y, false, exclude, alignR);
                if (alignY && Math.abs(alignY.snappedVal - y) <= alignR) {
                    y = alignY.snappedVal; axisLocked = true;
                    STATE.activeSnapLines.push(alignY);
                }
            }

            const snapTarget = { x, y };
            for (const v of STATE.vertices) {
                if (Math.hypot(v.x - snapTarget.x, v.y - snapTarget.y) <= snapR) {
                    return { x: v.x, y: v.y, snappedVertex: v, wallSnap: null };
                }
            }

            let nearest = null;
            for (const wall of STATE.walls) {
                const a = getVertex(wall.v1), b = getVertex(wall.v2);
                if (!a || !b) continue;
                const dx = b.x - a.x, dy = b.y - a.y;
                const len2 = dx * dx + dy * dy;
                if (!len2) continue;
                const t = Math.max(0, Math.min(1, ((snapTarget.x - a.x) * dx + (snapTarget.y - a.y) * dy) / len2));
                const px = a.x + t * dx, py = a.y + t * dy;
                const distance = Math.hypot(snapTarget.x - px, snapTarget.y - py);
                if (distance <= snapR && (!nearest || distance < nearest.distance)) {
                    nearest = { x: px, y: py, distance, wallSnap: { wall, t } };
                }
            }
            if (nearest && nearest.wallSnap.t > 0.01 && nearest.wallSnap.t < 0.99) {
                return { x: nearest.x, y: nearest.y, snappedVertex: null, wallSnap: nearest.wallSnap };
            }
            if (nearest) {
                const wall = nearest.wallSnap.wall;
                const endId = nearest.wallSnap.t <= 0.01 ? wall.v1 : wall.v2;
                const endV = getVertex(endId);
                if (endV && dist(snapTarget, endV) <= snapR) {
                    return { x: endV.x, y: endV.y, snappedVertex: endV, wallSnap: null };
                }
            }

            // 透显底层开启时，允许墙体端点次级吸附至底层墙角，便于上下层对齐绘制
            const ghostLower = STATE.ghostLowerFloor ? getLowerFloor() : null;
            if (ghostLower?.snap?.vertices) {
                for (const gv of ghostLower.snap.vertices) {
                    if (Math.hypot(gv.x - snapTarget.x, gv.y - snapTarget.y) <= snapR) {
                        return { x: gv.x, y: gv.y, snappedVertex: null, wallSnap: null };
                    }
                }
            }

            if (STATE.gridSnap && !axisLocked) {
                x = Math.round(x / STATE.gridSize) * STATE.gridSize;
                y = Math.round(y / STATE.gridSize) * STATE.gridSize;
            }
            return { x, y, snappedVertex: null, wallSnap: null };
        }

        function isFreeVertex(vid) {
            let count = 0;
            for (const w of STATE.walls) {
                if (w.v1 === vid || w.v2 === vid) count++;
                if (count > 1) return false;
            }
            return true;
        }

        function smartCloseWallEnd(startV, snapped) {
            const tol = Math.max(8, Math.min(28, 22 / STATE.scale));
            let x = snapped.x, y = snapped.y;
            let vertex = snapped.snappedVertex || null;
            let wallSnap = snapped.wallSnap || null;
            let corrected = false;

            if (!vertex && !wallSnap) {
                let bestD = Infinity;
                for (const v of STATE.vertices) {
                    if (v.id === startV.id) continue;
                    const d = Math.hypot(v.x - x, v.y - y);
                    if (d <= tol && d < bestD) { bestD = d; vertex = v; }
                }
            }
            if (vertex) {
                if (Math.hypot(vertex.x - x, vertex.y - y) > 0.001) corrected = true;
                x = vertex.x; y = vertex.y; wallSnap = null;
            }

            const dx = x - startV.x, dy = y - startV.y;
            const vertical = Math.abs(dx) <= tol && Math.abs(dy) > Math.abs(dx);
            const horizontal = !vertical && Math.abs(dy) <= tol && Math.abs(dx) >= Math.abs(dy);
            if (vertical || horizontal) {
                if (!vertex) {
                    if (vertical && x !== startV.x) { x = startV.x; corrected = true; }
                    else if (horizontal && y !== startV.y) { y = startV.y; corrected = true; }
                } else {
                    const dev = vertical ? Math.abs(vertex.x - startV.x) : Math.abs(vertex.y - startV.y);
                    if (isFreeVertex(startV.id) || dev <= 12) {
                        if (vertical && startV.x !== vertex.x) { startV.x = vertex.x; corrected = true; }
                        else if (horizontal && startV.y !== vertex.y) { startV.y = vertex.y; corrected = true; }
                    }
                }
            }

            if (wallSnap && !vertex) {
                const a = getVertex(wallSnap.wall.v1);
                const b = getVertex(wallSnap.wall.v2);
                if (a && b) {
                    const proj = projectPointToSegment({ x, y }, a, b);
                    wallSnap = { wall: wallSnap.wall, t: proj.t };
                    x = proj.projPoint.x; y = proj.projPoint.y;
                }
            }
            return { x, y, vertex, wallSnap, corrected };
        }

        function splitWallAt(wall, vertex, t) {
            if (!wall || !vertex || t <= 0.01 || t >= 0.99) return;
            const index = STATE.walls.findIndex(w => w.id === wall.id);
            if (index < 0) return;
            const thickness = wall.thickness || 12;
            const w1 = { id: uid('w_'), v1: wall.v1, v2: vertex.id, thickness };
            const w2 = { id: uid('w_'), v1: vertex.id, v2: wall.v2, thickness };
            STATE.walls.splice(index, 1, w1, w2);
            STATE.openings.forEach(op => {
                if (op.wallId !== wall.id) return;
                if (op.t <= t) {
                    op.wallId = w1.id;
                    op.t = op.t / t;
                } else {
                    op.wallId = w2.id;
                    op.t = (op.t - t) / (1 - t);
                }
            });
        }

        function vertexMergeTolerance() {
            return Math.max(8, Math.min(26, 16 / STATE.scale));
        }

        function findVertexNear(pos, excludeIds = [], tol = null) {
            const t = tol == null ? vertexMergeTolerance() : tol;
            const exclude = new Set(excludeIds);
            let best = null, bestD = Infinity;
            for (const v of STATE.vertices) {
                if (exclude.has(v.id)) continue;
                const d = dist(pos, v);
                if (d <= t && d < bestD) { bestD = d; best = v; }
            }
            return best;
        }

        function cleanupDuplicateWalls() {
            const seen = new Set();
            const out = [];
            for (const w of STATE.walls) {
                if (w.v1 === w.v2) continue;
                const key = [w.v1, w.v2].sort().join('|');
                if (seen.has(key)) continue;
                seen.add(key);
                out.push(w);
            }
            STATE.walls = out;
        }

        function removeOrphanVertices() {
            const used = new Set();
            STATE.walls.forEach(w => { used.add(w.v1); used.add(w.v2); });
            const removed = new Set();
            STATE.vertices.forEach(v => { if (!used.has(v.id)) removed.add(v.id); });
            if (removed.size === 0) return false;
            STATE.vertices = STATE.vertices.filter(v => !removed.has(v.id));
            return true;
        }

        function mergeCollinearWallsAt(vertexId) {
            const v = getVertex(vertexId);
            if (!v) return null;
            const linked = STATE.walls.filter(w => w.v1 === vertexId || w.v2 === vertexId);
            if (linked.length !== 2) return null;

            const [w1, w2] = linked;
            const a = getVertex(w1.v1 === vertexId ? w1.v2 : w1.v1);
            const b = getVertex(w2.v1 === vertexId ? w2.v2 : w2.v1);
            if (!a || !b || a.id === b.id) return null;

            const d1 = { x: a.x - v.x, y: a.y - v.y };
            const d2 = { x: b.x - v.x, y: b.y - v.y };
            const l1 = Math.hypot(d1.x, d1.y), l2 = Math.hypot(d2.x, d2.y);
            if (l1 < 0.001 || l2 < 0.001) return null;

            const cross = (d1.x * d2.y - d1.y * d2.x) / (l1 * l2);
            if (Math.abs(cross) > 0.02) return null;

            const ux = d1.x / l1, uy = d1.y / l1;
            const ta = l1;
            const tb = d2.x * ux + d2.y * uy;
            const cand = [{ t: 0, v }, { t: ta, v: a }, { t: tb, v: b }];
            cand.sort((p, q) => p.t - q.t);
            let lo = cand[0], hi = cand[2], mid = cand[1];
            if (lo.v.id === hi.v.id) return null;

            const keep = (w1.thickness || 12) >= (w2.thickness || 12) ? w1 : w2;
            const drop = keep === w1 ? w2 : w1;
            const k1 = getVertex(keep.v1), k2 = getVertex(keep.v2);
            const d3 = getVertex(drop.v1), d4 = getVertex(drop.v2);
            if (!k1 || !k2 || !d3 || !d4) return null;

            const midHasOther = STATE.walls.some(w =>
                w.id !== w1.id && w.id !== w2.id && (w.v1 === mid.v.id || w.v2 === mid.v.id));

            const oldDir = { x: k2.x - k1.x, y: k2.y - k1.y };
            const newDir = { x: hi.v.x - lo.v.x, y: hi.v.y - lo.v.y };
            if (oldDir.x * newDir.x + oldDir.y * newDir.y < 0) {
                const tmp = lo; lo = hi; hi = tmp;
            }

            keep.v1 = lo.v.id;
            keep.v2 = hi.v.id;
            keep.thickness = Math.max(w1.thickness || 12, w2.thickness || 12);

            const np1 = { x: lo.v.x, y: lo.v.y }, np2 = { x: hi.v.x, y: hi.v.y };
            for (const op of STATE.openings) {
                let p = null;
                if (op.wallId === keep.id) {
                    p = { x: k1.x + op.t * (k2.x - k1.x), y: k1.y + op.t * (k2.y - k1.y) };
                } else if (op.wallId === drop.id) {
                    p = { x: d3.x + op.t * (d4.x - d3.x), y: d3.y + op.t * (d4.y - d3.y) };
                }
                if (!p) continue;
                op.wallId = keep.id;
                op.t = Math.min(0.97, Math.max(0.03, projectPointToSegment(p, np1, np2).t));
            }

            STATE.walls = STATE.walls.filter(w => w.id !== drop.id);
            if (midHasOther) {
                const tm = projectPointToSegment(mid.v, np1, np2);
                splitWallAt(keep, mid.v, Math.min(0.97, Math.max(0.03, tm.t)));
            }
            removeOrphanVertices();
            return keep;
        }

        // 拖动结束后全图自动合并共线墙段：
        // 拉墙 / 拉端点过程中，被 splitWallAt 打断、或脱开再闭合的墙体常会残留
        // 一个只连接两面共线墙体的中间节点，使一面完整的墙变成两段。此处反复
        // 扫描所有节点并复用 mergeCollinearWallsAt 逐个消除这类多余分段（门窗洞口
        // 会按原位置重新投影到合并后的墙上）。中间节点若还连着其它墙体（T 形
        // 分户墙交点），mergeCollinearWallsAt 会自动跳过，不会破坏墙体交点。
        function autoMergeCollinearWalls() {
            cleanupDuplicateWalls();
            let mergedCount = 0;
            let changed = true;
            let guard = 0;
            while (changed && guard++ < 500) {
                changed = false;
                for (const v of STATE.vertices.slice()) {
                    if (!getVertex(v.id)) continue;
                    if (mergeCollinearWallsAt(v.id)) {
                        mergedCount++;
                        changed = true;
                        break; // 拓扑已变化，重新扫描，避免继续使用失效的墙体/节点引用
                    }
                }
            }
            if (mergedCount > 0) {
                cleanupDuplicateWalls();
                removeOrphanVertices();
                // 清理指向已被合并删除墙体的失效选中状态，避免检查器悬空
                if (STATE.selectedWallIds) {
                    STATE.selectedWallIds = new Set(
                        Array.from(STATE.selectedWallIds).filter(id => getWall(id)));
                }
                if (STATE.selected && STATE.selected.type === 'wall' && !getWall(STATE.selected.id)) {
                    STATE.selected = null;
                }
            }
            return mergedCount;
        }

        function mergeVertices(fromId, toId) {
            if (!fromId || !toId || fromId === toId) return false;
            const from = getVertex(fromId), to = getVertex(toId);
            if (!from || !to) return false;
            for (const w of STATE.walls) {
                if (w.v1 === fromId) w.v1 = toId;
                if (w.v2 === fromId) w.v2 = toId;
            }
            STATE.vertices = STATE.vertices.filter(v => v.id !== fromId);
            cleanupDuplicateWalls();
            mergeCollinearWallsAt(toId);
            return true;
        }

        function canonicalCycleKey(ids) {
            if (!ids || ids.length < 3) return null;
            let start = 0;
            for (let i = 1; i < ids.length; i++) {
                if (String(ids[i]) < String(ids[start])) start = i;
            }
            const rotated = [];
            for (let i = 0; i < ids.length; i++) rotated.push(ids[(start + i) % ids.length]);
            return rotated.join('|');
        }

        function isAutoSpace(room) {
            if (!room) return true;
            if (room.autoGenerated === false) return false;
            const name = (room.name || '').trim();
            return name === '' || /^空间\s*\d*$/.test(name);
        }

        function detectInteriorFaces() {
            // 若拖动过程中两个端点重合 (距离 < 0.5px)，按并查集归并为同一拓扑节点，避免 0 长度边干扰闭合环提取
            const uf = new Map();
            const findCanon = (id) => {
                let cur = id;
                while (uf.has(cur) && uf.get(cur) !== cur) cur = uf.get(cur);
                return cur;
            };
            for (const v of STATE.vertices) uf.set(v.id, v.id);
            for (const w of STATE.walls) {
                const a = getVertex(w.v1), b = getVertex(w.v2);
                if (a && b && Math.hypot(a.x - b.x, a.y - b.y) < 0.5) {
                    const ra = findCanon(a.id), rb = findCanon(b.id);
                    if (ra !== rb) uf.set(ra, rb);
                }
            }
            const adj = new Map();
            for (const v of STATE.vertices) {
                const c = findCanon(v.id);
                if (!adj.has(c)) adj.set(c, []);
            }
            for (const w of STATE.walls) {
                const u = findCanon(w.v1), v = findCanon(w.v2);
                if (u === v || !adj.has(u) || !adj.has(v)) continue;
                if (!adj.get(u).includes(v)) adj.get(u).push(v);
                if (!adj.get(v).includes(u)) adj.get(v).push(u);
            }

            // 剪枝度 <= 1 的悬空端点，防止 T 型门垛悬挑短边导致闭合环唯一顶点校验被误拒
            let pruned = true;
            while (pruned) {
                pruned = false;
                for (const [vid, list] of adj) {
                    if (list.length <= 1) {
                        for (const nb of list) {
                            const nbList = adj.get(nb);
                            if (nbList) {
                                const idx = nbList.indexOf(vid);
                                if (idx !== -1) nbList.splice(idx, 1);
                            }
                        }
                        adj.delete(vid);
                        pruned = true;
                    }
                }
            }

            for (const [vid, neighbors] of adj) {
                const v = getVertex(vid);
                if (!v) continue;
                neighbors.sort((a, b) => {
                    const va = getVertex(a), vb = getVertex(b);
                    if (!va || !vb) return 0;
                    return Math.atan2(va.y - v.y, va.x - v.x) - Math.atan2(vb.y - v.y, vb.x - v.x);
                });
            }

            const faces = [];
            const seen = new Set();

            for (const [u, neighbors] of adj) {
                for (const v of neighbors) {
                    const firstKey = `${u}->${v}`;
                    if (seen.has(firstKey)) continue;
                    seen.add(firstKey);

                    const cycle = [u];
                    let prev = u, curr = v, valid = true, guard = 0;

                    while (true) {
                        cycle.push(curr);
                        const links = adj.get(curr) || [];
                        const prevIdx = links.indexOf(prev);
                        if (links.length === 0 || prevIdx === -1) { valid = false; break; }
                        seen.add(`${prev}->${curr}`);

                        const nextIdx = (prevIdx - 1 + links.length) % links.length;
                        const next = links[nextIdx];
                        prev = curr;
                        curr = next;

                        if (curr === u) {
                            seen.add(`${prev}->${curr}`);
                            break;
                        }
                        if (++guard > 500) { valid = false; break; }
                    }

                    if (!valid || cycle.length < 3) continue;
                    const uniqueSet = new Set(cycle);
                    if (uniqueSet.size < 3 || uniqueSet.size !== cycle.length) continue;

                    let signed = 0, ok = true;
                    for (let i = 0; i < cycle.length; i++) {
                        const a = getVertex(cycle[i]);
                        const b = getVertex(cycle[(i + 1) % cycle.length]);
                        if (!a || !b) { ok = false; break; }
                        signed += a.x * b.y - b.x * a.y;
                    }
                    if (!ok || signed <= 0) continue;

                    const verts = cycle.map(id => getVertex(id)).filter(Boolean);
                    const area = computePolygonAreaMeters(verts);
                    if (area < 0.4) continue;

                    const key = canonicalCycleKey(cycle);
                    if (!key) continue;

                    faces.push({
                        ids: cycle.slice(),
                        key,
                        area,
                        poly: verts,
                        centroid: computePolygonCentroid(verts)
                    });
                }
            }

            const byKey = new Map();
            for (const f of faces) {
                if (!byKey.has(f.key)) byKey.set(f.key, f);
            }
            return Array.from(byKey.values());
        }

        function syncRoomsFromGeometry(options = {}) {
            const faces = detectInteriorFaces();
            faces.sort((a, b) => (a.centroid.y - b.centroid.y) || (a.centroid.x - b.centroid.x));

            const existingByKey = new Map();
            for (const room of STATE.rooms) {
                const k = canonicalCycleKey(room.vertexIds);
                if (k && !existingByKey.has(k)) existingByKey.set(k, room);
            }

            const nextRooms = [];
            const reused = new Set();

            for (const face of faces) {
                const existing = existingByKey.get(face.key);
                if (existing && !reused.has(existing)) {
                    existing.vertexIds = face.ids.slice();
                    nextRooms.push(existing);
                    reused.add(existing);
                    continue;
                }
                nextRooms.push(createDefaultRoomProps({
                    id: uid('r_'),
                    name: '',
                    autoGenerated: true,
                    vertexIds: face.ids.slice()
                }));
            }

            for (const room of STATE.rooms) {
                if (reused.has(room)) continue;
                const oldPoly = (room.vertexIds || []).map(id => getVertex(id)).filter(Boolean);
                const refPt = oldPoly.length >= 3 ? computePolygonCentroid(oldPoly) : null;
                if (!refPt) continue;

                for (const face of faces) {
                    const candidate = nextRooms.find(r => canonicalCycleKey(r.vertexIds) === face.key);
                    if (!candidate || !isAutoSpace(candidate)) continue;
                    if (isPointInPolygon(refPt, face.poly) || (oldPoly.length >= 3 && isPointInPolygon(face.centroid, oldPoly))) {
                        Object.assign(candidate, {
                            name: room.name,
                            autoGenerated: room.autoGenerated,
                            materialType: room.materialType,
                            styleId: room.styleId,
                            tileW: room.tileW,
                            tileH: room.tileH,
                            gap: room.gap,
                            groutEnabled: room.groutEnabled,
                            groutColor: room.groutColor,
                            groutDepth: room.groutDepth,
                            groutPrice: room.groutPrice,
                            auxPrice: room.auxPrice,
                            wallGroutEnabled: room.wallGroutEnabled,
                            wallGroutColor: room.wallGroutColor,
                            wallGroutPrice: room.wallGroutPrice,
                            wallAuxPrice: room.wallAuxPrice,
                            wallTiling: room.wallTiling ? JSON.parse(JSON.stringify(room.wallTiling)) : null,
                            expansionGap: room.expansionGap,
                            originMode: room.originMode,
                            originX: room.originX,
                            originY: room.originY,
                            originDoorAlign: room.originDoorAlign || null,
                            originDoorId: room.originDoorId || null,
                            originDoorOffset: room.originDoorOffset || 0,
                            pattern: room.pattern,
                            wastage: room.wastage,
                            cleared: room.cleared
                        });
                        break;
                    }
                }
            }

            let autoIndex = 1;
            for (const room of nextRooms) {
                if (isAutoSpace(room)) {
                    room.autoGenerated = true;
                    room.name = `空间 ${autoIndex++}`;
                }
            }

            STATE.rooms = nextRooms;
            if (!STATE.rooms.some(r => r.id === STATE.selectedRoomId)) {
                STATE.selectedRoomId = STATE.rooms[0]?.id || null;
            }

            recomputeAllRoomTiling();
            initRoomSelectorDropdown();
            syncLeftPanelFromSelectedRoom();
        }

        /*************************************************************************
         * 五、多边形几何裁切排砖与算量引擎
         *************************************************************************/
        /**
         * 反复移除过短边 (<0.5px) 与共线顶点，直到稳定；onDropCollinear(prev, curr) 在移除共线点时回调。
         * pts 会被原地使用，返回新数组。
         */
        function dropCollinearPoints(pts, onDropCollinear = null, keepCollinear = null) {
            if (!pts || pts.length <= 3) return pts ? pts.slice() : [];
            // 先消除相邻重合顶点（只移除重复的后一个点，绝不同时删除两个角点）
            const dedup = [];
            for (let i = 0; i < pts.length; i++) {
                const cur = pts[i];
                const prev = dedup.length > 0 ? dedup[dedup.length - 1] : pts[pts.length - 1];
                if ( dedup.length > 0 && Math.hypot(cur.x - prev.x, cur.y - prev.y) < 0.5 ) {
                    if (onDropCollinear) onDropCollinear(prev, cur);
                    continue;
                }
                dedup.push(cur);
            }
            if (dedup.length > 1 && Math.hypot(dedup[0].x - dedup[dedup.length - 1].x, dedup[0].y - dedup[dedup.length - 1].y) < 0.5) {
                const dropped = dedup.pop();
                if (onDropCollinear) onDropCollinear(dedup[0], dropped);
            }
            pts = dedup;

            let changed = true;
            while (changed && pts.length > 3) {
                changed = false;
                const m = pts.length;
                const nextPts = [];
                for (let i = 0; i < m; i++) {
                    const pPrev = pts[(i - 1 + m) % m];
                    const pCurr = pts[i];
                    const pNext = pts[(i + 1 + m) % m];
                    const dx1 = pCurr.x - pPrev.x, dy1 = pCurr.y - pPrev.y;
                    const dx2 = pNext.x - pCurr.x, dy2 = pNext.y - pCurr.y;
                    const l1 = Math.hypot(dx1, dy1), l2 = Math.hypot(dx2, dy2);
                    if (l1 < 0.5) {
                        if (onDropCollinear) onDropCollinear(pPrev, pCurr);
                        changed = true;
                        continue;
                    }
                    if (l2 < 0.5) {
                        nextPts.push(pCurr);
                        continue;
                    }
                    const cross = Math.abs(dx1 * dy2 - dy1 * dx2) / (l1 * l2);
                    const dot = (dx1 * dx2 + dy1 * dy2) / (l1 * l2);
                    if (cross < 0.025 && dot > 0 && !(keepCollinear && keepCollinear(pPrev, pCurr))) {
                        if (onDropCollinear) onDropCollinear(pPrev, pCurr);
                        changed = true;
                        continue;
                    }
                    nextPts.push(pCurr);
                }
                pts = nextPts;
            }
            return pts;
        }

        function simplifyCollinearPolygonVerts(verts) {
            if (!verts || verts.length <= 3) return verts ? verts.slice() : [];
            return dropCollinearPoints(verts.map(v => ({ x: v.x, y: v.y })));
        }

        function getRoomPolygonVerts(room) {
            const raw = (room.vertexIds || []).map(id => getVertex(id)).filter(Boolean);
            return simplifyCollinearPolygonVerts(raw);
        }

        function offsetRoomPolygonInward(room, extraInsetPx = 0, includeWallHalf = true) {
            const rawVerts = (room.vertexIds || []).map(id => getVertex(id)).filter(Boolean);
            const rawIds = room.vertexIds || [];
            if (rawVerts.length < 3) return rawVerts;
            if (extraInsetPx <= 0 && !includeWallHalf) return simplifyCollinearPolygonVerts(rawVerts);

            let pts = rawVerts.map((v, idx) => {
                const idA = rawIds[idx], idB = rawIds[(idx + 1) % rawVerts.length];
                const w = STATE.walls.find(wall =>
                    (wall.v1 === idA && wall.v2 === idB) || (wall.v1 === idB && wall.v2 === idA)
                );
                return {
                    x: v.x,
                    y: v.y,
                    wallHalf: includeWallHalf ? ((w ? (w.thickness || 12) : 12) / 2) : 0
                };
            });

            // 同一直线上的相邻墙段厚度不同（墙皮有台阶）时保留分界点，内缩后在该处生成垂直台阶，
            // 使铺贴区域贴合较薄墙段的墙皮，而不是整条边都按较厚墙段内缩。
            pts = dropCollinearPoints(pts,
                (prev, curr) => { prev.wallHalf = Math.max(prev.wallHalf, curr.wallHalf); },
                (prev, curr) => Math.abs((prev.wallHalf || 0) - (curr.wallHalf || 0)) > 0.05);

            const n = pts.length;
            if (n < 3) return simplifyCollinearPolygonVerts(rawVerts);

            const area2 = polygonSignedArea(pts) * 2;
            if (Math.abs(area2) < 1e-3) return simplifyCollinearPolygonVerts(rawVerts);
            const sign = area2 >= 0 ? 1 : -1;

            const { minX, maxX, minY, maxY } = pointsBounds(pts);
            const maxAllowedInset = Math.max(1, Math.min(maxX - minX, maxY - minY) * 0.32);

            const shiftedEdges = [];
            for (let i = 0; i < n; i++) {
                const a = pts[i], b = pts[(i + 1) % n];
                const distIn = Math.min(maxAllowedInset, (a.wallHalf || 0) + Math.max(0, extraInsetPx));
                const dx = b.x - a.x, dy = b.y - a.y;
                const len = Math.hypot(dx, dy) || 1;
                const ux = dx / len, uy = dy / len;
                const nx = -sign * uy, ny = sign * ux;
                shiftedEdges.push({ ux, uy, nx, ny, distIn });
            }

            const insetVerts = [];
            for (let i = 0; i < n; i++) {
                const P = pts[i];
                const ePrev = shiftedEdges[(i - 1 + n) % n];
                const eCurr = shiftedEdges[i];
                const Ax = P.x + ePrev.nx * ePrev.distIn;
                const Ay = P.y + ePrev.ny * ePrev.distIn;
                const Bx = P.x + eCurr.nx * eCurr.distIn;
                const By = P.y + eCurr.ny * eCurr.distIn;
                const cr = ePrev.ux * eCurr.uy - ePrev.uy * eCurr.ux;
                if (Math.abs(cr) < 1e-3) {
                    const sameDir = ePrev.ux * eCurr.ux + ePrev.uy * eCurr.uy > 0;
                    if (sameDir && Math.hypot(Bx - Ax, By - Ay) > 0.05) {
                        // 共线但内缩距离不同：先到上一段墙皮，再沿法向折到下一段墙皮（台阶）。
                        // 台阶处那一小段墙面同样要留外边缝：台阶线向较薄墙段一侧退 extraInset。
                        const extra = Math.max(0, extraInsetPx);
                        let sx = 0, sy = 0;
                        if (extra > 0) {
                            const Pp = pts[(i - 1 + n) % n], Pn = pts[(i + 1) % n];
                            const lim = 0.45 * Math.min(Math.hypot(P.x - Pp.x, P.y - Pp.y), Math.hypot(Pn.x - P.x, Pn.y - P.y));
                            const e = Math.min(extra, lim);
                            const dir = ePrev.distIn < eCurr.distIn ? -1 : 1;   // 上一段较薄 → 退向上一段
                            sx = eCurr.ux * e * dir; sy = eCurr.uy * e * dir;
                        }
                        insetVerts.push({ x: Ax + sx, y: Ay + sy });
                        insetVerts.push({ x: Bx + sx, y: By + sy });
                    } else {
                        insetVerts.push({ x: Bx, y: By });
                    }
                } else {
                    const t = ((Bx - Ax) * eCurr.uy - (By - Ay) * eCurr.ux) / cr;
                    const maxMiter = Math.max(ePrev.distIn, eCurr.distIn) * 3.0;
                    const clampedT = Math.max(-maxMiter, Math.min(maxMiter, t));
                    insetVerts.push({
                        x: Ax + ePrev.ux * clampedT,
                        y: Ay + ePrev.uy * clampedT
                    });
                }
            }

            if (computePolygonAreaPx(insetVerts) < 25) return simplifyCollinearPolygonVerts(rawVerts);
            return insetVerts;
        }

        function getRoomInnerWallVerts(room) {
            return offsetRoomPolygonInward(room, 0, true);
        }

        /** 毫米 → 画布世界坐标像素 (SCALE_PIXELS_PER_METER px = 1m) */
        function mmToPx(mm) {
            return (Number(mm) || 0) * SCALE_PIXELS_PER_METER / 1000;
        }

        /**
         * 缝隙在画布上的显示宽度 (世界坐标 px)：按真实比例，屏幕上至少 GAP_MIN_SCREEN_PX 像素。
         * 砖缝与外边缝共用此规则，同样毫米数在任何缩放下显示同样宽。
         */
        const GAP_MIN_SCREEN_PX = 1;
        function gapDisplayWidth(mm, targetCtx) {
            const zoom = (targetCtx === ctx ? STATE.scale : 1) || 1;
            return Math.max(mmToPx(mm), GAP_MIN_SCREEN_PX / zoom);
        }

        function getRoomPavingPolygonVerts(room) {
            const gapMM = Math.max(0, Number(room.expansionGap) || 0);
            if (gapMM > 0) {
                // 外边缝按真实毫米内缩（与砖缝同一比例），排砖、算量、DXF 共用
                return offsetRoomPolygonInward(room, mmToPx(gapMM), true);
            }
            // 外边缝为 0：铺贴边界 = 墙体内侧净空边界 (不再延伸到墙中线)
            return getRoomInnerWallVerts(room);
        }

        function getRoomBounds(room) {
            const verts = getRoomPolygonVerts(room);
            if (verts.length < 3) return { verts: [], minX: 0, maxX: 0, minY: 0, maxY: 0, cx: 0, cy: 0, perimeterM: 0 };
            const { minX, maxX, minY, maxY } = pointsBounds(verts);
            let perimPx = 0;
            for (let i = 0; i < verts.length; i++) {
                const a = verts[i], b = verts[(i + 1) % verts.length];
                perimPx += dist(a, b);
            }
            return {
                verts,
                minX, maxX, minY, maxY,
                cx: (minX + maxX) / 2,
                cy: (minY + maxY) / 2,
                perimeterM: perimPx / SCALE_PIXELS_PER_METER
            };
        }

        /** 砖缝(mm)：木地板按 0 缝铺贴 (仍然绘制板边线)，瓷砖取用户设置的砖缝 */
        function getRoomJointMM(room) {
            if (!room || room.materialType === 'wood') return 0;
            return Math.max(0, Number(room.gap) || 0);
        }

        /**
         * 起铺点解析：返回 { x, y, label, gx, gy }。
         * gx / gy 为排砖生长方向 (+1 向右/向下铺，-1 向左/向上铺)：
         *  - 预设角点按所在角决定方向 (右上角 = 向左、向下铺 ...)；
         *  - 自定义起铺点若吸附在墙内侧，则自动贴合“铺贴边界”(墙内侧再内缩外边缝)，并按所在墙角决定生长方向，
         *    这样起铺点 X/Y 两个方向的第一排都是整块，而不是被削掉一条边的裁切块。
         */
        function getRoomOriginWorld(room) {
            const o = getRoomOriginWorldRaw(room);
            o.gx = 1; o.gy = 1;
            switch (room.originMode) {
                case 'tl': break;
                case 'tr': o.gx = -1; break;
                case 'br': o.gx = -1; o.gy = -1; break;
                case 'center': break;
                case 'custom': {
                    if (room.originDoorId && room.originDoorAlign) {
                        const curDoorSnap = getRoomDoorMidSnaps(room).find(d => d.openingId === room.originDoorId);
                        if (curDoorSnap) {
                            room.originX = curDoorSnap.x;
                            room.originY = curDoorSnap.y;
                            room.originDoorAlign = curDoorSnap.axis;
                            o.x = curDoorSnap.x;
                            o.y = curDoorSnap.y;
                        }
                    }
                    if (room.originX == null || room.originY == null) break;
                    const pav = getRoomPavingPolygonVerts(room);
                    if (!pav || pav.length < 3) break;
                    let inner = [];
                    try { inner = getRoomInnerWallVerts(room) || []; } catch (e) { inner = []; }
                    const snapAxis = (val, innerVals, pavVals) => {
                        for (const iv of innerVals) {
                            if (Math.abs(val - iv) <= 1.5) {
                                let best = null;
                                for (const pv of pavVals) {
                                    const d = Math.abs(pv - iv);
                                    // 外边缝按真实比例内缩 (见 getRoomPavingPolygonVerts)，容差覆盖常用缝宽
                                    if (d <= 22 && (!best || d < best.d)) best = { v: pv, d };
                                }
                                if (best) return { v: best.v, snapped: true };
                            }
                        }
                        for (const pv of pavVals) {
                            if (Math.abs(val - pv) <= 0.6) return { v: pv, snapped: true };
                        }
                        return { v: val, snapped: false };
                    };
                    const sx = snapAxis(o.x, inner.map(v => v.x), pav.map(v => v.x));
                    const sy = snapAxis(o.y, inner.map(v => v.y), pav.map(v => v.y));
                    o.x = sx.v; o.y = sy.v;
                    const { cx, cy } = pointsBounds(pav);
                    const E = 4;
                    const inside = (px, py) => isPointInPolygon({ x: px, y: py }, pav) ? 1 : 0;
                    if (sx.snapped) {
                        const right = inside(o.x + E, o.y + E) + inside(o.x + E, o.y - E);
                        const left = inside(o.x - E, o.y + E) + inside(o.x - E, o.y - E);
                        o.gx = right > left ? 1 : (left > right ? -1 : (o.x > cx ? -1 : 1));
                    }
                    if (sy.snapped) {
                        const down = inside(o.x + E, o.y + E) + inside(o.x - E, o.y + E);
                        const up = inside(o.x + E, o.y - E) + inside(o.x - E, o.y - E);
                        o.gy = down > up ? 1 : (up > down ? -1 : (o.y > cy ? -1 : 1));
                    }
                    // 门洞起铺：沿门宽方向对齐整砖并避开门中砖缝（支持优排偏移 originDoorOffset），垂直方向整砖贴合门洞墙边向室内生长
                    if (room.originDoorAlign && room.pattern !== 'diagonal') {
                        const pxPerMM = SCALE_PIXELS_PER_METER / 1000;
                        const doorOff = Number(room.originDoorOffset) || 0;
                        // 显示 / 拖动用的标记点：门框中点（贴合铺贴边界）
                        o.mark = { x: room.originDoorAlign === 'x' ? room.originX : o.x, y: room.originDoorAlign === 'y' ? room.originY : o.y };
                        if (room.originDoorAlign === 'x') {
                            o.x = room.originX - Math.max(50, Number(room.tileW) || 800) * pxPerMM / 2 + doorOff; o.gx = 1;
                        } else if (room.originDoorAlign === 'y') {
                            o.y = room.originY - Math.max(50, Number(room.tileH) || 800) * pxPerMM / 2 + doorOff; o.gy = 1;
                        }
                        o.doorAlign = room.originDoorAlign;
                        o.label = '门洞整砖优排起铺';
                    }
                    break;
                }
                case 'bl':
                default: o.gy = -1; break;
            }
            return o;
        }

        /** 起铺点的显示位置：门中心对砖中时为门框中点，其余为排砖原点 */
        const originMark = o => (o && o.mark) ? o.mark : o;

        function getRoomOriginWorldRaw(room) {
            const pavingVerts = getRoomPavingPolygonVerts(room);
            if (!pavingVerts || pavingVerts.length < 3) {
                return { x: 0, y: 0, label: '左下角起铺' };
            }
            if (room.originMode === 'custom' && room.originX != null && room.originY != null) {
                return { x: room.originX, y: room.originY, label: '自定义起铺点' };
            }
            const { minX, maxX, minY, maxY } = pointsBounds(pavingVerts);
            const tol = 2.0;

            switch (room.originMode) {
                case 'tl': {
                    const topVerts = pavingVerts.filter(v => Math.abs(v.y - minY) <= tol);
                    const pick = topVerts.length ? topVerts.reduce((a, b) => (a.x <= b.x ? a : b)) : { x: minX, y: minY };
                    return { x: pick.x, y: pick.y, label: '左上角起铺' };
                }
                case 'tr': {
                    const topVerts = pavingVerts.filter(v => Math.abs(v.y - minY) <= tol);
                    const pick = topVerts.length ? topVerts.reduce((a, b) => (a.x >= b.x ? a : b)) : { x: maxX, y: minY };
                    return { x: pick.x, y: pick.y, label: '右上角起铺' };
                }
                case 'br': {
                    const botVerts = pavingVerts.filter(v => Math.abs(v.y - maxY) <= tol);
                    const pick = botVerts.length ? botVerts.reduce((a, b) => (a.x >= b.x ? a : b)) : { x: maxX, y: maxY };
                    return { x: pick.x, y: pick.y, label: '右下角起铺' };
                }
                case 'center': {
                    const vRect = getRoomVirtualCenterRect(room);
                    return { x: vRect.cx, y: vRect.cy, label: '中心对称起铺' };
                }
                case 'bl':
                default: {
                    const botVerts = pavingVerts.filter(v => Math.abs(v.y - maxY) <= tol);
                    const pick = botVerts.length ? botVerts.reduce((a, b) => (a.x <= b.x ? a : b)) : { x: minX, y: maxY };
                    return { x: pick.x, y: pick.y, label: '左下角起铺' };
                }
            }
        }

        function decomposePolygonToSubRects(verts) {
            if (!verts || verts.length < 3) return [];
            const ys = Array.from(new Set(verts.map(v => Math.round(v.y * 100) / 100))).sort((a, b) => a - b);
            const rects = [];
            for (let j = 0; j < ys.length - 1; j++) {
                const y1 = ys[j], y2 = ys[j + 1];
                if (y2 - y1 < 1e-3) continue;
                const midY = (y1 + y2) / 2;
                const xIntersections = [];
                for (let i = 0; i < verts.length; i++) {
                    const a = verts[i], b = verts[(i + 1) % verts.length];
                    if ((a.y <= midY && b.y > midY) || (b.y <= midY && a.y > midY)) {
                        const t = (midY - a.y) / (b.y - a.y);
                        xIntersections.push(a.x + t * (b.x - a.x));
                    }
                }
                xIntersections.sort((a, b) => a - b);
                for (let k = 0; k + 1 < xIntersections.length; k += 2) {
                    const x1 = xIntersections[k], x2 = xIntersections[k + 1];
                    if (x2 - x1 > 0.1) {
                        rects.push({ x1, y1, x2, y2 });
                    }
                }
            }
            return rects;
        }

        // 为任意户型（矩形、L型、异形）虚拟出空间内部最大内接矩形区域，用于文字精准居中
        function getRoomVirtualCenterRect(room) {
            const verts = getRoomPolygonVerts(room);
            if (!verts || verts.length < 3) {
                return { x1: 0, y1: 0, x2: 40, y2: 40, w: 40, h: 40, cx: 20, cy: 20 };
            }
            const srs = decomposePolygonToSubRects(verts);
            if (srs.length === 0) {
                const b = getRoomBounds(room);
                const w = Math.max(10, b.maxX - b.minX), h = Math.max(10, b.maxY - b.minY);
                return { x1: b.minX, y1: b.minY, x2: b.maxX, y2: b.maxY, w, h, cx: b.cx, cy: b.cy };
            }

            let best = null;
            const m = srs.length;
            for (let i = 0; i < m; i++) {
                let curX1 = srs[i].x1, curX2 = srs[i].x2;
                const curY1 = srs[i].y1;
                let curY2 = srs[i].y2;
                const evalRect = (x1, y1, x2, y2) => {
                    const w = x2 - x1, h = y2 - y1;
                    if (w <= 4 || h <= 4) return;
                    const aspect = Math.min(w, h) / Math.max(w, h, 1);
                    const score = (w * h) * Math.pow(aspect, 0.22);
                    if (!best || score > best.score) {
                        best = { x1, y1, x2, y2, w, h, cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, score };
                    }
                };
                evalRect(curX1, curY1, curX2, curY2);

                for (let j = i + 1; j < m; j++) {
                    if (Math.abs(srs[j].y1 - curY2) > 0.6) continue;
                    const nx1 = Math.max(curX1, srs[j].x1);
                    const nx2 = Math.min(curX2, srs[j].x2);
                    if (nx2 - nx1 <= 4) continue;
                    curX1 = nx1;
                    curX2 = nx2;
                    curY2 = srs[j].y2;
                    evalRect(curX1, curY1, curX2, curY2);
                }
            }
            if (!best) {
                const c = computePolygonCentroid(verts);
                return { x1: c.x - 20, y1: c.y - 15, x2: c.x + 20, y2: c.y + 15, w: 40, h: 30, cx: c.x, cy: c.y };
            }
            return best;
        }

        function isPointInPolygonOrOnEdge(pt, poly, eps = 0.25) {
            const x = pt.x, y = pt.y;
            const n = poly.length;
            for (let i = 0; i < n; i++) {
                const a = poly[i], b = poly[(i + 1) % n];
                const dx = b.x - a.x, dy = b.y - a.y;
                const l2 = dx * dx + dy * dy;
                if (l2 > 0) {
                    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2));
                    const px = a.x + t * dx, py = a.y + t * dy;
                    if (Math.hypot(x - px, y - py) <= eps) return true;
                }
            }
            return isPointInPolygon(pt, poly);
        }

        function segmentsProperlyIntersect(a, b, c, d, eps = 0.2) {
            const ccw = (p1, p2, p3) => (p2.x - p1.x) * (p3.y - p1.y) - (p2.y - p1.y) * (p3.x - p1.x);
            const d1 = ccw(a, b, c), d2 = ccw(a, b, d);
            const d3 = ccw(c, d, a), d4 = ccw(c, d, b);
            return ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) &&
                   ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps));
        }

        function isQuadFullyInsidePolygon(quad, poly) {
            const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) * 0.25;
            const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) * 0.25;
            if (!isPointInPolygonOrOnEdge({ x: cx, y: cy }, poly, 0.2)) return false;

            for (let i = 0; i < 4; i++) {
                const p = quad[i], q = quad[(i + 1) % 4];
                if (!isPointInPolygonOrOnEdge(p, poly, 0.25)) return false;
                if (!isPointInPolygonOrOnEdge({ x: (p.x + q.x) * 0.5, y: (p.y + q.y) * 0.5 }, poly, 0.2)) return false;
                for (let j = 0; j < poly.length; j++) {
                    if (segmentsProperlyIntersect(p, q, poly[j], poly[(j + 1) % poly.length], 0.2)) {
                        return false;
                    }
                }
            }

            let qMinX = Infinity, qMaxX = -Infinity, qMinY = Infinity, qMaxY = -Infinity;
            for (const p of quad) {
                if (p.x < qMinX) qMinX = p.x;
                if (p.x > qMaxX) qMaxX = p.x;
                if (p.y < qMinY) qMinY = p.y;
                if (p.y > qMaxY) qMaxY = p.y;
            }
            for (const v of poly) {
                if (v.x > qMinX + 0.25 && v.x < qMaxX - 0.25 && v.y > qMinY + 0.25 && v.y < qMaxY - 0.25) {
                    if (isPointInPolygon(v, quad)) return false;
                }
            }
            return true;
        }


        // 多边形是否为凸多边形（各拐角叉积同号）
        function isPolygonConvex(poly) {
            if (!poly || poly.length < 3) return false;
            const n = poly.length;
            if (n === 3) return true;
            let sign = 0;
            for (let i = 0; i < n; i++) {
                const a = poly[i], b = poly[(i + 1) % n], c = poly[(i + 2) % n];
                const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
                if (Math.abs(cross) > 1e-3) {
                    const s = cross > 0 ? 1 : -1;
                    if (sign === 0) sign = s;
                    else if (sign !== s) return false;
                }
            }
            return true;
        }

        // Sutherland-Hodgman 任意凸多边形半平面精确裁剪（支持任意角度斜墙，零溢出）
        function clipPolygonAgainstConvexPoly(subjectPoly, convexClipPoly) {
            if (!subjectPoly || subjectPoly.length < 3 || !convexClipPoly || convexClipPoly.length < 3) return [];
            const orient = polygonSignedArea(convexClipPoly) >= 0 ? 1 : -1;
            let output = subjectPoly.map(p => ({ x: p.x, y: p.y }));
            const n = convexClipPoly.length;

            for (let i = 0; i < n; i++) {
                const A = convexClipPoly[i];
                const B = convexClipPoly[(i + 1) % n];
                const ex = B.x - A.x, ey = B.y - A.y;
                const elen = Math.hypot(ex, ey);
                if (elen < 1e-5) continue;

                const signedDist = (p) => orient * ((ex * (p.y - A.y) - ey * (p.x - A.x)) / elen);
                const input = output;
                output = [];
                if (input.length === 0) break;

                let S = input[input.length - 1];
                let dS = signedDist(S);
                for (const E of input) {
                    const dE = signedDist(E);
                    if (dE >= -1e-4) {
                        if (dS < -1e-4) {
                            const denom = dS - dE;
                            const t = Math.abs(denom) < 1e-9 ? 0.5 : (dS / denom);
                            output.push({ x: S.x + t * (E.x - S.x), y: S.y + t * (E.y - S.y) });
                        }
                        output.push(E);
                    } else if (dS >= -1e-4) {
                        const denom = dS - dE;
                        const t = Math.abs(denom) < 1e-9 ? 0.5 : (dS / denom);
                        output.push({ x: S.x + t * (E.x - S.x), y: S.y + t * (E.y - S.y) });
                    }
                    S = E;
                    dS = dE;
                }
            }
            return output;
        }

        /**
         * 直角多边形（所有边水平或竖直）→ 矩形分区；不是直角多边形时返回 null。
         * 分别按水平条带、竖直条带切分（同跨度的相邻条带合并），取分区少、切缝总长短的一种，
         * 让切缝尽量只经过台阶附近的少量砖块。矩形与原多边形同绕向。
         */
        function decomposeRectilinearToRects(poly) {
            const n = poly.length;
            if (n < 4) return null;
            const EPS = 0.01;
            for (let i = 0; i < n; i++) {
                const a = poly[i], b = poly[(i + 1) % n];
                if (Math.abs(a.x - b.x) > EPS && Math.abs(a.y - b.y) > EPS) return null;
            }
            const sign = polygonSignedArea(poly) >= 0 ? 1 : -1;
            const slabs = (pts) => {
                const ys = Array.from(new Set(pts.map(v => Math.round(v.y * 1000) / 1000))).sort((a, b) => a - b);
                const out = [];
                for (let j = 0; j + 1 < ys.length; j++) {
                    const y1 = ys[j], y2 = ys[j + 1];
                    if (y2 - y1 < 1e-3) continue;
                    const midY = (y1 + y2) / 2;
                    const xs = [];
                    for (let i = 0; i < pts.length; i++) {
                        const a = pts[i], b = pts[(i + 1) % pts.length];
                        if ((a.y <= midY && b.y > midY) || (b.y <= midY && a.y > midY)) {
                            xs.push(a.x + (midY - a.y) / (b.y - a.y) * (b.x - a.x));
                        }
                    }
                    xs.sort((a, b) => a - b);
                    for (let k = 0; k + 1 < xs.length; k += 2) {
                        if (xs[k + 1] - xs[k] > 1e-3) out.push({ x1: xs[k], x2: xs[k + 1], y1, y2 });
                    }
                }
                // 合并上下相接、左右跨度相同的条带
                let merged = true;
                while (merged) {
                    merged = false;
                    for (let i = 0; i < out.length && !merged; i++) {
                        for (let j = 0; j < out.length && !merged; j++) {
                            if (i === j) continue;
                            const A = out[i], B = out[j];
                            if (Math.abs(A.y2 - B.y1) < 1e-3 && Math.abs(A.x1 - B.x1) < EPS && Math.abs(A.x2 - B.x2) < EPS) {
                                A.y2 = B.y2;
                                out.splice(j, 1);
                                merged = true;
                            }
                        }
                    }
                }
                return out;
            };
            const seamLen = (rects) => {
                // 切缝 = 分区周长总和 − 多边形周长，比较时只需分区周长总和
                let s2 = 0;
                for (const r of rects) s2 += 2 * ((r.x2 - r.x1) + (r.y2 - r.y1));
                return s2;
            };
            const hRects = slabs(poly);
            const vRects = slabs(poly.map(p => ({ x: p.y, y: p.x }))).map(r => ({ x1: r.y1, x2: r.y2, y1: r.x1, y2: r.x2 }));
            if (!hRects.length && !vRects.length) return null;
            let best = hRects;
            if (!hRects.length || (vRects.length && (vRects.length < hRects.length ||
                (vRects.length === hRects.length && seamLen(vRects) < seamLen(hRects) - 1e-6)))) best = vRects;
            return best.map(r => {
                const q = [{ x: r.x1, y: r.y1 }, { x: r.x2, y: r.y1 }, { x: r.x2, y: r.y2 }, { x: r.x1, y: r.y2 }];
                return (polygonSignedArea(q) >= 0 ? 1 : -1) === sign ? q : q.reverse();
            });
        }

        // 耳切法三角剖分 + Hertel-Mehlhorn 凸多边形合并（支持带斜墙的 L 型/凹多边形房间）
        function decomposePolygonToConvexParts(poly) {
            if (!poly || poly.length < 3) return [];
            const clean = simplifyCollinearPolygonVerts(poly);
            if (clean.length < 3) return [];
            if (isPolygonConvex(clean)) return [clean];

            // 横平竖直的房间（含墙厚不同形成的窄台阶）按矩形切分：
            // 耳切对角线遇到几毫米宽的台阶会切出细长三角形，裁出的砖块碎片无法正确合并，出现斜线
            const rectParts = decomposeRectilinearToRects(clean);
            if (rectParts) return rectParts;

            const orient = polygonSignedArea(clean) >= 0 ? 1 : -1;
            const pts = clean.map((p, idx) => ({ x: p.x, y: p.y, idx }));
            const indices = pts.map((_, i) => i);
            const triangles = [];

            const isEar = (i0, i1, i2, rem) => {
                const a = pts[i0], b = pts[i1], c = pts[i2];
                const cross = orient * ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
                if (cross <= 1e-4) return false;
                for (const k of rem) {
                    if (k === i0 || k === i1 || k === i2) continue;
                    const p = pts[k];
                    const c1 = orient * ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x));
                    const c2 = orient * ((c.x - b.x) * (p.y - b.y) - (c.y - b.y) * (p.x - b.x));
                    const c3 = orient * ((a.x - c.x) * (p.y - c.y) - (a.y - c.y) * (p.x - c.x));
                    if (c1 >= -1e-4 && c2 >= -1e-4 && c3 >= -1e-4) return false;
                }
                return true;
            };

            let guard = 0;
            while (indices.length > 3 && guard++ < 500) {
                let earFound = false;
                const m = indices.length;
                for (let i = 0; i < m; i++) {
                    const i0 = indices[(i - 1 + m) % m];
                    const i1 = indices[i];
                    const i2 = indices[(i + 1) % m];
                    if (isEar(i0, i1, i2, indices)) {
                        triangles.push([pts[i0], pts[i1], pts[i2]]);
                        indices.splice(i, 1);
                        earFound = true;
                        break;
                    }
                }
                if (!earFound) {
                    const i0 = indices[0], i1 = indices[1], i2 = indices[2];
                    triangles.push([pts[i0], pts[i1], pts[i2]]);
                    indices.splice(1, 1);
                }
            }
            if (indices.length === 3) {
                triangles.push([pts[indices[0]], pts[indices[1]], pts[indices[2]]]);
            }

            // Hertel-Mehlhorn: 合并共享内部对角线且合并后仍为凸多边形的分片，消除多余内部分割线
            let parts = triangles.map(t => t.slice());
            let merged = true;
            while (merged && parts.length > 1) {
                merged = false;
                for (let i = 0; i < parts.length && !merged; i++) {
                    for (let j = i + 1; j < parts.length && !merged; j++) {
                        const candidate = tryMergeTwoSharedEdgePolys(parts[i], parts[j], 0.2);
                        if (candidate && isPolygonConvex(candidate)) {
                            parts[i] = candidate;
                            parts.splice(j, 1);
                            merged = true;
                        }
                    }
                }
            }
            return parts;
        }

        function tryMergeTwoSharedEdgePolys(pA, pB, tol = 0.25) {
            const nA = pA.length, nB = pB.length;
            const samePt = (p, q) => Math.hypot(p.x - q.x, p.y - q.y) <= tol;
            for (let i = 0; i < nA; i++) {
                const a1 = pA[i], a2 = pA[(i + 1) % nA];
                for (let j = 0; j < nB; j++) {
                    const b1 = pB[j], b2 = pB[(j + 1) % nB];
                    if (samePt(a1, b2) && samePt(a2, b1)) {
                        const combined = [];
                        for (let k = 1; k < nA; k++) combined.push(pA[(i + k) % nA]);
                        for (let k = 1; k < nB; k++) combined.push(pB[(j + k) % nB]);
                        return simplifyCollinearPolygonVerts(combined);
                    }
                }
            }
            return null;
        }

        /** 把 other 中落在 poly 边上的顶点插入 poly，使两个相邻多边形的公共边端点一致 */
        function insertPointsOnEdges(poly, other, tol = 0.35) {
            const out = [];
            const n = poly.length;
            for (let i = 0; i < n; i++) {
                const a = poly[i], b = poly[(i + 1) % n];
                out.push(a);
                const ex = b.x - a.x, ey = b.y - a.y;
                const len2 = ex * ex + ey * ey;
                if (len2 < 1e-6) continue;
                const len = Math.sqrt(len2);
                const mids = [];
                for (const q of other) {
                    const t = ((q.x - a.x) * ex + (q.y - a.y) * ey) / len2;
                    if (t * len <= tol || (1 - t) * len <= tol) continue;
                    const d = Math.abs((q.x - a.x) * ey - (q.y - a.y) * ex) / len;
                    if (d <= tol) mids.push({ t, p: { x: a.x + ex * t, y: a.y + ey * t } });
                }
                mids.sort((m1, m2) => m1.t - m2.t).forEach(m => {
                    const last = out[out.length - 1];
                    if (Math.hypot(last.x - m.p.x, last.y - m.p.y) > tol) out.push(m.p);
                });
            }
            return out;
        }

        /**
         * 合并同一块砖被多个凸分区裁出的碎片（它们互不重叠、沿边相接）。
         * 做法：统一为同向 → 在 T 形接点处补点并吸附 → 抵消方向相反的公共边 → 把剩余边串成闭合轮廓。
         * 不会因“只共用半条边/多条边”而产生三角形或自交轮廓。
         */
        function unionClippedConvexParts(parts, tol = 0.35) {
            if (!parts || parts.length <= 1) return parts;
            const oriented = parts.filter(p => p && p.length >= 3).map(p => polygonSignedArea(p) >= 0 ? p.slice() : p.slice().reverse());
            if (oriented.length <= 1) return oriented;
            // 吸附：距离 tol 内的点视为同一点
            const pts = [];
            const snap = q => {
                for (const p of pts) if (Math.abs(p.x - q.x) <= tol && Math.abs(p.y - q.y) <= tol) return p;
                const np = { x: q.x, y: q.y, k: pts.length };
                pts.push(np);
                return np;
            };
            const snapped = oriented.map(p => p.map(snap));
            const withT = snapped.map((p, i) => {
                const others = [];
                snapped.forEach((o, j) => { if (j !== i) others.push(...o); });
                return insertPointsOnEdges(p, others, tol).map(snap);
            });
            // 有向边计数，抵消相反方向
            const edges = new Map();
            for (const poly of withT) {
                for (let i = 0; i < poly.length; i++) {
                    const a = poly[i], b = poly[(i + 1) % poly.length];
                    if (a === b) continue;
                    const rev = `${b.k}>${a.k}`;
                    if (edges.has(rev)) {
                        const e = edges.get(rev);
                        if (--e.n === 0) edges.delete(rev);
                        continue;
                    }
                    const key = `${a.k}>${b.k}`;
                    const e = edges.get(key);
                    if (e) e.n++; else edges.set(key, { a, b, n: 1 });
                }
            }
            const out = new Map();
            for (const e of edges.values()) {
                for (let n = 0; n < e.n; n++) {
                    if (!out.has(e.a.k)) out.set(e.a.k, []);
                    out.get(e.a.k).push(e.b);
                }
            }
            const loops = [];
            for (const startK of [...out.keys()]) {
                while (out.get(startK) && out.get(startK).length) {
                    const loop = [pts[startK]];
                    let cur = out.get(startK).pop();
                    let guard = 0;
                    while (cur.k !== startK && guard++ < 10000) {
                        loop.push(cur);
                        const nx = out.get(cur.k);
                        if (!nx || !nx.length) break;
                        cur = nx.pop();
                    }
                    if (cur.k !== startK) return oriented;   // 轮廓无法闭合：保守地返回原碎片
                    const clean = removeCollinearVerts(loop.map(p => ({ x: p.x, y: p.y })));
                    if (clean.length >= 3) loops.push(clean);
                }
            }
            return loops.length ? loops : oriented;
        }

        /** 去掉共线顶点（含原地折返点） */
        function removeCollinearVerts(poly) {
            let list = poly.slice();
            let changed = true;
            while (changed && list.length > 3) {
                changed = false;
                for (let i = 0; i < list.length; i++) {
                    const a = list[(i - 1 + list.length) % list.length], b = list[i], c = list[(i + 1) % list.length];
                    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
                    const l = Math.hypot(c.x - a.x, c.y - a.y) || 1;
                    if (Math.abs(cross) / l < 0.05 || Math.hypot(b.x - a.x, b.y - a.y) < 1e-6) {
                        list.splice(i, 1);
                        changed = true;
                        break;
                    }
                }
            }
            return list;
        }


        /** 过门石花色：花色库中选定的瓷砖花色；未选择时取预设默认过门石（presets.json door.defaultThresholdStyleId） */
        function getThresholdStyle(op) {
            const st = MaterialLib.get(op.thresholdStyleId || PRESETS.door.defaultThresholdStyleId, 'tile');
            const hex = String(st.base || '#cbd5e1');
            const n = parseInt(hex.replace('#', '').padEnd(6, '0').slice(0, 6), 16);
            const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
            return { styleId: st.id, name: st.name, fill: hex, vein: st.vein || hex, img: st.img || null,
                stroke: lum > 0.55 ? '#475569' : '#0f172a', textColor: lum > 0.55 ? '#0f172a' : '#f8fafc', price: PRESETS.door.thresholdPrice };
        }

        function analyzeDoorAdjacency(op, thresholdSeq = 1) {
            if (!op || op.type !== 'door') return null;
            const wall = getWall(op.wallId);
            if (!wall) return null;
            const v1 = getVertex(wall.v1), v2 = getVertex(wall.v2);
            if (!v1 || !v2) return null;
            const wallLen = dist(v1, v2);
            if (wallLen < 1) return null;

            const mmPerPx = 1000 / SCALE_PIXELS_PER_METER; // 20mm/px
            const ux = (v2.x - v1.x) / wallLen, uy = (v2.y - v1.y) / wallLen;
            const nx = -uy, ny = ux;
            const angle = Math.atan2(uy, ux);
            const thPx = wall.thickness || 12;
            const thMM = Math.round(thPx * mmPerPx);
            const wPx = op.width || 45;
            const wMM = Math.round(wPx * mmPerPx);
            const halfW = wPx * 0.5;
            const cx = v1.x + op.t * (v2.x - v1.x);
            const cy = v1.y + op.t * (v2.y - v1.y);

            const findRoomOnSide = (sign) => {
                for (const d of [4, 10, 18, 28]) {
                    const px = cx + nx * (sign * (thPx * 0.5 + d));
                    const py = cy + ny * (sign * (thPx * 0.5 + d));
                    for (const r of STATE.rooms) {
                        if (r.cleared) continue;
                        const poly = getRoomPolygonVerts(r);
                        if (poly.length >= 3 && isPointInPolygon({ x: px, y: py }, poly)) {
                            return r;
                        }
                    }
                }
                return null;
            };

            const roomMinus = findRoomOnSide(-1);
            const roomPlus = findRoomOnSide(1);

            let roomA = null, roomB = null, signA = -1, signB = 1;
            if (roomMinus && roomPlus && roomMinus.id !== roomPlus.id) {
                // 若一侧瓷砖一侧木地板，默认将瓷砖侧作为 A 侧（主延伸侧）；若同材质则面积较大者作为 A 侧
                const areaM = computePolygonAreaPx(getRoomPolygonVerts(roomMinus));
                const areaP = computePolygonAreaPx(getRoomPolygonVerts(roomPlus));
                const swapToPlusFirst = (roomMinus.materialType === 'wood' && roomPlus.materialType === 'tile') ||
                    (roomMinus.materialType === roomPlus.materialType && areaP > areaM * 1.05);
                if (swapToPlusFirst) {
                    roomA = roomPlus; signA = 1;
                    roomB = roomMinus; signB = -1;
                } else {
                    roomA = roomMinus; signA = -1;
                    roomB = roomPlus; signB = 1;
                }
            } else if (roomMinus) {
                roomA = roomMinus; signA = -1; signB = 1;
            } else if (roomPlus) {
                roomA = roomPlus; signA = 1; signB = -1;
            }

            let scenario = 'unattached';
            let scenarioLabel = '未闭合墙门洞';
            if (roomA && roomB) {
                const mA = roomA.materialType === 'wood' ? 'wood' : 'tile';
                const mB = roomB.materialType === 'wood' ? 'wood' : 'tile';
                if (mA === 'tile' && mB === 'tile') {
                    scenario = 'tile_tile';
                    scenarioLabel = `${roomA.name}(砖) ↔ ${roomB.name}(砖)`;
                } else if (mA === 'wood' && mB === 'wood') {
                    scenario = 'wood_wood';
                    scenarioLabel = `${roomA.name}(木) ↔ ${roomB.name}(木)`;
                } else {
                    scenario = 'tile_wood';
                    scenarioLabel = `${roomA.name}(砖) ↔ ${roomB.name}(木)`;
                }
            } else if (roomA) {
                scenario = 'single_side';
                scenarioLabel = `${roomA.name}(${roomA.materialType === 'wood' ? '木' : '砖'}) ↔ 外侧/入户`;
            }

            // ── 门洞两项设置：连接形式 (op.doorJoint) + 过门形式 (op.doorOccupy 占门框空间 id / op.doorOffset 偏移 mm) ──
            // 通铺需两侧规格、铺法、缝宽一致，网格才能连成一个整体
            const sameSpec = !!(roomA && roomB && roomA.materialType === roomB.materialType
                && Number(roomA.tileW) === Number(roomB.tileW) && Number(roomA.tileH) === Number(roomB.tileH)
                && (roomA.pattern || 'straight') === (roomB.pattern || 'straight') && getRoomJointMM(roomA) === getRoomJointMM(roomB));
            const jointOptions = PRESETS.door.jointOptions[scenario] || [];
            const allowedJoints = jointOptions.filter(j => !(j.value === 'continuous' && !sameSpec)).map(j => j.value);
            let joint = op.doorJoint;
            if (!allowedJoints.includes(joint)) {
                if (scenario === 'tile_tile') {
                    const isWet = /卫|浴|厕|阳/.test(`${roomA?.name || ''}${roomB?.name || ''}`);
                    joint = (sameSpec && !isWet) ? 'continuous' : 'threshold';
                } else if (scenario === 'tile_wood' || scenario === 'wood_wood') {
                    joint = 'strip';
                } else {
                    joint = 'threshold';
                }
            }
            const usesOccupy = !!roomB && (joint === 'align' || joint === 'strip' || joint === 'hard');

            // 占门框空间：默认 A 侧（砖木相接时 A 恒为瓷砖侧，同材质时为面积较大者）
            const occId = op.doorOccupy;
            const occIsB = usesOccupy && occId === roomB?.id;
            const occRoom = occIsB ? roomB : roomA;
            const otherRoom = occIsB ? roomA : roomB;
            const sOcc = (occIsB ? signB : signA) * thPx * 0.5;
            const sOther = (occIsB ? signA : signB) * thPx * 0.5;
            const defaultOffsetMM = joint === 'strip' ? (Number(PRESETS.door?.defaultStripOffsetMM) || 20) : 0;
            const rawOffset = (op.doorOffset == null || op.doorOffset === '') ? defaultOffsetMM : Number(op.doorOffset);
            const offsetMM = usesOccupy ? Math.max(0, Math.min(thMM, Math.round(Number.isFinite(rawOffset) ? rawOffset : defaultOffsetMM))) : 0;
            // 接缝位置：从另一侧门框边向占框侧回退 offset（0 = 贴齐另一侧门框边）
            const sSeam = sOther - Math.sign(sOther) * (offsetMM / mmPerPx);

            const netHalfW = Math.max(4, halfW);
            const tsHalfW = Math.max(4, halfW);

            const makeQuad = (s1, s2, boxHalfW = netHalfW, customWidthMM = null) => {
                const sa = Math.min(s1, s2), sb = Math.max(s1, s2);
                const pts = [
                    { x: cx - ux * boxHalfW + nx * sa, y: cy - uy * boxHalfW + ny * sa },
                    { x: cx + ux * boxHalfW + nx * sa, y: cy + uy * boxHalfW + ny * sa },
                    { x: cx + ux * boxHalfW + nx * sb, y: cy + uy * boxHalfW + ny * sb },
                    { x: cx - ux * boxHalfW + nx * sb, y: cy - uy * boxHalfW + ny * sb }
                ];
                const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
                const depthMM = Math.max(0, Math.round((sb - sa) * mmPerPx));
                const effWidthMM = customWidthMM != null ? customWidthMM : Math.max(0, Math.round(boxHalfW * 2 * mmPerPx));
                return {
                    pts,
                    rect: { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) },
                    sMin: sa,
                    sMax: sb,
                    depthMM,
                    widthMM: effWidthMM,
                    areaSqm: depthMM > 0 ? (effWidthMM * depthMM) / 1e6 : 0
                };
            };

            const sFaceA = signA * thPx * 0.5;
            const sFaceB = signB * thPx * 0.5;

            const roomExtensions = []; // { roomId, roomName, quad, clipPts }
            // 门洞延伸区：quad 为门洞内实际铺贴范围；clipPts 从该空间铺贴边界（含外边缝内缩）起算，
            // 用于把门洞部分并入同一块砖裁切，使房间内的砖直接延伸过门洞而不是另起一小块
            const pushExt = (room, sFace, sEnd, sClipEnd = sEnd, extra = null) => {
                const gapPx = mmToPx(Math.max(0, Number(room.expansionGap) || 0));
                const sIn = sFace + Math.sign(sFace || 1) * gapPx;
                roomExtensions.push({ roomId: room.id, roomName: room.name, quad: makeQuad(sFace, sEnd), clipPts: makeQuad(sIn, sClipEnd).pts, ...(extra || {}) });
            };
            let thresholdStone = null;
            let continuousLink = null;
            let stripType = 'none';
            let stripOffsets = [];

            if (joint === 'threshold') {
                const ts = getThresholdStyle(op);
                const q = makeQuad(-thPx * 0.5, thPx * 0.5, tsHalfW, wMM);
                thresholdStone = {
                    id: `MS-${thresholdSeq}`,
                    doorId: op.id,
                    styleId: ts.styleId,
                    styleName: ts.name,
                    fill: ts.fill,
                    stroke: ts.stroke,
                    textColor: ts.textColor,
                    img: ts.img,
                    price: ts.price,
                    lenMM: wMM,
                    widMM: thMM,
                    areaSqm: q.areaSqm,
                    pts: q.pts,
                    rect: q.rect,
                    cx,
                    cy,
                    angle
                };
                // 过门石与木地板相接处需压边条；与瓷砖相接直接勾缝；外侧/入户门外沿紧靠门框不加收口条
                if (scenario === 'wood_wood') {
                    stripType = 'strip';
                    stripOffsets = [
                        { sOff: sFaceA, edgeSign: Math.sign(sFaceA) || 1 },
                        { sOff: sFaceB, edgeSign: Math.sign(sFaceB) || -1 }
                    ];
                } else if (scenario === 'tile_wood') {
                    stripType = 'strip';
                    stripOffsets = [{ sOff: sFaceB, edgeSign: Math.sign(sFaceB) || -1 }];
                } else if (scenario === 'single_side' && roomA?.materialType === 'wood') {
                    stripType = 'strip';
                    stripOffsets = [{ sOff: sFaceA, edgeSign: Math.sign(sFaceA) || 1 }];
                }
            } else if (joint === 'continuous') {
                // 通铺：两侧空间连成一个铺贴整体，共用一个起铺点；门洞只是墙体被裁掉的部分，
                // 砖从一侧直接延伸到另一侧（同一块砖），门洞处不另起散块、无接缝无压条
                const gapB = mmToPx(Math.max(0, Number(roomB.expansionGap) || 0));
                pushExt(roomA, sFaceA, sFaceB, sFaceB + Math.sign(sFaceB || 1) * gapB, { bridgeTo: roomB.id });
                continuousLink = { fromRoomId: roomA.id, toRoomId: roomB.id, merge: true };
            } else if (joint === 'extend') {
                // 单侧 / 入户：室内铺贴延伸至门洞外沿（紧抵入户门框/门槛，不加外侧收口条）
                pushExt(roomA, sFaceA, sFaceB);
            } else if (usesOccupy) {
                // 对缝 / 压边条 / 硬连接：占框侧铺到接缝，另一侧按偏移量伸入门洞（深度为 0 时不生成延伸区）
                if (offsetMM < thMM) {
                    pushExt(occRoom, sOcc, sSeam);
                }
                if (offsetMM > 0) {
                    pushExt(otherRoom, sOther, sSeam);
                }
                if (joint === 'align' && sameSpec) {
                    continuousLink = { fromRoomId: occRoom.id, toRoomId: otherRoom.id };
                }
                if (joint === 'strip') {
                    stripType = 'strip';
                    const edgeSign = Math.abs(sOcc - sSeam) > 0.01
                        ? Math.sign(sOcc - sSeam)
                        : (Math.sign(sOther - sSeam) || 1);
                    stripOffsets = [{ sOff: sSeam, edgeSign }];
                }
            }

            const strips = stripOffsets.map((item, idx) => {
                const sOff = typeof item === 'number' ? item : item.sOff;
                const edgeSign = typeof item === 'number' ? 1 : (item.edgeSign || 1);
                return {
                    id: `${op.id}_strip_${idx + 1}`,
                    type: stripType,
                    typeLabel: PRESETS.door.stripTypes[stripType] || '压边条',
                    sOffset: sOff,
                    edgeSign,
                    lengthMM: wMM,
                    lengthM: +(wMM / 1000).toFixed(2),
                    p1: { x: cx - ux * halfW + nx * sOff, y: cy - uy * halfW + ny * sOff },
                    p2: { x: cx + ux * halfW + nx * sOff, y: cy + uy * halfW + ny * sOff }
                };
            });

            const jointLabel = (jointOptions.find(j => j.value === joint) || {}).label || '过门石';
            const effModeLabel = usesOccupy
                ? `${jointLabel} · ${occRoom.name}占门框${offsetMM ? ` 偏移${Units.text(offsetMM)}` : ''}`
                : (joint === 'continuous' ? `通铺 · ${roomA.name}↔${roomB.name}` : jointLabel);

            return {
                doorId: op.id,
                wallId: wall.id,
                cx, cy, ux, uy, nx, ny, angle,
                wPx, thPx, wMM, thMM,
                roomA, roomB, signA, signB,
                scenario,
                scenarioLabel,
                joint,
                jointOptions: jointOptions.map(j => ({ ...j, disabled: !allowedJoints.includes(j.value) })),
                usesOccupy,
                occupyRoomId: usesOccupy ? occRoom.id : null,
                offsetMM,
                effModeLabel,
                effStripType: stripType,
                effStripTypeLabel: PRESETS.door.stripTypes[stripType] || '无压边条',
                roomExtensions,
                thresholdStone,
                continuousLink,
                strips,
                fullDoorQuad: makeQuad(-thPx * 0.5, thPx * 0.5)
            };
        }

        function computeAllDoorsPavingPlan() {
            const plans = [];
            let msSeq = 1;
            let thresholdCount = 0, thresholdAreaSqm = 0, thresholdCost = 0, stripCount = 0, stripLengthM = 0, stripCost = 0;

            for (const op of STATE.openings) {
                if (op.type !== 'door') continue;
                const plan = analyzeDoorAdjacency(op, msSeq);
                if (!plan) continue;
                if (plan.thresholdStone) {
                    msSeq++;
                    thresholdCount++;
                    thresholdAreaSqm += plan.thresholdStone.areaSqm;
                    const tPrice = priceOr(op.thresholdPrice, plan.thresholdStone.price);
                    plan.thresholdStone.price = tPrice;
                    thresholdCost += tPrice;
                }
                if (plan.strips && plan.strips.length > 0) {
                    stripCount += plan.strips.length;
                    const sPrice = priceOr(op.stripPrice, PRESETS.door.stripPrice);
                    for (const st of plan.strips) {
                        stripLengthM += st.lengthM;
                        stripCost += st.lengthM * sPrice;
                    }
                }
                plans.push(plan);
            }

            STATE.computedDoors = plans;
            STATE.doorSummary = {
                thresholdCount,
                thresholdAreaSqm: +thresholdAreaSqm.toFixed(2),
                thresholdCost: Math.round(thresholdCost * 100) / 100,
                stripCount,
                stripLengthM: +stripLengthM.toFixed(2),
                stripCost: Math.round(stripCost * 100) / 100,
                doorExtraCost: Math.round((thresholdCost + stripCost) * 100) / 100
            };
            return plans;
        }

        /** 砖块分类：整砖 / 大裁切 (≥50%) / 小边角 */
        /**
         * 余料复用：估算裁切块实际需要的整砖数量（v4.7.3 起替代“小边角两片拼一砖”的固定折半）。
         *  - 矩形裁切块：按“先大后小”逐块下料，优先从已有余料中切（余料不旋转，保持纹理方向），
         *    否则开一块新砖；每次切割按一刀到底（guillotine）留下两块余料，扣除锯缝 3 mm，
         *    短边 < 40 mm 的余料视为废料。大裁切的余条也可供后续小块使用（如地板行尾余料接下一行）。
         *  - 三角形裁切块（斜铺沿墙边）：需明确为三角形 (isTri !== false)，两块互扣组合外接矩形不超过整砖尺寸时可同切一块砖。
         *  - 其它异形块（门洞缺口、墙面 L 形等）：各占一块砖，不产生可用余料（保守）。
         * pieces: [{ a: 沿砖长 mm, b: 沿砖宽 mm, area: mm², isTri?: boolean }]；返回 { tiles, saved }
         */
        const REUSE_KERF_MM = 3, REUSE_MIN_MM = 40;
        function countTilesForCuts(pieces, L, W, reuse = true) {
            if (!reuse || !pieces.length) return { tiles: pieces.length, saved: 0 };
            const rects = [], tris = [];
            let other = 0;
            for (const p of pieces) {
                const box = Math.max(1, p.a * p.b);
                if (p.area >= box * 0.96) rects.push(p);
                else if (p.isTri !== false && Math.abs(p.area - box / 2) <= box * 0.06) tris.push(p);
                else other++;
            }
            rects.sort((x, y) => (y.a * y.b) - (x.a * x.b));
            const offs = [];
            let tiles = 0;
            const K = REUSE_KERF_MM, MIN = REUSE_MIN_MM;
            const usable = ([l, w]) => l >= MIN && w >= MIN;
            for (const p of rects) {
                let bi = -1, bA = Infinity;
                for (let i = 0; i < offs.length; i++) {
                    const o = offs[i];
                    if (p.a <= o.l + 0.5 && p.b <= o.w + 0.5 && o.l * o.w < bA) { bA = o.l * o.w; bi = i; }
                }
                let o;
                if (bi >= 0) o = offs.splice(bi, 1)[0];
                else { tiles++; o = { l: L, w: W }; }
                const rl = o.l - p.a - K, rw = o.w - p.b - K;
                const A = [[rl, o.w], [p.a, rw]], B = [[o.l, rw], [rl, p.b]];
                const score = opt => Math.max(0, ...opt.filter(usable).map(([l, w]) => l * w));
                for (const r of (score(A) >= score(B) ? A : B)) if (usable(r)) offs.push({ l: r[0], w: r[1] });
            }
            // 三角形按尺寸从大到小校验配对：沿对角线互扣（留锯缝 K）能放入同一整砖 L×W 方可合切一砖
            tris.sort((x, y) => (y.a * y.b) - (x.a * x.b));
            const triUsed = new Uint8Array(tris.length);
            const triFitsPair = (p, q) =>
                (Math.max(p.a, q.a) + K <= L + 0.5 && Math.max(p.b, q.b) + K <= W + 0.5) ||
                (p.a + q.a + K <= L + 0.5 && Math.max(p.b, q.b) <= W + 0.5) ||
                (Math.max(p.a, q.a) <= L + 0.5 && p.b + q.b + K <= W + 0.5);
            for (let i = 0; i < tris.length; i++) {
                if (triUsed[i]) continue;
                triUsed[i] = 1;
                tiles++;
                for (let j = i + 1; j < tris.length; j++) {
                    if (!triUsed[j] && triFitsPair(tris[i], tris[j])) {
                        triUsed[j] = 1;
                        break;
                    }
                }
            }
            tiles += other;
            return { tiles, saved: pieces.length - tiles };
        }

        function classifyTileCut(areaRatio, cutLenMM, cutWidMM, tileLenMM, tileWidMM) {
            if (areaRatio >= 0.97 && cutLenMM >= tileLenMM - 10 && cutWidMM >= tileWidMM - 10) return 'FULL';
            return areaRatio >= 0.50 ? 'CUT_LARGE' : 'CUT_SMALL';
        }

        /**
         * 排砖网格（铺贴坐标系）：recomputeAllRoomTiling 与 evaluateRoomTilingAtOrigin 共用，
         * 保证 AI 寻优评估与实际排砖使用完全一致的网格。
         *   origin：{ x, y, gx, gy }（gx/gy < 0 表示向左/向上铺）；pB：铺贴边界包围盒 { minX, minY, maxX, maxY }
         */
        function createPavingLattice(room, origin, pB) {
            const mmPerPx = 1000 / SCALE_PIXELS_PER_METER;
            const tileLenMM = Math.max(50, Number(room.tileW) || 800);
            const tileWidMM = Math.max(50, Number(room.tileH) || 800);
            const jointMM = getRoomJointMM(room);
            const tileLenPx = Math.max(3, tileLenMM / mmPerPx);
            const tileWidPx = Math.max(3, tileWidMM / mmPerPx);
            const jointPx = Math.max(0, jointMM / mmPerPx);
            const stepX = tileLenPx + jointPx;
            const stepY = tileWidPx + jointPx;
            const isDiag = room.pattern === 'diagonal';
            // 向左/向上铺时，让第 -1 列/行的砖外缘正好落在起铺点上 (整块贴边，不留半缝)
            let origX = origin.x, origY = origin.y;
            if (!isDiag) {
                if (origin.gx < 0) origX += jointPx;
                if (origin.gy < 0) origY += jointPx;
            }
            const angleRad = isDiag ? Math.PI / 4 : 0;
            const cosA = Math.cos(angleRad), sinA = Math.sin(angleRad);
            const diagSpan = Math.hypot(pB.maxX - pB.minX, pB.maxY - pB.minY) + Math.max(stepX, stepY) * 2;
            const diagRange = {
                minRow: -Math.ceil(diagSpan / stepY), maxRow: Math.ceil(diagSpan / stepY),
                minCol: -Math.ceil(diagSpan / stepX), maxCol: Math.ceil(diagSpan / stepX)
            };
            return {
                mmPerPx, tileLenMM, tileWidMM, jointMM, tileLenPx, tileWidPx, jointPx, stepX, stepY,
                fullTileAreaPx: tileLenPx * tileWidPx, isDiag, origX, origY, angleRad, cosA, sinA,
                /** 覆盖矩形范围所需的行列区间（斜铺统一使用整个铺贴区域的区间） */
                rangeFor(x1, y1, x2, y2) {
                    if (isDiag) return diagRange;
                    return {
                        minRow: Math.floor((y1 - origY) / stepY) - 1, maxRow: Math.ceil((y2 - origY) / stepY) + 1,
                        minCol: Math.floor((x1 - origX) / stepX) - 2, maxCol: Math.ceil((x2 - origX) / stepX) + 2
                    };
                },
                /** 工字铺错半砖、369 铺每行错 1/3（向上铺 gy<0 时门洞第一排为 r=-1，保持第一排不错位使门中正对整砖） */
                rowShift(r) {
                    const effR = origin.gy < 0 ? (-r - 1) : r;
                    if (room.pattern === 'brick') return (Math.abs(effR) % 2) * (stepX * 0.5);
                    if (room.pattern === 'stagger_369') return (Math.abs(effR) % 3) * (stepX / 3);
                    return 0;
                },
                /** 第 r 行第 c 列整砖的四个角（世界坐标） */
                corners(r, c, rowShiftX) {
                    const lx1 = c * stepX + rowShiftX;
                    const ly1 = r * stepY;
                    const lx2 = lx1 + tileLenPx;
                    const ly2 = ly1 + tileWidPx;
                    return [
                        { lx: lx1, ly: ly1 },
                        { lx: lx2, ly: ly1 },
                        { lx: lx2, ly: ly2 },
                        { lx: lx1, ly: ly2 }
                    ].map(p => ({
                        x: origX + p.lx * cosA - p.ly * sinA,
                        y: origY + p.lx * sinA + p.ly * cosA
                    }));
                },
                /** 点集在砖块方向 (u 沿砖长, v 沿砖宽) 上的跨度 (px)，用于裁切尺寸 */
                uvSpan(pts) {
                    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
                    for (const pt of pts) {
                        const dx = pt.x - origX, dy = pt.y - origY;
                        const u = dx * cosA + dy * sinA;
                        const v = -dx * sinA + dy * cosA;
                        if (u < minU) minU = u;
                        if (u > maxU) maxU = u;
                        if (v < minV) minV = v;
                        if (v > maxV) maxV = v;
                    }
                    return { du: maxU - minU, dv: maxV - minV };
                },
                /** 裁切下料尺寸 (mm，四舍五入且不小于 10mm、不大于整砖) */
                cutSizeMM(pts) {
                    const { du, dv } = this.uvSpan(pts);
                    return {
                        cutLenMM: Math.min(tileLenMM, Math.max(10, Math.round(du * mmPerPx))),
                        cutWidMM: Math.min(tileWidMM, Math.max(10, Math.round(dv * mmPerPx)))
                    };
                },
                frameOf(rawCorners) {
                    return { x: rawCorners[0].x, y: rawCorners[0].y, a: angleRad, w: tileLenPx, h: tileWidPx };
                }
            };
        }

        /** 通铺组内实际生效的起铺点空间（不在组内时为自身） */
        function getOriginMasterRoom(room) {
            return (room && STATE.originGroups && STATE.originGroups.get(room.id)?.master) || room;
        }

        function recomputeAllRoomTiling() {
            const reuseSmallCuts = $id('chk-small-cut-reuse')?.checked ?? true;

            // 先计算全屋门洞铺贴归属、过门石、通铺联动与压边条方案
            const doorPlans = computeAllDoorsPavingPlan();
            const roomDoorExtsMap = new Map();
            // 通铺 / 同规格对缝的空间按门洞连成通铺组，组内共用一个起铺点
            const linkParent = new Map();
            const findRoot = id => { while (linkParent.has(id) && linkParent.get(id) !== id) id = linkParent.get(id); return id; };
            for (const dp of doorPlans) {
                for (const ext of dp.roomExtensions) {
                    if (!roomDoorExtsMap.has(ext.roomId)) roomDoorExtsMap.set(ext.roomId, []);
                    roomDoorExtsMap.get(ext.roomId).push(ext);
                }
                if (dp.continuousLink) {
                    const ra = findRoot(dp.continuousLink.fromRoomId), rb = findRoot(dp.continuousLink.toRoomId);
                    if (!linkParent.has(ra)) linkParent.set(ra, ra);
                    if (!linkParent.has(rb)) linkParent.set(rb, rb);
                    if (ra !== rb) linkParent.set(rb, ra);
                }
            }
            // 通铺（merge）连成的铺贴整体：组内按一张网格排砖，跨门洞的砖只算一块
            const mergeParent = new Map();
            const findM = id => { while (mergeParent.has(id) && mergeParent.get(id) !== id) id = mergeParent.get(id); return id; };
            const bridges = [];
            for (const dp of doorPlans) {
                if (!dp.continuousLink || !dp.continuousLink.merge) continue;
                const a = dp.continuousLink.fromRoomId, b = dp.continuousLink.toRoomId;
                if (!mergeParent.has(a)) mergeParent.set(a, a);
                if (!mergeParent.has(b)) mergeParent.set(b, b);
                const ra = findM(a), rb = findM(b);
                if (ra !== rb) mergeParent.set(rb, ra);
                const ext = dp.roomExtensions.find(e => e.bridgeTo === b);
                if (ext) bridges.push({ a, b, clipPts: ext.clipPts });
            }
            const mergeGroupOf = new Map(); // roomId → { rooms, parts:[{poly, owner}], bridges, bounds }
            {
                const tmp = new Map();
                for (const id of mergeParent.keys()) {
                    const room = STATE.rooms.find(r => r.id === id && !r.cleared);
                    if (!room || getRoomPolygonVerts(room).length < 3) continue;
                    const root = findM(id);
                    if (!tmp.has(root)) tmp.set(root, []);
                    tmp.get(root).push(room);
                }
                for (const [root, rooms] of tmp) {
                    if (rooms.length < 2) continue;
                    const ids = new Set(rooms.map(r => r.id));
                    const gBridges = bridges.filter(br => ids.has(br.a) && ids.has(br.b));
                    const parts = [];
                    const allPts = [];
                    for (const r of rooms) {
                        const pv = getRoomPavingPolygonVerts(r);
                        allPts.push(...pv);
                        for (const cp of decomposePolygonToConvexParts(pv)) parts.push({ poly: cp, owner: r.id, bb: pointsBounds(cp) });
                    }
                    for (const br of gBridges) {
                        parts.push({ poly: br.clipPts, owner: br.a, bb: pointsBounds(br.clipPts), bridge: true });
                        allPts.push(...br.clipPts);
                    }
                    const info = { rooms, parts, bridges: gBridges, bounds: pointsBounds(allPts) };
                    rooms.forEach(r => mergeGroupOf.set(r.id, info));
                }
            }
            STATE.mergeGroups = mergeGroupOf;

            const groups = new Map();
            for (const id of linkParent.keys()) {
                const room = STATE.rooms.find(r => r.id === id && !r.cleared);
                if (!room) continue;
                const root = findRoot(id);
                if (!groups.has(root)) groups.set(root, []);
                groups.get(root).push(room);
            }
            STATE.originGroups = new Map(); // roomId → { master, rooms }
            for (const rooms of groups.values()) {
                if (rooms.length < 2) continue;
                // 组起铺点：最近一次手动设置过起铺点的空间 → 设了自定义起铺点的空间 → 面积最大的空间
                const area = r => { try { return computePolygonAreaMeters(getRoomInnerWallVerts(r)); } catch (e) { return 0; } };
                const byArea = (x, y) => area(y) - area(x);
                const stamped = rooms.filter(r => r.originStamp).sort((x, y) => y.originStamp - x.originStamp);
                const custom = rooms.filter(r => r.originMode === 'custom' && r.originX != null && r.originY != null).sort(byArea);
                const master = stamped[0] || custom[0] || [...rooms].sort(byArea)[0];
                const info = { master, rooms };
                rooms.forEach(r => STATE.originGroups.set(r.id, info));
            }

            for (const room of STATE.rooms) {
                const verts = getRoomPolygonVerts(room);
                if (verts.length < 3 || room.cleared) {
                    room.computedTiles = [];
                    room.stats = { areaSqm: 0, fullCount: 0, cutLargeCount: 0, cutSmallCount: 0, buyCount: 0, groutLengthM: 0, groutTubes: 0, auxArea: 0 };
                    continue;
                }

                const b = getRoomBounds(room);
                // 净面积直接按实际铺贴边界多边形（已扣除墙厚与四周外边缝）精确计算，与排砖裁剪几何完全一致
                const pavingVerts = getRoomPavingPolygonVerts(room);
                let netAreaSqm = Math.max(0, computePolygonAreaMeters(pavingVerts));
                const convexParts = decomposePolygonToConvexParts(pavingVerts);
                const doorExtItems = roomDoorExtsMap.get(room.id) || [];
                const doorExts = doorExtItems.map(e => e.quad);
                const mg = mergeGroupOf.get(room.id) || null;
                // 通铺组：本空间作为 B 侧的门洞也纳入裁切/显示区域（同一块砖跨过门洞）
                const inBridges = mg ? mg.bridges.filter(br => br.b === room.id).map(br => br.clipPts) : [];
                room.doorExtensionQuads = doorExts;
                room.doorClipPolys = doorExtItems.map(e => e.clipPts).concat(inBridges);
                room.mergeGroupRoomIds = mg ? mg.rooms.map(r => r.id) : null;
                for (const dq of doorExts) {
                    netAreaSqm += dq.areaSqm;
                }
                // 门洞延伸区与房间铺贴区一起参与裁切：跨过墙面线的砖是同一块砖。
                // 通铺组：整组铺贴区（各空间 + 门洞）作为一个整体裁切，每块砖按面积占比归属一个空间
                const clipParts = mg
                    ? mg.parts
                    : convexParts.map(cp => ({ poly: cp, owner: room.id })).concat(doorExtItems.map(e => ({ poly: e.clipPts, owner: room.id })));
                const pB = pointsBounds(pavingVerts.concat(...doorExtItems.map(e => e.clipPts), ...inBridges));
                const pMinX = pB.minX, pMaxX = pB.maxX, pMinY = pB.minY, pMaxY = pB.maxY;
                const nearRects = doorExts.map(dq => dq.rect).concat(inBridges.map(cp => { const b2 = pointsBounds(cp); return { x1: b2.minX, y1: b2.minY, x2: b2.maxX, y2: b2.maxY }; }));

                const masterRoom = getOriginMasterRoom(room);
                const orig = getRoomOriginWorld(masterRoom);
                const latticeB = mg ? pointsBounds([mg.bounds && { x: mg.bounds.minX, y: mg.bounds.minY }, { x: mg.bounds.maxX, y: mg.bounds.maxY }, orig]) : pB;
                const G = createPavingLattice(room, orig, latticeB);
                const { tileLenMM, tileWidMM, jointMM, fullTileAreaPx } = G;
                const range = G.rangeFor(pMinX, pMinY, pMaxX, pMaxY);

                const roomTiles = [];
                let fullCount = 0, cutLargeCount = 0, cutSmallCount = 0;
                let roomTileSeq = 1;
                const formatRoomTileId = () => roomTileSeq++;   // 临时序号；排砖完成后由 renumberTiles() 统一改为规格编号
                const countCategory = (category) => {
                    if (category === 'FULL') fullCount++;
                    else if (category === 'CUT_LARGE') cutLargeCount++;
                    else cutSmallCount++;
                };

                for (let r = range.minRow; r <= range.maxRow; r++) {
                    const rowShiftX = G.rowShift(r);
                    for (let c = range.minCol; c <= range.maxCol; c++) {
                        const rawCorners = G.corners(r, c, rowShiftX);
                        const tb = pointsBounds(rawCorners);
                        if (tb.maxX <= pMinX + 0.05 || tb.minX >= pMaxX - 0.05 || tb.maxY <= pMinY + 0.05 || tb.minY >= pMaxY - 0.05) continue;

                        const nearAnyDoor = nearRects.some(rc => !(tb.maxX < rc.x1 - 1 || tb.minX > rc.x2 + 1 || tb.maxY < rc.y1 - 1 || tb.minY > rc.y2 + 1));
                        if (!nearAnyDoor && isQuadFullyInsidePolygon(rawCorners, pavingVerts)) {
                            fullCount++;
                            roomTiles.push({
                                id: formatRoomTileId(),
                                roomId: room.id,
                                roomName: room.name,
                                category: 'FULL',
                                polys: [rawCorners],
                                frame: G.frameOf(rawCorners),
                                center: {
                                    x: (rawCorners[0].x + rawCorners[2].x) * 0.5,
                                    y: (rawCorners[0].y + rawCorners[2].y) * 0.5
                                },
                                cutLenMM: tileLenMM,
                                cutWidMM: tileWidMM,
                                areaRatio: 1.0
                            });
                            continue;
                        }

                        let clippedParts = [];
                        let totalClippedAreaPx = 0;
                        const ownerArea = new Map();
                        for (const cPart of clipParts) {
                            if (cPart.bb && (tb.maxX < cPart.bb.minX || tb.minX > cPart.bb.maxX || tb.maxY < cPart.bb.minY || tb.minY > cPart.bb.maxY)) continue;
                            const cp = clipPolygonAgainstConvexPoly(rawCorners, cPart.poly);
                            if (cp.length >= 3) {
                                const a = computePolygonAreaPx(cp);
                                if (a > 0.4) {
                                    clippedParts.push(cp);
                                    totalClippedAreaPx += a;
                                    ownerArea.set(cPart.owner, (ownerArea.get(cPart.owner) || 0) + a);
                                }
                            }
                        }
                        if (clippedParts.length === 0) continue;
                        if (mg) {
                            // 跨空间的砖只归属面积占比最大的空间（并列时取组内顺序靠前者），避免重复计数
                            let best = null, bestA = -1;
                            for (const gr of mg.rooms) { const a = ownerArea.get(gr.id) || 0; if (a > bestA + 1e-6) { bestA = a; best = gr.id; } }
                            if (best !== room.id) continue;
                        }
                        if (clippedParts.length > 1) {
                            clippedParts = unionClippedConvexParts(clippedParts);
                        }

                        const areaRatio = Math.min(1.0, totalClippedAreaPx / fullTileAreaPx);
                        if (areaRatio < 0.015) continue;

                        const allPts = clippedParts.flat();
                        const { cutLenMM, cutWidMM } = G.cutSizeMM(allPts);
                        const entityId = formatRoomTileId();
                        const category = classifyTileCut(areaRatio, cutLenMM, cutWidMM, tileLenMM, tileWidMM);
                        countCategory(category);

                        roomTiles.push({
                            id: entityId,
                            roomId: room.id,
                            roomName: room.name,
                            category,
                            polys: clippedParts,
                            frame: G.frameOf(rawCorners),
                            center: computePolygonCentroid(allPts),
                            cutLenMM: category === 'FULL' ? tileLenMM : cutLenMM,
                            cutWidMM: category === 'FULL' ? tileWidMM : cutWidMM,
                            areaRatio,
                            clipAreaPx: totalClippedAreaPx
                        });
                    }
                }

                room.computedTiles = roomTiles;

                const cutPieces = roomTiles.filter(t => t.category !== 'FULL').map(t => ({
                    a: t.cutLenMM,
                    b: t.cutWidMM,
                    area: t.areaRatio * tileLenMM * tileWidMM,
                    isTri: t.polys.length === 1 && t.polys[0].length === 3
                }));
                const cutNeed = countTilesForCuts(cutPieces, tileLenMM, tileWidMM, reuseSmallCuts);
                const baseNeeded = fullCount + cutNeed.tiles;
                const buyCount = Math.ceil(baseNeeded * (1 + (Number(room.wastage) || 0) / 100));

                let groutLengthM = 0, groutTubes = 0, groutAreaSqm = 0;
                if (room.materialType === 'tile' && room.groutEnabled && jointMM > 0 && netAreaSqm > 0) {
                    groutAreaSqm = netAreaSqm;
                    const wM = tileLenMM / 1000, hM = tileWidMM / 1000, gM = jointMM / 1000;
                    groutLengthM = netAreaSqm * ((wM + hM) / ((wM + gM) * (hM + gM)));
                    const C = PRESETS.calc;
                    const crossFactor = Math.max(1.0, (jointMM * C.groutDepthMM) / C.groutCrossRef); // 与墙面美缝统一截面下限与参数
                    groutTubes = Math.ceil((groutLengthM * crossFactor) / C.groutMetersPerTube);
                }

                const wastagePct = Math.max(0, Number(room.wastage) || 0);
                // 辅料面积与报价单/造价统一：净铺贴面积 × (1 + 损耗%)
                const auxArea = netAreaSqm * (1 + wastagePct / 100);
                const auxUnitPrice = priceOr(room.auxPrice, matPreset(room.materialType).auxPrice);
                const auxCost = auxArea * auxUnitPrice;
                const groutUnitPrice = priceOr(room.groutPrice, PRESETS.floor.room.groutPrice);
                const groutCost = groutAreaSqm * groutUnitPrice;
                const buyAreaSqm = buyCount * ((tileLenMM * tileWidMM) / 1e6);

                room.stats = {
                    areaSqm: netAreaSqm,
                    buyAreaSqm,
                    fullCount,
                    cutLargeCount,
                    cutSmallCount,
                    buyCount,
                    reuseSaved: cutNeed.saved,
                    groutLengthM,
                    groutAreaSqm,
                    groutTubes,
                    groutCost,
                    auxArea,
                    auxCost
                };
            }

            renumberTiles();
            refreshViews({ results: true, preview3d: true, canvas: false });
        }

        /**
         * 按与 recomputeAllRoomTiling 完全一致的排砖网格，评估“以某个墙角为起铺点”时的裁切情况。
         * 返回 { full, cut, narrow, wasteTiles }：
         *  - cut        需要切割的砖块数 (散块数)
         *  - narrow     切后最窄边 < 150mm 的细条 (难切、易崩边、基本无法复用)
         *  - wasteTiles 裁掉部分的面积合计 (以整砖面积为单位)
         */
        function evaluateRoomTilingAtOrigin(room, originWorld) {
            const pavingVerts = getRoomPavingPolygonVerts(room);
            if (!pavingVerts || pavingVerts.length < 3) return null;
            const convexParts = decomposePolygonToConvexParts(pavingVerts);
            const pB = pointsBounds(pavingVerts);
            const G = createPavingLattice(room, originWorld, pB);
            const { tileLenMM, tileWidMM, mmPerPx, fullTileAreaPx } = G;
            // 边缘裁切砖宽度不得小于原砖的 1/3（且不低于 100mm = 10cm）
            const minCutLenMM = Math.min(tileLenMM - 15, Math.max(100, tileLenMM / 3));
            const minCutWidMM = Math.min(tileWidMM - 15, Math.max(100, tileWidMM / 3));
            const range = G.rangeFor(pB.minX, pB.minY, pB.maxX, pB.maxY);

            let full = 0, cut = 0, narrow = 0, narrowU = 0, narrowV = 0, wasteTiles = 0;
            let minRatioU = 1.0, minRatioV = 1.0;
            for (let r = range.minRow; r <= range.maxRow; r++) {
                const rowShiftX = G.rowShift(r);
                for (let c = range.minCol; c <= range.maxCol; c++) {
                    const quad = G.corners(r, c, rowShiftX);
                    const tb = pointsBounds(quad);
                    if (tb.maxX <= pB.minX + 0.05 || tb.minX >= pB.maxX - 0.05 || tb.maxY <= pB.minY + 0.05 || tb.minY >= pB.maxY - 0.05) continue;
                    if (isQuadFullyInsidePolygon(quad, pavingVerts)) { full++; continue; }

                    let areaPx = 0;
                    const pts = [];
                    for (const cPart of convexParts) {
                        const cp = clipPolygonAgainstConvexPoly(quad, cPart);
                        if (cp.length < 3) continue;
                        const a = computePolygonAreaPx(cp);
                        if (a <= 0.4) continue;
                        areaPx += a;
                        pts.push(...cp);
                    }
                    const ratio = Math.min(1, areaPx / fullTileAreaPx);
                    if (ratio < 0.015) continue;
                    const { du, dv } = G.uvSpan(pts);
                    const cutLenMM = Math.min(tileLenMM, du * mmPerPx);
                    const cutWidMM = Math.min(tileWidMM, dv * mmPerPx);
                    if (classifyTileCut(ratio, cutLenMM, cutWidMM, tileLenMM, tileWidMM) === 'FULL') { full++; continue; }
                    cut++;
                    wasteTiles += 1 - ratio;
                    const isCutU = cutLenMM < tileLenMM - 10;
                    const isCutV = cutWidMM < tileWidMM - 10;
                    const badU = isCutU && cutLenMM < minCutLenMM;
                    const badV = isCutV && cutWidMM < minCutWidMM;
                    if (badU) narrowU++;
                    if (badV) narrowV++;
                    if (badU || badV) narrow++;
                    if (isCutU) minRatioU = Math.min(minRatioU, cutLenMM / tileLenMM);
                    if (isCutV) minRatioV = Math.min(minRatioV, cutWidMM / tileWidMM);
                }
            }
            return { full, cut, narrow, narrowU, narrowV, minRatioU, minRatioV, wasteTiles };
        }

        /**
         * 查找封闭空间外围墙体上的所有门洞候选（含门宽、内外墙属性、门框起止点与房间内侧中点）：
         * 多扇门时严格按门洞宽度从大到小排序（同宽时优先建筑最外墙上的门洞）。
         */
        /**
         * 遍历空间外围墙体上水平 / 竖直墙中的门洞，每扇门对本空间一侧回调一次：
         * cb({ op, w, c 门洞中心, h 半墙厚, nx, ny 指向本空间的法向, axis })。斜墙上的门跳过（砖块无法沿斜向对中）。
         */
        function forEachRoomAxisDoor(room, insideOffset, cb) {
            if (!room) return;
            const poly = getRoomPolygonVerts(room);
            if (!poly || poly.length < 3) return;
            const wallIds = new Set(roomWalls(room).map(w => w.id));
            for (const op of STATE.openings) {
                if (op.type !== 'door' || !wallIds.has(op.wallId)) continue;
                const w = getWall(op.wallId);
                const v1 = w && getVertex(w.v1), v2 = w && getVertex(w.v2);
                if (!v1 || !v2) continue;
                const len = dist(v1, v2);
                if (len < 1) continue;
                const ux = (v2.x - v1.x) / len, uy = (v2.y - v1.y) / len;
                const axis = Math.abs(uy) < 0.02 ? 'x' : (Math.abs(ux) < 0.02 ? 'y' : null);
                if (!axis) continue;
                const t = Number(op.t) || 0.5;
                const c = { x: v1.x + (v2.x - v1.x) * t, y: v1.y + (v2.y - v1.y) * t };
                const h = (w.thickness || 12) / 2;
                for (const sgn of [1, -1]) {
                    const nx = -uy * sgn, ny = ux * sgn;
                    if (isPointInPolygon({ x: c.x + nx * (h + insideOffset), y: c.y + ny * (h + insideOffset) }, poly)) cb({ op, w, c, h, nx, ny, axis });
                }
            }
        }

        function getRoomDoorCandidates(room) {
            const out = [];
            const mmPerPx = 1000 / SCALE_PIXELS_PER_METER;
            forEachRoomAxisDoor(room, 1.5, ({ op, w, c, h, nx, ny, axis }) => {
                const widthPx = Number(op.width) || 44;
                // 判断门另一侧是否属于其它封闭房间（若不属于任何其它房间，则为外墙入户门）
                const probeOut = { x: c.x - nx * (h + 3), y: c.y - ny * (h + 3) };
                const hasOtherRoom = STATE.rooms.some(r2 => r2.id !== room.id && !r2.cleared && isPointInPolygon(probeOut, getRoomPolygonVerts(r2)));
                out.push({
                    x: c.x + nx * h, y: c.y + ny * h, axis,
                    openingId: op.id, wallId: w.id,
                    widthPx, widthMM: widthPx * mmPerPx,
                    isExteriorWall: !hasOtherRoom
                });
            });
            // 优先取空间最外墙上的门洞；有多扇门时取最大（宽）的门为准
            out.sort((a, b) => ((b.isExteriorWall ? 1 : 0) - (a.isExteriorWall ? 1 : 0)) || (b.widthPx - a.widthPx));
            return out;
        }

        /**
         * 单空间 AI 优排（供全局 AI 优排调用）：
         * 1. 以封闭空间最外墙中的门洞为起铺点（有多扇门的取最宽的门为准），起铺点直接对准门中心；
         * 2. 门中正对一块完整整砖（砖中对门中，绝不出现砖缝对着门中心，进门方向整砖起铺）；
         * 3. 若两侧边缘裁切砖宽度小于原砖 1/3（通常 10–15cm），仅在保持该整砖正对门中心的前提下做最小微调；
         * 4. 无门洞的空间遍历墙角选出无 <1/3 窄条且整砖最多的起铺点。
         */
        function optimizeSingleRoomOrigin(room) {
            if (!room || room.cleared) return null;
            let corners = [];
            try { corners = getRoomInnerWallVerts(room) || []; } catch (e) { corners = []; }
            if (corners.length < 3) return null;
            const pav = getRoomPavingPolygonVerts(room);
            if (!pav || pav.length < 3) return null;
            const mmPerPx = 1000 / SCALE_PIXELS_PER_METER;
            const pxPerMM = 1 / mmPerPx;
            const tileLenMM = Math.max(50, Number(room.tileW) || 800);
            const tileWidMM = Math.max(50, Number(room.tileH) || 800);

            const saved = {
                originMode: room.originMode,
                originX: room.originX,
                originY: room.originY,
                originDoorAlign: room.originDoorAlign || null,
                originDoorId: room.originDoorId || null,
                originDoorOffset: room.originDoorOffset || 0
            };

            const doors = getRoomDoorCandidates(room);
            if (doors.length > 0 && room.pattern !== 'diagonal') {
                const mainDoor = doors[0]; // 优先最外墙门洞，多扇门取最宽门洞
                const isX = mainDoor.axis === 'x';
                const tileSpanMM = isX ? tileLenMM : tileWidMM;
                const tileSpanPx = tileSpanMM * pxPerMM;

                // 默认 delta = 0：起铺点对准门中心，门中正对一整块砖（砖中心与门中心严格重合）
                room.originMode = 'custom';
                room.originX = mainDoor.x;
                room.originY = mainDoor.y;
                room.originDoorAlign = mainDoor.axis;
                room.originDoorId = mainDoor.openingId;
                room.originDoorOffset = 0;

                const ow0 = getRoomOriginWorld(room);
                const ev0 = evaluateRoomTilingAtOrigin(room, ow0);
                let bestDoorCand = {
                    originX: mainDoor.x,
                    originY: mainDoor.y,
                    originDoorAlign: mainDoor.axis,
                    originDoorId: mainDoor.openingId,
                    originDoorOffset: 0,
                    ev: ev0 || { full: 0, cut: 0, narrow: 0 },
                    doorWidthMM: Math.round(mainDoor.widthMM),
                    isExteriorDoor: !!mainDoor.isExteriorWall,
                    tag: '门中正对整砖'
                };

                // 若默认“砖中对门中”在门洞方向两侧墙边产生了 < 1/3 原砖宽度的窄裁切砖，
                // 在确保同一块整砖仍然正对门中心（最大偏移不超过 1/4 砖宽，严禁砖缝靠近门中）的范围内寻找最小偏移消除 <1/3 窄条
                const narrowDoor0 = ev0 ? (isX ? ev0.narrowU : ev0.narrowV) : 0;
                if (ev0 && narrowDoor0 > 0) {
                    const maxShiftPx = tileSpanPx * 0.24;
                    const STEPS = 16;
                    for (let s = 1; s <= STEPS; s++) {
                        const absShift = (s / STEPS) * maxShiftPx;
                        for (const sgn of [1, -1]) {
                            const delta = absShift * sgn;
                            room.originDoorOffset = delta;
                            const ow = getRoomOriginWorld(room);
                            const ev = evaluateRoomTilingAtOrigin(room, ow);
                            if (!ev) continue;
                            const narrowDoor = isX ? ev.narrowU : ev.narrowV;
                            if (narrowDoor === 0) {
                                bestDoorCand = {
                                    originX: mainDoor.x,
                                    originY: mainDoor.y,
                                    originDoorAlign: mainDoor.axis,
                                    originDoorId: mainDoor.openingId,
                                    originDoorOffset: Math.round(delta * 1000) / 1000,
                                    ev,
                                    doorWidthMM: Math.round(mainDoor.widthMM),
                                    isExteriorDoor: !!mainDoor.isExteriorWall,
                                    tag: '门中正对整砖(防窄边微调)'
                                };
                                break;
                            }
                        }
                        if ((isX ? bestDoorCand.ev.narrowU : bestDoorCand.ev.narrowV) === 0) break;
                    }
                }

                room.originMode = saved.originMode;
                room.originX = saved.originX;
                room.originY = saved.originY;
                room.originDoorAlign = saved.originDoorAlign;
                room.originDoorId = saved.originDoorId;
                room.originDoorOffset = saved.originDoorOffset;

                return bestDoorCand;
            }

            // 无门洞或 45° 斜铺空间：遍历各内墙角，优先整砖且保证边缘裁切砖 >= 1/3 原砖
            room.originDoorAlign = null;
            room.originDoorId = null;
            room.originDoorOffset = 0;
            let bestCorner = null;
            const seen = new Set();
            for (const cnr of corners) {
                const cx = Math.round(cnr.x), cy = Math.round(cnr.y);
                const key = `${cx},${cy}`;
                if (seen.has(key)) continue;
                seen.add(key);
                room.originMode = 'custom';
                room.originX = cx;
                room.originY = cy;
                const ow = getRoomOriginWorld(room);
                const ev = evaluateRoomTilingAtOrigin(room, ow);
                if (!ev) continue;
                const score = ev.narrow * 150000 + ev.cut * 120 - ev.full * 35 + ev.wasteTiles * 25;
                if (!bestCorner || score < bestCorner.score - 1e-6) {
                    bestCorner = {
                        originX: cx,
                        originY: cy,
                        originDoorAlign: null,
                        originDoorId: null,
                        originDoorOffset: 0,
                        score,
                        ev,
                        doorWidthMM: 0,
                        isExteriorDoor: false,
                        tag: '墙角整砖优排'
                    };
                }
            }
            room.originMode = saved.originMode;
            room.originX = saved.originX;
            room.originY = saved.originY;
            room.originDoorAlign = saved.originDoorAlign;
            room.originDoorId = saved.originDoorId;
            room.originDoorOffset = saved.originDoorOffset;
            return bestCorner;
        }

        /**
         * 全局 AI 优排：对全屋所有有效封闭空间一键执行门洞居中整砖起铺优排
         */
        function autoOptimizeAllRoomsOrigin() {
            const validRooms = STATE.rooms.filter(r => !r.cleared && getRoomPolygonVerts(r).length >= 3);
            if (validRooms.length === 0) {
                showToast('当前画布暂无有效封闭空间，请先绘制或导入户型');
                return;
            }
            saveHistory();
            let optimizedCount = 0;
            let doorRoomsCount = 0;
            const stampBase = Date.now();

            for (let i = 0; i < validRooms.length; i++) {
                const room = validRooms[i];
                const best = optimizeSingleRoomOrigin(room);
                if (!best) continue;
                room.originMode = 'custom';
                room.originX = best.originX;
                room.originY = best.originY;
                room.originDoorAlign = best.originDoorAlign;
                room.originDoorId = best.originDoorId || null;
                room.originDoorOffset = best.originDoorOffset || 0;
                // 通铺组优先级：拥有最外墙入户门的空间优先作为全组主起铺基准，其次按最宽门洞与空间面积排序
                const extPriority = best.isExteriorDoor ? 1000000 : (best.originDoorAlign ? 500000 : 0);
                room.originStamp = stampBase + extPriority + (best.doorWidthMM || 0) * 10 + i;
                optimizedCount++;
                if (best.originDoorAlign) doorRoomsCount++;
            }

            refreshViews({ tiling: true, panel: true, results: true, preview3d: true, canvas: true });
            const totalFull = validRooms.reduce((s, r) => s + (r.stats?.fullCount || 0), 0);
            showToast(`全屋 AI 优排完成：已优排 ${optimizedCount} 个空间（${doorRoomsCount} 个空间起铺点对准最宽门洞中心，门中正对整砖），全屋整砖 ${totalFull} 块`);
        }

        /*************************************************************************
         * 六、2D 工程画布渲染引擎
         *************************************************************************/
        function resizeCanvas() {
            const dpr = window.devicePixelRatio || 1;
            const rect = container.getBoundingClientRect();
            canvas.width = Math.max(1, rect.width * dpr);
            canvas.height = Math.max(1, rect.height * dpr);
            canvas.style.width = `${rect.width}px`;
            canvas.style.height = `${rect.height}px`;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            render();
        }
        window.addEventListener('resize', () => {
            resizeCanvas();
            const modal = $id('import-modal');
            if (modal && !modal.classList.contains('hidden')) {
                renderCvModalPreview();
            }
        });
        if (typeof ResizeObserver !== 'undefined' && container) {
            new ResizeObserver(() => resizeCanvas()).observe(container);
        }

        function renderSquareGrid(targetCtx, viewWidth, viewHeight) {
            targetCtx.save();
            targetCtx.fillStyle = CANVAS_THEME.bg;
            targetCtx.fillRect(0, 0, viewWidth, viewHeight);
            if (!STATE.showGrid) {
                targetCtx.restore();
                return;
            }

            targetCtx.translate(STATE.panX, STATE.panY);
            targetCtx.scale(STATE.scale, STATE.scale);

            const minX = -STATE.panX / STATE.scale;
            const minY = -STATE.panY / STATE.scale;
            const maxX = (viewWidth - STATE.panX) / STATE.scale;
            const maxY = (viewHeight - STATE.panY) / STATE.scale;

            const baseGrid = STATE.gridSize;
            const majorGrid = baseGrid * 5;

            const startSubX = Math.floor(minX / baseGrid) * baseGrid;
            const endSubX = Math.ceil(maxX / baseGrid) * baseGrid;
            const startSubY = Math.floor(minY / baseGrid) * baseGrid;
            const endSubY = Math.ceil(maxY / baseGrid) * baseGrid;

            // 细网格：极轻；缩小到屏幕间距 < 7px 时不再绘制，避免远景成片灰噪
            const drawMinor = baseGrid * STATE.scale >= 7;
            targetCtx.lineWidth = 1 / STATE.scale;
            targetCtx.strokeStyle = CANVAS_THEME.gridMinor;
            targetCtx.beginPath();
            if (drawMinor) for (let x = startSubX; x <= endSubX; x += baseGrid) {
                if (x % majorGrid !== 0) { targetCtx.moveTo(x, startSubY); targetCtx.lineTo(x, endSubY); }
            }
            if (drawMinor) for (let y = startSubY; y <= endSubY; y += baseGrid) {
                if (y % majorGrid !== 0) { targetCtx.moveTo(startSubX, y); targetCtx.lineTo(endSubX, y); }
            }
            targetCtx.stroke();

            const startMajorX = Math.floor(minX / majorGrid) * majorGrid;
            const endMajorX = Math.ceil(maxX / majorGrid) * majorGrid;
            const startMajorY = Math.floor(minY / majorGrid) * majorGrid;
            const endMajorY = Math.ceil(maxY / majorGrid) * majorGrid;

            targetCtx.lineWidth = 1 / STATE.scale;
            targetCtx.strokeStyle = CANVAS_THEME.gridMajor;
            targetCtx.beginPath();
            for (let x = startMajorX; x <= endMajorX; x += majorGrid) {
                targetCtx.moveTo(x, startSubY); targetCtx.lineTo(x, endSubY);
            }
            for (let y = startMajorY; y <= endMajorY; y += majorGrid) {
                targetCtx.moveTo(startSubX, y); targetCtx.lineTo(endSubX, y);
            }
            targetCtx.stroke();
            targetCtx.restore();
        }

        function renderUnderlayImage(targetCtx = ctx) {
            if (!STATE.bgImage || !STATE.showBgImage || STATE.bgOpacity <= 0) return;
            targetCtx.save();
            const drawW = STATE.imageWidth * STATE.bgWorldScale;
            const drawH = STATE.imageHeight * STATE.bgWorldScale;
            targetCtx.globalAlpha = STATE.bgOpacity;
            targetCtx.drawImage(STATE.bgImage, STATE.bgOffsetX, STATE.bgOffsetY, drawW, drawH);
            targetCtx.restore();
        }

        function renderRoomsAndPaving(targetCtx = ctx, roomFilter = null) {
            const isMainView = (targetCtx === ctx);
            for (const room of STATE.rooms) {
                if (roomFilter && !roomFilter.has(room.id)) continue;
                const polyVerts = getRoomPolygonVerts(room);
                if (polyVerts.length < 3) continue;

                const isSelected = isMainView && room.id === STATE.selectedRoomId;
                const isHovered = isMainView && STATE.hovered?.type === 'room' && STATE.hovered.id === room.id;
                const styleObj = MaterialLib.getForRoom(room);
                const hasOuterGap = !room.cleared && (Number(room.expansionGap) || 0) > 0;
                const pavingVerts = hasOuterGap ? getRoomPavingPolygonVerts(room) : polyVerts;

                targetCtx.save();
                targetCtx.beginPath();
                tracePolygon(targetCtx, polyVerts);

                if (room.cleared) {
                    targetCtx.fillStyle = 'rgba(241, 245, 249, 0.7)';
                } else if (hasOuterGap) {
                    // 最外圈离墙外边缝留空基层背景（瓷砖与木地板通用）
                    targetCtx.fillStyle = room.materialType === 'wood'
                        ? 'rgba(243, 236, 223, 0.85)'
                        : 'rgba(226, 232, 240, 0.82)';
                } else {
                    targetCtx.fillStyle = styleObj.base;
                }
                const hasUnderlay = isMainView && !!(STATE.bgImage && STATE.showBgImage);
                const roomFillAlpha = hasUnderlay
                    ? Math.max(0.12, 0.95 - STATE.bgOpacity * 0.80)
                    : 1.0;
                targetCtx.globalAlpha = roomFillAlpha;
                if (!hasOuterGap || room.cleared) {
                    targetCtx.fill();
                } else {
                    targetCtx.fill();
                    if (pavingVerts.length >= 3) {
                        targetCtx.beginPath();
                        tracePolygon(targetCtx, pavingVerts);
                        targetCtx.fillStyle = styleObj.base;
                        targetCtx.fill();
                    }
                }
                targetCtx.globalAlpha = 1.0;

                if (STATE.showPaving && !room.cleared && room.computedTiles) {
                    targetCtx.save();
                    targetCtx.beginPath();
                    tracePolygon(targetCtx, pavingVerts);
                    // 门洞延伸区按“从铺贴边界起算”的裁切区绘制，砖在门洞处连续，不被外边缝切断
                    for (const cp of (room.doorClipPolys || [])) {
                        if (cp && cp.length >= 3) tracePolygon(targetCtx, cp);
                    }
                    targetCtx.clip();
                    const gap = roomGapStroke(room, targetCtx);
                    for (const tile of room.computedTiles) {
                        drawPavingTile(targetCtx, tile, room, styleObj, gap);
                        drawTileLabel(targetCtx, tile);
                    }
                    // 通铺组：相邻空间的砖跨进本空间的部分也在本空间区域内画出（编号只在归属空间标注）
                    for (const mid of (room.mergeGroupRoomIds || [])) {
                        if (mid === room.id) continue;
                        const mr = getRoom(mid);
                        if (!mr || mr.cleared || !mr.computedTiles) continue;
                        const pvb = pointsBounds(pavingVerts.concat(...(room.doorClipPolys || [])));
                        for (const tile of mr.computedTiles) {
                            const tb = getPolysBounds(tile.polys);
                            if (tb[2] < pvb.minX || tb[0] > pvb.maxX || tb[3] < pvb.minY || tb[1] > pvb.maxY) continue;
                            drawPavingTile(targetCtx, tile, mr, styleObj, gap);
                        }
                    }
                    targetCtx.restore();
                }

                if (hasOuterGap && pavingVerts.length >= 3) drawOuterGapBand(targetCtx, room);

                // 选中/悬停的室内浅色罩染（只在主画布绘制，导出图纸时不带选中态）。
                // 注：区域边缘高亮已移至 renderRoomSelectionOverlay()，在墙体之上绘制，
                // 否则描边会被后绘制的墙体覆盖，看不到选中状态。
                if ((isSelected || isHovered) && targetCtx === ctx) {
                    targetCtx.save();
                    targetCtx.beginPath();
                    tracePolygon(targetCtx, polyVerts);
                    targetCtx.fillStyle = isSelected ? 'rgba(53, 106, 230, 0.03)' : 'rgba(53, 106, 230, 0.015)';
                    targetCtx.fill();
                    targetCtx.restore();
                }

                if (STATE.showRoomLabels !== false) {
                    // 在任意户型空间内虚拟出最大内接矩形区域，将文字居中放置于该虚拟矩形中心
                    const vRect = getRoomVirtualCenterRect(room);
                    const labelX = vRect.cx, labelY = vRect.cy;
                    const areaSqm = room.stats ? room.stats.areaSqm : computePolygonAreaMeters(polyVerts);
                    const buyCount = room.stats ? room.stats.buyCount : 0;
                    const matBadge = room.cleared
                        ? '未铺贴'
                        : `${room.materialType === 'wood' ? '地板' : '瓷砖'} ${room.tileW}×${room.tileH} · ${buyCount}块`;

                    // 空间文字标签：无白色底块、在虚拟矩形中心居中，自适应字号且保证清晰易读
                    targetCtx.save();
                    const curScale = (targetCtx === ctx) ? (STATE.scale || 1) : 1;
                    const rectSpanW = Math.max(20, vRect.w - 12);
                    const rectSpanH = Math.max(16, vRect.h - 12);
                    const minRectSpan = Math.min(rectSpanW, rectSpanH);

                    const nameText = `${room.name || '未命名'}`;
                    const areaText = `${areaSqm.toFixed(2)} m²`;
                    // 屏幕字号范围 [11.0px, 16.0px]，随虚拟矩形与画布缩放自适应
                    const desiredScreenPx = Math.max(11.0, Math.min(16.0, minRectSpan * curScale * 0.11));
                    let titleFontPx = desiredScreenPx / curScale;

                    targetCtx.font = `600 ${titleFontPx}px ${CANVAS_FONT_SANS}`;
                    const measuredTitleW = Math.max(targetCtx.measureText(nameText).width, targetCtx.measureText(areaText).width * 0.86);
                    const measuredBadgeW = targetCtx.measureText(matBadge).width * 0.76;
                    const maxTextW = Math.max(measuredTitleW, measuredBadgeW, 1);
                    if (maxTextW > rectSpanW * 0.82) {
                        titleFontPx = Math.max(7.5 / curScale, titleFontPx * ((rectSpanW * 0.82) / maxTextW));
                    }
                    if (titleFontPx * 3.2 > rectSpanH * 0.74) {
                        titleFontPx = Math.max(7.5 / curScale, (rectSpanH * 0.74) / 3.2);
                    }
                    const areaFontPx = titleFontPx * 0.82;
                    const subFontPx = titleFontPx * 0.72;
                    const lineStep = titleFontPx * 1.18;

                    targetCtx.textAlign = 'center';
                    targetCtx.textBaseline = 'middle';
                    targetCtx.lineJoin = 'round';
                    targetCtx.miterLimit = 2;

                    // 第一行：房间名称
                    targetCtx.font = `600 ${titleFontPx}px ${CANVAS_FONT_SANS}`;
                    targetCtx.lineWidth = Math.max(1.8 / curScale, titleFontPx * 0.22);
                    targetCtx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
                    targetCtx.strokeText(nameText, labelX, labelY - lineStep);
                    targetCtx.fillStyle = isSelected ? CANVAS_THEME.accentDark : CANVAS_THEME.label;
                    targetCtx.fillText(nameText, labelX, labelY - lineStep);

                    // 第二行：房间面积（在名称下方）
                    targetCtx.font = `500 ${areaFontPx}px ${CANVAS_FONT_MONO}`;
                    targetCtx.lineWidth = Math.max(1.6 / curScale, areaFontPx * 0.22);
                    targetCtx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
                    targetCtx.strokeText(areaText, labelX, labelY);
                    targetCtx.fillStyle = isSelected ? CANVAS_THEME.accentDark : CANVAS_THEME.label2;
                    targetCtx.fillText(areaText, labelX, labelY);

                    // 第三行：副标题（规格与块数）
                    targetCtx.font = `400 ${subFontPx}px ${CANVAS_FONT_MONO}`;
                    targetCtx.lineWidth = Math.max(1.5 / curScale, subFontPx * 0.22);
                    targetCtx.strokeStyle = 'rgba(255, 255, 255, 0.82)';
                    targetCtx.strokeText(matBadge, labelX, labelY + lineStep);
                    targetCtx.fillStyle = isSelected ? CANVAS_THEME.accent : (room.materialType === 'wood' ? '#8A6A3A' : CANVAS_THEME.label3);
                    targetCtx.fillText(matBadge, labelX, labelY + lineStep);
                    targetCtx.restore();
                }

                // 起铺点十字靶标改在墙体与门窗之后绘制 (见 renderOriginTargetsOverlay)，避免被门洞或墙体遮挡

                targetCtx.restore();
            }
        }

        function buildWallPolylines(items) {
            const adj = new Map();
            items.forEach((it, idx) => {
                if (!adj.has(it.v1.id)) adj.set(it.v1.id, []);
                if (!adj.has(it.v2.id)) adj.set(it.v2.id, []);
                adj.get(it.v1.id).push({ idx, other: it.v2.id });
                adj.get(it.v2.id).push({ idx, other: it.v1.id });
            });

            const used = new Array(items.length).fill(false);
            const polylines = [];

            const walk = (startVid, startIdx) => {
                const ids = [startVid];
                let curVid = startVid, idx = startIdx;
                used[idx] = true;
                let guard = 0;
                while (guard++ < 5000) {
                    const it = items[idx];
                    const nextVid = (it.v1.id === curVid) ? it.v2.id : it.v1.id;
                    ids.push(nextVid);
                    curVid = nextVid;
                    const links = adj.get(curVid) || [];
                    if (links.length !== 2) break;
                    const next = links.find(l => !used[l.idx]);
                    if (!next) break;
                    used[next.idx] = true;
                    idx = next.idx;
                }
                polylines.push(ids);
            };

            for (const [vid, links] of adj) {
                if (links.length === 2) continue;
                for (const l of links) if (!used[l.idx]) walk(vid, l.idx);
            }
            for (let i = 0; i < items.length; i++) {
                if (!used[i]) walk(items[i].v1.id, i);
            }
            return polylines;
        }

        function renderWalls(targetCtx = ctx, wallFilter = null) {
            const isMainView = (targetCtx === ctx);
            const items = [];
            for (const wall of STATE.walls) {
                if (wallFilter && !wallFilter.has(wall.id)) continue;
                const v1 = getVertex(wall.v1), v2 = getVertex(wall.v2);
                if (!v1 || !v2) continue;
                items.push({ wall, v1, v2 });
            }
            if (items.length === 0) return;

            const isHighlighted = (wall) => isMainView &&
                (isWallSelected(wall.id) || (STATE.hovered?.type === 'wall' && STATE.hovered.id === wall.id));

            const groups = new Map();
            for (const it of items) {
                const th = it.wall.thickness || 12;
                if (!groups.has(th)) groups.set(th, []);
                groups.get(th).push(it);
            }

            const jointPolygons = (e1, e2) => {
                const P = e1.p;
                const d1 = { x: e1.other.x - P.x, y: e1.other.y - P.y };
                const d2 = { x: e2.other.x - P.x, y: e2.other.y - P.y };
                const l1 = Math.hypot(d1.x, d1.y), l2 = Math.hypot(d2.x, d2.y);
                if (l1 < 0.001 || l2 < 0.001) return [];
                const u1 = { x: d1.x / l1, y: d1.y / l1 };
                const u2 = { x: d2.x / l2, y: d2.y / l2 };
                const h1 = (e1.it.wall.thickness || 12) / 2;
                const h2 = (e2.it.wall.thickness || 12) / 2;

                const capRect = (P0, u, h) => {
                    const nx = -u.y, ny = u.x;
                    return [
                        { x: P0.x + nx * h, y: P0.y + ny * h },
                        { x: P0.x - nx * h, y: P0.y - ny * h },
                        { x: P0.x - nx * h - u.x * h, y: P0.y - ny * h - u.y * h },
                        { x: P0.x + nx * h - u.x * h, y: P0.y + ny * h - u.y * h }
                    ];
                };

                const cr = u1.x * u2.y - u1.y * u2.x;
                if (Math.abs(cr) < 0.02) {
                    // 共线墙段：端部补块只取两者中较薄的半厚，避免厚墙补块伸进薄墙一侧形成凸块
                    const hc = Math.min(h1, h2);
                    return [capRect(P, u1, hc), capRect(P, u2, hc)];
                }

                const s = cr > 0 ? 1 : -1;
                const n1 = s > 0 ? { x: u1.y, y: -u1.x } : { x: -u1.y, y: u1.x };
                const n2 = s > 0 ? { x: -u2.y, y: u2.x } : { x: u2.y, y: -u2.x };
                const A = { x: P.x + n1.x * h1, y: P.y + n1.y * h1 };
                const B = { x: P.x + n2.x * h2, y: P.y + n2.y * h2 };
                const rhs = { x: B.x - A.x, y: B.y - A.y };
                const t1 = (rhs.x * u2.y - rhs.y * u2.x) / cr;
                const M = { x: A.x + u1.x * t1, y: A.y + u1.y * t1 };

                const spike = Math.hypot(M.x - P.x, M.y - P.y);
                const limit = Math.max(12, Math.min(140, 10 * Math.max(h1, h2)));
                if (spike > limit) return [[A, B, P]];
                return [[A, M, B, P]];
            };

            const fillJointWedges = (list, color, includeNeighbors = false) => {
                const inList = new Set(list.map(it => it.wall.id));
                const byNode = new Map();
                for (const it of items) {
                    for (const p of [it.v1, it.v2]) {
                        if (!byNode.has(p.id)) byNode.set(p.id, []);
                        byNode.get(p.id).push({ it, p, other: p.id === it.v1.id ? it.v2 : it.v1 });
                    }
                }
                targetCtx.beginPath();
                let any = false;
                const dirOf = (e) => {
                    const dx = e.other.x - e.p.x, dy = e.other.y - e.p.y;
                    const l = Math.hypot(dx, dy) || 1;
                    return { x: dx / l, y: dy / l };
                };
                const isStraightPair = (a, b) => {
                    const da = dirOf(a), db = dirOf(b);
                    return Math.abs(da.x * db.y - da.y * db.x) < 0.02 && (da.x * db.x + da.y * db.y) < 0;
                };
                for (const entries of byNode.values()) {
                    if (entries.length < 2) continue;
                    // 节点上存在「贯通墙」(两段共线反向墙) 时，记下贯通墙成员：
                    // T 形节点处贯通墙与支墙之间的外侧斜接块会伸出贯通墙（两段贯通墙厚度不同时尤其明显），不再填充
                    const through = new Set();
                    if (entries.length >= 3) {
                        for (let i = 0; i < entries.length; i++) {
                            for (let j = i + 1; j < entries.length; j++) {
                                if (isStraightPair(entries[i], entries[j])) { through.add(i); through.add(j); }
                            }
                        }
                    }
                    for (let i = 0; i < entries.length; i++) {
                        for (let j = i + 1; j < entries.length; j++) {
                            const a = entries[i], b = entries[j];
                            const hasA = inList.has(a.it.wall.id), hasB = inList.has(b.it.wall.id);
                            if (includeNeighbors ? !(hasA || hasB) : !(hasA && hasB)) continue;
                            if ((through.has(i) || through.has(j)) && !isStraightPair(a, b)) continue;
                            for (const poly of jointPolygons(a, b)) {
                                if (poly.length < 3) continue;
                                // 统一绕向：同一路径内相互重叠的补块绕向相反时按 nonzero 规则会相互抵消而露出空白
                                tracePolygon(targetCtx, polygonSignedArea(poly) < 0 ? poly.slice().reverse() : poly);
                                any = true;
                            }
                        }
                    }
                }
                if (any) { targetCtx.fillStyle = color; targetCtx.fill(); }
            };

            targetCtx.save();
            targetCtx.lineCap = 'butt';
            targetCtx.lineJoin = 'miter';
            targetCtx.miterLimit = 8;

            fillJointWedges(items, CANVAS_THEME.wall);

            for (const [th, group] of groups) {
                const base = group.filter(it => !isHighlighted(it.wall));
                if (base.length === 0) continue;
                targetCtx.strokeStyle = CANVAS_THEME.wall;
                targetCtx.lineWidth = th;
                for (const ids of buildWallPolylines(base)) {
                    if (ids.length < 2) continue;
                    const closed = ids.length > 3 && ids[0] === ids[ids.length - 1];
                    const first = getVertex(ids[0]);
                    if (!first) continue;
                    targetCtx.beginPath();
                    targetCtx.moveTo(first.x, first.y);
                    const last = closed ? ids.length - 1 : ids.length;
                    for (let i = 1; i < last; i++) {
                        const v = getVertex(ids[i]);
                        if (v) targetCtx.lineTo(v.x, v.y);
                    }
                    if (closed) targetCtx.closePath();
                    targetCtx.stroke();
                }
            }

            for (const it of items) {
                if (!isHighlighted(it.wall)) continue;
                const color = isWallSelected(it.wall.id) ? CANVAS_THEME.accent : CANVAS_THEME.wallHover;
                const th = it.wall.thickness || 12;
                fillJointWedges([it], color, true);
                targetCtx.strokeStyle = color;
                targetCtx.lineWidth = th;
                targetCtx.beginPath();
                targetCtx.moveTo(it.v1.x, it.v1.y);
                targetCtx.lineTo(it.v2.x, it.v2.y);
                targetCtx.stroke();
            }
            targetCtx.restore();
        }

        /**
         * 砖缝描边：只在砖块“外侧”描线，线的外半宽 = 砖缝真实宽度 (不足 0.5 屏幕像素时保底成发丝线)。
         * 这样砖面保持真实尺寸，调大砖缝只会让缝变宽，不会把砖面“吃小”。
         */
        /**
         * 花色贴图按“整块砖”映射：贴图拉伸铺满该砖的完整外框（含铺贴角度），再裁剪到实际可见多边形。
         * 这样边缘被切割的半砖 / 小角只显示贴图的对应局部，呈现真实的裁切效果，而不是把整张图塞进碎块。
         * 没有 frame 信息的砖块，按砖块包围盒 + 房间规格兜底绘制。
         */
        /** 砖缝/板缝描边样式：颜色与半宽（主画布按缩放保证最细 0.5 屏幕像素） */
        /**
         * 外边缝（墙体内侧到铺贴边缘）：沿墙内侧画一条与砖缝同规则宽度的缝带，
         * 瓷砖用勾缝色、木地板用伸缩缝底色；门洞处 (门洞延伸铺贴区) 不画。
         */
        function drawOuterGapBand(targetCtx, room) {
            const inner = getRoomInnerWallVerts(room);
            if (inner.length < 3) return;
            const w = gapDisplayWidth(room.expansionGap, targetCtx);
            targetCtx.save();
            targetCtx.beginPath();
            tracePolygon(targetCtx, inner);
            for (const cp of (room.doorClipPolys || [])) {
                if (cp && cp.length >= 3) tracePolygon(targetCtx, cp);
            }
            targetCtx.clip('evenodd');
            targetCtx.beginPath();
            tracePolygon(targetCtx, inner);
            targetCtx.strokeStyle = room.materialType === 'wood' ? '#C2A77E' : roomGapStroke(room, targetCtx).color;
            targetCtx.lineWidth = w * 2;
            targetCtx.lineJoin = 'miter';
            targetCtx.setLineDash([]);
            targetCtx.stroke();
            targetCtx.restore();
        }

        function roomGapStroke(room, targetCtx) {
            const color = room.materialType === 'tile'
                ? (room.groutEnabled !== false ? (room.groutColor || '#94a3b8') : '#cbd5e1')
                : '#8c6239';
            // 每块砖向外描边 halfW，相邻两砖之间可见的缝宽即为 halfW
            const halfW = gapDisplayWidth(getRoomJointMM(room), targetCtx);
            return { color, halfW };
        }

        /**
         * 绘制单块砖：[底色] → 贴图（按整砖映射并裁切）→ 砖号模式下裁切砖的半透明分类色 → 砖缝描边。
         * 房间内的砖由房间底色打底 (fillBase=false)；门洞内的砖需自行填底色 (fillBase=true)。
         */
        function drawPavingTile(targetCtx, tile, room, styleObj, gap, fillBase = false) {
            const markColors = STATE.showTileMarks ? tileMarkColor(tile.category) : null;
            for (const part of tile.polys) {
                targetCtx.beginPath();
                tracePolygon(targetCtx, part);
                if (fillBase) {
                    targetCtx.fillStyle = styleObj.base;
                    targetCtx.fill();
                }
                if (styleObj.img) drawTileTexture(targetCtx, styleObj.img, tile, part, room);
                if (markColors && markColors.fill) {
                    targetCtx.beginPath();
                    tracePolygon(targetCtx, part);
                    targetCtx.fillStyle = markColors.fill;
                    targetCtx.fill();
                }
                strokeTileGapOutside(targetCtx, part, markColors ? markColors.stroke : gap.color, gap.halfW);
            }
        }

        /** 砖号标注（仅主画布、砖号模式）：屏幕上过小的砖隐藏编号，临界区间淡入，避免远景数字挤满画布 */
        function drawTileLabel(targetCtx, tile, bounds = null) {
            if (!STATE.showTileMarks || targetCtx !== ctx) return;
            const [pMinX, pMinY, pMaxX, pMaxY] = bounds || getPolysBounds(tile.polys);
            const boxW = Math.max(2, pMaxX - pMinX);
            const boxH = Math.max(2, pMaxY - pMinY);
            const isVert = boxH > boxW * 1.35;
            const longSpan = isVert ? boxH : boxW;
            const shortSpan = isVert ? boxW : boxH;
            const shortPx = shortSpan * STATE.scale, longPx = longSpan * STATE.scale;
            if (shortPx < TILE_LABEL_MIN_PX || longPx < TILE_LABEL_MIN_PX + 4) return;
            const idStr = String(tile.id);
            targetCtx.save();
            targetCtx.translate((pMinX + pMaxX) * 0.5, (pMinY + pMaxY) * 0.5);
            if (isVert) targetCtx.rotate(-Math.PI / 2);
            targetCtx.globalAlpha = Math.min(1, 0.4 + (shortPx - TILE_LABEL_MIN_PX) / 28);
            targetCtx.fillStyle = tileMarkColor(tile.category).label;
            targetCtx.textAlign = 'center';
            targetCtx.textBaseline = 'middle';
            const fontPx = Math.min(10 / STATE.scale, Math.max(6 / STATE.scale, Math.min(shortSpan * 0.32, (longSpan * 0.7) / Math.max(idStr.length * 0.72, 1.5))));
            targetCtx.font = `500 ${fontPx}px ${CANVAS_FONT_MONO}`;
            targetCtx.lineJoin = 'round';
            targetCtx.lineWidth = 2.2 / STATE.scale;
            targetCtx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
            targetCtx.strokeText(idStr, 0, 0);
            targetCtx.fillText(idStr, 0, 0);
            targetCtx.restore();
        }

        function drawTileTexture(c, img, tile, part, room) {
            if (!img || !part || part.length < 3) return;
            c.save();
            c.beginPath();
            tracePolygon(c, part);
            c.clip();
            const f = tile.frame;
            if (f && f.w > 0 && f.h > 0) {
                c.translate(f.x, f.y);
                if (f.a) c.rotate(f.a);
                c.drawImage(img, 0, 0, f.w, f.h);
            } else {
                let bx = Infinity, by = Infinity;
                for (const p of part) { bx = Math.min(bx, p.x); by = Math.min(by, p.y); }
                const mmPerPx = 1000 / SCALE_PIXELS_PER_METER;
                c.drawImage(img, bx, by, Math.max(8, (room?.tileW || 600) / mmPerPx), Math.max(8, (room?.tileH || 600) / mmPerPx));
            }
            c.restore();
        }

        function strokeTileGapOutside(c, part, color, halfW) {
            c.save();
            c.beginPath();
            c.rect(-1e5, -1e5, 2e5, 2e5);
            tracePolygon(c, part);
            c.clip('evenodd');
            c.beginPath();
            tracePolygon(c, part);
            c.strokeStyle = color;
            c.lineWidth = halfW * 2;
            c.lineJoin = 'miter';
            c.setLineDash([]);
            c.stroke();
            c.restore();
        }

        const _styleLumCache = new WeakMap();
        function parseHexLuminance(hex) {
            const m = String(hex || '').trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
            if (!m) return 245;
            let h = m[1];
            if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
            const r = parseInt(h.slice(0, 2), 16);
            const g = parseInt(h.slice(2, 4), 16);
            const b = parseInt(h.slice(4, 6), 16);
            return 0.299 * r + 0.587 * g + 0.114 * b;
        }
        function getStyleLuminance(styleObj) {
            if (!styleObj) return 245;
            if (styleObj.img && styleObj.img.complete && styleObj.img.naturalWidth > 0) {
                if (_styleLumCache.has(styleObj.img)) return _styleLumCache.get(styleObj.img);
                try {
                    const cv = document.createElement('canvas');
                    cv.width = 8; cv.height = 8;
                    const c2 = cv.getContext('2d');
                    c2.drawImage(styleObj.img, 0, 0, 8, 8);
                    const d = c2.getImageData(0, 0, 8, 8).data;
                    let sum = 0, cnt = 0;
                    for (let i = 0; i < d.length; i += 4) {
                        sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
                        cnt++;
                    }
                    const lum = cnt ? sum / cnt : parseHexLuminance(styleObj.base);
                    _styleLumCache.set(styleObj.img, lum);
                    return lum;
                } catch (e) { /* 跨域贴图回退 base 色 */ }
            }
            return parseHexLuminance(styleObj.base);
        }

        function renderOpenings(targetCtx = ctx, wallFilter = null) {
            const isMainView = (targetCtx === ctx);
            for (const op of STATE.openings) {
                if (wallFilter && !wallFilter.has(op.wallId)) continue;
                const wall = getWall(op.wallId);
                if (!wall) continue;
                const v1 = getVertex(wall.v1), v2 = getVertex(wall.v2);
                if (!v1 || !v2) continue;
                const wallLen = dist(v1, v2);
                if (wallLen < 1) continue;

                const posX = v1.x + op.t * (v2.x - v1.x);
                const posY = v1.y + op.t * (v2.y - v1.y);
                const angle = Math.atan2(v2.y - v1.y, v2.x - v1.x);

                const isSelected = isMainView && STATE.selected?.type === 'opening' && STATE.selected.id === op.id;
                const isHovered = isMainView && ((STATE.hovered?.type === 'opening' && STATE.hovered.id === op.id) ||
                    (STATE.hovered?.type === 'opening-endpoint' && STATE.hovered.id === op.id));
                const isResizingThis = isMainView && STATE.isDragging && STATE.dragTarget?.type === 'opening-endpoint' && STATE.dragTarget.id === op.id;

                targetCtx.save();
                targetCtx.translate(posX, posY);
                targetCtx.rotate(angle);

                const width = op.width || 45;
                const halfW = width / 2;
                const wallThick = wall.thickness || 12;

                targetCtx.fillStyle = CANVAS_THEME.openingGap;
                targetCtx.fillRect(-halfW, -wallThick / 2 - 0.25, width, wallThick + 0.5);

                if (op.type === 'door' && STATE.showPaving) {
                    const dPlan = (STATE.computedDoors || []).find(p => p.doorId === op.id) || analyzeDoorAdjacency(op, 1);
                    if (dPlan) {
                        if (dPlan.thresholdStone) {
                            const ts = dPlan.thresholdStone;
                            targetCtx.save();
                            targetCtx.fillStyle = ts.fill;
                            targetCtx.fillRect(-halfW, -wallThick / 2, width, wallThick);
                            // 花色库贴图：按过门石长宽铺满
                            if (ts.img) {
                                try { targetCtx.drawImage(ts.img, -halfW, -wallThick / 2, width, wallThick); } catch (e) { /* 贴图未就绪 */ }
                            }
                            if (STATE.showTileMarks) {
                                targetCtx.textAlign = 'center';
                                targetCtx.textBaseline = 'middle';
                                const fPx = Math.min(8.5 / (STATE.scale || 1), Math.max(4.5 / (STATE.scale || 1), wallThick * 0.45));
                                targetCtx.font = `700 ${fPx}px "Cascadia Mono", Consolas, "TileCalcCN", monospace`;
                                targetCtx.lineWidth = Math.max(1.8 / (STATE.scale || 1), fPx * 0.25);
                                targetCtx.strokeStyle = 'rgba(255, 255, 255, 0.88)';
                                targetCtx.strokeText(ts.id, 0, 0);
                                targetCtx.fillStyle = '#0f172a';
                                targetCtx.fillText(ts.id, 0, 0);
                            }
                            targetCtx.restore();
                        } else if (dPlan.roomExtensions && dPlan.roomExtensions.length > 0) {
                            // 在门洞区域内绘制延伸进门洞的瓷砖/木地板与板材编号（覆盖外边缝区域使通铺砖无缝贯通）
                            const maxGapPx = Math.max(1.5, mmToPx(Math.max(Number(dPlan.roomA?.expansionGap) || 0, Number(dPlan.roomB?.expansionGap) || 0)) + 0.8);
                            const mainExtRoom = getRoom(dPlan.roomExtensions[0].roomId) || dPlan.roomA;
                            const mainStyleObj = mainExtRoom ? MaterialLib.getForRoom(mainExtRoom) : null;
                            targetCtx.save();
                            targetCtx.beginPath();
                            targetCtx.rect(-halfW, -wallThick / 2 - maxGapPx, width, wallThick + maxGapPx * 2);
                            targetCtx.clip();
                            if (mainStyleObj && mainStyleObj.base) {
                                targetCtx.fillStyle = mainStyleObj.base;
                                targetCtx.fillRect(-halfW, -wallThick / 2 - maxGapPx, width, wallThick + maxGapPx * 2);
                            }
                            targetCtx.rotate(-angle);
                            targetCtx.translate(-posX, -posY);

                            const drawnRoomIds = new Set();
                            const extRoomIds = dPlan.roomExtensions.map(e => e.roomId);
                            if (dPlan.joint === 'continuous' && dPlan.roomB) extRoomIds.push(dPlan.roomB.id);
                            for (const extRoomId of extRoomIds) {
                                if (drawnRoomIds.has(extRoomId)) continue;
                                drawnRoomIds.add(extRoomId);
                                const r = getRoom(extRoomId);
                                if (!r || r.cleared || !r.computedTiles) continue;
                                const styleObj = MaterialLib.getForRoom(r);
                                const gap = roomGapStroke(r, targetCtx);
                                const dRect = dPlan.fullDoorQuad.rect;
                                for (const tile of r.computedTiles) {
                                    const tb = getPolysBounds(tile.polys);
                                    if (tb[2] < dRect.x1 - 2 || tb[0] > dRect.x2 + 2 || tb[3] < dRect.y1 - 2 || tb[1] > dRect.y2 + 2) continue;
                                    drawPavingTile(targetCtx, tile, r, styleObj, gap, true);
                                    drawTileLabel(targetCtx, tile, tb);
                                }
                            }
                            targetCtx.restore();
                        }

                        // 绘制压边条 / 收口条（无边框、黄色底带斜纹，以接缝偏移线为对应边而非中心）
                        if (dPlan.strips && dPlan.strips.length > 0) {
                            const stripH = 2.4;
                            for (const st of dPlan.strips) {
                                const sy = st.sOffset;
                                const y0 = (st.edgeSign || 1) >= 0 ? sy : (sy - stripH);
                                targetCtx.save();
                                targetCtx.beginPath();
                                targetCtx.rect(-halfW, y0, width, stripH);
                                targetCtx.fillStyle = '#fbbf24';
                                targetCtx.fill();
                                targetCtx.clip();
                                targetCtx.strokeStyle = 'rgba(180, 83, 9, 0.55)';
                                targetCtx.lineWidth = 0.85;
                                targetCtx.beginPath();
                                for (let hx = -halfW - stripH; hx < halfW + stripH; hx += 4.2) {
                                    targetCtx.moveTo(hx, y0 + stripH);
                                    targetCtx.lineTo(hx + stripH, y0);
                                }
                                targetCtx.stroke();
                                targetCtx.restore();
                            }
                        }
                    }
                }

                if (isSelected || isHovered || isResizingThis) {
                    const k = targetCtx === ctx ? 1 / (STATE.scale || 1) : 1;
                    const pad = 0.5 * k;
                    targetCtx.strokeStyle = (isSelected || isResizingThis) ? CANVAS_THEME.accent : 'rgba(53, 106, 230, 0.45)';
                    targetCtx.lineWidth = 1.5 * k;
                    targetCtx.strokeRect(-halfW - pad, -wallThick / 2 - pad, width + pad * 2, wallThick + pad * 2);
                }

                if (op.type === 'door' && STATE.showDoorLeaves !== false) {
                    const flipSign = op.flip ? -1 : 1;
                    const hingeAtEnd = !!op.hinge;
                    const hingeX = hingeAtEnd ? halfW : -halfW;
                    const startAngle = hingeAtEnd ? Math.PI : 0;
                    const endAngle = startAngle + (hingeAtEnd ? -1 : 1) * flipSign * (Math.PI / 2);
                    const counterclockwise = hingeAtEnd ? (flipSign > 0) : (flipSign < 0);
                    const arcRadius = width;

                    // 采样门扇开启扇形区域的背景亮度：浅色/纯白背景填充低透明度黑，深色/木色背景填充低透明度白，兼顾门扇识别与底层铺贴透视
                    const nx = -Math.sin(angle), ny = Math.cos(angle);
                    const sampleDist = wallThick * 0.5 + arcRadius * 0.42;
                    const samplePt = { x: posX + nx * flipSign * sampleDist, y: posY + ny * flipSign * sampleDist };
                    let bgLum = parseHexLuminance(isMainView ? CANVAS_THEME.bg : '#FFFFFF');
                    for (const rm of STATE.rooms) {
                        const rVerts = getRoomPolygonVerts(rm);
                        if (rVerts.length >= 3 && isPointInPolygon(samplePt, rVerts)) {
                            bgLum = rm.cleared
                                ? parseHexLuminance('#f1f5f9')
                                : getStyleLuminance(MaterialLib.getForRoom(rm));
                            break;
                        }
                    }
                    const useDarkSector = bgLum >= 200;
                    const sectorFill = useDarkSector ? 'rgba(17, 24, 39, 0.14)' : 'rgba(255, 255, 255, 0.22)';

                    // 完整填充门扇开启的 90° 扇形区域（从铰链中心与门洞两侧边界起铺满至圆弧）
                    targetCtx.beginPath();
                    targetCtx.moveTo(hingeX, 0);
                    targetCtx.arc(hingeX, 0, arcRadius, startAngle, endAngle, counterclockwise);
                    targetCtx.closePath();
                    targetCtx.fillStyle = sectorFill;
                    targetCtx.fill();

                    targetCtx.beginPath();
                    targetCtx.strokeStyle = isSelected ? CANVAS_THEME.accent : (useDarkSector ? '#111827' : '#475569');
                    targetCtx.lineWidth = 1.1;
                    targetCtx.setLineDash([3, 3]);
                    targetCtx.arc(hingeX, 0, arcRadius, startAngle, endAngle, counterclockwise);
                    targetCtx.stroke();
                    targetCtx.setLineDash([]);

                    targetCtx.beginPath();
                    targetCtx.strokeStyle = isSelected ? CANVAS_THEME.accentDark : (useDarkSector ? '#111827' : CANVAS_THEME.doorLeaf);
                    targetCtx.lineWidth = 2;
                    targetCtx.moveTo(hingeX, 0);
                    targetCtx.lineTo(hingeX, flipSign * arcRadius);
                    targetCtx.stroke();

                    targetCtx.beginPath();
                    targetCtx.arc(hingeX, 0, 2.2, 0, Math.PI * 2);
                    targetCtx.fillStyle = isSelected ? CANVAS_THEME.accentDark : (useDarkSector ? '#111827' : CANVAS_THEME.doorLeaf);
                    targetCtx.fill();
                } else if (op.type === 'window') {
                    const glassOff = Math.max(1.4, wallThick * 0.16);
                    targetCtx.fillStyle = '#FFFFFF';
                    targetCtx.fillRect(-halfW, -wallThick / 2, width, wallThick);
                    targetCtx.fillStyle = CANVAS_THEME.windowFill || 'rgba(220, 233, 255, 0.85)';
                    targetCtx.fillRect(-halfW, -wallThick / 2, width, wallThick);
                    targetCtx.strokeStyle = isSelected ? CANVAS_THEME.accent : (CANVAS_THEME.windowLine || '#5B82BD');
                    targetCtx.lineWidth = 1.15;
                    targetCtx.beginPath();
                    targetCtx.moveTo(-halfW, -glassOff);
                    targetCtx.lineTo(halfW, -glassOff);
                    targetCtx.moveTo(-halfW, glassOff);
                    targetCtx.lineTo(halfW, glassOff);
                    targetCtx.stroke();
                }

                // 在主画布中为选中/悬停门窗绘制两端拉伸调宽手柄与实时毫米宽度标签
                if (targetCtx === ctx && (isSelected || isHovered || isResizingThis)) {
                    const k = 1 / (STATE.scale || 1);
                    for (const endKey of ['start', 'end']) {
                        const hx = endKey === 'start' ? -halfW : halfW;
                        const activeHandle = (STATE.hovered?.type === 'opening-endpoint' && STATE.hovered.id === op.id && STATE.hovered.end === endKey) ||
                            (isResizingThis && STATE.dragTarget.end === endKey);
                        const hr = (activeHandle ? 6.2 : 5.0) * k;
                        targetCtx.beginPath();
                        targetCtx.arc(hx, 0, hr, 0, Math.PI * 2);
                        targetCtx.fillStyle = activeHandle ? '#356AE6' : '#ffffff';
                        targetCtx.strokeStyle = '#356AE6';
                        targetCtx.lineWidth = 2 * k;
                        targetCtx.fill();
                        targetCtx.stroke();
                    }


                }
                targetCtx.restore();

                // 入户门标记：仅对开启了「入户门标记」的最外墙门，在门外侧绘制指向室内的红色实心块状箭头与「入户门」文字
                if (op.type === 'door' && op.isEntryDoor) {
                    const arrow = getEntryDoorArrowGeom(op);
                    if (arrow) {
                        targetCtx.save();
                        targetCtx.beginPath();
                        arrow.poly.forEach((pt, idx) => {
                            if (idx === 0) targetCtx.moveTo(pt.x, pt.y);
                            else targetCtx.lineTo(pt.x, pt.y);
                        });
                        targetCtx.closePath();
                        targetCtx.fillStyle = '#F43F5E';
                        targetCtx.fill();
                        if (isSelected) {
                            targetCtx.strokeStyle = CANVAS_THEME.accent;
                            targetCtx.lineWidth = 1.2;
                            targetCtx.stroke();
                        }
                        const curScale = targetCtx === ctx ? (STATE.scale || 1) : 1;
                        const labelPx = targetCtx === ctx
                            ? Math.max(5.0, Math.min(9.0, 8.5 / Math.sqrt(curScale)))
                            : 8.5;
                        targetCtx.font = `600 ${labelPx}px ${CANVAS_FONT_SANS}`;
                        targetCtx.textAlign = 'center';
                        targetCtx.textBaseline = 'middle';
                        targetCtx.lineJoin = 'round';
                        targetCtx.lineWidth = Math.max(1.8, labelPx * 0.28);
                        targetCtx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
                        targetCtx.strokeText('入户门', arrow.labelPos.x, arrow.labelPos.y);
                        targetCtx.fillStyle = isSelected ? CANVAS_THEME.accent : '#E11D48';
                        targetCtx.fillText('入户门', arrow.labelPos.x, arrow.labelPos.y);
                        targetCtx.restore();
                    }
                }
            }
        }

        /** 判断门洞是否位于最外墙并返回指向室内的方向信息；户内门返回 null */
        function getExteriorDoorDirection(op) {
            if (!op || op.type !== 'door') return null;
            const w = getWall(op.wallId);
            if (!w) return null;
            const v1 = getVertex(w.v1), v2 = getVertex(w.v2);
            if (!v1 || !v2) return null;
            const len = dist(v1, v2);
            if (len < 1) return null;
            const ux = (v2.x - v1.x) / len, uy = (v2.y - v1.y) / len;
            const nx = -uy, ny = ux;
            const wallThick = w.thickness || 12;
            const cx = v1.x + op.t * (v2.x - v1.x);
            const cy = v1.y + op.t * (v2.y - v1.y);
            const probe = wallThick * 0.5 + 8;
            const ptPos = { x: cx + nx * probe, y: cy + ny * probe };
            const ptNeg = { x: cx - nx * probe, y: cy - ny * probe };
            let inPos = false, inNeg = false;
            for (const rm of (STATE.rooms || [])) {
                const verts = getRoomPolygonVerts(rm);
                if (verts.length < 3) continue;
                if (!inPos && isPointInPolygon(ptPos, verts)) inPos = true;
                if (!inNeg && isPointInPolygon(ptNeg, verts)) inNeg = true;
                if (inPos && inNeg) return null; // 两侧均有空间，属于户内门
            }
            if (inPos && !inNeg) {
                return { cx, cy, ux, uy, inX: nx, inY: ny, outX: -nx, outY: -ny, wallThick, width: op.width || 45 };
            }
            if (inNeg && !inPos) {
                return { cx, cy, ux, uy, inX: -nx, inY: -ny, outX: nx, outY: ny, wallThick, width: op.width || 45 };
            }
            // 未闭合空间时：退化按全局中心指向室内
            const ref = globalRefPoint();
            const dot = (ref.x - cx) * nx + (ref.y - cy) * ny;
            const sgn = dot >= 0 ? 1 : -1;
            return { cx, cy, ux, uy, inX: nx * sgn, inY: ny * sgn, outX: -nx * sgn, outY: -ny * sgn, wallThick, width: op.width || 45 };
        }

        /** 计算入户门块状实心箭头的世界坐标几何（位于外墙外侧、尖端指向室内，尾部外侧附带「入户门」文字位置） */
        function getEntryDoorArrowGeom(op) {
            const d = getExteriorDoorDirection(op);
            if (!d) return null;
            const tipDist = d.wallThick * 0.5 + 3.5;
            const totalLen = Math.max(11, Math.min(15, d.width * 0.32));
            const headLen = totalLen * 0.48;
            const shaftLen = totalLen - headLen;
            const headHalfW = totalLen * 0.39;
            const shaftHalfW = totalLen * 0.14;
            const tip = { x: d.cx + d.outX * tipDist, y: d.cy + d.outY * tipDist };
            const baseMid = { x: d.cx + d.outX * (tipDist + headLen), y: d.cy + d.outY * (tipDist + headLen) };
            const tailMid = { x: d.cx + d.outX * (tipDist + headLen + shaftLen), y: d.cy + d.outY * (tipDist + headLen + shaftLen) };
            const headL = { x: baseMid.x - d.ux * headHalfW, y: baseMid.y - d.uy * headHalfW };
            const headR = { x: baseMid.x + d.ux * headHalfW, y: baseMid.y + d.uy * headHalfW };
            const neckL = { x: baseMid.x - d.ux * shaftHalfW, y: baseMid.y - d.uy * shaftHalfW };
            const neckR = { x: baseMid.x + d.ux * shaftHalfW, y: baseMid.y + d.uy * shaftHalfW };
            const tailL = { x: tailMid.x - d.ux * shaftHalfW, y: tailMid.y - d.uy * shaftHalfW };
            const tailR = { x: tailMid.x + d.ux * shaftHalfW, y: tailMid.y + d.uy * shaftHalfW };
            const labelDist = tipDist + totalLen + (Math.abs(d.outX) > Math.abs(d.outY) ? 14 : 7.5);
            const labelPos = { x: d.cx + d.outX * labelDist, y: d.cy + d.outY * labelDist };
            return {
                tip,
                headL,
                headR,
                neckL,
                neckR,
                tailL,
                tailR,
                tail: tailMid,
                baseL: headL,
                baseR: headR,
                labelPos,
                poly: [tip, headL, neckL, tailL, tailR, neckR, headR]
            };
        }

        let g_exteriorDimHitTargets = [];
        let g_lastDimPill = { w: 34, h: 18 };
        const DIM = { SPAN: 34, DEPTH: 30, INSET: 22, OUT: 22, EQUAL: 1.5, OVERLAP: 8 };

        function drawIsoTick(targetCtx, x, y, r = 3.8) {
            targetCtx.beginPath();
            targetCtx.moveTo(x - r, y - r);
            targetCtx.lineTo(x + r, y + r);
            targetCtx.stroke();
        }

        // 尺寸胶囊文字：沿尺寸线方向旋转 (斜墙跟随墙角度)，并规整到 [-90°, 90°) 保证文字不倒置
        function dimTextAngle(u, vertical) {
            if (!u) return vertical ? -Math.PI / 2 : 0;
            let a = Math.atan2(u.y, u.x);
            if (a >= Math.PI / 2 - 1e-6) a -= Math.PI;
            else if (a < -Math.PI / 2 - 1e-6) a += Math.PI;
            return a;
        }

        function drawIsoDimensionText(targetCtx, x, y, text, wallId, isHovered, isActive, vertical, invScale = 1.0, u = null) {
            targetCtx.save();
            targetCtx.translate(x, y);
            const textAngle = dimTextAngle(u, vertical);
            if (textAngle) targetCtx.rotate(textAngle);

            const fontPx = 10 * invScale;
            targetCtx.font = `500 ${fontPx}px ${CANVAS_FONT_MONO}`;
            const w = targetCtx.measureText(text).width + 10 * invScale;
            const h = 15 * invScale;

            // 技术制图风格尺寸文字：白底细边框中性色；选中墙体浅蓝，悬停/拖拽时强调蓝；随缩放自适应
            targetCtx.fillStyle = isHovered ? CANVAS_THEME.accentSoft : (isActive ? CANVAS_THEME.accentSubtle : CANVAS_THEME.dimPill);
            targetCtx.strokeStyle = isHovered ? CANVAS_THEME.accent : (isActive ? CANVAS_THEME.accentBorder : CANVAS_THEME.dimPillBorder);
            targetCtx.lineWidth = 1 * invScale;
            targetCtx.beginPath();
            targetCtx.roundRect(-w / 2, -h / 2, w, h, 2.5 * invScale);
            targetCtx.fill();
            targetCtx.stroke();

            targetCtx.fillStyle = (isHovered || isActive) ? CANVAS_THEME.accentDark : CANVAS_THEME.dimText;
            targetCtx.textAlign = 'center';
            targetCtx.textBaseline = 'middle';
            targetCtx.fillText(text, 0, 0);
            targetCtx.restore();

            g_lastDimPill = { x, y, w, h };
        }

        function drawOuterRingDimensionText(targetCtx, x, y, text, vertical, segSpanPx = 80) {
            targetCtx.save();
            targetCtx.translate(x, y);
            if (vertical) targetCtx.rotate(-Math.PI / 2);

            const maxAllowedFont = Math.max(8.5, (segSpanPx * 0.84) / Math.max(2.0, String(text).length * 0.62));
            const fontPx = Math.min(11.0, maxAllowedFont);
            targetCtx.font = `600 ${fontPx}px "Cascadia Mono", Consolas, Inter, "Noto Sans SC", sans-serif`;
            targetCtx.fillStyle = '#1e293b';
            targetCtx.textAlign = 'center';
            targetCtx.textBaseline = 'middle';
            targetCtx.fillText(text, 0, 0);
            targetCtx.restore();
        }

        function roomWalls(room) {
            const ids = room.vertexIds || [];
            const out = [];
            for (let i = 0; i < ids.length; i++) {
                const a = ids[i], b = ids[(i + 1) % ids.length];
                const w = STATE.walls.find(w =>
                    (w.v1 === a && w.v2 === b) || (w.v1 === b && w.v2 === a));
                if (w && out.indexOf(w) < 0) out.push(w);
            }
            return out;
        }

        function neighbourWallAt(P, wall, regionWalls) {
            for (const w of regionWalls) {
                if (w.id === wall.id) continue;
                if (w.v1 === P.id || w.v2 === P.id) return w;
            }
            return null;
        }

        function cornerMiterOffset(P, u, n, h, nb, ref) {
            const o1 = getVertex(nb.v1), o2 = getVertex(nb.v2);
            if (!o1 || !o2) return 0;
            const other = (o1.id === P.id) ? o2 : o1;
            const dx = other.x - P.x, dy = other.y - P.y;
            const l = Math.hypot(dx, dy);
            if (l < 0.001) return 0;
            const p = { x: dx / l, y: dy / l };
            const hN = (nb.thickness || 12) / 2;
            const mid = { x: (o1.x + o2.x) / 2, y: (o1.y + o2.y) / 2 };
            let m = { x: -p.y, y: p.x };
            if ((ref.x - mid.x) * m.x + (ref.y - mid.y) * m.y < 0) m = { x: -m.x, y: -m.y };
            const den = u.x * p.y - u.y * p.x;
            if (Math.abs(den) < 0.02) return 0;
            const rx = m.x * hN - n.x * h, ry = m.y * hN - n.y * h;
            const t = (rx * p.y - ry * p.x) / den;
            return isFinite(t) ? t : 0;
        }

        /**
         * 端点 P 处与 wall 相连的其它墙：取伸向 wall 的 n 侧（标注所在墙面一侧）的墙，
         * 求 wall 的 n 侧墙面线与该墙近侧墙面（朝 dir 一侧）的交点，返回沿 dir 的扣减量。
         * 用于未闭合墙、T 形墙等没有空间区域可参照的情况，保证标注为墙面净尺寸而非中心线尺寸。
         */
        function connectedFaceInset(P, wall, dir, n, h) {
            let best = 0;
            for (const w of STATE.walls) {
                if (w.id === wall.id || (w.v1 !== P.id && w.v2 !== P.id)) continue;
                const o1 = getVertex(w.v1), o2 = getVertex(w.v2);
                if (!o1 || !o2) continue;
                const other = o1.id === P.id ? o2 : o1;
                const l = Math.hypot(other.x - P.x, other.y - P.y);
                if (l < 0.001) continue;
                const p = { x: (other.x - P.x) / l, y: (other.y - P.y) / l };
                if (p.x * n.x + p.y * n.y < 0.05) continue;          // 不伸向本侧墙面（共线延长或在另一侧）
                const den = dir.x * p.y - dir.y * p.x;
                if (Math.abs(den) < 0.02) continue;
                let m = { x: -p.y, y: p.x };                          // 相连墙朝 dir 一侧的墙面
                if (m.x * dir.x + m.y * dir.y < 0) m = { x: -m.x, y: -m.y };
                const hN = (w.thickness || 12) / 2;
                const rx = m.x * hN - n.x * h, ry = m.y * hN - n.y * h;
                const t = (rx * p.y - ry * p.x) / den;
                if (isFinite(t) && t > best) best = t;
            }
            return best;
        }

        function wallInnerFace(wall, region, fallbackRef) {
            const v1 = getVertex(wall.v1), v2 = getVertex(wall.v2);
            if (!v1 || !v2) return null;
            const len = dist(v1, v2);
            if (len < 0.001) return null;
            const u = { x: (v2.x - v1.x) / len, y: (v2.y - v1.y) / len };
            const h = (wall.thickness || 12) / 2;
            const mid = { x: (v1.x + v2.x) / 2, y: (v1.y + v2.y) / 2 };
            const ref = (region && region.centroid) || fallbackRef || mid;

            let n = { x: -u.y, y: u.x };
            if ((ref.x - mid.x) * n.x + (ref.y - mid.y) * n.y < 0) n = { x: -n.x, y: -n.y };

            const insetAt = (P, dir) => {
                const nb = region ? neighbourWallAt(P, wall, region.walls) : null;
                if (nb) {
                    const t = cornerMiterOffset(P, dir, n, h, nb, ref);
                    return Math.min(Math.max(t, 0), len * 0.45);
                }
                // 无闭合空间（墙未闭合）或 T 形节点：按该端点上实际相连、伸向本侧墙面的墙体内皮计算净尺寸；
                // 自由端（无相连墙）不扣减
                return Math.min(Math.max(connectedFaceInset(P, wall, dir, n, h), 0), len * 0.45);
            };
            const t1 = insetAt(v1, { x: u.x, y: u.y });
            const t2 = insetAt(v2, { x: -u.x, y: -u.y });

            return {
                wall, len, u, n, h, v1, v2, t1, t2,
                innerLen: Math.max(0, len - t1 - t2),
                a: { x: v1.x + n.x * h + u.x * t1, y: v1.y + n.y * h + u.y * t1 },
                b: { x: v2.x + n.x * h - u.x * t2, y: v2.y + n.y * h - u.y * t2 }
            };
        }

        function overlapAlong(f1, f2) {
            const s = (p) => p.x * f1.u.x + p.y * f1.u.y;
            const a1 = s(f1.a), b1 = s(f1.b), a2 = s(f2.a), b2 = s(f2.b);
            const lo = Math.max(Math.min(a1, b1), Math.min(a2, b2));
            const hi = Math.min(Math.max(a1, b1), Math.max(a2, b2));
            return Math.max(0, hi - lo);
        }

        function faceGap(f1, f2) {
            const mx = (f2.v1.x + f2.v2.x) / 2 - (f1.v1.x + f1.v2.x) / 2;
            const my = (f2.v1.y + f2.v2.y) / 2 - (f1.v1.y + f1.v2.y) / 2;
            return Math.abs(mx * f1.n.x + my * f1.n.y) - f1.h - f2.h;
        }

        function findFacingPartner(face, region, faceOf) {
            let best = null, bestOverlap = 0;
            for (const w of region.walls) {
                if (w.id === face.wall.id) continue;
                const o = faceOf(w, region);
                if (!o) continue;
                if (Math.abs(face.u.x * o.u.y - face.u.y * o.u.x) > 0.02) continue;
                const mx = (o.v1.x + o.v2.x) / 2 - (face.v1.x + face.v2.x) / 2;
                const my = (o.v1.y + o.v2.y) / 2 - (face.v1.y + face.v2.y) / 2;
                if (mx * face.n.x + my * face.n.y <= 0) continue;
                if (mx * o.n.x + my * o.n.y >= 0) continue;
                const ov = overlapAlong(face, o);
                if (ov < DIM.OVERLAP) continue;
                if (ov > bestOverlap) { bestOverlap = ov; best = o; }
            }
            return best;
        }

        function pickCarrierFace(f1, f2) {
            const m1 = { x: (f1.a.x + f1.b.x) / 2, y: (f1.a.y + f1.b.y) / 2 };
            const m2 = { x: (f2.a.x + f2.b.x) / 2, y: (f2.a.y + f2.b.y) / 2 };
            if (Math.abs(m1.y - m2.y) > 1) return m1.y < m2.y ? f1 : f2;
            return m1.x <= m2.x ? f1 : f2;
        }

        function formatDimLabel(pxValue) {
            const meters = pxValue / SCALE_PIXELS_PER_METER;
            return Units.dim(meters * 1000);
        }

        function spanDimension(f, value, placement = 'outside', invScale = 1.0) {
            const n = f.n, u = f.u;
            const defaultK = placement === 'inside' ? (DIM.INSET * invScale) : -(2 * f.h + DIM.OUT * invScale);
            const k = typeof f.wall.dimOffset === 'number' ? f.wall.dimOffset : defaultK;
            const maxSlide = Math.max(0, f.innerLen * 0.42);
            const slide = Math.max(-maxSlide, Math.min(maxSlide, Number(f.wall.dimSlide) || 0));
            const p1 = { x: f.a.x + n.x * k, y: f.a.y + n.y * k };
            const p2 = { x: f.b.x + n.x * k, y: f.b.y + n.y * k };
            const extOver = (k >= 0 ? 4 : -4) * invScale;
            return {
                kind: 'span', wall: f.wall, value,
                u, n, k, slide,
                text: formatDimLabel(value),
                vertical: Math.abs(f.v2.x - f.v1.x) < Math.abs(f.v2.y - f.v1.y),
                e1a: f.a, e1b: { x: f.a.x + n.x * (k + extOver), y: f.a.y + n.y * (k + extOver) },
                e2a: f.b, e2b: { x: f.b.x + n.x * (k + extOver), y: f.b.y + n.y * (k + extOver) },
                p1, p2,
                tx: (p1.x + p2.x) / 2 + u.x * slide,
                ty: (p1.y + p2.y) / 2 + u.y * slide
            };
        }

        function wallDimension(f, invScale = 1.0) {
            const n = f.n, u = f.u;
            const defaultK = -(2 * f.h + DIM.OUT * invScale);
            const k = typeof f.wall.dimOffset === 'number' ? f.wall.dimOffset : defaultK;
            const maxSlide = Math.max(0, f.innerLen * 0.42);
            const slide = Math.max(-maxSlide, Math.min(maxSlide, Number(f.wall.dimSlide) || 0));
            const p1 = { x: f.a.x + n.x * k, y: f.a.y + n.y * k };
            const p2 = { x: f.b.x + n.x * k, y: f.b.y + n.y * k };
            const startOff = k < 0 ? -(2 * f.h + 2 * invScale) : 0;
            const endOff = k < 0 ? (k - 4 * invScale) : (k + 4 * invScale);
            return {
                kind: 'wall', wall: f.wall, value: f.innerLen,
                u, n, k, slide,
                text: formatDimLabel(f.innerLen),
                vertical: Math.abs(f.v2.x - f.v1.x) < Math.abs(f.v2.y - f.v1.y),
                e1a: { x: f.a.x + n.x * startOff, y: f.a.y + n.y * startOff },
                e1b: { x: f.a.x + n.x * endOff, y: f.a.y + n.y * endOff },
                e2a: { x: f.b.x + n.x * startOff, y: f.b.y + n.y * startOff },
                e2b: { x: f.b.x + n.x * endOff, y: f.b.y + n.y * endOff },
                p1, p2,
                tx: (p1.x + p2.x) / 2 + u.x * slide,
                ty: (p1.y + p2.y) / 2 + u.y * slide
            };
        }

        function globalRefPoint() {
            if (STATE.vertices.length === 0) return { x: 0, y: 0 };
            const b = pointsBounds(STATE.vertices);
            return { x: b.cx, y: b.cy };
        }

        function computeDimensionRegions() {
            const regions = [];
            const regionOf = new Map();
            for (const room of STATE.rooms) {
                const verts = getRoomPolygonVerts(room);
                const walls = roomWalls(room);
                if (verts.length < 3 || walls.length < 2) continue;
                const reg = {
                    index: regions.length,
                    room,
                    walls,
                    centroid: computePolygonCentroid(verts),
                    maxHalf: Math.max(...walls.map(w => (w.thickness || 12) / 2))
                };
                regions.push(reg);
                for (const w of walls) if (!regionOf.has(w.id)) regionOf.set(w.id, reg);
            }
            return { regions, regionOf };
        }

        // 主视图原有尺寸规划逻辑（保留原有样式，并支持传入 invScale 自适应缩放偏移量）
        function buildMainViewDimensionPlan(invScale = 1.0) {
            const plan = [];
            if (STATE.vertices.length < 2 || STATE.walls.length === 0) return plan;
            const { regions, regionOf } = computeDimensionRegions();
            const globalRef = globalRefPoint();
            const cache = new Map();
            const faceOf = (wall, region) => {
                const key = (region ? region.index : 'x') + ':' + wall.id;
                if (!cache.has(key)) cache.set(key, wallInnerFace(wall, region || null, globalRef));
                return cache.get(key);
            };

            const wallRoomCount = new Map();
            for (const reg of regions) {
                for (const w of reg.walls) {
                    wallRoomCount.set(w.id, (wallRoomCount.get(w.id) || 0) + 1);
                }
            }
            const isExteriorWall = (wall) => (wallRoomCount.get(wall.id) || 0) <= 1;
            const onlySelected = !STATE.showDimensions;

            const covered = new Set(), marked = new Set();
            for (const reg of regions) {
                for (const w of reg.walls) {
                    if (marked.has(w.id)) continue;
                    const f = faceOf(w, reg);
                    if (!f || f.innerLen < DIM.SPAN) continue;
                    const o = findFacingPartner(f, reg, faceOf);
                    if (!o) continue;
                    if (Math.abs(o.innerLen - f.innerLen) > DIM.EQUAL) continue;
                    if (faceGap(f, o) < DIM.DEPTH) continue;
                    const fExt = isExteriorWall(f.wall), oExt = isExteriorWall(o.wall);
                    let carrier, placement;
                    if (fExt !== oExt) {
                        carrier = fExt ? f : o;
                        placement = 'outside';
                    } else if (fExt) {
                        carrier = pickCarrierFace(f, o);
                        placement = 'outside';
                    } else {
                        carrier = pickCarrierFace(f, o);
                        placement = 'inside';
                    }
                    if (marked.has(carrier.wall.id)) continue;
                    // 户内尺寸线 (placement === 'inside') 默认隐藏，仅在选中对应墙体或正处于尺寸编辑时才显示
                    const pairSelected = isWallSelected(f.wall.id) || isWallSelected(o.wall.id) ||
                        STATE.editingWallId === f.wall.id || STATE.editingWallId === o.wall.id;
                    if (placement === 'inside' || onlySelected) {
                        const targetFace = (isWallSelected(o.wall.id) && !isWallSelected(f.wall.id)) ? o : carrier;
                        if (pairSelected) {
                            plan.push(spanDimension(targetFace, (f.innerLen + o.innerLen) / 2, placement, invScale));
                            marked.add(targetFace.wall.id);
                        }
                        covered.add(f.wall.id);
                        covered.add(o.wall.id);
                        continue;
                    }
                    plan.push(spanDimension(carrier, (f.innerLen + o.innerLen) / 2, placement, invScale));
                    marked.add(carrier.wall.id);
                    covered.add(f.wall.id);
                    covered.add(o.wall.id);
                }
            }

            for (const w of STATE.walls) {
                const isThisWallActive = isWallSelected(w.id) || STATE.editingWallId === w.id;
                if (covered.has(w.id)) {
                    // 若该墙虽已被对向尺寸覆盖，但当前用户明确选中了这面墙且它自身尚未画出尺寸线，则为其补画一条尺寸线方便直接在尺寸线上改长度
                    if (!isThisWallActive || marked.has(w.id)) continue;
                } else {
                    // 非外围墙（户内隔墙）默认隐藏尺寸线，仅在选中该墙时才显示
                    if ((!isExteriorWall(w) || onlySelected) && !isThisWallActive) continue;
                }
                const f = faceOf(w, regionOf.get(w.id) || null);
                if (!f || (f.innerLen < DIM.SPAN && !isThisWallActive) || f.innerLen < 6) continue;
                if (!isExteriorWall(w)) {
                    plan.push(spanDimension(f, f.innerLen, 'inside', invScale));
                } else {
                    plan.push(wallDimension(f, invScale));
                }
            }
            return plan;
        }

        function clusterAxisStops(vals, tol = 3.2) {
            if (!vals || vals.length === 0) return [];
            const sorted = vals.slice().sort((a, b) => a - b);
            const clusters = [[sorted[0]]];
            for (let i = 1; i < sorted.length; i++) {
                const prev = clusters[clusters.length - 1];
                if (Math.abs(sorted[i] - prev[prev.length - 1]) <= tol) {
                    prev.push(sorted[i]);
                } else {
                    clusters.push([sorted[i]]);
                }
            }
            return clusters.map(c => c.reduce((s, v) => s + v, 0) / c.length);
        }

        /*************************************************************************
         * 导出图纸专用：双层外圈建筑尺寸规划引擎 (内层：墙宽 + 内墙净尺寸；外层：外围总尺寸)
         * 仅用于导出 PDF / CAD DXF / DWG / 工程图纸 PNG，主视图保持原有青绿胶囊样式。
         *************************************************************************/
        /** 计算各侧外墙因向外开启门扇/圆弧越出包围盒所需的最小外推距离 */
        function computeOutwardDoorOffsets(bounds, wallIdSet = null, clearancePx = 14) {
            const extra = { left: 0, right: 0, top: 0, bottom: 0 };
            if (!bounds || !Number.isFinite(bounds.minX)) return extra;
            for (const op of (STATE.openings || [])) {
                if (!op || op.type !== 'door') continue;
                if (wallIdSet && !wallIdSet.has(op.wallId)) continue;
                const g = getOpeningSymbolGeometry(op);
                if (!g) continue;
                const pts = [];
                if (g.leaf) pts.push([g.leaf[0], g.leaf[1]], [g.leaf[2], g.leaf[3]]);
                for (const q of (g.arc || [])) pts.push(q);
                if (op.isEntryDoor) {
                    const arr = getEntryDoorArrowGeom(op);
                    if (arr) {
                        for (const pt of arr.poly) pts.push([pt.x, pt.y]);
                        if (arr.labelPos) pts.push([arr.labelPos.x, arr.labelPos.y]);
                    }
                }
                for (const [px, py] of pts) {
                    if (px < bounds.minX - 1) extra.left = Math.max(extra.left, (bounds.minX - px) + clearancePx);
                    if (px > bounds.maxX + 1) extra.right = Math.max(extra.right, (px - bounds.maxX) + clearancePx);
                    if (py < bounds.minY - 1) extra.top = Math.max(extra.top, (bounds.minY - py) + clearancePx);
                    if (py > bounds.maxY + 1) extra.bottom = Math.max(extra.bottom, (py - bounds.maxY) + clearancePx);
                }
            }
            return extra;
        }

        /**
         * 将某侧外圈尺寸中的一段墙体净跨 [c1, c2] 按该侧出现的门窗洞口拆分为 [墙垛 | 门/窗 | 墙垛] 细部尺寸，
         * 并确保各分段毫米之和与整段 spanMm 严格一致。
         */
        function splitSpanByOpenings(c1, c2, spanMm, openingsOnSide, fallbackWall = null) {
            if (!openingsOnSide || openingsOnSide.length === 0 || c2 - c1 < 3) {
                return { split: false, segs: [{ c1, c2, kind: 'inner-span', wall: fallbackWall, mmVal: spanMm }] };
            }
            const rawHits = [];
            for (const op of openingsOnSide) {
                const a = Math.max(c1, op.o1);
                const b = Math.min(c2, op.o2);
                if (b - a >= 2) rawHits.push({ a, b, type: op.type, wall: op.wall || fallbackWall });
            }
            if (rawHits.length === 0) {
                return { split: false, segs: [{ c1, c2, kind: 'inner-span', wall: fallbackWall, mmVal: spanMm }] };
            }
            rawHits.sort((p, q) => p.a - q.a);
            const hits = [];
            for (const h of rawHits) {
                const prev = hits[hits.length - 1];
                if (prev && h.a < prev.b - 0.5) continue;
                const a = prev ? Math.max(h.a, prev.b) : h.a;
                if (h.b - a >= 2) hits.push({ a, b: h.b, type: h.type, wall: h.wall });
            }
            if (hits.length === 0) {
                return { split: false, segs: [{ c1, c2, kind: 'inner-span', wall: fallbackWall, mmVal: spanMm }] };
            }
            const segs = [];
            let cursor = c1;
            for (const h of hits) {
                if (h.a - cursor >= 1.5) {
                    segs.push({
                        c1: cursor,
                        c2: h.a,
                        kind: 'wall-pier',
                        wall: h.wall || fallbackWall,
                        mmVal: Math.round(((h.a - cursor) / SCALE_PIXELS_PER_METER) * 1000)
                    });
                }
                const oa = Math.max(cursor, h.a);
                segs.push({
                    c1: oa,
                    c2: h.b,
                    kind: h.type === 'window' ? 'opening-window' : 'opening-door',
                    wall: h.wall || fallbackWall,
                    mmVal: Math.round(((h.b - oa) / SCALE_PIXELS_PER_METER) * 1000)
                });
                cursor = h.b;
            }
            if (c2 - cursor >= 1.5) {
                segs.push({
                    c1: cursor,
                    c2,
                    kind: 'wall-pier',
                    wall: fallbackWall,
                    mmVal: Math.round(((c2 - cursor) / SCALE_PIXELS_PER_METER) * 1000)
                });
            }
            const sumSub = segs.reduce((s, x) => s + x.mmVal, 0);
            const diff = spanMm - sumSub;
            if (diff !== 0 && segs.length > 0) {
                const piers = segs.filter(x => x.kind === 'wall-pier');
                const target = piers.length
                    ? piers.reduce((best, x) => (x.mmVal > best.mmVal ? x : best), piers[0])
                    : segs[segs.length - 1];
                if (target.mmVal + diff > 0) target.mmVal += diff;
            }
            return { split: true, segs };
        }

        function buildDimensionPlan(opts = {}) {
            const plan = [];
            if (STATE.vertices.length < 2 || STATE.walls.length === 0) return plan;

            const outDist = typeof opts.outDist === 'number' ? opts.outDist : 20;
            const tierStep = typeof opts.tierStep === 'number' ? opts.tierStep : 18;
            const tickLen = typeof opts.tickLen === 'number' ? opts.tickLen : 8.5;
            const wallIdSet = opts.wallIds || null;

            const { regionOf } = computeDimensionRegions();
            const globalRef = globalRefPoint();
            const cache = new Map();
            const faceOf = (wall) => {
                if (!cache.has(wall.id)) {
                    cache.set(wall.id, wallInnerFace(wall, regionOf.get(wall.id) || null, globalRef));
                }
                return cache.get(wall.id);
            };

            let bMinX = Infinity, bMaxX = -Infinity, bMinY = Infinity, bMaxY = -Infinity;
            const hWalls = [];
            const vWalls = [];
            const diagWalls = [];

            for (const w of STATE.walls) {
                if (wallIdSet && !wallIdSet.has(w.id)) continue;
                const v1 = getVertex(w.v1), v2 = getVertex(w.v2);
                if (!v1 || !v2) continue;
                const len = dist(v1, v2);
                if (len < 6) continue;
                const halfTh = (w.thickness || 12) * 0.5;
                bMinX = Math.min(bMinX, v1.x - halfTh, v2.x - halfTh);
                bMaxX = Math.max(bMaxX, v1.x + halfTh, v2.x + halfTh);
                bMinY = Math.min(bMinY, v1.y - halfTh, v2.y - halfTh);
                bMaxY = Math.max(bMaxY, v1.y + halfTh, v2.y + halfTh);

                const dx = Math.abs(v2.x - v1.x), dy = Math.abs(v2.y - v1.y);
                if (dx >= dy * 1.15) {
                    hWalls.push({
                        wall: w,
                        x1: Math.min(v1.x, v2.x),
                        x2: Math.max(v1.x, v2.x),
                        yMid: (v1.y + v2.y) * 0.5,
                        halfTh,
                        len
                    });
                } else if (dy >= dx * 1.15) {
                    vWalls.push({
                        wall: w,
                        y1: Math.min(v1.y, v2.y),
                        y2: Math.max(v1.y, v2.y),
                        xMid: (v1.x + v2.x) * 0.5,
                        halfTh,
                        len
                    });
                } else {
                    diagWalls.push(w);
                }
            }

            if (!Number.isFinite(bMinX)) return plan;

            const rawX = [];
            hWalls.forEach(hw => { rawX.push(hw.x1, hw.x2); });
            vWalls.forEach(vw => { rawX.push(vw.xMid); });
            const xStops = clusterAxisStops(rawX, 3.5);

            const rawY = [];
            vWalls.forEach(vw => { rawY.push(vw.y1, vw.y2); });
            hWalls.forEach(hw => { rawY.push(hw.yMid); });
            const yStops = clusterAxisStops(rawY, 3.5);

            // 收集某侧（上/下/左/右）最外围轮廓墙及与之相连的垂直/水平分界墙（取真实墙厚区间 [mid-halfTh, mid+halfTh]）
            const collectSideWallIntervals = (stops, alongWalls, crossWalls, isHoriz, pickMin) => {
                const sideAlongSet = new Set();
                for (let i = 0; i < stops.length - 1; i++) {
                    const c1 = stops[i], c2 = stops[i + 1];
                    if (c2 - c1 < 4) continue;
                    const mid = (c1 + c2) * 0.5;
                    const cands = alongWalls.filter(it =>
                        isHoriz ? (it.x1 <= mid + 2.5 && it.x2 >= mid - 2.5) : (it.y1 <= mid + 2.5 && it.y2 >= mid - 2.5)
                    );
                    if (!cands.length) continue;
                    cands.sort((a, b) => {
                        const ca = isHoriz ? a.yMid : a.xMid;
                        const cb = isHoriz ? b.yMid : b.xMid;
                        return pickMin ? (ca - cb) : (cb - ca);
                    });
                    sideAlongSet.add(cands[0]);
                }
                const sideAlong = Array.from(sideAlongSet);
                const sideVertexIds = new Set();
                for (const aw of sideAlong) {
                    sideVertexIds.add(aw.wall.v1);
                    sideVertexIds.add(aw.wall.v2);
                }

                const activeCross = crossWalls.filter(cw => {
                    if (sideVertexIds.has(cw.wall.v1) || sideVertexIds.has(cw.wall.v2)) return true;
                    const cPos = isHoriz ? cw.xMid : cw.yMid;
                    const cLo = (isHoriz ? cw.y1 : cw.x1) - cw.halfTh;
                    const cHi = (isHoriz ? cw.y2 : cw.x2) + cw.halfTh;
                    if (isHoriz) {
                        if (Math.abs((cw.xMid - cw.halfTh) - bMinX) <= 4 || Math.abs((cw.xMid + cw.halfTh) - bMaxX) <= 4) return true;
                    } else {
                        if (Math.abs((cw.yMid - cw.halfTh) - bMinY) <= 4 || Math.abs((cw.yMid + cw.halfTh) - bMaxY) <= 4) return true;
                    }
                    for (const aw of sideAlong) {
                        const aLo = (isHoriz ? aw.x1 : aw.y1) - aw.halfTh - 4;
                        const aHi = (isHoriz ? aw.x2 : aw.y2) + aw.halfTh + 4;
                        const aPos = isHoriz ? aw.yMid : aw.xMid;
                        const tol = aw.halfTh + cw.halfTh + 4.5;
                        if (cPos >= aLo && cPos <= aHi && aPos >= cLo - tol && aPos <= cHi + tol) return true;
                    }
                    return false;
                });

                if (activeCross.length === 0) return { wallIntervals: [], openings: [] };
                const sorted = activeCross.slice().sort((a, b) => (isHoriz ? a.xMid - b.xMid : a.yMid - b.yMid));
                const clusters = [[sorted[0]]];
                for (let i = 1; i < sorted.length; i++) {
                    const prev = clusters[clusters.length - 1];
                    const pMid = isHoriz ? prev[prev.length - 1].xMid : prev[prev.length - 1].yMid;
                    const cMid = isHoriz ? sorted[i].xMid : sorted[i].yMid;
                    if (Math.abs(cMid - pMid) <= 3.5) {
                        prev.push(sorted[i]);
                    } else {
                        clusters.push([sorted[i]]);
                    }
                }
                const mmPerPx = 1000 / SCALE_PIXELS_PER_METER;
                const snap = v => Math.round(v * mmPerPx) / mmPerPx;
                const wallIntervals = clusters.map(grp => {
                    const center = grp.reduce((s, it) => s + (isHoriz ? it.xMid : it.yMid), 0) / grp.length;
                    const halfTh = Math.max(...grp.map(it => it.halfTh));
                    return {
                        c1: snap(center - halfTh),
                        c2: snap(center + halfTh),
                        wall: grp[0].wall
                    };
                });

                // 收集该侧最外围墙体上的所有门窗洞口，用于在对应边上的外圈标注补出洞口尺寸
                const sideWallMap = new Map(sideAlong.map(aw => [aw.wall.id, aw]));
                const openings = [];
                for (const op of (STATE.openings || [])) {
                    if (op.type !== 'door' && op.type !== 'window') continue;
                    const aw = sideWallMap.get(op.wallId);
                    if (!aw) continue;
                    const v1 = getVertex(aw.wall.v1), v2 = getVertex(aw.wall.v2);
                    if (!v1 || !v2) continue;
                    const wLen = dist(v1, v2);
                    if (wLen < 1) continue;
                    const cx = v1.x + op.t * (v2.x - v1.x);
                    const cy = v1.y + op.t * (v2.y - v1.y);
                    const halfW = (op.width || 45) * 0.5;
                    const ux = (v2.x - v1.x) / wLen, uy = (v2.y - v1.y) / wLen;
                    const aCoord = isHoriz ? (cx - ux * halfW) : (cy - uy * halfW);
                    const bCoord = isHoriz ? (cx + ux * halfW) : (cy + uy * halfW);
                    const o1 = snap(Math.min(aCoord, bCoord));
                    const o2 = snap(Math.max(aCoord, bCoord));
                    const oMid = (o1 + o2) * 0.5;
                    // 仅当该墙体在洞口中心处确实是该侧最外围轮廓墙时纳入，避免凹口后方的内墙重叠投影
                    const candsAtMid = alongWalls.filter(it =>
                        isHoriz ? (it.x1 <= oMid + 2.5 && it.x2 >= oMid - 2.5) : (it.y1 <= oMid + 2.5 && it.y2 >= oMid - 2.5)
                    );
                    if (candsAtMid.length) {
                        candsAtMid.sort((a, b) => {
                            const ca = isHoriz ? a.yMid : a.xMid;
                            const cb = isHoriz ? b.yMid : b.xMid;
                            return pickMin ? (ca - cb) : (cb - ca);
                        });
                        const outerCoord = isHoriz ? candsAtMid[0].yMid : candsAtMid[0].xMid;
                        const curCoord = isHoriz ? aw.yMid : aw.xMid;
                        if (Math.abs(curCoord - outerCoord) > aw.halfTh + candsAtMid[0].halfTh + 4) continue;
                    }
                    openings.push({ o1, o2, type: op.type, wall: aw.wall });
                }
                openings.sort((a, b) => a.o1 - b.o1);
                return { wallIntervals, openings };
            };

            const doorExtra = computeOutwardDoorOffsets({ minX: bMinX, maxX: bMaxX, minY: bMinY, maxY: bMaxY }, wallIdSet, 14);
            const halfTick = tickLen * 0.55;
            const pushDimRecord = (c1, c2, side, tier, kind, wall, mmVal) => {
                const segSpan = Math.abs(c2 - c1);
                if (segSpan < 1.5) return;
                const value = (mmVal / 1000) * SCALE_PIXELS_PER_METER;
                const vertical = (side === 'left' || side === 'right');
                const u = vertical ? { x: 0, y: 1 } : { x: 1, y: 0 };
                const n = side === 'top'
                    ? { x: 0, y: -1 }
                    : (side === 'bottom' ? { x: 0, y: 1 } : (side === 'left' ? { x: -1, y: 0 } : { x: 1, y: 0 }));
                const baseOut = Math.max(outDist, doorExtra[side] || 0);
                const distFromBound = baseOut + (tier - 1) * tierStep;

                let p1, p2, e1a, e1b, e2a, e2b, tx, ty;
                if (side === 'top') {
                    const lineY = bMinY - distFromBound;
                    p1 = { x: c1, y: lineY }; p2 = { x: c2, y: lineY };
                    e1a = { x: c1, y: lineY - halfTick }; e1b = { x: c1, y: lineY + halfTick };
                    e2a = { x: c2, y: lineY - halfTick }; e2b = { x: c2, y: lineY + halfTick };
                    tx = (c1 + c2) * 0.5; ty = lineY - tickLen * 0.65;
                } else if (side === 'bottom') {
                    const lineY = bMaxY + distFromBound;
                    p1 = { x: c1, y: lineY }; p2 = { x: c2, y: lineY };
                    e1a = { x: c1, y: lineY - halfTick }; e1b = { x: c1, y: lineY + halfTick };
                    e2a = { x: c2, y: lineY - halfTick }; e2b = { x: c2, y: lineY + halfTick };
                    tx = (c1 + c2) * 0.5; ty = lineY - tickLen * 0.65;
                } else if (side === 'left') {
                    const lineX = bMinX - distFromBound;
                    p1 = { x: lineX, y: c1 }; p2 = { x: lineX, y: c2 };
                    e1a = { x: lineX - halfTick, y: c1 }; e1b = { x: lineX + halfTick, y: c1 };
                    e2a = { x: lineX - halfTick, y: c2 }; e2b = { x: lineX + halfTick, y: c2 };
                    tx = lineX - tickLen * 0.65; ty = (c1 + c2) * 0.5;
                } else {
                    const lineX = bMaxX + distFromBound;
                    p1 = { x: lineX, y: c1 }; p2 = { x: lineX, y: c2 };
                    e1a = { x: lineX - halfTick, y: c1 }; e1b = { x: lineX + halfTick, y: c1 };
                    e2a = { x: lineX - halfTick, y: c2 }; e2b = { x: lineX + halfTick, y: c2 };
                    tx = lineX - tickLen * 0.65; ty = (c1 + c2) * 0.5;
                }

                plan.push({
                    id: `${side}:t${tier}:${kind}:${Math.round(c1)}`,
                    side,
                    tier,
                    kind,
                    wall,
                    value,
                    mmVal,
                    segSpan,
                    u,
                    n,
                    k: -distFromBound,
                    slide: 0,
                    text: Units.dim(mmVal),
                    vertical,
                    e1a, e1b, e2a, e2b, p1, p2, tx, ty
                });
            };

            const emitSideTwoTier = (sideData, side) => {
                const wallIntervals = sideData && sideData.wallIntervals;
                const sideOpenings = (sideData && sideData.openings) || [];
                if (!wallIntervals || wallIntervals.length < 2) return;
                const detailTier = [];
                let sumMm = 0;
                for (let i = 0; i < wallIntervals.length; i++) {
                    const wi = wallIntervals[i];
                    const thMm = Math.round(((wi.c2 - wi.c1) / SCALE_PIXELS_PER_METER) * 1000);
                    sumMm += thMm;
                    detailTier.push({ c1: wi.c1, c2: wi.c2, kind: 'wall-th', wall: wi.wall, mmVal: thMm });
                    if (i < wallIntervals.length - 1) {
                        const nxt = wallIntervals[i + 1];
                        if (nxt.c1 - wi.c2 >= 3) {
                            const spanMm = Math.round(((nxt.c1 - wi.c2) / SCALE_PIXELS_PER_METER) * 1000);
                            sumMm += spanMm;
                            const res = splitSpanByOpenings(wi.c2, nxt.c1, spanMm, sideOpenings, wi.wall);
                            for (const sub of res.segs) detailTier.push(sub);
                        }
                    }
                }
                const cMin = detailTier[0].c1;
                const cMax = detailTier[detailTier.length - 1].c2;
                // 双层标注：内道展示结构分段（墙厚 / 墙垛 / 门窗洞口），外道展示外围总尺寸
                for (const seg of detailTier) pushDimRecord(seg.c1, seg.c2, side, 1, seg.kind, seg.wall, seg.mmVal);
                pushDimRecord(cMin, cMax, side, 2, 'outer-total', detailTier[0].wall, sumMm);
            };

            emitSideTwoTier(collectSideWallIntervals(xStops, hWalls, vWalls, true, true), 'top');
            if (hWalls.length > 1) {
                emitSideTwoTier(collectSideWallIntervals(xStops, hWalls, vWalls, true, false), 'bottom');
            }
            emitSideTwoTier(collectSideWallIntervals(yStops, vWalls, hWalls, false, true), 'left');
            if (vWalls.length > 1) {
                emitSideTwoTier(collectSideWallIntervals(yStops, vWalls, hWalls, false, false), 'right');
            }

            for (const dw of diagWalls) {
                const f = faceOf(dw);
                if (!f || f.innerLen < 12) continue;
                const k = -(f.h + outDist * 0.75);
                const p1 = { x: f.a.x + f.n.x * k, y: f.a.y + f.n.y * k };
                const p2 = { x: f.b.x + f.n.x * k, y: f.b.y + f.n.y * k };
                const mmVal = Math.round((f.innerLen / SCALE_PIXELS_PER_METER) * 1000);
                plan.push({
                    id: `diag:${dw.id}`,
                    side: 'diag',
                    tier: 1,
                    kind: 'inner-span',
                    wall: dw,
                    value: f.innerLen,
                    mmVal,
                    segSpan: f.innerLen,
                    u: f.u,
                    n: f.n,
                    k,
                    slide: 0,
                    text: Units.dim(mmVal),
                    vertical: Math.abs(f.v2.x - f.v1.x) < Math.abs(f.v2.y - f.v1.y),
                    e1a: { x: p1.x - f.n.x * halfTick, y: p1.y - f.n.y * halfTick },
                    e1b: { x: p1.x + f.n.x * halfTick, y: p1.y + f.n.y * halfTick },
                    e2a: { x: p2.x - f.n.x * halfTick, y: p2.y - f.n.y * halfTick },
                    e2b: { x: p2.x + f.n.x * halfTick, y: p2.y + f.n.y * halfTick },
                    p1,
                    p2,
                    tx: (p1.x + p2.x) * 0.5 - f.n.x * (tickLen * 0.65),
                    ty: (p1.y + p2.y) * 0.5 - f.n.y * (tickLen * 0.65)
                });
            }

            return plan;
        }

        // 单空间独立详图专用的四侧双层尺寸规划（内层：墙宽 + 内墙净尺寸分段；外层：外围总尺寸）
        function buildRoomOuterDimensionPlan(room, outDist = 16, tickLen = 7.5, tierStep = 14) {
            const verts = getRoomInnerWallVerts(room);
            if (!verts || verts.length < 3) return [];
            let rMinX = Infinity, rMaxX = -Infinity, rMinY = Infinity, rMaxY = -Infinity;
            const hEdges = [], vEdges = [], diagEdges = [];
            for (let i = 0; i < verts.length; i++) {
                const a = verts[i], b = verts[(i + 1) % verts.length];
                rMinX = Math.min(rMinX, a.x, b.x);
                rMaxX = Math.max(rMaxX, a.x, b.x);
                rMinY = Math.min(rMinY, a.y, b.y);
                rMaxY = Math.max(rMaxY, a.y, b.y);
                const len = Math.hypot(b.x - a.x, b.y - a.y);
                if (len < 6) continue;
                const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y);
                if (dx >= dy * 1.15) {
                    hEdges.push({ id: `eh_${i}`, x1: Math.min(a.x, b.x), x2: Math.max(a.x, b.x), yMid: (a.y + b.y) * 0.5 });
                } else if (dy >= dx * 1.15) {
                    vEdges.push({ id: `ev_${i}`, y1: Math.min(a.y, b.y), y2: Math.max(a.y, b.y), xMid: (a.x + b.x) * 0.5 });
                } else {
                    diagEdges.push({ a, b, len });
                }
            }

            // 查找该空间四侧外围墙体的真实墙厚（像素）
            const roomWallIds = getRoomWallIdSet(room);
            let leftTh = 12, rightTh = 12, topTh = 12, botTh = 12;
            for (const w of STATE.walls) {
                if (!roomWallIds.has(w.id)) continue;
                const v1 = getVertex(w.v1), v2 = getVertex(w.v2);
                if (!v1 || !v2) continue;
                const th = w.thickness || 12;
                const dx = Math.abs(v2.x - v1.x), dy = Math.abs(v2.y - v1.y);
                if (dy > dx) {
                    const xm = (v1.x + v2.x) * 0.5;
                    if (Math.abs(xm - rMinX) <= th + 4) leftTh = th;
                    if (Math.abs(xm - rMaxX) <= th + 4) rightTh = th;
                } else {
                    const ym = (v1.y + v2.y) * 0.5;
                    if (Math.abs(ym - rMinY) <= th + 4) topTh = th;
                    if (Math.abs(ym - rMaxY) <= th + 4) botTh = th;
                }
            }

            const mmPerPx = 1000 / SCALE_PIXELS_PER_METER;
            const snapMm = v => Math.round(v * mmPerPx) / mmPerPx;
            rMinX = snapMm(rMinX); rMaxX = snapMm(rMaxX);
            rMinY = snapMm(rMinY); rMaxY = snapMm(rMaxY);
            leftTh = snapMm(leftTh); rightTh = snapMm(rightTh);
            topTh = snapMm(topTh); botTh = snapMm(botTh);

            const oMinX = rMinX - leftTh, oMaxX = rMaxX + rightTh;
            const oMinY = rMinY - topTh, oMaxY = rMaxY + botTh;

            const xStops = clusterAxisStops([rMinX, rMaxX, ...hEdges.flatMap(e => [e.x1, e.x2]), ...vEdges.map(e => e.xMid)], 2.5).map(snapMm);
            const yStops = clusterAxisStops([rMinY, rMaxY, ...vEdges.flatMap(e => [e.y1, e.y2]), ...hEdges.map(e => e.yMid)], 2.5).map(snapMm);

            const buildInnerSideSegs = (stops, edges, isH, pickMin, boundLo, boundHi) => {
                const raw = [];
                for (let i = 0; i < stops.length - 1; i++) {
                    const c1 = stops[i], c2 = stops[i + 1];
                    if (c2 - c1 < 4) continue;
                    const mid = (c1 + c2) * 0.5;
                    const cands = edges.filter(e => isH ? (e.x1 <= mid + 2.5 && e.x2 >= mid - 2.5) : (e.y1 <= mid + 2.5 && e.y2 >= mid - 2.5));
                    if (!cands.length) {
                        raw.push({ c1, c2, edgeId: `span_${i}` });
                        continue;
                    }
                    cands.sort((a, b) => {
                        const ca = isH ? a.yMid : a.xMid;
                        const cb = isH ? b.yMid : b.xMid;
                        return pickMin ? (ca - cb) : (cb - ca);
                    });
                    raw.push({ c1, c2, edgeId: cands[0].id });
                }
                const merged = [];
                for (const seg of raw) {
                    const prev = merged[merged.length - 1];
                    if (prev && prev.edgeId === seg.edgeId && Math.abs(prev.c2 - seg.c1) <= 2.5) {
                        prev.c2 = seg.c2;
                    } else {
                        merged.push({ ...seg });
                    }
                }
                if (merged.length === 0 && boundHi - boundLo >= 4) {
                    return [{ c1: boundLo, c2: boundHi, edgeId: 'full' }];
                }
                return merged;
            };

            const doorExtra = computeOutwardDoorOffsets({ minX: oMinX, maxX: oMaxX, minY: oMinY, maxY: oMaxY }, roomWallIds, 14);
            const out = [];
            const halfTick = tickLen * 0.55;
            const pushSeg = (c1, c2, side, tier, kind, mmVal) => {
                const valPx = Math.abs(c2 - c1);
                if (valPx < 1.5) return;
                const vertical = (side === 'left' || side === 'right');
                const baseOut = Math.max(outDist, doorExtra[side] || 0);
                const d = baseOut + (tier - 1) * tierStep;
                let p1, p2, e1a, e1b, e2a, e2b, tx, ty;
                if (side === 'top') {
                    const ly = oMinY - d;
                    p1 = { x: c1, y: ly }; p2 = { x: c2, y: ly };
                    e1a = { x: c1, y: ly - halfTick }; e1b = { x: c1, y: ly + halfTick };
                    e2a = { x: c2, y: ly - halfTick }; e2b = { x: c2, y: ly + halfTick };
                    tx = (c1 + c2) * 0.5; ty = ly - tickLen * 0.65;
                } else if (side === 'bottom') {
                    const ly = oMaxY + d;
                    p1 = { x: c1, y: ly }; p2 = { x: c2, y: ly };
                    e1a = { x: c1, y: ly - halfTick }; e1b = { x: c1, y: ly + halfTick };
                    e2a = { x: c2, y: ly - halfTick }; e2b = { x: c2, y: ly + halfTick };
                    tx = (c1 + c2) * 0.5; ty = ly - tickLen * 0.65;
                } else if (side === 'left') {
                    const lx = oMinX - d;
                    p1 = { x: lx, y: c1 }; p2 = { x: lx, y: c2 };
                    e1a = { x: lx - halfTick, y: c1 }; e1b = { x: lx + halfTick, y: c1 };
                    e2a = { x: lx - halfTick, y: c2 }; e2b = { x: lx + halfTick, y: c2 };
                    tx = lx - tickLen * 0.65; ty = (c1 + c2) * 0.5;
                } else {
                    const lx = oMaxX + d;
                    p1 = { x: lx, y: c1 }; p2 = { x: lx, y: c2 };
                    e1a = { x: lx - halfTick, y: c1 }; e1b = { x: lx + halfTick, y: c1 };
                    e2a = { x: lx - halfTick, y: c2 }; e2b = { x: lx + halfTick, y: c2 };
                    tx = lx - tickLen * 0.65; ty = (c1 + c2) * 0.5;
                }
                out.push({ side, tier, kind, vertical, value: valPx, mmVal, text: String(mmVal), p1, p2, e1a, e1b, e2a, e2b, tx, ty });
            };

            const emitRoomSide = (innerSegs, side, startTh, endTh, boundLo, boundHi, sideOpenings = []) => {
                if (!innerSegs || innerSegs.length === 0) return;
                const detailTier = [];
                const startMm = Math.round((startTh / SCALE_PIXELS_PER_METER) * 1000);
                const endMm = Math.round((endTh / SCALE_PIXELS_PER_METER) * 1000);
                let totalMm = startMm + endMm;
                detailTier.push({ c1: boundLo - startTh, c2: boundLo, kind: 'wall-th', mmVal: startMm });
                for (const s of innerSegs) {
                    const mm = Math.round(((s.c2 - s.c1) / SCALE_PIXELS_PER_METER) * 1000);
                    totalMm += mm;
                    const res = splitSpanByOpenings(s.c1, s.c2, mm, sideOpenings, null);
                    for (const sub of res.segs) detailTier.push(sub);
                }
                detailTier.push({ c1: boundHi, c2: boundHi + endTh, kind: 'wall-th', mmVal: endMm });

                // 双层标注：内道展示结构分段（墙厚 / 墙垛 / 门窗洞口），外道展示外围总尺寸
                for (const seg of detailTier) pushSeg(seg.c1, seg.c2, side, 1, seg.kind, seg.mmVal);
                pushSeg(boundLo - startTh, boundHi + endTh, side, 2, 'outer-total', totalMm);
            };

            // 按空间围合墙体收集四侧边上各自出现的门窗洞口
            const roomSideOpenings = { top: [], bottom: [], left: [], right: [] };
            for (const op of (STATE.openings || [])) {
                if (op.type !== 'door' && op.type !== 'window') continue;
                if (!roomWallIds.has(op.wallId)) continue;
                const w = getWall(op.wallId);
                if (!w) continue;
                const v1 = getVertex(w.v1), v2 = getVertex(w.v2);
                if (!v1 || !v2) continue;
                const wLen = dist(v1, v2);
                if (wLen < 1) continue;
                const dx = Math.abs(v2.x - v1.x), dy = Math.abs(v2.y - v1.y);
                const th = w.thickness || 12;
                const cx = v1.x + op.t * (v2.x - v1.x);
                const cy = v1.y + op.t * (v2.y - v1.y);
                const halfW = (op.width || 45) * 0.5;
                const ux = (v2.x - v1.x) / wLen, uy = (v2.y - v1.y) / wLen;
                if (dx >= dy * 1.15) {
                    const belowIn = isPointInPolygon({ x: cx, y: cy + th * 0.5 + 4 }, verts);
                    const aboveIn = isPointInPolygon({ x: cx, y: cy - th * 0.5 - 4 }, verts);
                    const side = (belowIn && !aboveIn)
                        ? 'top'
                        : ((aboveIn && !belowIn) ? 'bottom' : (Math.abs(cy - rMinY) <= Math.abs(cy - rMaxY) ? 'top' : 'bottom'));
                    const o1 = snapMm(Math.min(cx - ux * halfW, cx + ux * halfW));
                    const o2 = snapMm(Math.max(cx - ux * halfW, cx + ux * halfW));
                    roomSideOpenings[side].push({ o1, o2, type: op.type, wall: w });
                } else if (dy >= dx * 1.15) {
                    const rightIn = isPointInPolygon({ x: cx + th * 0.5 + 4, y: cy }, verts);
                    const leftIn = isPointInPolygon({ x: cx - th * 0.5 - 4, y: cy }, verts);
                    const side = (rightIn && !leftIn)
                        ? 'left'
                        : ((leftIn && !rightIn) ? 'right' : (Math.abs(cx - rMinX) <= Math.abs(cx - rMaxX) ? 'left' : 'right'));
                    const o1 = snapMm(Math.min(cy - uy * halfW, cy + uy * halfW));
                    const o2 = snapMm(Math.max(cy - uy * halfW, cy + uy * halfW));
                    roomSideOpenings[side].push({ o1, o2, type: op.type, wall: w });
                }
            }
            for (const k of ['top', 'bottom', 'left', 'right']) {
                roomSideOpenings[k].sort((a, b) => a.o1 - b.o1);
            }

            emitRoomSide(buildInnerSideSegs(xStops, hEdges, true, true, rMinX, rMaxX), 'top', leftTh, rightTh, rMinX, rMaxX, roomSideOpenings.top);
            emitRoomSide(buildInnerSideSegs(xStops, hEdges, true, false, rMinX, rMaxX), 'bottom', leftTh, rightTh, rMinX, rMaxX, roomSideOpenings.bottom);
            emitRoomSide(buildInnerSideSegs(yStops, vEdges, false, true, rMinY, rMaxY), 'left', topTh, botTh, rMinY, rMaxY, roomSideOpenings.left);
            emitRoomSide(buildInnerSideSegs(yStops, vEdges, false, false, rMinY, rMaxY), 'right', topTh, botTh, rMinY, rMaxY, roomSideOpenings.right);

            if (diagEdges.length > 0) {
                const rCentroid = computePolygonCentroid(verts);
                for (const de of diagEdges) {
                    const ux = (de.b.x - de.a.x) / de.len, uy = (de.b.y - de.a.y) / de.len;
                    let nx = -uy, ny = ux;
                    const mx = (de.a.x + de.b.x) * 0.5, my = (de.a.y + de.b.y) * 0.5;
                    if ((rCentroid.x - mx) * nx + (rCentroid.y - my) * ny > 0) { nx = -nx; ny = -ny; }
                    const off = 10;
                    const p1 = { x: de.a.x + nx * off, y: de.a.y + ny * off };
                    const p2 = { x: de.b.x + nx * off, y: de.b.y + ny * off };
                    const mmVal = Math.round((de.len / SCALE_PIXELS_PER_METER) * 1000);
                    out.push({
                        side: 'diag', tier: 1, kind: 'inner-span',
                        vertical: Math.abs(de.b.x - de.a.x) < Math.abs(de.b.y - de.a.y),
                        value: de.len, mmVal, text: String(mmVal),
                        p1, p2,
                        e1a: { x: p1.x - nx * halfTick, y: p1.y - ny * halfTick },
                        e1b: { x: p1.x + nx * halfTick, y: p1.y + ny * halfTick },
                        e2a: { x: p2.x - nx * halfTick, y: p2.y - ny * halfTick },
                        e2b: { x: p2.x + nx * halfTick, y: p2.y + ny * halfTick },
                        tx: (p1.x + p2.x) * 0.5 + nx * (tickLen * 0.65),
                        ty: (p1.y + p2.y) * 0.5 + ny * (tickLen * 0.65)
                    });
                }
            }

            return out;
        }

        function renderArchitecturalDimensions(targetCtx = ctx) {
            if (targetCtx === ctx) g_exteriorDimHitTargets = [];
            if (STATE.vertices.length < 2 || STATE.walls.length === 0) return;

            const isMainView = (targetCtx === ctx);

            if (!isMainView) {
                // 导出图纸 (A4 PNG 等非主视图上下文)：采用最外圈四侧标尺分段标记风格
                const exportPlan = buildDimensionPlan({ outDist: 28, tickLen: 11.0 });
                targetCtx.save();
                targetCtx.lineCap = 'square';
                targetCtx.lineJoin = 'miter';
                for (const item of exportPlan) {
                    targetCtx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
                    targetCtx.lineWidth = 2.6;
                    targetCtx.beginPath();
                    targetCtx.moveTo(item.e1a.x, item.e1a.y); targetCtx.lineTo(item.e1b.x, item.e1b.y);
                    targetCtx.moveTo(item.e2a.x, item.e2a.y); targetCtx.lineTo(item.e2b.x, item.e2b.y);
                    targetCtx.moveTo(item.p1.x, item.p1.y); targetCtx.lineTo(item.p2.x, item.p2.y);
                    targetCtx.stroke();

                    targetCtx.strokeStyle = '#334155';
                    targetCtx.lineWidth = 1.15;
                    targetCtx.beginPath();
                    targetCtx.moveTo(item.e1a.x, item.e1a.y); targetCtx.lineTo(item.e1b.x, item.e1b.y);
                    targetCtx.moveTo(item.e2a.x, item.e2a.y); targetCtx.lineTo(item.e2b.x, item.e2b.y);
                    targetCtx.moveTo(item.p1.x, item.p1.y); targetCtx.lineTo(item.p2.x, item.p2.y);
                    targetCtx.stroke();

                    drawOuterRingDimensionText(
                        targetCtx,
                        item.tx,
                        item.ty,
                        item.text,
                        item.vertical,
                        item.segSpan || item.value
                    );
                }
                targetCtx.restore();
                return;
            }

            // 主视图 (targetCtx === ctx)：还原原有的青绿胶囊与45°刻度线样式，并随画布缩放自适应大小
            const curScale = Math.max(0.25, Math.min(8.0, STATE.scale || 1));
            const invScale = 1 / curScale;
            const plan = buildMainViewDimensionPlan(invScale);

            targetCtx.save();
            for (const item of plan) {
                const isHovered = STATE.hoveredDimension === (item.id || item.wall.id) ||
                    (STATE.dragTarget?.type === 'dimension' && STATE.dragTarget.wallId === item.wall.id);
                const isActive = isWallSelected(item.wall.id);

                // 底层白色描边光晕，防止尺寸线与底层砖缝视觉交织（随缩放自适应）
                targetCtx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
                targetCtx.lineWidth = 2.6 * invScale;
                targetCtx.beginPath();
                targetCtx.moveTo(item.e1a.x, item.e1a.y); targetCtx.lineTo(item.e1b.x, item.e1b.y);
                targetCtx.moveTo(item.e2a.x, item.e2a.y); targetCtx.lineTo(item.e2b.x, item.e2b.y);
                targetCtx.moveTo(item.p1.x, item.p1.y); targetCtx.lineTo(item.p2.x, item.p2.y);
                targetCtx.stroke();

                // 中性 slate 工程标注线色（#94a3b8），选中墙体为浅蓝，悬停/拖拽时高亮为宝蓝（#356AE6）
                targetCtx.strokeStyle = isHovered ? CANVAS_THEME.accent : (isActive ? 'rgba(53, 106, 230, 0.55)' : CANVAS_THEME.dimLine);
                targetCtx.lineWidth = (isHovered ? 1.4 : 1) * invScale;

                targetCtx.beginPath();
                targetCtx.moveTo(item.e1a.x, item.e1a.y); targetCtx.lineTo(item.e1b.x, item.e1b.y);
                targetCtx.moveTo(item.e2a.x, item.e2a.y); targetCtx.lineTo(item.e2b.x, item.e2b.y);
                targetCtx.stroke();

                targetCtx.beginPath();
                targetCtx.moveTo(item.p1.x, item.p1.y); targetCtx.lineTo(item.p2.x, item.p2.y);
                targetCtx.stroke();

                targetCtx.lineWidth = (isHovered ? 1.6 : 1.25) * invScale;
                drawIsoTick(targetCtx, item.p1.x, item.p1.y, 3.4 * invScale);
                drawIsoTick(targetCtx, item.p2.x, item.p2.y, 3.4 * invScale);

                drawIsoDimensionText(targetCtx, item.tx, item.ty, item.text, item.wall.id, isHovered, isActive, item.vertical, invScale, item.u);
                const hitAng = dimTextAngle(item.u, item.vertical);
                const hitC = Math.abs(Math.cos(hitAng)), hitS = Math.abs(Math.sin(hitAng));
                g_exteriorDimHitTargets.push({
                    id: item.wall.id,
                    wall: item.wall, kind: item.kind, vertical: item.vertical,
                    x: item.tx, y: item.ty,
                    p1: item.p1, p2: item.p2,
                    u: item.u, n: item.n,
                    curK: item.k, curSlide: item.slide,
                    halfW: (g_lastDimPill.w * hitC + g_lastDimPill.h * hitS) / 2,
                    halfH: (g_lastDimPill.w * hitS + g_lastDimPill.h * hitC) / 2,
                    clearPx: item.value
                });
            }
            targetCtx.restore();
        }

        // 当选中门/窗（或正在拖拽调整门窗）时，在门窗边上绘制三段式精准定位尺寸标注线（支持随缩放自适应大小）：
        // [端1距 d1] —— [门/窗宽 w] —— [端2距 d2]，点击任意尺寸胶囊即可直接输入数值精准修改距离或宽度！
        function renderSelectedOpeningDimensions(targetCtx = ctx) {
            if (targetCtx !== ctx) return;
            let activeOp = null;
            if (STATE.selected?.type === 'opening') {
                activeOp = STATE.openings.find(o => o.id === STATE.selected.id);
            } else if (STATE.isDragging && (STATE.dragTarget?.type === 'opening' || STATE.dragTarget?.type === 'opening-endpoint')) {
                activeOp = STATE.openings.find(o => o.id === STATE.dragTarget.id);
            }
            if (!activeOp) return;

            const wall = getWall(activeOp.wallId);
            if (!wall) return;
            const v1 = getVertex(wall.v1), v2 = getVertex(wall.v2);
            if (!v1 || !v2) return;
            const wallLen = dist(v1, v2);
            if (wallLen < 12) return;

            const curScale = Math.max(0.25, Math.min(8.0, STATE.scale || 1));
            const invScale = 1 / curScale;

            const ux = (v2.x - v1.x) / wallLen, uy = (v2.y - v1.y) / wallLen;
            let nx = -uy, ny = ux;
            const globalRef = globalRefPoint();
            const midWall = { x: (v1.x + v2.x) * 0.5, y: (v1.y + v2.y) * 0.5 };
            if ((midWall.x - globalRef.x) * nx + (midWall.y - globalRef.y) * ny < 0) {
                nx = -nx; ny = -ny;
            }

            const wallHalf = (wall.thickness || 12) / 2;
            const offsetDist = typeof activeOp.dimOffset === 'number' ? activeOp.dimOffset : (wallHalf + 20 * invScale);
            const widthPx = Math.min(wallLen, Math.max(10, activeOp.width || 45));
            const halfW = widthPx / 2;

            const cx = v1.x + activeOp.t * (v2.x - v1.x);
            const cy = v1.y + activeOp.t * (v2.y - v1.y);
            const opStart = { x: cx - ux * halfW, y: cy - uy * halfW };
            const opEnd = { x: cx + ux * halfW, y: cy + uy * halfW };

            const d1Px = Math.max(0, dist(v1, opStart));
            const d2Px = Math.max(0, dist(opEnd, v2));
            const vertical = Math.abs(v2.x - v1.x) < Math.abs(v2.y - v1.y);

            const segments = [
                { subKind: 'opening-d1', a: v1, b: opStart, valPx: d1Px, prefix: '距起点', color: CANVAS_THEME.accent, bg: CANVAS_THEME.accentSubtle },
                { subKind: 'opening-width', a: opStart, b: opEnd, valPx: widthPx, prefix: activeOp.type === 'window' ? '窗宽' : '门宽', color: CANVAS_THEME.dimText, bg: '#ffffff' },
                { subKind: 'opening-d2', a: opEnd, b: v2, valPx: d2Px, prefix: '距终点', color: CANVAS_THEME.accent, bg: CANVAS_THEME.accentSubtle }
            ];

            targetCtx.save();
            for (const seg of segments) {
                if (seg.valPx < 1.5) continue;
                const hitId = `${activeOp.id}:${seg.subKind}`;
                const isHovered = STATE.hoveredDimension === hitId;
                const isEditingThis = STATE.editingOpeningDim &&
                    STATE.editingOpeningDim.openingId === activeOp.id &&
                    STATE.editingOpeningDim.subKind === seg.subKind;

                const sgn = offsetDist >= 0 ? 1 : -1;
                const startExt = sgn * (wallHalf + 2 * invScale);
                const endExt = offsetDist + sgn * 4 * invScale;
                const e1a = { x: seg.a.x + nx * startExt, y: seg.a.y + ny * startExt };
                const e1b = { x: seg.a.x + nx * endExt, y: seg.a.y + ny * endExt };
                const e2a = { x: seg.b.x + nx * startExt, y: seg.b.y + ny * startExt };
                const e2b = { x: seg.b.x + nx * endExt, y: seg.b.y + ny * endExt };
                const p1 = { x: seg.a.x + nx * offsetDist, y: seg.a.y + ny * offsetDist };
                const p2 = { x: seg.b.x + nx * offsetDist, y: seg.b.y + ny * offsetDist };
                const tx = (p1.x + p2.x) * 0.5;
                const ty = (p1.y + p2.y) * 0.5;

                // 白色衬底防干扰（自适应缩放）
                targetCtx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
                targetCtx.lineWidth = 3.2 * invScale;
                targetCtx.beginPath();
                targetCtx.moveTo(e1a.x, e1a.y); targetCtx.lineTo(e1b.x, e1b.y);
                targetCtx.moveTo(e2a.x, e2a.y); targetCtx.lineTo(e2b.x, e2b.y);
                targetCtx.moveTo(p1.x, p1.y); targetCtx.lineTo(p2.x, p2.y);
                targetCtx.stroke();

                // 尺寸主线与界线
                const mainColor = (isHovered || isEditingThis) ? '#2D5DD0' : seg.color;
                targetCtx.strokeStyle = mainColor;
                targetCtx.lineWidth = ((isHovered || isEditingThis) ? 1.8 : 1.35) * invScale;
                targetCtx.beginPath();
                targetCtx.moveTo(e1a.x, e1a.y); targetCtx.lineTo(e1b.x, e1b.y);
                targetCtx.moveTo(e2a.x, e2a.y); targetCtx.lineTo(e2b.x, e2b.y);
                targetCtx.moveTo(p1.x, p1.y); targetCtx.lineTo(p2.x, p2.y);
                targetCtx.stroke();

                // 端头45°刻度线
                targetCtx.lineWidth = 1.7 * invScale;
                drawIsoTick(targetCtx, p1.x, p1.y, 3.8 * invScale);
                drawIsoTick(targetCtx, p2.x, p2.y, 3.8 * invScale);

                // 尺寸文字胶囊（随画布缩放自适应大小）
                const labelText = formatDimLabel(seg.valPx);
                targetCtx.save();
                targetCtx.translate(tx, ty);
                if (vertical) targetCtx.rotate(-Math.PI / 2);
                const fontPx = 10.0 * invScale;
                targetCtx.font = `500 ${fontPx}px ${CANVAS_FONT_MONO}`;
                const pillW = targetCtx.measureText(labelText).width + 11 * invScale;
                const pillH = 15.0 * invScale;

                targetCtx.fillStyle = (isHovered || isEditingThis) ? '#DCE9FF' : seg.bg;
                targetCtx.strokeStyle = mainColor;
                targetCtx.lineWidth = ((isHovered || isEditingThis) ? 1.5 : 1.15) * invScale;
                targetCtx.beginPath();
                targetCtx.roundRect(-pillW / 2, -pillH / 2, pillW, pillH, 3.2 * invScale);
                targetCtx.fill();
                targetCtx.stroke();

                targetCtx.fillStyle = (isHovered || isEditingThis) ? '#264FB5' : mainColor;
                targetCtx.textAlign = 'center';
                targetCtx.textBaseline = 'middle';
                targetCtx.fillText(labelText, 0, 0);
                targetCtx.restore();

                // 推入点击检测列表头（高于普通墙体尺寸优先级）
                g_exteriorDimHitTargets.unshift({
                    id: hitId,
                    wall,
                    opening: activeOp,
                    kind: seg.subKind,
                    labelPrefix: seg.prefix,
                    vertical,
                    x: tx,
                    y: ty,
                    p1,
                    p2,
                    u: { x: ux, y: uy },
                    n: { x: nx, y: ny },
                    curK: offsetDist,
                    curSlide: 0,
                    halfW: (vertical ? pillH : pillW) / 2,
                    halfH: (vertical ? pillW : pillH) / 2,
                    clearPx: seg.valPx
                });
            }
            targetCtx.restore();
        }

        function selectedWallIdsArray() {
            const ids = new Set(STATE.selectedWallIds || []);
            if (STATE.selected && STATE.selected.type === 'wall') ids.add(STATE.selected.id);
            return Array.from(ids);
        }

        function renderWallEndpointHandles() {
            if (STATE.tool !== 'select') return;
            const ids = selectedWallIdsArray();
            if (ids.length === 0) return;
            const k = 1 / (STATE.scale || 1);
            for (const wid of ids) {
                const wall = getWall(wid);
                if (!wall) continue;
                for (const end of ['v1', 'v2']) {
                    const v = getVertex(wall[end]);
                    if (!v) continue;
                    const isHover = STATE.hovered?.type === 'wall-endpoint' &&
                        STATE.hovered.wallId === wid && STATE.hovered.vertexId === v.id;
                    ctx.save();
                    ctx.beginPath();
                    ctx.arc(v.x, v.y, (isHover ? 7.5 : 6) * k, 0, Math.PI * 2);
                    ctx.fillStyle = isHover ? '#356AE6' : '#ffffff';
                    ctx.strokeStyle = '#356AE6';
                    ctx.lineWidth = 2 * k;
                    ctx.fill();
                    ctx.stroke();
                    ctx.restore();
                }
            }
        }

        function renderAlignmentGuidelines() {
            if (!STATE.activeSnapLines || STATE.activeSnapLines.length === 0) return;
            ctx.save();
            ctx.lineWidth = 1.2 / STATE.scale;
            ctx.setLineDash([4 / STATE.scale, 4 / STATE.scale]);
            for (const line of STATE.activeSnapLines) {
                ctx.strokeStyle = '#f97316';
                ctx.beginPath();
                if (line.type === 'x') { ctx.moveTo(line.value, -10000); ctx.lineTo(line.value, 10000); }
                else { ctx.moveTo(-10000, line.value); ctx.lineTo(10000, line.value); }
                ctx.stroke();
            }
            ctx.setLineDash([]);
            ctx.restore();
        }

        function renderMergeMarker() {
            const m = STATE.mergeCandidate;
            if (!m || !STATE.isDragging) return;
            const k = 1 / (STATE.scale || 1);
            ctx.save();
            ctx.beginPath();
            ctx.arc(m.x, m.y, 11 * k, 0, Math.PI * 2);
            ctx.strokeStyle = '#10b981';
            ctx.lineWidth = 2 * k;
            ctx.setLineDash([4 * k, 3 * k]);
            ctx.stroke();
            ctx.restore();
        }

        function renderDragConnectors() {
            const dt = STATE.dragTarget;
            if (!STATE.isDragging || !dt || dt.type !== 'wall' || !dt.detached) return;
            ctx.save();
            ctx.setLineDash([5, 4]);
            ctx.strokeStyle = '#356AE6';
            ctx.lineWidth = 2;
            for (const b of dt.blockedEnds) {
                if (!b.newVid) continue;
                const oldV = getVertex(b.oldVid), newV = getVertex(b.newVid);
                if (!oldV || !newV || dist(oldV, newV) < 1) continue;
                ctx.beginPath();
                ctx.moveTo(oldV.x, oldV.y);
                ctx.lineTo(newV.x, newV.y);
                ctx.stroke();
            }
            ctx.setLineDash([]);
            ctx.restore();
        }

        function renderMeasureOverlay() {
            if (STATE.measurePoints.length === 0) return;
            ctx.save();
            const p1 = STATE.measurePoints[0];
            const p2 = STATE.measurePoints[1] || STATE.mouseWorldPos;
            ctx.strokeStyle = '#f59e0b';
            ctx.lineWidth = 2 / STATE.scale;
            ctx.setLineDash([5 / STATE.scale, 3 / STATE.scale]);
            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.stroke();
            ctx.setLineDash([]);

            for (const pt of [p1, p2]) {
                ctx.fillStyle = '#f59e0b';
                ctx.beginPath();
                ctx.arc(pt.x, pt.y, 4.5 / STATE.scale, 0, Math.PI * 2);
                ctx.fill();
            }

            const dMeters = dist(p1, p2) / SCALE_PIXELS_PER_METER;
            if (dMeters > 0.02) {
                const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
                const txt = formatMeasureValue(dMeters);
                ctx.font = `bold ${11 / STATE.scale}px "Cascadia Mono", Consolas, sans-serif`;
                const tw = ctx.measureText(txt).width + 12 / STATE.scale;
                const th = 18 / STATE.scale;
                ctx.fillStyle = '#f59e0b';
                ctx.beginPath();
                ctx.roundRect(mx - tw / 2, my - th / 2, tw, th, 4 / STATE.scale);
                ctx.fill();
                ctx.fillStyle = '#ffffff';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(txt, mx, my);
            }
            ctx.restore();
        }

        /** 计算墙段上的居中吸附候选点（支持将同墙上的窗/其它洞口边缘作为边界点分段求中点） */
        function getWallOpeningMidpointCandidates(wall, wallLen, { excludeOpeningId = null, openingWidth = 0 } = {}) {
            if (!wall || wallLen < 1) return [];
            const intervals = [];
            for (const o of STATE.openings) {
                if (o.wallId !== wall.id || o.id === excludeOpeningId) continue;
                const wPx = Math.max(10, o.width || 45);
                const c = Math.max(0, Math.min(1, Number(o.t) || 0.5)) * wallLen;
                const a = Math.max(0, c - wPx * 0.5);
                const b = Math.min(wallLen, c + wPx * 0.5);
                if (b > a) intervals.push([a, b]);
            }
            intervals.sort((p, q) => p[0] - q[0]);
            const merged = [];
            for (const iv of intervals) {
                const prev = merged[merged.length - 1];
                if (prev && iv[0] <= prev[1] + 0.5) prev[1] = Math.max(prev[1], iv[1]);
                else merged.push([iv[0], iv[1]]);
            }

            const minSpan = Math.max(12, openingWidth > 0 ? openingWidth : 12);
            const candidates = [];
            let cursor = 0;
            for (const [oa, ob] of merged) {
                if (oa - cursor >= minSpan) {
                    const midS = (cursor + oa) * 0.5;
                    candidates.push({ t: midS / wallLen, s: midS, isSubSpan: true });
                }
                cursor = Math.max(cursor, ob);
            }
            if (wallLen - cursor >= minSpan) {
                const midS = (cursor + wallLen) * 0.5;
                candidates.push({ t: midS / wallLen, s: midS, isSubSpan: cursor > 0.5 });
            }

            // 若墙上有其他洞口但整墙中心 (t = 0.5) 不与任何洞口重叠且远离净段中点，保留整墙中点作备选
            if (merged.length > 0) {
                const fullMid = wallLen * 0.5;
                const opHalf = Math.max(4, (openingWidth || 20) * 0.5 - 0.5);
                const blocked = merged.some(([oa, ob]) => fullMid + opHalf > oa && fullMid - opHalf < ob);
                const nearExisting = candidates.some(c => Math.abs(c.s - fullMid) < 4);
                if (!blocked && !nearExisting) {
                    candidates.push({ t: 0.5, s: fullMid, isSubSpan: false });
                }
            }
            return candidates;
        }

        function findNearestWallSnap(pos, maxDist = 30, options = {}) {
            const snapMidpoint = Boolean(options.snapMidpoint);
            let closest = null, minDist = maxDist;
            for (const wall of STATE.walls) {
                const v1 = getVertex(wall.v1), v2 = getVertex(wall.v2);
                if (!v1 || !v2) continue;
                const proj = projectPointToSegment(pos, v1, v2);
                if (proj.distance < minDist) {
                    minDist = proj.distance;
                    const wallLen = dist(v1, v2);
                    const midSnapThresh = Math.min(wallLen * 0.25, Math.max(4, Math.min(16, 10 / Math.max(0.25, STATE.scale || 1))));
                    const candidates = getWallOpeningMidpointCandidates(wall, wallLen, options);
                    const projS = proj.t * wallLen;

                    let bestMid = null;
                    let bestMidOffset = Infinity;
                    for (const c of candidates) {
                        const off = Math.abs(projS - c.s);
                        if (off < bestMidOffset - 0.5 || (Math.abs(off - bestMidOffset) <= 0.5 && c.isSubSpan && !bestMid?.isSubSpan)) {
                            bestMidOffset = off;
                            bestMid = c;
                        }
                    }

                    const snappedMid = Boolean(snapMidpoint && bestMid && wallLen > 1 && bestMidOffset <= midSnapThresh);
                    const activeCand = bestMid || { t: 0.5, s: wallLen * 0.5, isSubSpan: false };
                    const midPoint = {
                        x: v1.x + activeCand.t * (v2.x - v1.x),
                        y: v1.y + activeCand.t * (v2.y - v1.y)
                    };
                    const halfPx = options.openingWidth ? options.openingWidth * 0.5 : 26;
                    const halfOpening = Math.min(0.46, halfPx / (wallLen || 1));
                    const rawT = snappedMid ? activeCand.t : proj.t;
                    const clampedT = Math.max(halfOpening, Math.min(1 - halfOpening, rawT));
                    closest = {
                        wall,
                        t: clampedT,
                        projPoint: {
                            x: v1.x + clampedT * (v2.x - v1.x),
                            y: v1.y + clampedT * (v2.y - v1.y)
                        },
                        midPoint,
                        midPoints: candidates.map(c => ({
                            x: v1.x + c.t * (v2.x - v1.x),
                            y: v1.y + c.t * (v2.y - v1.y),
                            isSubSpan: c.isSubSpan
                        })),
                        snappedMid,
                        snappedSubSpan: Boolean(snappedMid && activeCand.isSubSpan),
                        distance: proj.distance
                    };
                }
            }
            return closest;
        }

        /** 门窗拖拽 / 放置预览时绘制墙段中点参考线与吸附标识 */
        function renderOpeningMidpointIndicator(snap) {
            if (!snap || !snap.wall || !snap.midPoint) return;
            const v1 = getVertex(snap.wall.v1), v2 = getVertex(snap.wall.v2);
            if (!v1 || !v2) return;
            const wallLen = dist(v1, v2);
            if (wallLen < 1) return;

            const px = 1 / Math.max(0.25, STATE.scale || 1);
            const ux = (v2.x - v1.x) / wallLen, uy = (v2.y - v1.y) / wallLen;
            let nx = -uy, ny = ux;
            const globalRef = globalRefPoint();
            if ((snap.midPoint.x - globalRef.x) * nx + (snap.midPoint.y - globalRef.y) * ny < 0) {
                nx = -nx; ny = -ny;
            }
            const wallHalf = (snap.wall.thickness || 12) * 0.5;
            const pts = (snap.midPoints && snap.midPoints.length) ? snap.midPoints : [snap.midPoint];

            // 先绘制所有可用中点候选位置（未吸附时的淡淡引导圈），再高亮当前命中/吸附的中点
            for (const pt of pts) {
                const isActive = dist(pt, snap.midPoint) < 0.5;
                if (isActive && snap.snappedMid) continue;
                const tickExt = wallHalf + 6 * px;
                ctx.save();
                ctx.strokeStyle = isActive ? 'rgba(16, 185, 129, 0.55)' : 'rgba(16, 185, 129, 0.32)';
                ctx.lineWidth = 1.2 * px;
                ctx.setLineDash([3 * px, 2.5 * px]);
                ctx.beginPath();
                ctx.moveTo(pt.x - nx * tickExt, pt.y - ny * tickExt);
                ctx.lineTo(pt.x + nx * tickExt, pt.y + ny * tickExt);
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
                ctx.strokeStyle = isActive ? 'rgba(16, 185, 129, 0.8)' : 'rgba(16, 185, 129, 0.45)';
                ctx.lineWidth = 1.4 * px;
                ctx.beginPath();
                ctx.arc(pt.x, pt.y, 3 * px, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
                ctx.restore();
            }

            if (snap.snappedMid) {
                const tickExt = wallHalf + 10 * px;
                ctx.save();
                ctx.strokeStyle = '#10b981';
                ctx.lineWidth = 1.6 * px;
                ctx.setLineDash([3 * px, 2.5 * px]);
                ctx.beginPath();
                ctx.moveTo(snap.midPoint.x - nx * tickExt, snap.midPoint.y - ny * tickExt);
                ctx.lineTo(snap.midPoint.x + nx * tickExt, snap.midPoint.y + ny * tickExt);
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.fillStyle = '#ffffff';
                ctx.lineWidth = 1.6 * px;
                ctx.translate(snap.midPoint.x, snap.midPoint.y);
                ctx.rotate(Math.PI / 4);
                ctx.beginPath();
                ctx.rect(-4 * px, -4 * px, 8 * px, 8 * px);
                ctx.fill();
                ctx.stroke();
                ctx.restore();

                const label = snap.snappedSubSpan ? '净段中点' : '墙段中点';
                ctx.save();
                ctx.font = `600 ${10 * px}px "Noto Sans SC", sans-serif`;
                const padX = 5 * px, boxH = 18 * px;
                const boxW = ctx.measureText(label).width + padX * 2;
                const anchorDist = wallHalf + 18 * px;
                const boxX = snap.midPoint.x - nx * anchorDist - boxW * 0.5;
                const boxY = snap.midPoint.y - ny * anchorDist - boxH * 0.5;
                ctx.fillStyle = 'rgba(15, 23, 42, 0.94)';
                ctx.strokeStyle = '#10b981';
                ctx.lineWidth = 1 * px;
                ctx.beginPath();
                ctx.roundRect(boxX, boxY, boxW, boxH, 4 * px);
                ctx.fill();
                ctx.stroke();
                ctx.fillStyle = '#ffffff';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(label, boxX + boxW * 0.5, boxY + boxH * 0.5);
                ctx.restore();
            }
        }

        /** 拾取 / 拖动起铺点时，在门框中点显示可吸附标记（小三角，指向门洞） */
        function renderDoorMidSnapMarks() {
            const picking = STATE.tool === 'origin' || (STATE.isDragging && STATE.dragTarget?.type === 'origin');
            if (!picking) return;
            const sc = Math.max(0.25, STATE.scale || 1), px = 1 / sc;
            const rooms = STATE.dragTarget?.type === 'origin' ? [getRoom(STATE.dragTarget.roomId)].filter(Boolean) : STATE.rooms;
            ctx.save();
            ctx.strokeStyle = '#d97706';
            ctx.fillStyle = 'rgba(255,255,255,0.95)';
            ctx.lineWidth = 1.4 * px;
            for (const room of rooms) {
                for (const dm of getRoomDoorMidSnaps(room)) {
                    ctx.beginPath();
                    ctx.arc(dm.x, dm.y, 3.6 * px, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.stroke();
                    ctx.beginPath();
                    if (dm.axis === 'x') { ctx.moveTo(dm.x, dm.y - 7 * px); ctx.lineTo(dm.x, dm.y + 7 * px); }
                    else { ctx.moveTo(dm.x - 7 * px, dm.y); ctx.lineTo(dm.x + 7 * px, dm.y); }
                    ctx.stroke();
                }
            }
            ctx.restore();
        }

        function renderOriginSnapPreview() {
            renderDoorMidSnapMarks();
            if (STATE.isDragging && STATE.dragTarget?.type === 'origin') renderGroutSnapGuides();
            const snap = STATE.originSnapPreview;
            if (!snap) return;
            const sc = Math.max(0.25, STATE.scale || 1);
            const px = 1 / sc;
            const color = snap.snapType === 'corner' ? '#16a34a' : (snap.snapType === 'edge' ? '#0891b2' : (snap.snapType === 'door' ? '#d97706' : '#356AE6'));

            ctx.save();
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            if (snap.snapped && snap.cursor && dist(snap.cursor, snap) > 1 / sc) {
                ctx.beginPath();
                ctx.moveTo(snap.cursor.x, snap.cursor.y);
                ctx.lineTo(snap.x, snap.y);
                ctx.setLineDash([3 * px, 3 * px]);
                ctx.strokeStyle = color;
                ctx.lineWidth = 1.2 * px;
                ctx.stroke();
                ctx.setLineDash([]);
            }

            // 墙角用菱形、墙边用圆环；自由位置仅显示轻量十字，作为实时拾取预览。
            ctx.translate(snap.x, snap.y);
            ctx.strokeStyle = color;
            ctx.fillStyle = snap.snapped ? 'rgba(255,255,255,0.96)' : 'rgba(53,106,230,0.12)';
            ctx.lineWidth = 1.7 * px;
            if (snap.snapType === 'corner') {
                ctx.rotate(Math.PI / 4);
                ctx.beginPath();
                ctx.rect(-5 * px, -5 * px, 10 * px, 10 * px);
                ctx.fill();
                ctx.stroke();
            } else {
                ctx.beginPath();
                ctx.arc(0, 0, snap.snapType === 'edge' ? 5.5 * px : 4.5 * px, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(-8 * px, 0); ctx.lineTo(8 * px, 0);
                ctx.moveTo(0, -8 * px); ctx.lineTo(0, 8 * px);
                ctx.stroke();
            }
            ctx.restore();

            if (snap.snapped) {
                const label = snap.snapType === 'corner' ? '墙角吸附' : (snap.snapType === 'door' ? '门框中点 · 砖中对门中' : '墙边吸附 · 内侧边线');
                ctx.save();
                ctx.font = `600 ${10 * px}px "Noto Sans SC", sans-serif`;
                const padX = 5 * px, boxH = 18 * px;
                const boxW = ctx.measureText(label).width + padX * 2;
                const boxX = snap.x + 11 * px, boxY = snap.y - 23 * px;
                ctx.fillStyle = 'rgba(15, 23, 42, 0.94)';
                ctx.strokeStyle = color;
                ctx.lineWidth = 1 * px;
                ctx.beginPath();
                ctx.roundRect(boxX, boxY, boxW, boxH, 4 * px);
                ctx.fill();
                ctx.stroke();
                ctx.fillStyle = '#ffffff';
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';
                ctx.fillText(label, boxX + padX, boxY + boxH / 2);
                ctx.restore();
            }
        }

        function renderToolPreview() {
            if (STATE.tool === 'origin' || (STATE.isDragging && STATE.dragTarget?.type === 'origin')) {
                renderOriginSnapPreview();
                return;
            }
            if (STATE.isDragging && STATE.dragTarget?.type === 'opening' && STATE.openingSnapPreview) {
                renderOpeningMidpointIndicator(STATE.openingSnapPreview);
                return;
            }
            if (STATE.tool === 'wall' && !STATE.wallStartVertex) {
                STATE.wallDraft = null;
                STATE.lastWallDraftDir = null;
                const snap = snapPos(STATE.mouseWorldPos);
                ctx.save();
                ctx.strokeStyle = snap.snappedVertex || snap.wallSnap ? '#10b981' : '#356AE6';
                ctx.lineWidth = 2 / STATE.scale;
                ctx.beginPath();
                ctx.arc(snap.x, snap.y, 6 / STATE.scale, 0, Math.PI * 2);
                ctx.stroke();
                ctx.restore();
            } else if (STATE.tool === 'wall' && STATE.wallStartVertex) {
                const v1 = STATE.wallStartVertex;
                const snap = snapPos(STATE.mouseWorldPos);
                const fixed = smartCloseWallEnd({ x: v1.x, y: v1.y, id: v1.id }, snap);
                const endPt = { x: fixed.x, y: fixed.y };
                STATE.wallDraft = endPt;
                const draftLen = dist(v1, endPt);
                if (draftLen >= 6) {
                    const ddx = endPt.x - v1.x, ddy = endPt.y - v1.y;
                    STATE.lastWallDraftDir = Math.abs(ddy) <= 1e-6
                        ? { ux: ddx >= 0 ? 1 : -1, uy: 0 }
                        : (Math.abs(ddx) <= 1e-6
                            ? { ux: 0, uy: ddy >= 0 ? 1 : -1 }
                            : { ux: ddx / draftLen, uy: ddy / draftLen });
                }

                ctx.save();
                ctx.beginPath();
                ctx.moveTo(v1.x, v1.y);
                ctx.lineTo(endPt.x, endPt.y);
                ctx.lineWidth = 12;
                ctx.strokeStyle = 'rgba(53, 106, 230, 0.45)';
                ctx.lineCap = 'butt';
                ctx.stroke();

                const d = dist(v1, endPt);
                if (!STATE.draftPopoverShown && d > 5) {
                    ctx.fillStyle = '#356AE6';
                    ctx.font = 'bold 11px "Cascadia Mono", Consolas, monospace';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(formatDimLabel(d), (v1.x + endPt.x) / 2, (v1.y + endPt.y) / 2);
                }
                ctx.restore();
            } else if (['door', 'window'].includes(STATE.tool)) {
                const snap = findNearestWallSnap(STATE.mouseWorldPos, 30, {
                    snapMidpoint: !STATE.dragAltKey,
                    openingWidth: mmToPx(STATE.tool === 'window' ? PRESETS.draw.windowWidthMM : PRESETS.draw.doorWidthMM)
                });
                if (snap) {
                    ctx.save();
                    const { wall, projPoint } = snap;
                    const v1 = getVertex(wall.v1), v2 = getVertex(wall.v2);
                    const angle = Math.atan2(v2.y - v1.y, v2.x - v1.x);
                    ctx.translate(projPoint.x, projPoint.y);
                    ctx.rotate(angle);
                    ctx.strokeStyle = '#10b981';
                    ctx.fillStyle = 'rgba(16, 185, 129, 0.22)';
                    ctx.lineWidth = 2;
                    ctx.strokeRect(-22, -7, 44, 14);
                    ctx.fillRect(-22, -7, 44, 14);
                    ctx.restore();
                    renderOpeningMidpointIndicator(snap);
                }
            }
        }

        /*************************************************************************
         * 空间选中态：区域边缘高亮覆盖层
         * 说明：必须在墙体/门窗之后绘制，否则会被墙体覆盖而看不到选中状态。
         * 高亮路径取墙体内侧边缘（getRoomInnerWallVerts），紧贴房间可见边缘，
         * 再叠加“光晕 + 白色衬边 + 蓝色主线 + 角点手柄”四层，保证任何底色都清晰。
         * 只在主画布绘制，A4/DXF 导出不受影响。
         *************************************************************************/
        function renderRoomSelectionOverlay() {
            const drawRoomEdge = (room, mode) => {
                const centerVerts = getRoomPolygonVerts(room);
                if (centerVerts.length < 3) return;
                // 优先用墙体内侧边缘作为高亮路径，避免压在墙体中心线上
                let edgeVerts = centerVerts;
                try {
                    const inner = getRoomInnerWallVerts(room);
                    if (inner && inner.length >= 3) edgeVerts = inner;
                } catch (e) { /* 降级使用中心线多边形 */ }

                const sc = STATE.scale || 1;
                ctx.save();
                ctx.lineJoin = 'round';
                ctx.lineCap = 'round';
                const trace = () => {
                    ctx.beginPath();
                    tracePolygon(ctx, edgeVerts);
                };

                if (mode === 'selected') {
                    // 选中态：白色衬边（与深色墙体分离）+ 清晰的品牌蓝主线；不使用发光与阴影
                    trace();
                    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
                    ctx.lineWidth = 4.5 / sc;
                    ctx.stroke();
                    trace();
                    ctx.strokeStyle = CANVAS_THEME.accent;
                    ctx.lineWidth = 2 / sc;
                    ctx.stroke();
                } else {
                    // 悬停态：细虚线，不抢选中态的视觉
                    trace();
                    ctx.setLineDash([6 / sc, 4 / sc]);
                    ctx.strokeStyle = 'rgba(53, 106, 230, 0.55)';
                    ctx.lineWidth = 1.5 / sc;
                    ctx.stroke();
                    ctx.setLineDash([]);
                }
                ctx.restore();
            };

            // 先画悬停，再画选中（选中压住悬停）
            if (STATE.hovered && STATE.hovered.type === 'room') {
                const hoveredRoom = getRoom(STATE.hovered.id);
                if (hoveredRoom && hoveredRoom.id !== STATE.selectedRoomId) {
                    drawRoomEdge(hoveredRoom, 'hover');
                }
            }
            const selectedRoom = getRoom(STATE.selectedRoomId);
            if (selectedRoom) drawRoomEdge(selectedRoom, 'selected');
        }

        function renderOriginTargetsOverlay(targetCtx = ctx) {
            // 默认仅在选中“起铺点”工具时显示当前空间起铺点；开启底部“起铺点标靶”开关时常驻显示全屋起铺点
            const forceShow = !!STATE.showOrigins;
            if (!STATE.showPaving || (!forceShow && STATE.tool !== 'origin')) return;
            const sc = (targetCtx === ctx ? STATE.scale : 1) || 1;
            const drawnMasters = new Set();
            for (const room of STATE.rooms) {
                if (room.cleared || getRoomPolygonVerts(room).length < 3) continue;
                const isSelected = room.id === STATE.selectedRoomId;
                if (!forceShow && !isSelected) continue;
                const master = getOriginMasterRoom(room);
                if (drawnMasters.has(master.id)) continue;
                drawnMasters.add(master.id);
                const orig = originMark(getRoomOriginWorld(master));
                if (!orig || !Number.isFinite(orig.x) || !Number.isFinite(orig.y)) continue;
                const r = 6.5 / sc;
                const arm = 11 / sc;
                targetCtx.save();
                targetCtx.fillStyle = 'rgba(244, 63, 94, 0.25)';
                targetCtx.strokeStyle = '#e11d48';
                targetCtx.lineWidth = 1.8 / sc;
                targetCtx.beginPath();
                targetCtx.arc(orig.x, orig.y, r, 0, Math.PI * 2);
                targetCtx.fill();
                targetCtx.stroke();
                targetCtx.beginPath();
                targetCtx.moveTo(orig.x - arm, orig.y);
                targetCtx.lineTo(orig.x + arm, orig.y);
                targetCtx.moveTo(orig.x, orig.y - arm);
                targetCtx.lineTo(orig.x, orig.y + arm);
                targetCtx.stroke();
                targetCtx.restore();
            }
        }

        /** 获取紧邻当前层下方的一层（用于「透显底层」参考） */
        function getLowerFloor() {
            if (!STATE.floorsEnabled || !Array.isArray(STATE.floors) || STATE.floors.length < 2) return null;
            const idx = STATE.floors.findIndex(f => f.id === STATE.currentFloorId);
            return idx > 0 ? STATE.floors[idx - 1] : null;
        }

        /** 主画布透显紧邻底层的墙体、门窗与空间名（仅用于辅助绘图的视觉参考，不参与导图/算量） */
        function renderGhostLowerFloor(targetCtx = ctx) {
            if (!STATE.ghostLowerFloor || targetCtx !== ctx) return;
            const lf = getLowerFloor();
            const snap = lf && lf.snap;
            if (!snap) return;
            const verts = Array.isArray(snap.vertices) ? snap.vertices : [];
            const walls = Array.isArray(snap.walls) ? snap.walls : [];
            const openings = Array.isArray(snap.openings) ? snap.openings : [];
            const rooms = Array.isArray(snap.rooms) ? snap.rooms : [];
            if (!walls.length && !rooms.length) return;

            const vMap = new Map(verts.map(v => [v.id, v]));
            const wMap = new Map(walls.map(w => [w.id, w]));
            const alpha = Math.max(0.1, Math.min(0.85, Number(STATE.ghostLowerOpacity) || 0.35));
            const ghostWallColor = '#4A76C5';
            const ghostLineColor = '#3B63AD';

            targetCtx.save();
            targetCtx.globalAlpha = alpha;

            // 1. 底层墙体轮廓
            targetCtx.lineCap = 'round';
            targetCtx.lineJoin = 'round';
            targetCtx.strokeStyle = ghostWallColor;
            for (const w of walls) {
                const v1 = vMap.get(w.v1), v2 = vMap.get(w.v2);
                if (!v1 || !v2) continue;
                targetCtx.lineWidth = w.thickness || 12;
                targetCtx.beginPath();
                targetCtx.moveTo(v1.x, v1.y);
                targetCtx.lineTo(v2.x, v2.y);
                targetCtx.stroke();
            }

            // 2. 底层门窗符号
            for (const op of openings) {
                const w = wMap.get(op.wallId);
                if (!w) continue;
                const v1 = vMap.get(w.v1), v2 = vMap.get(w.v2);
                if (!v1 || !v2) continue;
                const cx = v1.x + (v2.x - v1.x) * op.t;
                const cy = v1.y + (v2.y - v1.y) * op.t;
                const angle = Math.atan2(v2.y - v1.y, v2.x - v1.x);
                const width = Number(op.width) || 40;
                const halfW = width * 0.5;
                const wallThick = w.thickness || 12;

                targetCtx.save();
                targetCtx.translate(cx, cy);
                targetCtx.rotate(angle);
                targetCtx.fillStyle = '#FFFFFF';
                targetCtx.fillRect(-halfW, -wallThick / 2 - 1, width, wallThick + 2);

                if (op.type === 'door' && STATE.showDoorLeaves !== false) {
                    const flipSign = op.flip ? -1 : 1;
                    const hingeAtEnd = !!op.hinge;
                    const hingeX = hingeAtEnd ? halfW : -halfW;
                    const startAngle = hingeAtEnd ? Math.PI : 0;
                    const endAngle = startAngle + (hingeAtEnd ? -1 : 1) * flipSign * (Math.PI / 2);
                    const ccw = hingeAtEnd ? (flipSign > 0) : (flipSign < 0);
                    targetCtx.beginPath();
                    targetCtx.strokeStyle = ghostLineColor;
                    targetCtx.lineWidth = 1;
                    targetCtx.setLineDash([3, 3]);
                    targetCtx.arc(hingeX, 0, width, startAngle, endAngle, ccw);
                    targetCtx.stroke();
                    targetCtx.setLineDash([]);
                    targetCtx.beginPath();
                    targetCtx.lineWidth = 1.6;
                    targetCtx.moveTo(hingeX, 0);
                    targetCtx.lineTo(hingeX, flipSign * width);
                    targetCtx.stroke();
                } else if (op.type === 'window') {
                    const glassOff = Math.max(1.4, wallThick * 0.16);
                    targetCtx.fillStyle = '#FFFFFF';
                    targetCtx.fillRect(-halfW, -wallThick / 2, width, wallThick);
                    targetCtx.strokeStyle = ghostLineColor;
                    targetCtx.lineWidth = 1.15;
                    targetCtx.beginPath();
                    targetCtx.moveTo(-halfW, -glassOff);
                    targetCtx.lineTo(halfW, -glassOff);
                    targetCtx.moveTo(-halfW, glassOff);
                    targetCtx.lineTo(halfW, glassOff);
                    targetCtx.stroke();
                }
                targetCtx.restore();
            }

            // 3. 底层空间名称标签（带楼层前缀，便于定位厨卫/楼梯间）
            const fontPx = Math.max(9, Math.min(16, 11 / Math.max(0.55, Math.min(1.4, STATE.scale))));
            targetCtx.font = `600 ${fontPx}px ${CANVAS_FONT_SANS}`;
            targetCtx.textAlign = 'center';
            targetCtx.textBaseline = 'middle';
            targetCtx.fillStyle = ghostLineColor;
            for (const r of rooms) {
                const pts = (r.vertexIds || []).map(id => vMap.get(id)).filter(Boolean);
                if (pts.length < 3) continue;
                let sx = 0, sy = 0;
                for (const p of pts) { sx += p.x; sy += p.y; }
                const rcx = sx / pts.length, rcy = sy / pts.length;
                const tag = `[${lf.name}] ${r.name || '未命名'}`;
                targetCtx.fillText(tag, rcx, rcy + fontPx * 1.15);
            }

            targetCtx.restore();
        }

        function render() {
            const dpr = window.devicePixelRatio || 1;
            const width = canvas.width / dpr;
            const height = canvas.height / dpr;

            ctx.clearRect(0, 0, width, height);
            renderSquareGrid(ctx, width, height);

            ctx.save();
            ctx.translate(STATE.panX, STATE.panY);
            ctx.scale(STATE.scale, STATE.scale);

            renderUnderlayImage(ctx);
            renderRoomsAndPaving(ctx);
            renderGhostLowerFloor(ctx);
            renderWalls(ctx);
            renderOpenings(ctx);
            // 空间选中边缘高亮：必须在墙体/门窗之后绘制
            renderRoomSelectionOverlay();
            renderOriginTargetsOverlay(ctx);

            if (STATE.showDimensions || STATE.selectedWallIds.size > 0 || STATE.selected?.type === 'wall' || STATE.editingWallId) {
                renderArchitecturalDimensions(ctx);
            } else {
                g_exteriorDimHitTargets = [];
            }
            // 选中门窗时始终在其边缘显示可点击修改的三段式距离与洞口宽尺寸标注线
            renderSelectedOpeningDimensions(ctx);

            renderWallEndpointHandles();
            renderAlignmentGuidelines();
            renderMergeMarker();
            renderDragConnectors();
            renderMeasureOverlay();
            renderToolPreview();

            ctx.restore();

            updateStraightenButton();
            updateDraftLengthPopover();
            renderCompassHud();
            if (typeof Elevation !== 'undefined') Elevation.checkFocusChange();
        }

        function snapCompassAngle(rawDeg) {
            const norm = ((rawDeg % 360) + 360) % 360;
            const nearest45 = Math.round(norm / 45) * 45;
            if (Math.abs(norm - nearest45) <= 8) {
                return {
                    angle: ((nearest45 % 360) + 360) % 360,
                    snapped: true
                };
            }
            return {
                angle: Math.round(norm) % 360,
                snapped: false
            };
        }

        function drawCompassSymbol(targetCtx, cx, cy, radius, deg = 0, opts = {}) {
            const { showDisc = false, isExport = false, isDragging = false } = opts;
            const rad = ((Number(deg) || 0) * Math.PI) / 180;
            const cr = isExport ? radius * 0.62 : radius * 0.72;
            const circleY = isExport ? -radius * 0.26 : 0;
            const ink = '#262626';
            const lw = Math.max(1.5, cr * 0.105);

            targetCtx.save();
            targetCtx.translate(cx, cy);

            if (showDisc && !isExport) {
                targetCtx.beginPath();
                targetCtx.arc(0, circleY, cr * 1.32, 0, Math.PI * 2);
                targetCtx.fillStyle = 'rgba(226, 232, 240, 0.78)';
                targetCtx.fill();
                if (isDragging) {
                    for (let a = 0; a < 360; a += 45) {
                        const ar = (a * Math.PI) / 180;
                        const rIn = cr * 1.12;
                        const rOut = cr * 1.28;
                        targetCtx.beginPath();
                        targetCtx.moveTo(Math.sin(ar) * rIn, circleY - Math.cos(ar) * rIn);
                        targetCtx.lineTo(Math.sin(ar) * rOut, circleY - Math.cos(ar) * rOut);
                        targetCtx.strokeStyle = (Math.round(deg) % 360 === a) ? '#356AE6' : 'rgba(100, 116, 139, 0.45)';
                        targetCtx.lineWidth = (a % 90 === 0) ? 1.6 : 1.1;
                        targetCtx.stroke();
                    }
                }
            }

            // 绘制圆环与左黑右白燕尾指北针（随方向角旋转）
            targetCtx.save();
            targetCtx.translate(0, circleY);
            targetCtx.rotate(rad);

            // 圆环底色与描边
            targetCtx.beginPath();
            targetCtx.arc(0, 0, cr, 0, Math.PI * 2);
            targetCtx.fillStyle = 'rgba(255, 255, 255, 0.92)';
            targetCtx.fill();
            targetCtx.strokeStyle = ink;
            targetCtx.lineWidth = lw;
            targetCtx.stroke();

            const tipY = -cr * 1.24;
            const wingX = cr * 0.60;
            const wingY = cr * 0.80;
            const notchY = cr * 0.52;

            // 右半针（白底填充遮住圆弧顶边 + 深色描边）
            targetCtx.beginPath();
            targetCtx.moveTo(0, tipY);
            targetCtx.lineTo(wingX, wingY);
            targetCtx.lineTo(0, notchY);
            targetCtx.closePath();
            targetCtx.fillStyle = '#ffffff';
            targetCtx.fill();

            // 左半针（实心深色填充）
            targetCtx.beginPath();
            targetCtx.moveTo(0, tipY);
            targetCtx.lineTo(-wingX, wingY);
            targetCtx.lineTo(0, notchY);
            targetCtx.closePath();
            targetCtx.fillStyle = ink;
            targetCtx.fill();

            // 指针整体外轮廓与中轴线
            targetCtx.lineJoin = 'round';
            targetCtx.lineCap = 'round';
            targetCtx.strokeStyle = ink;
            targetCtx.lineWidth = lw;
            targetCtx.beginPath();
            targetCtx.moveTo(0, tipY);
            targetCtx.lineTo(wingX, wingY);
            targetCtx.lineTo(0, notchY);
            targetCtx.lineTo(-wingX, wingY);
            targetCtx.closePath();
            targetCtx.stroke();

            targetCtx.beginPath();
            targetCtx.moveTo(0, tipY);
            targetCtx.lineTo(0, notchY);
            targetCtx.stroke();

            targetCtx.restore();

            // 仅在导出工程图时于圆环正下方绘制 NORTH 与 北，画布左上角指北针不显示下方文字
            if (isExport) {
                const northFontPx = Math.max(9, Math.round(cr * 0.45));
                const cnFontPx = Math.max(10, Math.round(cr * 0.54));
                targetCtx.fillStyle = ink;
                targetCtx.textAlign = 'center';
                targetCtx.textBaseline = 'middle';
                targetCtx.font = `700 ${northFontPx}px -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif`;
                targetCtx.fillText('NORTH', 0, circleY + cr + northFontPx * 0.78);
                targetCtx.font = `700 ${cnFontPx}px "Noto Sans SC", "Microsoft YaHei", SimHei, sans-serif`;
                targetCtx.fillText('北', 0, circleY + cr + northFontPx * 1.42 + cnFontPx * 0.56);
            }

            targetCtx.restore();
        }

        function renderCompassHud() {
            const cEl = $id('compass-hud-canvas');
            if (!cEl) return;
            const dpr = window.devicePixelRatio || 1;
            const cssW = 48, cssH = 48;
            const targetW = Math.round(cssW * dpr), targetH = Math.round(cssH * dpr);
            if (cEl.width !== targetW || cEl.height !== targetH) {
                cEl.width = targetW;
                cEl.height = targetH;
            }
            const cCtx = cEl.getContext('2d');
            cCtx.save();
            cCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
            cCtx.clearRect(0, 0, cssW, cssH);
            const active = !!(STATE.compassHover || STATE.compassDragging);
            drawCompassSymbol(cCtx, cssW / 2, cssH / 2, 19, STATE.northAngle || 0, {
                showDisc: active,
                showLabels: false,
                showSouthLabel: false,
                isExport: false,
                isDragging: !!STATE.compassDragging
            });
            cCtx.restore();
        }

        /*************************************************************************
         * 七、墙体正交保形拖拽、端点断开/闭合、双击改长与全图比例尺标定
         *************************************************************************/
        function isWallDiagonal(wallId) {
            const wall = getWall(wallId);
            if (!wall) return false;
            const v1 = getVertex(wall.v1), v2 = getVertex(wall.v2);
            if (!v1 || !v2) return false;
            return Math.abs(v1.x - v2.x) >= 1 && Math.abs(v1.y - v2.y) >= 1;
        }

        function straightenWall(wallId) {
            const wall = getWall(wallId);
            if (!wall) return false;
            const v1 = getVertex(wall.v1), v2 = getVertex(wall.v2);
            if (!v1 || !v2) return false;
            const dx = v2.x - v1.x, dy = v2.y - v1.y;
            if (Math.abs(dx) < 1 || Math.abs(dy) < 1) return false;

            saveHistory();
            const len = dist(v1, v2);
            const toHorizontal = Math.abs(dx) >= Math.abs(dy);
            if (toHorizontal) {
                v2.y = v1.y;
                v2.x = v1.x + (dx >= 0 ? len : -len);
            } else {
                v2.x = v1.x;
                v2.y = v1.y + (dy >= 0 ? len : -len);
            }
            for (const other of STATE.vertices) {
                if (other.id === v2.id || other.id === v1.id) continue;
                if (dist(other, v2) <= vertexMergeTolerance()) {
                    mergeVertices(v2.id, other.id);
                    break;
                }
            }
            removeOrphanVertices();
            mergeCollinearWallsAt(wall.v1);
            mergeCollinearWallsAt(wall.v2);
            syncRoomsFromGeometry({ silent: true });
            updateInspector();
            render();
            showToast(`已摆直为${toHorizontal ? '水平' : '垂直'}墙体`);
            return true;
        }

        function updateStraightenButton() {
            const el = $id('straighten-btn');
            if (!el) return;
            const sel = STATE.selected;
            const wall = (sel && sel.type === 'wall') ? getWall(sel.id) : null;
            const v1 = wall && getVertex(wall.v1), v2 = wall && getVertex(wall.v2);
            if (!wall || !v1 || !v2 || STATE.tool !== 'select' || STATE.isDragging || !isWallDiagonal(wall.id)) {
                el.classList.add('hidden');
                return;
            }
            const dx = v2.x - v1.x, dy = v2.y - v1.y;
            const len = Math.hypot(dx, dy) || 1;
            let nx = -dy / len, ny = dx / len;
            const s = toScreen((v1.x + v2.x) / 2, (v1.y + v2.y) / 2);
            let ox = nx * 30, oy = ny * 30;
            if (oy > 0) { ox = -ox; oy = -oy; }
            el.style.left = (s.x + ox) + 'px';
            el.style.top = (s.y + oy) + 'px';
            el.classList.remove('hidden');
        }

        function hitWallEndpointHandle(pos, tol = 9) {
            if (STATE.tool !== 'select') return null;
            const r = Math.max(7, tol / (STATE.scale || 1));
            for (const wid of selectedWallIdsArray()) {
                const wall = getWall(wid);
                if (!wall) continue;
                for (const end of ['v1', 'v2']) {
                    const v = getVertex(wall[end]);
                    if (v && dist(pos, v) <= r) {
                        return { type: 'wall-endpoint', id: wid, wallId: wid, end, vertexId: v.id, target: v };
                    }
                }
            }
            return null;
        }

        function findHitDimension(pos) {
            const lineTol = 5.5 / (STATE.scale || 1);
            for (const hit of g_exteriorDimHitTargets) {
                if (Math.abs(pos.x - hit.x) <= hit.halfW + 4 && Math.abs(pos.y - hit.y) <= hit.halfH + 4) {
                    return { ...hit, midPos: { x: hit.x, y: hit.y } };
                }
                if (hit.p1 && hit.p2) {
                    const proj = projectPointToSegment(pos, hit.p1, hit.p2);
                    if (proj.distance <= lineTol && proj.t >= 0.02 && proj.t <= 0.98) {
                        return { ...hit, midPos: { x: hit.x, y: hit.y } };
                    }
                }
            }
            return null;
        }

        function hitOriginHandle(pos) {
            // 起铺起铺点默认不显示也不响应点击，仅在进入起铺点编辑模式 (STATE.tool === 'origin') 时可点选/拖动，防止点击墙角时误选
            if (STATE.tool !== 'origin') return null;
            const room = getOriginMasterRoom(getSelectedRoom());
            if (!room) return null;
            const orig = originMark(getRoomOriginWorld(room));
            if (dist(pos, orig) <= 12 / STATE.scale) return room;
            return null;
        }

        /**
         * 本空间各门洞的门框中点：门洞中心投到本空间一侧的墙面线上（每个门两侧各一个，分属两侧空间）。
         * axis = 门宽方向（'x' 水平墙 / 'y' 竖直墙）；斜墙上的门不提供（砖块无法沿斜向对中）。
         */
        function getRoomDoorMidSnaps(room) {
            const out = [];
            forEachRoomAxisDoor(room, 1, ({ op, c, h, nx, ny, axis }) => out.push({ x: c.x + nx * h, y: c.y + ny * h, axis, openingId: op.id }));
            return out;
        }

        // 起铺点吸附使用房间墙体的“内侧边线”几何，而不是墙体中心线。
        // 角点优先于边线，保证靠近墙角时能精确落在两条墙面边线的交点。
        function snapOriginToRoomWallEdge(pos, room, radiusScreenPx = 14) {
            const freePoint = {
                x: pos.x, y: pos.y, cursor: { x: pos.x, y: pos.y },
                roomId: room?.id || null, snapped: false, snapType: null,
                snapLabel: '自由位置', distance: Infinity
            };
            if (!room) return freePoint;

            let edgeVerts = [];
            try { edgeVerts = getRoomInnerWallVerts(room) || []; } catch (e) { edgeVerts = []; }
            if (edgeVerts.length < 2) return freePoint;

            const radius = radiusScreenPx / Math.max(0.25, STATE.scale || 1);
            // 门框中点（门洞在本空间一侧墙面线上的中点）优先吸附
            let nearestDoor = null;
            for (const dm of getRoomDoorMidSnaps(room)) {
                const d = dist(pos, dm);
                if (d <= radius && (!nearestDoor || d < nearestDoor.distance)) nearestDoor = { ...dm, distance: d };
            }
            if (nearestDoor) {
                return {
                    x: nearestDoor.x, y: nearestDoor.y,
                    cursor: { x: pos.x, y: pos.y }, roomId: room.id,
                    snapped: true, snapType: 'door', snapLabel: '门框中点 · 砖中对门中',
                    distance: nearestDoor.distance, doorAxis: nearestDoor.axis, openingId: nearestDoor.openingId
                };
            }
            let nearestCorner = null;
            for (let i = 0; i < edgeVerts.length; i++) {
                const corner = edgeVerts[i];
                const d = dist(pos, corner);
                if (d <= radius && (!nearestCorner || d < nearestCorner.distance)) {
                    nearestCorner = { point: corner, distance: d, index: i };
                }
            }
            if (nearestCorner) {
                return {
                    x: nearestCorner.point.x, y: nearestCorner.point.y,
                    cursor: { x: pos.x, y: pos.y }, roomId: room.id,
                    snapped: true, snapType: 'corner', snapLabel: '墙角吸附',
                    distance: nearestCorner.distance, edgeIndex: nearestCorner.index
                };
            }

            let nearestEdge = null;
            for (let i = 0; i < edgeVerts.length; i++) {
                const a = edgeVerts[i], b = edgeVerts[(i + 1) % edgeVerts.length];
                const projected = projectPointToSegment(pos, a, b);
                if (projected.distance <= radius && (!nearestEdge || projected.distance < nearestEdge.distance)) {
                    nearestEdge = { point: projected.projPoint, distance: projected.distance, index: i };
                }
            }
            if (nearestEdge) {
                return {
                    x: nearestEdge.point.x, y: nearestEdge.point.y,
                    cursor: { x: pos.x, y: pos.y }, roomId: room.id,
                    snapped: true, snapType: 'edge', snapLabel: '墙边吸附',
                    distance: nearestEdge.distance, edgeIndex: nearestEdge.index
                };
            }
            return freePoint;
        }

        /* ---------- 起铺点拖动：相邻空间砖缝对齐吸附（地面） ----------
         * 排砖网格是周期性的：本空间的竖缝（常 X）/ 横缝（常 Y）中心线 = 相位 + k × 缝距，
         * 因此只需把“目标缝线 − 本空间缝线相位”对缝距取模，就能得到起铺点需要平移的量。
         * 参照对象：与本空间不在同一通铺 / 对缝组、未清空、非斜铺、且相互靠近的空间；
         * 竖缝只取两空间 X 投影重叠段内的缝线（缝线穿过两空间之间的墙延续），横缝同理。 */
        const wrapPeriod = (d, p) => { if (!(p > 0)) return d; d = ((d % p) + p) % p; return d > p / 2 ? d - p : d; };

        /** 网格的缝中心线相位族：工字铺每隔一行错半砖、369 铺错 1/3 砖，竖缝因此有多个相位 */
        function latticeJointPhases(room, G) {
            const half = G.jointPx / 2;
            const xs = [G.origX - half];
            if (room.pattern === 'brick') xs.push(G.origX - half + G.stepX / 2);
            else if (room.pattern === 'stagger_369') xs.push(G.origX - half + G.stepX / 3, G.origX - half + G.stepX * 2 / 3);
            return { xs, ys: [G.origY - half], stepX: G.stepX, stepY: G.stepY };
        }

        /** 拖动开始时收集一次参照空间的缝线（拖动过程中参照空间不变） */
        function collectFloorGroutRefs(room) {
            const grp = STATE.originGroups && STATE.originGroups.get(room.id);
            const same = new Set(grp ? grp.rooms.map(r => r.id) : [room.id]);
            same.add(room.id);
            const myPv = getRoomPavingPolygonVerts(room);
            if (!myPv || myPv.length < 3) return { refs: [], myB: null };
            const myB = pointsBounds(myPv);
            const near = 600 * SCALE_PIXELS_PER_METER / 1000;   // 600 mm 以内视为相邻（覆盖常见墙厚）
            const lines = (phases, step, lo, hi) => {
                const out = [];
                if (!(step > 0) || !(hi > lo)) return out;
                for (const ph of phases) {
                    for (let k = Math.ceil((lo - ph) / step); ph + k * step <= hi && out.length < 400; k++) out.push(ph + k * step);
                }
                return out;
            };
            const refs = [];
            for (const r2 of STATE.rooms) {
                if (same.has(r2.id) || r2.cleared || r2.pattern === 'diagonal' || !(r2.computedTiles && r2.computedTiles.length)) continue;
                const pv = getRoomPavingPolygonVerts(r2);
                if (!pv || pv.length < 3) continue;
                const b = pointsBounds(pv);
                if (b.minX > myB.maxX + near || b.maxX < myB.minX - near || b.minY > myB.maxY + near || b.maxY < myB.minY - near) continue;
                let G2;
                try { G2 = createPavingLattice(r2, getRoomOriginWorld(getOriginMasterRoom(r2)), b); } catch (e) { continue; }
                const ph = latticeJointPhases(r2, G2);
                refs.push({
                    room: r2, b,
                    xs: lines(ph.xs, ph.stepX, Math.max(b.minX, myB.minX), Math.min(b.maxX, myB.maxX)),
                    ys: lines(ph.ys, ph.stepY, Math.max(b.minY, myB.minY), Math.min(b.maxY, myB.maxY))
                });
            }
            return { refs, myB };
        }

        /**
         * 以 room 当前的 originX/Y 为拖动位置，计算砖缝对齐吸附。lockX / lockY：该轴已被墙边 / 墙角吸附，不再参与。
         * 返回 { dx, dy, guides } 或 null；guides 为吸附提示线（世界坐标）。
         */
        function snapOriginToFloorGrout(room, refsCtx, lockX, lockY) {
            if (!room || room.pattern === 'diagonal' || !refsCtx || !refsCtx.refs.length || (lockX && lockY)) return null;
            const o = getRoomOriginWorld(room);
            if (o.doorAlign) return null;
            const G = createPavingLattice(room, o, refsCtx.myB);
            const ph = latticeJointPhases(room, G);
            const tol = 6 / Math.max(0.25, STATE.scale || 1);   // 屏幕 6 px
            const pick = (axis) => {
                let best = null;
                for (const ref of refsCtx.refs) {
                    const targets = axis === 'x' ? ref.xs : ref.ys;
                    const phases = axis === 'x' ? ph.xs : ph.ys;
                    const step = axis === 'x' ? ph.stepX : ph.stepY;
                    for (const t of targets) {
                        for (const f of phases) {
                            const d = wrapPeriod(t - f, step);
                            if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, v: t, ref };
                        }
                    }
                }
                return best;
            };
            const bx = lockX ? null : pick('x');
            const by = lockY ? null : pick('y');
            if (!bx && !by) return null;
            const myB = refsCtx.myB, guides = [];
            if (bx) guides.push({ axis: 'x', v: bx.v, a: Math.min(myB.minY, bx.ref.b.minY), b: Math.max(myB.maxY, bx.ref.b.maxY), name: bx.ref.room.name });
            if (by) guides.push({ axis: 'y', v: by.v, a: Math.min(myB.minX, by.ref.b.minX), b: Math.max(myB.maxX, by.ref.b.maxX), name: by.ref.room.name });
            return { dx: bx ? bx.d : 0, dy: by ? by.d : 0, guides };
        }

        /** 砖缝对齐提示线：细虚线贯穿两个空间，并在端点标注参照空间 */
        function renderGroutSnapGuides() {
            const gs = STATE.groutSnapGuides;
            if (!gs || !gs.length) return;
            const px = 1 / Math.max(0.25, STATE.scale || 1);
            ctx.save();
            ctx.strokeStyle = '#356AE6';
            ctx.lineWidth = 1 * px;
            ctx.setLineDash([6 * px, 4 * px]);
            for (const g of gs) {
                ctx.beginPath();
                if (g.axis === 'x') { ctx.moveTo(g.v, g.a - 12 * px); ctx.lineTo(g.v, g.b + 12 * px); }
                else { ctx.moveTo(g.a - 12 * px, g.v); ctx.lineTo(g.b + 12 * px, g.v); }
                ctx.stroke();
            }
            ctx.setLineDash([]);
            ctx.font = `600 ${9.5 * px}px "Noto Sans SC", sans-serif`;
            ctx.textBaseline = 'middle';
            for (const g of gs) {
                const label = `砖缝对齐 · ${g.name || ''}`;
                const w = ctx.measureText(label).width + 8 * px, h = 15 * px;
                const x = g.axis === 'x' ? g.v + 4 * px : g.a - 12 * px;
                const y = g.axis === 'x' ? g.a - 12 * px - h : g.v - h - 3 * px;
                ctx.fillStyle = 'rgba(255,255,255,0.95)';
                ctx.strokeStyle = '#356AE6';
                ctx.lineWidth = 1 * px;
                ctx.beginPath();
                ctx.rect(x, y, w, h);
                ctx.fill();
                ctx.stroke();
                ctx.fillStyle = '#1e3a8a';
                ctx.textAlign = 'left';
                ctx.fillText(label, x + 4 * px, y + h / 2);
            }
            ctx.restore();
        }

        function getOriginRoomAtPoint(pos) {
            const hit = hitTest(pos);
            if (hit?.type === 'room') return getRoom(hit.id);

            // 点在墙厚范围内时，hitTest 会先命中墙体；此时按最近的房间内侧墙边
            // 判定目标空间，避免误把起铺点吸到共享墙的中心线或选错房间。
            let best = null;
            for (const room of STATE.rooms) {
                const candidate = snapOriginToRoomWallEdge(pos, room);
                if (!candidate.snapped) continue;
                const preferred = room.id === STATE.selectedRoomId;
                if (!best || candidate.distance < best.candidate.distance - 0.05 ||
                    (Math.abs(candidate.distance - best.candidate.distance) <= 0.05 && preferred)) {
                    best = { room, candidate };
                }
            }
            return best?.room || getSelectedRoom();
        }

        function hitOpeningEndpointHandle(pos, tol = 9.5) {
            if (STATE.tool !== 'select') return null;
            const r = Math.max(6.5, tol / (STATE.scale || 1));
            for (const op of STATE.openings) {
                const wall = getWall(op.wallId);
                if (!wall) continue;
                const v1 = getVertex(wall.v1), v2 = getVertex(wall.v2);
                if (!v1 || !v2) continue;
                const wallLen = dist(v1, v2);
                if (wallLen < 1) continue;
                const ux = (v2.x - v1.x) / wallLen, uy = (v2.y - v1.y) / wallLen;
                const cx = v1.x + op.t * (v2.x - v1.x);
                const cy = v1.y + op.t * (v2.y - v1.y);
                const halfW = (op.width || 45) / 2;
                const startPt = { x: cx - ux * halfW, y: cy - uy * halfW };
                const endPt = { x: cx + ux * halfW, y: cy + uy * halfW };
                if (dist(pos, startPt) <= r) {
                    return { type: 'opening-endpoint', id: op.id, end: 'start', target: op, wall, ux, uy };
                }
                if (dist(pos, endPt) <= r) {
                    return { type: 'opening-endpoint', id: op.id, end: 'end', target: op, wall, ux, uy };
                }
            }
            return null;
        }

        function hitTest(pos) {
            const opEndHandle = hitOpeningEndpointHandle(pos);
            if (opEndHandle) return opEndHandle;
            const endHandle = hitWallEndpointHandle(pos);
            if (endHandle) return endHandle;
            for (const v of STATE.vertices) {
                if (dist(pos, v) <= 9 / STATE.scale) return { type: 'vertex', id: v.id, target: v };
            }
            for (const op of STATE.openings) {
                const wall = getWall(op.wallId);
                if (!wall) continue;
                const v1 = getVertex(wall.v1), v2 = getVertex(wall.v2);
                if (!v1 || !v2) continue;
                const wallLen = dist(v1, v2) || 1;
                const ux = (v2.x - v1.x) / wallLen, uy = (v2.y - v1.y) / wallLen;
                const cx = v1.x + op.t * (v2.x - v1.x), cy = v1.y + op.t * (v2.y - v1.y);
                const halfW = (op.width || 45) / 2;
                const pA = { x: cx - ux * halfW, y: cy - uy * halfW };
                const pB = { x: cx + ux * halfW, y: cy + uy * halfW };
                const proj = projectPointToSegment(pos, pA, pB);
                if (proj.distance <= Math.max(10, (wall.thickness || 12) / 2 + 5)) {
                    return { type: 'opening', id: op.id, target: op };
                }
            }
            for (const wall of STATE.walls) {
                const v1 = getVertex(wall.v1), v2 = getVertex(wall.v2);
                if (!v1 || !v2) continue;
                const proj = projectPointToSegment(pos, v1, v2);
                if (proj.distance <= (wall.thickness || 12) / 2 + 5) {
                    return { type: 'wall', id: wall.id, target: wall };
                }
            }
            for (const room of STATE.rooms) {
                const verts = getRoomPolygonVerts(room);
                if (verts.length >= 3 && isPointInPolygon(pos, verts)) {
                    return { type: 'room', id: room.id, target: room };
                }
            }
            return null;
        }

        function computeWallDragEnds(wallsToMove, isHorizontal, isVertical) {
            const blockedEnds = [];
            if (!isHorizontal && !isVertical) return blockedEnds;
            const moveSet = new Set(wallsToMove);
            const isSameDirection = (w) => {
                const a = getVertex(w.v1), b = getVertex(w.v2);
                if (!a || !b) return false;
                return isHorizontal ? Math.abs(a.y - b.y) < 2 : Math.abs(a.x - b.x) < 2;
            };
            for (const wid of wallsToMove) {
                const w = getWall(wid);
                if (!w) continue;
                for (const end of ['v1', 'v2']) {
                    const vid = w[end];
                    const blocked = STATE.walls.some(other =>
                        other.id !== wid && !moveSet.has(other.id) &&
                        (other.v1 === vid || other.v2 === vid) && isSameDirection(other));
                    if (blocked) blockedEnds.push({ wallId: wid, end, oldVid: vid, newVid: null, connWallId: null, perpWalls: null });
                }
            }
            return blockedEnds;
        }

        function buildWallVertexOrigins(wallsToMove) {
            const map = new Map();
            wallsToMove.forEach(wid => {
                const w = getWall(wid);
                if (!w) return;
                [w.v1, w.v2].forEach(vid => {
                    const v = getVertex(vid);
                    if (v && !map.has(vid)) map.set(vid, { x: v.x, y: v.y });
                });
            });
            return map;
        }



        function handleDrag(worldPos) {
            if (!STATE.dragTarget) return;
            const dx = worldPos.x - STATE.dragStartMouse.x;
            const dy = worldPos.y - STATE.dragStartMouse.y;
            STATE.activeSnapLines = [];

            if (STATE.dragTarget.type === 'dimension') {
                const dt = STATE.dragTarget;
                if (Math.hypot(dx, dy) > 2.2 / (STATE.scale || 1)) {
                    if (!dt.hasMoved) {
                        saveHistory();
                        dt.hasMoved = true;
                    }
                    const deltaN = dx * dt.n.x + dy * dt.n.y;
                    const deltaU = dx * dt.u.x + dy * dt.u.y;
                    if (dt.opening) {
                        dt.opening.dimOffset = Math.round((dt.startK + deltaN) * 10) / 10;
                    } else {
                        dt.wall.dimOffset = Math.round((dt.startK + deltaN) * 10) / 10;
                        dt.wall.dimSlide = Math.round((dt.startSlide + deltaU) * 10) / 10;
                    }
                }
            } else if (STATE.dragTarget.type === 'origin') {
                const room = getRoom(STATE.dragTarget.roomId);
                if (room) {
                    const snap = snapOriginToRoomWallEdge(worldPos, room);
                    STATE.originSnapPreview = snap;
                    room.originMode = 'custom';
                    room.originX = snap.snapType === 'door' ? snap.x : Math.round(snap.x);
                    room.originY = snap.snapType === 'door' ? snap.y : Math.round(snap.y);
                    room.originDoorAlign = snap.snapType === 'door' ? snap.doorAxis : null;
                    room.originDoorId = snap.snapType === 'door' ? (snap.openingId || null) : null;
                    room.originDoorOffset = 0;
                    room.originStamp = Date.now();
                    // 砖缝对齐吸附（按住 Alt 暂停）：墙角 / 门框中点已定两轴；墙边吸附只锁定贴墙的那一轴
                    STATE.groutSnapGuides = null;
                    if (!STATE.dragAltKey && snap.snapType !== 'door' && snap.snapType !== 'corner') {
                        let lockX = false, lockY = false;
                        if (snap.snapType === 'edge') {
                            let ev = [];
                            try { ev = getRoomInnerWallVerts(room) || []; } catch (e) { ev = []; }
                            const a = ev[snap.edgeIndex], b = ev[(snap.edgeIndex + 1) % ev.length];
                            if (a && b && Math.abs(b.y - a.y) < 0.5) lockY = true;
                            else if (a && b && Math.abs(b.x - a.x) < 0.5) lockX = true;
                            else { lockX = true; lockY = true; }
                        }
                        const dt = STATE.dragTarget;
                        if (!dt.groutRefs) dt.groutRefs = collectFloorGroutRefs(room);
                        const gs = snapOriginToFloorGrout(room, dt.groutRefs, lockX, lockY);
                        if (gs) {
                            room.originX = Math.round((room.originX + gs.dx) * 1000) / 1000;
                            room.originY = Math.round((room.originY + gs.dy) * 1000) / 1000;
                            STATE.groutSnapGuides = gs.guides;
                        }
                    }
                    recomputeAllRoomTiling();
                }
            } else if (STATE.dragTarget.type === 'vertex' || STATE.dragTarget.type === 'wall-endpoint') {
                const vid = STATE.dragTarget.type === 'vertex' ? STATE.dragTarget.id : STATE.dragTarget.vertexId;
                const v = getVertex(vid);
                if (!v) return;
                let tx = STATE.dragTarget.originX + dx, ty = STATE.dragTarget.originY + dy;
                if (STATE.gridSnap) {
                    tx = Math.round(tx / STATE.gridSize) * STATE.gridSize;
                    ty = Math.round(ty / STATE.gridSize) * STATE.gridSize;
                }
                const snapX = findCollinearAndOrthoSnaps(tx, true, [v.id]);
                if (snapX) { tx = snapX.snappedVal; STATE.activeSnapLines.push(snapX); }
                const snapY = findCollinearAndOrthoSnaps(ty, false, [v.id]);
                if (snapY) { ty = snapY.snappedVal; STATE.activeSnapLines.push(snapY); }

                // 找出与当前节点直接相连的邻居节点：禁止将节点直接重合到同一面墙的另一端，防止墙体被压缩为0而断开消失
                const adjacentVids = new Set();
                for (const w of STATE.walls) {
                    if (w.v1 === v.id) adjacentVids.add(w.v2);
                    else if (w.v2 === v.id) adjacentVids.add(w.v1);
                }
                for (const adjId of adjacentVids) {
                    const av = getVertex(adjId);
                    if (av && Math.hypot(tx - av.x, ty - av.y) < 12) {
                        const ang = Math.atan2(ty - av.y, tx - av.x);
                        tx = av.x + Math.cos(ang) * 12;
                        ty = av.y + Math.sin(ang) * 12;
                    }
                }

                // 仅允许吸附合并不直接相连的其它自由节点（用于闭合敞口墙），保持既有边角连带拉动不断开
                const excludeIds = [v.id, ...Array.from(adjacentVids)];
                const nearV = findVertexNear({ x: tx, y: ty }, excludeIds);
                if (nearV) {
                    tx = nearV.x; ty = nearV.y;
                    STATE.dragTarget.mergeTargetId = nearV.id;
                    STATE.mergeCandidate = { x: nearV.x, y: nearV.y };
                } else {
                    STATE.dragTarget.mergeTargetId = null;
                    STATE.mergeCandidate = null;
                }
                v.x = tx; v.y = ty;
                recomputeAllRoomTiling();
            } else if (STATE.dragTarget.type === 'wall') {
                const dt = STATE.dragTarget;
                const { isHorizontal, isVertical } = dt;
                const vertexOrigins = dt.vertexOrigins;
                const movingVidSet = new Set(vertexOrigins.keys());
                let effDx = 0, effDy = 0;
                if (isHorizontal) {
                    effDy = dy;
                    if (STATE.gridSnap) effDy = Math.round(effDy / STATE.gridSize) * STATE.gridSize;
                    const sampleVid = vertexOrigins.keys().next().value;
                    const originY = vertexOrigins.get(sampleVid).y;
                    const snapY = findCollinearAndOrthoSnaps(originY + effDy, false, Array.from(movingVidSet));
                    if (snapY) { effDy = snapY.snappedVal - originY; STATE.activeSnapLines.push(snapY); }
                } else if (isVertical) {
                    effDx = dx;
                    if (STATE.gridSnap) effDx = Math.round(effDx / STATE.gridSize) * STATE.gridSize;
                    const sampleVid = vertexOrigins.keys().next().value;
                    const originX = vertexOrigins.get(sampleVid).x;
                    const snapX = findCollinearAndOrthoSnaps(originX + effDx, true, Array.from(movingVidSet));
                    if (snapX) { effDx = snapX.snappedVal - originX; STATE.activeSnapLines.push(snapX); }
                } else {
                    effDx = dx; effDy = dy;
                    if (STATE.gridSnap) {
                        effDx = Math.round(effDx / STATE.gridSize) * STATE.gridSize;
                        effDy = Math.round(effDy / STATE.gridSize) * STATE.gridSize;
                    }
                }

                // 若拉动的墙体端点连接着同向共线的相邻墙段（blockedEnds）：
                // 相邻同向共线墙段保持不动（原节点 oldVid 固定在原位），拉动的墙段脱开并自动生成正交延伸连接墙段
                let topologyChanged = false;
                if (!dt.detached && dt.blockedEnds && dt.blockedEnds.length > 0 && Math.hypot(effDx, effDy) > 0.5) {
                    const moveSet = new Set(dt.wallsToMove || []);
                    const isOrthoWall = (pw) => {
                        const a = getVertex(pw.v1), b = getVertex(pw.v2);
                        if (!a || !b) return false;
                        return isHorizontal ? Math.abs(a.x - b.x) < 2 : Math.abs(a.y - b.y) < 2;
                    };
                    const newVidByOld = new Map();
                    for (const b of dt.blockedEnds) {
                        let newV = newVidByOld.get(b.oldVid);
                        if (!newV) {
                            const orig = vertexOrigins.get(b.oldVid) || getVertex(b.oldVid);
                            if (!orig) continue;
                            // 记录原节点上原本相连的正交侧墙（当向侧墙内侧方向推拉时，动态调整分段归属避免重叠）
                            const perpWalls = [];
                            for (const pw of STATE.walls) {
                                if (moveSet.has(pw.id)) continue;
                                if ((pw.v1 === b.oldVid || pw.v2 === b.oldVid) && isOrthoWall(pw)) {
                                    const endKey = pw.v1 === b.oldVid ? 'v1' : 'v2';
                                    const farVid = pw.v1 === b.oldVid ? pw.v2 : pw.v1;
                                    const farV = getVertex(farVid);
                                    if (farV) perpWalls.push({ wallId: pw.id, endKey, farVid, farX: farV.x, farY: farV.y });
                                }
                            }
                            newV = { id: uid('v_'), x: orig.x, y: orig.y, _perpWalls: perpWalls, _origX: orig.x, _origY: orig.y };
                            STATE.vertices.push(newV);
                            newVidByOld.set(b.oldVid, newV);
                            // 原节点 oldVid 从移动集合中移除（保持共线邻居墙段不动），改为移动新节点 newV
                            vertexOrigins.delete(b.oldVid);
                            movingVidSet.delete(b.oldVid);
                            vertexOrigins.set(newV.id, { x: orig.x, y: orig.y });
                            movingVidSet.add(newV.id);
                            const w = getWall(b.wallId);
                            const connWall = {
                                id: uid('w_'),
                                v1: b.oldVid,
                                v2: newV.id,
                                thickness: (w && w.thickness) || 12
                            };
                            STATE.walls.push(connWall);
                            newV._connWallId = connWall.id;
                        }
                        b.newVid = newV.id;
                        b.connWallId = newV._connWallId;
                        b.perpWalls = newV._perpWalls;
                        const w = getWall(b.wallId);
                        if (w) w[b.end] = newV.id;
                    }
                    dt.detached = true;
                    topologyChanged = true;
                }

                // 判断侧墙 w (连接移动节点 mVid 与固定节点 sVid) 是否为错台短墙/可合并台阶墙：
                // 若 sVid 上连有与当前拖动墙同向的相邻墙体（如错开的两段水平墙），或 mVid/sVid 沿正交方向还有另一段分户墙，
                // 则允许直接拉到 sVid 对齐并合并（不再受 12px 最小墙长阻挡）
                const isSameDirWall = (ow) => {
                    const a = getVertex(ow.v1), b = getVertex(ow.v2);
                    if (!a || !b) return false;
                    return isHorizontal ? Math.abs(a.y - b.y) < 2.5 : Math.abs(a.x - b.x) < 2.5;
                };
                const isOrthoDirWall = (ow) => {
                    const a = getVertex(ow.v1), b = getVertex(ow.v2);
                    if (!a || !b) return false;
                    return isHorizontal ? Math.abs(a.x - b.x) < 2.5 : Math.abs(a.y - b.y) < 2.5;
                };
                const isStepMergeable = (w, mVid, sVid) => {
                    // 1. mVid 或 sVid 上还有另一段正交共线墙（说明 w 是分户墙上的错台段）
                    const hasOtherOrtho = STATE.walls.some(ow =>
                        ow.id !== w.id && !movingVidSet.has(ow.v1 === mVid || ow.v1 === sVid ? ow.v2 : ow.v1) &&
                        (ow.v1 === mVid || ow.v2 === mVid || ow.v1 === sVid || ow.v2 === sVid) && isOrthoDirWall(ow));
                    if (hasOtherOrtho) return true;
                    // 2. sVid 上连有与拖动墙同向的相邻墙体，且该相邻墙体向拖动墙外侧延伸（对齐后共线合并）
                    const sVert = getVertex(sVid);
                    if (!sVert) return false;
                    for (const ow of STATE.walls) {
                        if (ow.id === w.id || !(ow.v1 === sVid || ow.v2 === sVid) || !isSameDirWall(ow)) continue;
                        const otherWid = ow.v1 === sVid ? ow.v2 : ow.v1;
                        const otherV = getVertex(otherWid);
                        if (!otherV) continue;
                        // 检查该同向墙是否与当前拖动墙处于台阶错位关系（而非同一个矩形房间正对面的墙）
                        let overlapsDragged = false;
                        for (const mWid of (dt.wallsToMove || [])) {
                            const mw = getWall(mWid);
                            if (!mw) continue;
                            const mv1 = getVertex(mw.v1), mv2 = getVertex(mw.v2);
                            if (!mv1 || !mv2) continue;
                            if (isHorizontal) {
                                const min1 = Math.min(mv1.x, mv2.x), max1 = Math.max(mv1.x, mv2.x);
                                const min2 = Math.min(sVert.x, otherV.x), max2 = Math.max(sVert.x, otherV.x);
                                if (Math.min(max1, max2) - Math.max(min1, min2) > 4) overlapsDragged = true;
                            } else if (isVertical) {
                                const min1 = Math.min(mv1.y, mv2.y), max1 = Math.max(mv1.y, mv2.y);
                                const min2 = Math.min(sVert.y, otherV.y), max2 = Math.max(sVert.y, otherV.y);
                                if (Math.min(max1, max2) - Math.max(min1, min2) > 4) overlapsDragged = true;
                            }
                        }
                        if (!overlapsDragged) return true;
                    }
                    return false;
                };

                STATE.mergeCandidate = null;
                for (const w of STATE.walls) {
                    const move1 = movingVidSet.has(w.v1), move2 = movingVidSet.has(w.v2);
                    if (move1 !== move2) {
                        const mVid = move1 ? w.v1 : w.v2;
                        const sVid = move1 ? w.v2 : w.v1;
                        const isConnWall = dt.detached && dt.blockedEnds && dt.blockedEnds.some(b => b.connWallId === w.id);
                        const mOrig = vertexOrigins.get(mVid);
                        const sVert = getVertex(sVid);
                        if (!mOrig || !sVert) continue;
                        const nx = mOrig.x + effDx, ny = mOrig.y + effDy;

                        if (isConnWall || isStepMergeable(w, mVid, sVid)) {
                            // 允许直接拉到与相邻墙体平齐的位置（自动吸附并在松手时合并）
                            if (isHorizontal && Math.abs(ny - sVert.y) <= 4) {
                                effDy = sVert.y - mOrig.y;
                                STATE.mergeCandidate = { x: sVert.x, y: sVert.y };
                            } else if (isVertical && Math.abs(nx - sVert.x) <= 4) {
                                effDx = sVert.x - mOrig.x;
                                STATE.mergeCandidate = { x: sVert.x, y: sVert.y };
                            }
                            continue;
                        }

                        if (isHorizontal && Math.abs(nx - sVert.x) < 4) {
                            const origSign = (mOrig.y + effDy) >= sVert.y && mOrig.y === sVert.y ? 1 : (mOrig.y >= sVert.y ? 1 : -1);
                            if (Math.abs(mOrig.y - sVert.y) >= 1 && (ny - sVert.y) * origSign < 12) {
                                effDy = (sVert.y + origSign * 12) - mOrig.y;
                            }
                        } else if (isVertical && Math.abs(ny - sVert.y) < 4) {
                            const origSign = (mOrig.x + effDx) >= sVert.x && mOrig.x === sVert.x ? 1 : (mOrig.x >= sVert.x ? 1 : -1);
                            if (Math.abs(mOrig.x - sVert.x) >= 1 && (nx - sVert.x) * origSign < 12) {
                                effDx = (sVert.x + origSign * 12) - mOrig.x;
                            }
                        }
                    }
                }

                vertexOrigins.forEach((orig, vid) => {
                    const v = getVertex(vid);
                    if (v) { v.x = orig.x + effDx; v.y = orig.y + effDy; }
                });

                // 动态维护错台墙段与同轴正交分户墙的连接顺序（无论是本次刚拉开还是之前已有的错台墙段），
                // 保证向上拉、向下拉齐或拉过头时两侧房间始终闭合且墙段不重叠
                if (dt.stepChains) {
                    for (const ch of dt.stepChains) {
                        const stepV = getVertex(ch.stepVid), moveV = getVertex(ch.moveVid), farV = getVertex(ch.farVid);
                        const pw = getWall(ch.partWallId);
                        if (!stepV || !moveV || !farV || !pw) continue;
                        const dot = (moveV.x - stepV.x) * (farV.x - stepV.x) + (moveV.y - stepV.y) * (farV.y - stepV.y);
                        const desiredVid = dot > 1 ? moveV.id : stepV.id;
                        if (pw[ch.partEndKey] !== desiredVid) {
                            pw[ch.partEndKey] = desiredVid;
                            topologyChanged = true;
                        }
                    }
                }
                if (dt.detached && dt.blockedEnds) {
                    const handledOld = new Set();
                    for (const b of dt.blockedEnds) {
                        if (!b.newVid || handledOld.has(b.oldVid)) continue;
                        handledOld.add(b.oldVid);
                        const oldV = getVertex(b.oldVid), newV = getVertex(b.newVid);
                        if (!oldV || !newV || !b.perpWalls) continue;
                        for (const pwInfo of b.perpWalls) {
                            const pw = getWall(pwInfo.wallId);
                            if (!pw) continue;
                            const dot = (newV.x - oldV.x) * (pwInfo.farX - oldV.x) + (newV.y - oldV.y) * (pwInfo.farY - oldV.y);
                            const desiredVid = dot > 1 ? b.newVid : b.oldVid;
                            if (pw[pwInfo.endKey] !== desiredVid) {
                                pw[pwInfo.endKey] = desiredVid;
                                topologyChanged = true;
                            }
                        }
                    }
                }

                if (topologyChanged) {
                    syncRoomsFromGeometry({ silent: true });
                } else {
                    recomputeAllRoomTiling();
                }
            } else if (STATE.dragTarget.type === 'opening-endpoint') {
                const dt = STATE.dragTarget;
                const op = STATE.openings.find(o => o.id === dt.id);
                const wall = op ? getWall(op.wallId) : null;
                if (op && wall) {
                    const v1 = getVertex(wall.v1), v2 = getVertex(wall.v2);
                    const wallLen = (v1 && v2) ? dist(v1, v2) : 0;
                    if (wallLen >= 20) {
                        const proj = projectPointToSegment(worldPos, v1, v2);
                        const minWidthPx = 15; // 300mm
                        const maxWidthPx = Math.max(minWidthPx, wallLen - 6);
                        const minRatio = minWidthPx / wallLen;
                        const marginRatio = Math.min(0.08, 4 / wallLen);

                        let tStart = dt.initialTStart;
                        let tEnd = dt.initialTEnd;
                        if (dt.end === 'start') {
                            tStart = Math.max(marginRatio, Math.min(tEnd - minRatio, proj.t));
                        } else {
                            tEnd = Math.min(1 - marginRatio, Math.max(tStart + minRatio, proj.t));
                        }
                        let newWidthPx = (tEnd - tStart) * wallLen;
                        // 按 10mm (0.5px) 步进取整，让宽度数字干净整齐
                        newWidthPx = Math.max(minWidthPx, Math.min(maxWidthPx, Math.round(newWidthPx * 2) / 2));
                        if (dt.end === 'start') {
                            tStart = tEnd - newWidthPx / wallLen;
                        } else {
                            tEnd = tStart + newWidthPx / wallLen;
                        }
                        op.width = newWidthPx;
                        op.t = (tStart + tEnd) * 0.5;
                        recomputeAllRoomTiling();
                        if (STATE.selected?.type === 'opening' && STATE.selected.id === op.id) {
                            updateInspector();
                        }
                        render3DIsometricPreview();
                    }
                }
            } else if (STATE.dragTarget.type === 'opening') {
                const op = STATE.openings.find(o => o.id === STATE.dragTarget.id);
                if (op) {
                    const snap = findNearestWallSnap(worldPos, 40, {
                        snapMidpoint: !STATE.dragAltKey,
                        excludeOpeningId: op.id,
                        openingWidth: op.width || 45
                    });
                    STATE.openingSnapPreview = snap;
                    if (snap) {
                        const w = snap.wall;
                        const v1 = getVertex(w.v1), v2 = getVertex(w.v2);
                        const wallLen = (v1 && v2) ? dist(v1, v2) : 100;
                        const halfPx = snap.snappedMid ? (op.width || 45) * 0.5 : ((op.width || 45) * 0.5 + 3);
                        const halfRatio = Math.min(0.46, halfPx / Math.max(1, wallLen));
                        op.wallId = w.id;
                        op.t = Math.max(halfRatio, Math.min(1 - halfRatio, snap.t));
                        recomputeAllRoomTiling();
                        if (STATE.selected?.type === 'opening' && STATE.selected.id === op.id) updateInspector();
                        render3DIsometricPreview();
                    }
                }
            }
        }

        function setWallExtendDirUI(dir) {
            STATE.wallExtendDir = dir || 'pos';
            const btnNeg = $id('dim-ext-neg');
            const btnPos = $id('dim-ext-pos');
            const btnBoth = $id('dim-ext-both');
            [
                [btnNeg, 'neg'],
                [btnPos, 'pos'],
                [btnBoth, 'both']
            ].forEach(([btn, key]) => {
                if (!btn) return;
                const active = STATE.wallExtendDir === key;
                btn.classList.toggle('ui-btn-primary', active);
            });
        }

        function showDimensionPopover(wall, worldPos, clearPx, kind, opening = null, labelPrefix = null) {
            STATE.editingWallId = wall ? wall.id : null;
            STATE.editingClearPx = clearPx ?? null;
            STATE.editingDimKind = kind || null;
            STATE.editingOpeningDim = opening ? { openingId: opening.id, subKind: kind, labelPrefix: labelPrefix || '边距' } : null;
            STATE.dimInputTyping = false;

            const popover = $id('dim-input-popover');
            const input = $id('dim-input-field');
            const unitEl = $id('dim-input-unit');
            const labelEl = $id('dim-input-label');
            const submitBtn = $id('dim-input-submit');
            const calibBtn = $id('dim-input-calibrate');
            const btnNeg = $id('dim-ext-neg');
            const btnPos = $id('dim-ext-pos');
            const btnBoth = $id('dim-ext-both');

            const v1 = wall ? getVertex(wall.v1) : null, v2 = wall ? getVertex(wall.v2) : null;
            const isVertical = !!(v1 && v2 && Math.abs(v2.y - v1.y) > Math.abs(v2.x - v1.x));

            if (opening) {
                labelEl.textContent = `${labelPrefix || '门窗尺寸'}:`;
                labelEl.classList.remove('hidden');
                submitBtn.classList.remove('hidden');
                calibBtn.classList.add('hidden');
                if (btnNeg) btnNeg.classList.add('hidden');
                if (btnPos) btnPos.classList.add('hidden');
                if (btnBoth) btnBoth.classList.add('hidden');
            } else {
                // 墙体尺寸编辑：显示伸缩方向选择按钮 + 确认应用按钮
                labelEl.classList.add('hidden');
                submitBtn.classList.remove('hidden');
                calibBtn.classList.toggle('hidden', !STATE.bgImage);
                if (btnNeg) {
                    btnNeg.classList.remove('hidden');
                    btnNeg.innerHTML = isVertical ? '<i class="ph ph-caret-up"></i>' : '<i class="ph ph-caret-left"></i>';
                    btnNeg.title = isVertical ? '固定下端，向上端延伸/缩短' : '固定右端，向左端延伸/缩短';
                }
                if (btnPos) {
                    btnPos.classList.remove('hidden');
                    btnPos.innerHTML = isVertical ? '<i class="ph ph-caret-down"></i>' : '<i class="ph ph-caret-right"></i>';
                    btnPos.title = isVertical ? '固定上端，向下端延伸/缩短' : '固定左端，向右端延伸/缩短';
                }
                if (btnBoth) {
                    btnBoth.classList.remove('hidden');
                    btnBoth.innerHTML = isVertical ? '<i class="ph ph-caret-up-down "></i>' : '<i class="ph ph-caret-up-down rotate-90"></i>';
                    btnBoth.title = '中心不动，向两端对称延伸/缩短';
                }
                setWallExtendDirUI(STATE.wallExtendDir || 'pos');
            }
            popover.style.transform = 'translate(-50%, -115%)';
            popover.style.pointerEvents = 'auto';

            const px = (clearPx != null) ? clearPx : (v1 && v2 ? dist(v1, v2) : 50);
            const meters = px / SCALE_PIXELS_PER_METER;
            unitEl.textContent = STATE.unit;
            input.step = STATE.unit === 'mm' ? '10' : STATE.unit === 'cm' ? '1' : '0.05';
            input.value = STATE.unit === 'mm' ? Math.round(meters * 1000) : STATE.unit === 'cm' ? Number((meters * 100).toFixed(1)) : meters.toFixed(2);

            const screen = toScreen(worldPos.x, worldPos.y);
            const cw = container.clientWidth || canvas.clientWidth || 900;
            const chh = container.clientHeight || canvas.clientHeight || 600;
            popover.style.left = `${Math.max(140, Math.min(cw - 140, screen.x))}px`;
            popover.style.top = `${Math.max(44, Math.min(chh - 16, screen.y))}px`;
            popover.classList.remove('hidden');
            render();
            setTimeout(() => { input.focus(); input.select(); }, 30);
        }

        function applyOpeningDimensionChange(openingId, subKind, inputVal, options = {}) {
            const op = STATE.openings.find(o => o.id === openingId);
            if (!op || isNaN(inputVal) || inputVal < 0) return;
            const wall = getWall(op.wallId);
            if (!wall) return;
            const v1 = getVertex(wall.v1), v2 = getVertex(wall.v2);
            if (!v1 || !v2) return;
            const wallLen = dist(v1, v2);
            if (wallLen < 12) return;

            const meters = options.isMM ? (inputVal / 1000) : (Units.toMM(inputVal) / 1000);
            const targetPx = meters * SCALE_PIXELS_PER_METER;
            const minEdgeMarginPx = 2; // 40mm 最小留边
            const minWidthPx = 15;     // 300mm 最小门窗宽

            if ( options.recordHistory !== false ) saveHistory();

            if (subKind === 'opening-width') {
                const maxW = Math.max(minWidthPx, wallLen - minEdgeMarginPx * 2);
                const newW = Math.max(minWidthPx, Math.min(maxW, targetPx));
                op.width = newW;
                const halfRatio = (newW / 2) / wallLen;
                const marginRatio = minEdgeMarginPx / wallLen;
                op.t = Math.max(halfRatio + marginRatio, Math.min(1 - halfRatio - marginRatio, op.t));
                showToast(`${op.type === 'window' ? '窗宽' : '门宽'}已精准调整为 ${formatMeasureValue(newW / SCALE_PIXELS_PER_METER)}`);
            } else if (subKind === 'opening-d1') {
                const widthPx = op.width || 45;
                const maxD1 = Math.max(0, wallLen - widthPx - minEdgeMarginPx);
                const newD1 = Math.max(0, Math.min(maxD1, targetPx));
                op.t = (newD1 + widthPx * 0.5) / wallLen;
                showToast(`距墙起点距离已精准调整为 ${formatMeasureValue(newD1 / SCALE_PIXELS_PER_METER)}`);
            } else if (subKind === 'opening-d2') {
                const widthPx = op.width || 45;
                const maxD2 = Math.max(0, wallLen - widthPx - minEdgeMarginPx);
                const newD2 = Math.max(0, Math.min(maxD2, targetPx));
                op.t = (wallLen - newD2 - widthPx * 0.5) / wallLen;
                showToast(`距墙终点距离已精准调整为 ${formatMeasureValue(newD2 / SCALE_PIXELS_PER_METER)}`);
            }

            refreshViews({ tiling: true, panel: true, inspector: true, results: true, preview3d: true });
        }

        function applyNewWallLength(wallId, inputVal, options = {}) {
            const wall = getWall(wallId);
            if (!wall || isNaN(inputVal) || inputVal <= 0) return;
            const newLengthMeters = (options.isMeters ? inputVal : (Units.toMM(inputVal) / 1000));
            if (newLengthMeters <= 0.15) return;

            saveHistory();
            const v1 = getVertex(wall.v1), v2 = getVertex(wall.v2);
            if (!v1 || !v2) return;

            const currentDist = dist(v1, v2);
            let targetPixels = newLengthMeters * SCALE_PIXELS_PER_METER;
            if (options.clearPx && options.clearPx > 0.001) {
                targetPixels = targetPixels + (currentDist - options.clearPx);
            }
            const delta = targetPixels - currentDist;
            if (Math.abs(delta) < 0.01) return;

            const isHorizontal = Math.abs(v1.y - v2.y) < 4;
            const isVertical = Math.abs(v1.x - v2.x) < 4;
            const dir = options.extendDir || STATE.wallExtendDir || 'pos';

            // 沿着墙体方向的单位轴向量 (水平墙固定指向右 +X，垂直墙固定指向下 +Y，斜墙指向 X 较大端)
            let ux = 1, uy = 0;
            let vNeg = v1, vPos = v2;
            if (isHorizontal) {
                ux = 1; uy = 0;
                if (v1.x <= v2.x) { vNeg = v1; vPos = v2; } else { vNeg = v2; vPos = v1; }
            } else if (isVertical) {
                ux = 0; uy = 1;
                if (v1.y <= v2.y) { vNeg = v1; vPos = v2; } else { vNeg = v2; vPos = v1; }
            } else {
                const len = Math.max(1e-3, currentDist);
                const forward = (v2.x > v1.x || (Math.abs(v2.x - v1.x) < 1 && v2.y >= v1.y));
                vNeg = forward ? v1 : v2;
                vPos = forward ? v2 : v1;
                ux = (vPos.x - vNeg.x) / len;
                uy = (vPos.y - vNeg.y) / len;
            }

            // 平移指定端点，并自动连带平移与该端垂直共线的对侧墙角点，保持房间矩形不歪斜
            const shiftEndpoint = (endVert, shiftAmount) => {
                if (!endVert || Math.abs(shiftAmount) < 1e-4) return;
                const oldX = endVert.x, oldY = endVert.y;
                const dx = ux * shiftAmount, dy = uy * shiftAmount;
                const movedIds = new Set([endVert.id]);
                endVert.x += dx;
                endVert.y += dy;

                if (isHorizontal || isVertical) {
                    // 找出与该端点通过垂直侧墙相连的对面节点（或同一垂线上的相邻角点），同步平移
                    const queue = [{ x: oldX, y: oldY }];
                    const tol = 2.0;
                    while (queue.length > 0) {
                        const cur = queue.shift();
                        for (const w of STATE.walls) {
                            if (w.id === wall.id) continue;
                            const a = getVertex(w.v1), b = getVertex(w.v2);
                            if (!a || !b) continue;
                            // 仅沿与当前墙正交的侧墙传递位移
                            const wIsV = Math.abs(a.x - b.x) < 4;
                            const wIsH = Math.abs(a.y - b.y) < 4;
                            if ((isHorizontal && !wIsV) || (isVertical && !wIsH)) continue;
                            if (Math.hypot(a.x - cur.x, a.y - cur.y) <= tol && !movedIds.has(b.id)) {
                                const prev = { x: b.x, y: b.y };
                                movedIds.add(b.id);
                                b.x += dx; b.y += dy;
                                queue.push(prev);
                            } else if (Math.hypot(b.x - cur.x, b.y - cur.y) <= tol && !movedIds.has(a.id)) {
                                const prev = { x: a.x, y: a.y };
                                movedIds.add(a.id);
                                a.x += dx; a.y += dy;
                                queue.push(prev);
                            }
                        }
                    }
                }
            };

            if (dir === 'neg') {
                shiftEndpoint(vNeg, -delta);
            } else if (dir === 'both') {
                shiftEndpoint(vNeg, -delta * 0.5);
                shiftEndpoint(vPos, delta * 0.5);
            } else {
                shiftEndpoint(vPos, delta);
            }

            syncRoomsFromGeometry({ silent: true });
            updateInspector();
            render();
            const dirLabel = dir === 'neg'
                ? (isVertical ? '向上' : '向左')
                : (dir === 'both' ? '向两端对称' : (isVertical ? '向下' : '向右'));
            showToast(`墙体已${dirLabel}调整为 ${formatMeasureValue(newLengthMeters)}`);
        }

        function calibrateWholePlanByWall(wallId, inputVal, options = {}) {
            const wall = getWall(wallId);
            if (!wall || isNaN(inputVal) || inputVal <= 0) return;
            const targetMeters = options.isMeters ? inputVal : (Units.toMM(inputVal) / 1000);
            if (targetMeters <= 0.1) return;

            const v1 = getVertex(wall.v1), v2 = getVertex(wall.v2);
            if (!v1 || !v2) return;
            const currentPx = options.clearPx || dist(v1, v2);
            if (currentPx < 1) return;

            const desiredPx = targetMeters * SCALE_PIXELS_PER_METER;
            const factor = desiredPx / currentPx;
            if (Math.abs(factor - 1) < 0.001) return;

            saveHistory();
            const anchor = { x: v1.x, y: v1.y };
            for (const v of STATE.vertices) {
                v.x = anchor.x + (v.x - anchor.x) * factor;
                v.y = anchor.y + (v.y - anchor.y) * factor;
            }
            for (const op of STATE.openings) {
                op.width = (op.width || 45) * factor;
            }
            for (const r of STATE.rooms) {
                if (r.originX != null && r.originY != null) {
                    r.originX = anchor.x + (r.originX - anchor.x) * factor;
                    r.originY = anchor.y + (r.originY - anchor.y) * factor;
                }
            }
            if (STATE.bgImage) {
                STATE.bgOffsetX = anchor.x + (STATE.bgOffsetX - anchor.x) * factor;
                STATE.bgOffsetY = anchor.y + (STATE.bgOffsetY - anchor.y) * factor;
                STATE.bgWorldScale *= factor;
            }

            syncRoomsFromGeometry({ silent: true });
            fitCanvasToContent();
            updateInspector();
            render();
            showToast(`全图比例已按基准墙 (${formatMeasureValue(targetMeters)}) 校准！所有房间面积与排砖已同步重算`);
        }

        function commitWallEndpoint(worldPos, { exact = false } = {}) {
            if (!STATE.wallStartVertex) return false;
            let fixed;
            if (exact) {
                // 键盘定长输入：严格保留用户输入的精确坐标与长度，禁止对齐线 / 网格 / 大范围端点吸附与未重归一的轴向压平；
                // 仅在终点与已有顶点或墙线几乎重合（≤ 0.15px = 3mm）时执行精确闭合/T字连接
                const EXACT_TOL = 0.15;
                let x = worldPos.x, y = worldPos.y;
                let vertex = null, wallSnap = null;
                let bestVDist = EXACT_TOL;
                for (const v of STATE.vertices) {
                    if (v.id === STATE.wallStartVertex.id) continue;
                    const d = Math.hypot(v.x - x, v.y - y);
                    if (d <= bestVDist) { bestVDist = d; vertex = v; }
                }
                if (vertex) {
                    x = vertex.x; y = vertex.y;
                } else {
                    let bestWDist = EXACT_TOL;
                    for (const wall of STATE.walls) {
                        const a = getVertex(wall.v1), b = getVertex(wall.v2);
                        if (!a || !b) continue;
                        const proj = projectPointToSegment({ x, y }, a, b);
                        if (proj.t > 0.005 && proj.t < 0.995 && proj.distance <= bestWDist) {
                            bestWDist = proj.distance;
                            wallSnap = { wall, t: proj.t };
                            x = proj.projPoint.x;
                            y = proj.projPoint.y;
                        }
                    }
                }
                fixed = { x, y, vertex, wallSnap };
            } else {
                const snapped = snapPos(worldPos);
                fixed = smartCloseWallEnd(STATE.wallStartVertex, snapped);
            }
            const isEndAlreadyVertex = !!fixed.vertex || !!fixed.wallSnap;
            let endV = fixed.vertex;
            if (!endV) {
                endV = { id: uid('v_'), x: fixed.x, y: fixed.y };
                STATE.vertices.push(endV);
                if (fixed.wallSnap) splitWallAt(fixed.wallSnap.wall, endV, fixed.wallSnap.t);
            }

            const dupWall = STATE.walls.find(w =>
                (w.v1 === STATE.wallStartVertex.id && w.v2 === endV.id) ||
                (w.v2 === STATE.wallStartVertex.id && w.v1 === endV.id));

            if (endV.id !== STATE.wallStartVertex.id && !dupWall) {
                saveHistory();
                STATE.walls.push({
                    id: uid('w_'),
                    v1: STATE.wallStartVertex.id,
                    v2: endV.id,
                    thickness: mmToPx(PRESETS.draw.wallThicknessMM)
                });

                const mergeA = mergeCollinearWallsAt(STATE.wallStartVertex.id);
                const mergeB = mergeCollinearWallsAt(endV.id);
                if (mergeA || mergeB) removeOrphanVertices();
                if (mergeB && !getVertex(endV.id)) {
                    const near = [getVertex(mergeB.v1), getVertex(mergeB.v2)].filter(Boolean)
                        .sort((p, q) => dist(p, endV) - dist(q, endV))[0];
                    if (near) endV = near;
                }

                syncRoomsFromGeometry();
                if (isEndAlreadyVertex) {
                    setTool('select');
                    showToast('墙段闭合连通完成，已自动识别算量空间');
                    render();
                    STATE.dimInputTyping = false;
                    STATE.lastWallDraftDir = null;
                    return true;
                }
            }
            STATE.wallStartVertex = endV;
            STATE.dimInputTyping = false;
            STATE.lastWallDraftDir = null;
            return false;
        }

        function commitDraftLength(val) {
            if (STATE.tool !== 'wall' || !STATE.wallStartVertex) return false;
            const meters = Units.toMM(val) / 1000;
            if (isNaN(meters) || meters <= 0.05) return false;
            const v1 = STATE.wallStartVertex;
            let ux = 0, uy = 0;
            if (STATE.wallDraft) {
                const dx = STATE.wallDraft.x - v1.x, dy = STATE.wallDraft.y - v1.y;
                const len = Math.hypot(dx, dy);
                if (len >= 0.5) {
                    if (Math.abs(dy) <= 1e-6) { ux = dx >= 0 ? 1 : -1; uy = 0; }
                    else if (Math.abs(dx) <= 1e-6) { ux = 0; uy = dy >= 0 ? 1 : -1; }
                    else { ux = dx / len; uy = dy / len; }
                }
            }
            if (ux === 0 && uy === 0 && STATE.lastWallDraftDir) {
                ux = STATE.lastWallDraftDir.ux;
                uy = STATE.lastWallDraftDir.uy;
            }
            if (ux === 0 && uy === 0) return false;
            const target = meters * SCALE_PIXELS_PER_METER;
            const finished = commitWallEndpoint({
                x: v1.x + ux * target,
                y: v1.y + uy * target
            }, { exact: true });
            STATE.activeSnapLines = [];
            STATE.dimInputTyping = false;
            render();
            return !finished;
        }

        let g_draftLookOn = false;
        function isInputAllSelected(el) {
            try {
                const v = el.value || '';
                return v.length > 0 && el.selectionStart === 0 && el.selectionEnd === v.length;
            } catch (e) { return false; }
        }

        function updateDraftLengthPopover() {
            const popover = $id('dim-input-popover');
            const input = $id('dim-input-field');
            const label = $id('dim-input-label');
            const unitEl = $id('dim-input-unit');
            const submit = $id('dim-input-submit');
            const calib = $id('dim-input-calibrate');
            if (!popover || !input) return;

            const setDraftLook = (on) => {
                label.classList.toggle('hidden', on);
                submit.classList.toggle('hidden', on);
                calib.classList.toggle('hidden', on || !STATE.bgImage);
                if (on) {
                    $id('dim-ext-neg')?.classList.add('hidden');
                    $id('dim-ext-pos')?.classList.add('hidden');
                    $id('dim-ext-both')?.classList.add('hidden');
                }
                // 画墙实时定长输入框严格以墙体中心点 (50%, 50%) 居中对齐在墙段正中央
                popover.style.transform = on ? 'translate(-50%, -50%)' : 'translate(-50%, -115%)';
                popover.style.pointerEvents = on ? 'none' : 'auto';
                g_draftLookOn = on;
            };

            if (STATE.tool !== 'wall') STATE.draftPopoverDismissed = false;
            const drawing = STATE.tool === 'wall' && !!STATE.wallStartVertex &&
                !!STATE.wallDraft && !STATE.draftPopoverDismissed && !STATE.editingWallId;

            if (!drawing) {
                if (STATE.draftPopoverShown || g_draftLookOn) {
                    popover.classList.add('hidden');
                    STATE.draftPopoverShown = false;
                    setDraftLook(false);
                }
                return;
            }

            const len = dist(STATE.wallStartVertex, STATE.wallDraft);
            if (len < 6) {
                if (STATE.draftPopoverShown) {
                    popover.classList.add('hidden');
                    STATE.draftPopoverShown = false;
                }
                return;
            }

            const v1 = STATE.wallStartVertex;
            const midWorldX = (v1.x + STATE.wallDraft.x) * 0.5;
            const midWorldY = (v1.y + STATE.wallDraft.y) * 0.5;
            const mid = toScreen(midWorldX, midWorldY);
            const cw = container.clientWidth || canvas.clientWidth || 900;
            const chh = container.clientHeight || canvas.clientHeight || 600;
            // 仅在超出画布可视边界时做安全保护，保证正常绘制时 100% 居中于墙段中点
            popover.style.left = Math.max(44, Math.min(cw - 44, mid.x)) + 'px';
            popover.style.top = Math.max(24, Math.min(chh - 24, mid.y)) + 'px';
            popover.classList.remove('hidden');
            setDraftLook(true);
            unitEl.textContent = STATE.unit;
            STATE.draftPopoverShown = true;
            STATE.editingWallId = null;

            if (!STATE.dimInputTyping) {
                const meters = len / SCALE_PIXELS_PER_METER;
                const txt = STATE.unit === 'mm' ? String(Math.round(meters * 1000)) : STATE.unit === 'cm' ? String(Number((meters * 100).toFixed(1))) : meters.toFixed(2);
                if (document.activeElement !== input) input.focus({ preventScroll: true });
                if (input.value !== txt) input.value = txt;
                if (!isInputAllSelected(input)) input.select();
            }
        }

        /*************************************************************************
         * 八、四阶段户型图导入与识别引擎
         *************************************************************************/
        function clusterAndMergeRuns(runs, isHorizontal, minThick, maxThick) {
            if (runs.length === 0) return [];
            runs.sort((a, b) => (isHorizontal ? (a.y - b.y || a.x1 - b.x1) : (a.x - b.x || a.y1 - b.y1)));
            const clusters = [];
            for (const r of runs) {
                const pos = isHorizontal ? r.y : r.x;
                const s1 = isHorizontal ? r.x1 : r.y1;
                const s2 = isHorizontal ? r.x2 : r.y2;
                let matched = null;
                for (const c of clusters) {
                    const distPos = Math.abs(pos - c.lastPos);
                    const overlap = Math.min(s2, c.maxSpan) - Math.max(s1, c.minSpan);
                    if (distPos <= 3 && overlap >= -8) { matched = c; break; }
                }
                if (matched) {
                    matched.positions.push(pos);
                    matched.lastPos = pos;
                    matched.minSpan = Math.min(matched.minSpan, s1);
                    matched.maxSpan = Math.max(matched.maxSpan, s2);
                    matched.spans.push([s1, s2]);
                } else {
                    clusters.push({ positions: [pos], firstPos: pos, lastPos: pos, minSpan: s1, maxSpan: s2, spans: [[s1, s2]] });
                }
            }

            const centerlines = [];
            for (const c of clusters) {
                const thickness = c.lastPos - c.firstPos + 1;
                if (thickness < Math.max(2, minThick - 2) || thickness > maxThick + 8) continue;
                const centerCoord = Math.round((c.firstPos + c.lastPos) / 2);
                const spanHist = new Uint16Array(c.maxSpan - c.minSpan + 2);
                for (const [a, b] of c.spans) {
                    for (let k = a; k <= b; k++) spanHist[k - c.minSpan]++;
                }
                const minSupport = Math.max(2, Math.floor(thickness * 0.4));
                let segStart = -1;
                for (let i = 0; i <= c.maxSpan - c.minSpan + 1; i++) {
                    const active = spanHist[i] >= minSupport;
                    if (active && segStart === -1) {
                        segStart = c.minSpan + i;
                    } else if (!active && segStart !== -1) {
                        const segEnd = c.minSpan + i - 1;
                        if (segEnd - segStart >= 18) {
                            if (isHorizontal) centerlines.push({ x1: segStart, y1: centerCoord, x2: segEnd, y2: centerCoord, orient: 'H', thickness });
                            else centerlines.push({ x1: centerCoord, y1: segStart, x2: centerCoord, y2: segEnd, orient: 'V', thickness });
                        }
                        segStart = -1;
                    }
                }
            }

            const consolidated = [];
            centerlines.sort((a, b) => isHorizontal ? (a.y1 - b.y1 || a.x1 - b.x1) : (a.x1 - b.x1 || a.y1 - b.y1));
            for (const seg of centerlines) {
                let merged = false;
                for (let i = consolidated.length - 1; i >= 0; i--) {
                    const prev = consolidated[i];
                    if (isHorizontal && Math.abs(prev.y1 - seg.y1) <= 5 && seg.x1 - prev.x2 <= 10 && seg.x2 >= prev.x1 - 10) {
                        prev.x1 = Math.min(prev.x1, seg.x1);
                        prev.x2 = Math.max(prev.x2, seg.x2);
                        prev.y1 = prev.y2 = Math.round((prev.y1 + seg.y1) / 2);
                        merged = true;
                        break;
                    }
                    if (!isHorizontal && Math.abs(prev.x1 - seg.x1) <= 5 && seg.y1 - prev.y2 <= 10 && seg.y2 >= prev.y1 - 10) {
                        prev.y1 = Math.min(prev.y1, seg.y1);
                        prev.y2 = Math.max(prev.y2, seg.y2);
                        prev.x1 = prev.x2 = Math.round((prev.x1 + seg.x1) / 2);
                        merged = true;
                        break;
                    }
                }
                if (!merged) consolidated.push({ ...seg });
            }
            return consolidated;
        }

        function snapWallCorners(hWalls, vWalls, snapTolerance = 18) {
            for (const hw of hWalls) {
                for (const vw of vWalls) {
                    if (Math.abs(hw.x1 - vw.x1) <= snapTolerance && hw.y1 >= vw.y1 - snapTolerance && hw.y1 <= vw.y2 + snapTolerance) hw.x1 = vw.x1;
                    if (Math.abs(hw.x2 - vw.x1) <= snapTolerance && hw.y2 >= vw.y1 - snapTolerance && hw.y2 <= vw.y2 + snapTolerance) hw.x2 = vw.x1;
                    if (Math.abs(vw.y1 - hw.y1) <= snapTolerance && vw.x1 >= hw.x1 - snapTolerance && vw.x1 <= hw.x2 + snapTolerance) vw.y1 = hw.y1;
                    if (Math.abs(vw.y2 - hw.y1) <= snapTolerance && vw.x2 >= hw.x1 - snapTolerance && vw.x2 <= hw.x2 + snapTolerance) vw.y2 = hw.y1;
                }
            }
            return [...hWalls, ...vWalls];
        }

        function cluster1DCoords(arr, tol) {
            if (!arr.length) return [];
            const sorted = [...arr].sort((a, b) => a - b);
            const res = [sorted[0]];
            for (let i = 1; i < sorted.length; i++) {
                if (sorted[i] - res[res.length - 1] > tol) res.push(sorted[i]);
                else res[res.length - 1] = Math.round((res[res.length - 1] + sorted[i]) / 2);
            }
            return res;
        }

        function buildTopologyFromRecognizedSegments(rawWalls, rawDoors) {
            STATE.vertices = [];
            STATE.walls = [];
            STATE.openings = [];
            STATE.rooms = [];

            const hWalls = rawWalls.filter(w => Math.abs(w.y1 - w.y2) <= 3).map(w => ({ ...w, origY: w.y1 }));
            const vWalls = rawWalls.filter(w => Math.abs(w.x1 - w.x2) <= 3).map(w => ({ ...w, origX: w.x1 }));

            const vXCoords = cluster1DCoords(vWalls.map(w => w.x1), 14);
            const hYCoords = cluster1DCoords(hWalls.map(w => w.y1), 14);
            const snapToCluster = (val, clusters, tol = 14) => {
                for (const c of clusters) if (Math.abs(val - c) <= tol) return c;
                return Math.round(val);
            };

            for (const hw of hWalls) {
                hw.y1 = hw.y2 = snapToCluster(hw.y1, hYCoords);
                hw.x1 = snapToCluster(hw.x1, vXCoords);
                hw.x2 = snapToCluster(hw.x2, vXCoords);
                if (hw.x1 > hw.x2) { const t = hw.x1; hw.x1 = hw.x2; hw.x2 = t; }
            }
            for (const vw of vWalls) {
                vw.x1 = vw.x2 = snapToCluster(vw.x1, vXCoords);
                vw.y1 = snapToCluster(vw.y1, hYCoords);
                vw.y2 = snapToCluster(vw.y2, hYCoords);
                if (vw.y1 > vw.y2) { const t = vw.y1; vw.y1 = vw.y2; vw.y2 = t; }
            }

            const mergeCollinearWithDoors = (list, isH) => {
                list.sort((a, b) => isH ? (a.y1 - b.y1 || a.x1 - b.x1) : (a.x1 - b.x1 || a.y1 - b.y1));
                const out = [];
                for (const seg of list) {
                    const prev = out[out.length - 1];
                    if (prev) {
                        const sameAxis = isH ? (prev.y1 === seg.y1) : (prev.x1 === seg.x1);
                        const gap = isH ? (seg.x1 - prev.x2) : (seg.y1 - prev.y2);
                        const origDiff = isH
                            ? Math.abs((prev.origY ?? prev.y1) - (seg.origY ?? seg.y1))
                            : Math.abs((prev.origX ?? prev.x1) - (seg.origX ?? seg.x1));
                        if (sameAxis && gap >= -6 && gap <= 200 && origDiff <= 8) {
                            if (gap >= 24) {
                                rawDoors.push({
                                    x1: isH ? prev.x2 : prev.x1,
                                    y1: isH ? prev.y1 : prev.y2,
                                    x2: isH ? seg.x1 : seg.x1,
                                    y2: isH ? seg.y1 : seg.y1
                                });
                            }
                            if (isH) {
                                prev.x2 = Math.max(prev.x2, seg.x2);
                                prev.origY = seg.origY;
                            } else {
                                prev.y2 = Math.max(prev.y2, seg.y2);
                                prev.origX = seg.origX;
                            }
                            continue;
                        }
                    }
                    out.push(seg);
                }
                return out;
            };

            const mergedH = mergeCollinearWithDoors(hWalls, true);
            const mergedV = mergeCollinearWithDoors(vWalls, false);
            snapWallCorners(mergedH, mergedV, 18);

            // 针对转角门洞与悬空端点的正交桥接闭合
            const hasVAt = (x, y, tol = 12) => mergedV.some(vw => Math.abs(vw.x1 - x) <= tol && y >= vw.y1 - tol && y <= vw.y2 + tol);
            const hasHAt = (x, y, tol = 12) => mergedH.some(hw => Math.abs(hw.y1 - y) <= tol && x >= hw.x1 - tol && x <= hw.x2 + tol);
            const maxDoorBridge = 220;
            for (const vw of mergedV) {
                if (!hasHAt(vw.x1, vw.y1)) {
                    let bestH = null, bestGap = maxDoorBridge;
                    for (const hw of mergedH) {
                        const gap = vw.y1 - hw.y1;
                        if (gap > 0 && gap <= bestGap && vw.x1 >= hw.x1 - 70 && vw.x1 <= hw.x2 + 70) {
                            bestGap = gap; bestH = hw;
                        }
                    }
                    if (bestH) {
                        if (bestGap >= 24) rawDoors.push({ x1: vw.x1, y1: bestH.y1, x2: vw.x1, y2: vw.y1 });
                        vw.y1 = bestH.y1;
                        if (vw.x1 < bestH.x1) bestH.x1 = vw.x1;
                        if (vw.x1 > bestH.x2) bestH.x2 = vw.x1;
                    }
                }
                if (!hasHAt(vw.x2, vw.y2)) {
                    let bestH = null, bestGap = maxDoorBridge;
                    for (const hw of mergedH) {
                        const gap = hw.y1 - vw.y2;
                        if (gap > 0 && gap <= bestGap && vw.x1 >= hw.x1 - 70 && vw.x1 <= hw.x2 + 70) {
                            bestGap = gap; bestH = hw;
                        }
                    }
                    if (bestH) {
                        if (bestGap >= 24) rawDoors.push({ x1: vw.x1, y1: vw.y2, x2: vw.x1, y2: bestH.y1 });
                        vw.y2 = bestH.y1;
                        if (vw.x1 < bestH.x1) bestH.x1 = vw.x1;
                        if (vw.x1 > bestH.x2) bestH.x2 = vw.x1;
                    }
                }
            }
            for (const vw of mergedV) {
                for (const hw of mergedH) {
                    if (Math.abs(vw.x1 - hw.x1) <= 15 || Math.abs(vw.x1 - hw.x2) <= 15) {
                        if (vw.y1 > hw.y1 && vw.y1 - hw.y1 <= 60) vw.y1 = hw.y1;
                        if (vw.y2 < hw.y1 && hw.y1 - vw.y2 <= 60) vw.y2 = hw.y1;
                    }
                }
            }
            for (const vw of mergedV) {
                const crossesH = (x, y) => mergedH.some(hw => Math.abs(hw.y1 - y) <= 8 && x > hw.x1 + 15 && x < hw.x2 - 15);
                if (!crossesH(vw.x1, vw.y1)) {
                    for (const hw of mergedH) {
                        const gap = vw.y1 - hw.y1;
                        if (gap >= 24 && gap <= 120 && vw.x1 >= hw.x1 - 15 && vw.x1 <= hw.x2 + 15) {
                            const hasParallelV = mergedV.some(other => other !== vw && Math.abs(other.x1 - vw.x1) < 150 && other.y1 <= hw.y1 + 10 && other.y2 >= vw.y1 - 10);
                            if (!hasParallelV) {
                                rawDoors.push({ x1: vw.x1, y1: hw.y1, x2: vw.x1, y2: vw.y1 });
                                vw.y1 = hw.y1;
                                break;
                            }
                        }
                    }
                }
            }
            for (const hw of mergedH) {
                if (!hasVAt(hw.x1, hw.y1, 12)) {
                    const hasInnerV = mergedV.some(vw => vw.x1 > hw.x1 + 12 && vw.x1 - hw.x1 <= 55 && hw.y1 >= vw.y1 - 12 && hw.y1 <= vw.y2 + 12);
                    let bestV = null, bestGap = hasInnerV ? 95 : maxDoorBridge;
                    for (const vw of mergedV) {
                        const gap = hw.x1 - vw.x1;
                        if (gap > 0 && gap <= bestGap && hw.y1 >= vw.y1 - 24 && hw.y1 <= vw.y2 + 24) {
                            bestGap = gap; bestV = vw;
                        }
                    }
                    if (bestV) {
                        if (bestGap >= 24) rawDoors.push({ x1: bestV.x1, y1: hw.y1, x2: hw.x1, y2: hw.y1 });
                        hw.x1 = bestV.x1;
                    }
                }
                if (!hasVAt(hw.x2, hw.y2, 12)) {
                    const hasInnerV = mergedV.some(vw => hw.x2 > vw.x1 + 12 && hw.x2 - vw.x1 <= 55 && hw.y2 >= vw.y1 - 12 && hw.y2 <= vw.y2 + 12);
                    let bestV = null, bestGap = hasInnerV ? 95 : maxDoorBridge;
                    for (const vw of mergedV) {
                        const gap = vw.x1 - hw.x2;
                        if (gap > 0 && gap <= bestGap && hw.y1 >= vw.y1 - 24 && hw.y1 <= vw.y2 + 24) {
                            bestGap = gap; bestV = vw;
                        }
                    }
                    if (bestV) {
                        if (bestGap >= 24) rawDoors.push({ x1: hw.x2, y1: hw.y1, x2: bestV.x1, y2: hw.y1 });
                        hw.x2 = bestV.x1;
                    }
                }
            }
            const allSegs = snapWallCorners(mergedH, mergedV, 18);

            const getOrCreateVertex = (x, y) => {
                const rx = Math.round(x), ry = Math.round(y);
                for (const v of STATE.vertices) {
                    if (Math.hypot(v.x - rx, v.y - ry) <= 8) return v;
                }
                const nv = { id: uid('v_'), x: rx, y: ry };
                STATE.vertices.push(nv);
                return nv;
            };

            for (const s of allSegs) {
                getOrCreateVertex(s.x1, s.y1);
                getOrCreateVertex(s.x2, s.y2);
            }
            for (const hw of mergedH) {
                for (const vw of mergedV) {
                    if (vw.x1 >= hw.x1 - 8 && vw.x1 <= hw.x2 + 8 && hw.y1 >= vw.y1 - 8 && hw.y1 <= vw.y2 + 8) {
                        getOrCreateVertex(vw.x1, hw.y1);
                    }
                }
            }

            for (const s of allSegs) {
                const isH = Math.abs(s.y1 - s.y2) <= 2;
                const onSegVerts = STATE.vertices.filter(v => {
                    if (isH) return Math.abs(v.y - s.y1) <= 6 && v.x >= Math.min(s.x1, s.x2) - 6 && v.x <= Math.max(s.x1, s.x2) + 6;
                    return Math.abs(v.x - s.x1) <= 6 && v.y >= Math.min(s.y1, s.y2) - 6 && v.y <= Math.max(s.y1, s.y2) + 6;
                });
                onSegVerts.sort((a, b) => isH ? (a.x - b.x) : (a.y - b.y));
                for (let i = 0; i < onSegVerts.length - 1; i++) {
                    const va = onSegVerts[i], vb = onSegVerts[i + 1];
                    if (va.id === vb.id || dist(va, vb) < 10) continue;
                    const exists = STATE.walls.some(w =>
                        (w.v1 === va.id && w.v2 === vb.id) || (w.v1 === vb.id && w.v2 === va.id));
                    if (!exists) {
                        STATE.walls.push({
                            id: uid('w_'),
                            v1: va.id,
                            v2: vb.id,
                            thickness: Math.min(20, Math.max(10, Math.round(s.thickness || 12)))
                        });
                    }
                }
            }

            removeOrphanVertices();

            const seenDoorCenters = [];
            for (const d of rawDoors) {
                const cx = (d.x1 + d.x2) / 2, cy = (d.y1 + d.y2) / 2;
                if (seenDoorCenters.some(p => Math.hypot(p.x - cx, p.y - cy) < 25)) continue;
                seenDoorCenters.push({ x: cx, y: cy });
                const snap = findNearestWallSnap({ x: cx, y: cy }, 24);
                if (snap) {
                    const widthPx = Math.max(32, Math.min(60, Math.hypot(d.x2 - d.x1, d.y2 - d.y1)));
                    STATE.openings.push({
                        id: uid('op_'),
                        wallId: snap.wall.id,
                        t: snap.t,
                        width: widthPx,
                        type: 'door',
                        flip: cy > 400,
                        hinge: 0
                    });
                }
            }

            syncRoomsFromGeometry({ silent: true });
            if (STATE.ocrRoomLabels && STATE.ocrRoomLabels.length > 0) {
                applyOcrLabelsToRooms(STATE.ocrRoomLabels, { silent: true });
            }
        }

        function executeRecognitionPipeline() {
            if (!STATE.bgImage) return;
            const W = STATE.imageWidth, H = STATE.imageHeight;
            const readParam = (inputId, fallback) => {
                const v = parseInt($id(inputId).value, 10);
                return Number.isNaN(v) ? fallback : v;
            };
            const lumMin = readParam('paramLumMin', 108);
            const lumMax = readParam('paramLumMax', 180);
            const maxChroma = readParam('paramMaxChroma', 20);
            const minThick = readParam('paramMinThick', 6);
            const maxThick = readParam('paramMaxThick', 38);
            const minWallLen = readParam('paramMinWallLen', 28);

            const workCanvas = document.createElement('canvas');
            workCanvas.width = W; workCanvas.height = H;
            const wCtx = workCanvas.getContext('2d');
            wCtx.drawImage(STATE.bgImage, 0, 0, W, H);
            const imgData = wCtx.getImageData(0, 0, W, H).data;

            const rawMask = new Uint8Array(W * H);
            const stage1Can = document.createElement('canvas');
            stage1Can.width = W; stage1Can.height = H;
            const s1Ctx = stage1Can.getContext('2d');
            const s1Img = s1Ctx.createImageData(W, H);

            for (let y = 0; y < H; y++) {
                const rowOffset = y * W;
                for (let x = 0; x < W; x++) {
                    const idx = (rowOffset + x) * 4;
                    if (imgData[idx + 3] < 128) continue;
                    const r = imgData[idx], g = imgData[idx + 1], b = imgData[idx + 2];
                    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
                    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
                    if (lum >= lumMin && lum <= lumMax && chroma <= maxChroma) {
                        rawMask[rowOffset + x] = 1;
                        s1Img.data[idx] = 37; s1Img.data[idx + 1] = 99; s1Img.data[idx + 2] = 235; s1Img.data[idx + 3] = 235;
                    } else {
                        s1Img.data[idx] = Math.round(r * 0.22);
                        s1Img.data[idx + 1] = Math.round(g * 0.22);
                        s1Img.data[idx + 2] = Math.round(b * 0.26);
                        s1Img.data[idx + 3] = 255;
                    }
                }
            }
            s1Ctx.putImageData(s1Img, 0, 0);
            STATE.stage1Canvas = stage1Can;

            // 滤除细小噪点/水磨石颗粒 (< 45 像素连通域)，防止形态学闭运算将其与墙体桥接导致墙厚失真
            const visited = new Uint8Array(W * H);
            const ccStack = new Int32Array(W * H);
            const ccPixels = new Int32Array(W * H);
            for (let i = 0; i < W * H; i++) {
                if (!rawMask[i] || visited[i]) continue;
                let sp = 0, cnt = 0;
                ccStack[sp++] = i;
                visited[i] = 1;
                while (sp > 0) {
                    const p = ccStack[--sp];
                    ccPixels[cnt++] = p;
                    const x = p % W, y = (p / W) | 0;
                    if (x > 0 && rawMask[p - 1] && !visited[p - 1]) { visited[p - 1] = 1; ccStack[sp++] = p - 1; }
                    if (x < W - 1 && rawMask[p + 1] && !visited[p + 1]) { visited[p + 1] = 1; ccStack[sp++] = p + 1; }
                    if (y > 0 && rawMask[p - W] && !visited[p - W]) { visited[p - W] = 1; ccStack[sp++] = p - W; }
                    if (y < H - 1 && rawMask[p + W] && !visited[p + W]) { visited[p + W] = 1; ccStack[sp++] = p + W; }
                }
                if (cnt < 45) {
                    for (let k = 0; k < cnt; k++) rawMask[ccPixels[k]] = 0;
                }
            }

            const closedMask = new Uint8Array(rawMask);
            const gapBridgeMax = 5;
            for (let x = 0; x < W; x++) {
                let lastY = -999;
                for (let y = 0; y < H; y++) {
                    if (closedMask[y * W + x] === 1) {
                        const gap = y - lastY - 1;
                        if (gap >= 1 && gap <= gapBridgeMax) {
                            for (let ky = lastY + 1; ky < y; ky++) closedMask[ky * W + x] = 1;
                        }
                        lastY = y;
                    }
                }
            }
            for (let y = 0; y < H; y++) {
                const rowOff = y * W;
                let lastX = -999;
                for (let x = 0; x < W; x++) {
                    if (closedMask[rowOff + x] === 1) {
                        const gap = x - lastX - 1;
                        if (gap >= 1 && gap <= gapBridgeMax) {
                            for (let kx = lastX + 1; kx < x; kx++) closedMask[rowOff + kx] = 1;
                        }
                        lastX = x;
                    }
                }
            }

            const hWallMask = new Uint8Array(W * H);
            const vWallMask = new Uint8Array(W * H);
            for (let x = 0; x < W; x++) {
                let runStart = -1;
                for (let y = 0; y <= H; y++) {
                    const val = y < H ? closedMask[y * W + x] : 0;
                    if (val === 1 && runStart === -1) runStart = y;
                    else if (val === 0 && runStart !== -1) {
                        const thick = y - runStart;
                        if (thick >= minThick && thick <= maxThick) {
                            for (let ky = runStart; ky < y; ky++) hWallMask[ky * W + x] = 1;
                        }
                        runStart = -1;
                    }
                }
            }
            for (let y = 0; y < H; y++) {
                const rowOff = y * W;
                let runStart = -1;
                for (let x = 0; x <= W; x++) {
                    const val = x < W ? closedMask[rowOff + x] : 0;
                    if (val === 1 && runStart === -1) runStart = x;
                    else if (val === 0 && runStart !== -1) {
                        const thick = x - runStart;
                        if (thick >= minThick && thick <= maxThick) {
                            for (let kx = runStart; kx < x; kx++) vWallMask[rowOff + kx] = 1;
                        }
                        runStart = -1;
                    }
                }
            }

            const stage2Can = document.createElement('canvas');
            stage2Can.width = W; stage2Can.height = H;
            const s2Ctx = stage2Can.getContext('2d');
            const s2Img = s2Ctx.createImageData(W, H);
            for (let i = 0; i < W * H; i++) {
                const idx = i * 4;
                const isH = hWallMask[i] === 1, isV = vWallMask[i] === 1;
                if (isH || isV) {
                    s2Img.data[idx] = isH && isV ? 250 : (isH ? 16 : 56);
                    s2Img.data[idx + 1] = isH && isV ? 204 : (isH ? 185 : 189);
                    s2Img.data[idx + 2] = isH && isV ? 21 : (isH ? 129 : 248);
                    s2Img.data[idx + 3] = 255;
                } else {
                    s2Img.data[idx] = 15; s2Img.data[idx + 1] = 23; s2Img.data[idx + 2] = 42; s2Img.data[idx + 3] = 255;
                }
            }
            s2Ctx.putImageData(s2Img, 0, 0);
            STATE.stage2Canvas = stage2Can;

            const rawHSegments = [], rawVSegments = [];
            for (let y = 0; y < H; y++) {
                const rowOffset = y * W;
                let runStart = -1;
                for (let x = 0; x <= W; x++) {
                    const isWall = x < W ? hWallMask[rowOffset + x] === 1 : false;
                    if (isWall && runStart === -1) runStart = x;
                    else if (!isWall && runStart !== -1) {
                        if (x - runStart >= minWallLen) rawHSegments.push({ y, x1: runStart, x2: x - 1 });
                        runStart = -1;
                    }
                }
            }
            for (let x = 0; x < W; x++) {
                let runStart = -1;
                for (let y = 0; y <= H; y++) {
                    const isWall = y < H ? vWallMask[y * W + x] === 1 : false;
                    if (isWall && runStart === -1) runStart = y;
                    else if (!isWall && runStart !== -1) {
                        if (y - runStart >= minWallLen) rawVSegments.push({ x, y1: runStart, y2: y - 1 });
                        runStart = -1;
                    }
                }
            }

            const mergedHWalls = clusterAndMergeRuns(rawHSegments, true, minThick, maxThick);
            const mergedVWalls = clusterAndMergeRuns(rawVSegments, false, minThick, maxThick);
            const allWalls = snapWallCorners(mergedHWalls, mergedVWalls, 18);



            saveHistory();
            STATE.bgWorldScale = 1.0;
            STATE.bgOffsetX = 0;
            STATE.bgOffsetY = 0;
            buildTopologyFromRecognizedSegments(allWalls, []);
        }

        function setSliderValue(inputId, labelId, val, unitSuffix) {
            const el = $id(inputId);
            const lbl = $id(labelId);
            if (el) el.value = val;
            if (lbl) lbl.textContent = val + unitSuffix;
        }

        const CV_MODAL_STATE = {
            viewMode: 'split', // 'split' | 'side' | 'overlay' | 'stage'
            splitRatio: 0.50,
            zoom: 1.0,
            panX: 0,
            panY: 0,
            isDraggingSplit: false,
            isPanningPreview: false,
            panMoved: false,
            panStartMouseX: 0,
            panStartMouseY: 0,
            panStartOriginX: 0,
            panStartOriginY: 0,
            eyedropperActive: false,
            calibWallId: null,
            hoveredWallId: null,
            activeRoomId: null,
            lastDrawBox: { x: 0, y: 0, w: 1, h: 1, mode: 'split' }
        };

        function applyCvPresetMode(presetName, rerun = true) {
            const swatch = $id('cv-sampled-swatch');
            if (presetName === 'color_gray_wall') {
                setSliderValue('paramLumMin', 'lblLumMin', 108, '');
                setSliderValue('paramLumMax', 'lblLumMax', 180, '');
                setSliderValue('paramMaxChroma', 'lblMaxChroma', 20, '');
                setSliderValue('paramMinThick', 'lblMinThick', 6, 'px');
                setSliderValue('paramMaxThick', 'lblMaxThick', 38, 'px');
                setSliderValue('paramMinWallLen', 'lblMinWallLen', 28, 'px');
                $id('sampledColorBadge').textContent = '目标: 彩图灰墙 (L:108~180, C≤20)';
                if (swatch) swatch.style.background = '#919294';
            } else {
                setSliderValue('paramLumMin', 'lblLumMin', 0, '');
                setSliderValue('paramLumMax', 'lblLumMax', 95, '');
                setSliderValue('paramMaxChroma', 'lblMaxChroma', 35, '');
                setSliderValue('paramMinThick', 'lblMinThick', 5, 'px');
                setSliderValue('paramMaxThick', 'lblMaxThick', 28, 'px');
                setSliderValue('paramMinWallLen', 'lblMinWallLen', 32, 'px');
                $id('sampledColorBadge').textContent = '目标: 黑白CAD深色墙 (L:0~95)';
                if (swatch) swatch.style.background = '#1e293b';
            }
            if (rerun && STATE.bgImage) {
                executeRecognitionPipeline();
                syncCvModalInspectorAndPreview();
                render();
            }
        }

        function autoConfigurePreprocessParamsFromImage() {
            if (!STATE.bgImage) return;
            const W = STATE.imageWidth, H = STATE.imageHeight;
            const tmp = document.createElement('canvas');
            tmp.width = W; tmp.height = H;
            const tCtx = tmp.getContext('2d');
            tCtx.drawImage(STATE.bgImage, 0, 0, W, H);
            const data = tCtx.getImageData(0, 0, W, H).data;

            let darkNeutralCount = 0, midGrayNeutralCount = 0, coloredWoodCount = 0;
            for (let i = 0; i < data.length; i += 16) {
                const r = data[i], g = data[i + 1], b = data[i + 2];
                const chroma = Math.max(r, g, b) - Math.min(r, g, b);
                const lum = 0.299 * r + 0.587 * g + 0.114 * b;
                if (chroma <= 18) {
                    if (lum < 85) darkNeutralCount++;
                    else if (lum >= 105 && lum <= 182) midGrayNeutralCount++;
                } else if (chroma > 28 && lum > 100 && lum < 220) {
                    coloredWoodCount++;
                }
            }
            if (coloredWoodCount > 800 || midGrayNeutralCount > darkNeutralCount * 1.3) {
                applyCvPresetMode('color_gray_wall', false);
            } else {
                applyCvPresetMode('cad_dark_wall', false);
            }
        }

        function toggleModalEyedropper(forceState = null) {
            const nextState = forceState !== null ? forceState : !CV_MODAL_STATE.eyedropperActive;
            CV_MODAL_STATE.eyedropperActive = nextState;
            const btn = $id('btn-activate-eyedropper');
            const label = $id('eyedropper-btn-label');
            if (btn) {
                if (nextState) {
                    btn.className = 'ui-btn ui-btn-primary';
                    if (label) label.textContent = '正在取色(点击左图)';
                } else {
                    btn.className = 'ui-btn';
                    if (label) label.textContent = '吸管取墙色';
                }
            }
            renderCvModalPreview();
        }

        function sampleWallColorFromImageCoords(imgX, imgY) {
            if (!STATE.bgImage) return;
            const ix = Math.round(imgX), iy = Math.round(imgY);
            if (ix < 2 || iy < 2 || ix >= STATE.imageWidth - 2 || iy >= STATE.imageHeight - 2) return;

            const tmp = document.createElement('canvas');
            tmp.width = STATE.imageWidth; tmp.height = STATE.imageHeight;
            const tCtx = tmp.getContext('2d');
            tCtx.drawImage(STATE.bgImage, 0, 0, STATE.imageWidth, STATE.imageHeight);
            const patch = tCtx.getImageData(ix - 2, iy - 2, 5, 5).data;

            let sumR = 0, sumG = 0, sumB = 0, sumLum = 0, maxChroma = 0, count = 0;
            for (let i = 0; i < patch.length; i += 4) {
                const r = patch[i], g = patch[i + 1], b = patch[i + 2];
                const lum = 0.299 * r + 0.587 * g + 0.114 * b;
                const ch = Math.max(r, g, b) - Math.min(r, g, b);
                sumR += r; sumG += g; sumB += b;
                sumLum += lum;
                if (ch > maxChroma) maxChroma = ch;
                count++;
            }
            const avgR = Math.round(sumR / count), avgG = Math.round(sumG / count), avgB = Math.round(sumB / count);
            const avgLum = Math.round(sumLum / count);
            const newLumMin = Math.max(0, avgLum - 34);
            const newLumMax = Math.min(245, avgLum + 34);
            const newChroma = Math.min(85, Math.max(14, maxChroma + 12));

            setSliderValue('paramLumMin', 'lblLumMin', newLumMin, '');
            setSliderValue('paramLumMax', 'lblLumMax', newLumMax, '');
            setSliderValue('paramMaxChroma', 'lblMaxChroma', newChroma, '');
            $id('sampledColorBadge').textContent = `已取墙色: L=${avgLum} (${newLumMin}~${newLumMax}, C≤${newChroma})`;
            const swatch = $id('cv-sampled-swatch');
            if (swatch) swatch.style.background = `rgb(${avgR},${avgG},${avgB})`;

            toggleModalEyedropper(false);
            executeRecognitionPipeline();
            syncCvModalInspectorAndPreview();
            fitCanvasToContent();
            render();
            showToast(`已从左图吸取墙体颜色 RGB(${avgR},${avgG},${avgB}) L=${avgLum}，并重新识别拓扑房间！`);
        }

        function sampleWallColorAtPoint(worldX, worldY) {
            if (!STATE.bgImage) return;
            const imgX = (worldX - STATE.bgOffsetX) / STATE.bgWorldScale;
            const imgY = (worldY - STATE.bgOffsetY) / STATE.bgWorldScale;
            sampleWallColorFromImageCoords(imgX, imgY);
        }

        function selectCvModalCalibWall(wallId, focusInput = false) {
            CV_MODAL_STATE.calibWallId = wallId || null;
            populateCvModalCalibWalls();
            renderCvModalPreview();
            if (focusInput && wallId) {
                const mmInput = $id('cv-calib-wall-mm');
                if (mmInput) {
                    setTimeout(() => { mmInput.focus(); mmInput.select(); }, 20);
                }
            }
        }

        function populateCvModalCalibWalls() {
            const sel = $id('cv-calib-wall-select');
            const mmInput = $id('cv-calib-wall-mm');
            const editorCard = $id('cv-calib-editor-card');
            const titleEl = $id('cv-calib-selected-title');
            const infoEl = $id('cv-calib-current-info');
            if (!sel) return;

            if (!STATE.bgImage || STATE.walls.length === 0) {
                sel.innerHTML = '';
                sel.selectedIndex = -1;
                CV_MODAL_STATE.calibWallId = null;
                if (editorCard) editorCard.classList.add('hidden');
                return;
            }

            const wallItems = STATE.walls.map((w, idx) => {
                const v1 = getVertex(w.v1), v2 = getVertex(w.v2);
                const lenPx = (v1 && v2) ? dist(v1, v2) : 0;
                const lenMM = Math.round((lenPx / SCALE_PIXELS_PER_METER) * 1000);
                const isH = v1 && v2 ? Math.abs(v1.y - v2.y) <= Math.abs(v1.x - v2.x) : true;
                return {
                    id: w.id,
                    code: `W${idx + 1}`,
                    orient: isH ? '横墙' : '纵墙',
                    label: `W${idx + 1} (${isH ? '横墙' : '纵墙'} · 图上 ${Units.text(lenMM)})`,
                    lenMM,
                    lenPx
                };
            }).filter(item => item.lenPx >= 8);

            if (CV_MODAL_STATE.calibWallId && !wallItems.some(w => w.id === CV_MODAL_STATE.calibWallId)) {
                CV_MODAL_STATE.calibWallId = null;
            }

            sel.innerHTML = wallItems.map(item =>
                `<option value="${item.id}">${item.label}</option>`
            ).join('');
            // 不默认选中任何墙段：仅当左图选中了某段墙时，下拉框才联动显示
            const selIdx = wallItems.findIndex(w => w.id === CV_MODAL_STATE.calibWallId);
            sel.selectedIndex = selIdx;

            const activeItem = wallItems.find(w => w.id === CV_MODAL_STATE.calibWallId);
            if (activeItem) {
                if (editorCard) editorCard.classList.remove('hidden');
                if (titleEl) titleEl.textContent = `${activeItem.code} (${activeItem.orient})`;
                if (infoEl) infoEl.textContent = `图上 ${Units.text(activeItem.lenMM)}`;
                if (mmInput && document.activeElement !== mmInput) {
                    mmInput.value = activeItem.lenMM;
                }
            } else {
                if (editorCard) editorCard.classList.add('hidden');
            }
        }

        function populateCvModalRoomsList() {
            const containerEl = $id('cv-room-list-container');
            const countTag = $id('cv-room-count-tag');
            if (!containerEl) return;
            const roomCount = STATE.bgImage ? STATE.rooms.length : 0;
            if (countTag) countTag.textContent = `${roomCount} 个闭合空间`;

            if (!STATE.bgImage || STATE.rooms.length === 0) {
                containerEl.innerHTML = `<div class="py-6 text-center text-slate-400 text-xs border border-dashed border-slate-200 rounded-md">${STATE.bgImage ? '未检测到闭合房间，请微调上方亮度/色度滑杆或用吸管取墙色' : '请先点击左上角【上传本地户型图】进行识别'}</div>`;
                return;
            }

            if (!CV_MODAL_STATE.activeRoomId || !STATE.rooms.some(r => r.id === CV_MODAL_STATE.activeRoomId)) {
                CV_MODAL_STATE.activeRoomId = STATE.selectedRoomId || STATE.rooms[0].id;
            }

            containerEl.innerHTML = STATE.rooms.map((room, idx) => {
                const isAct = room.id === CV_MODAL_STATE.activeRoomId;
                const area = room.stats ? room.stats.areaSqm.toFixed(2) : computePolygonAreaMeters(getRoomPolygonVerts(room)).toFixed(2);
                const ocrBadge = room._ocrMatched
                    ? `<span class="ui-badge text-[9px] font-mono font-bold shrink-0" title="PP-OCRv5 自动识别房间名称">OCR</span>`
                    : '';
                return `
                    <div data-cv-room-row="${room.id}" class="cv-room-item ${isAct ? 'active' : ''}">
                        <div class="flex items-center gap-1.5 flex-1 min-w-0">
                            <span class="cv-room-badge ${isAct ? 'active' : ''}">${idx + 1}</span>
                            <input type="text" data-cv-room-input="${room.id}" value="${(room.name || '').replace(/"/g, '&quot;')}" class="ui-input h-6 px-2 text-xs font-medium flex-1 min-w-0 bg-white" placeholder="输入空间名称">
                            ${ocrBadge}
                        </div>
                        <div class="flex items-center gap-1.5 shrink-0">
                            <span class="text-[11px] font-mono font-bold ${isAct ? 'text-primary' : 'text-slate-600'}">${area} m²</span>
                        </div>
                    </div>
                `;
            }).join('');

            containerEl.querySelectorAll('.cv-room-item').forEach(row => {
                row.addEventListener('click', (e) => {
                    const rid = row.getAttribute('data-cv-room-row');
                    CV_MODAL_STATE.activeRoomId = rid;
                    selectRoom(rid);
                    if (e.target.tagName !== 'INPUT') {
                        populateCvModalRoomsList();
                        renderCvModalPreview();
                    }
                });
            });

            containerEl.querySelectorAll('input[data-cv-room-input]').forEach(inp => {
                inp.addEventListener('focus', () => {
                    const rid = inp.getAttribute('data-cv-room-input');
                    if (CV_MODAL_STATE.activeRoomId !== rid) {
                        CV_MODAL_STATE.activeRoomId = rid;
                        selectRoom(rid);
                        renderCvModalPreview();
                    }
                });
                inp.addEventListener('input', () => {
                    const rid = inp.getAttribute('data-cv-room-input');
                    const room = getRoom(rid);
                    if (!room) return;
                    room.name = inp.value;
                    room.autoGenerated = false;
                    initRoomSelectorDropdown();
                    if (STATE.selectedRoomId === room.id) {
                        $id('room-name-input').value = room.name;
                    }
                    renderCalculationResults();
                    renderCvModalPreview();
                    render();
                });
            });
        }

        function syncCvModalInspectorAndPreview() {
            populateCvModalCalibWalls();
            populateCvModalRoomsList();
            renderCvModalPreview();
        }

        function drawRecognizedTopologyOnPreview(pCtx, ox, oy, scaleWorldToCanvas, drawBgAlpha = 0.25) {
            pCtx.save();
            if (STATE.bgImage && drawBgAlpha > 0) {
                pCtx.globalAlpha = drawBgAlpha;
                pCtx.drawImage(
                    STATE.bgImage,
                    ox,
                    oy,
                    STATE.imageWidth * STATE.bgWorldScale * scaleWorldToCanvas,
                    STATE.imageHeight * STATE.bgWorldScale * scaleWorldToCanvas
                );
                pCtx.globalAlpha = 1.0;
            }

            const toPx = (wx, wy) => ({
                x: ox + (wx - STATE.bgOffsetX) * scaleWorldToCanvas,
                y: oy + (wy - STATE.bgOffsetY) * scaleWorldToCanvas
            });

            // 1. 绘制识别出的闭合房间多边形（不叠加房间文字与PP-OCR坐标框，保持视图干净）
            const palette = [
                'rgba(59, 130, 246, 0.24)', 'rgba(16, 185, 129, 0.24)',
                'rgba(245, 158, 11, 0.24)', 'rgba(168, 85, 247, 0.24)',
                'rgba(236, 72, 153, 0.24)', 'rgba(14, 165, 233, 0.24)',
                'rgba(132, 204, 22, 0.24)', 'rgba(249, 115, 22, 0.24)'
            ];
            STATE.rooms.forEach((room, idx) => {
                const verts = getRoomPolygonVerts(room);
                if (verts.length < 3) return;
                const isActRoom = room.id === CV_MODAL_STATE.activeRoomId;
                pCtx.beginPath();
                verts.forEach((v, i) => {
                    const p = toPx(v.x, v.y);
                    if (i === 0) pCtx.moveTo(p.x, p.y);
                    else pCtx.lineTo(p.x, p.y);
                });
                pCtx.closePath();
                pCtx.fillStyle = isActRoom ? 'rgba(53, 106, 230, 0.28)' : palette[idx % palette.length];
                pCtx.fill();
                pCtx.lineWidth = isActRoom ? 2.2 : 1.0;
                pCtx.strokeStyle = isActRoom ? '#356AE6' : 'rgba(100, 116, 139, 0.55)';
                pCtx.stroke();
            });

            // 2. 绘制识别出的墙体与当前选中/悬停用于比例标定的基准墙
            STATE.walls.forEach((w, idx) => {
                const v1 = getVertex(w.v1), v2 = getVertex(w.v2);
                if (!v1 || !v2) return;
                const p1 = toPx(v1.x, v1.y), p2 = toPx(v2.x, v2.y);
                const isCalibWall = w.id === CV_MODAL_STATE.calibWallId;
                const isHoverWall = w.id === CV_MODAL_STATE.hoveredWallId;
                const baseW = Math.max(3.2, (w.thickness || 12) * scaleWorldToCanvas * 0.88);

                if (isCalibWall || isHoverWall) {
                    pCtx.save();
                    pCtx.beginPath();
                    pCtx.moveTo(p1.x, p1.y);
                    pCtx.lineTo(p2.x, p2.y);
                    pCtx.lineCap = 'round';
                    pCtx.lineWidth = baseW + 5;
                    pCtx.strokeStyle = isCalibWall ? 'rgba(245, 158, 11, 0.42)' : 'rgba(56, 189, 248, 0.38)';
                    pCtx.stroke();
                    pCtx.restore();
                }

                pCtx.beginPath();
                pCtx.moveTo(p1.x, p1.y);
                pCtx.lineTo(p2.x, p2.y);
                pCtx.lineCap = 'round';
                pCtx.lineWidth = isCalibWall ? baseW + 1.5 : baseW;
                pCtx.strokeStyle = isCalibWall ? '#f59e0b' : (isHoverWall ? '#38bdf8' : '#10b981');
                pCtx.stroke();

                if (isCalibWall || isHoverWall) {
                    const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
                    const lenMM = Math.round((dist(v1, v2) / SCALE_PIXELS_PER_METER) * 1000);
                    const tag = isCalibWall ? `基准墙 W${idx + 1}: ${Units.text(lenMM)}` : `点击选为基准墙 W${idx + 1} (${Units.text(lenMM)})`;
                    pCtx.font = 'bold 10px "Cascadia Mono", Consolas, "Noto Sans SC", sans-serif';
                    const tw = pCtx.measureText(tag).width + 12;
                    pCtx.fillStyle = isCalibWall ? '#f59e0b' : '#0284c7';
                    pCtx.beginPath();
                    pCtx.roundRect(mx - tw / 2, my - 9.5, tw, 19, 4);
                    pCtx.fill();
                    pCtx.fillStyle = isCalibWall ? '#0f172a' : '#ffffff';
                    pCtx.textAlign = 'center';
                    pCtx.textBaseline = 'middle';
                    pCtx.fillText(tag, mx, my);
                }
            });

            // 3. 绘制顶点圆点
            for (const v of STATE.vertices) {
                const p = toPx(v.x, v.y);
                pCtx.fillStyle = '#475569';
                pCtx.beginPath();
                pCtx.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
                pCtx.fill();
            }

            pCtx.restore();
        }

        function renderCvModalPreview() {
            const pCanvas = $id('cv-preview-canvas');
            const wrapper = $id('cv-preview-wrapper');
            if (!pCanvas || !wrapper) return;
            const rect = wrapper.getBoundingClientRect();
            const cw = Math.max(320, Math.floor(rect.width || 640));
            const ch = Math.max(260, Math.floor(rect.height || 460));
            const dpr = window.devicePixelRatio || 1;
            if (pCanvas.width !== cw * dpr || pCanvas.height !== ch * dpr) {
                pCanvas.width = cw * dpr;
                pCanvas.height = ch * dpr;
                pCanvas.style.width = cw + 'px';
                pCanvas.style.height = ch + 'px';
            }
            const pCtx = pCanvas.getContext('2d');
            pCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

            pCtx.fillStyle = '#f1f5f9';
            pCtx.fillRect(0, 0, cw, ch);

            const splitUi = $id('cv-split-bar-ui');
            if (splitUi) splitUi.classList.toggle('hidden', CV_MODAL_STATE.viewMode !== 'split');

            if (!STATE.bgImage) {
                pCtx.fillStyle = '#94a3b8';
                pCtx.font = '500 13px "Noto Sans SC", Inter, sans-serif';
                pCtx.textAlign = 'center';
                pCtx.textBaseline = 'middle';
                pCtx.fillText('请点击左上角【上传本地户型图】或直接将图片拖入此区域', cw / 2, ch / 2);
                return;
            }

            const worldW = STATE.imageWidth * (STATE.bgWorldScale || 1);
            const worldH = STATE.imageHeight * (STATE.bgWorldScale || 1);
            const pad = 24;
            const zoom = CV_MODAL_STATE.zoom || 1.0;
            const panX = CV_MODAL_STATE.panX || 0;
            const panY = CV_MODAL_STATE.panY || 0;

            if (CV_MODAL_STATE.viewMode === 'side') {
                // 左右双图并排对比模式：左原图，右识别拓扑结果
                const halfW = (cw - pad * 3) / 2;
                const availH = ch - pad * 2;
                const baseSc = Math.min(halfW / worldW, availH / worldH);
                const sc = baseSc * zoom;
                const drawW = worldW * sc, drawH = worldH * sc;
                const leftX = pad + (halfW - drawW) / 2 + panX;
                const rightX = pad * 2 + halfW + (halfW - drawW) / 2 + panX;
                const topY = pad + (availH - drawH) / 2 + panY;

                pCtx.save();
                pCtx.beginPath();
                pCtx.rect(pad, pad, halfW, availH);
                pCtx.clip();
                pCtx.drawImage(STATE.bgImage, leftX, topY, drawW, drawH);
                pCtx.strokeStyle = '#cbd5e1';
                pCtx.strokeRect(leftX, topY, drawW, drawH);
                pCtx.restore();

                pCtx.save();
                pCtx.beginPath();
                pCtx.rect(pad * 2 + halfW, pad, halfW, availH);
                pCtx.clip();
                pCtx.fillStyle = '#ffffff';
                pCtx.fillRect(rightX, topY, drawW, drawH);
                drawRecognizedTopologyOnPreview(pCtx, rightX, topY, sc, 0.25);
                pCtx.strokeStyle = '#cbd5e1';
                pCtx.strokeRect(rightX, topY, drawW, drawH);
                pCtx.restore();

                CV_MODAL_STATE.lastDrawBox = {
                    mode: 'side',
                    leftX, rightX, y: topY, w: drawW, h: drawH, scaleWorldToCanvas: sc
                };
            } else {
                const availW = cw - pad * 2;
                const availH = ch - pad * 2;
                const baseSc = Math.min(availW / worldW, availH / worldH);
                const sc = baseSc * zoom;
                const drawW = worldW * sc, drawH = worldH * sc;
                const ox = (cw - drawW) / 2 + panX;
                const oy = (ch - drawH) / 2 + panY;

                CV_MODAL_STATE.lastDrawBox = {
                    mode: CV_MODAL_STATE.viewMode,
                    x: ox, y: oy, w: drawW, h: drawH, scaleWorldToCanvas: sc
                };

                if (CV_MODAL_STATE.viewMode === 'split') {
                    const splitX = ox + drawW * CV_MODAL_STATE.splitRatio;
                    // 左半边：原始户型图
                    pCtx.save();
                    pCtx.beginPath();
                    pCtx.rect(ox, oy, splitX - ox, drawH);
                    pCtx.clip();
                    pCtx.drawImage(STATE.bgImage, ox, oy, drawW, drawH);
                    pCtx.restore();

                    // 右半边：识别出的拓扑房间与墙体叠加
                    pCtx.save();
                    pCtx.beginPath();
                    pCtx.rect(splitX, oy, ox + drawW - splitX, drawH);
                    pCtx.clip();
                    pCtx.fillStyle = '#ffffff';
                    pCtx.fillRect(ox, oy, drawW, drawH);
                    drawRecognizedTopologyOnPreview(pCtx, ox, oy, sc, 0.30);
                    pCtx.restore();

                    // 分界卷帘线与手柄
                    pCtx.strokeStyle = '#38bdf8';
                    pCtx.lineWidth = 2;
                    pCtx.beginPath();
                    pCtx.moveTo(splitX, oy);
                    pCtx.lineTo(splitX, oy + drawH);
                    pCtx.stroke();

                    pCtx.fillStyle = '#0284c7';
                    pCtx.strokeStyle = '#ffffff';
                    pCtx.lineWidth = 1.5;
                    pCtx.beginPath();
                    pCtx.arc(splitX, oy + drawH / 2, 11, 0, Math.PI * 2);
                    pCtx.fill();
                    pCtx.stroke();

                    pCtx.fillStyle = '#ffffff';
                    pCtx.font = 'bold 10px monospace';
                    pCtx.textAlign = 'center';
                    pCtx.textBaseline = 'middle';
                    pCtx.fillText('↔', splitX, oy + drawH / 2);
                } else if (CV_MODAL_STATE.viewMode === 'overlay') {
                    drawRecognizedTopologyOnPreview(pCtx, ox, oy, sc, 0.55);
                } else if (CV_MODAL_STATE.viewMode === 'stage') {
                    const stageCan = STATE.stage2Canvas || STATE.stage1Canvas;
                    if (stageCan) {
                        pCtx.drawImage(stageCan, ox, oy, drawW, drawH);
                    }
                    drawRecognizedTopologyOnPreview(pCtx, ox, oy, sc, 0.0);
                }

                pCtx.strokeStyle = '#cbd5e1';
                pCtx.lineWidth = 1;
                pCtx.strokeRect(ox, oy, drawW, drawH);
            }
        }

        /*************************************************************************
         * 八(B)、前端 PP-OCRv5 (ONNX Runtime Web) 户型图房间名称自动识别引擎
         *************************************************************************/
        const PPOCR_STATE = {
            detSession: null,
            recSession: null,
            charset: null,
            executionProvider: 'wasm',
            detInput: [736, 736],
            recHeight: 32,
            recFixedWidth: null,
            loadingPromise: null,
            isRunning: false,
            runSeq: 0
        };

        function getOcrMetaDims(session, isInput = true) {
            const names = isInput ? session.inputNames : session.outputNames;
            const meta = isInput ? session.inputMetadata : session.outputMetadata;
            if (!meta || !names?.length) return null;
            const item = meta[0] || meta[names[0]];
            return item?.dims || item?.shape || null;
        }

        function updateOcrStatusBadge(text, tone = 'info') {
            const bar = $id('cv-ocr-status-bar');
            const badge = $id('cv-ocr-status-badge');
            const btn = $id('btn-rerun-ocr');
            if (badge) badge.textContent = text;
            if (bar) {
                if (tone === 'loading') {
                    bar.className = 'px-2.5 py-1 rounded bg-amber-50 border border-amber-300 flex items-center justify-between gap-2 text-[11px]';
                    if (badge) badge.className = 'text-amber-800 font-mono truncate font-medium';
                } else if (tone === 'success') {
                    bar.className = 'px-2.5 py-1 rounded bg-emerald-50 border border-emerald-200 flex items-center justify-between gap-2 text-[11px]';
                    if (badge) badge.className = 'text-emerald-800 font-mono truncate font-medium';
                } else if (tone === 'error') {
                    bar.className = 'px-2.5 py-1 rounded bg-rose-50 border border-rose-200 flex items-center justify-between gap-2 text-[11px]';
                    if (badge) badge.className = 'text-rose-700 font-mono truncate';
                } else {
                    bar.className = 'hidden px-2.5 py-1 rounded bg-indigo-50/70 border border-indigo-200/80 flex items-center justify-between gap-2 text-[11px]';
                    if (badge) badge.className = 'text-indigo-800 font-mono truncate';
                }
            }
            if (btn) {
                btn.disabled = tone === 'loading';
                btn.textContent = tone === 'loading' ? 'OCR识别中...' : 'OCR识别房间名';
            }
        }

        async function ensurePpOcrLoaded() {
            if (PPOCR_STATE.detSession && PPOCR_STATE.recSession && PPOCR_STATE.charset) {
                return PPOCR_STATE;
            }
            if (PPOCR_STATE.loadingPromise) {
                return PPOCR_STATE.loadingPromise;
            }
            PPOCR_STATE.loadingPromise = (async () => {
                if (typeof ort === 'undefined') {
                    throw new Error('未加载 ort.webgpu.min.js');
                }
                ort.env.wasm.wasmPaths = {
                    mjs: new URL('./assets/ort-wasm-simd-threaded.jsep.mjs', document.baseURI).href,
                    wasm: new URL('./assets/ort-wasm-simd-threaded.jsep.wasm', document.baseURI).href,
                };
                const crossOriginIsolated = window.crossOriginIsolated === true;
                ort.env.wasm.numThreads = crossOriginIsolated
                    ? Math.min(4, Math.max(1, navigator.hardwareConcurrency || 1))
                    : 1;
                ort.env.wasm.proxy = false;

                updateOcrStatusBadge('PP-OCRv5: 正在加载字典与检测/识别模型...', 'loading');
                const detUrl = (window.HostBridge && window.HostBridge.external && typeof window.HostBridge.external.getUrl === 'function')
                    ? window.HostBridge.external.getUrl('weight', 'det.onnx')
                    : './weight/det.onnx';
                const recUrl = (window.HostBridge && window.HostBridge.external && typeof window.HostBridge.external.getUrl === 'function')
                    ? window.HostBridge.external.getUrl('weight', 'rec.onnx')
                    : './weight/rec.onnx';
                const [dictResp, detResp, recResp] = await Promise.all([
                    fetch('./assets/ppocrv5_dict.txt'),
                    fetch(detUrl),
                    fetch(recUrl)
                ]);
                const extHint = (typeof DesktopHost !== 'undefined' && DesktopHost.isDesktop()) ? '（请确认程序同级目录下存在 weight 模型目录）' : '';
                if (!dictResp.ok) throw new Error(`字典加载失败: HTTP ${dictResp.status}`);
                if (!detResp.ok) throw new Error(`检测模型加载失败: HTTP ${detResp.status}${extHint}`);
                if (!recResp.ok) throw new Error(`识别模型加载失败: HTTP ${recResp.status}${extHint}`);

                const [dictText, detBuffer, recBuffer] = await Promise.all([
                    dictResp.text(),
                    detResp.arrayBuffer(),
                    recResp.arrayBuffer()
                ]);
                const lines = dictText.replace(/\r/g, '').split('\n');
                if (lines.length && lines[lines.length - 1] === '') lines.pop();
                lines.push(' ');
                PPOCR_STATE.charset = lines;

                const createSessions = async (executionProviders) => {
                    let det = null;
                    try {
                        det = await ort.InferenceSession.create(detBuffer, { executionProviders, graphOptimizationLevel: 'all' });
                        const rec = await ort.InferenceSession.create(recBuffer, { executionProviders, graphOptimizationLevel: 'all' });
                        return { det, rec };
                    } catch (error) {
                        det?.release?.();
                        throw error;
                    }
                };

                let sessions = null;
                let adapter = null;
                if (typeof navigator !== 'undefined' && navigator.gpu) {
                    try {
                        adapter = await navigator.gpu.requestAdapter();
                    } catch (err) {
                        console.warn('WebGPU adapter request failed; falling back to WASM.', err);
                    }
                }
                if (adapter) {
                    try {
                        sessions = await createSessions(['webgpu', 'wasm']);
                        PPOCR_STATE.executionProvider = 'webgpu';
                    } catch (err) {
                        console.warn('WebGPU model initialization failed; falling back to WASM.', err);
                    }
                }
                if (!sessions) {
                    sessions = await createSessions(['wasm']);
                    PPOCR_STATE.executionProvider = 'wasm';
                }

                PPOCR_STATE.detSession = sessions.det;
                PPOCR_STATE.recSession = sessions.rec;

                const detDims = getOcrMetaDims(PPOCR_STATE.detSession, true);
                if (detDims && detDims.length === 4) {
                    const dh = Number(detDims[2]), dw = Number(detDims[3]);
                    if (Number.isFinite(dh) && dh > 0 && Number.isFinite(dw) && dw > 0) {
                        PPOCR_STATE.detInput = [dh, dw];
                    }
                }
                const recInDims = getOcrMetaDims(PPOCR_STATE.recSession, true);
                PPOCR_STATE.recFixedWidth = null;
                if (recInDims && recInDims.length === 4) {
                    const rh = Number(recInDims[2]), rw = Number(recInDims[3]);
                    if (Number.isFinite(rh) && rh > 0) PPOCR_STATE.recHeight = rh;
                    if (Number.isFinite(rw) && rw > 0) PPOCR_STATE.recFixedWidth = rw;
                }
                return PPOCR_STATE;
            })();

            try {
                return await PPOCR_STATE.loadingPromise;
            } catch (err) {
                PPOCR_STATE.loadingPromise = null;
                throw err;
            }
        }

        function findOcrBoxesFromMap(prob, w, h, validW, validH, thresh = 0.3) {
            const total = w * h;
            const mask = new Uint8Array(total);
            for (let y = 0; y < validH; y++) {
                const rowOffset = y * w;
                for (let x = 0; x < validW; x++) {
                    const idx = rowOffset + x;
                    if (prob[idx] >= thresh) mask[idx] = 1;
                }
            }
            const stack = new Int32Array(total);
            const boxes = [];
            for (let i = 0; i < total; i++) {
                if (!mask[i]) continue;
                let sp = 0;
                stack[sp++] = i;
                mask[i] = 0;
                let minX = w, minY = h, maxX = 0, maxY = 0, sum = 0, cnt = 0;
                while (sp > 0) {
                    const p = stack[--sp];
                    const x = p % w, y = (p / w) | 0;
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                    sum += prob[p];
                    cnt++;
                    if (x > 0 && mask[p - 1]) { mask[p - 1] = 0; stack[sp++] = p - 1; }
                    if (x < w - 1 && mask[p + 1]) { mask[p + 1] = 0; stack[sp++] = p + 1; }
                    if (y > 0 && mask[p - w]) { mask[p - w] = 0; stack[sp++] = p - w; }
                    if (y < h - 1 && mask[p + w]) { mask[p + w] = 0; stack[sp++] = p + w; }
                }
                if (cnt < 16) continue;
                const bw = maxX - minX + 1, bh = maxY - minY + 1;
                if (bw < 3 || bh < 3) continue;
                boxes.push({ x0: minX, y0: minY, x1: maxX + 1, y1: maxY + 1, score: sum / cnt });
            }
            return boxes;
        }

        function unclipOcrBox(b, ratio = 1.5) {
            const w = b.x1 - b.x0, h = b.y1 - b.y0;
            const d = (w * h * ratio) / (2 * (w + h));
            return { ...b, x0: b.x0 - d, y0: b.y0 - d, x1: b.x1 + d, y1: b.y1 + d };
        }

        function mergeSameLineOcrBoxes(boxes) {
            boxes.sort((a, b) => ((a.y0 + a.y1) - (b.y0 + b.y1)) || (a.x0 - b.x0));
            let merged = true;
            while (merged) {
                merged = false;
                for (let i = 0; i < boxes.length; i++) {
                    for (let j = i + 1; j < boxes.length; j++) {
                        const a = boxes[i], b = boxes[j];
                        const ha = a.y1 - a.y0, hb = b.y1 - b.y0;
                        const cya = (a.y0 + a.y1) / 2, cyb = (b.y0 + b.y1) / 2;
                        if (Math.abs(cya - cyb) <= Math.min(ha, hb) * 0.45 && Math.max(ha, hb) / Math.min(ha, hb) <= 1.6) {
                            const left = a.x0 <= b.x0 ? a : b;
                            const right = a.x0 <= b.x0 ? b : a;
                            const gap = right.x0 - left.x1;
                            if (gap <= Math.min(ha, hb) * 0.5 && gap >= -Math.max(ha, hb)) {
                                boxes[i] = {
                                    x0: Math.min(a.x0, b.x0),
                                    y0: Math.min(a.y0, b.y0),
                                    x1: Math.max(a.x1, b.x1),
                                    y1: Math.max(a.y1, b.y1),
                                    score: (a.score + b.score) / 2
                                };
                                boxes.splice(j, 1);
                                merged = true;
                                break;
                            }
                        }
                    }
                    if (merged) break;
                }
            }
            return boxes;
        }

        function cropAndPreprocessOcrRec(rgba, W, H, box, targetH = 48) {
            const bw = Math.max(1, box.x1 - box.x0);
            const bh = Math.max(1, box.y1 - box.y0);
            const drawW = Math.min(320, Math.max(16, Math.round(targetH * bw / bh)));
            const out = new Float32Array(3 * targetH * drawW);
            const p = targetH * drawW;
            for (let y = 0; y < targetH; y++) {
                const sy = Math.min(H - 1, Math.max(0, Math.floor(box.y0 + (y + 0.5) * bh / targetH)));
                for (let x = 0; x < drawW; x++) {
                    const sx = Math.min(W - 1, Math.max(0, Math.floor(box.x0 + (x + 0.5) * bw / drawW)));
                    const sIdx = (sy * W + sx) * 4;
                    const dIdx = y * drawW + x;
                    out[dIdx] = (rgba[sIdx] / 255 - 0.5) / 0.5;
                    out[p + dIdx] = (rgba[sIdx + 1] / 255 - 0.5) / 0.5;
                    out[p * 2 + dIdx] = (rgba[sIdx + 2] / 255 - 0.5) / 0.5;
                }
            }
            return new ort.Tensor('float32', out, [1, 3, targetH, drawW]);
        }

        function ctcDecodeOcr(logits, dims, charset) {
            let T = 0, C = 0;
            if (dims.length === 3) {
                T = dims[1]; C = dims[2];
            } else if (dims.length === 2) {
                T = dims[0]; C = dims[1];
            }
            let text = '', conf = 0, n = 0, prev = -1;
            for (let t = 0; t < T; t++) {
                let best = -Infinity, bestIdx = 0;
                const base = t * C;
                for (let c = 0; c < C; c++) {
                    const v = logits[base + c];
                    if (v > best) { best = v; bestIdx = c; }
                }
                if (bestIdx > 0 && bestIdx !== prev) {
                    const ch = charset[bestIdx - 1];
                    if (ch !== undefined) text += ch;
                    conf += best;
                    n++;
                }
                prev = bestIdx;
            }
            return { text, score: n ? conf / n : 0 };
        }

        function inferRoomMaterialPropsFromName(name) {
            const n = (name || '').trim();
            if (/卫|浴|厕|洗手/.test(n)) {
                return { materialType: 'tile', tileW: 300, tileH: 300, pattern: 'straight' };
            }
            if (/厨|阳|露|生活|家政|玄关|入户/.test(n)) {
                return { materialType: 'tile', tileW: 600, tileH: 600, pattern: 'straight' };
            }
            if (/卧|房|书|衣帽|儿童|长辈|女孩|男孩/.test(n)) {
                return { materialType: 'wood', tileW: 1210, tileH: 195, pattern: /主卧/.test(n) ? 'stagger_369' : 'brick' };
            }
            return { materialType: 'tile', tileW: 800, tileH: 800, pattern: 'straight' };
        }

        function applyOcrLabelsToRooms(labels, options = {}) {
            if (!labels || !labels.length || !STATE.rooms || !STATE.rooms.length) return 0;
            const roomKeywordRegex = /卧|房|厅|厨|卫|阳|台|书|玄|关|廊|道|衣|帽|储|杂|室|馆|阁|院|花|露|浴|厕|入户|门厅|过道|起居/;
            const ws = STATE.bgWorldScale || 1;
            const usedLabels = new Set();
            let matchedCount = 0;

            // 第一轮：按标签中心点落在闭合房间多边形内部精准匹配
            for (const room of STATE.rooms) {
                const verts = getRoomPolygonVerts(room);
                if (verts.length < 3) continue;
                const candidates = [];
                labels.forEach((lbl, idx) => {
                    if (usedLabels.has(idx)) return;
                    const wx = STATE.bgOffsetX + lbl.cx * ws;
                    const wy = STATE.bgOffsetY + lbl.cy * ws;
                    if (isPointInPolygon({ x: wx, y: wy }, verts)) {
                        candidates.push({ lbl, idx });
                    }
                });
                if (candidates.length > 0) {
                    candidates.sort((a, b) => {
                        const aKw = roomKeywordRegex.test(a.lbl.cleanText) ? 1 : 0;
                        const bKw = roomKeywordRegex.test(b.lbl.cleanText) ? 1 : 0;
                        if (aKw !== bKw) return bKw - aKw;
                        return b.lbl.recScore - a.lbl.recScore;
                    });
                    const chosen = candidates[0];
                    usedLabels.add(chosen.idx);
                    room.name = chosen.lbl.cleanText;
                    room.autoGenerated = false;
                    room._ocrMatched = true;
                    room._ocrScore = chosen.lbl.recScore;
                    const mat = inferRoomMaterialPropsFromName(room.name);
                    Object.assign(room, mat);
                    matchedCount++;
                }
            }

            // 第二轮：若仍有未命名的自动房间且有未分配的房间关键词标签，按最近距离容差匹配
            for (let idx = 0; idx < labels.length; idx++) {
                if (usedLabels.has(idx)) continue;
                const lbl = labels[idx];
                if (!roomKeywordRegex.test(lbl.cleanText)) continue;
                const wx = STATE.bgOffsetX + lbl.cx * ws;
                const wy = STATE.bgOffsetY + lbl.cy * ws;
                let bestRoom = null, bestDist = 45 * ws;
                for (const room of STATE.rooms) {
                    if (room._ocrMatched) continue;
                    const verts = getRoomPolygonVerts(room);
                    for (let i = 0; i < verts.length; i++) {
                        const proj = projectPointToSegment({ x: wx, y: wy }, verts[i], verts[(i + 1) % verts.length]);
                        if (proj.distance < bestDist) {
                            bestDist = proj.distance;
                            bestRoom = room;
                        }
                    }
                }
                if (bestRoom) {
                    usedLabels.add(idx);
                    bestRoom.name = lbl.cleanText;
                    bestRoom.autoGenerated = false;
                    bestRoom._ocrMatched = true;
                    bestRoom._ocrScore = lbl.recScore;
                    Object.assign(bestRoom, inferRoomMaterialPropsFromName(bestRoom.name));
                    matchedCount++;
                }
            }

            if (!options.silent) {
                recomputeAllRoomTiling();
                initRoomSelectorDropdown();
                refreshViews({ panel: true, results: true, canvas: false });
                populateCvModalRoomsList();
                renderCvModalPreview();
                render();
            }
            return matchedCount;
        }

        async function runOcrOnCurrentFloorplan(options = {}) {
            if (!STATE.bgImage) {
                showToast('请先上传户型图');
                return [];
            }
            const currentSeq = ++PPOCR_STATE.runSeq;
            PPOCR_STATE.isRunning = true;
            try {
                const { detSession, recSession, charset } = await ensurePpOcrLoaded();
                if (currentSeq !== PPOCR_STATE.runSeq) return [];

                const W = STATE.imageWidth, H = STATE.imageHeight;
                const epTag = PPOCR_STATE.executionProvider === 'webgpu' ? 'WebGPU' : 'WASM';
                updateOcrStatusBadge(`PP-OCRv5 (${epTag}): 正在检测户型图文字区域 (DBNet)...`, 'loading');
                await new Promise(r => requestAnimationFrame(r));

                const srcCan = document.createElement('canvas');
                srcCan.width = W; srcCan.height = H;
                const srcCtx = srcCan.getContext('2d', { willReadFrequently: true });
                srcCtx.drawImage(STATE.bgImage, 0, 0, W, H);
                const srcRgba = srcCtx.getImageData(0, 0, W, H).data;

                const [IH, IW] = PPOCR_STATE.detInput || [736, 736];
                const scale = Math.min(IW / W, IH / H);
                const nw = Math.max(1, Math.round(W * scale));
                const nh = Math.max(1, Math.round(H * scale));

                const detPx = new Uint8Array(IW * IH * 4);
                for (let y = 0; y < nh; y++) {
                    const sy = Math.min(H - 1, Math.floor(y / scale));
                    for (let x = 0; x < nw; x++) {
                        const sx = Math.min(W - 1, Math.floor(x / scale));
                        const sIdx = (sy * W + sx) * 4;
                        const dIdx = (y * IW + x) * 4;
                        detPx[dIdx] = srcRgba[sIdx];
                        detPx[dIdx + 1] = srcRgba[sIdx + 1];
                        detPx[dIdx + 2] = srcRgba[sIdx + 2];
                        detPx[dIdx + 3] = 255;
                    }
                }

                const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
                const chw = new Float32Array(3 * IW * IH);
                const plane = IW * IH;
                for (let i = 0; i < plane; i++) {
                    const j = i * 4;
                    chw[i] = (detPx[j] / 255 - mean[0]) / std[0];
                    chw[plane + i] = (detPx[j + 1] / 255 - mean[1]) / std[1];
                    chw[plane * 2 + i] = (detPx[j + 2] / 255 - mean[2]) / std[2];
                }

                const detInName = detSession.inputNames[0];
                const detOutMap = await detSession.run({
                    [detInName]: new ort.Tensor('float32', chw, [1, 3, IH, IW])
                });
                if (currentSeq !== PPOCR_STATE.runSeq) return [];

                const detTensor = detOutMap[detSession.outputNames[0]];
                const dDims = detTensor.dims;
                const mh = dDims[dDims.length - 2], mw = dDims[dDims.length - 1];
                const strideX = IW / mw, strideY = IH / mh;
                const validW = Math.min(mw, Math.ceil(nw / strideX));
                const validH = Math.min(mh, Math.ceil(nh / strideY));

                let boxes = findOcrBoxesFromMap(detTensor.data, mw, mh, validW, validH, 0.3)
                    .map(b => unclipOcrBox(b, 1.5))
                    .filter(b => b.score >= 0.5)
                    .map(b => ({
                        x0: Math.max(0, Math.round((b.x0 * strideX) / scale)),
                        y0: Math.max(0, Math.round((b.y0 * strideY) / scale)),
                        x1: Math.min(W, Math.round((b.x1 * strideX) / scale)),
                        y1: Math.min(H, Math.round((b.y1 * strideY) / scale)),
                        score: b.score
                    }));

                boxes = mergeSameLineOcrBoxes(boxes);
                updateOcrStatusBadge(`PP-OCRv5 (${epTag}): 正在识别 ${boxes.length} 处文字内容...`, 'loading');

                const recInName = recSession.inputNames[0];
                const recOutName = recSession.outputNames[0];
                let recH = PPOCR_STATE.recHeight || 32;
                for (let i = 0; i < boxes.length; i++) {
                    if (currentSeq !== PPOCR_STATE.runSeq) return [];
                    let recOut;
                    try {
                        recOut = await recSession.run({ [recInName]: cropAndPreprocessOcrRec(srcRgba, W, H, boxes[i], recH) });
                    } catch (e) {
                        recH = recH === 32 ? 48 : 32;
                        PPOCR_STATE.recHeight = recH;
                        recOut = await recSession.run({ [recInName]: cropAndPreprocessOcrRec(srcRgba, W, H, boxes[i], recH) });
                    }
                    const rt = recOut[recOutName];
                    const dec = ctcDecodeOcr(rt.data, rt.dims, charset);
                    boxes[i].text = dec.text;
                    boxes[i].recScore = dec.score;
                    boxes[i].cx = Math.round((boxes[i].x0 + boxes[i].x1) / 2);
                    boxes[i].cy = Math.round((boxes[i].y0 + boxes[i].y1) / 2);
                }

                const roomKeywordRegex = /卧|房|厅|厨|卫|阳|台|书|玄|关|廊|道|衣|帽|储|杂|室|馆|阁|院|花|露|浴|厕|入户|门厅|过道|起居/;
                const areaOrDimRegex = /^\d+([.,]\d+)?\s*(m|m2|m²|㎡|mi|mm|cm|px|平|平米|平方米)?\.?$/i;
                const validLabels = boxes.filter(b => {
                    const t = (b.text || '').trim().replace(/^[·.,:;'"`~_\-+*/\\|()[\]{}<>]+|[·.,:;'"`~_\-+*/\\|()[\]{}<>]+$/g, '');
                    if (!t || areaOrDimRegex.test(t) || !/[\u4e00-\u9fa5]/.test(t)) return false;
                    b.cleanText = t;
                    if (roomKeywordRegex.test(t)) return b.recScore >= 0.45;
                    return t.length >= 2 && t.length <= 8 && b.recScore >= 0.70;
                });

                STATE.ocrRoomLabels = validLabels;
                const matchedCount = applyOcrLabelsToRooms(validLabels);
                const namesPreview = validLabels.map(l => l.cleanText).join('、');
                updateOcrStatusBadge(
                    validLabels.length > 0
                        ? `PP-OCRv5 (${epTag}) 已自动命名 ${matchedCount}/${STATE.rooms.length} 房间: ${namesPreview}`
                        : `PP-OCRv5 (${epTag}): 未在图中检测到明显房间名称文字`,
                    validLabels.length > 0 ? 'success' : 'info'
                );
                if (validLabels.length > 0) {
                    showToast(`PP-OCRv5 识别完成：自动匹配 ${matchedCount} 个房间名称（${namesPreview}）`);
                }
                return validLabels;
            } catch (err) {
                console.error('PP-OCRv5 识别失败:', err);
                updateOcrStatusBadge(`PP-OCRv5 识别异常: ${err.message || err}`, 'error');
                if (!options.auto) {
                    showToast('PP-OCRv5 识别失败: ' + (err.message || err));
                }
                return [];
            } finally {
                if (currentSeq === PPOCR_STATE.runSeq) {
                    PPOCR_STATE.isRunning = false;
                }
            }
        }

        function syncUnderlayUiState() {
            const hasBg = !!STATE.bgImage;
            const wrap = $id('underlay-menu-wrap');
            if (wrap) wrap.classList.toggle('hidden', !hasBg);
            if (!hasBg) {
                const popover = $id('underlay-popover');
                if (popover) popover.classList.add('hidden');
            }
            const btn = $id('btn-footer-underlay');
            if (btn) btn.classList.toggle('active', !!(hasBg && STATE.showBgImage));
            const pct = Math.round((STATE.bgOpacity ?? 0.45) * 100);
            const slider = $id('bg-opacity-slider');
            if (slider && parseInt(slider.value, 10) !== pct) slider.value = String(pct);
            const lbl = $id('bg-opacity-label');
            if (lbl) lbl.textContent = `${pct}%`;

            const dimCalibBtn = $id('dim-input-calibrate');
            if (dimCalibBtn && !hasBg) dimCalibBtn.classList.add('hidden');
        }

        function openCvRecognitionModal() {
            const modal = $id('import-modal');
            modal.classList.remove('hidden');
            if (STATE.bgImage && !STATE.stage1Canvas) {
                autoConfigurePreprocessParamsFromImage();
                executeRecognitionPipeline();
                CV_MODAL_STATE.calibWallId = null;
                CV_MODAL_STATE.zoom = 1.0;
                CV_MODAL_STATE.panX = 0;
                CV_MODAL_STATE.panY = 0;
                CV_MODAL_STATE.activeRoomId = STATE.rooms[0]?.id || null;
                fitCanvasToContent();
                render();
                runOcrOnCurrentFloorplan({ auto: true });
            }
            requestAnimationFrame(() => {
                syncCvModalInspectorAndPreview();
            });
        }

        async function requestCvRecognitionModal() {
            if (!(await confirmSaveBeforeReplace('执行户型图识别'))) return;
            openCvRecognitionModal();
        }

        /** 读取图片文件并设为画布底图（长边超过 1400px 时按比例记录尺寸），完成后回调 */
        function loadImageFileAsBackground(file, onLoaded) {
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    let W = img.naturalWidth || img.width || 960;
                    let H = img.naturalHeight || img.height || 860;
                    const sc = Math.min(1, 1400 / Math.max(W, H));
                    STATE.bgImage = img;
                    STATE.imageWidth = Math.max(1, Math.round(W * sc));
                    STATE.imageHeight = Math.max(1, Math.round(H * sc));
                    STATE.showBgImage = true;
                    STATE.ocrRoomLabels = [];
                    onLoaded(img);
                };
                img.src = e.target.result;
            };
            reader.readAsDataURL(file);
        }

        function handleReferenceUnderlayUpload(file) {
            loadImageFileAsBackground(file, () => {
                STATE.stage1Canvas = null;
                STATE.stage2Canvas = null;
                if (STATE.vertices.length === 0) {
                    STATE.bgWorldScale = 1.0;
                    STATE.bgOffsetX = 0;
                    STATE.bgOffsetY = 0;
                    fitCanvasToContent();
                }
                syncUnderlayUiState();
                markDirty();
                render();
                showToast('已导入参考底图');
            });
        }

        // 上传图片前先弹出裁剪窗口（Cropper.js）；取消则不导入，「使用原图」则原样导入
        const cropFloorplanFile = (file) => window.ImageCropDialog
            ? ImageCropDialog.pick(file, { title: '裁剪户型识别图', hint: '框选户型主体，去掉标题栏、图例与留白可提升识别准确度', aspect: NaN, maxSize: 4096 })
            : Promise.resolve(file);
        const cropUnderlayFile = (file) => window.ImageCropDialog
            ? ImageCropDialog.pick(file, { title: '裁剪参考底图', hint: '保留需要描图的区域，裁剪后可在画布上标定比例', aspect: NaN, maxSize: 4096 })
            : Promise.resolve(file);

        function handleUserFloorplanUpload(file) {
            loadImageFileAsBackground(file, () => {
                syncUnderlayUiState();
                autoConfigurePreprocessParamsFromImage();
                setTimeout(() => {
                    executeRecognitionPipeline();
                    CV_MODAL_STATE.calibWallId = null;
                    CV_MODAL_STATE.zoom = 1.0;
                    CV_MODAL_STATE.panX = 0;
                    CV_MODAL_STATE.panY = 0;
                    CV_MODAL_STATE.activeRoomId = STATE.rooms[0]?.id || null;
                    fitCanvasToContent();
                    syncCvModalInspectorAndPreview();
                    render();
                    showToast(`户型图已提取 ${STATE.walls.length} 段墙体、${STATE.rooms.length} 个闭合空间，正在调用 PP-OCRv5 自动识别房间名...`);
                    runOcrOnCurrentFloorplan({ auto: true });
                }, 120);
            });
        }

        /*************************************************************************
         * 九、初始化标准五室两厅无家具拓扑工程
         *************************************************************************/
        function updateZoomText() {
            if ((typeof Elevation !== 'undefined') && Elevation.isActive()) { Elevation.updateZoomText(); return; }
            $id('zoom-level-text').textContent = `${Math.round(STATE.scale * 100)}%`;
        }

        // 以 (cx, cy)（画布像素坐标，缺省为画布中心）为锚点缩放
        function zoomBy(factor, cx = container.clientWidth / 2, cy = container.clientHeight / 2) {
            if ((typeof Elevation !== 'undefined') && Elevation.isActive()) { Elevation.zoomBy(factor); return; }
            const newScale = Math.max(0.3, Math.min(8.0, STATE.scale * factor));
            STATE.panX = cx - (cx - STATE.panX) * (newScale / STATE.scale);
            STATE.panY = cy - (cy - STATE.panY) * (newScale / STATE.scale);
            STATE.scale = newScale;
            updateZoomText();
            render();
        }

        function fitCanvasToContent() {
            const rect = container.getBoundingClientRect();
            const cw = rect.width || 800, ch = rect.height || 600;
            if (STATE.vertices.length === 0 && !STATE.bgImage) {
                STATE.scale = 1.0; STATE.panX = 60; STATE.panY = 40;
                updateZoomText();
                return;
            }
            let { minX, maxX, minY, maxY } = pointsBounds(STATE.vertices);
            if (STATE.bgImage && STATE.vertices.length === 0) {
                minX = 0; minY = 0;
                maxX = STATE.imageWidth * STATE.bgWorldScale;
                maxY = STATE.imageHeight * STATE.bgWorldScale;
            }
            const pad = 70;
            const w = Math.max(200, maxX - minX + pad * 2);
            const h = Math.max(200, maxY - minY + pad * 2);
            STATE.scale = Math.max(0.35, Math.min(2.2, Math.min(cw / w, ch / h)));
            STATE.panX = (cw - (maxX + minX) * STATE.scale) / 2;
            STATE.panY = (ch - (maxY + minY) * STATE.scale) / 2;
            updateZoomText();
        }

        /*************************************************************************
         * 十、右侧 3D 轴测预览
         *************************************************************************/
        /** 3D 轴测预览：未选中空间 = 整层，选中空间 = 单空间（实现见 elevation.js） */
        function render3DIsometricPreview() {
            if (typeof Elevation !== 'undefined') Elevation.render3D();
        }

        /*************************************************************************
         * 十一、左侧与右侧 UI 面板同步与历史记录
         *************************************************************************/
        // 一块砖（可能被裁成多段）的整体包围盒 [minX, minY, maxX, maxY]
        function getPolysBounds(polys) {
            const b = pointsBounds(polys.flat());
            return [b.minX, b.minY, b.maxX, b.maxY];
        }

        const getRoom = id => STATE.rooms.find(r => r.id === id);

        function getSelectedRoom() {
            return getRoom(STATE.selectedRoomId) || STATE.rooms[0] || null;
        }

        function initRoomSelectorDropdown() {
            const select = $id('room-selector');
            const html = STATE.rooms.length === 0
                ? `<option value="">暂无空间</option>`
                : STATE.rooms.map(r => {
                    const area = r.stats ? r.stats.areaSqm.toFixed(1) : '0.0';
                    return `<option value="${r.id}">${r.name} (${area}m²)</option>`;
                }).join('');
            if (select) {
                select.innerHTML = html;
                if (STATE.selectedRoomId && STATE.rooms.length) select.value = STATE.selectedRoomId;
            }
        }

        // 在任意 canvas 上绘制花色缩略图（左侧色卡与花色选择管理器共用）
        function drawMaterialSwatch(swCanvas, materialType, styleObj) {
            if (!swCanvas) return;
            const c = swCanvas.getContext('2d');
            const w = swCanvas.width, h = swCanvas.height;

            if (styleObj.img) {
                c.clearRect(0, 0, w, h);
                c.drawImage(styleObj.img, 0, 0, w, h);
                return;
            }

            c.fillStyle = styleObj.base;
            c.fillRect(0, 0, w, h);
            if (materialType === 'tile') {
                if (styleObj.kind === '墙板') {
                    // 墙板预设：竖向护墙/格栅拼接纹理，便于与普通瓷砖直观区分
                    const cols = 6;
                    const cw = w / cols;
                    for (let i = 0; i < cols; i++) {
                        c.fillStyle = i % 2 === 0 ? styleObj.base : styleObj.accent;
                        c.fillRect(i * cw, 0, cw, h);
                        c.strokeStyle = styleObj.vein;
                        c.lineWidth = 1;
                        c.beginPath();
                        c.moveTo(i * cw, 0);
                        c.lineTo(i * cw, h);
                        c.stroke();
                    }
                } else if (styleObj.kind === '吊顶板') {
                    // 吊顶板预设：2×2 模块化扣板/蜂窝大板拼缝与柔和斜向反光
                    c.fillStyle = styleObj.accent;
                    c.fillRect(0, 0, w / 2, h / 2);
                    c.fillRect(w / 2, h / 2, w / 2, h / 2);
                    c.strokeStyle = styleObj.vein;
                    c.lineWidth = 1.1;
                    c.strokeRect(0.5, 0.5, w - 1, h - 1);
                    c.beginPath();
                    c.moveTo(w / 2, 0); c.lineTo(w / 2, h);
                    c.moveTo(0, h / 2); c.lineTo(w, h / 2);
                    c.stroke();
                } else {
                    c.strokeStyle = styleObj.vein;
                    c.lineWidth = 1.4;
                    for (let i = 0; i < 5; i++) {
                        c.beginPath();
                        c.moveTo((i * 19) % w, 0);
                        c.bezierCurveTo(w * 0.3, h * 0.4, w * 0.7, h * 0.6, ((i + 2) * 23) % w, h);
                        c.stroke();
                    }
                }
            } else {
                const plankH = h / 3;
                for (let row = 0; row < 3; row++) {
                    c.fillStyle = row % 2 === 0 ? styleObj.base : styleObj.accent;
                    c.fillRect(0, row * plankH, w, plankH);
                    c.strokeStyle = styleObj.vein;
                    c.lineWidth = 1;
                    c.strokeRect(0, row * plankH, w, plankH);
                }
            }
        }

        /** 左侧「规格编号」行：类型下拉、前缀、后缀与编号预览 */
        function syncSpecNumberRow(room) {
            const kindEl = $id('spec-kind-select'), preEl = $id('spec-prefix-input'), sepEl = $id('spec-sep-input'), pvEl = $id('spec-num-preview');
            if (!kindEl) return;
            const mt = room ? room.materialType : 'tile';
            const meta = getSpecMeta('floor', mt, room ? room.styleId : null);
            const opts = specKindList(mt).map(k => `<option value="${k.kind}">${k.kind}</option>`).join('');
            if (kindEl.dataset.mt !== mt) { kindEl.innerHTML = opts; kindEl.dataset.mt = mt; }
            kindEl.value = meta.kind;
            kindEl.disabled = !room;
            if (document.activeElement !== preEl) preEl.value = meta.prefix;
            if (document.activeElement !== sepEl) sepEl.value = tileNumSep();
            preEl.disabled = !room;
            const lbl = room && room.specLabel ? room.specLabel : `${meta.prefix}${(STATE.specList || []).filter(s => s.prefix === meta.prefix).length + 1}`;
            pvEl.textContent = `${lbl}${tileNumSep()}1`;
        }

        function syncLeftPanelFromSelectedRoom() {
            const room = getSelectedRoom();
            if (!room) {
                const sizeSelect = $id('size-select');
                if (sizeSelect && !sizeSelect.innerHTML.trim()) {
                    sizeSelect.innerHTML = MaterialLib.sizes('tile').map(s => `<option value="${s.label}">${s.label}</option>`).join('');
                }
                const defStyle = MaterialLib.get(null, 'tile');
                $id('swatch-label').textContent = defStyle.name;
                drawMaterialSwatch($id('swatch-canvas'), 'tile', defStyle);
                if (typeof Elevation !== 'undefined') Elevation.syncRoomInputs(null);
                return;
            }
            const roomSel = $id('room-selector');
            if (roomSel) roomSel.value = room.id;
            const styleObj = MaterialLib.getForRoom(room);

            $id('room-name-input').value = room.name || '';
            syncSpecNumberRow(room);

            const btnTile = $id('btn-mat-tile');
            const btnWood = $id('btn-mat-wood');
            const titleEl = $id('param-section-title');
            const groutPanel = $id('tile-grout-panel');
            const expansionPanel = $id('wood-expansion-panel');

            if (titleEl) titleEl.textContent = '砖材';
            if (room.materialType === 'tile') {
                btnTile.className = 'mat-card-btn active';
                btnWood.className = 'mat-card-btn';
                groutPanel.classList.remove('hidden');
            } else {
                btnWood.className = 'mat-card-btn active';
                btnTile.className = 'mat-card-btn';
                groutPanel.classList.add('hidden');
            }
            if (expansionPanel) expansionPanel.classList.remove('hidden');

            const sizeSelect = $id('size-select');
            const sizes = MaterialLib.sizes(room.materialType);
            const presetOptionsHtml = sizes.map(s => `<option value="${s.label}">${s.label}</option>`).join('');
            const customOptionHtml = `<option value="custom">自定义 (${room.tileW} × ${room.tileH} mm)</option>`;
            sizeSelect.innerHTML = presetOptionsHtml + customOptionHtml;

            const matchedPreset = sizes.find(s => s.w === Number(room.tileW) && s.h === Number(room.tileH));
            sizeSelect.value = matchedPreset ? matchedPreset.label : 'custom';

            $id('custom-w-input').value = room.tileW;
            $id('custom-h-input').value = room.tileH;
            $id('gap-select').value = String(getRoomJointMM(room));
            const jointRow = $id('joint-gap-row');
            if (jointRow) jointRow.classList.toggle('hidden', room.materialType === 'wood');
            $id('grout-enable-chk').checked = room.groutEnabled !== false;
            if ($id('grout-settings-rows')) $id('grout-settings-rows').classList.toggle('opacity-50', room.groutEnabled === false);
            const groutColor = room.groutColor || '#94a3b8';
            $id('grout-color-select').value = groutColor;
            const groutSwatch = $id('grout-color-swatch');
            if (groutSwatch) groutSwatch.style.backgroundColor = groutColor;
            const groutHex = $id('grout-color-hex');
            if (groutHex) groutHex.textContent = groutColor.toUpperCase();
            const groutPriceEl = $id('grout-price-input');
            if (groutPriceEl && document.activeElement !== groutPriceEl) {
                groutPriceEl.value = priceOr(room.groutPrice, PRESETS.floor.room.groutPrice);
            }
            const floorAuxEl = $id('floor-aux-price-input');
            if (floorAuxEl && document.activeElement !== floorAuxEl) {
                floorAuxEl.value = priceOr(room.auxPrice, matPreset(room.materialType).auxPrice);
            }
            const tilePriceEl = $id('tile-price-input');
            if (tilePriceEl && document.activeElement !== tilePriceEl) {
                tilePriceEl.value = getSpecPrice(room.materialType, room.styleId, room.tileW, room.tileH);
            }
            $id('expansion-gap-input').value = room.expansionGap;
            $id('origin-select').value = room.originMode || 'bl';
            const grp = STATE.originGroups && STATE.originGroups.get(room.id);
            const hintEl = $id('origin-group-hint');
            if (hintEl) {
                hintEl.classList.toggle('hidden', !grp);
                if (grp) {
                    const names = grp.rooms.map(r => r.name).join('、');
                    hintEl.textContent = grp.master.id === room.id
                        ? `通铺组（${names}）以本空间起铺点为准`
                        : `通铺组（${names}）跟随「${grp.master.name}」起铺点；在此修改起铺位置将改为以本空间为准`;
                }
            }
            $id('wastage-input').value = room.wastage;

            document.querySelectorAll('.floor-only .pattern-btn').forEach(btn => {
                const pat = btn.getAttribute('data-pattern');
                btn.classList.toggle('active', room.pattern === pat);
            });

            $id('swatch-label').textContent = styleObj.name;
            drawMaterialSwatch($id('swatch-canvas'), room.materialType, styleObj);
            if (typeof Elevation !== 'undefined') Elevation.syncRoomInputs(room);
        }

        function doorDirectionSvg(hinge, flip) {
            const hx = hinge ? 30 : 14;
            const ox = hinge ? 14 : 30;
            const s = flip ? -1 : 1;
            const oy = 24 + s * 16;
            const sweep = hinge ? (s > 0 ? 0 : 1) : (s > 0 ? 1 : 0);
            return `<svg viewBox="0 0 44 48" width="100%" height="34" xmlns="http://www.w3.org/2000/svg">` +
                `<rect x="2" y="20" width="40" height="8" rx="1" fill="#334155"/>` +
                `<rect x="14" y="20" width="16" height="8" fill="#ffffff"/>` +
                `<path d="M ${ox} 24 A 16 16 0 0 ${sweep} ${hx} ${oy}" fill="none" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3 3"/>` +
                `<line x1="${hx}" y1="24" x2="${hx}" y2="${24 + s * 14}" stroke="#1e293b" stroke-width="2.4" stroke-linecap="round"/>` +
                `<circle cx="${hx}" cy="24" r="2.6" fill="#1e293b"/></svg>`;
        }

        const DOOR_DIRECTIONS = [
            { hinge: 0, flip: false }, { hinge: 1, flip: false },
            { hinge: 0, flip: true }, { hinge: 1, flip: true }
        ];

        /** 选中门时刷新「连接形式 / 过门形式 / 过门偏移 / 过门石花色」，选项按两侧材质组合动态生成 */
        function syncDoorPavingSettings(op) {
            const dPlan = analyzeDoorAdjacency(op, 1);
            const box = $id('door-paving-settings');
            if (!box) return;
            box.classList.toggle('hidden', !dPlan);
            if (!dPlan) return;
            const esc = escapeHtmlText;
            const badgeEl = $id('door-adj-badge');
            badgeEl.textContent = dPlan.scenarioLabel;
            badgeEl.title = `${dPlan.scenarioLabel}\n当前：${dPlan.effModeLabel}${dPlan.strips.length ? ` · ${dPlan.effStripTypeLabel} ${dPlan.strips.length}根` : ''}`;

            const jointSel = $id('door-joint-select');
            jointSel.innerHTML = dPlan.jointOptions.map(j =>
                `<option value="${j.value}"${j.disabled ? ' disabled' : ''}>${esc(j.label)}${j.disabled && j.value === 'continuous' ? ' (两侧规格/铺法/缝宽不同)' : ''}</option>`).join('');
            jointSel.value = dPlan.joint;

            $id('door-threshold-style-row').classList.toggle('hidden', dPlan.joint !== 'threshold');
            const thPriceRow = $id('door-threshold-price-row');
            if (thPriceRow) {
                thPriceRow.classList.toggle('hidden', !dPlan.thresholdStone);
                const thInp = $id('door-threshold-price-input');
                if (thInp && document.activeElement !== thInp) {
                    thInp.value = priceOr(op.thresholdPrice, dPlan.thresholdStone?.price ?? PRESETS.door.thresholdPrice);
                }
            }
            const stripPriceRow = $id('door-strip-price-row');
            if (stripPriceRow) {
                const hasStrip = !!(dPlan.strips && dPlan.strips.length > 0);
                stripPriceRow.classList.toggle('hidden', !hasStrip);
                const stInp = $id('door-strip-price-input');
                if (stInp && document.activeElement !== stInp) {
                    stInp.value = priceOr(op.stripPrice, PRESETS.door.stripPrice);
                }
            }
            const tsInfo = getThresholdStyle(op);
            $id('door-threshold-swatch-label').textContent = tsInfo.name;
            $id('door-threshold-swatch-label').title = tsInfo.name;
            drawMaterialSwatch($id('door-threshold-swatch'), 'tile', { base: tsInfo.fill, vein: tsInfo.vein, accent: tsInfo.fill, img: tsInfo.img });

            $id('door-occupy-row').classList.toggle('hidden', !dPlan.usesOccupy);
            $id('door-offset-row').classList.toggle('hidden', !dPlan.usesOccupy);
            if (dPlan.usesOccupy) {
                const mat = r => r.materialType === 'wood' ? '木地板' : '瓷砖';
                const occSel = $id('door-occupy-select');
                occSel.innerHTML = [dPlan.roomA, dPlan.roomB].map(r =>
                    `<option value="${r.id}">${esc(r.name)}(${mat(r)}) 占门框</option>`).join('');
                occSel.value = dPlan.occupyRoomId;
                const offEl = $id('door-offset-input');
                offEl.max = String(dPlan.thMM);
                if (document.activeElement !== offEl) offEl.value = String(dPlan.offsetMM);
            }
        }

        function updateInspector() {
            syncUsageScope();
            const wallPanel = $id('inspector-wall-panel');
            const opPanel = $id('inspector-opening-panel');
            wallPanel.classList.add('hidden');
            opPanel.classList.add('hidden');

            const isWallActive = STATE.selectedWallIds.size > 0 || STATE.selected?.type === 'wall';
            if (isWallActive) {
                wallPanel.classList.remove('hidden');
                const wallId = STATE.selectedWallIds.size >= 1 ? Array.from(STATE.selectedWallIds)[0] : STATE.selected.id;
                const wall = getWall(wallId);
                if (wall) {
                    const thMM = Math.round((wall.thickness || 12) * 20);
                    const thInput = $id('wall-thickness-input');
                    if (thInput) thInput.value = String(thMM);
                    document.querySelectorAll('.combo-dropdown-item').forEach(item => {
                        item.classList.toggle('active', item.getAttribute('data-val') === String(thMM));
                    });
                    $id('btn-straighten-wall').classList.toggle('hidden', !isWallDiagonal(wall.id));
                }
            } else if (STATE.selected?.type === 'opening') {
                const op = STATE.openings.find(o => o.id === STATE.selected.id);
                if (!op) return;
                opPanel.classList.remove('hidden');
                $id('opening-type-title').innerHTML =
                    `<span>${op.type === 'window' ? '窗属性' : '门属性'}</span>`;
                $id('opening-width-input').value = Math.round((op.width || 45) * 20);
                const wall = getWall(op.wallId);
                const v1 = wall && getVertex(wall.v1), v2 = wall && getVertex(wall.v2);
                if (v1 && v2) {
                    const wallLen = dist(v1, v2);
                    const halfW = (op.width || 45) / 2;
                    const d1MM = Math.max(0, Math.round((op.t * wallLen - halfW) * 20));
                    const d2MM = Math.max(0, Math.round(((1 - op.t) * wallLen - halfW) * 20));
                    const d1El = $id('opening-dist1-input');
                    const d2El = $id('opening-dist2-input');
                    if (d1El && document.activeElement !== d1El) d1El.value = d1MM;
                    if (d2El && document.activeElement !== d2El) d2El.value = d2MM;
                }
                const dirBlock = $id('door-direction-block');
                dirBlock.classList.toggle('hidden', op.type !== 'door');
                $id('door-paving-settings')?.classList.toggle('hidden', op.type !== 'door');
                if (op.type === 'door') {
                    const grid = $id('door-direction-grid');
                    grid.innerHTML = '';
                    DOOR_DIRECTIONS.forEach(cfg => {
                        const active = !!op.hinge === !!cfg.hinge && !!op.flip === !!cfg.flip;
                        const btn = document.createElement('button');
                        btn.type = 'button';
                        btn.className = 'door-dir-btn' + (active ? ' active' : '');
                        btn.innerHTML = doorDirectionSvg(cfg.hinge, cfg.flip);
                        btn.onclick = () => {
                            saveHistory();
                            op.hinge = cfg.hinge; op.flip = cfg.flip;
                            refreshViews({ tiling: true, inspector: true, results: true, preview3d: true });
                        };
                        grid.appendChild(btn);
                    });

                    // 入户门标记开关：仅当选中的是最外墙门时显示
                    const entryRow = $id('door-entry-mark-row');
                    const entryChk = $id('chk-door-entry-mark');
                    const isExtDoor = !!getExteriorDoorDirection(op);
                    if (entryRow) entryRow.classList.toggle('hidden', !isExtDoor);
                    if (entryChk) entryChk.checked = isExtDoor && !!op.isEntryDoor;

                    // 门洞过门设置：连接形式 + 过门形式 / 偏移
                    syncDoorPavingSettings(op);
                }
                if (typeof Elevation !== 'undefined') Elevation.syncOpeningInputs(op);
            }
        }

        // 全屋汇总（合并地面砖、墙面砖与踢脚线，不含已清除空间），UI 面板与 DXF / A4 / PDF 导出共用
        function sumRoomStats() {
            const wallInfo = (typeof Elevation !== 'undefined' && Elevation.computeAllWallStats)
                ? Elevation.computeAllWallStats()
                : {
                    tot: { area: 0, buy: 0, buyArea: 0, full: 0, large: 0, small: 0, tileCost: 0, cost: 0, groutLen: 0, groutTubes: 0, groutCost: 0, auxArea: 0, auxCost: 0 },
                    skTot: { netM: 0, totalM: 0, areaSqm: 0, tileBuy: 0, woodBuy: 0, cost: 0, auxArea: 0, auxCost: 0 }
                };
            const wt = wallInfo.tot || {};
            const skt = wallInfo.skTot || {};
            const t = {
                floorArea: 0, wallArea: wt.area || 0, sumArea: 0,
                sumF: wt.full || 0, sumC: wt.large || 0, sumS: wt.small || 0, sumBuy: wt.buy || 0,
                sumGroutLen: 0, sumGroutTubes: 0, sumGroutCost: 0,
                sumAux: 0, sumAuxCost: 0,
                floorTileCost: 0, floorTotalCost: 0,
                skirtingNetM: skt.netM || 0,
                skirtingTotalM: skt.totalM || 0,
                skirtingAreaSqm: skt.areaSqm || 0,
                skirtingTileBuy: skt.tileBuy || 0,
                skirtingWoodBuy: skt.woodBuy || 0,
                skirtingCost: skt.cost || 0,
                wallTileCost: wt.tileCost || 0,
                wallGroutLen: wt.groutLen || 0,
                wallGroutTubes: wt.groutTubes || 0,
                wallGroutCost: wt.groutCost || 0,
                wallAux: (wt.auxArea || 0) + (skt.auxArea || 0),
                wallAuxCost: (wt.auxCost || 0) + (skt.auxCost || 0),
                wallCost: (wt.tileCost || 0) + (wt.groutCost || 0) + (wt.auxCost || 0) + (skt.auxCost || 0) + (skt.cost || 0),
                allCost: 0
            };
            for (const r of STATE.rooms) {
                if (r.cleared || !r.stats) continue;
                const st = r.stats;
                const rPrice = getSpecPrice(r.materialType, r.styleId, r.tileW, r.tileH);
                const rBuyArea = st.buyAreaSqm ?? (st.buyCount * ((r.tileW * r.tileH) / 1e6));
                t.floorArea += st.areaSqm;
                t.sumF += st.fullCount;
                t.sumC += st.cutLargeCount;
                t.sumS += st.cutSmallCount;
                t.sumBuy += st.buyCount;
                t.sumGroutLen += st.groutLengthM || 0;
                t.sumGroutTubes += st.groutTubes || 0;
                t.sumGroutCost += st.groutCost || 0;
                t.sumAux += st.auxArea || 0;
                t.sumAuxCost += st.auxCost || 0;
                t.floorTileCost += rBuyArea * rPrice;
            }
            const dsCost = STATE.doorSummary?.doorExtraCost || 0;
            t.floorTotalCost = t.floorTileCost + t.sumGroutCost + t.sumAuxCost + dsCost;
            t.allCost = t.floorTotalCost + t.wallCost;
            t.sumArea = t.floorArea + t.wallArea;
            return t;
        }

        /**
         * 用量汇总：把当前层需要的每一种材料一项一项列出（地面砖/地板、墙砖、踢脚线、过门石、压边条、美缝剂、铺贴辅料）。
         * scopeRoom 为空统计全层，否则只统计该空间（地面 + 该空间墙面 + 与之相邻的门洞）。
         * 每项带报价默认值：unit / qty / price 与工作站左侧填写的单价一致，quote.html 报价单直接使用。
         */
        function buildMaterialUsageItems(scopeRoom = null) {
            const items = [];
            const byKey = new Map();
            const r2 = v => Math.round((Number(v) || 0) * 100) / 100;
            const touch = (key, base) => {
                let it = byKey.get(key);
                if (!it) {
                    it = Object.assign({ areaSqm: 0, count: 0, qty: 0, lenM: 0, buyLenM: 0, places: [] }, base);
                    byKey.set(key, it);
                    items.push(it);
                }
                return it;
            };
            const addPlace = (it, tag) => { if (tag && !it.places.includes(tag)) it.places.push(tag); };
            const inScope = r => r && !r.cleared && (!scopeRoom || r.id === scopeRoom.id);

            // 1. 地面主材（按规格编号归并）
            for (const r of STATE.rooms) {
                if (!inScope(r) || !r.stats || !r.computedTiles || !r.computedTiles.length) continue;
                const isWood = r.materialType === 'wood';
                const meta = getSpecMeta('floor', r.materialType, r.styleId);
                const st = MaterialLib.getForRoom(r);
                const code = r.specLabel || previewRoomSpecLabel(r);
                const price = getSpecPrice(r.materialType, r.styleId, r.tileW, r.tileH);
                const it = touch(`F|${code}|${price}`, {
                    cat: 'main', code, kind: meta.kind, name: st?.name || meta.kind,
                    spec: `${r.tileW}×${r.tileH}`, countUnit: isWood ? '片' : '块', unit: 'm²', price
                });
                it.areaSqm += r.stats.areaSqm || 0;
                it.count += r.stats.buyCount || 0;
                it.qty += r.stats.buyAreaSqm ?? ((r.stats.buyCount || 0) * r.tileW * r.tileH / 1e6);
                addPlace(it, `${r.name}(地面)`);
            }

            const wallInfo = (typeof Elevation !== 'undefined' && Elevation.computeAllWallStats)
                ? Elevation.computeAllWallStats() : { rows: [], skirtingRows: [] };

            // 2. 墙面砖（按铺贴区规格归并）
            if (typeof Elevation !== 'undefined' && Elevation.forEachWallZone) {
                Elevation.forEachWallZone((z, room) => {
                    if (!inScope(room)) return;
                    const meta = getSpecMeta('wall', 'tile', z.spec.styleId);
                    const st = MaterialLib.get(z.spec.styleId, 'tile');
                    const code = z.specLabel || `${meta.prefix}?`;
                    const price = getSpecPrice('tile', z.spec.styleId, z.tw, z.th);
                    const buy = z.stats?.buy ?? 0;
                    const it = touch(`W|${code}|${z.tw}x${z.th}|${price}`, {
                        cat: 'main', code, kind: meta.kind, name: st?.name || meta.kind,
                        spec: `${z.tw}×${z.th}`, countUnit: '块', unit: 'm²', price
                    });
                    it.areaSqm += z.stats?.area || 0;
                    it.count += buy;
                    it.qty += buy * z.tw * z.th / 1e6;
                    addPlace(it, `${room.name}(墙面)`);
                });
            }

            // 3. 踢脚线（按 类型-长×厚×高 + 计价方式 归并；按房间合并净长后的精准采购量，与总造价一致）
            const skAux = new Map();
            const skList = wallInfo.skirtingMerged || wallInfo.skirtingRows || [];
            for (const s of skList) {
                if (!inScope(s.room)) continue;
                const isWood = s.sk.type === 'wood';
                const pu = s.sk.priceUnit || 'sqm';
                const unit = pu === 'piece' ? (isWood ? '根' : '块') : (pu === 'm' ? 'm' : 'm²');
                const it = touch(`SK|${s.sk.type}|${s.sk.lenMM}x${s.sk.thickMM}x${s.sk.heightMM}|${pu}|${s.sk.price}`, {
                    cat: 'skirting', code: `${isWood ? 'SKW' : 'SKT'}-${s.sk.lenMM}x${s.sk.heightMM}`,
                    kind: isWood ? '木质踢脚线' : '瓷砖踢脚线', name: isWood ? '木质踢脚线' : '瓷砖踢脚线',
                    spec: `${s.sk.lenMM}×${s.sk.heightMM}×${s.sk.thickMM}`, countUnit: isWood ? '根' : '块', unit, price: s.sk.price
                });
                it.count += s.buyCount;
                it.lenM += s.netM;
                it.buyLenM += s.buyLenM || 0;
                it.qty += pu === 'piece' ? s.buyCount : (pu === 'm' ? s.buyLenM : s.buyAreaSqm);
                addPlace(it, `${s.room.name}(踢脚)`);
                const qtyAux = s.auxQty != null ? s.auxQty : (isWood ? s.buyAreaSqm * 0.25 * (s.sk.thickMM / 15) : s.buyAreaSqm * (s.sk.thickMM / 12));
                if (qtyAux > 0) {
                    const p = s.auxUnitPrice != null ? s.auxUnitPrice : (qtyAux > 0 ? r2(s.auxCost / qtyAux) : 0);
                    const a = skAux.get(p) || { qty: 0, places: [] };
                    a.qty += qtyAux;
                    if (!a.places.includes(s.room.name)) a.places.push(s.room.name);
                    skAux.set(p, a);
                }
            }

            // 4. 门洞过门石与压边条（单空间时统计与之相邻的门洞）
            for (const dp of (STATE.computedDoors || [])) {
                if (scopeRoom && dp.roomA?.id !== scopeRoom.id && dp.roomB?.id !== scopeRoom.id) continue;
                const op = STATE.openings.find(o => o.id === dp.doorId);
                const adj = (dp.roomA && dp.roomB) ? `${dp.roomA.name}↔${dp.roomB.name}` : (dp.roomA?.name || dp.roomB?.name || '门洞');
                if (dp.thresholdStone) {
                    const ts = dp.thresholdStone;
                    const price = Number(ts.price) || 0;
                    const it = touch(`TS|${ts.styleName}|${ts.lenMM}x${ts.widMM}|${price}`, {
                        cat: 'door', code: 'MS', kind: '过门石', name: ts.styleName ? `过门石(${ts.styleName})` : '过门石',
                        spec: `${ts.lenMM}×${ts.widMM}`, countUnit: '块', unit: '块', price
                    });
                    it.count += 1; it.qty += 1; it.areaSqm += ts.areaSqm || 0;
                    addPlace(it, adj);
                }
                const sPrice = priceOr(op?.stripPrice, PRESETS.door.stripPrice);
                for (const st of (dp.strips || [])) {
                    const it = touch(`YT|${st.type || 'strip'}|${sPrice}`, {
                        cat: 'door', code: 'YT-1', kind: '压边条', name: st.typeLabel || '压边条',
                        spec: '按门宽', countUnit: '根', unit: 'm', price: sPrice
                    });
                    it.count += 1; it.lenM += st.lengthM || 0; it.qty += st.lengthM || 0;
                    addPlace(it, adj);
                }
            }

            // 5. 美缝剂（地面 + 墙面合并，按单价归并，按铺贴面积 m² 计价）
            const groutItem = (price) => touch(`MF|${price}`, {
                cat: 'grout', code: 'MF', kind: '美缝辅材', name: '美缝剂', spec: '', gaps: [],
                countUnit: 'm²', unit: 'm²', price
            });
            const addGap = (it, g) => { const s = String(g); if (!it.gaps.includes(s)) it.gaps.push(s); it.spec = `缝宽${it.gaps.join('/')}mm`; };
            for (const r of STATE.rooms) {
                const gArea = r.stats ? (r.stats.groutAreaSqm ?? (r.stats.groutTubes > 0 ? r.stats.areaSqm : 0)) : 0;
                if (!inScope(r) || !(gArea > 0)) continue;
                const price = priceOr(r.groutPrice, PRESETS.floor.room.groutPrice);
                const it = groutItem(price);
                it.count += gArea; it.qty += gArea; it.areaSqm += gArea; it.lenM += r.stats.groutLengthM || 0;
                addGap(it, getRoomJointMM(r));
                addPlace(it, `${r.name}(地面)`);
            }
            if (Array.isArray(wallInfo.groutGroups)) {
                for (const g of wallInfo.groutGroups) {
                    const gArea = g.area || 0;
                    if (!inScope(g.room) || !(gArea > 0)) continue;
                    const it = groutItem(g.price);
                    it.count += gArea; it.qty += gArea; it.areaSqm += gArea; it.lenM += g.len || 0;
                    (g.gaps || []).forEach(x => addGap(it, x));
                    addPlace(it, `${g.room.name}(墙面)`);
                }
            } else {
                const wallGroutGroups = new Map();
                for (const w of (wallInfo.rows || [])) {
                    const gArea = w.groutArea ?? ((w.groutLen > 0) ? (w.lay?.stats?.area || 0) : 0);
                    if (!inScope(w.room) || !(gArea > 0)) continue;
                    const gap = Math.max(0, Number(w.cfg?.gap ?? PRESETS.wall.face.gap));
                    const price = priceOr(w.cfg?.groutPrice, PRESETS.wall.face.groutPrice);
                    const k = `${w.room.id}|${w.cfg?.groutColor || PRESETS.wall.face.groutColor}|${price}`;
                    const g = wallGroutGroups.get(k) || { room: w.room, price, area: 0, len: 0, gaps: [] };
                    g.area += gArea;
                    g.len += w.groutLen || 0;
                    g.gaps.push(gap);
                    wallGroutGroups.set(k, g);
                }
                for (const g of wallGroutGroups.values()) {
                    const it = groutItem(g.price);
                    it.count += g.area; it.qty += g.area; it.areaSqm += g.area; it.lenM += g.len;
                    g.gaps.forEach(x => addGap(it, x));
                    addPlace(it, `${g.room.name}(墙面)`);
                }
            }

            // 6. 铺贴辅料（地面粘结 / 地板防潮垫 / 墙砖粘结 / 踢脚线辅料），数量 = 铺贴面积 × (1 + 损耗)
            for (const r of STATE.rooms) {
                if (!inScope(r) || !r.stats || !(r.stats.areaSqm > 0)) continue;
                const isWood = r.materialType === 'wood';
                const price = priceOr(r.auxPrice, matPreset(r.materialType).auxPrice);
                const it = touch(`AUXF|${isWood ? 'w' : 't'}|${price}`, {
                    cat: 'aux', code: isWood ? 'FL-DC' : 'FL-NJ', kind: '铺贴辅材',
                    name: isWood ? '地板防潮垫' : '地面铺贴辅料', spec: isWood ? '防潮膜/垫' : '水泥砂浆/瓷砖胶',
                    countUnit: 'm²', unit: 'm²', price
                });
                const q = (r.stats.areaSqm || 0) * (1 + Math.max(0, Number(r.wastage) || 0) / 100);
                it.qty += q; it.count += q;
                addPlace(it, `${r.name}(地面)`);
            }
            for (const w of (wallInfo.rows || [])) {
                if (!inScope(w.room) || !(w.lay?.stats?.area > 0)) continue;
                const wastage = Math.max(0, Number(w.cfg?.wastage ?? PRESETS.wall.face.wastage));
                const price = priceOr(w.cfg?.auxPrice, priceOr(w.room?.wallAuxPrice, PRESETS.wall.face.auxPrice));
                const it = touch(`AUXW|${price}`, {
                    cat: 'aux', code: 'FL-QNJ', kind: '铺贴辅材', name: '墙面铺贴辅料', spec: '瓷砖背胶/粘结剂',
                    countUnit: 'm²', unit: 'm²', price
                });
                const q = w.lay.stats.area * (1 + wastage / 100);
                it.qty += q; it.count += q;
                addPlace(it, `${w.room.name}(墙面)`);
            }
            for (const [price, a] of skAux) {
                const it = touch(`AUXS|${price}`, {
                    cat: 'aux', code: 'FL-SK', kind: '铺贴辅材', name: '踢脚线安装辅料', spec: '粘结剂/胶钉',
                    countUnit: 'm²', unit: 'm²', price
                });
                it.qty += a.qty; it.count += a.qty;
                a.places.forEach(p => addPlace(it, `${p}(踢脚)`));
            }

            const catOrder = { main: 0, skirting: 1, door: 2, grout: 3, aux: 4 };
            items.sort((a, b) => (catOrder[a.cat] - catOrder[b.cat]));
            for (const it of items) {
                it.qty = r2(it.qty);
                it.amount = r2(it.qty * it.price);
                const n = Number.isInteger(it.count) ? String(it.count) : it.count.toFixed(2);
                if (it.cat === 'main') it.usage = `${it.count}${it.countUnit}`;
                else if (it.cat === 'skirting') it.usage = `${it.count}${it.countUnit}`;
                else if (it.cat === 'door') it.usage = it.unit === 'm' ? `${it.lenM.toFixed(2)}m(${it.count}根)` : `${it.count}${it.countUnit}`;
                else if (it.cat === 'grout') it.usage = `${n}m²`;
                else it.usage = `${n}m²`;
                it.areaText = it.cat === 'main' ? `${it.qty.toFixed(2)}m²`
                    : (it.cat === 'skirting' ? `${it.buyLenM.toFixed(2)}m` : '');
                it.place = it.places.join('、');
            }
            return items;
        }

        /** 用量汇总的统计范围：立面模式 → 当前立面空间；平面中选中了空间 → 该空间；否则全层 */
        function getUsageScopeRoom() {
            const sel = (typeof Elevation !== 'undefined' && Elevation.curSelection) ? Elevation.curSelection() : null;
            if (sel && sel.active && sel.roomId) return getRoom(sel.roomId) || null;
            if (STATE.selected?.type === 'room' && STATE.selected.id === STATE.selectedRoomId) return getRoom(STATE.selectedRoomId) || null;
            return null;
        }
        /** 统计范围内的铺贴总面积（地面净面积 + 墙面铺贴面积） */
        function usageScopeArea(scopeRoom, t = null) {
            if (!scopeRoom) return (t || sumRoomStats()).sumArea;
            let area = scopeRoom.cleared ? 0 : (scopeRoom.stats?.areaSqm || 0);
            const wallInfo = (typeof Elevation !== 'undefined' && Elevation.computeAllWallStats) ? Elevation.computeAllWallStats() : { rows: [] };
            for (const w of (wallInfo.rows || [])) if (w.room === scopeRoom) area += w.lay?.stats?.area || 0;
            return area;
        }
        let g_usageScopeKey = '';
        /** 选中对象变化后（如点击墙体 / 门窗使空间失去选中）同步用量汇总的统计范围 */
        function syncUsageScope() {
            const r = getUsageScopeRoom();
            if ((r ? r.id : '') !== g_usageScopeKey) renderCalculationResults();
        }

        function renderCalculationResults() {
            const esc = SidePanel.esc;
            const scopeRoom = getUsageScopeRoom();
            g_usageScopeKey = scopeRoom ? scopeRoom.id : '';
            const items = buildMaterialUsageItems(scopeRoom);
            const t = sumRoomStats();

            const area = usageScopeArea(scopeRoom, t);
            const activeRooms = STATE.rooms.filter(r => !r.cleared).length;
            const badge = $id('usage-scope-badge');
            if (badge) {
                badge.textContent = scopeRoom ? scopeRoom.name : `全部 · ${activeRooms} 个空间`;
                badge.classList.toggle('is-room', !!scopeRoom);
                badge.title = scopeRoom ? `仅统计「${scopeRoom.name}」的地面、墙面与相邻门洞` : '统计当前层全部空间';
            }
            const sel = (typeof Elevation !== 'undefined' && Elevation.curSelection) ? Elevation.curSelection() : null;
            $id('btn-usage-show-all')?.classList.toggle('hidden', !scopeRoom || !!(sel && sel.active));
            if ($id('res-total-area-label')) $id('res-total-area-label').textContent = scopeRoom ? `铺贴总面积 · ${scopeRoom.name}` : '铺贴总面积';
            $id('res-total-area').innerHTML = `${area.toFixed(2)}<span class="summary-hero-unit">m²</span>`;

            const tbody = $id('usage-table-body');
            if (tbody) {
                tbody.innerHTML = items.length ? items.map(it => `
                    <tr class="usage-row" title="${esc(it.name)} ${esc(it.spec)}${it.cat === 'main' ? '\n采购面积：' + it.qty.toFixed(2) + 'm²（净铺贴 ' + it.areaSqm.toFixed(2) + 'm²）' : (it.cat === 'skirting' ? '\n采购长度：' + it.buyLenM.toFixed(2) + 'm（净长 ' + it.lenM.toFixed(2) + 'm）' : '')}${it.place ? '\n使用部位：' + esc(it.place) : ''}">
                        <td class="usage-name"><div class="truncate">${esc(it.name)}</div><div class="usage-sub truncate">${esc(it.kind !== it.name ? it.kind : '')}${it.code && it.cat === 'main' ? (it.kind !== it.name ? ' · ' : '') + esc(it.code) : ''}</div></td>
                        <td class="usage-spec font-mono">${esc(it.spec || '—')}</td>
                        <td class="usage-qty font-mono"><div>${esc(it.usage)}</div>${it.areaText ? `<div class="usage-sub">${esc(it.areaText)}</div>` : ''}</td>
                    </tr>`).join('')
                    : `<tr><td colspan="3" class="usage-empty">${STATE.rooms.length ? '该范围暂无铺贴材料' : '尚无闭合空间，请用「画墙」绘制或导入户型图'}</td></tr>`;
            }
            const cnt = $id('usage-item-count');
            if (cnt) cnt.textContent = `${items.length} 项`;
            const qBtn = $id('btn-open-quote');
            const anyFloorHasContent = STATE.floorsEnabled && STATE.floors.some(floorHasContent);
            if (qBtn) qBtn.disabled = items.length === 0 && !anyFloorHasContent;
        }

        /** 报价单弹窗：quote.html 独立页面，数据通过 IndexedDB + postMessage 传入；多层模式自动跨层汇总相同材料并附带各层分子行 */
        const QUOTE_DATA_KEY = 'tilecalc.quoteData';
        const MERCHANT_INFO_KEY = 'tilecalc.merchantInfo';
        function buildQuotePayload() {
            recomputeAllRoomTiling();
            let merchantInfo = null;
            try {
                const m = StorageDB.getJSON(MERCHANT_INFO_KEY, null);
                if (m && typeof m === 'object') merchantInfo = Object.assign({}, m);
            } catch (e) { }

            const rawFloors = STATE.floorsEnabled
                ? STATE.floors.map(f => ({
                    id: f.id,
                    name: f.name || f.id,
                    snap: f.id === STATE.currentFloorId ? JSON.parse(JSON.stringify(getSerializableState())) : (f.snap || emptyFloorState())
                }))
                : null;
            const activeFloors = rawFloors
                ? rawFloors.filter(f => (f.snap.walls && f.snap.walls.length > 0) || (f.snap.rooms && f.snap.rooms.length > 0))
                : [];

            // 多层模式且存在 2 层及以上有效户型：自动汇总所有楼层的相同材料，并附带每层明细子行一次性生成总报价
            if (STATE.floorsEnabled && activeFloors.length > 1) {
                const origSnap = JSON.parse(JSON.stringify(getSerializableState()));
                const origSelectedRoomId = STATE.selectedRoomId;
                const origSelected = STATE.selected;
                const mergedMap = new Map();
                const mergedList = [];
                let totalArea = 0;
                const floorNamesWithItems = [];

                try {
                    for (const fl of activeFloors) {
                        applyFloorSnapshotFields(fl.snap);
                        if (typeof Elevation !== 'undefined' && Elevation.resetCacheForExport) Elevation.resetCacheForExport();
                        recomputeAllRoomTiling();
                        const flItems = buildMaterialUsageItems(null);
                        totalArea += usageScopeArea(null);
                        if (flItems.length > 0) floorNamesWithItems.push(fl.name);

                        for (const it of flItems) {
                            const key = `${it.cat}|${it.name}|${it.spec || ''}|${it.unit}|${it.price}`;
                            let acc = mergedMap.get(key);
                            if (!acc) {
                                acc = {
                                    cat: it.cat,
                                    name: it.name,
                                    spec: it.spec || '',
                                    unit: it.unit,
                                    qty: 0,
                                    count: 0,
                                    countUnit: it.countUnit || '',
                                    price: it.price,
                                    floorRows: []
                                };
                                mergedMap.set(key, acc);
                                mergedList.push(acc);
                            }
                            const flQty = Math.round(((Number(it.qty) || 0) + Number.EPSILON) * 100) / 100;
                            acc.qty = Math.round((acc.qty + flQty + Number.EPSILON) * 100) / 100;
                            acc.count += Number(it.count) || 0;
                            const flNote = [it.cat === 'main' || it.cat === 'skirting' ? it.usage : '', it.place].filter(Boolean).join(' · ');
                            acc.floorRows.push({
                                floorName: fl.name,
                                qty: flQty,
                                note: flNote
                            });
                        }
                    }
                } finally {
                    applyFloorSnapshotFields(origSnap);
                    STATE.selectedRoomId = origSelectedRoomId;
                    STATE.selected = origSelected;
                    recomputeAllRoomTiling();
                    if (typeof Elevation !== 'undefined' && Elevation.onStateRestored) Elevation.onStateRestored();
                }

                const items = mergedList.map(acc => {
                    const flListStr = acc.floorRows.map(fr => fr.floorName).join('/');
                    const countNote = (acc.cat === 'main' || acc.cat === 'skirting') && acc.count > 0 && acc.countUnit
                        ? `共 ${Math.round(acc.count)}${acc.countUnit}`
                        : '';
                    return {
                        name: acc.name,
                        spec: acc.spec,
                        unit: acc.unit,
                        qty: acc.qty,
                        price: acc.price,
                        note: [countNote, flListStr].filter(Boolean).join(' · '),
                        floorRows: acc.floorRows
                    };
                });
                const floorSummary = (floorNamesWithItems.length ? floorNamesWithItems : activeFloors.map(f => f.name)).join(' + ');
                return {
                    projectName: getProjectName(),
                    clientName: getClientName(),
                    floorName: floorSummary,
                    scopeLabel: `全屋多层汇总 (${floorSummary})`,
                    multiFloor: true,
                    totalArea: Math.round(totalArea * 100) / 100,
                    fileBase: getProjectName(),
                    date: formatLocalDate('-'),
                    extraItems: PRESETS.quote.extraItems,
                    merchantInfo,
                    items
                };
            }

            const scopeRoom = getUsageScopeRoom();
            const items = buildMaterialUsageItems(scopeRoom).map(it => ({
                name: it.name, spec: it.spec || '', unit: it.unit, qty: it.qty, price: it.price,
                note: [it.cat === 'main' || it.cat === 'skirting' ? it.usage : '', it.place].filter(Boolean).join(' · ')
            }));
            return {
                projectName: getProjectName(),
                clientName: getClientName(),
                floorName: STATE.floorsEnabled ? (getCurrentFloor()?.name || '') : '',
                scopeLabel: scopeRoom ? scopeRoom.name : '全部空间',
                multiFloor: false,
                totalArea: Math.round(usageScopeArea(scopeRoom) * 100) / 100,
                fileBase: getExportBaseName(),
                date: formatLocalDate('-'),
                extraItems: PRESETS.quote.extraItems,   // 报价单「添加自定义项」菜单（presets.json quote.extraItems）
                merchantInfo,
                items
            };
        }
        async function buildQuotePayloadAsync() {
            await StorageDB.refreshKey(MERCHANT_INFO_KEY);
            const payload = buildQuotePayload();
            if (payload.merchantInfo && payload.merchantInfo.logoImageId) {
                try {
                    const du = await StorageDB.getImageDataUrl(payload.merchantInfo.logoImageId);
                    if (du) payload.merchantInfo.logoDataUrl = du;
                } catch (e) { }
            }
            return payload;
        }
        async function openQuoteModal() {
            const payload = await buildQuotePayloadAsync();
            if (!payload.items.length) { showToast('当前范围暂无材料，无法生成报价'); return; }
            const storePayload = Object.assign({}, payload);
            if (storePayload.merchantInfo) {
                storePayload.merchantInfo = Object.assign({}, storePayload.merchantInfo);
                delete storePayload.merchantInfo.logoDataUrl;
            }
            try { await StorageDB.setJSON(QUOTE_DATA_KEY, storePayload); } catch (e) { /* 忽略存储失败，改用窗口消息传递 */ }
            if (typeof DesktopHost !== 'undefined' && DesktopHost.isDesktop()) {
                try {
                    const winRes = await DesktopHost.openChildWindow({
                        id: 'quote',
                        url: 'quote.html',
                        title: `生成报价 · ${payload.projectName}`,
                        width: 1180,
                        height: 840,
                        minWidth: 880,
                        minHeight: 600,
                        resizable: true,
                        frameless: true,
                        center: true,
                        showInTaskbar: true,
                        backgroundColor: '#F5F7FA'
                    });
                    if (winRes) {
                        await DesktopHost.postToChild('quote', { type: 'tilecalc-quote-data', payload });
                        return;
                    }
                } catch (err) {
                    console.warn('[QuoteChildWindow]', err);
                }
            }
            const modal = $id('quote-modal');
            const ifr = $id('quote-iframe');
            ifr.onload = () => { try { ifr.contentWindow.postMessage({ type: 'tilecalc-quote-data', payload }, '*'); } catch (e) { } };
            ifr.src = 'quote.html?embed=1&t=' + Date.now();
            $id('quote-modal-sub').textContent = `${payload.projectName}${payload.floorName ? ' · ' + payload.floorName : ''} · ${payload.scopeLabel}`;
            modal.classList.remove('hidden');
        }

        // 可序列化的工程状态（去掉运行时的排砖结果）
        function getSerializableState() {
            const usedVertexIds = new Set(STATE.walls.flatMap(w => [w.v1, w.v2]));
            return {
                vertices: STATE.vertices.filter(v => usedVertexIds.has(v.id)),   // 画墙中尚未成墙的起点不入快照
                walls: STATE.walls,
                openings: STATE.openings,
                rooms: STATE.rooms.map(({ computedTiles, ...rest }) => rest),
                northAngle: STATE.northAngle || 0,
                floorHeightMM: STATE.floorHeightMM || PRESETS.wall.floorHeightMM,
                specMeta: STATE.specMeta || {},
                specPrices: STATE.specPrices || {},
                tileNumSep: tileNumSep()
            };
        }

        /* ---- 撤销 / 重做 ----
         * 约定：任何修改工程数据的操作，必须在修改【之前】调用 saveHistory()，记录修改前的状态。
         * undo()/redo() 在两个栈之间转移“当前状态”，因此每一步都能精确来回。 */
        const HISTORY_LIMIT = 60;

        function saveHistory() {
            pushUndoSnapshot(JSON.stringify(getSerializableState()));
        }

        function pushUndoSnapshot(snap) {
            if (STATE.undoStack[STATE.undoStack.length - 1] !== snap) {
                STATE.undoStack.push(snap);
                if (STATE.undoStack.length > HISTORY_LIMIT) STATE.undoStack.shift();
            }
            STATE.redoStack = [];
            markDirty();
            updateHistoryButtons();
        }

        /* 实时更新的输入框（边输入边预览）：首次变动时记下修改前快照，失焦/回车(change)时提交为一步撤销。
         * 这样一次连续输入只产生一条撤销记录，且能回到输入之前的状态。 */
        let pendingEdit = null;
        function beginLiveEdit() {
            if (pendingEdit === null) pendingEdit = JSON.stringify(getSerializableState());
        }
        function commitLiveEdit() {
            if (pendingEdit === null) return;
            if (pendingEdit !== JSON.stringify(getSerializableState())) pushUndoSnapshot(pendingEdit);   // 值未变化则不产生撤销记录
            pendingEdit = null;
        }

        // 载入/新建整个工程后调用：清空历史并视为已保存
        function resetHistory() {
            STATE.undoStack = [];
            STATE.redoStack = [];
            pendingEdit = null;
            setDirty(false);
            updateHistoryButtons();
        }

        function stepHistory(from, to, label) {
            if (!from.length) { showToast(`没有可${label}的操作`); return; }
            to.push(JSON.stringify(getSerializableState()));
            restoreFromSnapshot(from.pop());
            markDirty();
            showToast(`已${label}`);
        }
        const undo = () => stepHistory(STATE.undoStack, STATE.redoStack, '撤销');
        const redo = () => stepHistory(STATE.redoStack, STATE.undoStack, '重做');

        /* ---- 未保存标记与草稿自动保存 ----
         * 有未保存修改时，工程状态防抖写入 IndexedDB 草稿；意外关闭后可在欢迎页「继续上次工程」。
         * 保存工程 JSON / 载入新工程后草稿清除。 */
        const DRAFT_KEY = 'tilecalc.draft';
        let draftTimer = null;

        function updateTitleBar() {
            const name = $id('project-name-input').value || '未命名项目';
            document.title = `${STATE.dirty ? '● ' : ''}${name} - EasyTile`;
            if (typeof DesktopHost !== 'undefined' && DesktopHost.isDesktop() && window.HostBridge?.window?.setTitle) {
                window.HostBridge.window.setTitle(document.title).catch(() => {});
            }
        }

        function setDirty(v) {
            STATE.dirty = v;
            if (!v) {
                clearTimeout(draftTimer);
                try { StorageDB.remove(DRAFT_KEY); } catch (e) { /* 存储不可用时忽略 */ }
            }
            updateTitleBar();
        }

        function markDirty() {
            STATE.dirty = true;
            updateTitleBar();
            clearTimeout(draftTimer);
            draftTimer = setTimeout(saveDraft, 1200);
        }

        function saveDraft() {
            if (!STATE.walls.length) return;   // 空画布不覆盖已有草稿
            try {
                StorageDB.setJSON(DRAFT_KEY, {
                    savedAt: Date.now(),
                    projectName: $id('project-name-input').value,
                    clientName: $id('client-name-input')?.value || '',
                    state: getProjectState({ includeUnderlay: false })
                });
            } catch (e) { /* 存储受限时忽略 */ }
        }

        function readDraft() {
            try {
                const d = StorageDB.getJSON(DRAFT_KEY, null);
                return d && projectHasWalls(d.state) ? d : null;
            } catch (e) { return null; }
        }

        async function restoreDraft() {
            const d = readDraft();
            if (!d) return;
            if (!(await confirmSaveBeforeReplace('恢复工程草稿'))) return;
            STATE.currentFilePath = null;
            STATE.currentFileRevision = null;
            $id('project-name-input').value = d.projectName || '';
            if ($id('client-name-input')) $id('client-name-input').value = d.clientName || '';
            loadProjectState(d.state);
            resetHistory();
            markDirty();
            fitCanvasToContent();
            render();
            showToast('已恢复上次未保存的工程');
        }

        // 新建空白工程（可撤销）：工具栏「新建」与欢迎页共用
        /** 清空户型、底图、选择与绘制中间态（不含撤销栈），并刷新全部视图 */
        function resetDrawingState() {
            Object.assign(STATE, {
                vertices: [], walls: [], openings: [], rooms: [],
                northAngle: 0, bgImage: null, stage1Canvas: null, stage2Canvas: null,
                selected: null, selectedRoomId: null,
                wallStartVertex: null, wallDraft: null, activeSnapLines: [], originSnapPreview: null, openingSnapPreview: null,
                editingWallId: null, editingClearPx: null, measurePoints: []
            });
            STATE.selectedWallIds.clear();
            syncUnderlayUiState();
            $id('dim-input-popover').classList.add('hidden');
            $id('straighten-btn').classList.add('hidden');
            initRoomSelectorDropdown();
            refreshViews({ panel: true, inspector: true, results: true, preview3d: true, canvas: false });
        }

        async function newProject() {
            if (!(await confirmSaveBeforeReplace('新建空白工程'))) return;
            if ((typeof Elevation !== 'undefined')) Elevation.exit();
            saveHistory();
            STATE.currentFilePath = null;
            STATE.currentFileRevision = null;
            resetFloors();
            resetDrawingState();
            setTool('wall');
            render();
            showToast('已新建空白画布并进入【画墙】模式 · Ctrl+Z 可撤销');
        }

        // 清空当前画布所有内容（可撤销）；立面模式下只清空当前画布上显示的墙面铺贴
        function clearCanvas() {
            if (typeof Elevation !== 'undefined' && Elevation.isActive()) { Elevation.clearCanvas(); return; }
            const hasContent = STATE.walls.length > 0 || STATE.vertices.length > 0 || STATE.openings.length > 0 || STATE.rooms.length > 0 || STATE.bgImage !== null || STATE.measurePoints.length > 0;
            if (!hasContent) {
                showToast('当前画布已为空');
                return;
            }
            saveHistory();
            resetDrawingState();
            render();
            showToast('已清空画布 · Ctrl+Z 可撤销');
        }

        function applyFloorSnapshotFields(data) {
            STATE.vertices = data.vertices || [];
            STATE.walls = data.walls || [];
            STATE.openings = data.openings || [];
            STATE.specPrices = (data.specPrices && typeof data.specPrices === 'object') ? { ...data.specPrices } : {};
            STATE.rooms = (data.rooms || []).map(r => {
                const nr = createDefaultRoomProps(r);
                return nr;
            });
            STATE.northAngle = Number(data.northAngle) || 0;
            STATE.floorHeightMM = Number(data.floorHeightMM) || PRESETS.wall.floorHeightMM;
            STATE.specMeta = (data.specMeta && typeof data.specMeta === 'object') ? data.specMeta : {};
            STATE.tileNumSep = data.tileNumSep == null ? '-' : String(data.tileNumSep);
        }

        function restoreFromSnapshot(jsonStr) {
            applyFloorSnapshotFields(JSON.parse(jsonStr));
            STATE.selected = null;
            STATE.selectedWallIds.clear();
            if (!STATE.rooms.some(r => r.id === STATE.selectedRoomId)) {
                STATE.selectedRoomId = STATE.rooms[0]?.id || null;
            }
            recomputeAllRoomTiling();
            initRoomSelectorDropdown();
            refreshViews({ panel: true, inspector: true, canvas: false });
            updateHistoryButtons();
            if (typeof Elevation !== 'undefined') Elevation.onStateRestored();
            render();
        }

        /* ---- 多层图纸（层 = 工作表）----
         * STATE.floors 保存各层的快照、撤销栈、底图与视图；当前层的数据始终在 STATE.vertices/walls/openings/rooms 中。
         * 切换层时先把当前层写回其快照，再载入目标层。导出（DXF/DWG/PDF/A4/XLSX）只针对当前层。 */
        const BG_KEYS = ['bgImage', 'imageWidth', 'imageHeight', 'bgWorldScale', 'bgOffsetX', 'bgOffsetY', 'showBgImage', 'bgOpacity', 'stage1Canvas', 'stage2Canvas'];
        const emptyFloorState = () => ({ vertices: [], walls: [], openings: [], rooms: [], northAngle: STATE.northAngle || 0, floorHeightMM: STATE.floorHeightMM || PRESETS.wall.floorHeightMM, specMeta: JSON.parse(JSON.stringify(STATE.specMeta || {})), specPrices: JSON.parse(JSON.stringify(STATE.specPrices || {})), tileNumSep: tileNumSep() });

        /** 将单层底图及其标定参数序列化为可随 .tcalc 工程文件保存的对象（不进入公共图片数据库） */
        function serializeFloorUnderlay(bgObj) {
            if (!bgObj || !bgObj.bgImage) return null;
            const img = bgObj.bgImage;
            const nw = img.naturalWidth || img.width || 0;
            const nh = img.naturalHeight || img.height || 0;
            if (!nw || !nh) return null;
            let dataUrl = '';
            const rawSrc = typeof img.src === 'string' ? img.src : '';
            const maxSide = 2400;
            if (rawSrc.startsWith('data:image/') && Math.max(nw, nh) <= maxSide && rawSrc.length <= 3.5 * 1024 * 1024) {
                dataUrl = rawSrc;
            } else {
                try {
                    const k = Math.min(1, maxSide / Math.max(nw, nh));
                    const cv = document.createElement('canvas');
                    cv.width = Math.max(1, Math.round(nw * k));
                    cv.height = Math.max(1, Math.round(nh * k));
                    const ctx = cv.getContext('2d');
                    ctx.fillStyle = '#FFFFFF';
                    ctx.fillRect(0, 0, cv.width, cv.height);
                    ctx.drawImage(img, 0, 0, cv.width, cv.height);
                    dataUrl = cv.toDataURL('image/jpeg', 0.88);
                } catch (e) {
                    dataUrl = rawSrc.startsWith('data:image/') ? rawSrc : '';
                }
            }
            if (!dataUrl) return null;
            return {
                dataUrl,
                imageWidth: Number(bgObj.imageWidth) || nw,
                imageHeight: Number(bgObj.imageHeight) || nh,
                bgWorldScale: Number(bgObj.bgWorldScale) || 1,
                bgOffsetX: Number(bgObj.bgOffsetX) || 0,
                bgOffsetY: Number(bgObj.bgOffsetY) || 0,
                showBgImage: bgObj.showBgImage !== false,
                bgOpacity: bgObj.bgOpacity != null ? Number(bgObj.bgOpacity) : 0.4
            };
        }

        /** 将 .tcalc 工程文件中的单层底图还原为运行时 Image 对象 */
        function deserializeFloorUnderlay(u) {
            if (!u || !u.dataUrl || typeof u.dataUrl !== 'string') return Promise.resolve(null);
            return new Promise((resolve) => {
                const img = new Image();
                img.onload = () => {
                    const nw = img.naturalWidth || img.width || 960;
                    const nh = img.naturalHeight || img.height || 860;
                    const sc = Math.min(1, 1400 / Math.max(nw, nh));
                    resolve({
                        bgImage: img,
                        imageWidth: Number(u.imageWidth) || Math.max(1, Math.round(nw * sc)),
                        imageHeight: Number(u.imageHeight) || Math.max(1, Math.round(nh * sc)),
                        bgWorldScale: Number(u.bgWorldScale) || 1,
                        bgOffsetX: Number(u.bgOffsetX) || 0,
                        bgOffsetY: Number(u.bgOffsetY) || 0,
                        showBgImage: u.showBgImage !== false,
                        bgOpacity: u.bgOpacity != null ? Number(u.bgOpacity) : 0.4,
                        stage1Canvas: null,
                        stage2Canvas: null
                    });
                };
                img.onerror = () => resolve(null);
                img.src = u.dataUrl;
            });
        }

        function stashCurrentFloor() {
            const f = getCurrentFloor();
            if (!f) return;
            f.snap = JSON.parse(JSON.stringify(getSerializableState()));
            f.undo = STATE.undoStack;
            f.redo = STATE.redoStack;
            f.bg = Object.fromEntries(BG_KEYS.map(k => [k, STATE[k]]));
            f.view = { scale: STATE.scale, panX: STATE.panX, panY: STATE.panY };
        }

        function allFloorStates() {
            return STATE.floors.map(f => f.id === STATE.currentFloorId ? getSerializableState() : (f.snap || emptyFloorState()));
        }

        /** 工程级序列化：{ floorsEnabled, currentFloorId, floors: [{ id, name, state, underlay? }] } */
        function getProjectState({ includeUnderlay = false } = {}) {
            const cur = getSerializableState();
            return {
                floorsEnabled: !!STATE.floorsEnabled,
                currentFloorId: STATE.currentFloorId,
                floors: STATE.floors.map(f => {
                    const item = { id: f.id, name: f.name, state: f.id === STATE.currentFloorId ? cur : (f.snap || emptyFloorState()) };
                    if (includeUnderlay) {
                        const u = serializeFloorUnderlay(f.id === STATE.currentFloorId ? STATE : f.bg);
                        if (u) item.underlay = u;
                    }
                    return item;
                })
            };
        }
        const projectStateValid = x => !!(x && Array.isArray(x.floors) && x.floors.length);
        const projectHasWalls = x => projectStateValid(x) && x.floors.some(f => f.state?.walls?.length);

        function resetFloors() {
            STATE.floorsEnabled = false;
            STATE.floors = [{ id: 'F1', name: '1F', snap: null, undo: [], redo: [], bg: null, view: null }];
            STATE.currentFloorId = 'F1';
            renderFloorHud();
        }

        /** 载入工程级数据（含多层） */
        function loadProjectState(x) {
            STATE.floors = x.floors.map((f, i) => ({
                id: String(f.id || `F${i + 1}`), name: String(f.name || `${i + 1}F`),
                snap: f.state || emptyFloorState(), undo: [], redo: [], bg: null, view: null
            }));
            STATE.currentFloorId = STATE.floors.some(f => f.id === x.currentFloorId) ? x.currentFloorId : STATE.floors[0].id;
            STATE.floorsEnabled = !!x.floorsEnabled;
            restoreFromSnapshot(JSON.stringify(getCurrentFloor().snap));
            renderFloorHud();
        }

        /** 还原工程文件（.tcalc）中各楼层随工程保存的底图 */
        async function restoreProjectUnderlays(x) {
            if (!projectStateValid(x)) return;
            for (let i = 0; i < x.floors.length && i < STATE.floors.length; i++) {
                const rawFloor = x.floors[i];
                const fl = STATE.floors[i];
                if (rawFloor && rawFloor.underlay) {
                    const bg = await deserializeFloorUnderlay(rawFloor.underlay);
                    if (bg) {
                        fl.bg = bg;
                        if (fl.id === STATE.currentFloorId) {
                            for (const k of BG_KEYS) if (k in bg) STATE[k] = bg[k];
                        }
                    }
                }
            }
            syncUnderlayUiState();
        }

        /** 工程文件（.tcalc）格式：{ format, version, projectName, clientName, state, customStyles } */
        const PROJECT_FORMAT = 'tilecalc-project';
        const PROJECT_VERSION = 5;
        const isProjectFile = d => !!(d && d.format === PROJECT_FORMAT && Number(d.version) >= PROJECT_VERSION && projectStateValid(d.state));

        /** 打开工程文件数据（本地 .tcalc、示例工程共用）；格式不符时抛出异常 */
        async function openProjectData(d, { filePath = null, revision = null } = {}) {
            if (!isProjectFile(d)) throw new Error('不是有效的工程文件');
            if (typeof Elevation !== 'undefined') Elevation.exit();
            await MaterialLib.importRecords(d.customStyles);
            $id('project-name-input').value = d.projectName || PRESETS.project.defaultName;
            if ($id('client-name-input')) $id('client-name-input').value = d.clientName || '';
            STATE.currentFilePath = filePath || null;
            STATE.currentFileRevision = revision || null;
            Object.assign(STATE, { bgImage: null, stage1Canvas: null, stage2Canvas: null, selected: null });
            syncUnderlayUiState();
            loadProjectState(d.state);
            await restoreProjectUnderlays(d.state);
            resetHistory();
            setDirty(false);
            fitCanvasToContent();
            initRoomSelectorDropdown();
            refreshViews({ panel: true, results: true, preview3d: true });
        }

        /** 解析工程文件文本并打开，返回是否成功 */
        let _recordRecentProjectHook = null;
        let _skipNextFileInputConfirm = false;

        function anyProjectCanvasHasContent() {
            if (STATE.walls.length > 0 || STATE.rooms.length > 0 || STATE.openings.length > 0 || STATE.vertices.length > 0 || !!STATE.bgImage) {
                return true;
            }
            if (STATE.floorsEnabled && Array.isArray(STATE.floors)) {
                return STATE.floors.some(floorHasContent);
            }
            return false;
        }

        async function saveCurrentProjectFile() {
            const data = {
                format: PROJECT_FORMAT,
                version: PROJECT_VERSION,
                projectName: $id('project-name-input').value,
                clientName: $id('client-name-input')?.value || '',
                // 工程文件随同保存各楼层导入的参考底图与标定参数
                state: getProjectState({ includeUnderlay: true }),
                // 工程用到的自定义花色随工程保存（含所有层），换电脑导入后可还原
                customStyles: await MaterialLib.exportUsed(allFloorStates().flatMap(st => (st.rooms || []).map(r => r.styleId).concat((st.openings || []).map(o => o.thresholdStyleId))))
            };
            const fileName = `${data.projectName || '瓷砖算量工程'}${PROJECT_FILE_EXT}`;
            const jsonText = JSON.stringify(data, null, 2);
            const filter = 'EasyTile 工程文件 (*.tcalc)|*.tcalc|JSON 文件 (*.json)|*.json|所有文件 (*.*)|*.*';

            let saveRes = null;
            try {
                if (typeof DesktopHost !== 'undefined' && DesktopHost.isDesktop() && STATE.currentFilePath) {
                    try {
                        saveRes = await DesktopHost.saveBlob(jsonText, fileName, {
                            encoding: 'utf8',
                            filter,
                            saveAs: false,
                            path: STATE.currentFilePath,
                            revision: STATE.currentFileRevision || ''
                        });
                    } catch (overwriteErr) {
                        // 若文件已被外部改动或权限受限，自动退回另存为对话框避免误覆盖
                        saveRes = await DesktopHost.saveBlob(jsonText, fileName, {
                            encoding: 'utf8',
                            filter,
                            saveAs: true
                        });
                    }
                } else {
                    saveRes = await downloadBlob(new Blob([jsonText], { type: 'application/x-tilecalc+json' }), fileName, {
                        encoding: 'utf8',
                        filter,
                        saveAs: true
                    });
                }
            } catch (err) {
                showToast('保存失败：' + (err?.message || err));
                return false;
            }

            if (!saveRes || !saveRes.saved || saveRes.cancelled) return false;
            if (saveRes.path) {
                STATE.currentFilePath = saveRes.path;
                STATE.currentFileRevision = saveRes.revision || null;
            }
            if (typeof _recordRecentProjectHook === 'function') {
                _recordRecentProjectHook({
                    fileName: saveRes.name || fileName,
                    projectName: data.projectName,
                    clientName: data.clientName,
                    state: getProjectState({ includeUnderlay: false })
                });
            }
            setDirty(false);
            showToast(`工程已保存 (${saveRes.name || fileName} · Ctrl+S)`);
            return true;
        }

        async function confirmSaveBeforeReplace() {
            if (!anyProjectCanvasHasContent()) return true;
            const choice = await UiDialogs.confirmSave({
                title: '保存当前工程？',
                message: '画布上有未保存的内容，是否先保存？',
                detail: '',
                okText: '保存',
                altText: '不保存',
                cancelText: '取消',
                icon: 'ph-floppy-disk'
            });
            if (choice === 'save') {
                return await saveCurrentProjectFile();
            }
            return choice === 'discard';
        }

        async function openProjectTextContent(rawText, { fileName = '', filePath = null, revision = null, toast = true, skipConfirm = false } = {}) {
            let d = null;
            try { d = JSON.parse(rawText); } catch (err) { /* 非 JSON */ }
            if (!isProjectFile(d)) {
                showToast(`工程文件格式不正确（请选择本程序 v1.0.0 及以后保存的 ${PROJECT_FILE_EXT} 文件）`);
                return false;
            }
            if (!skipConfirm) {
                const targetTitle = d.projectName || String(fileName || '').replace(/\.(tcalc|json)$/i, '') || '其他工程';
                if (!(await confirmSaveBeforeReplace(`打开工程「${targetTitle}」`))) return false;
            }
            await openProjectData(d, { filePath, revision });
            if (typeof _recordRecentProjectHook === 'function') {
                _recordRecentProjectHook({
                    fileName: fileName || (filePath ? filePath.split(/[\\/]/).pop() : ''),
                    projectName: d.projectName || String(fileName || '').replace(/\.(tcalc|json)$/i, ''),
                    clientName: d.clientName || '',
                    state: getProjectState({ includeUnderlay: false })
                });
            }
            if (toast) showToast('工程文件已成功导入');
            return true;
        }

        /** 统一打开本地工程文件入口（桌面模式调用原生打开窗，浏览器模式触发隐藏 input） */
        async function openLocalProjectFile() {
            if (!(await confirmSaveBeforeReplace('打开其他工程文件'))) return;
            if (typeof DesktopHost !== 'undefined' && DesktopHost.isDesktop()) {
                try {
                    const res = await DesktopHost.openTextFile({
                        filter: 'EasyTile 工程文件 (*.tcalc;*.json)|*.tcalc;*.json|所有文件 (*.*)|*.*'
                    });
                    if (!res || res.cancelled) return;
                    const ok = await openProjectTextContent(res.content, {
                        fileName: res.name,
                        filePath: res.path,
                        revision: res.revision,
                        skipConfirm: true
                    });
                    if (ok && typeof window._closeWelcomeModal === 'function') window._closeWelcomeModal();
                } catch (err) {
                    showToast('打开工程失败：' + (err?.message || err));
                }
                return;
            }
            _skipNextFileInputConfirm = true;
            $id('json-file-input').click();
        }

        /** 示例工程：presets.json project.examples，一个直接打开，多个时弹出选择 */
        async function openExampleProject(ex) {
            try {
                const r = await fetch(ex.file, { cache: 'no-cache' });
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                await openProjectData(await r.json());
                showToast(`已打开示例工程「${ex.name}」`);
            } catch (err) {
                console.error('[示例工程]', ex.file, err);
                showToast(`示例工程「${ex.name}」打开失败：${ex.file}`);
            }
        }
        function openExamples() {
            const list = PRESETS.project.examples || [];
            if (!list.length) { showToast('presets.json 中未配置示例工程'); return; }
            if (list.length === 1) { openExampleProject(list[0]); return; }
            const modal = $id('modal-backdrop');
            $id('modal-title').textContent = '打开示例工程';
            $id('modal-content').innerHTML = `<div class="example-list">${list.map((ex, i) => `
                <button type="button" class="example-item" data-example="${i}">
                    <i class="ph ph-folder-open"></i>
                    <span class="example-item-text"><b>${escapeHtmlText(ex.name)}</b><small>${escapeHtmlText(ex.desc || ex.file)}</small></span>
                </button>`).join('')}</div>`;
            $id('modal-content').querySelectorAll('[data-example]').forEach(btn => btn.addEventListener('click', () => {
                modal.classList.add('hidden');
                openExampleProject(list[+btn.dataset.example]);
            }));
            modal.classList.remove('hidden');
        }

        function floorHasContent(f) {
            if (!f) return false;
            if (f.id === STATE.currentFloorId) {
                return STATE.walls.length > 0 || STATE.rooms.length > 0 || STATE.openings.length > 0 || !!STATE.bgImage;
            }
            const s = f.snap;
            const hasBg = !!(f.bg && f.bg.bgImage);
            return hasBg || !!(s && ((s.walls && s.walls.length > 0) || (s.rooms && s.rooms.length > 0) || (s.openings && s.openings.length > 0)));
        }

        async function toggleFloorMode() {
            if (!STATE.floorsEnabled) {
                STATE.floorsEnabled = true;
                markDirty();
                renderFloorHud();
                if (typeof Elevation !== 'undefined') Elevation.syncFloorInputs();
                showToast('已启用楼层管理');
                return;
            }
            // 关闭楼层模式：若有多层，仅保留当前层（若其他层有内容则提示确认）
            if (STATE.floors.length > 1) {
                const othersHaveContent = STATE.floors.some(f => f.id !== STATE.currentFloorId && floorHasContent(f));
                if (othersHaveContent) {
                    const ok = await UiDialogs.confirm({
                        title: '禁用楼层模式',
                        message: '其他楼层包含户型或排砖数据，禁用后将仅保留当前层，确定继续吗？',
                        detail: '其余楼层的数据将被清除，且无法撤销。',
                        okText: '确定',
                        danger: true
                    });
                    if (!ok) return;
                }
                const cur = getCurrentFloor();
                STATE.floors = [cur];
                STATE.currentFloorId = cur.id;
            }
            STATE.floorsEnabled = false;
            markDirty();
            renderFloorHud();
            render();
            if (typeof Elevation !== 'undefined') Elevation.syncFloorInputs();
            showToast('已禁用楼层模式');
        }

        function switchFloor(id) {
            if (id === STATE.currentFloorId || !STATE.floors.some(f => f.id === id)) return;
            if ((typeof Elevation !== 'undefined')) Elevation.exit();
            commitLiveEdit();
            stashCurrentFloor();
            STATE.currentFloorId = id;
            const f = getCurrentFloor();
            // 底图按层保存；新层无底图
            const bg = f.bg || { bgImage: null, stage1Canvas: null, stage2Canvas: null, bgOffsetX: 0, bgOffsetY: 0, bgWorldScale: 1, showBgImage: true, bgOpacity: 0.4 };
            for (const k of BG_KEYS) if (k in bg) STATE[k] = bg[k];
            Object.assign(STATE, { selected: null, wallStartVertex: null, wallDraft: null, activeSnapLines: [], originSnapPreview: null, openingSnapPreview: null, editingWallId: null, editingClearPx: null, measurePoints: [] });
            restoreFromSnapshot(JSON.stringify(f.snap || emptyFloorState()));
            STATE.undoStack = f.undo || [];
            STATE.redoStack = f.redo || [];
            updateHistoryButtons();
            syncUnderlayUiState();
            if (f.view && f.view.scale) Object.assign(STATE, f.view); else if (STATE.walls.length) fitCanvasToContent();
            renderFloorHud();
            render();
            showToast(`已切换到「${f.name}」`);
        }

        function nextFloorName() {
            let n = STATE.floors.length + 1;
            while (STATE.floors.some(f => f.name === `${n}F`)) n++;
            return `${n}F`;
        }

        async function addFloor(copyCurrent = false) {
            const name = await UiDialogs.prompt({
                title: copyCurrent ? '复制当前层' : '新建层',
                message: '层名称（如 2F、阁楼、地下室、方案B）',
                value: copyCurrent ? `${getCurrentFloor().name} 副本` : nextFloorName(),
                okText: '确定'
            });
            if (name == null) return;
            const nm = String(name).trim() || nextFloorName();
            let seq = STATE.floors.length + 1;
            while (STATE.floors.some(f => f.id === `F${seq}`)) seq++;
            const snap = copyCurrent ? JSON.parse(JSON.stringify(getSerializableState())) : emptyFloorState();
            const curBg = Object.fromEntries(BG_KEYS.map(k => [k, STATE[k]]));
            STATE.floors.push({ id: `F${seq}`, name: nm, snap, undo: [], redo: [], bg: copyCurrent ? curBg : null, view: copyCurrent ? { scale: STATE.scale, panX: STATE.panX, panY: STATE.panY } : null });
            markDirty();
            switchFloor(`F${seq}`);
            if (!copyCurrent) setTool('wall');
        }

        async function renameFloor() {
            const f = getCurrentFloor();
            const name = await UiDialogs.prompt({ title: '重命名层', message: '层名称', value: f.name, okText: '确定' });
            if (name == null || !String(name).trim()) return;
            f.name = String(name).trim();
            markDirty();
            renderFloorHud();
            if (typeof Elevation !== 'undefined') Elevation.syncFloorInputs();
        }

        async function deleteFloor(targetId = null) {
            if (STATE.floors.length <= 1) { showToast('至少保留一层，不能全部删除'); return; }
            const f = (targetId && STATE.floors.find(x => x.id === targetId)) || getCurrentFloor();
            if (!f) return;
            if (floorHasContent(f)) {
                const ok = await UiDialogs.confirm({
                    title: '删除层', message: `「${f.name}」包含户型或排砖内容，确定删除吗？`,
                    detail: '该层的户型与排砖数据将一并删除，且无法撤销。', okText: '删除', danger: true
                });
                if (!ok) return;
            }
            if (f.id === STATE.currentFloorId) {
                const idx = STATE.floors.indexOf(f);
                const target = STATE.floors[idx + 1] || STATE.floors[idx - 1];
                switchFloor(target.id);
            }
            STATE.floors = STATE.floors.filter(x => x !== f);
            markDirty();
            renderFloorHud();
            render();
            showToast(`已删除「${f.name}」`);
        }

        /**
         * 镜像翻转当前层户型：axis = 'x'（左右镜像）或 'y'（上下镜像）。
         * 绕户型包围盒中心原地镜像，同步修正门扇开启方向、空间多边形绕向、地面起铺点与墙面立面起铺方向，支持 Ctrl+Z 撤销。
         */
        function mirrorCurrentFloor(axis = 'x') {
            if (!STATE.walls.length && !STATE.vertices.length) {
                showToast('当前层暂无户型可镜像');
                return;
            }
            if (typeof Elevation !== 'undefined') Elevation.exit();
            commitLiveEdit();
            saveHistory();

            // 预取各房间墙面长度（镜像保持长度不变，用于精确翻转立面自定义起铺点 origin.x）
            const faceLenMap = new Map();
            if (typeof Elevation !== 'undefined' && typeof Elevation.getRoomFaces === 'function') {
                for (const r of STATE.rooms) {
                    if (!r.wallTiling?.faces) continue;
                    const map = new Map();
                    for (const f of Elevation.getRoomFaces(r)) map.set(f.key, f.lenMM);
                    faceLenMap.set(r.id, map);
                }
            }

            const usedIds = new Set(STATE.walls.flatMap(w => [w.v1, w.v2]));
            const boundVerts = usedIds.size ? STATE.vertices.filter(v => usedIds.has(v.id)) : STATE.vertices;
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            for (const v of boundVerts) {
                if (v.x < minX) minX = v.x;
                if (v.x > maxX) maxX = v.x;
                if (v.y < minY) minY = v.y;
                if (v.y > maxY) maxY = v.y;
            }
            const cx = (minX + maxX) * 0.5;
            const cy = (minY + maxY) * 0.5;
            const isX = axis === 'x';
            const r3 = n => Math.round(n * 1000) / 1000;

            for (const v of STATE.vertices) {
                if (isX) v.x = r3(2 * cx - v.x);
                else v.y = r3(2 * cy - v.y);
            }

            // 二维反射改变局部法向手性 (det = -1)，所有门洞需翻转 flip 以保持镜像后的真实开启侧
            for (const op of STATE.openings) {
                if (op.type === 'door') op.flip = !op.flip;
            }

            const modeSwap = isX
                ? { tl: 'tr', tr: 'tl', bl: 'br', br: 'bl' }
                : { tl: 'bl', bl: 'tl', tr: 'br', br: 'tr' };
            for (const r of STATE.rooms) {
                if (Array.isArray(r.vertexIds)) r.vertexIds.reverse();
                if (r.originMode && modeSwap[r.originMode]) r.originMode = modeSwap[r.originMode];
                if (isX && r.originX != null) r.originX = r3(2 * cx - r.originX);
                if (!isX && r.originY != null) r.originY = r3(2 * cy - r.originY);
                if ((isX && r.originDoorAlign === 'x') || (!isX && r.originDoorAlign === 'y')) {
                    r.originDoorOffset = -(Number(r.originDoorOffset) || 0);
                }
                if (r.wallTiling?.faces) {
                    const lens = faceLenMap.get(r.id);
                    for (const [fKey, cfg] of Object.entries(r.wallTiling.faces)) {
                        if (!cfg) continue;
                        if (cfg.alignH === 'left') cfg.alignH = 'right';
                        else if (cfg.alignH === 'right') cfg.alignH = 'left';
                        if (cfg.origin && Number.isFinite(Number(cfg.origin.x))) {
                            const lenMM = lens && lens.get(fKey);
                            if (lenMM > 0) cfg.origin.x = Math.round((lenMM - Number(cfg.origin.x)) * 10) / 10;
                        }
                    }
                }
            }

            Object.assign(STATE, {
                wallStartVertex: null, wallDraft: null, activeSnapLines: [],
                originSnapPreview: null, openingSnapPreview: null,
                editingWallId: null, editingClearPx: null, measurePoints: []
            });
            recomputeAllRoomTiling();
            if (typeof Elevation !== 'undefined' && typeof Elevation.onStateRestored === 'function') {
                Elevation.onStateRestored();
            }
            refreshViews({ panel: true, inspector: true, results: true, preview3d: true, canvas: true });
            showToast(isX ? '已将当前层户型左右镜像 · Ctrl+Z 可撤销' : '已将当前层户型上下镜像 · Ctrl+Z 可撤销');
        }

        function syncFloorHudOptions() {
            const lf = getLowerFloor();
            const ghostWrap = $id('floor-hud-ghost-wrap');
            const ghostChk = $id('floor-hud-ghost-chk');
            const ghostLbl = $id('floor-hud-ghost-label');
            const opRow = $id('floor-hud-ghost-opacity-row');
            const opSlider = $id('floor-hud-ghost-opacity');
            const opVal = $id('floor-hud-ghost-opacity-val');
            const hasLower = !!lf;
            if (ghostChk) {
                ghostChk.disabled = !hasLower;
                ghostChk.checked = hasLower && !!STATE.ghostLowerFloor;
            }
            if (ghostWrap) {
                ghostWrap.classList.toggle('is-disabled', !hasLower);
                ghostWrap.title = hasLower
                    ? `透显下一层「${lf.name}」的墙体、门窗与空间名称作为参考`
                    : '当前为最底层，切换至上层后可透显下层';
            }
            if (ghostLbl) {
                ghostLbl.textContent = hasLower ? `透显底层 (${lf.name})` : '透显底层 (无下层)';
            }
            const pct = Math.round(Math.max(0.1, Math.min(0.85, Number(STATE.ghostLowerOpacity) || 0.35)) * 100);
            if (opSlider) opSlider.value = String(pct);
            if (opVal) opVal.textContent = `${pct}%`;
            if (opRow) opRow.classList.toggle('hidden', !(hasLower && STATE.ghostLowerFloor));

            const hasGeo = STATE.walls.length > 0 || STATE.vertices.length > 0;
            const mx = $id('floor-hud-mirror-x');
            const my = $id('floor-hud-mirror-y');
            if (mx) mx.disabled = !hasGeo;
            if (my) my.disabled = !hasGeo;
        }

        function renderFloorHud() {
            const toggleBtn = $id('floor-hud-toggle');
            const btn = $id('floor-hud-btn');
            const menu = $id('floor-hud-menu');
            const btnText = $id('floor-hud-name');
            if (!btnText || !btn) return;
            const enabled = !!STATE.floorsEnabled;
            if (toggleBtn) {
                toggleBtn.setAttribute('aria-pressed', String(enabled));
                toggleBtn.title = enabled
                    ? '已启用楼层模式（点击关闭楼层模式）'
                    : '点击启用楼层模式（默认禁用，启用后显示层下拉列表并在导出图纸时附加楼层前缀）';
            }
            btn.classList.toggle('hidden', !enabled);
            if (!enabled && menu) {
                menu.classList.add('hidden');
                btn.setAttribute('aria-expanded', 'false');
            }
            const cur = getCurrentFloor();
            btnText.textContent = cur?.name || '1F';
            const list = $id('floor-hud-list');
            const canDel = STATE.floors.length > 1;
            // 新建的层显示在上方（楼层自下而上叠放）
            list.innerHTML = STATE.floors.slice().reverse().map(f => `
                <button type="button" class="floor-hud-item${f.id === STATE.currentFloorId ? ' is-active' : ''}" data-floor-id="${f.id}">
                    <i class="ph ${f.id === STATE.currentFloorId ? 'ph-check' : 'ph-stack'}"></i><span>${escapeHtmlText(f.name)}</span>
                    ${canDel ? `<span class="floor-item-del" data-del-floor-id="${f.id}" title="删除「${escapeHtmlText(f.name)}」"><i class="ph ph-trash"></i></span>` : ''}
                </button>`).join('');
            $id('floor-hud-del').disabled = !canDel;
            syncFloorHudOptions();
        }
        const escapeHtmlText = SidePanel.esc;   // HTML 转义（与左侧面板组件共用）

        function initFloorHud() {
            const hud = $id('floor-hud');
            if (!hud) return;
            const menu = $id('floor-hud-menu');
            const close = () => { menu.classList.add('hidden'); $id('floor-hud-btn').setAttribute('aria-expanded', 'false'); };
            const toggleBtn = $id('floor-hud-toggle');
            if (toggleBtn) {
                toggleBtn.addEventListener('click', e => {
                    e.stopPropagation();
                    close();
                    toggleFloorMode();
                });
            }
            $id('floor-hud-btn').addEventListener('click', e => {
                e.stopPropagation();
                if (!STATE.floorsEnabled) return;
                const open = menu.classList.contains('hidden');
                if (open) syncFloorHudOptions();
                menu.classList.toggle('hidden', !open);
                $id('floor-hud-btn').setAttribute('aria-expanded', String(open));
            });
            $id('floor-hud-list').addEventListener('click', e => {
                const delBtn = e.target.closest('[data-del-floor-id]');
                if (delBtn) {
                    e.stopPropagation();
                    close();
                    deleteFloor(delBtn.getAttribute('data-del-floor-id'));
                    return;
                }
                const b = e.target.closest('[data-floor-id]');
                if (!b) return;
                close();
                switchFloor(b.getAttribute('data-floor-id'));
            });
            $id('floor-hud-add').addEventListener('click', () => { close(); addFloor(false); });
            $id('floor-hud-copy').addEventListener('click', () => { close(); addFloor(true); });
            $id('floor-hud-rename').addEventListener('click', () => { close(); renameFloor(); });
            $id('floor-hud-del').addEventListener('click', () => { close(); deleteFloor(); });
            $id('floor-hud-ghost-chk')?.addEventListener('change', e => {
                STATE.ghostLowerFloor = !!e.target.checked;
                syncFloorHudOptions();
                render();
            });
            const onGhostOpacity = e => {
                const pct = Math.max(10, Math.min(85, parseInt(e.target.value, 10) || 35));
                STATE.ghostLowerOpacity = pct / 100;
                const valEl = $id('floor-hud-ghost-opacity-val');
                if (valEl) valEl.textContent = `${pct}%`;
                render();
            };
            $id('floor-hud-ghost-opacity')?.addEventListener('input', onGhostOpacity);
            $id('floor-hud-ghost-opacity')?.addEventListener('change', onGhostOpacity);
            $id('floor-hud-mirror-x')?.addEventListener('click', () => { close(); mirrorCurrentFloor('x'); });
            $id('floor-hud-mirror-y')?.addEventListener('click', () => { close(); mirrorCurrentFloor('y'); });
            document.addEventListener('mousedown', e => { if (!hud.contains(e.target)) close(); });
            renderFloorHud();
        }

        function updateHistoryButtons() {
            $id('btn-undo').disabled = !STATE.undoStack.length;
            $id('btn-redo').disabled = !STATE.redoStack.length;
        }

        function selectRoom(roomId) {
            STATE.selectedRoomId = roomId;
            // 空间选中只保留区域描边，清除可能残留的墙体端点圆形手柄。
            STATE.selectedWallIds.clear();
            const room = getRoom(roomId);
            if (room) {
                STATE.selected = { type: 'room', id: room.id, target: room };
            }
            if ($id('room-selector')) $id('room-selector').value = roomId;
            if (typeof Elevation !== 'undefined' && Elevation.isActive() && Elevation.switchRoom) {
                Elevation.switchRoom(roomId);
            }
            refreshViews({ panel: true, inspector: true, results: true, preview3d: true });
        }

        function deleteSelectedElement() {
            let wallsChanged = false;
            if (STATE.selectedWallIds.size > 0) {
                saveHistory();
                const wids = new Set(STATE.selectedWallIds);
                STATE.walls = STATE.walls.filter(w => !wids.has(w.id));
                STATE.openings = STATE.openings.filter(o => !wids.has(o.wallId));
                STATE.selectedWallIds.clear();
                STATE.selected = null;
                wallsChanged = true;
                showToast('已拆除选中的墙体');
            } else if (STATE.selected) {
                saveHistory();
                if (STATE.selected.type === 'wall') {
                    const wid = STATE.selected.id;
                    STATE.walls = STATE.walls.filter(w => w.id !== wid);
                    STATE.openings = STATE.openings.filter(o => o.wallId !== wid);
                    STATE.selected = null;
                    wallsChanged = true;
                    showToast('已拆除该墙体及附属门窗');
                } else if (STATE.selected.type === 'opening') {
                    STATE.openings = STATE.openings.filter(o => o.id !== STATE.selected.id);
                    STATE.selected = null;
                    showToast('已删除门窗构件');
                }
            }
            if (wallsChanged) {
                removeOrphanVertices();
                syncRoomsFromGeometry({ silent: true });
            }
            refreshViews({ tiling: true, panel: true, inspector: true, results: true, preview3d: true });
        }

        /**
         * 删除选中的空间（Delete 键，带确认）。
         * 房间由墙体围合自动识别，因此“删除空间”= 拆除只属于该空间的墙体（及其门窗）；
         * 与相邻空间共用的墙体保留，保证相邻空间不受影响。可 Ctrl+Z 撤销。
         */
        async function deleteSelectedRoom() {
            const room = getRoom(STATE.selectedRoomId);
            if (!room) return;
            const name = room.name || '未命名空间';
            const own = roomWalls(room);
            const shared = new Set();
            for (const other of STATE.rooms) {
                if (other.id === room.id) continue;
                for (const w of roomWalls(other)) shared.add(w.id);
            }
            const removable = own.filter(w => !shared.has(w.id));
            if (!removable.length) {
                showToast(`【${name}】的墙体全部与相邻空间共用，无法单独删除；可拆除指定墙体与相邻空间合并`);
                return;
            }
            const openingCount = STATE.openings.filter(o => removable.some(w => w.id === o.wallId)).length;
            const ok = await UiDialogs.confirm({
                title: '删除空间',
                message: `确定删除空间【${name}】吗？`,
                detail: `将拆除该空间独有的 ${removable.length} 段墙体${openingCount ? `及 ${openingCount} 个门窗` : ''}，与相邻空间共用的墙体会保留。可按 Ctrl+Z 撤销。`,
                okText: '删除',
                danger: true
            });
            if (!ok || !getRoom(room.id)) return;
            saveHistory();
            const wids = new Set(removable.map(w => w.id));
            STATE.walls = STATE.walls.filter(w => !wids.has(w.id));
            STATE.openings = STATE.openings.filter(o => !wids.has(o.wallId));
            STATE.selectedWallIds.clear();
            STATE.selected = null;
            STATE.selectedRoomId = null;
            removeOrphanVertices();
            syncRoomsFromGeometry({ silent: true });
            STATE.selectedRoomId = null;
            if (typeof recomputeAllRoomTiling === 'function') recomputeAllRoomTiling();
            if (typeof syncLeftPanelFromSelectedRoom === 'function') syncLeftPanelFromSelectedRoom();
            if (typeof renderCalculationResults === 'function') renderCalculationResults();
            refreshViews({ inspector: true, preview3d: true });
            showToast(`已删除空间【${name}】`);
        }

        function setTool(toolName) {
            // 立面模式：「起铺点(O)」= 在立面上拾取 / 拖动墙面起铺点；切换到其它工具时退出拾取
            if (typeof Elevation !== 'undefined' && Elevation.isActive()) {
                if (toolName === 'origin') { Elevation.setPicking(true); return; }
                Elevation.setPicking(false);
            }
            STATE.tool = toolName;
            STATE.wallStartVertex = null;
            STATE.wallDraft = null;
            STATE.lastWallDraftDir = null;
            STATE.activeSnapLines = [];
            STATE.originSnapPreview = null;
            STATE.editingWallId = null;
            STATE.editingClearPx = null;
            STATE.dimInputTyping = false;
            STATE.draftPopoverDismissed = false;
            if (toolName !== 'measure') STATE.measurePoints = [];

            $id('dim-input-popover').classList.add('hidden');
            STATE.draftPopoverShown = false;

            document.querySelectorAll('.tool-btn').forEach(btn => {
                btn.classList.toggle('active', btn.getAttribute('data-tool') === toolName);
            });

            const hintMap = {
                select: '选择：点击空间配砖 · 拖动墙体/端点 · 双击尺寸改长',
                pan: '平移：拖动平移画布 · 滚轮缩放',
                wall: '画墙：点击确定拐角，输入数值回车定长，围合自动生成空间 (Esc 结束)',
                door: '加门：靠近墙体自动吸附放置门洞',
                window: '加窗：靠近墙体自动吸附放置窗洞',
                origin: '起铺点：点击或拖动起铺点，自动吸附墙边与门框（按住 Alt 取消吸附）',
                measure: '测距：依次点击起点与终点测量距离',
                eyedropper: '吸管：点选底图墙体像素采样并重新识别'
            };
            { const _h = $id('current-action-hint'); _h.textContent = hintMap[toolName] || ''; _h.title = _h.textContent; }
            render();
        }

        /*************************************************************************
         * 十二、中文字体引擎 (./assets/fonts/chinese-font.ttf)
         * 提供字形映射与字宽 (charToGid / measureTextEm)、TrueType 子集 (buildSubsetTtf)。
         * 用于：DXF 文字排版宽度计算、DXF→PDF 转换时嵌入中文子集字体 (dxf-pdf.js)。
         *************************************************************************/
        const ChineseFontEngine = {
            loaded: false,
            loadingPromise: null,
            rawBytes: null,
            dv: null,
            tables: {},
            unitsPerEm: 256,
            ascent: 267,
            descent: -68,
            numGlyphs: 0,
            advanceWidths: null,
            codeToGid: new Map(),
            loca: null,

            async ensureLoaded() {
                if (this.loaded) return true;
                if (this.loadingPromise) return this.loadingPromise;
                this.loadingPromise = (async () => {
                    try {
                        const resp = await fetch('./assets/fonts/chinese-font.ttf');
                        if (!resp.ok) throw new Error('HTTP ' + resp.status);
                        const ab = await resp.arrayBuffer();
                        this.parseBuffer(new Uint8Array(ab));
                        this.loaded = true;
                        return true;
                    } catch (err) {
                        console.warn('ChineseFontEngine load warning:', err);
                        return false;
                    }
                })();
                return this.loadingPromise;
            },

            parseBuffer(bytes) {
                this.rawBytes = bytes;
                const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                this.dv = dv;
                const numTables = dv.getUint16(4, false);
                this.tables = {};
                for (let i = 0; i < numTables; i++) {
                    const pos = 12 + i * 16;
                    const tag = String.fromCharCode(
                        dv.getUint8(pos), dv.getUint8(pos + 1),
                        dv.getUint8(pos + 2), dv.getUint8(pos + 3)
                    );
                    this.tables[tag] = {
                        checksum: dv.getUint32(pos + 4, false),
                        offset: dv.getUint32(pos + 8, false),
                        length: dv.getUint32(pos + 12, false)
                    };
                }

                const headOff = this.tables['head'].offset;
                this.unitsPerEm = dv.getUint16(headOff + 18, false) || 256;
                const indexToLocFormat = dv.getInt16(headOff + 50, false);

                const hheaOff = this.tables['hhea'].offset;
                this.ascent = dv.getInt16(hheaOff + 4, false);
                this.descent = dv.getInt16(hheaOff + 6, false);
                const numHMetrics = dv.getUint16(hheaOff + 34, false);

                const maxpOff = this.tables['maxp'].offset;
                const numGlyphs = dv.getUint16(maxpOff + 4, false);
                this.numGlyphs = numGlyphs;

                const hmtxOff = this.tables['hmtx'].offset;
                this.advanceWidths = new Uint16Array(numGlyphs);
                let lastAdv = this.unitsPerEm;
                for (let i = 0; i < numGlyphs; i++) {
                    if (i < numHMetrics) {
                        lastAdv = dv.getUint16(hmtxOff + i * 4, false);
                    }
                    this.advanceWidths[i] = lastAdv;
                }

                this.codeToGid.clear();
                const cmapOff = this.tables['cmap'].offset;
                const numCmapTables = dv.getUint16(cmapOff + 2, false);
                for (let i = 0; i < numCmapTables; i++) {
                    const subOff = cmapOff + dv.getUint32(cmapOff + 4 + i * 8 + 4, false);
                    const fmt = dv.getUint16(subOff, false);
                    if (fmt === 4) {
                        const segCount = dv.getUint16(subOff + 6, false) >> 1;
                        const endCodesOff = subOff + 14;
                        const startCodesOff = endCodesOff + segCount * 2 + 2;
                        const idDeltasOff = startCodesOff + segCount * 2;
                        const idRangeOffsetsOff = idDeltasOff + segCount * 2;
                        for (let s = 0; s < segCount; s++) {
                            const endCode = dv.getUint16(endCodesOff + s * 2, false);
                            const startCode = dv.getUint16(startCodesOff + s * 2, false);
                            const idDelta = dv.getInt16(idDeltasOff + s * 2, false);
                            const idRangeOffsetPos = idRangeOffsetsOff + s * 2;
                            const idRangeOffset = dv.getUint16(idRangeOffsetPos, false);
                            if (startCode === 0xFFFF) break;
                            for (let c = startCode; c <= endCode; c++) {
                                let gid = 0;
                                if (idRangeOffset === 0) {
                                    gid = (c + idDelta) & 0xFFFF;
                                } else {
                                    const rawGid = dv.getUint16(idRangeOffsetPos + idRangeOffset + (c - startCode) * 2, false);
                                    if (rawGid !== 0) gid = (rawGid + idDelta) & 0xFFFF;
                                }
                                if (gid > 0 && gid < numGlyphs) {
                                    this.codeToGid.set(c, gid);
                                }
                            }
                        }
                        break;
                    }
                }

                const locaOff = this.tables['loca'].offset;
                this.loca = new Uint32Array(numGlyphs + 1);
                for (let i = 0; i <= numGlyphs; i++) {
                    this.loca[i] = indexToLocFormat === 1
                        ? dv.getUint32(locaOff + i * 4, false)
                        : dv.getUint16(locaOff + i * 2, false) * 2;
                }
            },

            charToGid(cp) {
                if (!this.loaded) return 0;
                return this.codeToGid.get(cp) || this.codeToGid.get(0x20) || 1;
            },

            charAdvanceEm(cp) {
                if (!this.loaded) return cp > 127 ? 1.0 : 0.56;
                const gid = this.codeToGid.get(cp);
                if (!gid) return cp > 127 ? 1.0 : 0.55;
                return (this.advanceWidths[gid] || this.unitsPerEm) / this.unitsPerEm;
            },

            measureTextEm(str) {
                let total = 0;
                const s = String(str ?? '');
                for (const ch of s) {
                    total += this.charAdvanceEm(ch.codePointAt(0));
                }
                return total;
            },

            buildSubsetTtf(usedGidsSet) {
                if (!this.loaded || !this.rawBytes) return new Uint8Array(0);
                const buf = this.rawBytes;
                const glyfOff = this.tables['glyf'].offset;
                const numGlyphs = this.numGlyphs;
                const glyphChunks = [];
                const newLoca = new Uint32Array(numGlyphs + 1);
                let curGlyfLen = 0;
                for (let g = 0; g < numGlyphs; g++) {
                    newLoca[g] = curGlyfLen;
                    if (g === 0 || usedGidsSet.has(g)) {
                        const start = this.loca[g], end = this.loca[g + 1];
                        if (end > start) {
                            const slice = buf.subarray(glyfOff + start, glyfOff + end);
                            glyphChunks.push(slice);
                            curGlyfLen += slice.length;
                            const pad = (4 - (curGlyfLen & 3)) & 3;
                            if (pad > 0) {
                                glyphChunks.push(new Uint8Array(pad));
                                curGlyfLen += pad;
                            }
                        }
                    }
                }
                newLoca[numGlyphs] = curGlyfLen;

                const newGlyfBytes = new Uint8Array(curGlyfLen);
                let p = 0;
                for (const ch of glyphChunks) {
                    newGlyfBytes.set(ch, p);
                    p += ch.length;
                }

                const newLocaBytes = new Uint8Array((numGlyphs + 1) * 4);
                const locaDv = new DataView(newLocaBytes.buffer);
                for (let g = 0; g <= numGlyphs; g++) {
                    locaDv.setUint32(g * 4, newLoca[g], false);
                }

                const tagNames = Object.keys(this.tables);
                const headerLen = 12 + tagNames.length * 16;
                const tableBuffers = {};
                let totalBodyLen = 0;
                for (const tag of tagNames) {
                    let tb;
                    if (tag === 'glyf') tb = newGlyfBytes;
                    else if (tag === 'loca') tb = newLocaBytes;
                    else {
                        const t = this.tables[tag];
                        tb = new Uint8Array(buf.subarray(t.offset, t.offset + t.length));
                    }
                    tableBuffers[tag] = tb;
                    totalBodyLen += (tb.length + 3) & ~3;
                }

                const out = new Uint8Array(headerLen + totalBodyLen);
                out.set(buf.subarray(0, 12), 0);
                const outDv = new DataView(out.buffer);
                let curOff = headerLen;
                tagNames.forEach((tag, idx) => {
                    const tb = tableBuffers[tag];
                    const dirPos = 12 + idx * 16;
                    for (let k = 0; k < 4; k++) outDv.setUint8(dirPos + k, tag.charCodeAt(k));
                    outDv.setUint32(dirPos + 4, this.tables[tag].checksum, false);
                    outDv.setUint32(dirPos + 8, curOff, false);
                    outDv.setUint32(dirPos + 12, tb.length, false);
                    out.set(tb, curOff);
                    curOff += (tb.length + 3) & ~3;
                });
                return out;
            }
        };

        // 页面加载后立即后台预热中文字体引擎
        setTimeout(() => { ChineseFontEngine.ensureLoaded(); }, 60);


        /*************************************************************************
         * 十三、CAD 图纸构建 (acadrust WASM)
         * CadDrawing 只负责收集图层与实体，生成精简 JSON「绘图描述」；
         * 真正的 DXF / DWG 文件由 acadrust (assets/vendor/acadrust-wasm, buildDrawing) 创建与写出，
         * 包括图层/线型/文字样式表、句柄、原生 ACAD_TABLE 表格等。
         * DXF / PDF / DWG 三种导出共用 buildProjectDrawing() 生成的同一份绘图描述。
         *************************************************************************/
        const r2 = v => Math.round(Number(v) * 10000) / 10000;

        /*************************************************************************
         * 应用图框：由图框编辑器 tukuan.html “保存应用图框”写入 IndexedDB，
         * 内容为纸面毫米坐标（Y 向上）的 CAD 图元，{{字段}} 占位符在导出时逐页填入。
         *************************************************************************/
        const APPLIED_FRAME_KEY = 'tilecalc-applied-frame-v1';
        const FRAME_CONTEXT_KEY = 'tilecalc-frame-context-v1';
        let g_defaultFramePromise = null;

        /** 应用图框里的图片：按原图重新生成像素栅格 (IM)，由 acadrust 写成 TK_IMAGE 色块图块，保证与原图一致 */
        async function rebuildFrameImageSolids(frame) {
            if (!frame || !Array.isArray(frame.images) || frame.images.length === 0) return frame;
            const r3 = v => Math.round(Number(v) * 1000) / 1000;
            const rasters = [];
            for (const im of frame.images) {
                if (!im || !Array.isArray(im.p) || im.p.length !== 4) continue;
                let src = im.src || '';
                if (!src && im.imageId) {
                    try { src = await StorageDB.getImageDataUrl(im.imageId); } catch (e) { src = ''; }
                }
                if (!src) continue;
                im.src = src;   // 供 PDF 矢量/图片渲染复用，不写回 KV
                const x0 = Math.min(im.p[0], im.p[2]), x1 = Math.max(im.p[0], im.p[2]);
                const yB = Math.min(im.p[1], im.p[3]), yT = Math.max(im.p[1], im.p[3]);
                const img = await new Promise(resolve => {
                    const el = new Image();
                    el.onload = () => resolve(el);
                    el.onerror = () => resolve(null);
                    el.src = src;
                });
                if (!img) continue;
                const ras = CadShared.imageToRaster(img, img.naturalWidth || img.width, img.naturalHeight || img.height, x1 - x0, yT - yB);
                if (ras) rasters.push({ t: 'IM', l: 'TK_IMAGE', p: [r3(x0), r3(yT)], w: r3(x1 - x0), h: r3(yT - yB), gw: ras.gw, gh: ras.gh, px: ras.px });
            }
            if (rasters.length > 0) {
                frame.entities = [...rasters, ...frame.entities.filter(e => e.l !== 'TK_IMAGE')];
            }
            return frame;
        }

        async function loadAppliedSheetFrame() {
            const valid = f => f && f.version === 1 && Number(f.fieldVersion) >= 2 && Array.isArray(f.entities) && f.sheetWidthMm > 0 && f.sheetHeightMm > 0 && f.innerRect && f.blockRect;
            try {
                const f = await StorageDB.refreshJSON(APPLIED_FRAME_KEY, null);
                if (valid(f)) return await rebuildFrameImageSolids(f);
            } catch (e) { /* 损坏的本地数据：回退默认图框 */ }
            if (!g_defaultFramePromise) {
                g_defaultFramePromise = fetch('assets/data/default-frame.json').then(r => r.ok ? r.json() : null).catch(() => null);
            }
            const def = await g_defaultFramePromise;
            return valid(def) ? await rebuildFrameImageSolids(def) : null;
        }

        /** 读取报价页面已保存的商家信息（tilecalc.merchantInfo） */
        function getMerchantInfo() {
            try {
                const m = StorageDB.getJSON(MERCHANT_INFO_KEY, null);
                if (m && typeof m === 'object') {
                    return {
                        company: String(m.company || '').trim(),
                        contact: String(m.contact || '').trim(),
                        phone: String(m.phone || '').trim(),
                        address: String(m.address || '').trim()
                    };
                }
            } catch (e) { }
            return { company: '', contact: '', phone: '', address: '' };
        }

        /** 本地日期字符串（避免 UTC 导致凌晨 0–8 点日期差一天） */
        function formatLocalDate(sep = '-', d = new Date()) {
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${y}${sep}${m}${sep}${day}`;
        }

        /** 当前工程数据（供图框编辑器预览“关联工程数据”的格子） */
        function writeFrameEditorContext() {
            try {
                recomputeAllRoomTiling();
                const totalStats = sumRoomStats();
                const { sumArea, sumBuy, allCost } = totalStats;
                const rooms = STATE.rooms.filter(r => !r.cleared && getRoomPolygonVerts(r).length >= 3);
                const n = rooms.length || STATE.rooms.length;
                const first = rooms[0];
                const firstPrice = first ? getSpecPrice(first.materialType, first.styleId, first.tileW, first.tileH) : defaultSpecPrice();
                const fl = STATE.floorsEnabled ? (getCurrentFloor()?.name || '1F') : '';
                const m = getMerchantInfo();
                const ctx = {
                    merchantCompany: m.company,
                    merchantContact: m.contact,
                    merchantPhone: m.phone,
                    merchantAddress: m.address,
                    projectName: getProjectName(),
                    clientName: getClientName(),
                    floorName: fl,
                    sheetTitle: '全屋铺贴排砖施工总图',
                    sheetDesc: '全屋墙体、起铺基准与排砖总览',
                    sheetNo: '01',
                    sheetSeq: '01',
                    pageNo: `1 / ${n + 2}`,
                    totalSheets: String(n + 2),
                    date: formatLocalDate('.'),
                    roomName: first ? first.name : '全屋',
                    roomSpec: first ? `${uSpec(first.tileW, first.tileH)}${Units.cur()} ${patternLabel(first.pattern)}` : '多规格',
                    lengthUnit: Units.NAME[Units.cur()],
                    roomArea: first?.stats ? `${first.stats.areaSqm.toFixed(2)} m²` : `${sumArea.toFixed(2)} m²`,
                    roomBuy: first?.stats ? `${first.stats.buyCount} 块` : `${sumBuy} 块`,
                    roomCount: `${n} 个`,
                    totalArea: `${sumArea.toFixed(2)} m²`,
                    totalBuy: `${sumBuy} 块`,
                    totalCost: `¥${Math.round(allCost)}`,
                    unitPrice: `¥${firstPrice} / m²`
                };
                return StorageDB.setJSON(FRAME_CONTEXT_KEY, ctx);
            } catch (e) { console.warn(e); }
        }

        /** 图框参数表的单元格内容（图框编辑器给出 cells / al / ch / cc / pad） */
        function frameTableCells(e) {
            return { cells: e.cells || [], al: e.al || [], ch: e.ch || [], cc: e.cc || null, pad: e.pad || null };
        }

        /** 根据应用图框计算图纸内容安全区与图签占位高度（供绘制前预规划分页与正式出图共用） */
        function computeAppliedFrameContentBounds(frame, ox, oy, k) {
            const X = x => r2(ox + x * k), Y = y => r2(oy + y * k);
            const H = frame.sheetHeightMm;
            const ir = frame.innerRect, br = frame.blockRect;
            const iL = X(ir.xMm), iR = X(ir.xMm + ir.widthMm), iB = Y(H - ir.yMm - ir.heightMm), iT = Y(H - ir.yMm);
            const bL = X(br.xMm), bR = X(br.xMm + br.widthMm), bB = Y(H - br.yMm - br.heightMm), bT = Y(H - br.yMm);
            const pad = 300;
            const out = { ox, oy, innerLeft: iL, innerRight: iR, innerBottom: iB, innerTop: iT, layoutMode: frame.layoutMode, edgePosition: frame.edgePosition, cornerPosition: frame.cornerPosition, contentLeft: iL + pad, contentRight: iR - pad, contentBottom: iB + pad, contentTop: iT - 260, tbX: bL, tbY: bB, tbW: bR - bL, tbH: 0 };
            if (frame.layoutMode === 'edge') {
                if (frame.edgePosition === 'left') out.contentLeft = bR + pad; else out.contentRight = bL - pad;
            } else if (String(frame.cornerPosition).startsWith('top')) {
                out.contentTop = bB - 260;
            } else {
                out.tbH = bT - bB;   // 底部贴角图签栏：总图按此高度避让
            }
            return out;
        }

        /** 过滤仅按每页自动变化、不宜全套固定覆盖的图框占位符 */
        const PER_SHEET_PLACEHOLDER_KEYS = new Set([
            'sheetTitle', 'sheetDesc', 'sheetNo', 'sheetSeq', 'pageNo', 'totalSheets',
            'sheetSize', 'lengthUnit', 'floorName', 'roomName', 'roomSpec', 'roomArea',
            'roomBuy', 'roomCount', 'totalArea', 'totalBuy', 'totalCost', 'unitPrice'
        ]);
        const GLOBAL_FIELD_PLACEHOLDERS = new Map([
            ['projectName', '工程名称'],
            ['clientName', '客户名称'],
            ['date', '出图日期'],
            ['merchantCompany', '商家/公司名称'],
            ['merchantContact', '商家联系人'],
            ['merchantPhone', '联系电话'],
            ['merchantAddress', '商家地址']
        ]);

        /**
         * 提取当前应用图框中可覆盖的表单字段（供导出图纸弹窗渲染与覆写）：表格格子 + 带字段名 (fl) 的独立多行文字。
         */
        function extractAppliedFrameEditableFields(frame) {
            const fields = [];
            if (!frame || !Array.isArray(frame.entities)) return fields;
            const entities = frame.entities;

            // 收集图框标签文字 (TK_TEXT_LABEL) 及图片占据区域
            const labels = [];
            const imageBoxes = [];
            for (const e of entities) {
                if (!e) continue;
                if (e.t === 'T' && e.l === 'TK_TEXT_LABEL' && e.s) {
                    labels.push({ x: e.p[0], y: e.p[1], s: String(e.s).trim() });
                } else if (e.t === 'IM') {
                    imageBoxes.push([e.p[0], e.p[1] - e.h, e.p[0] + e.w, e.p[1]]);
                } else if (e.t === 'S' && e.l === 'TK_IMAGE') {
                    const xs = [e.p[0], e.p[2], e.p[4], e.p[6]], ys = [e.p[1], e.p[3], e.p[5], e.p[7]];
                    imageBoxes.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
                }
            }
            const hasImageInRect = (x0, y0, x1, y1) => imageBoxes.some(b =>
                Math.min(x1, b[2]) - Math.max(x0, b[0]) > 1 && Math.min(y1, b[3]) - Math.max(y0, b[1]) > 1);
            const labelInRect = (x0, y0, x1, y1) => {
                const hit = labels.find(lb => lb.x >= x0 - 1 && lb.x <= x1 + 1 && lb.y >= y0 - 1 && lb.y <= y1 + 1);
                return hit ? hit.s : '';
            };

            // 带字段名 (fl) 的多行文字：落在表格格内时归入该格，否则单独成字段
            const overlayTexts = [];
            entities.forEach((e, idx) => {
                if (!e) return;
                if (e.t === 'MT' && e.fl) {
                    overlayTexts.push({ idx, t: e.t, x: e.p[0], y: e.p[1], s: String(e.s || '').trim(), fl: e.fl || '', used: false });
                }
            });

            const isOnlyGlobalOrPerSheet = (raw) => {
                const s = String(raw || '').trim();
                if (!s) return false;
                const keys = [...s.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]);
                if (!keys.length) return false;
                if (keys.some(k => PER_SHEET_PLACEHOLDER_KEYS.has(k))) return true;
                // 若只包含全局字段占位符（含行内标签前缀，如 "日期：{{date}}"、"出图日期：{{date}}"、"工程：{{projectName}}" 等），
                // 由顶部全局字段控制，避免导出弹窗出现带 {{...}} 的重复输入框
                if (keys.every(k => GLOBAL_FIELD_PLACEHOLDERS.has(k))) {
                    const stripped = s.replace(/\{\{\w+\}\}/g, '').replace(/[：:\s]/g, '');
                    if (!stripped || stripped.length <= 12) return true;
                }
                return false;
            };

            let tbIdx = 0;
            entities.forEach((e, idx) => {
                if (!e || e.t !== 'TB') return;
                const curTbIdx = tbIdx++;
                const t = frameTableCells(e);
                let curY = e.p[1];
                for (let r = 0; r < e.rh.length; r++) {
                    const rowH = e.rh[r] || 0;
                    const rowTop = curY, rowBot = curY - rowH;
                    let curX = e.p[0];
                    for (let c = 0; c < e.cw.length; c++) {
                        const colW = e.cw[c] || 0;
                        const x0 = curX, x1 = curX + colW;
                        curX = x1;
                        if (hasImageInRect(x0, rowBot, x1, rowTop)) continue;

                        const cellRaw = String((t.cells[r] && t.cells[r][c]) || '').trim();
                        const stackedLbl = (e.lb && e.lb[r] && e.lb[r][c] && e.lb[r][c].s) ? String(e.lb[r][c].s).trim() : '';
                        const cornerLbl = labelInRect(x0, rowBot, x1, rowTop);
                        const ovList = overlayTexts.filter(ov => !ov.used && ov.x >= x0 - 1 && ov.x <= x1 + 1 && ov.y >= rowBot - 1 && ov.y <= rowTop + 1);

                        if (ovList.length > 0 && !cellRaw) {
                            const ov = ovList[0];
                            ov.used = true;
                            if (isOnlyGlobalOrPerSheet(ov.s)) continue;
                            const lbl = stackedLbl || cornerLbl || ov.fl || '图签字段';
                            fields.push({
                                key: `ent:${ov.idx}`,
                                kind: 'ent',
                                entIdx: ov.idx,
                                label: lbl,
                                defaultValue: ov.s,
                                multiline: ov.s.includes('\n') || ov.s.length > 26
                            });
                            continue;
                        }

                        if (isOnlyGlobalOrPerSheet(cellRaw)) continue;
                        const metaLbl = (e.fl && e.fl[r] && e.fl[r][c]) ? String(e.fl[r][c]).trim() : '';
                        let lbl = stackedLbl || cornerLbl || metaLbl;
                        if (!lbl && cellRaw) {
                            const m = cellRaw.match(/^([^：:\n]{1,10})[：:]\s*$/);
                            lbl = m ? m[1] : cellRaw.slice(0, 10);
                        }
                        if (!lbl) continue;
                        fields.push({
                            key: `tb:${curTbIdx}:${r}:${c}`,
                            kind: 'tb',
                            tbIdx: curTbIdx,
                            r,
                            c,
                            label: lbl,
                            defaultValue: cellRaw,
                            multiline: cellRaw.includes('\n') || cellRaw.length > 26
                        });
                    }
                    curY = rowBot;
                }
            });

            // 若有未被表格认领的独立 MT（非纯标签/工程占位符）
            for (const ov of overlayTexts) {
                if (ov.used || isOnlyGlobalOrPerSheet(ov.s)) continue;
                fields.push({
                    key: `ent:${ov.idx}`,
                    kind: 'ent',
                    entIdx: ov.idx,
                    label: ov.fl,
                    defaultValue: ov.s,
                    multiline: ov.s.includes('\n') || ov.s.length > 26
                });
            }
            return fields;
        }

        /**
         * 把应用图框画到模型空间 (ox, oy) 处，k 为纸面毫米 → 模型单位的放大倍数。
         * 图框所有图元统一归入 SHEET_FRAME 图层，并对图签表格文字施加内边距与防溢出约束。
         * 支持导出前传入 overrides（{ cellOverrides, entOverrides }）覆盖对应表单/图元文字。
         * 返回与内置图框相同的内容区描述，供各页排版。
         */
        function drawAppliedSheetFrame(dxf, frame, ox, oy, k, values, overrides = null) {
            const X = x => r2(ox + x * k), Y = y => r2(oy + y * k);
            const fill = str => String(str ?? '').replace(/\{\{(\w+)\}\}/g, (_, key) => (values[key] != null ? String(values[key]) : ''));
            const cellOvs = overrides?.cellOverrides || {};
            const entOvs = overrides?.entOverrides || {};
            const omitOuter = !!overrides?.omitOuterFrame;
            /** 单行文字：填入字段值；含字段的文字按对齐锚点 (m.ax / m.ha) 和真实字宽重新定位 */
            const placeText = (s, x, h, m, em) => {
                const v = fill(s).replace(/[\r\n]+/g, ' ').trim();
                const curH = Number(h) || 2.8;
                if (!v || !m) return { s: v, x, h: curH };
                const w = ChineseFontEngine.measureTextEm(v) * (em ? 1 : 1.12) * curH;
                const tx = m.ha === 'center' ? m.ax - w * 0.5 : m.ha === 'right' ? m.ax - w : m.ax;
                return { s: v, x: r2(tx), h: curH };
            };
            dxf.setActiveLayer('SHEET_FRAME');
            // 图框编辑器选用的中文字体（宋体 / 楷体 / 微软雅黑 …）：登记文字样式与字形参数，由 acadrust 建样式
            for (const f of (Array.isArray(frame.fonts) ? frame.fonts : [])) {
                if (Array.isArray(f) && f[0]) dxf.fonts.set(f[0], f);
            }
            let tbIdx = 0;
            frame.entities.forEach((e, entIdx) => {
                if (omitOuter && e && e.l === 'TK_OUTER') return;
                if (e.t === 'L') {
                    dxf.push({ t: 'L', p: [X(e.p[0]), Y(e.p[1]), X(e.p[2]), Y(e.p[3])] });
                } else if (e.t === 'P') {
                    const pts = [];
                    for (let i = 0; i < e.p.length; i += 2) pts.push(X(e.p[i]), Y(e.p[i + 1]));
                    const ent = { t: 'P', c: !!e.c, p: pts };
                    if (e.w) ent.w = e.w.map(w => r2(w * k));
                    dxf.push(ent);
                } else if (e.t === 'IM') {
                    // 图框图片：像素栅格交给 acadrust 写成一个色块图块（每页一个，可整体选中 / 删除），放在 SHEET_FRAME_IMAGE 图层
                    dxf.setActiveLayer('SHEET_FRAME_IMAGE');
                    dxf.push({ t: 'IM', p: [X(e.p[0]), Y(e.p[1])], w: r2(e.w * k), h: r2(e.h * k), gw: e.gw, gh: e.gh, px: e.px });
                    dxf.setActiveLayer('SHEET_FRAME');
                } else if (e.t === 'S') {
                    // 图片色块（图框保存时本地空间不足、未带原图）：按原色输出，同一页的色块合成一个图块
                    const isImg = e.l === 'TK_IMAGE';
                    const ent = { t: 'S', p: [X(e.p[0]), Y(e.p[1]), X(e.p[2]), Y(e.p[3]), X(e.p[4]), Y(e.p[5]), X(e.p[6]), Y(e.p[7])] };
                    if (e.col != null) ent.col = e.col;
                    if (isImg) ent.g = `${r2(ox)},${r2(oy)}:${e.g || 'img'}`;
                    if (isImg) dxf.setActiveLayer('SHEET_FRAME_IMAGE');
                    dxf.push(ent);
                    if (isImg) dxf.setActiveLayer('SHEET_FRAME');
                } else if (e.t === 'C') {
                    dxf.push({ t: 'C', p: [X(e.p[0]), Y(e.p[1])], r: r2(e.r * k) });
                } else if (e.t === 'T') {
                    const rawS = Object.prototype.hasOwnProperty.call(entOvs, `ent:${entIdx}`) ? entOvs[`ent:${entIdx}`] : e.s;
                    const pl = placeText(rawS, e.p[0], e.h, e.m, e.em);
                    if (!pl.s) return;
                    const ent = { t: 'T', p: [X(pl.x), Y(e.p[1])], h: r2(pl.h * k), s: pl.s };
                    if (e.em) ent.em = true;   // 图框编辑器的屏幕字号，由 acadrust 换算成 CAD 字高
                    if (e.col != null) ent.col = e.col;
                    if (e.ff) ent.ff = e.ff;
                    if (e.rgb != null) ent.rgb = e.rgb;
                    dxf.push(ent);
                } else if (e.t === 'MT') {
                    // 多行文字 / 自由文字：MTEXT 文本框，按附着点 (al) 与参考宽度 (w) 由 CAD 排版
                    const rawS = Object.prototype.hasOwnProperty.call(entOvs, `ent:${entIdx}`) ? entOvs[`ent:${entIdx}`] : e.s;
                    const v = fill(rawS).replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '');
                    if (!v.trim()) return;
                    const ent = { t: 'MT', p: [X(e.p[0]), Y(e.p[1])], h: r2((Number(e.h) || 2.8) * k), s: v, al: e.al || 1, w: r2((Number(e.w) || 0) * k) };
                    if (e.ls) ent.ls = e.ls;
                    if (e.em) { ent.em = true; if (e.lh) ent.lh = e.lh; }
                    if (e.r) ent.r = e.r;
                    if (e.col != null) ent.col = e.col;
                    if (e.ff) ent.ff = e.ff;
                    if (e.rgb != null) ent.rgb = e.rgb;
                    if (e.tr) ent.tr = e.tr;   // 字间距（MTEXT 跟踪系数）
                    dxf.push(ent);
                } else if (e.t === 'TB') {
                    const curTbIdx = tbIdx++;
                    // 参数表输出为 CAD 原生表格 (ACAD_TABLE)：填入本页字段值，内边距、字高与文字排版由 acadrust 完成
                    const t = frameTableCells(e);
                    const ent = {
                        t: 'TB',
                        col: e.col != null ? e.col : 7,
                        p: [X(e.p[0]), Y(e.p[1])],
                        cw: e.cw.map(v => r2(v * k)),
                        rh: e.rh.map(v => r2(v * k)),
                        cells: t.cells.map((row, ri) => row.map((c, ci) => {
                            const ovKey = `tb:${curTbIdx}:${ri}:${ci}`;
                            const rawCell = Object.prototype.hasOwnProperty.call(cellOvs, ovKey) ? cellOvs[ovKey] : c;
                            return fill(rawCell).trim();
                        })),
                        th: r2((e.th || 3) * k),
                        al: t.al,
                        ch: t.ch.map(row => row.map(v => r2(v * k)))
                    };
                    if (t.cc) ent.cc = t.cc;
                    if (t.pad) ent.pad = t.pad.map(v => r2(v * k));
                    if (e.em) ent.em = true;
                    if (Array.isArray(e.bx)) ent.bx = e.bx.map(row => row.map(b => b.map(v => r2(v * k))));
                    if (Array.isArray(e.cf)) ent.cf = e.cf;
                    if (Array.isArray(e.crgb)) ent.crgb = e.crgb;
                    // 堆叠式字段名：与内容写进同一个单元格 MTEXT（首行）
                    if (Array.isArray(e.lb)) ent.lb = e.lb.map(row => row.map(l => (l && l.s ? { s: fill(l.s).trim(), h: r2(l.h * k), col: l.col } : null)));
                    dxf.push(ent);
                }
            });
            // 图框图片原图：只用于 PDF 彩色嵌入（不写入 DXF；CAD 中由上面的色块显示）
            for (const im of (Array.isArray(frame.images) ? frame.images : [])) {
                if (!im || !im.src || !Array.isArray(im.p) || im.p.length !== 4) continue;
                dxf.setActiveLayer('SHEET_FRAME_IMAGE');
                dxf.push({ t: 'IMG', p: [X(im.p[0]), Y(im.p[1]), X(im.p[2]), Y(im.p[3])], src: im.src });
                dxf.setActiveLayer('SHEET_FRAME');
            }
            // 纸面坐标（Y 向下）→ 模型坐标的内框与图签栏
            return computeAppliedFrameContentBounds(frame, ox, oy, k);
        }

        class CadDrawing {
            constructor() {
                this.layers = new Map();
                this.activeLayer = '0';
                this.entities = [];
                this.dimensions = [];
                this.fonts = new Map();   // 图框字体样式：名称 → [样式名, 字体名, 字体文件, cap, asc, desc]
                this.addLayer('0', 7, 'CONTINUOUS');
            }

            static cleanName(name) {
                return String(name).replace(/[^A-Za-z0-9_-]/g, '_').toUpperCase() || '0';
            }

            addLayer(name, colorNumber = 7, lineType = 'CONTINUOUS') {
                const n = CadDrawing.cleanName(name);
                const lt = ['CONTINUOUS', 'DASHED', 'CENTER'].includes(lineType) ? lineType : 'CONTINUOUS';
                this.layers.set(n, [n, colorNumber, lt]);
                return this;
            }

            setActiveLayer(name) {
                const n = CadDrawing.cleanName(name);
                if (!this.layers.has(n)) this.addLayer(n);
                this.activeLayer = n;
                return this;
            }

            push(ent) {
                ent.l = this.activeLayer;
                this.entities.push(ent);
                return this;
            }

            drawLine(x1, y1, x2, y2, ltype = null) {
                const e = { t: 'L', p: [r2(x1), r2(y1), r2(x2), r2(y2)] };
                if (ltype) e.lt = ltype;
                return this.push(e);
            }

            drawPolyline(points, closed = true, ltype = null) {
                if (!points || points.length < 2) return this;
                const e = { t: 'P', c: !!closed, p: points.flatMap(pt => [r2(pt[0]), r2(pt[1])]) };
                if (ltype) e.lt = ltype;
                return this.push(e);
            }

            /** 带线宽的不断开多段线 (墙体)：widths[i] 为第 i 段线宽，CAD 会在拐角自动斜接 */
            drawWidePolyline(points, widths, closed = false) {
                if (!points || points.length < 2) return this;
                const segCount = closed ? points.length : points.length - 1;
                const w = points.map((_, i) => r2(Math.max(0.01, Number(widths[Math.min(i, segCount - 1)]) || 0.01)));
                return this.push({ t: 'P', c: !!closed, p: points.flatMap(pt => [r2(pt[0]), r2(pt[1])]), w });
            }

            drawRect(x1, y1, x2, y2, ltype = null) {
                return this.drawPolyline([[x1, y1], [x2, y1], [x2, y2], [x1, y2]], true, ltype);
            }

            /** 实心四边形 (SOLID + 闭合轮廓)；SOLID 顶点顺序为 [0, 1, 3, 2] (Z 字序) */
            drawSolidQuad(points, color = null) {
                if (!points || points.length < 4) return this;
                const q = points.slice(0, 4).map(pt => [r2(pt[0]), r2(pt[1])]);
                const e = { t: 'S', p: [...q[0], ...q[1], ...q[3], ...q[2]] };
                if (color != null) e.col = color;
                this.push(e);
                return this.drawPolyline(q, true);
            }

            drawCircle(cx, cy, r) {
                return this.push({ t: 'C', p: [r2(cx), r2(cy)], r: r2(Math.max(0.5, Number(r))) });
            }

            /** 单行文字；alignCenter 时按中文字体字宽把 (x, y) 换算为居中文字的左下基线起点 */
            drawText(x, y, height, textStr, rotationDeg = 0, alignCenter = false) {
                const s = String(textStr ?? '').replace(/[\r\n]+/g, ' ').trim();
                if (!s) return this;
                const h = r2(Math.max(8, Number(height)));
                const rot = r2(rotationDeg || 0);
                let tx = Number(x), ty = Number(y);
                if (alignCenter) {
                    const dx = -ChineseFontEngine.measureTextEm(s) * h * 0.5, dy = -h * 0.36;
                    const rad = (rot * Math.PI) / 180;
                    tx += dx * Math.cos(rad) - dy * Math.sin(rad);
                    ty += dx * Math.sin(rad) + dy * Math.cos(rad);
                }
                const e = { t: 'T', p: [r2(tx), r2(ty)], h, s };
                if (rot) e.r = rot;
                return this.push(e);
            }

            /**
             * CAD 原生表格 (ACAD_TABLE)。(x, y) 为左上角；colWidths / rowHeights 为列宽、行高；rows 为二维文字。
             * 内边距、按格宽自动缩字 / 拆行、显示图形（匿名块 *T 中的网格线与 MTEXT）全部由 acadrust 生成，
             * 与 CAD 重新生成表格的结果一致，打开即正确显示。
             */
            drawTable(x, y, colWidths, rowHeights, rows, textHeight = 120, colorAci = 7) {
                const cw = colWidths.map(r2), rh = rowHeights.map(r2);
                const cells = rh.map((_, r) => cw.map((__, c) => String((rows[r] || [])[c] ?? '').replace(/[\r\n]+/g, ' ').trim()));
                return this.push({ t: 'TB', col: colorAci, p: [r2(x), r2(y)], cw, rh, cells, th: r2(textHeight * 0.84) });
            }

            /**
             * CAD 原生对齐尺寸标注 (DIMENSION / AcDbAlignedDimension)。
             * 样式对齐建筑施工图标尺：两端对称垂直短刻度线 + 尺寸线微出头 + 文字居于尺寸线上方/左侧。
             */
            drawDimension(x1, y1, x2, y2, textStr, textH = 95, tickHalf = 75) {
                let ax = Number(x1), ay = Number(y1), bx = Number(x2), by = Number(y2);
                let dx = bx - ax, dy = by - ay;
                const len = Math.hypot(dx, dy);
                if (!(len > 1e-3)) return this;
                let ang = Math.atan2(dy, dx) * 180 / Math.PI;
                if (ang <= -90 || ang > 90) {
                    [ax, bx] = [bx, ax];
                    [ay, by] = [by, ay];
                    dx = -dx;
                    dy = -dy;
                    ang = Math.atan2(dy, dx) * 180 / Math.PI;
                }
                const ux = dx / len, uy = dy / len;
                const nx = -uy, ny = ux;
                const h = r2(Math.max(20, Number(textH) || 95));
                const th = r2(Math.max(25, Number(tickHalf) || Math.round(h * 0.78)));
                const dle = r2(th * 0.42);
                const gap = r2(Math.max(18, h * 0.28));
                const s = String(textStr ?? '').replace(/[\r\n]+/g, ' ').trim();
                const midX = (ax + bx) * 0.5, midY = (ay + by) * 0.5;
                const tcX = midX + nx * (gap + h * 0.5), tcY = midY + ny * (gap + h * 0.5);
                const halfW = ChineseFontEngine.measureTextEm(s) * h * 0.5;
                const baseOff = -h * 0.36;
                const tx = r2(tcX - ux * halfW + nx * baseOff);
                const ty = r2(tcY - uy * halfW + ny * baseOff);

                this.dimensions.push({
                    layer: this.activeLayer,
                    ax: r2(ax), ay: r2(ay),
                    bx: r2(bx), by: r2(by),
                    def1x: r2(ax - nx * th), def1y: r2(ay - ny * th),
                    def2x: r2(bx - nx * th), def2y: r2(by - ny * th),
                    tcX: r2(tcX), tcY: r2(tcY),
                    tx, ty,
                    h,
                    rot: r2(ang),
                    text: s,
                    lines: [
                        [r2(ax - ux * dle), r2(ay - uy * dle), r2(bx + ux * dle), r2(by + uy * dle)],
                        [r2(ax - nx * th), r2(ay - ny * th), r2(ax + nx * th), r2(ay + ny * th)],
                        [r2(bx - nx * th), r2(by - ny * th), r2(bx + nx * th), r2(by + ny * th)]
                    ]
                });
                return this;
            }

            /** 交给 acadrust 的绘图描述 (JSON) */
            toSpec() {
                return JSON.stringify({
                    insunits: 4,
                    layers: Array.from(this.layers.values()),
                    styles: [['STANDARD', 'SimHei', 'simhei.ttf'], ['CHINESE_TTF', 'Droid Sans Fallback', 'chinese-font.ttf']],
                    fonts: Array.from(this.fonts.values()),
                    entities: this.entities.filter(e => e.t !== 'IMG'),   // IMG 仅供 PDF 嵌入位图
                    dims: this.dimensions   // 尺寸标注：匿名块 *Dn + DIMENSION + 标注样式，均由 acadrust 写出
                });
            }
        }

        const { CAD_VERSION, loadAcadrust } = CadShared;

        /** 由 acadrust 写出图纸：format = 'dxf' | 'dwg' */
        async function writeCadDrawing(drawing, format) {
            const acad = await loadAcadrust();
            const dwg = format === 'dwg';
            return acad.buildDrawing(drawing.toSpec(), dwg, dwg ? CAD_VERSION.dwg : CAD_VERSION.dxf);
        }

        /** 取某个空间四周围合墙体的 id 集合 (按空间顶点环相邻两点查找墙段) */
        function getRoomWallIdSet(room) {
            const ids = room.vertexIds || [];
            const set = new Set();
            for (let i = 0; i < ids.length; i++) {
                const a = ids[i], b = ids[(i + 1) % ids.length];
                for (const w of STATE.walls) {
                    if ((w.v1 === a && w.v2 === b) || (w.v1 === b && w.v2 === a)) set.add(w.id);
                }
            }
            return set;
        }

        /**
         * 门窗平面符号的世界坐标几何 (与主画布 renderOpenings 的门弧/窗线一致)，DXF 与 PDF 共用：
         *  - jambs : 洞口两侧门框线 (横穿墙厚)
         *  - leaf  : 门扇 (90°开启位置) 线段
         *  - arc   : 门扇开启轨迹圆弧折线
         *  - lines : 窗的墙面线 / 玻璃线
         */
        function getOpeningSymbolGeometry(op) {
            const wall = getWall(op.wallId);
            if (!wall) return null;
            const v1 = getVertex(wall.v1), v2 = getVertex(wall.v2);
            if (!v1 || !v2) return null;
            const wLen = dist(v1, v2);
            if (wLen < 1) return null;
            const ang = Math.atan2(v2.y - v1.y, v2.x - v1.x);
            const ux = Math.cos(ang), uy = Math.sin(ang);
            const nx = -uy, ny = ux;
            const cx = v1.x + op.t * (v2.x - v1.x), cy = v1.y + op.t * (v2.y - v1.y);
            const width = op.width || 45, halfW = width / 2;
            const th = wall.thickness || 12;
            const P = (lx, ly) => ({ x: cx + ux * lx + nx * ly, y: cy + uy * lx + ny * ly });
            const seg = (a, b) => [a.x, a.y, b.x, b.y];
            const out = { type: op.type, wallId: wall.id, jambs: [], leaf: null, arc: [], lines: [], th, width, center: { x: cx, y: cy }, ux, uy };
            out.jambs.push(seg(P(-halfW, -th / 2), P(-halfW, th / 2)));
            out.jambs.push(seg(P(halfW, -th / 2), P(halfW, th / 2)));
            if (op.type === 'door') {
                const flipSign = op.flip ? -1 : 1;
                const hingeAtEnd = !!op.hinge;
                const hingeX = hingeAtEnd ? halfW : -halfW;
                const startAngle = hingeAtEnd ? Math.PI : 0;
                const sweep = (hingeAtEnd ? -1 : 1) * flipSign * (Math.PI / 2);
                out.leaf = seg(P(hingeX, 0), P(hingeX, flipSign * width));
                const N = 18;
                for (let i = 0; i <= N; i++) {
                    const a = startAngle + sweep * (i / N);
                    const q = P(hingeX + width * Math.cos(a), width * Math.sin(a));
                    out.arc.push([q.x, q.y]);
                }
            } else if (op.type === 'window') {
                for (const k of [-th / 2, -th / 6, th / 6, th / 2]) {
                    out.lines.push(seg(P(-halfW, k), P(halfW, k)));
                }
            }
            return out;
        }

        /**
         * 把全屋墙体按拓扑串成连续墙链，并在门洞处切开，返回若干条“不断开”的多段线片段。
         * 每个片段：{ pts:[{x,y}], widths:[每段墙厚], closed }
         * - 2 面墙相交的节点：两墙直接首尾相连 (拐角交给 CAD 做斜接，不再出现断线/缺角)；
         * - 3 面以上相交的节点：最接近“直通”的两面墙贯通，其余墙在节点处对接。
         */
        function buildContinuousWallPieces(wallIdSet = null, cutTypes = ['door', 'window']) {
            const walls = STATE.walls.filter(w => {
                if (wallIdSet && !wallIdSet.has(w.id)) return false;
                const a = getVertex(w.v1), b = getVertex(w.v2);
                return a && b && w.v1 !== w.v2 && dist(a, b) >= 1;
            });
            const byVertex = new Map();
            for (const w of walls) {
                for (const vid of [w.v1, w.v2]) {
                    if (!byVertex.has(vid)) byVertex.set(vid, []);
                    byVertex.get(vid).push(w);
                }
            }
            const otherEnd = (w, vid) => (w.v1 === vid ? w.v2 : w.v1);

            // 节点配对：key = `${vertexId}|${wallId}` -> 与之贯通的另一面墙
            const partner = new Map();
            for (const [vid, list] of byVertex) {
                if (list.length < 2) continue;
                const v = getVertex(vid);
                const dirs = list.map(w => {
                    const o = getVertex(otherEnd(w, vid));
                    const L = Math.hypot(o.x - v.x, o.y - v.y) || 1;
                    return { w, ux: (o.x - v.x) / L, uy: (o.y - v.y) / L };
                });
                const cands = [];
                for (let i = 0; i < dirs.length; i++) {
                    for (let j = i + 1; j < dirs.length; j++) {
                        const dot = dirs[i].ux * dirs[j].ux + dirs[i].uy * dirs[j].uy;
                        cands.push({ i, j, ang: Math.acos(Math.max(-1, Math.min(1, dot))) });
                    }
                }
                cands.sort((p, q) => q.ang - p.ang);
                const used = new Set();
                let pairedCount = 0;
                for (const c of cands) {
                    if (used.has(c.i) || used.has(c.j)) continue;
                    const minAng = (list.length === 2) ? 0 : (pairedCount === 0 ? Math.PI * 0.5 : Math.PI * 5 / 6);
                    if (c.ang < minAng) continue;
                    used.add(c.i); used.add(c.j);
                    partner.set(`${vid}|${dirs[c.i].w.id}`, dirs[c.j].w);
                    partner.set(`${vid}|${dirs[c.j].w.id}`, dirs[c.i].w);
                    pairedCount++;
                }
            }

            // 串链
            const visited = new Set();
            const chains = [];
            for (const w0 of walls) {
                if (visited.has(w0.id)) continue;
                visited.add(w0.id);
                const chain = [{ wall: w0, from: w0.v1, to: w0.v2 }];
                let closed = false;
                // 向后延伸
                for (;;) {
                    const last = chain[chain.length - 1];
                    const nx = partner.get(`${last.to}|${last.wall.id}`);
                    if (!nx) break;
                    if (nx.id === chain[0].wall.id) {
                        closed = (chain.length >= 2) && partner.get(`${chain[0].from}|${chain[0].wall.id}`)?.id === last.wall.id;
                        break;
                    }
                    if (visited.has(nx.id)) break;
                    visited.add(nx.id);
                    chain.push({ wall: nx, from: last.to, to: otherEnd(nx, last.to) });
                }
                // 向前延伸
                if (!closed) {
                    for (;;) {
                        const first = chain[0];
                        const pv = partner.get(`${first.from}|${first.wall.id}`);
                        if (!pv || visited.has(pv.id)) break;
                        visited.add(pv.id);
                        chain.unshift({ wall: pv, from: otherEnd(pv, first.from), to: first.from });
                    }
                }
                chains.push({ chain, closed });
            }

            // 按门洞切开
            const EPS = 1e-4;
            const out = [];
            for (const { chain, closed } of chains) {
                const pieces = [];
                let cur = null;
                chain.forEach((seg, si) => {
                    const A = getVertex(seg.from), B = getVertex(seg.to);
                    const len = dist(A, B);
                    const th = seg.wall.thickness || 12;
                    const rev = seg.from !== seg.wall.v1;
                    const cuts = STATE.openings
                        .filter(o => o.wallId === seg.wall.id && cutTypes.includes(o.type))
                        .map(o => {
                            const dt = ((o.width || 45) * 0.5) / len;
                            let t0 = Math.max(0, o.t - dt), t1 = Math.min(1, o.t + dt);
                            if (rev) { const a = 1 - t1, b = 1 - t0; t0 = a; t1 = b; }
                            return [t0, t1];
                        })
                        .sort((p, q) => p[0] - q[0]);
                    const keeps = [];
                    let tcur = 0;
                    for (const [t0, t1] of cuts) {
                        if (t0 > tcur + 0.01) keeps.push([tcur, t0]);
                        tcur = Math.max(tcur, t1);
                    }
                    if (tcur < 0.99) keeps.push([tcur, 1]);
                    const at = t => ({ x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t });

                    for (const [ta, tb] of keeps) {
                        if (cur && ta <= EPS) {
                            cur.pts.push(at(tb));
                            cur.widths.push(th);
                            cur.endWall = seg.wall;
                            cur.endVertexId = tb >= 1 - EPS ? seg.to : null;
                        } else {
                            if (cur) pieces.push(cur);
                            cur = {
                                pts: [at(ta), at(tb)],
                                widths: [th],
                                startWall: seg.wall,
                                startVertexId: ta <= EPS ? seg.from : null,
                                endWall: seg.wall,
                                endVertexId: tb >= 1 - EPS ? seg.to : null,
                                startsAtSeam: si === 0 && ta <= EPS,
                                endsAtSeam: false
                            };
                        }
                        if (tb < 1 - EPS) {
                            pieces.push(cur);
                            cur = null;
                        }
                    }
                    if (keeps.length === 0 && cur) { pieces.push(cur); cur = null; }
                    if (cur && si === chain.length - 1) cur.endsAtSeam = true;
                });
                if (cur) pieces.push(cur);

                if (closed && pieces.length >= 1) {
                    if (pieces.length === 1 && pieces[0].startsAtSeam && pieces[0].endsAtSeam) {
                        const p = pieces[0];
                        out.push({ pts: p.pts.slice(0, -1), widths: p.widths.slice(), closed: true });
                        continue;
                    }
                    const f = pieces[0], l = pieces[pieces.length - 1];
                    if (pieces.length > 1 && f.startsAtSeam && l.endsAtSeam) {
                        pieces.shift();
                        pieces.pop();
                        pieces.push({
                            pts: l.pts.concat(f.pts.slice(1)),
                            widths: l.widths.concat(f.widths),
                            startWall: l.startWall,
                            startVertexId: l.startVertexId,
                            endWall: f.endWall,
                            endVertexId: f.endVertexId
                        });
                    }
                }
                for (const p of pieces) {
                    let total = 0;
                    for (let i = 1; i < p.pts.length; i++) total += Math.hypot(p.pts[i].x - p.pts[i - 1].x, p.pts[i].y - p.pts[i - 1].y);
                    if (total < 0.5) continue;
                    out.push({
                        pts: p.pts,
                        widths: p.widths,
                        closed: false,
                        startWall: p.startWall || null,
                        startVertexId: p.startVertexId || null,
                        endWall: p.endWall || null,
                        endVertexId: p.endVertexId || null
                    });
                }
            }
            return out;
        }

        /**
         * 将墙体中心线 + 墙厚转换为闭合的双线轮廓多边形（内外墙皮精确坐标）：
         *  - 闭合环墙体输出外皮闭合环与内皮闭合环；
         *  - 门窗洞口断开或 T 型节点对接的墙段，按内外偏移线斜接并在端部闭合为完整轮廓；
         *  - T 型节点端部自动贴合贯通主墙的内外墙皮，不伸入主墙中心线内部。
         */
        function buildWallOutlinePolygons(wallIdSet = null, cutTypes = ['door', 'window']) {
            return buildWallGeometryParts(wallIdSet, cutTypes).loops;
        }

        /** 将墙体轮廓按每段斜接角点拆分为实心四边形数组 [L0, L1, R1, R0]（供「墙壁实心」填充） */
        function buildWallSolidQuads(wallIdSet = null, cutTypes = ['door', 'window']) {
            return buildWallGeometryParts(wallIdSet, cutTypes).quads;
        }

        function buildWallGeometryParts(wallIdSet = null, cutTypes = ['door', 'window']) {
            const pieces = buildContinuousWallPieces(wallIdSet, cutTypes);
            const loops = [];
            const quads = [];
            const miterCorner = (P, sPrev, sNext, sideSign) => {
                const p1 = { x: P.x + sPrev.n.x * sPrev.h * sideSign, y: P.y + sPrev.n.y * sPrev.h * sideSign };
                const p2 = { x: P.x + sNext.n.x * sNext.h * sideSign, y: P.y + sNext.n.y * sNext.h * sideSign };
                const cr = sPrev.u.x * sNext.u.y - sPrev.u.y * sNext.u.x;
                if (Math.abs(cr) < 0.02) {
                    return { x: (p1.x + p2.x) * 0.5, y: (p1.y + p2.y) * 0.5 };
                }
                const rhs = { x: p2.x - p1.x, y: p2.y - p1.y };
                const t = (rhs.x * sNext.u.y - rhs.y * sNext.u.x) / cr;
                const lim = 4.0 * Math.max(sPrev.h, sNext.h);
                const tc = Math.max(-lim, Math.min(lim, t));
                return { x: p1.x + sPrev.u.x * tc, y: p1.y + sPrev.u.y * tc };
            };

            /**
             * 角点：一般为单个斜接点 (in === out)。相邻两段共线同向但墙厚不同时，
             * 墙皮在分界处形成垂直台阶：in 为上一段墙皮端点，out 为下一段墙皮起点，
             * 避免取中点把墙皮连成斜边。
             */
            const cornerPair = (P, sPrev, sNext, sideSign) => {
                const cr = sPrev.u.x * sNext.u.y - sPrev.u.y * sNext.u.x;
                const sameDir = sPrev.u.x * sNext.u.x + sPrev.u.y * sNext.u.y > 0;
                if (Math.abs(cr) < 0.02 && sameDir && Math.abs(sPrev.h - sNext.h) > 0.05) {
                    const p1 = { x: P.x + sPrev.n.x * sPrev.h * sideSign, y: P.y + sPrev.n.y * sPrev.h * sideSign };
                    const p2 = { x: P.x + sNext.n.x * sNext.h * sideSign, y: P.y + sNext.n.y * sNext.h * sideSign };
                    return { in: p1, out: p2 };
                }
                const m = miterCorner(P, sPrev, sNext, sideSign);
                return { in: m, out: m };
            };
            const flattenCorners = (cs) => {
                const out = [];
                for (const c of cs) {
                    out.push(c.in);
                    if (c.out !== c.in) out.push(c.out);
                }
                return out;
            };

            for (const piece of pieces) {
                const rawPts = piece.pts || [];
                if (rawPts.length < 2) continue;
                const pts = [rawPts[0]];
                const widths = [piece.widths[0] || 12];
                for (let i = 1; i < rawPts.length; i++) {
                    if (Math.hypot(rawPts[i].x - pts[pts.length - 1].x, rawPts[i].y - pts[pts.length - 1].y) > 0.2) {
                        pts.push(rawPts[i]);
                        widths.push(piece.widths[Math.min(i, piece.widths.length - 1)] || 12);
                    }
                }
                if (piece.closed && pts.length >= 3 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) <= 0.2) {
                    pts.pop();
                }
                const segCount = piece.closed ? pts.length : pts.length - 1;
                if (segCount < 1 || (piece.closed && segCount < 3)) continue;

                const segs = [];
                for (let k = 0; k < segCount; k++) {
                    const A = pts[k], B = pts[(k + 1) % pts.length];
                    const dx = B.x - A.x, dy = B.y - A.y;
                    const len = Math.hypot(dx, dy) || 1;
                    const u = { x: dx / len, y: dy / len };
                    const n = { x: -u.y, y: u.x };
                    const h = Math.max(0.5, (piece.widths[Math.min(k, piece.widths.length - 1)] || 12) * 0.5);
                    segs.push({ A, B, len, u, n, h });
                }

                if (piece.closed) {
                    const leftC = [], rightC = [];
                    for (let k = 0; k < segCount; k++) {
                        const prev = segs[(k - 1 + segCount) % segCount];
                        const curr = segs[k];
                        leftC.push(cornerPair(pts[k], prev, curr, +1));
                        rightC.push(cornerPair(pts[k], prev, curr, -1));
                    }
                    loops.push(flattenCorners(leftC), flattenCorners(rightC));
                    for (let k = 0; k < segCount; k++) {
                        const kn = (k + 1) % segCount;
                        quads.push([leftC[k].out, leftC[kn].in, rightC[kn].in, rightC[k].out]);
                    }
                } else {
                    const leftPts = [], rightPts = [];
                    const s0 = segs[0];
                    let tStartL = 0, tStartR = 0;
                    if (piece.startVertexId != null && piece.startWall) {
                        const V0 = getVertex(piece.startVertexId);
                        if (V0) {
                            tStartL = Math.min(s0.len * 0.45, Math.max(0, connectedFaceInset(V0, piece.startWall, s0.u, s0.n, s0.h)));
                            tStartR = Math.min(s0.len * 0.45, Math.max(0, connectedFaceInset(V0, piece.startWall, s0.u, { x: -s0.n.x, y: -s0.n.y }, s0.h)));
                        }
                    }
                    // T 形端部顶在「墙厚不同的两段共线墙」分界点上时，两侧墙面不在同一直线：
                    // 端部轮廓沿主墙两侧墙面各走到本墙中线，形成台阶，而不是一条斜线
                    let capStart = null;
                    if (piece.startVertexId != null && piece.startWall) {
                        const V0 = getVertex(piece.startVertexId);
                        if (V0) {
                            const cl = Math.min(s0.len * 0.45, Math.max(0, connectedFaceInset(V0, piece.startWall, s0.u, s0.n, 0)));
                            const cr = Math.min(s0.len * 0.45, Math.max(0, connectedFaceInset(V0, piece.startWall, s0.u, { x: -s0.n.x, y: -s0.n.y }, 0)));
                            if (Math.abs(cl - cr) > 0.05) {
                                capStart = {
                                    L: { x: pts[0].x + s0.u.x * cl, y: pts[0].y + s0.u.y * cl },
                                    R: { x: pts[0].x + s0.u.x * cr, y: pts[0].y + s0.u.y * cr }
                                };
                            }
                        }
                    }
                    leftPts.push({ x: pts[0].x + s0.n.x * s0.h + s0.u.x * tStartL, y: pts[0].y + s0.n.y * s0.h + s0.u.y * tStartL });
                    rightPts.push({ x: pts[0].x - s0.n.x * s0.h + s0.u.x * tStartR, y: pts[0].y - s0.n.y * s0.h + s0.u.y * tStartR });

                    const leftC = [null], rightC = [null];
                    for (let k = 1; k < segCount; k++) {
                        leftC.push(cornerPair(pts[k], segs[k - 1], segs[k], +1));
                        rightC.push(cornerPair(pts[k], segs[k - 1], segs[k], -1));
                    }

                    const sLast = segs[segCount - 1];
                    let tEndL = 0, tEndR = 0;
                    if (piece.endVertexId != null && piece.endWall) {
                        const VM = getVertex(piece.endVertexId);
                        if (VM) {
                            const backU = { x: -sLast.u.x, y: -sLast.u.y };
                            tEndL = Math.min(sLast.len * 0.45, Math.max(0, connectedFaceInset(VM, piece.endWall, backU, sLast.n, sLast.h)));
                            tEndR = Math.min(sLast.len * 0.45, Math.max(0, connectedFaceInset(VM, piece.endWall, backU, { x: -sLast.n.x, y: -sLast.n.y }, sLast.h)));
                        }
                    }
                    const endP = pts[segCount];
                    let capEnd = null;
                    if (piece.endVertexId != null && piece.endWall) {
                        const VM = getVertex(piece.endVertexId);
                        if (VM) {
                            const backU = { x: -sLast.u.x, y: -sLast.u.y };
                            const cl = Math.min(sLast.len * 0.45, Math.max(0, connectedFaceInset(VM, piece.endWall, backU, sLast.n, 0)));
                            const cr = Math.min(sLast.len * 0.45, Math.max(0, connectedFaceInset(VM, piece.endWall, backU, { x: -sLast.n.x, y: -sLast.n.y }, 0)));
                            if (Math.abs(cl - cr) > 0.05) {
                                capEnd = {
                                    L: { x: endP.x - sLast.u.x * cl, y: endP.y - sLast.u.y * cl },
                                    R: { x: endP.x - sLast.u.x * cr, y: endP.y - sLast.u.y * cr }
                                };
                            }
                        }
                    }
                    const endL = { x: endP.x + sLast.n.x * sLast.h - sLast.u.x * tEndL, y: endP.y + sLast.n.y * sLast.h - sLast.u.y * tEndL };
                    const endR = { x: endP.x - sLast.n.x * sLast.h - sLast.u.x * tEndR, y: endP.y - sLast.n.y * sLast.h - sLast.u.y * tEndR };
                    leftC.push({ in: endL, out: endL });
                    rightC.push({ in: endR, out: endR });
                    leftC[0] = { in: leftPts[0], out: leftPts[0] };
                    rightC[0] = { in: rightPts[0], out: rightPts[0] };

                    for (let k = 0; k < segCount; k++) {
                        quads.push([leftC[k].out, leftC[k + 1].in, rightC[k + 1].in, rightC[k].out]);
                    }
                    if (capStart) {
                        quads.push([leftPts[0], capStart.L, capStart.R, capStart.R]);
                        quads.push([leftPts[0], capStart.R, rightPts[0], rightPts[0]]);
                    }
                    if (capEnd) {
                        quads.push([endL, capEnd.L, capEnd.R, capEnd.R]);
                        quads.push([endL, capEnd.R, endR, endR]);
                    }
                    const loopPts = flattenCorners(leftC);
                    if (capEnd) loopPts.push(capEnd.L, capEnd.R);
                    loopPts.push(...flattenCorners(rightC).reverse());
                    if (capStart) loopPts.push(capStart.R, capStart.L);
                    loops.push(loopPts);
                }
            }
            const mmPerPx = 1000 / SCALE_PIXELS_PER_METER;
            const snapMm = v => Math.round(v * mmPerPx) / mmPerPx;
            return {
                loops: loops.map(loop => loop.map(p => ({ x: snapMm(p.x), y: snapMm(p.y) }))),
                quads: quads.map(q => q.map(p => ({ x: snapMm(p.x), y: snapMm(p.y) })))
            };
        }

        /**
         * 材料说明 / 材料明细表的数据整理（CAD 末页总表与 xlsx 导出共用）。
         * floorName 为当前楼层名（未启用楼层时为空串），写入「使用部位」前缀。
         */
        function createMaterialSpecHelpers(floorName = '') {
            const formatRoomMaterialDesc = (r) => {
                if (!r || r.materialType === 'wood') return '无缝拼接';
                const gap = getRoomJointMM(r);
                return r.groutEnabled !== false ? `留${gap}mm缝,填美缝剂` : `留${gap}mm缝,填填缝剂`;
            };

            /**
             * 踢脚线材料项：按 编码(类型-长x厚x高) 归并。传入 room 时只统计该空间启用了踢脚线的墙面，
             * 用于单空间排砖详图 / 墙面立面详图左下角的「材料说明」；不传则统计全屋。
             */
            const getSkirtingSpecItems = (room = null, placeSuffix = '墙面踢脚线') => {
                const list = [];
                if (typeof Elevation === 'undefined' || !Elevation.computeAllWallStats) return list;
                const byCode = new Map();
                const wStats = Elevation.computeAllWallStats();
                for (const s of (wStats.skirtingMerged || wStats.skirtingRows || [])) {
                    if (room && s.room !== room) continue;
                    const isWood = s.sk.type === 'wood';
                    const skCode = `${isWood ? 'SKW' : 'SKT'}-${s.sk.lenMM}x${s.sk.thickMM}x${s.sk.heightMM}`;
                    const skKind = isWood ? '木质踢脚线' : '瓷砖踢脚线';
                    const skUnit = isWood ? '根' : '块';
                    const rName = s.room?.name || '未命名';
                    const skPlaceTag = `${rName}(${placeSuffix})`;
                    let skItem = byCode.get(skCode);
                    if (!skItem) {
                        skItem = {
                            code: skCode,
                            kind: skKind,
                            name: skKind,
                            size: `${uSpec(s.sk.lenMM, s.sk.heightMM, '*')}${Units.cur()}(厚${Units.val(s.sk.thickMM)})`,
                            areaSqm: 0,
                            netLenM: 0,
                            doorDeductM: 0,
                            area: '0.00m²',
                            count: 0,
                            qty: `0${skUnit}`,
                            unit: skUnit,
                            places: [],
                            place: '',
                            desc: '',
                            isSkirting: true
                        };
                        byCode.set(skCode, skItem);
                        list.push(skItem);
                    }
                    skItem.areaSqm += s.buyAreaSqm;
                    skItem.netLenM += s.netM;
                    skItem.doorDeductM += s.deductM;
                    skItem.area = `${skItem.areaSqm.toFixed(2)}m²(${skItem.netLenM.toFixed(2)}m)`;
                    skItem.count += s.buyCount;
                    skItem.qty = `${skItem.count}${skItem.unit}`;
                    if (s.room?.name && !skItem.places.includes(skPlaceTag)) skItem.places.push(skPlaceTag);
                    skItem.place = floorName ? `${floorName} ${skItem.places.join('、')}` : skItem.places.join('、');
                    skItem.desc = `净长${skItem.netLenM.toFixed(2)}m(已扣洞口${skItem.doorDeductM.toFixed(2)}m),损耗${s.sk.wastage}%`;
                }
                return list;
            };

            /**
             * 按材料编号累计一行材料说明：同编号的面积、块数相加，使用部位去重拼接。
             * base = { code, kind, name, size, desc }；placeTag 为空时不记录使用部位（墙面立面详图）。
             */
            const accumulateSpecItem = (byCode, list, base, areaSqm, count, placeTag = '', floorName = '') => {
                let item = byCode.get(base.code);
                if (!item) {
                    item = Object.assign({ areaSqm: 0, count: 0, places: [], place: '' }, base);
                    byCode.set(base.code, item);
                    list.push(item);
                }
                item.areaSqm += areaSqm || 0;
                item.count += count || 0;
                item.area = `${item.areaSqm.toFixed(2)}m²`;
                item.qty = `${item.count}块`;
                if (placeTag && !item.places.includes(placeTag)) {
                    item.places.push(placeTag);
                    item.place = floorName ? `${floorName} ${item.places.join('、')}` : item.places.join('、');
                }
                return item;
            };

            /** 墙面分区 → 材料说明的基础字段（全屋汇总与墙面立面详图共用） */
            const wallZoneSpecBase = (z, desc) => {
                const meta = getSpecMeta('wall', 'tile', z.spec.styleId);
                const stObj = MaterialLib.get(z.spec.styleId, 'tile');
                return {
                    code: z.specLabel || `${meta.prefix}1`,
                    kind: meta.kind,
                    name: stObj?.name || meta.kind,
                    size: `${uSpec(z.tw, z.th, '*')}${Units.cur()}`,
                    desc
                };
            };
            const groutDesc = (gap, groutOn) => `留${gap}mm缝,${groutOn ? '填美缝剂' : '填填缝剂'}`;

            /**
             * 门洞过门石与压边条辅材：按「规格+材质 / 条型」归并。
             * 传入 room 时仅统计与该空间相邻的门洞，不传则统计全层。
             */
            const getDoorAuxSpecItems = (room = null) => {
                const list = [];
                const stoneMap = new Map();
                const stripMap = new Map();
                const formatPlace = (places) => floorName ? `${floorName} ${places.join('、')}`.trim() : places.join('、');
                for (const dp of (STATE.computedDoors || [])) {
                    if (room && dp.roomA?.id !== room.id && dp.roomB?.id !== room.id) continue;
                    const adjLabel = (dp.roomA && dp.roomB)
                        ? `${dp.roomA.name}↔${dp.roomB.name}`
                        : (dp.roomA?.name || dp.roomB?.name || '门洞');
                    if (dp.thresholdStone) {
                        const ts = dp.thresholdStone;
                        const sKey = `${ts.styleName || '过门石'}|${ts.lenMM}x${ts.widMM}`;
                        let item = stoneMap.get(sKey);
                        if (!item) {
                            item = {
                                ids: [],
                                code: ts.id,
                                kind: '过门石',
                                name: ts.styleName || '过门石',
                                size: `${uSpec(ts.lenMM, ts.widMM, '*')}${Units.cur()}`,
                                areaSqm: 0,
                                area: '0.00m²',
                                count: 0,
                                qty: '0块',
                                places: [],
                                place: '',
                                desc: '门洞石材过门石',
                                isDoorAux: true
                            };
                            stoneMap.set(sKey, item);
                            list.push(item);
                        }
                        if (ts.id && !item.ids.includes(ts.id)) item.ids.push(ts.id);
                        item.code = item.ids.length <= 2 ? item.ids.join('/') : `${item.ids[0]}~${item.ids[item.ids.length - 1]}`;
                        item.areaSqm += ts.areaSqm || 0;
                        item.area = `${item.areaSqm.toFixed(2)}m²`;
                        item.count += 1;
                        item.qty = `${item.count}块`;
                        if (adjLabel && !item.places.includes(adjLabel)) item.places.push(adjLabel);
                        item.place = formatPlace(item.places);
                    }
                    for (const st of (dp.strips || [])) {
                        const tKey = st.type || 'strip';
                        let item = stripMap.get(tKey);
                        if (!item) {
                            item = {
                                code: 'YT-1',
                                kind: '压边条',
                                name: st.typeLabel || '压边条/高低压条',
                                lenSet: new Set(),
                                size: '',
                                totalLenM: 0,
                                area: '0.00m',
                                count: 0,
                                qty: '0根',
                                places: [],
                                place: '',
                                desc: '门洞收口压边条',
                                isDoorAux: true
                            };
                            stripMap.set(tKey, item);
                            list.push(item);
                        }
                        item.lenSet.add(Math.round(st.lengthMM || 0));
                        const lens = Array.from(item.lenSet);
                        item.size = lens.length === 1 ? `长${uLen(lens[0])}${Units.cur()}` : '按门宽定制';
                        item.totalLenM += st.lengthM || 0;
                        item.area = `${item.totalLenM.toFixed(2)}m`;
                        item.count += 1;
                        item.qty = `${item.count}根`;
                        if (adjLabel && !item.places.includes(adjLabel)) item.places.push(adjLabel);
                        item.place = formatPlace(item.places);
                        item.desc = `总长${item.totalLenM.toFixed(2)}m`;
                    }
                }
                return list;
            };

            /** 地面美缝/填缝剂与粘结/垫层辅料（传 room 统计单空间，不传统计全层地面） */
            const getFloorGroutAndAuxItems = (targetRoom = null) => {
                const list = [];
                const groutMap = new Map();
                const auxMap = new Map();
                const formatPlace = (places) => floorName ? `${floorName} ${places.join('、')}`.trim() : places.join('、');
                const rooms = targetRoom ? [targetRoom] : STATE.rooms;
                for (const r of rooms) {
                    if (!r || r.cleared || !r.stats) continue;
                    const pTag = r.name ? `${r.name}(地面)` : '';
                    if ((r.stats.groutLengthM || 0) > 0) {
                        const isGrout = r.groutEnabled !== false;
                        const gKey = isGrout ? 'grout' : 'caulk';
                        let gItem = groutMap.get(gKey);
                        if (!gItem) {
                            gItem = {
                                code: isGrout ? 'MF-1' : 'TF-1',
                                kind: '美缝辅材',
                                name: isGrout ? '地面美缝剂' : '地面填缝剂',
                                gaps: new Set(),
                                size: '',
                                lenM: 0,
                                tubes: 0,
                                area: '0.0m',
                                qty: '0支',
                                places: [],
                                place: '',
                                desc: '按缝长与3mm缝深估算',
                                isAux: true
                            };
                            groutMap.set(gKey, gItem);
                            list.push(gItem);
                        }
                        gItem.gaps.add(getRoomJointMM(r));
                        const gs = Array.from(gItem.gaps);
                        gItem.size = gs.length === 1 ? `缝宽${gs[0]}mm` : `缝宽${gs.join('/')}mm`;
                        gItem.lenM += r.stats.groutLengthM || 0;
                        gItem.tubes += r.stats.groutTubes || 0;
                        gItem.area = `${gItem.lenM.toFixed(1)}m`;
                        gItem.qty = `${gItem.tubes}支`;
                        if (pTag && !gItem.places.includes(pTag)) gItem.places.push(pTag);
                        gItem.place = formatPlace(gItem.places);
                    }
                    if ((r.stats.auxArea || 0) > 0) {
                        const isWood = r.materialType === 'wood';
                        const aKey = isWood ? 'wood_pad' : 'tile_adh';
                        let aItem = auxMap.get(aKey);
                        if (!aItem) {
                            aItem = {
                                code: isWood ? 'FL-DC' : 'FL-NJ',
                                kind: '铺贴辅材',
                                name: isWood ? '地板防潮垫层' : '瓷砖粘结辅料',
                                size: isWood ? '防潮膜/垫' : '瓷砖胶/砂浆',
                                auxSqm: 0,
                                netSqm: 0,
                                area: '0.00m²',
                                qty: '按面积配比',
                                places: [],
                                place: '',
                                desc: isWood ? '含损耗铺贴面积' : '含损耗铺贴面积',
                                isAux: true
                            };
                            auxMap.set(aKey, aItem);
                            list.push(aItem);
                        }
                        aItem.auxSqm += r.stats.auxArea || 0;
                        aItem.netSqm += r.stats.areaSqm || 0;
                        aItem.area = `${aItem.auxSqm.toFixed(2)}m²`;
                        if (pTag && !aItem.places.includes(pTag)) aItem.places.push(pTag);
                        aItem.place = formatPlace(aItem.places);
                    }
                }
                return list;
            };

            /** 墙面美缝/填缝剂、墙砖粘结辅料与踢脚线安装辅料（可用于单空间立面页或全层总表） */
            const getWallGroutAndAuxItems = (targetRoom = null, sourceList = null) => {
                const list = [];
                if (typeof Elevation === 'undefined' || !Elevation.computeAllWallStats) return list;
                const wallStats = Elevation.computeAllWallStats();
                const allowedFaceKeys = sourceList ? new Set(sourceList.filter(x => x && x.cfg && x.lay && x.f).map(x => x.f.key)) : null;
                const groutMap = new Map();
                const groutAcc = new Map(); // 按「房间+缝色+单价」合并加权缝长后统一向上取整，与总造价/报价单一致
                const auxItem = {
                    code: 'FL-QNJ',
                    kind: '铺贴辅材',
                    name: '墙砖粘结辅料',
                    size: '墙砖背胶/粘结剂',
                    auxSqm: 0,
                    area: '0.00m²',
                    qty: '按面积配比',
                    places: [],
                    place: '',
                    desc: '含损耗铺贴面积',
                    isAux: true
                };
                const formatPlace = (places) => floorName ? `${floorName} ${places.join('、')}`.trim() : places.join('、');
                const C = PRESETS.calc;
                for (const w of (wallStats.rows || [])) {
                    if (targetRoom && w.room !== targetRoom) continue;
                    if (allowedFaceKeys && !allowedFaceKeys.has(w.face?.key || '')) continue;
                    const pTag = w.room?.name ? `${w.room.name}(墙面)` : '';
                    if ((w.groutLen || 0) > 0) {
                        const isGrout = w.cfg?.groutEnabled !== false;
                        const gKey = isGrout ? 'w_grout' : 'w_caulk';
                        let gItem = groutMap.get(gKey);
                        if (!gItem) {
                            gItem = {
                                code: isGrout ? 'WMF-1' : 'WTF-1',
                                kind: '美缝辅材',
                                name: isGrout ? '墙面美缝剂' : '墙面填缝剂',
                                gaps: new Set(),
                                size: '',
                                lenM: 0,
                                tubes: 0,
                                area: '0.0m',
                                qty: '0支',
                                places: [],
                                place: '',
                                desc: '按缝长与3mm缝深估算',
                                isAux: true
                            };
                            groutMap.set(gKey, gItem);
                            list.push(gItem);
                        }
                        const gap = Math.max(0, Number(w.cfg?.gap ?? PRESETS.wall.face.gap));
                        gItem.gaps.add(gap);
                        const gs = Array.from(gItem.gaps);
                        gItem.size = gs.length === 1 ? `缝宽${gs[0]}mm` : `缝宽${gs.join('/')}mm`;
                        gItem.lenM += w.groutLen || 0;
                        gItem.area = `${gItem.lenM.toFixed(1)}m`;
                        if (pTag && !gItem.places.includes(pTag)) gItem.places.push(pTag);
                        gItem.place = formatPlace(gItem.places);
                        const price = priceOr(w.cfg?.groutPrice, PRESETS.wall.face.groutPrice);
                        const color = w.cfg?.groutColor || PRESETS.wall.face.groutColor;
                        const accKey = `${gKey}|${w.room?.id || ''}|${color}|${price}`;
                        const acc = groutAcc.get(accKey) || { gItem, weighted: 0 };
                        acc.weighted += w.groutLen * Math.max(1.0, (gap * C.groutDepthMM) / C.groutCrossRef);
                        groutAcc.set(accKey, acc);
                    }
                    if ((w.auxArea || 0) > 0) {
                        auxItem.auxSqm += w.auxArea || 0;
                        auxItem.area = `${auxItem.auxSqm.toFixed(2)}m²`;
                        if (pTag && !auxItem.places.includes(pTag)) auxItem.places.push(pTag);
                        auxItem.place = formatPlace(auxItem.places);
                    }
                }
                for (const acc of groutAcc.values()) {
                    acc.gItem.tubes += Math.ceil(acc.weighted / C.groutMetersPerTube);
                    acc.gItem.qty = `${acc.gItem.tubes}支`;
                }
                if (auxItem.auxSqm > 0) list.push(auxItem);

                // 补齐踢脚线安装辅料（与报价单及总造价口径一致）
                if (!allowedFaceKeys) {
                    const skAuxItem = {
                        code: 'FL-SK',
                        kind: '铺贴辅材',
                        name: '踢脚线安装辅料',
                        size: '粘结剂/胶钉',
                        auxSqm: 0,
                        area: '0.00m²',
                        qty: '按面积配比',
                        places: [],
                        place: '',
                        desc: '按踢脚线采购面积与厚度折算',
                        isAux: true
                    };
                    for (const s of (wallStats.skirtingMerged || wallStats.skirtingRows || [])) {
                        if (targetRoom && s.room !== targetRoom) continue;
                        const qAux = s.auxQty != null ? s.auxQty : (s.auxArea || 0);
                        if (!(qAux > 0)) continue;
                        skAuxItem.auxSqm += qAux;
                        skAuxItem.area = `${skAuxItem.auxSqm.toFixed(2)}m²`;
                        const pTag = s.room?.name ? `${s.room.name}(踢脚)` : '';
                        if (pTag && !skAuxItem.places.includes(pTag)) skAuxItem.places.push(pTag);
                        skAuxItem.place = formatPlace(skAuxItem.places);
                    }
                    if (skAuxItem.auxSqm > 0) list.push(skAuxItem);
                }
                return list;
            };

            const getAllMaterialSpecItems = () => {
                const list = [];
                const byCode = new Map();
                for (const r of STATE.rooms) {
                    if (r.cleared || !r.computedTiles || !r.computedTiles.length) continue;
                    const meta = getSpecMeta('floor', r.materialType, r.styleId);
                    const stObj = MaterialLib.getForRoom(r);
                    accumulateSpecItem(byCode, list, {
                        code: r.specLabel || previewRoomSpecLabel(r),
                        kind: meta.kind,
                        name: stObj?.name || meta.kind,
                        size: `${uSpec(r.tileW, r.tileH, '*')}${Units.cur()}`,
                        desc: formatRoomMaterialDesc(r)
                    }, r.stats?.areaSqm ?? 0, r.stats?.buyCount ?? r.computedTiles.length,
                    r.name ? `${r.name}(地面)` : '', floorName);
                }
                if (typeof Elevation !== 'undefined' && Elevation.forEachWallZone) {
                    Elevation.forEachWallZone((z, room, f, lay) => {
                        const gap = Math.max(0, Number(lay.gap ?? 1.5));
                        const wallCfg = Elevation.getCfg ? Elevation.getCfg(room, f.key) : null;
                        const groutOn = wallCfg ? wallCfg.groutEnabled !== false : room.wallGroutEnabled !== false;
                        accumulateSpecItem(byCode, list, wallZoneSpecBase(z, groutDesc(gap, groutOn)),
                            z.stats?.area ?? 0, z.stats?.buy ?? (z.tiles ? z.tiles.length : 0),
                            room.name ? `${room.name}(墙面)` : '', floorName);
                    });
                }
                for (const skItem of getSkirtingSpecItems()) list.push(skItem);
                for (const dItem of getDoorAuxSpecItems()) list.push(dItem);
                for (const fItem of getFloorGroutAndAuxItems()) list.push(fItem);
                for (const wItem of getWallGroutAndAuxItems()) list.push(wItem);
                return list;
            };

            return { formatRoomMaterialDesc, getSkirtingSpecItems, getDoorAuxSpecItems, getFloorGroutAndAuxItems, getWallGroutAndAuxItems, accumulateSpecItem, wallZoneSpecBase, groutDesc, getAllMaterialSpecItems };
        }

        /**
         * 生成整套 CAD 施工图 DXF（支持多层：每层独立一行横向排布，开启多层模式时在每行最前面标注层名称）。
         * 返回 { drawing, sheets: [{ area: [x0,y0,x1,y1], title }], projectName, totalSheets, roomSheetCount, floorCount }，
         * sheets 为每张图幅的模型空间范围，供 PDF 逐页输出使用。DXF / PDF / DWG 导出共用这一份数据。
         */
        async function buildProjectDrawing(exportOpts = {}) {
            const origSnap = JSON.parse(JSON.stringify(getSerializableState()));
            const origSelectedRoomId = STATE.selectedRoomId;
            const rawFloors = STATE.floorsEnabled
                ? STATE.floors.map(f => ({ id: f.id, name: f.name, snap: f.id === STATE.currentFloorId ? origSnap : (f.snap || emptyFloorState()) }))
                : [{ id: STATE.currentFloorId, name: '', snap: origSnap }];
            const activeFloors = rawFloors.filter(f => (f.snap.walls && f.snap.walls.length > 0) || (f.snap.rooms && f.snap.rooms.length > 0));
            if (activeFloors.length === 0) {
                showToast('当前画布无墙体或房间实体，请先绘制或导入户型');
                return null;
            }

            await ChineseFontEngine.ensureLoaded();

            const fieldOvs = exportOpts.fieldOverrides || {};
            const merchant = getMerchantInfo();
            const merchantCompany = fieldOvs.merchantCompany != null ? String(fieldOvs.merchantCompany) : merchant.company;
            const merchantContact = fieldOvs.merchantContact != null ? String(fieldOvs.merchantContact) : merchant.contact;
            const merchantPhone = fieldOvs.merchantPhone != null ? String(fieldOvs.merchantPhone) : merchant.phone;
            const merchantAddress = fieldOvs.merchantAddress != null ? String(fieldOvs.merchantAddress) : merchant.address;
            const projectName = fieldOvs.projectName != null ? String(fieldOvs.projectName) : getProjectName();
            const clientName = fieldOvs.clientName != null ? String(fieldOvs.clientName) : getClientName();
            const rawDateOverride = fieldOvs.date != null ? String(fieldOvs.date).trim() : '';
            const dateStr = rawDateOverride || formatLocalDate('-');
            const optShowTileMarks = exportOpts.showTileMarks != null ? !!exportOpts.showTileMarks : !!STATE.showTileMarks;
            const optColorTiles = !!exportOpts.colorTiles;
            const optSolidWalls = !!exportOpts.solidWalls;
            const optOmitOuterFrame = !!exportOpts.omitOuterFrame;
            const frameOverrides = { cellOverrides: exportOpts.cellOverrides || {}, entOverrides: exportOpts.entOverrides || {}, omitOuterFrame: optOmitOuterFrame };
            const fontScales = normalizeCadFontScales(exportOpts.fontScales);
            const fs = (key) => (fontScales[key] || 100) / 100;
            const scaleH = (baseH, key, minH = 16) => Math.max(minH, Math.round(baseH * fs(key)));

            const dxf = new CadDrawing();
            // 图框编辑器 (tukuan.html) 中“保存应用”的图框；未保存时使用随程序提供的默认图框
            const appliedFrame = await loadAppliedSheetFrame();

            // 注册精简后的 4 大类标准 CAD 图层体系：
            // 1. SHEET_FRAME (图框层)：外框、坐标轴、图签栏、指北针、图纸底部标题、楼层标识
            // 2. FLOOR_PLAN (户型图层)：墙体、门窗符号、房间边界、伸缩缝、起铺基准点、过门石/压边条、空间标签、尺寸标注
            // 3. TILE_<规格编码> (每种瓷砖/地板独立一层)：对应规格编码(如 CT1、WD1、WT1)的砖块轮廓与砖号标记
            // 4. MATERIAL_TABLE (材料表明细表层)：左下角材料说明表与末页材料明细表
            dxf.addLayer('SHEET_FRAME', 7, 'CONTINUOUS');       // 7 白/黑: 图框与图签栏层
            dxf.addLayer('FLOOR_PLAN', 7, 'CONTINUOUS');        // 7 白/黑: 户型结构与尺寸标注层
            dxf.addLayer('ORIGIN_MARK', 1, 'CONTINUOUS');       // 1 红: 起铺基准点靶标与文字层
            if (optSolidWalls) dxf.addLayer('WALL_FILL', 7, 'CONTINUOUS');   // 实心墙体填充层
            dxf.addLayer('MATERIAL_TABLE', 7, 'CONTINUOUS');    // 7 白/黑: 材料说明与材料明细表层

            const tileSpecColorPalette = [4, 3, 2, 6, 5, 30, 140, 40];
            const tileSpecLayerMap = new Map();
            const getTileSpecLayer = (codeStr) => {
                const raw = String(codeStr || '').trim();
                const layerName = raw ? CadDrawing.cleanName(`TILE_${raw}`) : 'TILE';
                if (!tileSpecLayerMap.has(layerName)) {
                    // 开启「块着色」时为每种砖/地板/过门石规格分配独立 ACI 描边颜色；未开启时统一白色/黑色 (ACI 7)
                    const color = optColorTiles ? tileSpecColorPalette[tileSpecLayerMap.size % tileSpecColorPalette.length] : 7;
                    dxf.addLayer(layerName, color, 'CONTINUOUS');
                    tileSpecLayerMap.set(layerName, layerName);
                }
                return layerName;
            };
            const getRoomTileLayer = (r) => {
                const code = r?.specLabel || previewRoomSpecLabel(r);
                return getTileSpecLayer(code);
            };

            // 图幅在模型空间统一按 29700 宽排布 (A4 横向 1:100)；每层图纸排成一行，开启多层模式时每行最前面加上层名称
            const frameK = appliedFrame ? 29700 / appliedFrame.sheetWidthMm : 1;
            const sheetW = 29700;
            const sheetH = appliedFrame ? Math.round(appliedFrame.sheetHeightMm * frameK) : 21000;
            const sheetGap = 3500;
            const outerM = 360;
            const innerM = 640;
            const matReserveH = 440 + 7 * 380 + 360;
            const preFrameBounds = appliedFrame
                ? computeAppliedFrameContentBounds(appliedFrame, 0, 0, frameK)
                : { contentLeft: innerM + 300, contentRight: sheetW - innerM - 300, contentBottom: innerM + 300, contentTop: sheetH - innerM - 850 - 260, tbH: 1900 };

            const sheets = [];
            let currentSheetIdx = 0;
            const mmPerPx = 1000 / SCALE_PIXELS_PER_METER;
            const snapPxToMm = v => Math.round(v * mmPerPx) / mmPerPx;
            const rawFrameFields = !!appliedFrame;   // 应用图框：图纸编号 / 名称的前后缀写在图框格子里；无图框时由内置图签补「PZ-」与楼层名

            try {
            // 第一阶段：逐层算量、分页规划与材料明细收集
            const preparedFloors = [];
            for (let rowIdx = 0; rowIdx < activeFloors.length; rowIdx++) {
                const fl = activeFloors[rowIdx];
                if (STATE.floorsEnabled) {
                    applyFloorSnapshotFields(fl.snap);
                    if (typeof Elevation !== 'undefined' && Elevation.resetCacheForExport) Elevation.resetCacheForExport();
                }
                recomputeAllRoomTiling();
                const floorName = STATE.floorsEnabled ? (fl.name || `${rowIdx + 1}F`) : '';
                const activeRooms = STATE.rooms.filter(r => !r.cleared && getRoomPolygonVerts(r).length >= 3);
                const roomsForSheets = activeRooms.length > 0 ? activeRooms : STATE.rooms;
                const elevRooms = Elevation.roomsWithWallTiling();
                const elevPlan = elevRooms.length
                    ? Elevation.planElevationSheets({ ...preFrameBounds, matReserveH }, elevRooms)
                    : { pages: [] };
                const matHelpers = createMaterialSpecHelpers(floorName);
                const allItems = matHelpers.getAllMaterialSpecItems();
                const wholeStats = sumRoomStats();
                const firstPrice = getUnitPrice(roomsForSheets[0] || STATE.rooms[0]);
                const sheetCount = 1 + roomsForSheets.length + elevPlan.pages.length + 1;
                preparedFloors.push({
                    rowIdx,
                    floorName,
                    roomsForSheets,
                    elevRooms,
                    elevPlan,
                    matHelpers,
                    allItems,
                    wholeStats,
                    firstPrice,
                    sheetCount,
                    snapshot: {
                        vertices: STATE.vertices,
                        walls: STATE.walls,
                        openings: STATE.openings,
                        rooms: STATE.rooms,
                        northAngle: STATE.northAngle,
                        floorHeightMM: STATE.floorHeightMM,
                        specMeta: STATE.specMeta,
                        specPrices: STATE.specPrices,
                        tileNumSep: STATE.tileNumSep,
                        computedDoors: STATE.computedDoors,
                        mergeGroups: STATE.mergeGroups,
                        specList: STATE.specList
                    }
                });
            }

            const totalSheets = preparedFloors.reduce((s, f) => s + f.sheetCount, 0);
            const totalRoomSheets = preparedFloors.reduce((s, f) => s + f.roomsForSheets.length, 0);
            const curFloorCtx = {
                floorName: '',
                wholeStats: { sumArea: 0, sumBuy: 0, allCost: 0 },
                firstPrice: 0,
                roomsForSheets: [],
                floorBaseIdx: 0,
                rowIdx: 0,
                colIdx: 0
            };

            const frameFieldValues = (sheetIdx, sheetTitle, sheetSubTitle, room) => {
                const st = room?.stats;
                const seq = String(sheetIdx + 1).padStart(2, '0');
                const floorName = curFloorCtx.floorName;
                return {
                    merchantCompany,
                    merchantContact,
                    merchantPhone,
                    merchantAddress,
                    projectName,
                    clientName,
                    floorName,
                    sheetTitle: rawFrameFields ? sheetTitle : ((floorName && !String(sheetTitle).startsWith(floorName)) ? `${floorName}${sheetTitle}` : sheetTitle),
                    sheetDesc: sheetSubTitle,
                    sheetNo: rawFrameFields ? seq : `PZ-${seq}`,
                    sheetSeq: seq,
                    pageNo: `${sheetIdx + 1} / ${totalSheets}`,
                    totalSheets: String(totalSheets),
                    date: dateStr.replace(/-/g, '.'),
                    sheetSize: appliedFrame?.sheetLabel || 'A4 横向',
                    roomName: room ? room.name : '全屋',
                    roomSpec: room ? `${uSpec(room.tileW, room.tileH)}${Units.cur()} ${patternLabel(room.pattern)}` : '多规格',
                    lengthUnit: Units.NAME[Units.cur()],
                    roomArea: `${(st ? st.areaSqm : curFloorCtx.wholeStats.sumArea).toFixed(2)} m²`,
                    roomBuy: `${st ? st.buyCount : curFloorCtx.wholeStats.sumBuy} 块`,
                    roomCount: `${curFloorCtx.roomsForSheets.length} 个`,
                    totalArea: `${curFloorCtx.wholeStats.sumArea.toFixed(2)} m²`,
                    totalBuy: `${curFloorCtx.wholeStats.sumBuy} 块`,
                    totalCost: `¥${Math.round(curFloorCtx.wholeStats.allCost)}`,
                    unitPrice: `¥${room ? getUnitPrice(room) : curFloorCtx.firstPrice} / m²`
                };
            };
            const drawCadSheetFrame = (sheetIdx, sheetTitle, sheetSubTitle, room = null) => {
                if (sheets[currentSheetIdx] && sheets[currentSheetIdx].entEnd == null) {
                    sheets[currentSheetIdx].entEnd = dxf.entities.length;
                    sheets[currentSheetIdx].dimEnd = dxf.dimensions.length;
                }
                currentSheetIdx = sheetIdx;
                const floorName = curFloorCtx.floorName;
                const fullSheetTitle = (floorName && !String(sheetTitle).startsWith(floorName)) ? `${floorName}${sheetTitle}` : sheetTitle;
                const ox = curFloorCtx.colIdx * (sheetW + sheetGap);
                const oy = -curFloorCtx.rowIdx * (sheetH + sheetGap);
                curFloorCtx.colIdx++;
                sheets[sheetIdx] = {
                    area: [ox, oy, ox + sheetW, oy + sheetH],
                    title: `${sheetIdx + 1}. ${fullSheetTitle}`,
                    ox,
                    oy,
                    floorRowIdx: curFloorCtx.rowIdx,
                    floorLabel: floorName,
                    entStart: dxf.entities.length,
                    entEnd: null,
                    dimStart: dxf.dimensions.length,
                    dimEnd: null,
                    sk: sheets[curFloorCtx.floorBaseIdx]?.sk || 1
                };
                if (appliedFrame) {
                    return drawAppliedSheetFrame(dxf, appliedFrame, ox, oy, frameK, frameFieldValues(sheetIdx, sheetTitle, sheetSubTitle, room), frameOverrides);
                }
                dxf.setActiveLayer('SHEET_FRAME');
                if (!optOmitOuterFrame) {
                    dxf.drawRect(ox + outerM, oy + outerM, ox + sheetW - outerM, oy + sheetH - outerM);
                }
                dxf.drawRect(ox + innerM, oy + innerM, ox + sheetW - innerM, oy + sheetH - innerM);

                // 顶部页眉标题栏
                const topBarY = oy + sheetH - innerM - 850;
                dxf.drawLine(ox + innerM, topBarY, ox + sheetW - innerM, topBarY);
                dxf.drawText(ox + innerM + 350, topBarY + 425, scaleH(280, 'sheetTitle', 120), `${projectName}${clientName ? ' · ' + clientName : ''} · ${fullSheetTitle}`, 0, false);
                dxf.drawText(ox + sheetW - innerM - 3200, topBarY + 425, scaleH(210, 'sheetTitle', 100), `第 ${sheetIdx + 1} / ${totalSheets} 页`, 0, false);

                // 右下角标准图签栏
                const tbW = 8600, tbH = 1900;
                const tbX = ox + sheetW - innerM - tbW;
                const tbY = oy + innerM;
                dxf.drawRect(tbX, tbY, tbX + tbW, tbY + tbH);
                dxf.drawLine(tbX, tbY + 630, tbX + tbW, tbY + 630);
                dxf.drawLine(tbX, tbY + 1260, tbX + tbW, tbY + 1260);
                dxf.drawLine(tbX + 4600, tbY, tbX + 4600, tbY + 1260);

                dxf.drawText(tbX + 240, tbY + 1580, scaleH(210, 'sheetTitle', 90), `工程：${projectName}${clientName ? '   客户：' + clientName : ''}`, 0, false);
                dxf.drawText(tbX + 240, tbY + 945, scaleH(175, 'sheetTitle', 80), `图名：${fullSheetTitle}`, 0, false);
                dxf.drawText(tbX + 4840, tbY + 945, scaleH(175, 'sheetTitle', 80), `图幅：A4 横向工程图`, 0, false);
                dxf.drawText(tbX + 240, tbY + 315, scaleH(175, 'sheetTitle', 80), `说明：${sheetSubTitle}`, 0, false);
                dxf.drawText(tbX + 4840, tbY + 315, scaleH(175, 'sheetTitle', 80), `页码：${sheetIdx + 1}/${totalSheets}  日期：${dateStr}`, 0, false);

                return {
                    ox,
                    oy,
                    innerLeft: ox + innerM,
                    innerRight: ox + sheetW - innerM,
                    innerBottom: oy + innerM,
                    innerTop: topBarY,
                    contentLeft: ox + innerM + 300,
                    contentBottom: oy + innerM + 300,
                    contentRight: ox + sheetW - innerM - 300,
                    contentTop: topBarY - 260,
                    tbX,
                    tbY,
                    tbW,
                    tbH
                };
            };

                const drawLegendSymbolDxf = (it, cx, cy, sw, sh) => {
                    if (!it) return;
                    const type = it.type;
                    if (type === 'origin') {
                        dxf.setActiveLayer('ORIGIN_MARK');
                        const r = Math.max(45, Math.min(sw, sh) * 0.34);
                        const arm = r * 1.62;
                        dxf.drawCircle(cx, cy, r);
                        dxf.drawCircle(cx, cy, Math.max(18, r * 0.38));
                        dxf.drawLine(cx - arm, cy, cx + arm, cy);
                        dxf.drawLine(cx, cy - arm, cx, cy + arm);
                        return;
                    }
                    if (type === 'tile' || type === 'colorSpec') {
                        const layer = it.layer || getTileSpecLayer(it.sampleCode || '');
                        dxf.setActiveLayer(layer);
                        const bw = Math.min(sw * 0.84, sh * 1.55);
                        const bh = sh * 0.72;
                        dxf.drawRect(cx - bw * 0.5, cy - bh * 0.5, cx + bw * 0.5, cy + bh * 0.5);
                        const codeStr = it.codeText || (optShowTileMarks ? (it.sampleCode || 'A1') : '');
                        if (codeStr) {
                            const txtH = Math.max(42, Math.min(90, Math.round(bh * 0.44)));
                            dxf.drawText(cx, cy, txtH, codeStr, 0, true);
                        }
                        return;
                    }
                    if (type === 'expGap') {
                        dxf.setActiveLayer('FLOOR_PLAN');
                        const bw = sw * 0.84, bh = sh * 0.60;
                        dxf.drawRect(cx - bw * 0.5, cy - bh * 0.5, cx + bw * 0.5, cy + bh * 0.5, 'DASHED');
                        return;
                    }
                    if (type === 'doorWin') {
                        dxf.setActiveLayer('FLOOR_PLAN');
                        // 左侧平开门符号 + 右侧窗洞符号
                        const d = Math.min(sw * 0.34, sh * 0.68);
                        const dx0 = cx - sw * 0.38;
                        const dy0 = cy - d * 0.45;
                        dxf.drawLine(dx0, dy0, dx0, dy0 + d);
                        dxf.drawLine(dx0, dy0, dx0 + d, dy0);
                        const arcPts = [];
                        for (let i = 0; i <= 6; i++) {
                            const a = (Math.PI * 0.5) * (i / 6);
                            arcPts.push([dx0 + Math.cos(a) * d, dy0 + Math.sin(a) * d]);
                        }
                        dxf.drawPolyline(arcPts, false);
                        const ww = sw * 0.34, wh = Math.min(sh * 0.34, 110);
                        const wx0 = cx + sw * 0.08;
                        dxf.drawRect(wx0, cy - wh * 0.5, wx0 + ww, cy + wh * 0.5);
                        dxf.drawLine(wx0, cy, wx0 + ww, cy);
                        return;
                    }
                    if (type === 'threshold') {
                        const msLayer = optColorTiles ? getTileSpecLayer('MS') : 'FLOOR_PLAN';
                        const bw = sw * 0.72, bh = sh * 0.46;
                        dxf.setActiveLayer(msLayer);
                        dxf.drawRect(cx - bw * 0.5, cy - bh * 0.40, cx + bw * 0.5, cy + bh * 0.56);
                        dxf.drawText(cx, cy + bh * 0.08, Math.max(40, Math.min(82, Math.round(bh * 0.52))), 'MS', 0, true);
                        dxf.setActiveLayer('FLOOR_PLAN');
                        dxf.drawLine(cx - bw * 0.56, cy - bh * 0.68, cx + bw * 0.56, cy - bh * 0.68);
                        return;
                    }
                    if (type === 'wall') {
                        const bw = sw * 0.82, bh = Math.min(sh * 0.38, 120);
                        const pts = [
                            [cx - bw * 0.5, cy - bh * 0.5],
                            [cx + bw * 0.5, cy - bh * 0.5],
                            [cx + bw * 0.5, cy + bh * 0.5],
                            [cx - bw * 0.5, cy + bh * 0.5]
                        ];
                        if (it.solid) {
                            dxf.setActiveLayer('WALL_FILL');
                            dxf.drawSolidQuad(pts, 7);
                        }
                        dxf.setActiveLayer('FLOOR_PLAN');
                        dxf.drawPolyline(pts, true);
                        return;
                    }
                    if (type === 'elevOpen') {
                        dxf.setActiveLayer('FLOOR_PLAN');
                        const dh = sh * 0.72, dw = Math.min(sw * 0.32, dh * 0.75);
                        const dx0 = cx - sw * 0.36;
                        dxf.drawRect(dx0, cy - dh * 0.5, dx0 + dw, cy + dh * 0.5);
                        dxf.drawPolyline([[dx0, cy + dh * 0.5], [dx0 + dw, cy], [dx0, cy - dh * 0.5]], false);
                        const wx0 = cx + sw * 0.06, wh = dh * 0.68, ww = Math.min(sw * 0.34, wh * 1.1);
                        dxf.drawRect(wx0, cy - wh * 0.5, wx0 + ww, cy + wh * 0.5);
                        dxf.drawLine(wx0 + ww * 0.5, cy - wh * 0.5, wx0 + ww * 0.5, cy + wh * 0.5);
                        return;
                    }
                    if (type === 'keyPlan') {
                        dxf.setActiveLayer('FLOOR_PLAN');
                        const r = Math.min(sw, sh) * 0.34;
                        dxf.drawRect(cx - r * 1.15, cy - r, cx + r * 1.15, cy + r);
                        dxf.drawLine(cx, cy - r * 0.65, cx, cy + r * 0.65);
                        dxf.drawLine(cx - r * 0.65, cy, cx + r * 0.65, cy);
                        dxf.drawPolyline([[cx - r * 0.25, cy + r * 0.35], [cx, cy + r * 0.70], [cx + r * 0.25, cy + r * 0.35]], false);
                        return;
                    }
                    if (type === 'elevBand') {
                        dxf.setActiveLayer('FLOOR_PLAN');
                        const bw = sw * 0.84, bh = sh * 0.56;
                        dxf.drawLine(cx - bw * 0.5, cy - bh * 0.45, cx + bw * 0.5, cy - bh * 0.45);
                        dxf.drawLine(cx - bw * 0.44, cy + bh * 0.12, cx + bw * 0.44, cy + bh * 0.12, 'DASHED');
                        dxf.drawLine(cx, cy - bh * 0.45, cx, cy + bh * 0.12);
                        return;
                    }
                    if (type === 'wallLine') {
                        dxf.setActiveLayer('FLOOR_PLAN');
                        const bw = sw * 0.72, bh = sh * 0.58;
                        dxf.drawRect(cx - bw * 0.5, cy - bh * 0.40, cx + bw * 0.5, cy + bh * 0.52);
                        dxf.drawLine(cx - bw * 0.68, cy - bh * 0.40, cx + bw * 0.68, cy - bh * 0.40);
                    }
                };

                const buildLegendItems = (leg) => {
                    if (!leg) return [];
                    const isElev = leg.mode === 'elev';
                    const sampleCode = leg.sampleCode || (isElev ? 'W1' : 'A1');
                    const itemsList = isElev ? [
                        { type: 'origin', label: '墙面起铺点' },
                        { type: 'tile', label: optShowTileMarks ? '墙砖轮廓及编号' : '墙砖铺贴轮廓', sampleCode },
                        { type: 'elevOpen', label: '立面门洞 / 窗洞' },
                        { type: 'keyPlan', label: '分区方位索引标' },
                        { type: 'elevBand', label: '踢脚线 / 吊顶区' },
                        { type: 'wallLine', label: '墙面边界与地面线' }
                    ] : [
                        { type: 'origin', label: '起铺点（放线基准）' },
                        { type: 'tile', label: optShowTileMarks ? '砖块轮廓及编号' : '砖块铺贴轮廓', sampleCode },
                        { type: 'expGap', label: '离墙外边缝 / 伸缩缝' },
                        { type: 'doorWin', label: '平开门 / 窗洞符号' },
                        { type: 'threshold', label: '过门石 / 压边条' },
                        { type: 'wall', label: optSolidWalls ? '实心结构墙体' : '双线建筑墙体', solid: optSolidWalls }
                    ];
                    if (Array.isArray(leg.colorSpecs) && leg.colorSpecs.length > 0) {
                        const maxExtra = Math.min(6, leg.colorSpecs.length);
                        for (let i = 0; i < maxExtra; i++) {
                            const sp = leg.colorSpecs[i];
                            itemsList.push({
                                type: 'colorSpec',
                                layer: optColorTiles ? (sp.layer || getTileSpecLayer(sp.code)) : 'TILE',
                                codeText: sp.code,
                                label: sp.name || sp.code
                            });
                        }
                    }
                    return itemsList;
                };

                const drawLegendBoxDxf = (lx, lyBot, lw, lh, numCols, legItems, hdrH, lblX, lblTextH) => {
                    const numRows = Math.max(1, Math.ceil(legItems.length / numCols));
                    const bodyH = Math.max(360, lh - hdrH);
                    const baseRowH = Math.floor(bodyH / numRows);
                    const rowHeights = Array(numRows).fill(baseRowH);
                    rowHeights[numRows - 1] += bodyH - baseRowH * numRows;
                    const lyTop = lyBot + lh;

                    dxf.setActiveLayer('MATERIAL_TABLE');
                    dxf.drawText(lblX, lyTop + 115, scaleH(200, 'tableText', 100), '图示说明', 0, false);
                    dxf.drawRect(lx, lyBot, lx + lw, lyTop);

                    const headerBotY = lyTop - hdrH;
                    dxf.drawLine(lx, headerBotY, lx + lw, headerBotY);
                    let ryCur = headerBotY;
                    const rowMidYs = [];
                    for (let r = 0; r < numRows; r++) {
                        const nextY = ryCur - rowHeights[r];
                        rowMidYs.push((ryCur + nextY) * 0.5);
                        if (r < numRows - 1) dxf.drawLine(lx, nextY, lx + lw, nextY);
                        ryCur = nextY;
                    }

                    const baseGroupW = Math.floor(lw / numCols);
                    const hdrTxtH = Math.max(55, Math.min(Math.round(hdrH * 0.68), Math.round(lblTextH * 1.05)));
                    const dataTxtH = Math.max(50, Math.min(Math.round(baseRowH * 0.62), Math.round(lblTextH * 0.96)));
                    const symMaxH = Math.min(...rowHeights) * 0.62;

                    for (let c = 0; c < numCols; c++) {
                        const gx0 = lx + c * baseGroupW;
                        const gx1 = (c === numCols - 1) ? (lx + lw) : (gx0 + baseGroupW);
                        const gw = gx1 - gx0;
                        const symW = Math.max(680, Math.min(1280, Math.round(gw * 0.30)));
                        const divX = gx0 + symW;
                        dxf.setActiveLayer('MATERIAL_TABLE');
                        if (c > 0) dxf.drawLine(gx0, lyBot, gx0, lyTop);
                        dxf.drawLine(divX, lyBot, divX, lyTop);
                        dxf.drawText(gx0 + symW * 0.5, lyTop - hdrH * 0.5, hdrTxtH, '图例', 0, true);
                        dxf.drawText(divX + (gw - symW) * 0.5, lyTop - hdrH * 0.5, hdrTxtH, '说明', 0, true);

                        for (let r = 0; r < numRows; r++) {
                            const idx = c * numRows + r;
                            const it = legItems[idx];
                            if (!it) continue;
                            const rowY = rowMidYs[r];
                            drawLegendSymbolDxf(it, gx0 + symW * 0.5, rowY, symW * 0.72, symMaxH);
                            dxf.setActiveLayer('MATERIAL_TABLE');
                            const availTextW = Math.max(600, (gx1 - divX) - 180);
                            const em = Math.max(1, ChineseFontEngine.measureTextEm(it.label));
                            const fitH = Math.max(62, Math.min(dataTxtH, Math.floor(availTextW / em)));
                            dxf.drawText(divX + 95, rowY - fitH * 0.36, fitH, it.label, 0, false);
                        }
                    }
                };

                const drawMaterialSpecTableDxf = (frame, items = [], opts = {}) => {
                    const includePlace = !!opts.includePlace;
                    const MAX_ROWS = items.length > 14 ? 8 : 7;
                    const numCols = Math.max(1, Math.ceil(items.length / MAX_ROWS));
                    const baseCw = includePlace
                        ? [500, 960, 920, 1280, 1420, 1020, 860, 1840, 1900]
                        : [520, 1020, 960, 1340, 1500, 1040, 900, 2020];
                    const baseGroupW = baseCw.reduce((a, b) => a + b, 0);
                    const tx = (frame.layoutMode === 'edge' && frame.edgePosition === 'left') || frame.cornerPosition === 'bottom-left'
                        ? frame.tbX + frame.tbW
                        : (frame.innerLeft ?? (frame.contentLeft - 300));
                    const rightLimit = (frame.layoutMode === 'edge' && frame.edgePosition === 'right')
                        ? (frame.tbX - 160)
                        : ((frame.tbH > 0 && frame.tbX > tx) ? (frame.tbX - 160) : (frame.innerRight - 160));
                    const availW = Math.max(4000, rightLimit - tx);
                    const rawTotalW = baseGroupW * numCols;
                    const wScale = rawTotalW > availW ? (availW / rawTotalW) : 1;

                    const colWidths = [];
                    const headerRow = [];
                    for (let c = 0; c < numCols; c++) {
                        for (const w of baseCw) colWidths.push(Math.round(w * wScale));
                        if (includePlace) {
                            headerRow.push('序号', '材料编码', '材料类别', '材料名称', '规格/型号', '面积', '数量', '使用部位', '描述');
                        } else {
                            headerRow.push('序号', '材料编码', '材料类别', '材料名称', '规格/型号', '面积', '数量', '描述');
                        }
                    }

                    const headerH = 440;
                    const dataRowH = 380;
                    const rowHeights = [headerH, ...Array(MAX_ROWS).fill(dataRowH)];
                    const rows = [headerRow];
                    for (let r = 0; r < MAX_ROWS; r++) {
                        const row = [];
                        for (let c = 0; c < numCols; c++) {
                            const idx = c * MAX_ROWS + r;
                            const seqStr = String(idx + 1).padStart(2, '0');
                            const it = items[idx];
                            const cells = it ? [it.code, it.kind, it.name || '', it.size, it.area || '', it.qty || ''] : ['', '', '', '', '', ''];
                            if (includePlace) cells.push(it ? (it.place || '') : '');
                            row.push(seqStr, ...cells, it ? it.desc : '');
                        }
                        rows.push(row);
                    }

                    const tableH = headerH + MAX_ROWS * dataRowH;
                    const tableW = colWidths.reduce((a, b) => a + b, 0);
                    const ty = frame.innerBottom + tableH;
                    const textH = scaleH(Math.max(80, Math.round(115 * Math.min(1, wScale))), 'tableText', 56);

                    dxf.setActiveLayer('MATERIAL_TABLE');
                    dxf.drawText(tx + Math.round(380 * wScale), ty + 115, scaleH(200, 'tableText', 100), '材料说明', 0, false);
                    dxf.drawTable(tx, ty, colWidths, rowHeights, rows, textH, 7);

                    const legItems = buildLegendItems(opts.legend);
                    if (legItems.length > 0) {
                        const sideGap = 240;
                        const sideX = tx + tableW + sideGap;
                        const sideW = rightLimit - sideX;
                        if (sideW >= 3600) {
                            const legCols = sideW >= 5400 ? 2 : 1;
                            drawLegendBoxDxf(sideX, frame.innerBottom, sideW, tableH, legCols, legItems, headerH, sideX + 180, textH);
                            return tableH + 360;
                        }
                        const stackW = Math.min(availW, Math.max(tableW, 10800));
                        const legCols = stackW >= 13200 ? 4 : stackW >= 9000 ? 3 : 2;
                        const legRows = Math.ceil(legItems.length / legCols);
                        const legHdrH = 360;
                        const legH = legHdrH + legRows * 420;
                        const legBot = ty + 420;
                        drawLegendBoxDxf(tx, legBot, stackW, legH, legCols, legItems, legHdrH, tx + Math.round(380 * wScale), textH);
                        return (legBot + legH + 360) - frame.innerBottom;
                    }
                    return tableH + 360;
                };

            /**
             * 在每张图纸正下方水平居中绘制「1F图纸名称  1:比例」及下划线 (白色 ACI 7)。
             */
            const snapArchScale = (raw) => {
                const std = [10, 15, 20, 25, 30, 40, 50, 60, 75, 80, 100, 120, 150, 200, 250, 300];
                if (!Number.isFinite(raw) || raw <= 0) return 50;
                let best = std[0], minDiff = Math.abs(raw - best);
                for (const s of std) {
                    const d = Math.abs(raw - s);
                    if (d < minDiff) { minDiff = d; best = s; }
                }
                return best;
            };
            const drawSheetBottomTitleDxf = (cx, y, sheetTitleText, rawScaleDenom) => {
                if (sheets[currentSheetIdx] && Number.isFinite(rawScaleDenom) && rawScaleDenom > 0) {
                    sheets[currentSheetIdx].sk = rawScaleDenom / 100;
                }
                const ratio = snapArchScale(rawScaleDenom);
                const floorName = curFloorCtx.floorName;
                const prefix = (floorName && !sheetTitleText.startsWith(floorName)) ? floorName : '';
                const fullText = `${prefix}${sheetTitleText}  1:${ratio}`;
                const h = scaleH(210, 'sheetTitle', 100);
                const textW = ChineseFontEngine.measureTextEm(fullText) * h;
                dxf.setActiveLayer('SHEET_FRAME');
                dxf.drawText(cx, y, h, fullText, 0, true);
                const lineY = y - h * 0.58;
                dxf.drawLine(cx - textW * 0.52, lineY, cx + textW * 0.52, lineY);
            };

            /**
             * 右上角指北针（样式：圆环 + 左黑右白燕尾指针 + 正下方 NORTH 与 北）
             */
            const drawDxfCompass = (cx, cy, r, deg = 0) => {
                const rad = (Number(deg) || 0) * Math.PI / 180;
                const ux = Math.sin(rad);
                const uy = Math.cos(rad);
                const px = Math.cos(rad);
                const py = -Math.sin(rad);
                const cr = r * 0.68;
                const ccy = cy + r * 0.22;
                const pt = (xLocal, yLocal) => [
                    cx + px * xLocal + ux * yLocal,
                    ccy + py * xLocal + uy * yLocal
                ];

                const tip = pt(0, cr * 1.24);
                const bl = pt(-cr * 0.60, -cr * 0.80);
                const br = pt(cr * 0.60, -cr * 0.80);
                const bc = pt(0, -cr * 0.52);
                const lw = Math.max(10, cr * 0.065);

                dxf.setActiveLayer('SHEET_FRAME');
                // 圆环：从指针顶部穿出点 (+4.2°) 顺时针绕至 (-4.2°)，避免圆弧穿过右半白底指针尖端内部
                const arcPts = [];
                const startDeg = 4.2, endDeg = 360 - 4.2, steps = 40;
                for (let i = 0; i <= steps; i++) {
                    const a = (startDeg + (endDeg - startDeg) * (i / steps)) * Math.PI / 180;
                    arcPts.push(pt(Math.sin(a) * cr, Math.cos(a) * cr));
                }
                dxf.drawWidePolyline(arcPts, arcPts.map(() => lw), false);

                // 左半燕尾针实心填充 (ACI 7：打印/PDF为实心黑，CAD黑底为实心白)
                dxf.drawSolidQuad([tip, bl, bc, bc], 7);

                // 燕尾针外轮廓与中轴线
                dxf.drawWidePolyline([tip, br, bc, bl], [lw, lw, lw, lw], true);
                dxf.drawWidePolyline([tip, bc], [lw, lw], false);

                // 圆环正下方绘制 NORTH 与 北
                const northH = Math.round(cr * 0.42);
                const cnH = Math.round(cr * 0.50);
                dxf.drawText(cx, ccy - cr * 1.50, northH, 'NORTH', 0, true);
                dxf.drawText(cx, ccy - cr * 2.18, cnH, '北', 0, true);
            };

            // 绘制门窗符号 (门框线 + 门扇 + 开启弧线 / 窗框线)，wallIdSet 为 null 时绘制全部
            const drawOpeningSymbolsDxf = (mx, my, wallIdSet) => {
                dxf.setActiveLayer('FLOOR_PLAN');
                for (const op of STATE.openings) {
                    if (wallIdSet && !wallIdSet.has(op.wallId)) continue;
                    const g = getOpeningSymbolGeometry(op);
                    if (!g) continue;
                    for (const j of g.jambs) dxf.drawLine(mx(j[0]), my(j[1]), mx(j[2]), my(j[3]));
                    for (const l of g.lines) dxf.drawLine(mx(l[0]), my(l[1]), mx(l[2]), my(l[3]));
                    if (g.leaf) dxf.drawLine(mx(g.leaf[0]), my(g.leaf[1]), mx(g.leaf[2]), my(g.leaf[3]));
                    if (g.arc.length >= 2) dxf.drawPolyline(g.arc.map(q => [mx(q[0]), my(q[1])]), false);
                    if (op.type === 'door' && op.isEntryDoor) {
                        const arr = getEntryDoorArrowGeom(op);
                        if (arr) {
                            dxf.drawSolidQuad([
                                [mx(arr.tip.x), my(arr.tip.y)],
                                [mx(arr.headL.x), my(arr.headL.y)],
                                [mx(arr.headR.x), my(arr.headR.y)],
                                [mx(arr.tip.x), my(arr.tip.y)]
                            ], 1);
                            dxf.drawSolidQuad([
                                [mx(arr.neckL.x), my(arr.neckL.y)],
                                [mx(arr.tailL.x), my(arr.tailL.y)],
                                [mx(arr.tailR.x), my(arr.tailR.y)],
                                [mx(arr.neckR.x), my(arr.neckR.y)]
                            ], 1);
                            if (arr.labelPos) {
                                dxf.drawText(mx(arr.labelPos.x), my(arr.labelPos.y), 95, '入户门', 0, true);
                            }
                        }
                    }
                }
            };

            // ---- 各图幅共用的绘制工具（fx/fy 为该图幅的 世界坐标 → 图纸坐标 映射） ----
            /** 闭合双线轮廓墙体；开启「墙壁实心」时先在 WALL_FILL 层绘制斜接实心墙段 */
            const drawWallPiecesDxf = (fx, fy, scale, wallIdSet = null) => {
                if (optSolidWalls) {
                    dxf.setActiveLayer('WALL_FILL');
                    for (const q of buildWallSolidQuads(wallIdSet)) {
                        dxf.drawSolidQuad(q.map(p => [fx(p.x), fy(p.y)]), 7);
                    }
                }
                dxf.setActiveLayer('FLOOR_PLAN');
                for (const loop of buildWallOutlinePolygons(wallIdSet)) {
                    dxf.drawPolyline(loop.map(p => [fx(p.x), fy(p.y)]), true);
                }
            };
            /** 门洞过门石（含编号）与压边条；开启「块着色」时归入 TILE_MS 分色描边 */
            const drawDoorFinishDxf = (dp, fx, fy, textH) => {
                if (dp.thresholdStone) {
                    const ts = dp.thresholdStone;
                    const pts = ts.pts.map(p => [fx(p.x), fy(p.y)]);
                    dxf.setActiveLayer(optColorTiles ? getTileSpecLayer('MS') : 'FLOOR_PLAN');
                    dxf.drawPolyline(pts, true);
                    const isVert = Math.abs(dp.uy) > Math.abs(dp.ux);
                    dxf.drawText(fx(ts.cx), fy(ts.cy), textH, ts.id, isVert ? 90 : 0, true);
                }
                if (dp.strips && dp.strips.length > 0) {
                    dxf.setActiveLayer('FLOOR_PLAN');
                    for (const st of dp.strips) dxf.drawLine(fx(st.p1.x), fy(st.p1.y), fx(st.p2.x), fy(st.p2.y));
                }
            };
            /** 外边缝（离墙伸缩缝）虚线边界 */
            const drawExpansionDxf = (r, fx, fy) => {
                if (r.cleared || !((Number(r.expansionGap) || 0) > 0)) return;
                dxf.setActiveLayer('FLOOR_PLAN');
                dxf.drawPolyline(getRoomPavingPolygonVerts(r).map(v => [fx(v.x), fy(v.y)]), true, 'DASHED');
            };
            /** 起铺点十字圆环靶标与文字标识 (ORIGIN_MARK 红色图层) */
            const drawOriginTargetDxf = (orig, fx, fy, rad, innerRad, arm, opt = {}) => {
                if (!orig || !Number.isFinite(orig.x) || !Number.isFinite(orig.y)) return;
                dxf.setActiveLayer('ORIGIN_MARK');
                const ox = fx(orig.x), oy = fy(orig.y);
                dxf.drawCircle(ox, oy, rad);
                dxf.drawCircle(ox, oy, innerRad);
                dxf.drawLine(ox - arm, oy, ox + arm, oy);
                dxf.drawLine(ox, oy - arm, ox, oy + arm);
                if (opt.label) {
                    const txtH = opt.txtH || Math.max(46, Math.round(rad * 0.85));
                    const dirX = opt.dirX ?? 1;
                    const dirY = opt.dirY ?? 1;
                    const em = ChineseFontEngine.measureTextEm(opt.label);
                    const lx = opt.labelX != null ? opt.labelX : (ox + dirX * (arm + em * txtH * 0.5 + txtH * 0.35));
                    const ly = opt.labelY != null ? opt.labelY : (oy + dirY * (rad + txtH * 0.55));
                    dxf.drawText(lx, ly, txtH, opt.label, 0, true);
                }
            };
            /** 外圈分段尺寸标注（CAD 原生 DIMENSION 实体）；txtHOf(图纸上的分段长度, it) 给出字高 */
            const drawDimItemsDxf = (items, fx, fy, txtHOf, textOf) => {
                dxf.setActiveLayer('FLOOR_PLAN');
                for (const it of items) {
                    const x1 = fx(it.p1.x), y1 = fy(it.p1.y);
                    const x2 = fx(it.p2.x), y2 = fy(it.p2.y);
                    const span = Math.hypot(x2 - x1, y2 - y1);
                    const tickHalf = Math.hypot(fx(it.e1b.x) - fx(it.e1a.x), fy(it.e1b.y) - fy(it.e1a.y)) * 0.5;
                    dxf.drawDimension(x1, y1, x2, y2, textOf(it), txtHOf(span, it), tickHalf);
                }
            };
            /** 外圈建筑尺寸文字（门洞段标「门xxx」、窗洞段标「窗xxx」） */
            const formatOuterDimLabel = (it) => {
                const val = uLen(it.mmVal != null ? it.mmVal : Math.round((it.value / SCALE_PIXELS_PER_METER) * 1000));
                if (it?.kind === 'opening-window') return `窗${val}`;
                if (it?.kind === 'opening-door') return `门${val}`;
                return val;
            };
            /** 砖块多边形（按每种瓷砖/地板规格编码独立分图层描边），返回其图纸坐标包围盒 */
            const drawTilePolysDxf = (t, fx, fy, tileLayer = 'TILE') => {
                dxf.setActiveLayer(tileLayer);
                let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
                for (const part of t.polys) {
                    dxf.drawPolyline(part.map(pt => {
                        const x = fx(pt.x), y = fy(pt.y);
                        if (x < minX) minX = x;
                        if (x > maxX) maxX = x;
                        if (y < minY) minY = y;
                        if (y > maxY) maxY = y;
                        return [x, y];
                    }), true);
                }
                const boxW = Math.max(10, maxX - minX), boxH = Math.max(10, maxY - minY);
                const isVert = boxH > boxW * 1.35;
                return {
                    minX, maxX, minY, maxY, cx: (minX + maxX) * 0.5, cy: (minY + maxY) * 0.5,
                    isVert, longSpan: isVert ? boxH : boxW, shortSpan: isVert ? boxW : boxH
                };
            };

            // 第二阶段：逐层生成各楼层图幅（每层占一行）
            let nextSheetIdx = 0;
            for (const fl of preparedFloors) {
                Object.assign(STATE, fl.snapshot);
                if (typeof Elevation !== 'undefined' && Elevation.resetCacheForExport) Elevation.resetCacheForExport();
                if (typeof Elevation !== 'undefined' && Elevation.ensureNumbers) Elevation.ensureNumbers();

                const { floorName, roomsForSheets, elevRooms, elevPlan, matHelpers, allItems, wholeStats, firstPrice, rowIdx } = fl;
                const { formatRoomMaterialDesc, getSkirtingSpecItems, getDoorAuxSpecItems, getFloorGroutAndAuxItems, getWallGroutAndAuxItems, accumulateSpecItem, wallZoneSpecBase, groutDesc } = matHelpers;
                const floorBaseIdx = nextSheetIdx;
                Object.assign(curFloorCtx, {
                    floorName,
                    wholeStats,
                    firstPrice,
                    roomsForSheets,
                    floorBaseIdx,
                    rowIdx,
                    colIdx: 0
                });

                const getRoomMaterialSpecItems = (r) => {
                    if (!r || r.cleared) return [];
                    const meta = getSpecMeta('floor', r.materialType, r.styleId);
                    const stObj = MaterialLib.getForRoom(r);
                    const code = r.specLabel || previewRoomSpecLabel(r);
                    const count = r.stats?.buyCount ?? (r.computedTiles ? r.computedTiles.length : 0);
                    const areaSqm = r.stats?.areaSqm ?? 0;
                    const rName = `${r.name || '未命名'}(地面)`;
                    return [{
                        code,
                        kind: meta.kind,
                        name: stObj?.name || meta.kind,
                        size: `${uSpec(r.tileW, r.tileH, '*')}${Units.cur()}`,
                        areaSqm,
                        area: `${areaSqm.toFixed(2)}m²`,
                        count,
                        qty: `${count}块`,
                        place: floorName ? `${floorName} ${rName}`.trim() : rName,
                        desc: formatRoomMaterialDesc(r)
                    }, ...getSkirtingSpecItems(r), ...getDoorAuxSpecItems(r), ...getFloorGroutAndAuxItems(r)];
                };

                let hMinX = Infinity, hMinY = Infinity, hMaxX = -Infinity, hMaxY = -Infinity;
                for (const v of STATE.vertices) {
                    if (v.x < hMinX) hMinX = v.x;
                    if (v.y < hMinY) hMinY = v.y;
                    if (v.x > hMaxX) hMaxX = v.x;
                    if (v.y > hMaxY) hMaxY = v.y;
                }
                if (!Number.isFinite(hMinX)) { hMinX = 0; hMinY = 0; hMaxX = 700; hMaxY = 500; }

                const collectFloorColorSpecs = (roomList) => {
                    const seen = new Set();
                    const list = [];
                    for (const rm of roomList) {
                        if (!rm || rm.cleared) continue;
                        const code = rm.specLabel || previewRoomSpecLabel(rm);
                        if (code && !seen.has(code)) {
                            seen.add(code);
                            const stObj = MaterialLib.getForRoom(rm);
                            const meta = getSpecMeta('floor', rm.materialType, rm.styleId);
                            list.push({
                                code,
                                name: formatLegendMaterialName('floor', meta.kind, rm.materialType, stObj?.name) || code,
                                layer: getTileSpecLayer(code)
                            });
                        }
                    }
                    const roomIds = new Set(roomList.map(rm => rm.id));
                    const msDoors = (STATE.computedDoors || []).filter(dp => dp.thresholdStone && (roomIds.has(dp.roomA?.id) || roomIds.has(dp.roomB?.id)));
                    if (msDoors.length > 0 && !seen.has('MS')) {
                        const msNames = [...new Set(msDoors.map(dp => String(dp.thresholdStone.styleName || '').trim()).filter(Boolean))];
                        const msLabel = msNames.length === 0
                            ? '过门石'
                            : (msNames.length === 1
                                ? formatLegendMaterialName('threshold', '过门石', 'tile', msNames[0])
                                : `${formatLegendMaterialName('threshold', '过门石', 'tile', msNames[0])}等`);
                        list.push({
                            code: 'MS',
                            name: msLabel,
                            layer: getTileSpecLayer('MS')
                        });
                    }
                    return list;
                };

                // =========================================================================
                // 本层第 1 张：全屋排砖施工总图
                // =========================================================================
                {
                    const sheetIdx = nextSheetIdx++;
                    hMinX = snapPxToMm(hMinX); hMinY = snapPxToMm(hMinY);
                    hMaxX = snapPxToMm(hMaxX); hMaxY = snapPxToMm(hMaxY);
                    const frame = drawCadSheetFrame(sheetIdx, '全屋铺贴排砖施工总图', '全屋墙体、起铺基准与排砖总览');
                    const floorColorSpecs = collectFloorColorSpecs(roomsForSheets);
                    const matH = drawMaterialSpecTableDxf(frame, allItems, {
                        includePlace: true,
                        legend: {
                            mode: 'floor',
                            sampleCode: floorColorSpecs[0]?.code || 'A1',
                            colorSpecs: floorColorSpecs
                        }
                    });
                const bottomReserve = Math.max(frame.tbH, matH);
                const bottomBase1 = frame.contentBottom + bottomReserve + 650;
                const viewW = frame.contentRight - frame.contentLeft;
                const viewH = frame.contentTop - bottomBase1;
                const wholeDimPlan = buildDimensionPlan({ outDist: 20, tierStep: 18, tickLen: 8.5 });
                let wFitMinX = hMinX - 70, wFitMaxX = hMaxX + 70, wFitMinY = hMinY - 70, wFitMaxY = hMaxY + 70;
                for (const dm of wholeDimPlan) {
                    for (const pt of [dm.p1, dm.p2, dm.e1a, dm.e1b, dm.e2a, dm.e2b]) {
                        if (!pt) continue;
                        if (pt.x - 20 < wFitMinX) wFitMinX = pt.x - 20;
                        if (pt.x + 20 > wFitMaxX) wFitMaxX = pt.x + 20;
                        if (pt.y - 20 < wFitMinY) wFitMinY = pt.y - 20;
                        if (pt.y + 20 > wFitMaxY) wFitMaxY = pt.y + 20;
                    }
                }
                const modelSpanX = Math.max(200, wFitMaxX - wFitMinX);
                const modelSpanY = Math.max(200, wFitMaxY - wFitMinY);
                const scale1 = Math.min(viewW / modelSpanX, viewH / modelSpanY);
                const unit1 = scale1 / mmPerPx;
                const cx1 = frame.ox + Math.round((frame.contentLeft + (viewW - modelSpanX * scale1) * 0.5 - frame.ox) / unit1) * unit1;
                const cy1 = frame.oy + Math.round((bottomBase1 + (viewH - modelSpanY * scale1) * 0.5 - frame.oy) / unit1) * unit1;
                const fx1 = px => cx1 + (px - wFitMinX) * scale1;
                const fy1 = py => cy1 + (wFitMaxY - py) * scale1;

                // 1.1 绘制全屋墙体与门窗符号 (FLOOR_PLAN 图层)
                drawWallPiecesDxf(fx1, fy1, scale1);
                drawOpeningSymbolsDxf(fx1, fy1, null);

                // 1.1b 绘制全屋门洞独立过门石与压边条 (FLOOR_PLAN 图层)
                for (const dp of (STATE.computedDoors || [])) drawDoorFinishDxf(dp, fx1, fy1, scaleH(42, 'tileMark', 20));

                // 1.2 绘制全屋各空间排砖
                for (const r of STATE.rooms) {
                    const verts = getRoomPolygonVerts(r);
                    if (verts.length < 3) continue;

                    drawExpansionDxf(r, fx1, fy1);

                    const vRectDxf = getRoomVirtualCenterRect(r);
                    const labelDxfX = fx1(vRectDxf.cx);
                    const labelDxfY = fy1(vRectDxf.cy);
                    const st = r.stats || { areaSqm: 0 };
                    const roomLabelStr = `${r.name} (${st.areaSqm.toFixed(2)}m²)`;
                    const roomLabelH = scaleH(125, 'roomLabel', 60);
                    const badgeHalfW = Math.max(520, ChineseFontEngine.measureTextEm(roomLabelStr) * roomLabelH * 0.55 + 140);
                    const badgeHalfH = Math.max(140, Math.round(roomLabelH * 1.44));
                    if (!r.cleared) {
                        const orad = Math.max(45, scale1 * 2.4);
                        const markPt = originMark(getRoomOriginWorld(r));
                        const mx1 = fx1(markPt.x), my1 = fy1(markPt.y);
                        const txtH1 = scaleH(Math.max(48, Math.min(84, Math.round(orad * 0.85))), 'originLabel', 26);
                        const nearBadge = Math.abs(mx1 - labelDxfX) < badgeHalfW && Math.abs(my1 - labelDxfY) < badgeHalfH + 140;
                        const orgOpts1 = nearBadge
                            ? { label: '起铺点', txtH: txtH1, labelX: mx1, labelY: labelDxfY - badgeHalfH - txtH1 * 0.75 }
                            : { label: '起铺点', txtH: txtH1, dirX: labelDxfX >= mx1 ? 1 : -1, dirY: labelDxfY >= my1 ? 1 : -1 };
                        drawOriginTargetDxf(markPt, fx1, fy1, orad, orad * 0.38, orad * 1.6, orgOpts1);
                    }

                    if (!r.cleared && r.computedTiles) {
                        const roomTileLayer = getRoomTileLayer(r);
                        const tileBoxes = r.computedTiles.map(t => ({ t, tb: drawTilePolysDxf(t, fx1, fy1, roomTileLayer) }));
                        if (optShowTileMarks) {
                            const fTile = fs('tileMark');
                            for (const { t, tb } of tileBoxes) {
                                if (Math.abs(tb.cx - labelDxfX) < badgeHalfW && Math.abs(tb.cy - labelDxfY) < badgeHalfH) continue;
                                const rawMid = { x: (tb.cx - cx1) / scale1 + wFitMinX, y: wFitMaxY - (tb.cy - cy1) / scale1 };
                                const insideTile = t.polys.some(poly => poly.length >= 3 && isPointInPolygon(rawMid, poly));
                                if (insideTile && tb.shortSpan >= 85 && tb.longSpan >= 110) {
                                    dxf.setActiveLayer(roomTileLayer);
                                    const idStr = String(t.id);
                                    const baseTxtH = Math.max(24, Math.min(76, Math.round(Math.min(tb.shortSpan * 0.34, (tb.longSpan * 0.72) / Math.max(idStr.length * 0.75, 1.8)))));
                                    const txtH = Math.max(18, Math.min(Math.round(tb.shortSpan * 0.72), Math.round(baseTxtH * fTile)));
                                    dxf.drawText(tb.cx, tb.cy, txtH, idStr, tb.isVert ? 90 : 0, true);
                                }
                            }
                        }
                    }

                    dxf.setActiveLayer('FLOOR_PLAN');
                    dxf.drawText(labelDxfX, labelDxfY, roomLabelH, roomLabelStr, 0, true);
                }

                // 1.3 双层外圈建筑尺寸标注（内道：结构分段含墙厚、墙垛与门窗洞口；外道：外围总尺寸）
                drawDimItemsDxf(wholeDimPlan, fx1, fy1,
                    (span, it) => it?.kind === 'outer-total' ? scaleH(98, 'dimension', 45) : scaleH(86, 'dimension', 40),
                    formatOuterDimLabel);

                // 1.4 右上角指北针与正下方居中图名+比例
                drawDxfCompass(frame.contentRight - 520, frame.contentTop - 520, 420, STATE.northAngle || 0);
                const capY1 = Math.max(frame.contentBottom + bottomReserve + 220, cy1 - 240);
                drawSheetBottomTitleDxf(cx1 + modelSpanX * scale1 * 0.5, capY1, '全屋铺贴排砖施工总图', 2000 / scale1);
            }

            // =========================================================================
            // 第 2 .. N+1 页 (Sheets 1 .. roomsForSheets.length)：单个空间的独立排砖详图
            // =========================================================================
            roomsForSheets.forEach((r) => {
                const sheetIdx = nextSheetIdx++;
                const st = r.stats || { areaSqm: 0, fullCount: 0, cutLargeCount: 0, cutSmallCount: 0, buyCount: 0, groutLengthM: 0, wasteRatePct: 0, pairedSaved: 0 };
                const patName = patternLabel(r.pattern);
                const matLabel = r.materialType === 'wood' ? '木地板' : '瓷砖';
                const frame = drawCadSheetFrame(sheetIdx, `【${r.name}】独立排砖施工详图`, `${matLabel} ${r.specLabel ? r.specLabel + ' ' : ''}${uSpec(r.tileW, r.tileH, 'x')}${Units.cur()} · ${patName} · 净面积 ${st.areaSqm.toFixed(2)}m²`, r);
                drawDxfCompass(frame.contentRight - 520, frame.contentTop - 520, 420, STATE.northAngle || 0);
                const roomColorSpecs = collectFloorColorSpecs([r]);
                const matH = drawMaterialSpecTableDxf(frame, getRoomMaterialSpecItems(r), {
                    legend: {
                        mode: 'floor',
                        sampleCode: roomColorSpecs[0]?.code || 'A1',
                        colorSpecs: roomColorSpecs
                    }
                });
                const bottomReserve = Math.max(frame.tbH, matH);

                const verts = getRoomInnerWallVerts(r);
                if (verts.length >= 3) {
                    let { minX: rMinX, minY: rMinY, maxX: rMaxX, maxY: rMaxY } =
                        pointsBounds(verts.concat(...(r.doorExtensionQuads || []).map(dq => dq.pts),
                            ...(r.mergeGroupRoomIds ? (r.computedTiles || []).flatMap(t => t.polys.flat()) : [])));
                    // 围合墙体向外扩出墙厚，保证墙体与外圈尺寸线都在图框内
                    const roomWallIds = getRoomWallIdSet(r);
                    let roomMaxTh = 12;
                    for (const w of STATE.walls) if (roomWallIds.has(w.id)) roomMaxTh = Math.max(roomMaxTh, w.thickness || 12);
                    rMinX = snapPxToMm(rMinX - roomMaxTh);
                    rMinY = snapPxToMm(rMinY - roomMaxTh);
                    rMaxX = snapPxToMm(rMaxX + roomMaxTh);
                    rMaxY = snapPxToMm(rMaxY + roomMaxTh);
                    const roomDimPlan = buildRoomOuterDimensionPlan(r, 16, 7.5);
                    let fitMinX = rMinX - 55, fitMaxX = rMaxX + 55, fitMinY = rMinY - 55, fitMaxY = rMaxY + 55;
                    for (const dm of roomDimPlan) {
                        for (const pt of [dm.p1, dm.p2, dm.e1a, dm.e1b, dm.e2a, dm.e2b]) {
                            if (!pt) continue;
                            if (pt.x - 20 < fitMinX) fitMinX = pt.x - 20;
                            if (pt.x + 20 > fitMaxX) fitMaxX = pt.x + 20;
                            if (pt.y - 20 < fitMinY) fitMinY = pt.y - 20;
                            if (pt.y + 20 > fitMaxY) fitMaxY = pt.y + 20;
                        }
                    }
                    const fitSpanX = Math.max(80, fitMaxX - fitMinX);
                    const fitSpanY = Math.max(80, fitMaxY - fitMinY);
                    const vLeft = frame.contentLeft + 400;
                    const vBottom = frame.contentBottom + bottomReserve + 650;
                    const vW = (frame.contentRight - vLeft) - 400;
                    const vH = (frame.contentTop - vBottom) - 300;
                    const rScale = Math.min(vW / fitSpanX, vH / fitSpanY);
                    const rUnit = rScale / mmPerPx;
                    const rCx = frame.ox + Math.round((vLeft + (vW - fitSpanX * rScale) * 0.5 - frame.ox) / rUnit) * rUnit;
                    const rCy = frame.oy + Math.round((vBottom + (vH - fitSpanY * rScale) * 0.5 - frame.oy) / rUnit) * rUnit;
                    const rfx = px => rCx + (px - fitMinX) * rScale;
                    const rfy = py => rCy + (fitMaxY - py) * rScale;

                    // 围合墙体 (闭合双线轮廓，门窗洞口处断开) 与门窗符号
                    drawWallPiecesDxf(rfx, rfy, rScale, roomWallIds);
                    drawOpeningSymbolsDxf(rfx, rfy, roomWallIds);

                    // 门洞延伸区轮廓与压边条
                    dxf.setActiveLayer('FLOOR_PLAN');
                    for (const dq of (r.doorExtensionQuads || [])) {
                        dxf.drawPolyline(dq.pts.map(p => [rfx(p.x), rfy(p.y)]), true);
                    }
                    for (const dp of (STATE.computedDoors || [])) {
                        if (dp.roomA?.id === r.id || dp.roomB?.id === r.id) drawDoorFinishDxf(dp, rfx, rfy, scaleH(54, 'tileMark', 24));
                    }

                    // 标注该空间双层外圈尺寸（内道：结构分段含墙厚、墙垛与门窗洞口；外道：外围总尺寸）
                    drawDimItemsDxf(roomDimPlan, rfx, rfy,
                        (span, dm) => dm?.kind === 'outer-total' ? scaleH(108, 'dimension', 48) : scaleH(94, 'dimension', 42),
                        formatOuterDimLabel);

                    drawExpansionDxf(r, rfx, rfy);
                    if (!r.cleared) {
                        const rMark = originMark(getRoomOriginWorld(r));
                        const rCenter = getRoomVirtualCenterRect(r);
                        const mxr = rfx(rMark.x), myr = rfy(rMark.y);
                        const rcx = rfx(rCenter.cx), rcy = rfy(rCenter.cy);
                        drawOriginTargetDxf(rMark, rfx, rfy, 140, 55, 220, {
                            label: '起铺点',
                            txtH: scaleH(105, 'originLabel', 40),
                            dirX: rcx >= mxr ? 1 : -1,
                            dirY: rcy >= myr ? 1 : -1
                        });
                    }

                    if (!r.cleared && r.computedTiles) {
                        const roomTileLayer = getRoomTileLayer(r);
                        const tileBoxes = r.computedTiles.map(t => ({ t, tb: drawTilePolysDxf(t, rfx, rfy, roomTileLayer) }));
                        if (optShowTileMarks) {
                            const fTile = fs('tileMark');
                            for (const { t, tb } of tileBoxes) {
                                if (tb.shortSpan >= 65 && tb.longSpan >= 85) {
                                    dxf.setActiveLayer(roomTileLayer);
                                    const idStr = String(t.id);
                                    const baseTxtH = Math.max(24, Math.min(105, Math.round(Math.min(tb.shortSpan * 0.35, (tb.longSpan * 0.74) / Math.max(idStr.length * 0.75, 1.8)))));
                                    const txtH = Math.max(18, Math.min(Math.round(tb.shortSpan * 0.72), Math.round(baseTxtH * fTile)));
                                    dxf.drawText(tb.cx, tb.cy, txtH, idStr, tb.isVert ? 90 : 0, true);
                                }
                            }
                        }
                    }

                    const capY = Math.max(frame.contentBottom + bottomReserve + 220, rCy - 220);
                    drawSheetBottomTitleDxf(rCx + fitSpanX * rScale * 0.5, capY, `【${r.name}】独立排砖施工详图`, 2000 / rScale);
                }
            });

            // =========================================================================
            // 墙面立面排砖详图（每个有墙面铺贴的空间自动按比例分页，附左侧分区索引图）
            // =========================================================================
            if (elevPlan.pages.length) {
                Elevation.drawElevationSheetsDxf({
                    dxf,
                    drawCadSheetFrame,
                    drawMaterialSpecTableDxf,
                    drawSheetBottomTitleDxf,
                    getSkirtingSpecItems,
                    getWallGroutAndAuxItems,
                    accumulateSpecItem,
                    wallZoneSpecBase,
                    groutDesc,
                    getTileSpecLayer,
                    showTileMarks: optShowTileMarks,
                    fontScales,
                    getRoomInnerWallVerts,
                    getRoomWallIdSet,
                    buildWallOutlinePolygons,
                    buildRoomOuterDimensionPlan,
                    drawWallPiecesDxf,
                    drawOpeningSymbolsDxf,
                    drawOriginTargetDxf,
                    drawDimItemsDxf,
                    pagePlans: elevPlan.pages,
                    startIdx: nextSheetIdx,
                    price: firstPrice
                }, elevRooms);
                nextSheetIdx += elevPlan.pages.length;
            }

            // =========================================================================
            // 本层最后 1 张：材料明细表
            // =========================================================================
            {
                const lastIdx = nextSheetIdx++;
                const frame = drawCadSheetFrame(lastIdx, '材料明细表', '全屋各空间铺贴材料明细清单');
                const tx = frame.contentLeft + 200;
                const tw = (frame.contentRight - frame.contentLeft) - 400;
                let curY = frame.contentTop - 160;

                const totalDataRows = Math.max(14, allItems.length);
                const availH = curY - (frame.contentBottom + frame.tbH + 300);
                const titleBoxH = 920;
                const headerRowH = 680;
                const dataRowH = Math.max(360, Math.min(540, Math.floor((availH - titleBoxH - headerRowH) / totalDataRows)));

                dxf.setActiveLayer('MATERIAL_TABLE');
                // 顶部「材料明细表」通栏标题框
                dxf.drawRect(tx, curY - titleBoxH, tx + tw, curY);
                const summaryTitleH = scaleH(320, 'tableText', 140);
                dxf.drawText(tx + 720, curY - titleBoxH * 0.5 - summaryTitleH * 0.36, summaryTitleH, '材料明细表', 0, false);
                curY -= titleBoxH;

                const colRatios = [0.05, 0.08, 0.08, 0.13, 0.14, 0.09, 0.08, 0.18, 0.17];
                const colWidths = colRatios.map(r => Math.round(tw * r));
                const headers = ['序号', '材料类别', '材料编码', '材料名称', '规格型号', '面积', '数量', '使用部位', '备注'];
                const rows = [headers];
                const rowHeights = [headerRowH];

                for (let i = 0; i < totalDataRows; i++) {
                    const it = allItems[i];
                    rowHeights.push(dataRowH);
                    rows.push([
                        String(i + 1).padStart(2, '0'),
                        it ? it.kind : '',
                        it ? it.code : '',
                        it ? it.name : '',
                        it ? it.size : '',
                        it ? (it.area || '') : '',
                        it ? (it.qty || '') : '',
                        it ? it.place : '',
                        it ? it.desc : ''
                    ]);
                }

                dxf.drawTable(tx, curY, colWidths, rowHeights, rows, scaleH(130, 'tableText', 70), 7);
            }
            }

            if (sheets[currentSheetIdx] && sheets[currentSheetIdx].entEnd == null) {
                sheets[currentSheetIdx].entEnd = dxf.entities.length;
                sheets[currentSheetIdx].dimEnd = dxf.dimensions.length;
            }

            // =========================================================================
            // 归一化各图幅至严格 1:1 真实毫米比例 (1 CAD 单位 = 1 mm)
            // 每层所有图幅排成独立一行；开启多层模式时在每行最前面绘制层名称标识
            // =========================================================================
            {
                const rn = v => Math.round(Number(v) * 100) / 100;
                let curX = 0, curRowY = 0, rowMaxH = 0;
                let prevRowIdx = null;
                const floorRowStats = new Map();
                for (let i = 0; i < sheets.length; i++) {
                    const sh = sheets[i];
                    if (!sh) continue;
                    if (prevRowIdx !== null && sh.floorRowIdx !== prevRowIdx) {
                        curRowY -= rowMaxH;
                        curX = 0;
                        rowMaxH = 0;
                    }
                    prevRowIdx = sh.floorRowIdx;

                    const sk = (Number.isFinite(sh.sk) && sh.sk > 0) ? sh.sk : 1;
                    const wMm = Math.round(sheetW * sk);
                    const hMm = Math.round(sheetH * sk);
                    const gapMm = Math.round(sheetGap * sk);
                    const newOx = Math.round(curX);
                    const newOy = Math.round(curRowY);
                    const ox0 = sh.ox, oy0 = sh.oy;
                    const tx = x => rn(newOx + (x - ox0) * sk);
                    const ty = y => rn(newOy + (y - oy0) * sk);
                    const ts = s => rn(s * sk);

                    const eEnd = sh.entEnd != null ? sh.entEnd : dxf.entities.length;
                    for (let ei = sh.entStart; ei < eEnd; ei++) {
                        const e = dxf.entities[ei];
                        if (!e) continue;
                        if (e.t === 'L') {
                            e.p = [tx(e.p[0]), ty(e.p[1]), tx(e.p[2]), ty(e.p[3])];
                        } else if (e.t === 'P' || e.t === 'S' || e.t === 'IMG') {
                            for (let j = 0; j < e.p.length; j += 2) {
                                e.p[j] = tx(e.p[j]);
                                e.p[j + 1] = ty(e.p[j + 1]);
                            }
                            if (e.w) e.w = e.w.map(ts);
                        } else if (e.t === 'IM') {
                            e.p = [tx(e.p[0]), ty(e.p[1])];
                            e.w = ts(e.w);
                            e.h = ts(e.h);
                        } else if (e.t === 'C') {
                            e.p = [tx(e.p[0]), ty(e.p[1])];
                            e.r = Math.max(0.5, ts(e.r));
                        } else if (e.t === 'T') {
                            e.p = [tx(e.p[0]), ty(e.p[1])];
                            e.h = Math.max(1, ts(e.h));
                        } else if (e.t === 'MT') {
                            e.p = [tx(e.p[0]), ty(e.p[1])];
                            e.h = Math.max(1, ts(e.h));
                            if (e.w) e.w = ts(e.w);
                        } else if (e.t === 'TB') {
                            e.p = [tx(e.p[0]), ty(e.p[1])];
                            e.cw = e.cw.map(ts);
                            e.rh = e.rh.map(ts);
                            e.th = Math.max(1, ts(e.th));
                            if (e.ch) e.ch = e.ch.map(row => row.map(v => Math.max(1, ts(v))));
                            if (e.pad) e.pad = e.pad.map(ts);
                            if (Array.isArray(e.bx)) e.bx = e.bx.map(row => row.map(b => b.map(ts)));
                            if (Array.isArray(e.lb)) e.lb = e.lb.map(row => row.map(l => (l ? Object.assign({}, l, { h: Math.max(0.5, ts(l.h)) }) : l)));
                        }
                    }

                    const dEnd = sh.dimEnd != null ? sh.dimEnd : dxf.dimensions.length;
                    for (let di = sh.dimStart; di < dEnd; di++) {
                        const d = dxf.dimensions[di];
                        if (!d) continue;
                        d.ax = tx(d.ax); d.ay = ty(d.ay);
                        d.bx = tx(d.bx); d.by = ty(d.by);
                        d.def1x = tx(d.def1x); d.def1y = ty(d.def1y);
                        d.def2x = tx(d.def2x); d.def2y = ty(d.def2y);
                        d.tcX = tx(d.tcX); d.tcY = ty(d.tcY);
                        d.tx = tx(d.tx); d.ty = ty(d.ty);
                        d.h = Math.max(1, ts(d.h));
                        if (d.lines) {
                            d.lines = d.lines.map(ln => [tx(ln[0]), ty(ln[1]), tx(ln[2]), ty(ln[3])]);
                        }
                    }

                    sh.area = [newOx, newOy, newOx + wMm, newOy + hMm];
                    const st = floorRowStats.get(sh.floorRowIdx) || { label: sh.floorLabel || '', yBottom: newOy, maxH: 0, firstGap: gapMm };
                    if (hMm > st.maxH) st.maxH = hMm;
                    floorRowStats.set(sh.floorRowIdx, st);

                    curX += wMm + gapMm;
                    rowMaxH = Math.max(rowMaxH, hMm + gapMm);
                }

                // 开启多层模式时，在每一层行首（X < 0）绘制层名称
                if (STATE.floorsEnabled && floorRowStats.size > 0) {
                    const statsArr = Array.from(floorRowStats.values());
                    const uniformGap = Math.max(...statsArr.map(s => Math.max(s.firstGap, Math.round(s.maxH * 0.08))));
                    dxf.setActiveLayer('SHEET_FRAME');
                    for (const st of statsArr) {
                        if (!st.label) continue;
                        const textH = Math.max(500, Math.round(st.maxH * 0.14));
                        const padX = Math.round(textH * 0.7);
                        const textW = ChineseFontEngine.measureTextEm(st.label) * textH;
                        const spanW = Math.max(Math.round(st.maxH * 0.26), Math.round(textW + padX * 2));
                        const rx = -uniformGap;
                        const lx = rx - spanW;
                        const cy = st.yBottom + st.maxH * 0.5;
                        dxf.drawText((lx + rx) * 0.5, cy, textH, st.label, 0, true);
                    }
                }
            }

            return {
                drawing: dxf,
                sheets: sheets.filter(Boolean),
                // PDF 纸张与图框图幅一致 (pt)
                paperPt: appliedFrame ? [appliedFrame.sheetWidthMm * 72 / 25.4, appliedFrame.sheetHeightMm * 72 / 25.4] : null,
                projectName,
                colorTiles: optColorTiles,
                totalSheets,
                roomSheetCount: totalRoomSheets,
                floorCount: preparedFloors.length
            };
            } finally {
                if (STATE.floorsEnabled) {
                    applyFloorSnapshotFields(origSnap);
                    STATE.selectedRoomId = origSelectedRoomId;
                    if (typeof Elevation !== 'undefined' && Elevation.resetCacheForExport) Elevation.resetCacheForExport();
                    recomputeAllRoomTiling();
                }
            }
        }

        const CAD_EXPORT_FONTS_KEY = 'tilecalc.cadExportFontScales.v2';
        const CAD_FONT_SCALE_DEFS = [
            { key: 'tileMark', label: '砖号与过门石编号', hint: '砖块编号、过门石 MS 编号', defaultPct: 100 },
            { key: 'dimension', label: '尺寸标注字号', hint: '建筑外圈、单空间与立面尺寸', defaultPct: 100 },
            { key: 'roomLabel', label: '空间与墙面名称', hint: '房间名面积、立面墙名与标注', defaultPct: 100 },
            { key: 'originLabel', label: '起铺点标注字号', hint: '地面与墙面「起铺点」文字', defaultPct: 100 },
            { key: 'tableText', label: '材料表与图例字号', hint: '材料说明、图例与明细表文字', defaultPct: 100 },
            { key: 'sheetTitle', label: '图名与标题字号', hint: '图名比例、索引与图框标题', defaultPct: 100 }
        ];
        function normalizeCadFontScales(raw = null) {
            const out = {};
            for (const d of CAD_FONT_SCALE_DEFS) {
                const v = raw && typeof raw === 'object' ? raw[d.key] : undefined;
                const n = (v === undefined || v === null || v === '') ? NaN : Number(v);
                out[d.key] = Number.isFinite(n) && n > 0 ? Math.max(50, Math.min(200, Math.round(n))) : d.defaultPct;
            }
            return out;
        }
        function loadCadFontScales() {
            try {
                const raw = StorageDB.getJSON(CAD_EXPORT_FONTS_KEY, null);
                if (raw) return normalizeCadFontScales(raw);
            } catch (e) { }
            return normalizeCadFontScales(null);
        }
        function saveCadFontScales(scales) {
            try { StorageDB.setJSON(CAD_EXPORT_FONTS_KEY, normalizeCadFontScales(scales)); } catch (e) { }
        }

        let g_exportBusy = false;
        let g_cadExportModalBound = false;
        let g_cadExportTargetFormat = 'dxf';
        let g_cadExportDisplayOpts = { showTileMarks: null, colorTiles: false, solidWalls: false, fontScales: null };
        const g_cadExportFrameOverrides = new Map();

        /** 导出公共流程：防重入、生成绘图描述、统一错误提示 */
        async function runCadExport(label, job, exportOpts = {}) {
            if (g_exportBusy) return;
            g_exportBusy = true;
            try {
                const res = await buildProjectDrawing(exportOpts);
                if (res) await job(res);
            } catch (err) {
                console.error(err);
                showToast(`${label} 导出失败：` + (err?.message || err));
            } finally {
                g_exportBusy = false;
            }
        }

        const getExportFileBase = (res) => {
            const pName = (res && res.projectName) ? res.projectName : getProjectName();
            if (res && res.floorCount > 1) return pName;
            return (STATE.floorsEnabled && getCurrentFloor()?.name) ? `${pName}_${getCurrentFloor().name}` : pName;
        };

        /** 导出 DXF (AutoCAD 2007 / AC1021)：由 acadrust 直接创建并写出 */
        function exportDxfDirectly(exportOpts = {}) {
            return runCadExport('DXF', async (res) => {
                showToast('正在生成 DXF…');
                const bytes = await writeCadDrawing(res.drawing, 'dxf');
                const base = getExportFileBase(res);
                const filename = `${base}_CAD多页排砖施工图.dxf`;
                const saveRes = await downloadBlob(new Blob([bytes], { type: 'application/dxf' }), filename);
                if (!saveRes || !saveRes.saved || saveRes.cancelled) return;
                showToast(res.floorCount > 1
                    ? `已导出多层 CAD 施工图：${saveRes.name || filename}（共 ${res.floorCount} 层、${res.totalSheets} 页）`
                    : `已导出多页 CAD 施工图：${saveRes.name || filename}（共 ${res.totalSheets} 页：总图 + ${res.roomSheetCount} 个空间详图 + 总结表）`);
            }, exportOpts);
        }

        /** 导出 DWG (AutoCAD 2007 / AC1021)：由 acadrust 直接创建并写出 */
        function exportDwgFromDxf(exportOpts = {}) {
            return runCadExport('DWG', async (res) => {
                showToast('正在生成 DWG…');
                const dwg = await writeCadDrawing(res.drawing, 'dwg');
                const sig = new TextDecoder().decode(dwg.subarray(0, 6));
                if (sig !== 'AC1021') throw new Error(`DWG 文件头校验失败：${sig}（应为 AC1021）`);
                const base = getExportFileBase(res);
                const filename = `${base}_CAD多页排砖施工图.dwg`;
                const saveRes = await downloadBlob(new Blob([dwg], { type: 'application/acad' }), filename);
                if (!saveRes || !saveRes.saved || saveRes.cancelled) return;
                showToast(res.floorCount > 1
                    ? `已导出多层 DWG（AutoCAD 2007 / ${sig}）：${saveRes.name || filename}（共 ${res.floorCount} 层、${res.totalSheets} 页）`
                    : `已导出 DWG（AutoCAD 2007 / ${sig}）：${saveRes.name || filename}`);
            }, exportOpts);
        }

        /**
         * 导出 PDF：acadrust 写出的同一份 DXF，经 DxfPdf 按图幅转换，每张图一页 A4 横向，
         * 嵌入 chinese-font.ttf 子集字体，中文可正常显示、可选中复制。
         */
        function exportPdfFromDxf(exportOpts = {}) {
            return runCadExport('PDF', async (res) => {
                if (!(await ChineseFontEngine.ensureLoaded())) throw new Error('中文字体加载失败');
                showToast(`正在生成 PDF（共 ${res.sheets.length} 页）…`);
                const dxfText = new TextDecoder().decode(await writeCadDrawing(res.drawing, 'dxf'));
                const layerLw = { SHEET_FRAME: 0.25, FLOOR_PLAN: 0.16, ORIGIN_MARK: 0.18, WALL_FILL: 0.16, MATERIAL_TABLE: 0.15, TILE: 0.08 };
                const darkColorLayers = ['ORIGIN_MARK'];
                for (const [lname] of res.drawing.layers.values()) {
                    const up = String(lname);
                    if (up.startsWith('TILE')) {
                        layerLw[up] = 0.08;
                        if (res.colorTiles) darkColorLayers.push(up);
                    }
                }
                // 图框图片：嵌入原图彩色位图；未带原图时其色块图层按原色输出
                const images = res.drawing.entities.filter(e => e.t === 'IMG').map(e => ({
                    area: [Math.min(e.p[0], e.p[2]), Math.min(e.p[1], e.p[3]), Math.max(e.p[0], e.p[2]), Math.max(e.p[1], e.p[3])], src: e.src
                }));
                const bytes = await DxfPdf.convert(dxfText, {
                    pages: res.sheets,
                    paper: res.paperPt || [841.89, 595.28],
                    color: 'mono',   // 墙体/标注/图框纯黑白，开启块着色时砖/地板/过门石图层按深色调分色描边
                    colorLayers: ['SHEET_FRAME_IMAGE'],
                    darkColorLayers,
                    imageLayers: ['SHEET_FRAME_IMAGE'],
                    images,
                    margin: 0,
                    font: ChineseFontEngine,
                    capRatio: 1,
                    title: `${res.projectName} · 排砖施工图`,
                    layerLw
                });
                const base = getExportFileBase(res);
                const filename = `${base}_排砖施工图.pdf`;
                const saveRes = await downloadBlob(new Blob([bytes], { type: 'application/pdf' }), filename);
                if (!saveRes || !saveRes.saved || saveRes.cancelled) return;
                showToast(`已导出 PDF：${saveRes.name || filename}（共 ${res.sheets.length} 页，每张图一页）`);
            }, { ...exportOpts, omitOuterFrame: true });
        }

        /** 打开 CAD / PDF 导出选项弹窗：可修改显示砖号/块着色/墙壁实心并覆盖图签表单字段 */
        async function openCadExportOptionsModal(defaultFormat = 'dxf') {
            const rawFloors = STATE.floorsEnabled
                ? STATE.floors.map(f => ({ snap: f.id === STATE.currentFloorId ? getSerializableState() : (f.snap || emptyFloorState()) }))
                : [{ snap: getSerializableState() }];
            const hasContent = rawFloors.some(f => (f.snap.walls && f.snap.walls.length > 0) || (f.snap.rooms && f.snap.rooms.length > 0));
            if (!hasContent) {
                showToast('当前画布无墙体或房间实体，请先绘制或导入户型');
                return;
            }
            const modal = $id('cad-export-options-modal');
            if (!modal) {
                if (defaultFormat === 'pdf') return exportPdfFromDxf();
                if (defaultFormat === 'dwg') return exportDwgFromDxf();
                return exportDxfDirectly();
            }

            g_cadExportTargetFormat = ['dxf', 'dwg', 'pdf'].includes(defaultFormat) ? defaultFormat : 'dxf';
            const fmtUpper = g_cadExportTargetFormat.toUpperCase();
            if ($id('exp-opt-title')) $id('exp-opt-title').textContent = `导出 ${fmtUpper} 图纸选项`;
            if ($id('btn-confirm-cad-export')) $id('btn-confirm-cad-export').textContent = `确认导出 ${fmtUpper}`;

            const chkMarks = $id('exp-opt-show-tile-marks');
            const chkColor = $id('exp-opt-color-tiles');
            const chkWall = $id('exp-opt-solid-walls');
            if (chkMarks) chkMarks.checked = g_cadExportDisplayOpts.showTileMarks != null ? g_cadExportDisplayOpts.showTileMarks : !!STATE.showTileMarks;
            if (chkColor) chkColor.checked = !!g_cadExportDisplayOpts.colorTiles;
            if (chkWall) chkWall.checked = !!g_cadExportDisplayOpts.solidWalls;

            const appliedFrame = await loadAppliedSheetFrame();
            const frameKey = appliedFrame ? `${appliedFrame.name || ''}|${appliedFrame.savedAt || ''}` : 'builtin';
            const savedOvs = g_cadExportFrameOverrides.get(frameKey) || {};
            const todayStr = formatLocalDate('.');

            const frameHint = $id('exp-opt-frame-hint');
            if (frameHint) {
                frameHint.textContent = appliedFrame
                    ? `${appliedFrame.name || '自定义图框'}${appliedFrame.sheetLabel ? ` (${appliedFrame.sheetLabel})` : ''}`
                    : '内置默认图签';
            }

            const fieldsGrid = $id('exp-opt-fields-grid');
            const mInfo = getMerchantInfo();
            const globalDefs = [
                { key: 'projectName', label: '工程名称', defaultValue: getProjectName() },
                { key: 'clientName', label: '客户名称', defaultValue: getClientName() },
                { key: 'date', label: '出图日期', defaultValue: todayStr },
                { key: 'merchantCompany', label: '商家 / 公司名称', defaultValue: mInfo.company },
                { key: 'merchantContact', label: '商家联系人', defaultValue: mInfo.contact },
                { key: 'merchantPhone', label: '联系电话', defaultValue: mInfo.phone },
                { key: 'merchantAddress', label: '商家地址', defaultValue: mInfo.address }
            ];
            const dynamicDefs = appliedFrame ? extractAppliedFrameEditableFields(appliedFrame) : [];

            const renderFieldInputs = (useDefaultsOnly = false) => {
                if (!fieldsGrid) return;
                fieldsGrid.replaceChildren();
                const allDefs = [
                    ...globalDefs.map(d => ({ ...d, isGlobal: true })),
                    ...dynamicDefs.map(d => ({ ...d, isGlobal: false }))
                ];
                for (const f of allDefs) {
                    const val = useDefaultsOnly
                        ? f.defaultValue
                        : (Object.prototype.hasOwnProperty.call(savedOvs, f.key) ? savedOvs[f.key] : f.defaultValue);
                    const wrap = document.createElement('label');
                    wrap.className = 'cad-exp-field' + (f.multiline ? ' is-full' : '');
                    const titleSpan = document.createElement('span');
                    titleSpan.className = 'font-medium text-slate-700 truncate';
                    titleSpan.textContent = f.label;
                    titleSpan.title = f.label;
                    const inp = document.createElement(f.multiline ? 'textarea' : 'input');
                    if (!f.multiline) inp.type = 'text';
                    else inp.rows = 2;
                    inp.className = 'ui-input w-full text-xs';
                    inp.value = val || '';
                    inp.placeholder = f.defaultValue ? `默认：${f.defaultValue.split('\n')[0]}` : `填写${f.label}`;
                    inp.dataset.expKey = f.key;
                    inp.dataset.expKind = f.isGlobal ? 'global' : f.kind;
                    inp.dataset.defaultVal = f.defaultValue || '';
                    wrap.append(titleSpan, inp);
                    fieldsGrid.appendChild(wrap);
                }
            };
            renderFieldInputs(false);

            // 高级选项（默认收起）：图纸各处字号缩放百分比
            const advBody = $id('cad-exp-adv-body');
            const advToggle = $id('btn-toggle-cad-exp-adv');
            const advResetBtn = $id('btn-reset-export-fonts');
            const fontsGrid = $id('exp-opt-fonts-grid');
            const setAdvExpanded = (expanded) => {
                if (advBody) advBody.classList.toggle('hidden', !expanded);
                if (advToggle) advToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
                if (advResetBtn) advResetBtn.classList.toggle('hidden', !expanded);
            };
            setAdvExpanded(false);

            const renderFontScaleInputs = (useDefaultsOnly = false) => {
                if (!fontsGrid) return;
                fontsGrid.replaceChildren();
                const curScales = useDefaultsOnly
                    ? normalizeCadFontScales(null)
                    : normalizeCadFontScales(g_cadExportDisplayOpts.fontScales || loadCadFontScales());
                for (const d of CAD_FONT_SCALE_DEFS) {
                    const row = document.createElement('label');
                    row.className = 'cad-exp-font-item';
                    const lbl = document.createElement('span');
                    lbl.className = 'cad-exp-font-label';
                    const strong = document.createElement('strong');
                    strong.textContent = d.label;
                    const small = document.createElement('small');
                    small.textContent = d.hint;
                    lbl.append(strong, small);

                    const ctrl = document.createElement('span');
                    ctrl.className = 'cad-exp-font-ctrl';
                    const inp = document.createElement('input');
                    inp.type = 'number';
                    inp.min = '50';
                    inp.max = '200';
                    inp.step = '5';
                    inp.className = 'ui-input';
                    inp.value = String(curScales[d.key]);
                    inp.dataset.fontScaleKey = d.key;
                    const unit = document.createElement('span');
                    unit.textContent = '%';
                    ctrl.append(inp, unit);

                    row.append(lbl, ctrl);
                    fontsGrid.appendChild(row);
                }
            };
            renderFontScaleInputs(false);

            const closeModal = () => modal.classList.add('hidden');
            if (!g_cadExportModalBound) {
                g_cadExportModalBound = true;
                $id('btn-close-cad-export')?.addEventListener('click', closeModal);
                $id('btn-cancel-cad-export')?.addEventListener('click', closeModal);
                modal.addEventListener('mousedown', e => { if (e.target === modal) closeModal(); });
                window.addEventListener('keydown', e => {
                    if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeModal();
                });
                $id('btn-toggle-cad-exp-adv')?.addEventListener('click', () => {
                    const isOpen = $id('btn-toggle-cad-exp-adv')?.getAttribute('aria-expanded') === 'true';
                    setAdvExpanded(!isOpen);
                });
                $id('btn-reset-export-fonts')?.addEventListener('click', () => {
                    const defaults = normalizeCadFontScales(null);
                    g_cadExportDisplayOpts.fontScales = defaults;
                    saveCadFontScales(defaults);
                    if (modal._renderExportFonts) modal._renderExportFonts(true);
                });
                $id('btn-reset-export-fields')?.addEventListener('click', () => {
                    const curKey = modal.dataset.frameKey || 'builtin';
                    g_cadExportFrameOverrides.delete(curKey);
                    if (modal._renderExportFields) modal._renderExportFields(true);
                });
                $id('btn-confirm-cad-export')?.addEventListener('click', () => {
                    const fmt = g_cadExportTargetFormat;
                    const showMarks = $id('exp-opt-show-tile-marks') ? $id('exp-opt-show-tile-marks').checked : !!STATE.showTileMarks;
                    const colorTiles = $id('exp-opt-color-tiles') ? $id('exp-opt-color-tiles').checked : false;
                    const solidWalls = $id('exp-opt-solid-walls') ? $id('exp-opt-solid-walls').checked : false;
                    const rawFontScales = {};
                    $id('exp-opt-fonts-grid')?.querySelectorAll('[data-font-scale-key]').forEach(el => {
                        rawFontScales[el.dataset.fontScaleKey] = el.value;
                    });
                    const fontScales = normalizeCadFontScales(rawFontScales);
                    saveCadFontScales(fontScales);
                    g_cadExportDisplayOpts = { showTileMarks: showMarks, colorTiles, solidWalls, fontScales };

                    const fieldOverrides = {};
                    const cellOverrides = {};
                    const entOverrides = {};
                    const ovCache = {};
                    const curKey = modal.dataset.frameKey || 'builtin';
                    $id('exp-opt-fields-grid')?.querySelectorAll('[data-exp-key]').forEach(el => {
                        const k = el.dataset.expKey;
                        const kind = el.dataset.expKind;
                        const v = el.value;
                        if (kind === 'global') {
                            fieldOverrides[k] = v;
                            if (v !== el.dataset.defaultVal) ovCache[k] = v;
                        } else if (kind === 'tb') {
                            cellOverrides[k] = v;
                            ovCache[k] = v;
                        } else if (kind === 'ent') {
                            entOverrides[k] = v;
                            ovCache[k] = v;
                        }
                    });
                    g_cadExportFrameOverrides.set(curKey, ovCache);
                    // 若用户在导出选项弹窗中填写或修改了商家信息，同步写回报价单商家信息缓存（IndexedDB）
                    try {
                        const prevM = StorageDB.getJSON(MERCHANT_INFO_KEY, {}) || {};
                        const nextM = Object.assign({}, prevM, {
                            company: fieldOverrides.merchantCompany != null ? String(fieldOverrides.merchantCompany).trim() : (prevM.company || ''),
                            contact: fieldOverrides.merchantContact != null ? String(fieldOverrides.merchantContact).trim() : (prevM.contact || ''),
                            phone: fieldOverrides.merchantPhone != null ? String(fieldOverrides.merchantPhone).trim() : (prevM.phone || ''),
                            address: fieldOverrides.merchantAddress != null ? String(fieldOverrides.merchantAddress).trim() : (prevM.address || '')
                        });
                        delete nextM.logoDataUrl;
                        StorageDB.setJSON(MERCHANT_INFO_KEY, nextM);
                    } catch (e) { }
                    closeModal();

                    const opts = { showTileMarks: showMarks, colorTiles, solidWalls, fontScales, fieldOverrides, cellOverrides, entOverrides };
                    if (fmt === 'pdf') exportPdfFromDxf(opts);
                    else if (fmt === 'dwg') exportDwgFromDxf(opts);
                    else exportDxfDirectly(opts);
                });
            }
            modal.dataset.frameKey = frameKey;
            modal._renderExportFields = renderFieldInputs;
            modal._renderExportFonts = renderFontScaleInputs;
            modal.classList.remove('hidden');
        }

        async function downloadBlob(blob, filename, opts = {}) {
            if (typeof DesktopHost !== 'undefined') {
                return await DesktopHost.saveBlob(blob, filename, opts);
            }
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 400);
            return { saved: true, cancelled: false, path: null, name: filename, revision: null };
        }

        /** 按需加载第三方脚本（同一地址只加载一次；file:// 下同样可用） */
        const _scriptLoads = new Map();
        function loadScriptOnce(src) {
            if (!_scriptLoads.has(src)) {
                _scriptLoads.set(src, new Promise((resolve, reject) => {
                    const el = document.createElement('script');
                    el.src = src;
                    el.onload = () => resolve();
                    el.onerror = () => { _scriptLoads.delete(src); reject(new Error('加载失败: ' + src)); };
                    document.head.appendChild(el);
                }));
            }
            return _scriptLoads.get(src);
        }

        /**
         * 导出算量表 (.xlsx)：表格结构与 CAD 末页「材料明细表」一致
         * （通栏标题 + 序号 / 材料类别 / 材料编码 / 材料名称 / 规格型号 / 面积 / 数量 / 使用部位 / 备注），
         * 使用 ExcelJS (assets/vendor/exceljs) 生成，带边框、表头底色、列宽与 A4 横向打印设置。
         */
        async function exportCalculationXLSX() {
            if (STATE.rooms.length === 0 && STATE.walls.length === 0) {
                showToast('当前画布无墙体或房间实体，请先绘制或导入户型');
                return;
            }
            try {
                await loadScriptOnce('assets/vendor/exceljs/exceljs.min.js');
            } catch (err) {
                showToast('无法加载 Excel 组件 (assets/vendor/exceljs)');
                return;
            }
            recomputeAllRoomTiling();
            const floorName = STATE.floorsEnabled ? (getCurrentFloor()?.name || '1F') : '';
            const items = createMaterialSpecHelpers(floorName).getAllMaterialSpecItems();
            const projectName = getProjectName();
            const clientName = getClientName();

            const wb = new ExcelJS.Workbook();
            wb.creator = 'EasyTile';
            wb.created = new Date();
            const ws = wb.addWorksheet('材料明细表', {
                pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, horizontalCentered: true,
                    margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 } },
                views: [{ state: 'frozen', ySplit: 3, showGridLines: false }]
            });
            // 列宽按 CAD 末页列比例 [0.05,0.08,0.08,0.13,0.14,0.09,0.08,0.18,0.17] 换算
            const headers = ['序号', '材料类别', '材料编码', '材料名称', '规格型号', '面积', '数量', '使用部位', '备注'];
            const widths = [7, 12, 12, 18, 20, 14, 11, 30, 32];
            ws.columns = widths.map(w => ({ width: w }));
            const FONT = '等线';
            const thin = { style: 'thin', color: { argb: 'FF7F8794' } };
            const border = { top: thin, left: thin, bottom: thin, right: thin };
            const nCol = headers.length;

            // 第 1 行：通栏标题「材料明细表」（与 CAD 一致左对齐）
            ws.mergeCells(1, 1, 1, nCol);
            const tCell = ws.getCell(1, 1);
            tCell.value = '材料明细表';
            tCell.font = { name: FONT, size: 16, bold: true, color: { argb: 'FF1F2937' } };
            tCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
            ws.getRow(1).height = 34;
            for (let c = 1; c <= nCol; c++) ws.getCell(1, c).border = { top: { style: 'medium', color: { argb: 'FF374151' } }, left: c === 1 ? thin : undefined, right: c === nCol ? thin : undefined, bottom: thin };

            // 第 2 行：工程信息
            ws.mergeCells(2, 1, 2, nCol);
            const iCell = ws.getCell(2, 1);
            iCell.value = `工程名称：${projectName}${clientName ? '　客户名称：' + clientName : ''}${floorName ? '　楼层：' + floorName : ''}　导出时间：${new Date().toLocaleString('zh-CN')}`;
            iCell.font = { name: FONT, size: 10, color: { argb: 'FF4B5563' } };
            iCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
            ws.getRow(2).height = 20;
            for (let c = 1; c <= nCol; c++) ws.getCell(2, c).border = { left: c === 1 ? thin : undefined, right: c === nCol ? thin : undefined, bottom: thin };

            // 第 3 行：表头
            const hRow = ws.getRow(3);
            hRow.values = headers;
            hRow.height = 24;
            hRow.eachCell(cell => {
                cell.font = { name: FONT, size: 11, bold: true, color: { argb: 'FF111827' } };
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E9F0' } };
                cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
                cell.border = border;
            });

            const wrapCols = new Set([4, 5, 8, 9]);
            const leftCols = new Set([4, 8, 9]);
            items.forEach((it, i) => {
                const row = ws.addRow([
                    String(i + 1).padStart(2, '0'),
                    it.kind || '',
                    it.code || '',
                    it.name || '',
                    it.size || '',
                    it.area || '',
                    it.qty || '',
                    it.place || '',
                    it.desc || ''
                ]);
                const longest = Math.max(String(it.place || '').length / 15, String(it.desc || '').length / 16, 1);
                row.height = Math.max(22, Math.ceil(longest) * 16 + 6);
                row.eachCell({ includeEmpty: true }, (cell, c) => {
                    cell.font = { name: FONT, size: 10, color: { argb: 'FF1F2937' }, bold: c === 3 };
                    cell.alignment = { vertical: 'middle', horizontal: leftCols.has(c) ? 'left' : 'center', wrapText: wrapCols.has(c) };
                    cell.border = border;
                    if (i % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F8FA' } };
                });
            });
            if (!items.length) {
                const row = ws.addRow(['', '', '', '暂无材料', '', '', '', '', '']);
                row.eachCell({ includeEmpty: true }, cell => { cell.border = border; cell.font = { name: FONT, size: 10, color: { argb: 'FF9CA3AF' } }; cell.alignment = { horizontal: 'center' }; });
            }
            ws.pageSetup.printTitlesRow = '3:3';

            const buf = await wb.xlsx.writeBuffer();
            const saveRes = await downloadBlob(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${getExportBaseName()}_材料明细表.xlsx`);
            if (!saveRes || !saveRes.saved || saveRes.cancelled) return;
            showToast(`已导出 Excel 材料明细表（${items.length} 项）`);
        }

        let g_imgExportModalBound = false;
        let g_imgExportOpts = {
            showTileMarks: null,
            showDimensions: true,
            showRoomLabels: true,
            showOrigin: true,
            resolution: 3000
        };

        /**
         * 渲染无图框高清彩图 Canvas（白底、纯彩铺贴效果、四周边缘建筑尺寸标注、右上角指北针图示、底部空间名称与材料图示）。
         * opts.scope: 'all'（全屋）或单个 roomId。
         */
        function renderColorFloorPlanJPGCanvas(opts = {}) {
            recomputeAllRoomTiling();

            const showTileMarks = opts.showTileMarks != null ? !!opts.showTileMarks : !!STATE.showTileMarks;
            const showDimensions = opts.showDimensions !== false;
            const showRoomLabels = opts.showRoomLabels !== false;
            const showOrigin = opts.showOrigin !== false;
            const targetLongEdge = Math.max(1200, Math.min(6000, Number(opts.resolution) || 3000));

            const allRooms = STATE.rooms || [];
            const singleRoom = (opts.scope && opts.scope !== 'all')
                ? (allRooms.find(r => r.id === opts.scope) || null)
                : null;
            const exportRooms = singleRoom ? [singleRoom] : allRooms.slice();
            const isWholeHouse = !singleRoom;

            const roomFilter = isWholeHouse ? null : new Set([singleRoom.id]);
            const wallFilter = isWholeHouse ? null : getRoomWallIdSet(singleRoom);

            // 1. 构建四周外圈尺寸标注方案（单空间用独立双层标注，全屋用外围双层标注）
            let dimPlan = [];
            if (showDimensions) {
                if (!isWholeHouse) {
                    dimPlan = buildRoomOuterDimensionPlan(singleRoom, 22, 9.5, 20);
                } else {
                    dimPlan = buildDimensionPlan({ outDist: 26, tickLen: 10.5, tierStep: 20 });
                }
            }

            // 2. 收集底部图示项（当前导出范围内用到的地面花色、过门石、压边条、起铺点、外边缝）
            const legendItems = [];
            const seenMatKeys = new Set();
            let hasAnyGap = false;
            let hasAnyOrigin = false;
            for (const r of exportRooms) {
                if (r.cleared) continue;
                hasAnyOrigin = true;
                if ((Number(r.expansionGap) || 0) > 0) hasAnyGap = true;
                const stObj = MaterialLib.getForRoom(r);
                const meta = getSpecMeta('floor', r.materialType, r.styleId);
                const key = `${r.materialType}|${meta.kind}|${r.styleId || stObj.id || ''}|${r.tileW}x${r.tileH}`;
                if (!seenMatKeys.has(key)) {
                    seenMatKeys.add(key);
                    const code = r.specLabel ? `${r.specLabel} ` : '';
                    const matLabel = formatLegendMaterialName('floor', meta.kind, r.materialType, stObj.name);
                    legendItems.push({
                        kind: 'mat',
                        styleObj: stObj,
                        materialType: r.materialType,
                        label: `${code}${matLabel} ${uSpec(r.tileW, r.tileH)}${Units.cur()}`
                    });
                }
            }
            const seenTsStyles = new Set();
            let hasStrip = false;
            const stripLabels = new Set();
            for (const dp of (STATE.computedDoors || [])) {
                if (wallFilter && !wallFilter.has(dp.wallId)) continue;
                if (dp.thresholdStone) {
                    const ts = dp.thresholdStone;
                    const tk = String(ts.styleName || '').trim();
                    const tsLabel = formatLegendMaterialName('threshold', '过门石', 'tile', tk);
                    if (!seenTsStyles.has(tsLabel)) {
                        seenTsStyles.add(tsLabel);
                        legendItems.push({ kind: 'threshold', ts, label: `MS ${tsLabel}` });
                    }
                }
                if (dp.strips && dp.strips.length > 0) {
                    hasStrip = true;
                    dp.strips.forEach(s => { if (s && s.typeLabel) stripLabels.add(s.typeLabel); });
                }
            }
            if (hasStrip) {
                const stripArr = [...stripLabels];
                const stripText = stripArr.length === 1 && !stripArr[0].includes('压边条')
                    ? `压边条·${stripArr[0]}`
                    : (stripArr.length === 1 ? stripArr[0] : '金属压边条');
                legendItems.push({ kind: 'strip', label: stripText });
            }
            if (showOrigin && hasAnyOrigin) legendItems.push({ kind: 'origin', label: '起铺点' });
            if (hasAnyGap) legendItems.push({ kind: 'gap', label: '离墙外边缝' });

            // 3. 计算精确世界包围盒（涵括墙厚、门扇开启弧、门洞延伸、以及全部外圈尺寸线与文字，确保四边零裁切）
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            const expand = (x, y, pad = 0) => {
                if (!Number.isFinite(x) || !Number.isFinite(y)) return;
                if (x - pad < minX) minX = x - pad;
                if (x + pad > maxX) maxX = x + pad;
                if (y - pad < minY) minY = y - pad;
                if (y + pad > maxY) maxY = y + pad;
            };

            const exportWalls = wallFilter ? STATE.walls.filter(w => wallFilter.has(w.id)) : STATE.walls;
            for (const w of exportWalls) {
                const v1 = getVertex(w.v1), v2 = getVertex(w.v2);
                if (!v1 || !v2) continue;
                const halfTh = (w.thickness || 12) * 0.5;
                expand(v1.x, v1.y, halfTh);
                expand(v2.x, v2.y, halfTh);
            }
            for (const r of exportRooms) {
                for (const pt of getRoomPolygonVerts(r)) expand(pt.x, pt.y, 4);
                for (const dq of (r.doorExtensionQuads || [])) {
                    for (const pt of (dq.pts || [])) expand(pt.x, pt.y, 2);
                }
            }
            for (const op of STATE.openings) {
                if (wallFilter && !wallFilter.has(op.wallId)) continue;
                const w = getWall(op.wallId);
                if (!w) continue;
                const v1 = getVertex(w.v1), v2 = getVertex(w.v2);
                if (!v1 || !v2) continue;
                const posX = v1.x + op.t * (v2.x - v1.x);
                const posY = v1.y + op.t * (v2.y - v1.y);
                if (op.type === 'door' && STATE.showDoorLeaves !== false) {
                    const width = op.width || 45;
                    const len = Math.hypot(v2.x - v1.x, v2.y - v1.y) || 1;
                    const ux = (v2.x - v1.x) / len, uy = (v2.y - v1.y) / len;
                    const flipSign = op.flip ? -1 : 1;
                    const nx = -uy * flipSign, ny = ux * flipSign;
                    const hx = posX + (op.hinge ? 0.5 : -0.5) * width * ux;
                    const hy = posY + (op.hinge ? 0.5 : -0.5) * width * uy;
                    expand(hx + nx * width, hy + ny * width, 4);
                    expand(posX + nx * width * 0.72, posY + ny * width * 0.72, 4);
                }
                if (op.type === 'door' && op.isEntryDoor) {
                    const arr = getEntryDoorArrowGeom(op);
                    if (arr) {
                        for (const pt of arr.poly) expand(pt.x, pt.y, 6);
                        if (arr.labelPos) expand(arr.labelPos.x, arr.labelPos.y, 14);
                    }
                }
            }
            for (const dm of dimPlan) {
                for (const pt of [dm.p1, dm.p2, dm.e1a, dm.e1b, dm.e2a, dm.e2b]) {
                    if (pt) expand(pt.x, pt.y, 4);
                }
                if (dm.tx != null && dm.ty != null) expand(dm.tx, dm.ty, 16);
            }
            if (!Number.isFinite(minX)) {
                const fb = pointsBounds(STATE.vertices);
                minX = fb.minX; minY = fb.minY; maxX = fb.maxX; maxY = fb.maxY;
            }

            const rawW = Math.max(80, maxX - minX);
            const rawH = Math.max(80, maxY - minY);
            const padWorld = Math.max(18, Math.min(44, Math.max(rawW, rawH) * 0.04));
            minX -= padWorld; maxX += padWorld;
            minY -= padWorld; maxY += padWorld;
            const modelW = maxX - minX;
            const modelH = maxY - minY;

            // 4. 按实际宽高比生成高清白底画布（顶部留出右上角指北针安全区，底部留出空间名称 + 图示区）
            const uiUnit = targetLongEdge / 3000;
            const marginPx = Math.round(70 * uiUnit);
            const topHeaderPad = Math.round(40 * uiUnit);
            const compassAreaRight = Math.round(135 * uiUnit);
            const bottomTitleH = Math.round(78 * uiUnit);
            const estLegendRows = legendItems.length ? Math.min(3, Math.ceil(legendItems.length / 4)) : 0;
            const bottomLegendH = estLegendRows > 0 ? Math.round((estLegendRows * 46 + 24) * uiUnit) : 0;
            const bottomAreaH = bottomTitleH + bottomLegendH + Math.round(20 * uiUnit);

            let W, H;
            if (modelW >= modelH) {
                W = targetLongEdge;
                const drawWAvail = W - marginPx * 2 - compassAreaRight * 0.5;
                const drawHNeed = Math.round(drawWAvail * (modelH / modelW));
                H = Math.max(Math.round(targetLongEdge * 0.45), drawHNeed + marginPx * 2 + topHeaderPad + bottomAreaH);
            } else {
                H = targetLongEdge;
                const drawHAvail = Math.max(400, H - marginPx * 2 - topHeaderPad - bottomAreaH);
                const drawWNeed = Math.round(drawHAvail * (modelW / modelH));
                W = Math.max(Math.round(targetLongEdge * 0.52), drawWNeed + marginPx * 2 + compassAreaRight);
            }

            const exportCanvas = document.createElement('canvas');
            exportCanvas.width = W;
            exportCanvas.height = H;
            const c = exportCanvas.getContext('2d');
            c.imageSmoothingEnabled = true;
            c.imageSmoothingQuality = 'high';

            c.fillStyle = '#FFFFFF';
            c.fillRect(0, 0, W, H);

            const drawLeft = marginPx;
            const drawTop = marginPx + topHeaderPad;
            const drawRight = W - marginPx - Math.round(compassAreaRight * 0.55);
            const drawBottom = H - marginPx - bottomAreaH;
            const drawW = Math.max(200, drawRight - drawLeft);
            const drawH = Math.max(200, drawBottom - drawTop);

            const autoScale = Math.min(drawW / modelW, drawH / modelH);
            const offsetX = drawLeft + (drawW - modelW * autoScale) * 0.5 - minX * autoScale;
            const offsetY = drawTop + (drawH - modelH * autoScale) * 0.5 - minY * autoScale;

            c.save();
            c.translate(offsetX, offsetY);
            c.scale(autoScale, autoScale);

            // 5. 临时切换渲染标志：以纯彩色材质/花色贴图与真实砖缝绘制（不让砖号模式冲淡过门石与材质色）
            const prevShowPaving = STATE.showPaving;
            const prevShowMarks = STATE.showTileMarks;
            const prevShowRoomLabels = STATE.showRoomLabels;
            STATE.showPaving = true;
            STATE.showTileMarks = false;
            STATE.showRoomLabels = showRoomLabels;

            try {
                // 5.1 彩色铺贴与无底色块的空间名称
                renderRoomsAndPaving(c, roomFilter);

                // 5.2 墙体与门窗（全彩过门石 / 门洞延伸铺贴 / 压边条）
                renderWalls(c, wallFilter);
                renderOpenings(c, wallFilter);

                // 5.3 可选：高对比度砖号与过门石编号（带白底描边，浅砖深木均清晰可读）
                if (showTileMarks) {
                    for (const room of exportRooms) {
                        if (room.cleared || !room.computedTiles) continue;
                        const vRect = showRoomLabels ? getRoomVirtualCenterRect(room) : null;
                        const avoidHalfW = vRect ? Math.min(54, vRect.w * 0.30) : 0;
                        const avoidHalfH = vRect ? Math.min(30, vRect.h * 0.24) : 0;

                        for (const tile of room.computedTiles) {
                            const [pMinX, pMinY, pMaxX, pMaxY] = getPolysBounds(tile.polys);
                            const tcx = (pMinX + pMaxX) * 0.5;
                            const tcy = (pMinY + pMaxY) * 0.5;
                            if (vRect && Math.abs(tcx - vRect.cx) < avoidHalfW && Math.abs(tcy - vRect.cy) < avoidHalfH) {
                                continue;
                            }
                            const boxW = Math.max(2, pMaxX - pMinX);
                            const boxH = Math.max(2, pMaxY - pMinY);
                            const isVert = boxH > boxW * 1.35;
                            const longSpan = isVert ? boxH : boxW;
                            const shortSpan = isVert ? boxW : boxH;
                            if (shortSpan * autoScale < 16 || longSpan * autoScale < 22) continue;

                            c.save();
                            c.translate(tcx, tcy);
                            if (isVert) c.rotate(-Math.PI / 2);
                            c.textAlign = 'center';
                            c.textBaseline = 'middle';
                            const idStr = String(tile.id);
                            const fPx = Math.min(
                                18 / autoScale,
                                shortSpan * 0.34,
                                (longSpan * 0.74) / Math.max(idStr.length * 0.72, 1.8)
                            );
                            c.font = `700 ${fPx}px ${CANVAS_FONT_MONO}`;
                            c.lineJoin = 'round';
                            c.lineWidth = Math.max(fPx * 0.26, 2.4 / autoScale);
                            c.strokeStyle = 'rgba(255, 255, 255, 0.88)';
                            c.strokeText(idStr, 0, 0);
                            c.fillStyle = '#334155';
                            c.fillText(idStr, 0, 0);
                            c.restore();
                        }
                    }

                    // 过门石编号 (MS-1 等)
                    for (const dp of (STATE.computedDoors || [])) {
                        if (!dp.thresholdStone) continue;
                        if (wallFilter && !wallFilter.has(dp.wallId)) continue;
                        const ts = dp.thresholdStone;
                        const w = getWall(dp.wallId);
                        const th = w ? (w.thickness || 12) : 12;
                        c.save();
                        c.translate(ts.cx, ts.cy);
                        c.rotate(ts.angle || 0);
                        const fPx = Math.min(16 / autoScale, Math.max(4.5, th * 0.48));
                        c.font = `700 ${fPx}px ${CANVAS_FONT_MONO}`;
                        c.textAlign = 'center';
                        c.textBaseline = 'middle';
                        c.lineJoin = 'round';
                        c.lineWidth = Math.max(fPx * 0.28, 2.2 / autoScale);
                        c.strokeStyle = 'rgba(255, 255, 255, 0.92)';
                        c.strokeText(ts.id, 0, 0);
                        c.fillStyle = '#0f172a';
                        c.fillText(ts.id, 0, 0);
                        c.restore();
                    }
                }

                // 5.4 可选：红色起铺点十字靶标
                if (showOrigin) {
                    const drawnMasters = new Set();
                    const r = Math.min(8, Math.max(3.5, 11 / autoScale));
                    const arm = r * 1.7;
                    for (const room of exportRooms) {
                        if (room.cleared || getRoomPolygonVerts(room).length < 3) continue;
                        const master = getOriginMasterRoom(room);
                        if (roomFilter && !roomFilter.has(master.id)) continue;
                        if (drawnMasters.has(master.id)) continue;
                        drawnMasters.add(master.id);
                        const orig = originMark(getRoomOriginWorld(master));
                        if (!orig || !Number.isFinite(orig.x) || !Number.isFinite(orig.y)) continue;
                        c.save();
                        c.fillStyle = 'rgba(244, 63, 94, 0.25)';
                        c.strokeStyle = '#e11d48';
                        c.lineWidth = Math.max(1.2, 2.4 / autoScale);
                        c.beginPath();
                        c.arc(orig.x, orig.y, r, 0, Math.PI * 2);
                        c.fill();
                        c.stroke();
                        c.beginPath();
                        c.moveTo(orig.x - arm, orig.y);
                        c.lineTo(orig.x + arm, orig.y);
                        c.moveTo(orig.x, orig.y - arm);
                        c.lineTo(orig.x, orig.y + arm);
                        c.stroke();
                        c.restore();
                    }
                }

                // 5.5 可选：四周边缘建筑尺寸标记（清晰锐利，支持 mm/cm/m 单位自适应）
                if (showDimensions && dimPlan.length > 0) {
                    const lw = Math.max(0.85, 2.2 / autoScale);
                    const tickR = Math.max(2.6, 6.5 / autoScale);
                    c.save();
                    c.lineCap = 'square';
                    c.lineJoin = 'miter';
                    for (const item of dimPlan) {
                        c.strokeStyle = 'rgba(255, 255, 255, 0.9)';
                        c.lineWidth = lw * 2.4;
                        c.beginPath();
                        c.moveTo(item.e1a.x, item.e1a.y); c.lineTo(item.e1b.x, item.e1b.y);
                        c.moveTo(item.e2a.x, item.e2a.y); c.lineTo(item.e2b.x, item.e2b.y);
                        c.moveTo(item.p1.x, item.p1.y); c.lineTo(item.p2.x, item.p2.y);
                        c.stroke();

                        c.strokeStyle = '#334155';
                        c.lineWidth = lw;
                        c.beginPath();
                        c.moveTo(item.e1a.x, item.e1a.y); c.lineTo(item.e1b.x, item.e1b.y);
                        c.moveTo(item.e2a.x, item.e2a.y); c.lineTo(item.e2b.x, item.e2b.y);
                        c.moveTo(item.p1.x, item.p1.y); c.lineTo(item.p2.x, item.p2.y);
                        c.stroke();

                        c.lineWidth = lw * 1.25;
                        drawIsoTick(c, item.p1.x, item.p1.y, tickR);
                        drawIsoTick(c, item.p2.x, item.p2.y, tickR);

                        const baseVal = item.mmVal != null ? Units.dim(item.mmVal) : item.text;
                        const dimLabel = item.kind === 'opening-window'
                            ? `窗${baseVal}`
                            : (item.kind === 'opening-door' ? `门${baseVal}` : baseVal);
                        const spanPx = item.segSpan || item.value || 80;
                        c.save();
                        c.translate(item.tx, item.ty);
                        if (item.vertical) c.rotate(-Math.PI / 2);
                        const idealPx = Math.min(26 / autoScale, 12.5);
                        const fitPx = Math.max(5.5, (spanPx * 0.88) / Math.max(2.0, String(dimLabel).length * 0.68));
                        const fontPx = Math.min(idealPx, fitPx);
                        c.font = `600 ${fontPx}px ${CANVAS_FONT_MONO}`;
                        c.textAlign = 'center';
                        c.textBaseline = 'middle';
                        c.lineJoin = 'round';
                        c.lineWidth = Math.max(fontPx * 0.25, 2.2 / autoScale);
                        c.strokeStyle = 'rgba(255, 255, 255, 0.92)';
                        c.strokeText(dimLabel, 0, 0);
                        c.fillStyle = item.kind === 'opening-window'
                            ? '#0369a1'
                            : (item.kind === 'opening-door' ? '#78350f' : '#0f172a');
                        c.fillText(dimLabel, 0, 0);
                        c.restore();
                    }
                    c.restore();
                }
            } finally {
                STATE.showPaving = prevShowPaving;
                STATE.showTileMarks = prevShowMarks;
                STATE.showRoomLabels = prevShowRoomLabels;
            }
            c.restore();

            // 6. 右上角：指北针方向图示
            const compassR = Math.round(58 * uiUnit);
            const compassCx = W - marginPx - Math.round(compassR * 0.85);
            const compassCy = marginPx + Math.round(compassR * 1.15);
            drawCompassSymbol(c, compassCx, compassCy, compassR, STATE.northAngle || 0, {
                showDisc: false,
                isExport: true
            });

            // 7. 底部：空间名称标题 + 图示说明栏
            const floorPrefix = STATE.floorsEnabled && getCurrentFloor()?.name ? `${getCurrentFloor().name} · ` : '';
            let mainTitle = '';
            let subTitle = '';
            if (singleRoom) {
                const st = singleRoom.stats || { areaSqm: 0, buyCount: 0 };
                mainTitle = `${floorPrefix}${singleRoom.name || '未命名空间'}`;
                const matText = singleRoom.cleared
                    ? '未铺贴'
                    : `${singleRoom.materialType === 'wood' ? '木地板' : '瓷砖'} ${uSpec(singleRoom.tileW, singleRoom.tileH)}${Units.cur()} · ${patternLabel(singleRoom.pattern)} · 采购 ${st.buyCount} 块`;
                subTitle = `铺贴面积 ${st.areaSqm.toFixed(2)} m²  |  ${matText}`;
            } else {
                const activeRooms = exportRooms.filter(r => !r.cleared);
                const sumArea = activeRooms.reduce((s, r) => s + (r.stats?.areaSqm || 0), 0);
                mainTitle = `${floorPrefix}${getProjectName()} · 全屋铺贴方案`;
                subTitle = activeRooms.length ? `共 ${activeRooms.length} 个铺贴空间  |  地面净面积 ${sumArea.toFixed(2)} m²` : '';
            }

            const titleY = drawBottom + Math.round(32 * uiUnit);
            const titleFontPx = Math.round(36 * uiUnit);
            const subFontPx = Math.round(21 * uiUnit);
            c.save();
            c.textAlign = 'center';
            c.textBaseline = 'middle';
            c.font = `700 ${titleFontPx}px ${CANVAS_FONT_SANS}`;
            c.fillStyle = '#0f172a';
            c.fillText(mainTitle, W * 0.5, titleY);
            const tw = c.measureText(mainTitle).width;
            c.strokeStyle = '#334155';
            c.lineWidth = Math.max(1.5, 2.2 * uiUnit);
            c.beginPath();
            c.moveTo(W * 0.5 - tw * 0.52, titleY + titleFontPx * 0.62);
            c.lineTo(W * 0.5 + tw * 0.52, titleY + titleFontPx * 0.62);
            c.stroke();
            if (subTitle) {
                c.font = `500 ${subFontPx}px ${CANVAS_FONT_MONO}`;
                c.fillStyle = '#475569';
                c.fillText(subTitle, W * 0.5, titleY + titleFontPx * 1.12);
            }

            // 底部图示（按实际用到的材料花色与施工符号横向居中排布，超出自动换行）
            if (legendItems.length > 0) {
                const legFontPx = Math.round(21 * uiUnit);
                const iconW = Math.round(34 * uiUnit);
                const iconH = Math.round(22 * uiUnit);
                const iconGap = Math.round(10 * uiUnit);
                const itemGap = Math.round(34 * uiUnit);
                const rowStep = Math.round(44 * uiUnit);
                const maxLineW = W - marginPx * 2;
                c.font = `500 ${legFontPx}px ${CANVAS_FONT_SANS}`;
                c.textAlign = 'left';
                c.textBaseline = 'middle';

                const measured = legendItems.map(it => ({
                    ...it,
                    w: iconW + iconGap + c.measureText(it.label).width
                }));
                const lines = [];
                let curLine = [], curW = 0;
                for (const m of measured) {
                    const addW = curLine.length ? (itemGap + m.w) : m.w;
                    if (curLine.length && curW + addW > maxLineW) {
                        lines.push({ items: curLine, w: curW });
                        curLine = [m];
                        curW = m.w;
                    } else {
                        curLine.push(m);
                        curW += addW;
                    }
                }
                if (curLine.length) lines.push({ items: curLine, w: curW });

                let curLegY = titleY + titleFontPx * (subTitle ? 2.05 : 1.45);
                for (const ln of lines) {
                    let lx = (W - ln.w) * 0.5;
                    for (const it of ln.items) {
                        const iy = curLegY - iconH * 0.5;
                        if (it.kind === 'mat') {
                            c.save();
                            c.fillStyle = it.styleObj.base || '#f8fafc';
                            c.fillRect(lx, iy, iconW, iconH);
                            if (it.styleObj.img) {
                                try {
                                    c.beginPath();
                                    c.rect(lx, iy, iconW, iconH);
                                    c.clip();
                                    c.drawImage(it.styleObj.img, lx, iy, iconW, iconH);
                                } catch (e) { }
                            }
                            c.strokeStyle = '#64748b';
                            c.lineWidth = Math.max(1.2, 1.6 * uiUnit);
                            c.strokeRect(lx, iy, iconW, iconH);
                            c.restore();
                        } else if (it.kind === 'threshold') {
                            c.save();
                            c.fillStyle = it.ts.fill || '#334155';
                            c.fillRect(lx, iy, iconW, iconH);
                            if (it.ts.img) {
                                try {
                                    c.beginPath();
                                    c.rect(lx, iy, iconW, iconH);
                                    c.clip();
                                    c.drawImage(it.ts.img, lx, iy, iconW, iconH);
                                } catch (e) { }
                            }
                            c.strokeStyle = it.ts.stroke || '#0f172a';
                            c.lineWidth = Math.max(1.2, 1.6 * uiUnit);
                            c.strokeRect(lx, iy, iconW, iconH);
                            c.restore();
                        } else if (it.kind === 'strip') {
                            c.save();
                            const sh = Math.max(7, iconH * 0.42);
                            const sy0 = curLegY - sh * 0.5;
                            c.beginPath();
                            c.rect(lx, sy0, iconW, sh);
                            c.fillStyle = '#fbbf24';
                            c.fill();
                            c.clip();
                            c.strokeStyle = 'rgba(180, 83, 9, 0.55)';
                            c.lineWidth = Math.max(1.4, 1.8 * uiUnit);
                            const step = Math.max(5, 6 * uiUnit);
                            c.beginPath();
                            for (let hx = lx - sh; hx < lx + iconW + sh; hx += step) {
                                c.moveTo(hx, sy0 + sh);
                                c.lineTo(hx + sh, sy0);
                            }
                            c.stroke();
                            c.restore();
                        } else if (it.kind === 'origin') {
                            c.save();
                            const ocx = lx + iconW * 0.5;
                            const or = Math.round(7.5 * uiUnit);
                            const oarm = Math.round(12 * uiUnit);
                            c.fillStyle = 'rgba(244, 63, 94, 0.25)';
                            c.strokeStyle = '#e11d48';
                            c.lineWidth = Math.max(1.5, 2 * uiUnit);
                            c.beginPath(); c.arc(ocx, curLegY, or, 0, Math.PI * 2); c.fill(); c.stroke();
                            c.beginPath();
                            c.moveTo(ocx - oarm, curLegY); c.lineTo(ocx + oarm, curLegY);
                            c.moveTo(ocx, curLegY - oarm); c.lineTo(ocx, curLegY + oarm);
                            c.stroke();
                            c.restore();
                        } else if (it.kind === 'gap') {
                            c.save();
                            c.strokeStyle = '#356AE6';
                            c.lineWidth = Math.max(1.4, 2 * uiUnit);
                            c.setLineDash([Math.round(5 * uiUnit), Math.round(4 * uiUnit)]);
                            c.strokeRect(lx + 2, iy + 2, iconW - 4, iconH - 4);
                            c.restore();
                        }
                        c.fillStyle = '#334155';
                        c.fillText(it.label, lx + iconW + iconGap, curLegY);
                        lx += it.w + itemGap;
                    }
                    curLegY += rowStep;
                }
            }
            c.restore();

            return { canvas: exportCanvas, singleRoom, isWholeHouse };
        }

        function exportColorFloorPlanJPG(opts = {}) {
            if (STATE.vertices.length === 0) {
                showToast('当前画布为空，无法导出图片');
                return;
            }
            const { canvas: exportCanvas, singleRoom, isWholeHouse } = renderColorFloorPlanJPGCanvas(opts);
            const scopeSuffix = isWholeHouse ? '_全屋' : `_${singleRoom.name || '单空间'}`;
            const filename = `${getExportBaseName()}${scopeSuffix}_铺贴彩图.jpg`;
            exportCanvas.toBlob(async blob => {
                if (blob) {
                    const saveRes = await downloadBlob(blob, filename);
                    if (!saveRes || !saveRes.saved || saveRes.cancelled) return;
                    showToast(`已导出高清彩图：${saveRes.name || filename} (${exportCanvas.width}×${exportCanvas.height})`);
                }
            }, 'image/jpeg', 0.95);
        }

        function exportElevationColorJPG(opts = {}) {
            if (typeof Elevation === 'undefined' || !Elevation.renderColorExportCanvas) {
                showToast('当前未处于立面模式');
                return;
            }
            const res = Elevation.renderColorExportCanvas(opts);
            if (!res || !res.canvas) {
                showToast('当前立面空间为空，无法导出彩图');
                return;
            }
            const roomName = res.room?.name || '当前空间';
            const viewSuffix = res.viewMode === 'single' ? res.faceLabel : '展开立面';
            const filename = `${getExportBaseName()}_${roomName}_${viewSuffix}_立面彩图.jpg`;
            res.canvas.toBlob(async blob => {
                if (blob) {
                    const saveRes = await downloadBlob(blob, filename);
                    if (!saveRes || !saveRes.saved || saveRes.cancelled) return;
                    showToast(`已导出立面彩图：${saveRes.name || filename} (${res.canvas.width}×${res.canvas.height})`);
                }
            }, 'image/jpeg', 0.95);
        }

        function openImageExportOptionsModal() {
            if (STATE.vertices.length === 0 && STATE.walls.length === 0) {
                showToast('当前画布为空，请先绘制或导入户型');
                return;
            }
            recomputeAllRoomTiling();
            const isElevMode = (typeof Elevation !== 'undefined' && Elevation.isActive());
            const modal = $id('img-export-options-modal');
            if (!modal) {
                if (isElevMode) exportElevationColorJPG({ viewMode: Elevation.curSelection?.().view || 'unfold' });
                else exportColorFloorPlanJPG({ scope: 'all' });
                return;
            }

            // 默认选中逻辑：立面模式下导出当前空间立面；平面模式下默认选中当前空间或「全屋」
            const elevRoom = isElevMode ? Elevation.getCurrentRoom?.() : null;
            const elevSel = isElevMode ? (Elevation.curSelection?.() || {}) : {};
            const elevFaces = elevRoom ? (Elevation.getRoomFaces?.(elevRoom) || []) : [];
            const curElevFace = elevFaces.find(f => f.key === elevSel.faceKey) || elevFaces[0] || null;

            const curSelectedRoom = getUsageScopeRoom();
            const defaultScope = isElevMode
                ? (elevSel.view === 'single' && curElevFace ? 'elev-single' : 'elev-unfold')
                : ((curSelectedRoom && STATE.rooms.some(r => r.id === curSelectedRoom.id)) ? curSelectedRoom.id : 'all');

            const roomsGrid = $id('img-exp-rooms-grid');
            if (roomsGrid) {
                roomsGrid.replaceChildren();
                const addRadioItem = (value, nameText, metaText, isWhole = false) => {
                    const lbl = document.createElement('label');
                    lbl.className = 'img-exp-room-item' + (isWhole ? ' is-whole' : '');
                    const rad = document.createElement('input');
                    rad.type = 'radio';
                    rad.name = 'img-exp-scope';
                    rad.value = value;
                    rad.checked = (value === defaultScope);
                    const nameSpan = document.createElement('span');
                    nameSpan.className = 'img-exp-room-name';
                    nameSpan.textContent = nameText;
                    nameSpan.title = nameText;
                    const metaSpan = document.createElement('span');
                    metaSpan.className = 'img-exp-room-meta';
                    metaSpan.textContent = metaText;
                    lbl.append(rad, nameSpan, metaSpan);
                    roomsGrid.appendChild(lbl);
                };

                if (isElevMode && elevRoom) {
                    const rName = elevRoom.name || '未命名空间';
                    addRadioItem(
                        'elev-unfold',
                        `${rName} · 全墙面展开立面`,
                        `当前空间 · 共 ${elevFaces.length} 面墙`,
                        true
                    );
                    if (curElevFace) {
                        addRadioItem(
                            'elev-single',
                            `${rName} · ${curElevFace.label}墙立面`,
                            `当前墙面 · ${Units.dim(curElevFace.lenMM)}`,
                            false
                        );
                    }
                } else {
                    const activeCount = STATE.rooms.filter(r => !r.cleared).length;
                    const totalArea = STATE.rooms.reduce((s, r) => s + (r.cleared ? 0 : (r.stats?.areaSqm || 0)), 0);
                    addRadioItem(
                        'all',
                        '全屋（全部空间）',
                        STATE.rooms.length ? `${activeCount}个空间 · ${totalArea.toFixed(1)}m²` : '全部墙体',
                        true
                    );
                    for (const r of STATE.rooms) {
                        const area = r.stats ? r.stats.areaSqm : 0;
                        addRadioItem(r.id, r.name || '未命名空间', `${area.toFixed(1)}m²`, false);
                    }
                }
            }

            const chkMarks = $id('img-exp-show-marks');
            const chkDims = $id('img-exp-show-dims');
            const chkLabels = $id('img-exp-show-labels');
            const chkOrigin = $id('img-exp-show-origin');
            if (chkMarks) chkMarks.checked = g_imgExportOpts.showTileMarks != null ? g_imgExportOpts.showTileMarks : !!STATE.showTileMarks;
            if (chkDims) chkDims.checked = g_imgExportOpts.showDimensions !== false;
            if (chkLabels) chkLabels.checked = g_imgExportOpts.showRoomLabels !== false;
            if (chkOrigin) chkOrigin.checked = g_imgExportOpts.showOrigin !== false;

            const closeModal = () => modal.classList.add('hidden');
            if (!g_imgExportModalBound) {
                g_imgExportModalBound = true;
                $id('btn-close-img-export')?.addEventListener('click', closeModal);
                $id('btn-cancel-img-export')?.addEventListener('click', closeModal);
                modal.addEventListener('mousedown', e => { if (e.target === modal) closeModal(); });
                window.addEventListener('keydown', e => {
                    if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeModal();
                });
                $id('btn-confirm-img-export')?.addEventListener('click', () => {
                    const checkedRadio = $id('img-exp-rooms-grid')?.querySelector('input[name="img-exp-scope"]:checked');
                    const scope = checkedRadio ? checkedRadio.value : 'all';
                    const opts = {
                        scope,
                        showTileMarks: !!$id('img-exp-show-marks')?.checked,
                        showDimensions: !!$id('img-exp-show-dims')?.checked,
                        showRoomLabels: !!$id('img-exp-show-labels')?.checked,
                        showOrigin: !!$id('img-exp-show-origin')?.checked,
                        resolution: g_imgExportOpts.resolution || 3000
                    };
                    g_imgExportOpts = {
                        showTileMarks: opts.showTileMarks,
                        showDimensions: opts.showDimensions,
                        showRoomLabels: opts.showRoomLabels,
                        showOrigin: opts.showOrigin,
                        resolution: opts.resolution
                    };
                    closeModal();
                    if (scope === 'elev-unfold' || scope === 'elev-single') {
                        exportElevationColorJPG({ ...opts, viewMode: scope === 'elev-single' ? 'single' : 'unfold' });
                    } else {
                        exportColorFloorPlanJPG(opts);
                    }
                });
            }

            modal.classList.remove('hidden');
        }

        let toastTimer = null;
        function showToast(msg) {
            const container = $id('toast-container');
            $id('toast-msg').textContent = msg;
            container.classList.remove('opacity-0', 'translate-y-2');
            container.classList.add('opacity-100', 'translate-y-0');
            clearTimeout(toastTimer);
            toastTimer = setTimeout(() => {
                container.classList.add('opacity-0', 'translate-y-2');
                container.classList.remove('opacity-100', 'translate-y-0');
            }, 2600);
        }

        /*************************************************************************
         * 十三、全量事件绑定
         *************************************************************************/
        function bindEvents() {
            canvas.addEventListener('wheel', (e) => {
                e.preventDefault();
                const rect = canvas.getBoundingClientRect();
                const mx = e.clientX - rect.left, my = e.clientY - rect.top;
                zoomBy(e.deltaY < 0 ? 1.12 : 0.89, mx, my);
            }, { passive: false });

            canvas.addEventListener('dblclick', (e) => {
                const rect = canvas.getBoundingClientRect();
                const worldPos = toWorld(e.clientX - rect.left, e.clientY - rect.top);
                if (STATE.tool === 'wall' && STATE.wallStartVertex) {
                    const draftField = $id('dim-input-field');
                    if (draftField) { draftField.focus(); draftField.select(); }
                    return;
                }
                const hitDim = findHitDimension(worldPos);
                if (hitDim) {
                    showDimensionPopover(hitDim.wall, hitDim.midPos, hitDim.clearPx, hitDim.kind, hitDim.opening, hitDim.labelPrefix);
                } else {
                    const hit = hitTest(worldPos);
                    if (hit && hit.type === 'wall') {
                        const wall = getWall(hit.id);
                        const v1 = getVertex(wall.v1), v2 = getVertex(wall.v2);
                        const { regionOf } = computeDimensionRegions();
                        const f = wallInnerFace(wall, regionOf.get(wall.id) || null, globalRefPoint());
                        showDimensionPopover(wall, { x: (v1.x + v2.x) / 2, y: (v1.y + v2.y) / 2 }, f ? f.innerLen : null, 'wall');
                    }
                }
            });

            canvas.addEventListener('mousemove', (e) => {
                const rect = canvas.getBoundingClientRect();
                const screenPos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
                const worldPos = toWorld(screenPos.x, screenPos.y);
                STATE.mouseWorldPos = worldPos;
                STATE.dragAltKey = !!e.altKey;

                if (STATE.isPanning) {
                    STATE.panX = screenPos.x - STATE.panStart.x;
                    STATE.panY = screenPos.y - STATE.panStart.y;
                    render();
                    return;
                }
                if (STATE.isDragging && STATE.dragTarget) {
                    handleDrag(worldPos);
                    render();
                    return;
                }

                const hitDim = findHitDimension(worldPos);
                STATE.hoveredDimension = hitDim ? (hitDim.id || hitDim.wall.id) : null;

                if (STATE.tool === 'select') {
                    const origRoom = hitOriginHandle(worldPos);
                    const hit = hitTest(worldPos);
                    STATE.hovered = hit;
                    if (hit && hit.type === 'opening-endpoint') {
                        canvas.style.cursor = Math.abs(hit.ux) >= Math.abs(hit.uy) ? 'ew-resize' : 'ns-resize';
                    } else if (hitDim || origRoom || (hit && (hit.type === 'vertex' || hit.type === 'wall-endpoint'))) {
                        canvas.style.cursor = 'move';
                    } else if (hit) {
                        canvas.style.cursor = 'pointer';
                    } else {
                        canvas.style.cursor = STATE.isSpacePressed ? 'grab' : 'default';
                    }
                } else if (STATE.tool === 'origin') {
                    const hit = hitTest(worldPos);
                    const room = getOriginRoomAtPoint(worldPos);
                    STATE.originSnapPreview = room ? snapOriginToRoomWallEdge(worldPos, room) : null;
                    STATE.hovered = hit?.type === 'room' ? hit : null;
                    canvas.style.cursor = 'crosshair';
                } else if (STATE.tool === 'pan') {
                    canvas.style.cursor = 'grab';
                } else {
                    STATE.originSnapPreview = null;
                    STATE.hovered = null;
                    canvas.style.cursor = 'crosshair';
                }
                render();
            });

            canvas.addEventListener('mousedown', (e) => {
                const rect = canvas.getBoundingClientRect();
                const screenPos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
                const worldPos = toWorld(screenPos.x, screenPos.y);

                if (e.button === 1 || STATE.isSpacePressed || STATE.tool === 'pan') {
                    STATE.originSnapPreview = null;
                    STATE.isPanning = true;
                    STATE.panStart = { x: screenPos.x - STATE.panX, y: screenPos.y - STATE.panY };
                    canvas.style.cursor = 'grabbing';
                    return;
                }
                if (e.button !== 0) return;

                if (STATE.tool !== 'wall') {
                    $id('dim-input-popover').classList.add('hidden');
                }

                if (STATE.tool === 'eyedropper') {
                    sampleWallColorAtPoint(worldPos.x, worldPos.y);
                    return;
                }

                if (STATE.tool === 'origin') {
                    const room = getOriginRoomAtPoint(worldPos);
                    if (!room) {
                        showToast('请先绘制或导入一个闭合空间，再拾取起铺点');
                        return;
                    }
                    if (room.id !== STATE.selectedRoomId) selectRoom(room.id);
                    // 按下即设置起铺点并进入拖动：按住左键移动时实时重排预览，松开确定（与选择模式下拖动红色十字同一流程）
                    saveHistory();
                    STATE.selected = { type: 'room', id: room.id, target: room };
                    STATE.isDragging = true;
                    STATE.dragStartMouse = { ...worldPos };
                    STATE.dragTarget = { type: 'origin', roomId: room.id, fromTool: true };
                    STATE.dragAltKey = !!e.altKey;
                    handleDrag(worldPos);
                    refreshViews({ panel: true, results: true, canvas: false });
                    render();
                    return;
                }

                if (STATE.tool === 'measure') {
                    if (STATE.measurePoints.length >= 2) STATE.measurePoints = [];
                    STATE.measurePoints.push({ x: worldPos.x, y: worldPos.y });
                    if (STATE.measurePoints.length === 2) {
                        const dM = dist(STATE.measurePoints[0], STATE.measurePoints[1]) / SCALE_PIXELS_PER_METER;
                        showToast(`实测距离：${formatMeasureValue(dM)}`);
                    }
                    render();
                    return;
                }

                if (STATE.tool === 'select') {
                    const hitDim = findHitDimension(worldPos);
                    if (hitDim) {
                        STATE.isDragging = true;
                        STATE.dragStartMouse = { ...worldPos };
                        STATE.dragTarget = {
                            type: 'dimension',
                            wallId: hitDim.wall.id,
                            wall: hitDim.wall,
                            opening: hitDim.opening || null,
                            labelPrefix: hitDim.labelPrefix || null,
                            kind: hitDim.kind,
                            clearPx: hitDim.clearPx || null,
                            midPos: { ...hitDim.midPos },
                            u: hitDim.u || { x: 1, y: 0 },
                            n: hitDim.n || { x: 0, y: 1 },
                            startK: typeof hitDim.curK === 'number' ? hitDim.curK : 22,
                            startSlide: typeof hitDim.curSlide === 'number' ? hitDim.curSlide : 0,
                            hasMoved: false
                        };
                        canvas.style.cursor = 'grabbing';
                        render();
                        return;
                    }

                    const origRoom = hitOriginHandle(worldPos);
                    if (origRoom) {
                        saveHistory();
                        STATE.isDragging = true;
                        STATE.dragStartMouse = { ...worldPos };
                        STATE.dragTarget = { type: 'origin', roomId: origRoom.id };
                        return;
                    }

                    const endHandle = hitWallEndpointHandle(worldPos);
                    if (endHandle) {
                        saveHistory();
                        const ev = getVertex(endHandle.vertexId);
                        STATE.selectedWallIds.clear();
                        STATE.selectedWallIds.add(endHandle.wallId);
                        STATE.selected = { type: 'wall', id: endHandle.wallId, target: getWall(endHandle.wallId) };
                        STATE.isDragging = true;
                        STATE.dragStartMouse = { ...worldPos };
                        STATE.dragTarget = {
                            type: 'wall-endpoint',
                            wallId: endHandle.wallId,
                            end: endHandle.end,
                            vertexId: endHandle.vertexId,
                            originX: ev.x,
                            originY: ev.y,
                            detached: false,
                            blockedEnds: [{ wallId: endHandle.wallId, end: endHandle.end, oldVid: endHandle.vertexId, newVid: null }]
                        };
                        updateInspector();
                        render();
                        return;
                    }

                    const hit = hitTest(worldPos);
                    if (e.shiftKey && hit && hit.type === 'wall') {
                        if (STATE.selectedWallIds.has(hit.id)) STATE.selectedWallIds.delete(hit.id);
                        else STATE.selectedWallIds.add(hit.id);
                        STATE.selected = { type: 'wall', id: hit.id, target: hit.target };
                        updateInspector();
                        render();
                        return;
                    } else if (hit && hit.type === 'wall') {
                        if (!STATE.selectedWallIds.has(hit.id)) {
                            STATE.selectedWallIds.clear();
                            STATE.selectedWallIds.add(hit.id);
                        }
                    } else {
                        STATE.selectedWallIds.clear();
                    }

                    STATE.selected = hit;
                    if (hit && hit.type === 'room') {
                        selectRoom(hit.id);
                    } else if (!hit) {
                        // 点击空白区：取消选中任何对象（墙/门窗/顶点/空间）
                        STATE.selectedWallIds.clear();
                        STATE.selectedRoomId = null;
                        $id('dim-input-popover').classList.add('hidden');
                        refreshViews({ results: true, preview3d: true, canvas: false });
                    }
                    updateInspector();

                    if (hit && hit.type !== 'room') {
                        saveHistory();
                        STATE.isDragging = true;
                        STATE.dragStartMouse = { ...worldPos };
                        if (hit.type === 'vertex') {
                            const v = getVertex(hit.id);
                            STATE.dragTarget = { type: 'vertex', id: hit.id, originX: v.x, originY: v.y };
                        } else if (hit.type === 'wall') {
                            const wallsToMove = STATE.selectedWallIds.size > 0 ? Array.from(STATE.selectedWallIds) : [hit.id];
                            const mainWall = getWall(hit.id);
                            const v1 = getVertex(mainWall.v1), v2 = getVertex(mainWall.v2);
                            const isHorizontal = Math.abs(v1.y - v2.y) < 2.5;
                            const isVertical = Math.abs(v1.x - v2.x) < 2.5;
                            const blockedEnds = computeWallDragEnds(wallsToMove, isHorizontal, isVertical);
                            const vertexOrigins = buildWallVertexOrigins(wallsToMove);
                            // 识别已存在的错台短墙与共线正交分户墙链（如上一次拉开形成的台阶），支持反向拉回合并或越过台阶
                            const stepChains = [];
                            if (isHorizontal || isVertical) {
                                const isOrtho = (ow) => {
                                    const a = getVertex(ow.v1), b = getVertex(ow.v2);
                                    if (!a || !b) return false;
                                    return isHorizontal ? Math.abs(a.x - b.x) < 2.5 : Math.abs(a.y - b.y) < 2.5;
                                };
                                const isSame = (ow) => {
                                    const a = getVertex(ow.v1), b = getVertex(ow.v2);
                                    if (!a || !b) return false;
                                    return isHorizontal ? Math.abs(a.y - b.y) < 2.5 : Math.abs(a.x - b.x) < 2.5;
                                };
                                for (const mVid of vertexOrigins.keys()) {
                                    const orthoAtM = STATE.walls.filter(w => (w.v1 === mVid || w.v2 === mVid) && isOrtho(w));
                                    for (const sw of orthoAtM) {
                                        const sVid = sw.v1 === mVid ? sw.v2 : sw.v1;
                                        if (vertexOrigins.has(sVid)) continue;
                                        const sHasSameDir = STATE.walls.some(w => w.id !== sw.id && (w.v1 === sVid || w.v2 === sVid) && isSame(w));
                                        if (!sHasSameDir) continue;
                                        // 查找连接在 mVid 或 sVid 上的另一段同轴正交分户墙
                                        const partW = STATE.walls.find(w =>
                                            w.id !== sw.id && isOrtho(w) &&
                                            (w.v1 === mVid || w.v2 === mVid || w.v1 === sVid || w.v2 === sVid));
                                        if (partW) {
                                            const attachVid = (partW.v1 === mVid || partW.v1 === sVid) ? partW.v1 : partW.v2;
                                            const partEndKey = partW.v1 === attachVid ? 'v1' : 'v2';
                                            const farVid = partEndKey === 'v1' ? partW.v2 : partW.v1;
                                            stepChains.push({ stepWallId: sw.id, moveVid: mVid, stepVid: sVid, partWallId: partW.id, partEndKey, farVid });
                                        }
                                    }
                                }
                            }
                            STATE.dragTarget = {
                                type: 'wall',
                                mainWallId: hit.id,
                                isHorizontal,
                                isVertical,
                                wallsToMove,
                                blockedEnds,
                                stepChains,
                                detached: false,
                                vertexOrigins
                            };
                        } else if (hit.type === 'opening-endpoint') {
                            const op = hit.target;
                            STATE.selected = { type: 'opening', id: op.id, target: op };
                            updateInspector();
                            const wall = getWall(op.wallId);
                            const v1 = wall && getVertex(wall.v1), v2 = wall && getVertex(wall.v2);
                            const wallLen = (v1 && v2) ? Math.max(1, dist(v1, v2)) : 100;
                            const halfRatio = ((op.width || 45) / 2) / wallLen;
                            STATE.dragTarget = {
                                type: 'opening-endpoint',
                                id: op.id,
                                end: hit.end,
                                initialTStart: op.t - halfRatio,
                                initialTEnd: op.t + halfRatio
                            };
                        } else if (hit.type === 'opening') {
                            STATE.dragTarget = { type: 'opening', id: hit.id, startWallId: hit.target.wallId };
                        }
                    }
                } else if (STATE.tool === 'wall') {
                    const snapped = snapPos(worldPos);
                    if (!STATE.wallStartVertex) {
                        saveHistory();
                        let startV = snapped.snappedVertex;
                        if (!startV) {
                            startV = { id: uid('v_'), x: snapped.x, y: snapped.y };
                            STATE.vertices.push(startV);
                            if (snapped.wallSnap) splitWallAt(snapped.wallSnap.wall, startV, snapped.wallSnap.t);
                        }
                        STATE.wallStartVertex = startV;
                    } else if (commitWallEndpoint(worldPos)) {
                        return;
                    }
                    STATE.activeSnapLines = [];
                } else if (['door', 'window'].includes(STATE.tool)) {
                    const snap = findNearestWallSnap(worldPos, 30, {
                        snapMidpoint: !e.altKey,
                        openingWidth: mmToPx(STATE.tool === 'window' ? PRESETS.draw.windowWidthMM : PRESETS.draw.doorWidthMM)
                    });
                    if (snap) {
                        saveHistory();
                        const newOp = {
                            id: uid('op_'),
                            wallId: snap.wall.id,
                            t: snap.t,
                            width: mmToPx(STATE.tool === 'window' ? PRESETS.draw.windowWidthMM : PRESETS.draw.doorWidthMM),
                            type: STATE.tool,
                            flip: false,
                            hinge: 0
                        };
                        STATE.openings.push(newOp);
                        STATE.selected = { type: 'opening', id: newOp.id, target: newOp };
                        setTool('select');
                        refreshViews({ tiling: true, panel: true, inspector: true, results: true, preview3d: true, canvas: false });
                        showToast(`已吸附安装${newOp.type === 'window' ? '窗户' : '门扇'}`);
                    } else {
                        showToast('请将鼠标靠近墙体以自动吸附放置门窗');
                    }
                }
                render();
            });

            window.addEventListener('mouseup', () => {
                STATE.activeSnapLines = [];
                if (STATE.isPanning) {
                    STATE.isPanning = false;
                    canvas.style.cursor = STATE.isSpacePressed ? 'grab' : 'default';
                }
                if (STATE.isDragging) {
                    const dt = STATE.dragTarget;
                    const originSnapResult = dt && dt.type === 'origin' ? STATE.originSnapPreview : null;
                    // 记录本次是否真的拖动过（而非单击选中），供松手后自动合并共线墙段时判断，
                    // 避免单击一面墙就把既有分段误合并掉。
                    let dragMoved = false;
                    if (dt && dt.type === 'vertex') {
                        const v = getVertex(dt.id);
                        dragMoved = !!v && (Math.abs(v.x - dt.originX) > 0.5 || Math.abs(v.y - dt.originY) > 0.5);
                    } else if (dt && dt.type === 'wall-endpoint') {
                        const cur = getVertex(dt.blockedEnds?.[0]?.newVid || dt.vertexId);
                        dragMoved = !!cur && (Math.abs(cur.x - dt.originX) > 0.5 || Math.abs(cur.y - dt.originY) > 0.5);
                    } else if (dt && dt.type === 'wall' && dt.vertexOrigins) {
                        dragMoved = Array.from(dt.vertexOrigins.entries()).some(([vid, o]) => {
                            const v = getVertex(vid);
                            return v && (Math.abs(v.x - o.x) > 0.5 || Math.abs(v.y - o.y) > 0.5);
                        });
                    }
                    STATE.isDragging = false;
                    STATE.dragTarget = null;
                    STATE.openingSnapPreview = null;
                    if (dt && dt.type === 'origin') {
                        STATE.originSnapPreview = null;
                        STATE.groutSnapGuides = null;
                        refreshViews({ panel: true, results: true, canvas: false });
                        // 工具栏拾取：松开后回到选择模式，避免后续点击误改起铺点（已设置的起铺点仍可在选择模式下拖动微调）
                        if (dt.fromTool) {
                            setTool('select');
                            canvas.style.cursor = 'default';
                            if (!originSnapResult?.snapped) showToast('起铺点已设置，已退出拾取模式');
                        }
                    }

                    if (dt && (dt.type === 'vertex' || dt.type === 'wall-endpoint') && dt.mergeTargetId) {
                        const targetVid = dt.type === 'vertex' ? dt.id : dt.vertexId;
                        if (mergeVertices(targetVid, dt.mergeTargetId)) {
                            removeOrphanVertices();
                            syncRoomsFromGeometry({ silent: true });
                            showToast('端点已自动重合闭合');
                        }
                    }
                    if (dt && dt.type === 'dimension') {
                        if (!dt.hasMoved) {
                            showDimensionPopover(dt.wall, dt.midPos, dt.clearPx, dt.kind, dt.opening, dt.labelPrefix);
                        }
                    }
                    let autoMergedCount = 0;
                    if (dt && dt.type === 'wall' && (dragMoved || dt.detached)) {
                        const touchedVids = new Set();
                        if (dt.blockedEnds) {
                            for (const b of dt.blockedEnds) {
                                touchedVids.add(b.oldVid);
                                if (!b.newVid) continue;
                                touchedVids.add(b.newVid);
                                const oldV = getVertex(b.oldVid), newV = getVertex(b.newVid);
                                if (oldV && newV) {
                                    delete newV._perpWalls; delete newV._connWallId; delete newV._origX; delete newV._origY;
                                    if (dist(oldV, newV) <= 4.0) {
                                        if (mergeVertices(newV.id, oldV.id)) autoMergedCount++;
                                    }
                                }
                            }
                        }
                        // 检查移动后的墙体端点是否与相邻台阶节点重合（如将错台墙拉回与相邻墙体平齐合并）
                        if (dt.vertexOrigins) {
                            for (const vid of dt.vertexOrigins.keys()) {
                                touchedVids.add(vid);
                                const v = getVertex(vid);
                                if (!v) continue;
                                const near = STATE.vertices.find(other =>
                                    other.id !== v.id && !dt.vertexOrigins.has(other.id) && dist(v, other) <= 4.0);
                                if (near) {
                                    touchedVids.add(near.id);
                                    if (mergeVertices(v.id, near.id)) autoMergedCount++;
                                }
                            }
                        }
                        cleanupDuplicateWalls();
                        removeOrphanVertices();
                        // 对本次拖拽涉及的节点尝试合并共线墙段（无 T 型分户墙时自动合成一整段墙）
                        for (const vid of Array.from(touchedVids)) {
                            if (getVertex(vid) && mergeCollinearWallsAt(vid)) {
                                autoMergedCount++;
                            }
                        }
                        cleanupDuplicateWalls();
                        removeOrphanVertices();
                        if (STATE.selectedWallIds) {
                            STATE.selectedWallIds = new Set(Array.from(STATE.selectedWallIds).filter(id => getWall(id)));
                        }
                        if (STATE.selected && STATE.selected.type === 'wall' && !getWall(STATE.selected.id)) {
                            STATE.selected = null;
                        }
                        syncRoomsFromGeometry({ silent: true });
                    } else if (dt && dragMoved && (dt.type === 'vertex' || dt.type === 'wall-endpoint')) {
                        autoMergedCount = autoMergeCollinearWalls();
                        syncRoomsFromGeometry({ silent: true });
                    }
                    STATE.mergeCandidate = null;
                    if (originSnapResult?.snapped) {
                        showToast(originSnapResult.snapType === 'corner'
                            ? '起铺点已吸附到墙角边线交点'
                            : originSnapResult.snapType === 'door'
                                ? '起铺点已吸附到门框中点：砖块中线对准门中心'
                                : '起铺点已吸附到墙体内侧边线');
                    }
                    if (autoMergedCount > 0) {
                        showToast(`已自动合并 ${autoMergedCount} 处共线墙段，墙体恢复为整段`);
                    }
                    updateInspector();
                    render();
                }
            });

            canvas.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                if (STATE.tool === 'wall') {
                    STATE.wallStartVertex = null;
                    setTool('select');
                    render();
                }
            });

            // 全局快捷键（输入框内仅响应 Ctrl+S / Ctrl+O / Esc，避免干扰文字编辑与原生撤销）
            const isModalOpen = () => ['import-modal', 'modal-backdrop'].some(id => !$id(id).classList.contains('hidden'));
            window.addEventListener('keydown', (e) => {
                if (StylePicker.isOpen() || window.UiDialogs?.isOpen() || window.ImageCropDialog?.isOpen()) return;
                const mod = e.ctrlKey || e.metaKey;
                const k = e.key.toLowerCase();
                const tag = document.activeElement?.tagName;
                const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

                if (mod && k === 's') { e.preventDefault(); $id('btn-save-json').click(); return; }
                if (mod && k === 'o') { e.preventDefault(); openLocalProjectFile(); return; }
                if (k === 'escape') {
                    if (isModalOpen()) {
                        $id('btn-close-import-modal').click();
                        $id('btn-close-generic-modal').click();
                        $id('btn-close-help-modal')?.click();
                    } else if (STATE.wallStartVertex || STATE.tool !== 'select') {
                        STATE.wallStartVertex = null;
                        setTool('select');
                        render();
                    } else if (!$id('app-update-modal')?.classList.contains('hidden')) {
                        $id('btn-close-app-update')?.click();
                    }
                    return;
                }
                if (typing || isModalOpen()) return;

                if (mod) {
                    if (k === 'z' && e.shiftKey) { e.preventDefault(); redo(); }
                    else if (k === 'z') { e.preventDefault(); undo(); }
                    else if (k === 'y') { e.preventDefault(); redo(); }
                    return;
                }
                if (k === 'delete' || k === 'backspace') {
                    const roomPicked = STATE.selected?.type === 'room' && !STATE.selectedWallIds.size;
                    if (roomPicked) {
                        // 选中空间：Delete 删除整个空间（带确认）；Backspace 不触发，避免误删
                        if (k === 'delete') { e.preventDefault(); deleteSelectedRoom(); }
                    } else if (STATE.selected || STATE.selectedWallIds.size) {
                        e.preventDefault();
                        deleteSelectedElement();
                    }
                    return;
                }
                if (e.code === 'Space' && !STATE.isSpacePressed) {
                    STATE.isSpacePressed = true;
                    canvas.style.cursor = 'grab';
                    e.preventDefault();
                    return;
                }
                const TOOL_KEYS = { v: 'select', h: 'pan', w: 'wall', d: 'door', f: 'window', o: 'origin', m: 'measure' };
                if (TOOL_KEYS[k]) setTool(TOOL_KEYS[k]);
                else if (k === '=' || k === '+') zoomBy(1.25);
                else if (k === '-') zoomBy(0.8);
                else if (k === '0' || k === 'home') { if (Elevation.isActive()) Elevation.fit(); else { fitCanvasToContent(); render(); } }
                else if (k === 'f1' || k === '?') { e.preventDefault(); $id('btn-open-help').click(); }
            });

            window.addEventListener('keyup', (e) => {
                if (e.code === 'Space') {
                    STATE.isSpacePressed = false;
                    canvas.style.cursor = 'default';
                    const ec = $id('elev-canvas'); if (ec && ec.style.cursor === 'grab') ec.style.cursor = '';
                }
            });

            document.querySelectorAll('.tool-btn').forEach(btn => {
                btn.addEventListener('click', () => setTool(btn.getAttribute('data-tool')));
            });

            $id('btn-new-project').addEventListener('click', newProject);
            $id('btn-open-json')?.addEventListener('click', () => openLocalProjectFile());

            $id('btn-open-import').addEventListener('click', () => {
                requestCvRecognitionModal();
            });
            $id('btn-close-import-modal').addEventListener('click', () => {
                toggleModalEyedropper(false);
                $id('import-modal').classList.add('hidden');
            });
            $id('btn-confirm-import-modal').addEventListener('click', () => {
                toggleModalEyedropper(false);
                $id('import-modal').classList.add('hidden');
                fitCanvasToContent();
                render();
                showToast(`已完成户型识别与标定，共载入 ${STATE.rooms.length} 个算量空间`);
            });
            $id('btn-trigger-upload').addEventListener('click', () => {
                $id('file-upload-input').click();
            });
            $id('file-upload-input').addEventListener('change', (e) => {
                const file = e.target.files && e.target.files[0];
                e.target.value = '';
                if (file) cropFloorplanFile(file).then(f => { if (f) handleUserFloorplanUpload(f); });
            });

            const btnRerunOcr = $id('btn-rerun-ocr');
            if (btnRerunOcr) {
                btnRerunOcr.addEventListener('click', () => runOcrOnCurrentFloorplan({ auto: false }));
            }

            // 弹窗对比模式切换按钮
            document.querySelectorAll('.cv-view-mode-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    CV_MODAL_STATE.viewMode = btn.getAttribute('data-cv-mode') || 'split';
                    document.querySelectorAll('.cv-view-mode-btn').forEach(b => {
                        const active = b === btn;
                        b.className = 'segmented-btn cv-view-mode-btn' + (active ? ' active-tile' : '');
                    });
                    renderCvModalPreview();
                });
            });

            // 卷帘滑杆同步
            const splitSlider = $id('cv-split-slider');
            if (splitSlider) {
                splitSlider.addEventListener('input', (e) => {
                    CV_MODAL_STATE.splitRatio = Math.max(0.05, Math.min(0.95, parseInt(e.target.value, 10) / 100));
                    renderCvModalPreview();
                });
            }

            // 左侧预览画布交互：支持拖动卷帘、吸管取墙色、点击墙段切换标定墙、点击房间切换右侧命名项
            const cvPrevCanvas = $id('cv-preview-canvas');
            if (cvPrevCanvas) {
                const mapCanvasEventToWorldAndImg = (e) => {
                    const r = cvPrevCanvas.getBoundingClientRect();
                    const mx = e.clientX - r.left, my = e.clientY - r.top;
                    const box = CV_MODAL_STATE.lastDrawBox;
                    if (!box || !STATE.bgImage) return null;
                    if (box.mode === 'side') {
                        const inLeft = mx >= box.leftX && mx <= box.leftX + box.w && my >= box.y && my <= box.y + box.h;
                        const inRight = mx >= box.rightX && mx <= box.rightX + box.w && my >= box.y && my <= box.y + box.h;
                        if (!inLeft && !inRight) return null;
                        const relX = inLeft ? (mx - box.leftX) : (mx - box.rightX);
                        const relY = my - box.y;
                        const wx = STATE.bgOffsetX + relX / box.scaleWorldToCanvas;
                        const wy = STATE.bgOffsetY + relY / box.scaleWorldToCanvas;
                        return {
                            mx, my, wx, wy,
                            imgX: (wx - STATE.bgOffsetX) / (STATE.bgWorldScale || 1),
                            imgY: (wy - STATE.bgOffsetY) / (STATE.bgWorldScale || 1)
                        };
                    } else {
                        if (mx < box.x || mx > box.x + box.w || my < box.y || my > box.y + box.h) return null;
                        const relX = mx - box.x, relY = my - box.y;
                        const wx = STATE.bgOffsetX + relX / box.scaleWorldToCanvas;
                        const wy = STATE.bgOffsetY + relY / box.scaleWorldToCanvas;
                        return {
                            mx, my, wx, wy,
                            imgX: (wx - STATE.bgOffsetX) / (STATE.bgWorldScale || 1),
                            imgY: (wy - STATE.bgOffsetY) / (STATE.bgWorldScale || 1)
                        };
                    }
                };

                const findWallNearPreviewPoint = (pt, box) => {
                    if (!pt || !box) return null;
                    const hitTolWorld = 16 / (box.scaleWorldToCanvas || 1);
                    let bestWall = null, bestDist = hitTolWorld;
                    for (const w of STATE.walls) {
                        const v1 = getVertex(w.v1), v2 = getVertex(w.v2);
                        if (!v1 || !v2) continue;
                        const proj = projectPointToSegment({ x: pt.wx, y: pt.wy }, v1, v2);
                        if (proj.distance < bestDist) {
                            bestDist = proj.distance;
                            bestWall = w;
                        }
                    }
                    return bestWall;
                };

                cvPrevCanvas.addEventListener('mousemove', (e) => {
                    if (CV_MODAL_STATE.isDraggingSplit) return;
                    const r = cvPrevCanvas.getBoundingClientRect();
                    const mx = e.clientX - r.left;
                    const box = CV_MODAL_STATE.lastDrawBox;
                    if (!CV_MODAL_STATE.eyedropperActive && box && box.mode === 'split') {
                        const splitX = box.x + box.w * CV_MODAL_STATE.splitRatio;
                        if (Math.abs(mx - splitX) <= 10) {
                            cvPrevCanvas.style.cursor = 'ew-resize';
                            if (CV_MODAL_STATE.hoveredWallId) {
                                CV_MODAL_STATE.hoveredWallId = null;
                                renderCvModalPreview();
                            }
                            return;
                        }
                    }
                    if (CV_MODAL_STATE.eyedropperActive) {
                        cvPrevCanvas.style.cursor = 'crosshair';
                        return;
                    }
                    const pt = mapCanvasEventToWorldAndImg(e);
                    const hoverWall = findWallNearPreviewPoint(pt, box);
                    const nextHoverId = hoverWall ? hoverWall.id : null;
                    if (nextHoverId !== CV_MODAL_STATE.hoveredWallId) {
                        CV_MODAL_STATE.hoveredWallId = nextHoverId;
                        renderCvModalPreview();
                    }
                    cvPrevCanvas.style.cursor = hoverWall ? 'pointer' : 'default';
                });

                cvPrevCanvas.addEventListener('mouseleave', () => {
                    if (CV_MODAL_STATE.hoveredWallId) {
                        CV_MODAL_STATE.hoveredWallId = null;
                        renderCvModalPreview();
                    }
                });

                // 支持直接将户型图拖入预览区域上传识别
                const cvWrapper = $id('cv-preview-wrapper');
                const dropTarget = cvWrapper || cvPrevCanvas;
                ['dragenter', 'dragover'].forEach(evtName => {
                    dropTarget.addEventListener(evtName, (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
                        dropTarget.classList.add('ring-2', 'ring-blue-500', 'ring-inset');
                    });
                });
                ['dragleave', 'dragend'].forEach(evtName => {
                    dropTarget.addEventListener(evtName, (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        dropTarget.classList.remove('ring-2', 'ring-blue-500', 'ring-inset');
                    });
                });
                dropTarget.addEventListener('drop', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    dropTarget.classList.remove('ring-2', 'ring-blue-500', 'ring-inset');
                    const files = e.dataTransfer && e.dataTransfer.files;
                    if (!files || !files.length) return;
                    const imgFile = Array.from(files).find(f => (f.type && f.type.startsWith('image/')) || /\.(png|jpe?g|webp|bmp)$/i.test(f.name));
                    if (imgFile) {
                        cropFloorplanFile(imgFile).then(f => { if (f) handleUserFloorplanUpload(f); });
                    } else {
                        showToast('请拖入 PNG / JPG / WEBP / BMP 格式的户型图片');
                    }
                });

                // 支持鼠标滚轮以光标为中心缩放识别预览视图
                cvPrevCanvas.addEventListener('wheel', (e) => {
                    if (!STATE.bgImage) return;
                    e.preventDefault();
                    const r = cvPrevCanvas.getBoundingClientRect();
                    const mx = e.clientX - r.left, my = e.clientY - r.top;
                    const oldZoom = CV_MODAL_STATE.zoom || 1.0;
                    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
                    const newZoom = Math.max(0.4, Math.min(6.0, oldZoom * factor));
                    if (Math.abs(newZoom - oldZoom) < 1e-4) return;
                    const ratio = newZoom / oldZoom;
                    const cx = r.width / 2 + (CV_MODAL_STATE.panX || 0);
                    const cy = r.height / 2 + (CV_MODAL_STATE.panY || 0);
                    CV_MODAL_STATE.panX = (CV_MODAL_STATE.panX || 0) - (mx - cx) * (ratio - 1);
                    CV_MODAL_STATE.panY = (CV_MODAL_STATE.panY || 0) - (my - cy) * (ratio - 1);
                    CV_MODAL_STATE.zoom = newZoom;
                    renderCvModalPreview();
                }, { passive: false });

                cvPrevCanvas.addEventListener('dblclick', () => {
                    if (!STATE.bgImage) return;
                    CV_MODAL_STATE.zoom = 1.0;
                    CV_MODAL_STATE.panX = 0;
                    CV_MODAL_STATE.panY = 0;
                    renderCvModalPreview();
                });

                cvPrevCanvas.addEventListener('mousedown', (e) => {
                    const r = cvPrevCanvas.getBoundingClientRect();
                    const mx = e.clientX - r.left;
                    const box = CV_MODAL_STATE.lastDrawBox;

                    const pt = mapCanvasEventToWorldAndImg(e);
                    if (pt && CV_MODAL_STATE.eyedropperActive && e.button === 0) {
                        sampleWallColorFromImageCoords(pt.imgX, pt.imgY);
                        return;
                    }

                    const hitWall = findWallNearPreviewPoint(pt, box);
                    if (e.button === 0 && box && box.mode === 'split') {
                        const splitX = box.x + box.w * CV_MODAL_STATE.splitRatio;
                        if (Math.abs(mx - splitX) <= 11 && !hitWall) {
                            CV_MODAL_STATE.isDraggingSplit = true;
                            return;
                        }
                    }

                    if (STATE.bgImage) {
                        CV_MODAL_STATE.isPanningPreview = true;
                        CV_MODAL_STATE.panMoved = false;
                        CV_MODAL_STATE.panStartMouseX = e.clientX;
                        CV_MODAL_STATE.panStartMouseY = e.clientY;
                        CV_MODAL_STATE.panStartOriginX = CV_MODAL_STATE.panX || 0;
                        CV_MODAL_STATE.panStartOriginY = CV_MODAL_STATE.panY || 0;
                    }
                });

                window.addEventListener('mousemove', (e) => {
                    if (CV_MODAL_STATE.isDraggingSplit) {
                        const r = cvPrevCanvas.getBoundingClientRect();
                        const mx = e.clientX - r.left;
                        const box = CV_MODAL_STATE.lastDrawBox;
                        if (box && box.w > 10) {
                            CV_MODAL_STATE.splitRatio = Math.max(0.05, Math.min(0.95, (mx - box.x) / box.w));
                            if (splitSlider) splitSlider.value = String(Math.round(CV_MODAL_STATE.splitRatio * 100));
                            renderCvModalPreview();
                        }
                        return;
                    }
                    if (CV_MODAL_STATE.isPanningPreview) {
                        const dx = e.clientX - CV_MODAL_STATE.panStartMouseX;
                        const dy = e.clientY - CV_MODAL_STATE.panStartMouseY;
                        if (!CV_MODAL_STATE.panMoved && Math.hypot(dx, dy) > 4) {
                            CV_MODAL_STATE.panMoved = true;
                        }
                        if (CV_MODAL_STATE.panMoved) {
                            CV_MODAL_STATE.panX = CV_MODAL_STATE.panStartOriginX + dx;
                            CV_MODAL_STATE.panY = CV_MODAL_STATE.panStartOriginY + dy;
                            renderCvModalPreview();
                        }
                    }
                });
                window.addEventListener('mouseup', (e) => {
                    if (CV_MODAL_STATE.isDraggingSplit) {
                        CV_MODAL_STATE.isDraggingSplit = false;
                        return;
                    }
                    if (CV_MODAL_STATE.isPanningPreview) {
                        const wasMoved = CV_MODAL_STATE.panMoved;
                        CV_MODAL_STATE.isPanningPreview = false;
                        CV_MODAL_STATE.panMoved = false;
                        if (!wasMoved && e.button === 0 && e.target === cvPrevCanvas) {
                            const box = CV_MODAL_STATE.lastDrawBox;
                            const pt = mapCanvasEventToWorldAndImg(e);
                            if (!pt) return;
                            const hitWall = findWallNearPreviewPoint(pt, box);
                            if (hitWall) {
                                selectCvModalCalibWall(hitWall.id, true);
                                return;
                            }
                            for (const room of STATE.rooms) {
                                const verts = getRoomPolygonVerts(room);
                                if (verts.length >= 3 && isPointInPolygon({ x: pt.wx, y: pt.wy }, verts)) {
                                    CV_MODAL_STATE.activeRoomId = room.id;
                                    selectRoom(room.id);
                                    populateCvModalRoomsList();
                                    renderCvModalPreview();
                                    const inp = document.querySelector(`input[data-cv-room-input="${room.id}"]`);
                                    if (inp) { inp.focus(); inp.select(); }
                                    return;
                                }
                            }
                            if (CV_MODAL_STATE.calibWallId) selectCvModalCalibWall(null);
                        }
                    }
                });
            }

            ['paramLumMin', 'paramLumMax', 'paramMaxChroma', 'paramMinThick', 'paramMaxThick', 'paramMinWallLen'].forEach(id => {
                const el = $id(id);
                const lblId = id.replace('param', 'lbl');
                const suffix = id.includes('Thick') || id.includes('Len') ? 'px' : '';
                el.addEventListener('input', () => {
                    $id(lblId).textContent = el.value + suffix;
                });
                el.addEventListener('change', () => {
                    if (STATE.bgImage) {
                        executeRecognitionPipeline();
                        syncCvModalInspectorAndPreview();
                        render();
                    }
                });
            });
            $id('btn-cv-preset-color').addEventListener('click', () => applyCvPresetMode('color_gray_wall', true));
            $id('btn-cv-preset-cad').addEventListener('click', () => applyCvPresetMode('cad_dark_wall', true));
            $id('btn-activate-eyedropper').addEventListener('click', () => {
                if (!STATE.bgImage) {
                    showToast('请先上传户型图');
                    return;
                }
                toggleModalEyedropper();
            });
            $id('btn-rerun-cv').addEventListener('click', () => {
                if (!STATE.bgImage) {
                    showToast('请先选择上传一张户型图');
                    return;
                }
                executeRecognitionPipeline();
                syncCvModalInspectorAndPreview();
                render();
                showToast('已按当前滤镜参数重跑墙体与房间识别');
            });

            // 比例标定控件事件绑定
            $id('cv-calib-wall-select').addEventListener('change', (e) => {
                selectCvModalCalibWall(e.target.value || null, !!e.target.value);
            });

            const applyModalWallScaleCalibration = () => {
                const wallId = CV_MODAL_STATE.calibWallId || $id('cv-calib-wall-select').value;
                const mmVal = parseFloat($id('cv-calib-wall-mm').value);
                if (!wallId || !getWall(wallId)) {
                    showToast('请先在左侧预览图点击或下拉选择一段基准墙');
                    return;
                }
                if (isNaN(mmVal) || mmVal < 100) {
                    showToast('请输入有效的墙体毫米长度（例如 3600）');
                    return;
                }
                calibrateWholePlanByWall(wallId, mmVal / 1000, { isMeters: true });
                syncCvModalInspectorAndPreview();
            };
            $id('btn-cv-apply-scale').addEventListener('click', applyModalWallScaleCalibration);
            $id('cv-calib-wall-mm').addEventListener('keydown', (e) => {
                if (e.key === 'Enter') applyModalWallScaleCalibration();
            });

            // 空间快捷命名按钮事件绑定
            document.querySelectorAll('.cv-quick-name-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const targetId = CV_MODAL_STATE.activeRoomId || STATE.selectedRoomId || STATE.rooms[0]?.id;
                    const room = getRoom(targetId);
                    if (!room) {
                        showToast('当前尚无闭合空间可命名');
                        return;
                    }
                    saveHistory();
                    room.name = btn.textContent.trim();
                    room.autoGenerated = false;
                    initRoomSelectorDropdown();
                    if (STATE.selectedRoomId === room.id) {
                        $id('room-name-input').value = room.name;
                    }
                    populateCvModalRoomsList();
                    renderCalculationResults();
                    renderCvModalPreview();
                    render();
                });
            });

            const submitDimPopover = () => {
                const popover = $id('dim-input-popover');
                const input = $id('dim-input-field');
                const val = parseFloat(input.value);
                if (STATE.tool === 'wall' && STATE.wallStartVertex && !STATE.editingWallId && !STATE.editingOpeningDim) {
                    if (!isNaN(val) && val > 0) commitDraftLength(val);
                    STATE.dimInputTyping = false;
                    if (STATE.tool !== 'wall') {
                        popover.classList.add('hidden');
                        STATE.draftPopoverShown = false;
                    }
                    return;
                }
                if (STATE.editingOpeningDim && !isNaN(val) && val >= 0) {
                    const { openingId, subKind } = STATE.editingOpeningDim;
                    STATE.editingOpeningDim = null;
                    STATE.editingWallId = null;
                    STATE.editingClearPx = null;
                    STATE.dimInputTyping = false;
                    popover.classList.add('hidden');
                    STATE.draftPopoverShown = false;
                    applyOpeningDimensionChange(openingId, subKind, val);
                    return;
                }
                if (STATE.editingWallId && !isNaN(val)) {
                    applyNewWallLength(STATE.editingWallId, val, {
                        clearPx: STATE.editingClearPx,
                        kind: STATE.editingDimKind,
                        extendDir: STATE.wallExtendDir || 'pos'
                    });
                }
                STATE.editingOpeningDim = null;
                STATE.editingWallId = null;
                STATE.editingClearPx = null;
                STATE.dimInputTyping = false;
                popover.classList.add('hidden');
                STATE.draftPopoverShown = false;
            };
            $id('dim-input-submit').addEventListener('click', submitDimPopover);
            ['neg', 'pos', 'both'].forEach(dir => {
                const btn = $id(`dim-ext-${dir}`);
                if (!btn) return;
                btn.addEventListener('click', () => {
                    setWallExtendDirUI(dir);
                    const input = $id('dim-input-field');
                    if (input) {
                        input.focus();
                        if (!STATE.dimInputTyping) input.select();
                    }
                });
            });
            $id('dim-input-calibrate').addEventListener('click', () => {
                const popover = $id('dim-input-popover');
                const input = $id('dim-input-field');
                const val = parseFloat(input.value);
                if (STATE.editingWallId && !isNaN(val) && val > 0) {
                    calibrateWholePlanByWall(STATE.editingWallId, val, { clearPx: STATE.editingClearPx });
                }
                STATE.editingWallId = null;
                STATE.editingClearPx = null;
                STATE.dimInputTyping = false;
                popover.classList.add('hidden');
            });
            const dimInputEl = $id('dim-input-field');
            dimInputEl.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.isComposing) {
                    e.preventDefault();
                    submitDimPopover();
                } else if (e.key === 'Escape') {
                    $id('dim-input-popover').classList.add('hidden');
                    STATE.editingWallId = null;
                    STATE.editingOpeningDim = null;
                    STATE.editingClearPx = null;
                    STATE.dimInputTyping = false;
                }
            });
            dimInputEl.addEventListener('input', () => { STATE.dimInputTyping = true; });

            $id('straighten-btn').addEventListener('click', () => {
                if (STATE.selected && STATE.selected.type === 'wall') straightenWall(STATE.selected.id);
            });

            $id('btn-delete-wall').addEventListener('click', deleteSelectedElement);
            $id('btn-delete-opening').addEventListener('click', deleteSelectedElement);
            $id('btn-straighten-wall').addEventListener('click', () => {
                const wid = STATE.selectedWallIds.size >= 1 ? Array.from(STATE.selectedWallIds)[0] : STATE.selected?.id;
                if (wid) straightenWall(wid);
            });
            const applyWallThicknessMM = (mmVal, recordHist = true) => {
                const clampedMM = Math.max(40, Math.min(800, Number(mmVal) || 240));
                const thPx = Math.round((clampedMM / 20) * 10) / 10;
                if (recordHist) saveHistory();
                selectedWallIdsArray().forEach(wid => {
                    const w = getWall(wid);
                    if (w) w.thickness = thPx;
                });
                const thInput = $id('wall-thickness-input');
                if (thInput && document.activeElement !== thInput) thInput.value = String(Math.round(clampedMM));
                document.querySelectorAll('.combo-dropdown-item').forEach(item => {
                    item.classList.toggle('active', item.getAttribute('data-val') === String(Math.round(clampedMM)));
                });
                recomputeAllRoomTiling();
                render();
            };
            $id('wall-thickness-input')?.addEventListener('input', (e) => {
                const val = parseFloat(e.target.value);
                if (!isNaN(val) && val >= 40 && val <= 800) {
                    beginLiveEdit();
                    applyWallThicknessMM(val, false);
                }
            });
            $id('wall-thickness-input')?.addEventListener('change', (e) => {
                const val = parseFloat(e.target.value);
                if (!isNaN(val)) { applyWallThicknessMM(val, false); commitLiveEdit(); }
            });

            // 墙体厚度下拉预设菜单交互
            const thDropdownBtn = $id('wall-thickness-dropdown-btn');
            const thDropdownMenu = $id('wall-thickness-menu');
            if (thDropdownBtn && thDropdownMenu) {
                const toggleDropdown = (show) => {
                    const willShow = (show !== undefined) ? show : thDropdownMenu.classList.contains('hidden');
                    thDropdownMenu.classList.toggle('hidden', !willShow);
                    thDropdownBtn.setAttribute('aria-expanded', String(willShow));
                };
                thDropdownBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    toggleDropdown();
                });
                document.querySelectorAll('.combo-dropdown-item').forEach(item => {
                    item.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const val = parseFloat(item.getAttribute('data-val'));
                        if (!isNaN(val)) {
                            const thInput = $id('wall-thickness-input');
                            if (thInput) thInput.value = String(Math.round(val));
                            applyWallThicknessMM(val, true);
                        }
                        toggleDropdown(false);
                    });
                });
                document.addEventListener('click', (e) => {
                    if (!thDropdownMenu.classList.contains('hidden')) {
                        if (!thDropdownMenu.contains(e.target) && e.target !== thDropdownBtn) {
                            toggleDropdown(false);
                        }
                    }
                });
            }
            const onOpeningWidthInput = (e) => {
                if (STATE.selected?.type !== 'opening') return;
                const op = STATE.openings.find(o => o.id === STATE.selected.id);
                if (op) {
                    beginLiveEdit();
                    op.width = Math.max(15, (parseInt(e.target.value, 10) || 800) / 20);
                    refreshViews({ tiling: true, results: true, preview3d: true, canvas: true });
                }
            };
            $id('opening-width-input').addEventListener('input', onOpeningWidthInput);
            $id('opening-width-input').addEventListener('change', (e) => { onOpeningWidthInput(e); commitLiveEdit(); });
            $id('opening-dist1-input').addEventListener('input', (e) => {
                if (STATE.selected?.type !== 'opening') return;
                const val = parseFloat(e.target.value);
                if (!isNaN(val) && val >= 0) {
                    beginLiveEdit();
                    applyOpeningDimensionChange(STATE.selected.id, 'opening-d1', val, { isMM: true, recordHistory: false });
                }
            });
            $id('opening-dist1-input').addEventListener('change', (e) => {
                if (STATE.selected?.type !== 'opening') return;
                const val = parseFloat(e.target.value);
                if (!isNaN(val) && val >= 0) {
                    applyOpeningDimensionChange(STATE.selected.id, 'opening-d1', val, { isMM: true, recordHistory: false });
                    commitLiveEdit();
                }
            });
            $id('opening-dist2-input').addEventListener('input', (e) => {
                if (STATE.selected?.type !== 'opening') return;
                const val = parseFloat(e.target.value);
                if (!isNaN(val) && val >= 0) {
                    beginLiveEdit();
                    applyOpeningDimensionChange(STATE.selected.id, 'opening-d2', val, { isMM: true, recordHistory: false });
                }
            });
            $id('opening-dist2-input').addEventListener('change', (e) => {
                if (STATE.selected?.type !== 'opening') return;
                const val = parseFloat(e.target.value);
                if (!isNaN(val) && val >= 0) {
                    applyOpeningDimensionChange(STATE.selected.id, 'opening-d2', val, { isMM: true, recordHistory: false });
                    commitLiveEdit();
                }
            });
            // 选中门的属性修改：统一记录撤销 → 修改 → 重算排砖与刷新
            const editSelectedDoor = (mutate, extra = {}) => {
                const op = STATE.openings.find(o => o.id === STATE.selected?.id);
                if (!op || op.type !== 'door') return;
                saveHistory();
                mutate(op);
                refreshViews({ tiling: true, inspector: true, results: true, ...extra });
            };
            $id('btn-flip-opening').addEventListener('click', () => editSelectedDoor(op => { op.flip = !op.flip; }, { preview3d: true }));
            $id('btn-swap-hinge').addEventListener('click', () => editSelectedDoor(op => { op.hinge = op.hinge ? 0 : 1; }, { preview3d: true }));

            // 门洞过门设置：首次修改时把当前生效值（含自动推荐值）写入门洞
            const editDoorPaving = (mutate) => editSelectedDoor(op => {
                const plan = analyzeDoorAdjacency(op, 1);
                if (plan) {
                    op.doorJoint = plan.joint;
                    if (plan.occupyRoomId) op.doorOccupy = plan.occupyRoomId;
                    op.doorOffset = plan.offsetMM;
                }
                mutate(op);
            });
            $id('door-joint-select')?.addEventListener('change', (e) => editDoorPaving(op => {
                const prevJoint = op.doorJoint;
                op.doorJoint = e.target.value;
                if (op.doorJoint === 'strip' && prevJoint !== 'strip' && (!op.doorOffset || op.doorOffset === 0)) {
                    op.doorOffset = Number(PRESETS.door?.defaultStripOffsetMM) || 20;
                }
            }));
            $id('door-occupy-select')?.addEventListener('change', (e) => editDoorPaving(op => { op.doorOccupy = e.target.value; }));
            $id('door-offset-input')?.addEventListener('input', (e) => {
                const op = STATE.openings.find(o => o.id === STATE.selected?.id);
                if (!op || op.type !== 'door') return;
                beginLiveEdit();
                const plan = analyzeDoorAdjacency(op, 1);
                if (plan) {
                    op.doorJoint = plan.joint;
                    if (plan.occupyRoomId) op.doorOccupy = plan.occupyRoomId;
                }
                op.doorOffset = Math.max(0, Math.round(Number(e.target.value) || 0));
                refreshViews({ tiling: true, results: true });
            });
            $id('door-offset-input')?.addEventListener('change', (e) => {
                editDoorPaving(op => {
                    op.doorOffset = Math.max(0, Math.round(Number(e.target.value) || 0));
                });
                commitLiveEdit();
            });
            const openThresholdPicker = () => {
                const op = STATE.selected?.type === 'opening' && STATE.openings.find(o => o.id === STATE.selected.id);
                if (!op || op.type !== 'door') return;
                const plan = analyzeDoorAdjacency(op, 1);
                StylePicker.openFor({
                    type: 'tile', ctx: 'stone',
                    selectedId: getThresholdStyle(op)?.styleId || op.thresholdStyleId || null,
                    sub: `应用到：门洞过门石${plan ? `（${plan.scenarioLabel}）` : ''}`,
                    crop: plan ? { w: plan.wMM, h: plan.thMM } : null,
                    onPick: id => {
                        STATE.selected = { type: 'opening', id: op.id };
                        editSelectedDoor(o => { o.thresholdStyleId = id; });
                    }
                });
            };
            $id('door-threshold-swatch-box')?.addEventListener('click', openThresholdPicker);
            $id('btn-door-threshold-style')?.addEventListener('click', openThresholdPicker);
            const bindDoorPrice = (id, prop) => {
                $id(id)?.addEventListener('input', (e) => {
                    const op = STATE.openings.find(o => o.id === STATE.selected?.id);
                    if (!op || op.type !== 'door') return;
                    beginLiveEdit();
                    op[prop] = Math.max(0, Number(e.target.value) || 0);
                    computeAllDoorsPavingPlan();
                    refreshViews({ tiling: false, results: true });
                });
                $id(id)?.addEventListener('change', (e) => {
                    const v = Math.max(0, Number(e.target.value) || 0);
                    editSelectedDoor(op => { op[prop] = v; computeAllDoorsPavingPlan(); }, { tiling: false, preview3d: false });
                    commitLiveEdit();
                });
            };
            bindDoorPrice('door-threshold-price-input', 'thresholdPrice');
            bindDoorPrice('door-strip-price-input', 'stripPrice');

            $id('room-selector').addEventListener('change', (e) => selectRoom(e.target.value));
            $id('room-name-input').addEventListener('input', (e) => {
                const room = getSelectedRoom();
                if (!room) return;
                room.name = e.target.value;
                room.autoGenerated = false;
                initRoomSelectorDropdown();
                renderCalculationResults();
                render();
            });
            document.querySelectorAll('.room-preset-tag').forEach(btn => {
                btn.addEventListener('click', () => {
                    const room = getSelectedRoom();
                    if (!room) return;
                    saveHistory();
                    room.name = btn.textContent;
                    room.autoGenerated = false;
                    $id('room-name-input').value = room.name;
                    initRoomSelectorDropdown();
                    renderCalculationResults();
                    render();
                });
            });

            // 切换材质类型：套用该类型的默认规格与铺法（presets.json floor.byMaterial），花色重置为该类型默认预设
            for (const type of ['tile', 'wood']) {
                $id('btn-mat-' + type).addEventListener('click', () => {
                    const room = getSelectedRoom();
                    if (!room) return;
                    saveHistory();
                    if (room.auxPrice == null || Number(room.auxPrice) === matPreset(room.materialType).auxPrice) {
                        room.auxPrice = matPreset(type).auxPrice;
                    }
                    room.cleared = false;
                    room.materialType = type;
                    room.styleId = null;
                    const d = matPreset(type);
                    Object.assign(room, { tileW: d.tileW, tileH: d.tileH, gap: d.gap, pattern: d.pattern });
                    refreshViews({ tiling: true, panel: true, preview3d: true });
                });
            }

            $id('size-select').addEventListener('change', (e) => {
                if (e.target.value === 'custom') {
                    $id('custom-w-input').focus();
                    return;
                }
                const room = getSelectedRoom();
                if (!room) return;
                const found = MaterialLib.sizes(room.materialType).find(s => s.label === e.target.value);
                if (found) {
                    saveHistory();
                    room.cleared = false;
                    room.tileW = found.w; room.tileH = found.h;
                    refreshViews({ tiling: true, panel: true });
                }
            });

            const onCustomDimInput = () => {
                const room = getSelectedRoom();
                if (!room) return;
                const wVal = parseFloat($id('custom-w-input').value);
                const hVal = parseFloat($id('custom-h-input').value);
                if ((isNaN(wVal) || wVal < 50) && (isNaN(hVal) || hVal < 50)) return;
                beginLiveEdit();
                room.cleared = false;
                if (!isNaN(wVal) && wVal >= 50) room.tileW = Math.min(3600, wVal);
                if (!isNaN(hVal) && hVal >= 50) room.tileH = Math.min(3600, hVal);
                refreshViews({ tiling: true, panel: false, results: true, preview3d: true });
            };
            const onCustomDimCommit = () => {
                const room = getSelectedRoom();
                if (!room) return;
                beginLiveEdit();
                room.cleared = false;
                room.tileW = Math.max(50, Math.min(3600, parseFloat($id('custom-w-input').value) || 800));
                room.tileH = Math.max(50, Math.min(3600, parseFloat($id('custom-h-input').value) || 800));
                refreshViews({ tiling: true, panel: true, results: true, preview3d: true });
                commitLiveEdit();
            };
            $id('custom-w-input').addEventListener('input', onCustomDimInput);
            $id('custom-h-input').addEventListener('input', onCustomDimInput);
            $id('custom-w-input').addEventListener('change', onCustomDimCommit);
            $id('custom-h-input').addEventListener('change', onCustomDimCommit);

            $id('btn-swap-dim').addEventListener('click', () => {
                const room = getSelectedRoom();
                if (!room) return;
                saveHistory();
                const tmp = room.tileW; room.tileW = room.tileH; room.tileH = tmp;
                refreshViews({ tiling: true, panel: true, results: true, preview3d: true });
                showToast(`已对调长宽为 ${Units.val(room.tileW)} × ${Units.text(room.tileH)}`);
            });

            // 当前空间的单个参数：每次修改都可撤销；live=true 的数字框边输入边预览，整次输入合并为一步撤销
            const bindRoomField = (id, apply, { live = false } = {}) => {
                const el = $id(id);
                if (!el) return;
                const run = (e) => {
                    const room = getSelectedRoom();
                    if (!room) return;
                    beginLiveEdit();
                    apply(room, e.target);
                    refreshViews({ tiling: true, results: true, preview3d: true });
                };
                if (live) el.addEventListener('input', run);
                el.addEventListener('change', (e) => { run(e); commitLiveEdit(); });
            };
            bindRoomField('gap-select', (room, el) => { room.gap = room.materialType === 'wood' ? 0 : Math.max(0, parseFloat(el.value) || 0); }, { live: true });
            bindRoomField('expansion-gap-input', (room, el) => { room.expansionGap = Math.max(0, parseFloat(el.value) || 0); }, { live: true });
            bindRoomField('grout-enable-chk', (room, el) => {
                room.groutEnabled = el.checked;
                if ($id('grout-settings-rows')) $id('grout-settings-rows').classList.toggle('opacity-50', !room.groutEnabled);
            }, { live: true });
            bindRoomField('grout-color-select', (room, el) => {
                room.groutColor = el.value;
                const groutSwatch = $id('grout-color-swatch');
                if (groutSwatch) groutSwatch.style.backgroundColor = el.value;
                const groutHex = $id('grout-color-hex');
                if (groutHex) groutHex.textContent = (el.value || '').toUpperCase();
            }, { live: true });
            bindRoomField('grout-price-input', (room, el) => {
                const n = Number(el.value);
                if (Number.isFinite(n) && n >= 0) room.groutPrice = n;
            }, { live: true });
            bindRoomField('floor-aux-price-input', (room, el) => {
                const n = Number(el.value);
                if (Number.isFinite(n) && n >= 0) room.auxPrice = n;
            }, { live: true });
            bindRoomField('wastage-input', (room, el) => { room.wastage = Math.max(0, parseFloat(el.value) || 0); }, { live: true });

            $id('origin-select').addEventListener('change', (e) => {
                const room = getSelectedRoom();
                if (!room) return;
                saveHistory();
                room.originMode = e.target.value;
                room.originDoorAlign = null;
                room.originDoorOffset = 0;
                room.originStamp = Date.now();
                refreshViews({ tiling: true, panel: true, results: true });
            });
            $id('btn-pick-origin').addEventListener('click', () => setTool('origin'));
            $id('btn-ai-origin')?.addEventListener('click', autoOptimizeAllRoomsOrigin);

            document.querySelectorAll('.floor-only .pattern-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const room = getSelectedRoom();
                    if (!room) return;
                    saveHistory();
                    room.cleared = false;
                    room.pattern = btn.getAttribute('data-pattern');
                    refreshViews({ tiling: true, panel: true, results: true, preview3d: true });
                });
            });

            $id('tile-price-input')?.addEventListener('input', (e) => {
                const room = getSelectedRoom();
                if (!room) return;
                const n = Number(e.target.value);
                if (!Number.isFinite(n) || n < 0) return;
                beginLiveEdit();
                setSpecPrice(room.materialType, room.styleId, room.tileW, room.tileH, n);
                renderCalculationResults();
                if (typeof Elevation !== 'undefined' && Elevation.isActive()) Elevation.refresh({ calc: false });
            });
            $id('tile-price-input')?.addEventListener('change', (e) => {
                const room = getSelectedRoom();
                if (!room) return;
                const n = Number(e.target.value);
                beginLiveEdit();
                setSpecPrice(room.materialType, room.styleId, room.tileW, room.tileH, Number.isFinite(n) && n >= 0 ? n : defaultSpecPrice());
                renderCalculationResults();
                if (typeof Elevation !== 'undefined' && Elevation.isActive()) Elevation.refresh({ calc: false });
                commitLiveEdit();
            });
            $id('chk-small-cut-reuse').addEventListener('change', () => {
                recomputeAllRoomTiling();
                if (typeof Elevation !== 'undefined' && Elevation.isActive()) Elevation.refresh({ calc: true });
                render();
            });

            $id('btn-apply-all-rooms').addEventListener('click', () => {
                const src = getSelectedRoom();
                if (!src) return;
                saveHistory();
                STATE.rooms.forEach(r => {
                    r.cleared = false;
                    r.materialType = src.materialType;
                    r.styleId = src.styleId;
                    r.tileW = src.tileW;
                    r.tileH = src.tileH;
                    r.gap = src.gap;
                    r.groutEnabled = src.groutEnabled;
                    r.groutColor = src.groutColor;
                    r.groutPrice = src.groutPrice;
                    r.auxPrice = src.auxPrice;
                    r.expansionGap = src.expansionGap;
                    r.pattern = src.pattern;
                    r.wastage = src.wastage;
                });
                recomputeAllRoomTiling();
                render();
                showToast(`已将【${src.name}】的铺贴规格应用到全屋 ${STATE.rooms.length} 个空间`);
            });

            document.querySelectorAll('input[name="unit"]').forEach(rad => {
                rad.addEventListener('change', (e) => {
                    Units.setUnit(e.target.value);
                    refreshViews({ panel: true, inspector: true, results: true });
                    if (typeof Elevation !== 'undefined') {
                        Elevation.syncFloorInputs();
                        if (Elevation.isActive()) Elevation.refresh({ calc: false });
                    }
                });
            });

            const syncIconBtnState = (inputEl) => {
                const btn = inputEl && inputEl.closest('.status-icon-btn');
                if (btn) btn.classList.toggle('active', !!inputEl.checked);
            };
            const statusToggleMap = [
                ['chk-show-paving', 'showPaving'],
                ['chk-show-tile-marks', 'showTileMarks'],
                ['chk-show-door-leaves', 'showDoorLeaves'],
                ['chk-room-labels', 'showRoomLabels'],
                ['chk-show-origins', 'showOrigins'],
                ['chk-dimensions', 'showDimensions'],
                ['chk-show-compass', 'showCompass'],
                ['chk-show-grid', 'showGrid'],
                ['chk-grid-snap', 'gridSnap']
            ];
            for (const [id, key] of statusToggleMap) {
                const el = $id(id);
                if (!el) continue;
                el.checked = !!STATE[key];
                syncIconBtnState(el);
            }
            $id('compass-hud')?.classList.toggle('hidden', !STATE.showCompass);

            const refreshViewAfterToggle = () => {
                render();
                if (typeof Elevation !== 'undefined' && Elevation.isActive()) Elevation.refresh({ calc: false });
            };
            $id('chk-show-paving').addEventListener('change', (e) => {
                STATE.showPaving = e.target.checked; syncIconBtnState(e.target); refreshViewAfterToggle();
            });
            $id('chk-show-tile-marks').addEventListener('change', (e) => {
                STATE.showTileMarks = e.target.checked; syncIconBtnState(e.target); refreshViewAfterToggle();
            });
            $id('chk-show-door-leaves')?.addEventListener('change', (e) => {
                STATE.showDoorLeaves = e.target.checked; syncIconBtnState(e.target); refreshViewAfterToggle();
            });
            $id('chk-room-labels')?.addEventListener('change', (e) => {
                STATE.showRoomLabels = e.target.checked; syncIconBtnState(e.target); refreshViewAfterToggle();
            });
            $id('chk-show-origins')?.addEventListener('change', (e) => {
                STATE.showOrigins = e.target.checked; syncIconBtnState(e.target); refreshViewAfterToggle();
            });
            $id('chk-dimensions').addEventListener('change', (e) => {
                STATE.showDimensions = e.target.checked; syncIconBtnState(e.target); refreshViewAfterToggle();
            });
            $id('chk-show-compass')?.addEventListener('change', (e) => {
                STATE.showCompass = e.target.checked;
                syncIconBtnState(e.target);
                $id('compass-hud')?.classList.toggle('hidden', !STATE.showCompass);
            });
            $id('chk-show-grid')?.addEventListener('change', (e) => {
                STATE.showGrid = e.target.checked; syncIconBtnState(e.target); refreshViewAfterToggle();
            });
            $id('chk-grid-snap').addEventListener('change', (e) => {
                STATE.gridSnap = e.target.checked; syncIconBtnState(e.target);
            });
            $id('chk-door-entry-mark')?.addEventListener('change', (e) => {
                if (STATE.selected?.type !== 'opening') return;
                const op = STATE.openings.find(o => o.id === STATE.selected.id);
                if (!op || op.type !== 'door') return;
                saveHistory();
                op.isEntryDoor = !!e.target.checked;
                markDirty();
                render();
            });

            // 导入参考底图与底部底图菜单交互
            const underlayInput = $id('underlay-upload-input');
            const underlayPopover = $id('underlay-popover');
            const closeUnderlayPopover = () => {
                if (underlayPopover) underlayPopover.classList.add('hidden');
            };
            $id('btn-import-underlay').addEventListener('click', () => {
                underlayInput.click();
            });
            underlayInput.addEventListener('change', (e) => {
                const file = e.target.files && e.target.files[0];
                e.target.value = '';
                if (file) cropUnderlayFile(file).then(f => { if (f) handleReferenceUnderlayUpload(f); });
            });
            $id('btn-footer-underlay').addEventListener('click', (e) => {
                e.stopPropagation();
                if (STATE.bgImage && !STATE.showBgImage) {
                    STATE.showBgImage = true;
                    syncUnderlayUiState();
                    render();
                }
                underlayPopover.classList.toggle('hidden');
            });
            $id('btn-underlay-clear').addEventListener('click', () => {
                closeUnderlayPopover();
                if (!STATE.bgImage) {
                    showToast('当前暂无参考底图');
                    return;
                }
                STATE.bgImage = null;
                STATE.stage1Canvas = null;
                STATE.stage2Canvas = null;
                syncUnderlayUiState();
                markDirty();
                render();
                showToast('已清除参考底图');
            });
            $id('btn-underlay-replace').addEventListener('click', () => {
                closeUnderlayPopover();
                underlayInput.click();
            });
            $id('btn-underlay-recognize').addEventListener('click', () => {
                closeUnderlayPopover();
                requestCvRecognitionModal();
            });
            window.addEventListener('mousedown', (e) => {
                const wrap = $id('underlay-menu-wrap');
                if (wrap && !wrap.contains(e.target)) closeUnderlayPopover();
            });

            const onBgOpacityChange = (e) => {
                const pct = parseInt(e.target.value, 10);
                STATE.bgOpacity = pct / 100;
                const lbl = $id('bg-opacity-label');
                if (lbl) lbl.textContent = `${pct}%`;
                render();
            };
            $id('bg-opacity-slider').addEventListener('input', onBgOpacityChange);
            $id('bg-opacity-slider').addEventListener('change', onBgOpacityChange);

            // 规格编号：类型 / 前缀 / 后缀（改动只重新编号，不重新排砖）
            const afterSpecNumEdit = () => {
                if (!STATE.showTileMarks) {
                    STATE.showTileMarks = true;
                    const chkMarks = $id('chk-show-tile-marks');
                    if (chkMarks) { chkMarks.checked = true; syncIconBtnState(chkMarks); }
                }
                renumberTiles();
                syncSpecNumberRow(getSelectedRoom());
                markDirty();
                render();
                if (typeof Elevation !== 'undefined') Elevation.refresh({ calc: false });
            };
            $id('btn-spec-adv-toggle')?.addEventListener('click', (e) => {
                const panel = $id('spec-adv-panel');
                if (!panel) return;
                const isHidden = panel.classList.toggle('hidden');
                e.currentTarget.setAttribute('aria-expanded', isHidden ? 'false' : 'true');
            });
            $id('spec-kind-select')?.addEventListener('change', (e) => {
                const room = getSelectedRoom();
                if (!room) return;
                saveHistory();
                setSpecMeta('floor', room.materialType, room.styleId, { kind: e.target.value });
                afterSpecNumEdit();
            });
            $id('spec-prefix-input')?.addEventListener('input', (e) => {
                const room = getSelectedRoom();
                if (!room) return;
                beginLiveEdit();
                setSpecMeta('floor', room.materialType, room.styleId, { prefix: e.target.value });
                afterSpecNumEdit();
            });
            $id('spec-sep-input')?.addEventListener('input', (e) => {
                beginLiveEdit();
                STATE.tileNumSep = String(e.target.value || '').replace(/\s+/g, '').slice(0, 3);
                afterSpecNumEdit();
            });
            ['spec-prefix-input', 'spec-sep-input'].forEach(id => $id(id)?.addEventListener('change', commitLiveEdit));

            $id('btn-undo').addEventListener('click', undo);
            $id('btn-redo').addEventListener('click', redo);
            $id('btn-clear').addEventListener('click', clearCanvas);
            initFloorHud();
            $id('btn-zoom-in').addEventListener('click', () => zoomBy(1.25));
            $id('btn-zoom-out').addEventListener('click', () => zoomBy(0.8));
            $id('btn-zoom-reset').addEventListener('click', () => { if (Elevation.isActive()) { Elevation.fit(); return; } fitCanvasToContent(); render(); });

            // 主画布左上角指北针：悬浮显示 N/S 圆盘、拖拽旋转方向角（每 45° 强吸附）、双击归零正北
            const compassHud = $id('compass-hud');
            if (compassHud) {
                let dragGrabOffsetDeg = 0;

                const getMouseCompassDeg = (ev) => {
                    const rect = compassHud.getBoundingClientRect();
                    const cx = rect.left + rect.width * 0.5;
                    const cy = rect.top + rect.height * 0.5;
                    const dx = ev.clientX - cx;
                    const dy = ev.clientY - cy;
                    if (Math.hypot(dx, dy) < 3) return null;
                    // 以正上方 (0, -1) 为 0°，顺时针递增
                    return (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
                };

                const updateCompassAngleFromEvent = (ev) => {
                    const mouseDeg = getMouseCompassDeg(ev);
                    if (mouseDeg === null) return;
                    const rawDeg = (mouseDeg - dragGrabOffsetDeg + 360) % 360;
                    const snapped = snapCompassAngle(rawDeg);
                    STATE.northAngle = snapped.angle;
                    compassHud.title = `方向指针：${STATE.northAngle}°（拖拽旋转，每45°吸附，双击正北归零）`;
                    renderCompassHud();
                };

                compassHud.addEventListener('mouseenter', () => {
                    STATE.compassHover = true;
                    renderCompassHud();
                });
                compassHud.addEventListener('mouseleave', () => {
                    STATE.compassHover = false;
                    renderCompassHud();
                });
                compassHud.addEventListener('mousedown', (ev) => {
                    if (ev.button !== 0) return;
                    ev.preventDefault();
                    ev.stopPropagation();
                    beginLiveEdit();
                    STATE.compassDragging = true;
                    compassHud.classList.add('dragging');
                    const mouseDeg = getMouseCompassDeg(ev);
                    if (mouseDeg !== null) {
                        const curNorth = Number(STATE.northAngle) || 0;
                        // 若按在南针半侧（与当前北向夹角 > 90°），则以南针跟随鼠标；若按在北针半侧，则北针直接指向鼠标
                        const diff = ((mouseDeg - curNorth + 540) % 360) - 180;
                        dragGrabOffsetDeg = Math.abs(diff) > 105 ? 180 : 0;
                    } else {
                        dragGrabOffsetDeg = 0;
                    }
                    renderCompassHud();
                });
                window.addEventListener('mousemove', (ev) => {
                    if (!STATE.compassDragging) return;
                    ev.preventDefault();
                    updateCompassAngleFromEvent(ev);
                });
                window.addEventListener('mouseup', () => {
                    if (!STATE.compassDragging) return;
                    STATE.compassDragging = false;
                    compassHud.classList.remove('dragging');
                    commitLiveEdit();
                    renderCompassHud();
                    showToast(`指北针方向已设为 ${STATE.northAngle}°`);
                });
                compassHud.addEventListener('dblclick', (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    if ((STATE.northAngle || 0) !== 0) {
                        saveHistory();
                        STATE.northAngle = 0;
                        compassHud.title = '方向指针（拖拽旋转角度，每45°自动吸附，双击复位正北 0°）';
                        renderCompassHud();
                        showToast('指北针已复位正北 (0°)');
                    }
                });
            }

            // 顶部悬浮下拉菜单：点击子项后立即收起，鼠标移出后恢复悬浮展开能力
            document.querySelectorAll('.ribbon-dropdown').forEach(dd => {
                dd.addEventListener('mouseleave', () => dd.classList.remove('menu-closed'));
                dd.querySelectorAll('.ribbon-menu-item').forEach(item => {
                    item.addEventListener('click', () => {
                        dd.classList.add('menu-closed');
                        item.blur();
                    });
                });
            });

            // 窄窗口时将顶部中间工具栏收起为“工具”弹层，避免按钮挤压重叠
            (() => {
                const ribbonBar = document.querySelector('.ribbon-bar');
                const ribbonLeft = document.querySelector('.ribbon-left');
                const ribbonRight = document.querySelector('.ribbon-right');
                const ribbonCenter = $id('ribbon-center');
                const ribbonPanel = $id('ribbon-center-panel');
                const toolsToggle = $id('btn-ribbon-tools-toggle');
                if (!ribbonBar || !ribbonLeft || !ribbonRight || !ribbonCenter || !ribbonPanel || !toolsToggle) return;

                let expandedPanelWidth = 0;

                const clampPopoverPosition = () => {
                    if (!ribbonCenter.classList.contains('is-collapsed')) {
                        ribbonPanel.style.removeProperty('--ribbon-popover-shift-x');
                        return;
                    }
                    ribbonPanel.style.setProperty('--ribbon-popover-shift-x', '0px');
                    const rect = ribbonPanel.getBoundingClientRect();
                    const margin = 8;
                    let shift = 0;
                    if (rect.left < margin) {
                        shift = margin - rect.left;
                    } else if (rect.right > window.innerWidth - margin) {
                        shift = (window.innerWidth - margin) - rect.right;
                    }
                    if (shift !== 0) {
                        ribbonPanel.style.setProperty('--ribbon-popover-shift-x', `${Math.round(shift)}px`);
                    }
                };

                const setToolsOpen = (open) => {
                    const next = Boolean(open) && ribbonCenter.classList.contains('is-collapsed');
                    ribbonCenter.classList.toggle('is-open', next);
                    toolsToggle.setAttribute('aria-expanded', next ? 'true' : 'false');
                    if (next) clampPopoverPosition();
                };

                const measureChildrenWidth = (el) => {
                    let sum = 0;
                    for (const child of el.children) {
                        const style = getComputedStyle(child);
                        if (style.display === 'none') continue;
                        sum += child.getBoundingClientRect().width
                            + (parseFloat(style.marginLeft) || 0)
                            + (parseFloat(style.marginRight) || 0);
                    }
                    return Math.ceil(sum);
                };

                const updateRibbonCollapse = () => {
                    const isCollapsed = ribbonCenter.classList.contains('is-collapsed');
                    if (!isCollapsed) {
                        const w = Math.ceil(ribbonPanel.getBoundingClientRect().width);
                        if (w > 0) expandedPanelWidth = w;
                    }
                    if (!expandedPanelWidth) return;

                    const barStyle = getComputedStyle(ribbonBar);
                    const barPad = (parseFloat(barStyle.paddingLeft) || 0) + (parseFloat(barStyle.paddingRight) || 0);
                    const availableBarWidth = ribbonBar.clientWidth - barPad;
                    const leftNeed = measureChildrenWidth(ribbonLeft);
                    const rightNeed = measureChildrenWidth(ribbonRight);
                    const requiredBarWidth = expandedPanelWidth + 2 * Math.max(leftNeed, rightNeed) + 32;

                    const shouldCollapse = isCollapsed
                        ? availableBarWidth < requiredBarWidth + 16
                        : availableBarWidth < requiredBarWidth;

                    if (shouldCollapse !== isCollapsed) {
                        ribbonCenter.classList.toggle('is-collapsed', shouldCollapse);
                        if (!shouldCollapse) setToolsOpen(false);
                    }
                    if (shouldCollapse && ribbonCenter.classList.contains('is-open')) {
                        clampPopoverPosition();
                    }
                };

                toolsToggle.addEventListener('click', (e) => {
                    e.stopPropagation();
                    setToolsOpen(!ribbonCenter.classList.contains('is-open'));
                });

                ribbonPanel.addEventListener('click', (e) => {
                    if (e.target.closest('.tool-btn, .ribbon-menu-item')) {
                        setToolsOpen(false);
                    }
                });

                document.addEventListener('pointerdown', (e) => {
                    if (ribbonCenter.classList.contains('is-open') && !ribbonCenter.contains(e.target)) {
                        setToolsOpen(false);
                    }
                });

                document.addEventListener('keydown', (e) => {
                    if (e.key === 'Escape' && ribbonCenter.classList.contains('is-open')) {
                        setToolsOpen(false);
                    }
                });

                updateRibbonCollapse();
                if (typeof ResizeObserver !== 'undefined') {
                    const ro = new ResizeObserver(() => updateRibbonCollapse());
                    ro.observe(ribbonBar);
                } else {
                    window.addEventListener('resize', updateRibbonCollapse);
                }
            })();

            // 点击导出 DXF / PDF / DWG 先弹出导出选项弹窗（可覆盖表单字段与设置砖号/块着色/墙壁实心）
            $id('btn-export-dxf').addEventListener('click', () => openCadExportOptionsModal('dxf'));
            $id('btn-export-pdf').addEventListener('click', () => openCadExportOptionsModal('pdf'));
            $id('btn-export-dwg').addEventListener('click', () => openCadExportOptionsModal('dwg'));
            // 图框设置：桌面模式弹出独立原生子窗体，浏览器模式降级为内嵌 iframe 弹窗
            const frameModal = $id('frame-editor-modal');
            const closeFrameEditor = () => frameModal.classList.add('hidden');
            $id('btn-frame-editor')?.addEventListener('click', async () => {
                await writeFrameEditorContext();
                if (typeof DesktopHost !== 'undefined' && DesktopHost.isDesktop()) {
                    try {
                        const winRes = await DesktopHost.openChildWindow({
                            id: 'frame-editor',
                            url: 'tukuan.html',
                            title: '图框设置 · EasyTile',
                            width: 1440,
                            height: 900,
                            minWidth: 960,
                            minHeight: 640,
                            resizable: true,
                            frameless: true,
                            center: true,
                            showInTaskbar: true,
                            backgroundColor: '#F5F7FA'
                        });
                        if (winRes) {
                            if (winRes.alreadyOpen) {
                                await DesktopHost.postToChild('frame-editor', { type: 'tilecalc-frame-context-updated' });
                            }
                            return;
                        }
                    } catch (err) {
                        console.warn('[FrameChildWindow]', err);
                    }
                }
                const ifr = $id('frame-editor-iframe');
                ifr.src = 'tukuan.html?embed=1&t=' + Date.now();
                frameModal.classList.remove('hidden');
            });
            $id('btn-close-frame-editor')?.addEventListener('click', closeFrameEditor);
            window.addEventListener('keydown', e => { if (e.key === 'Escape' && !frameModal.classList.contains('hidden')) closeFrameEditor(); });
            $id('btn-export-a4').addEventListener('click', openImageExportOptionsModal);
            // 用量汇总：「全部」取消空间选中；「生成报价」打开 quote.html 报价单
            $id('btn-usage-show-all')?.addEventListener('click', () => {
                STATE.selected = null;
                STATE.selectedRoomId = null;
                STATE.selectedWallIds.clear();
                updateInspector();
                refreshViews({ results: true, preview3d: true });
            });
            const quoteModal = $id('quote-modal');
            const closeQuote = () => { quoteModal.classList.add('hidden'); };
            $id('btn-open-quote')?.addEventListener('click', openQuoteModal);
            $id('btn-close-quote')?.addEventListener('click', closeQuote);
            window.addEventListener('keydown', e => { if (e.key === 'Escape' && !quoteModal.classList.contains('hidden')) closeQuote(); });

            const handleChildBridgeMessage = async (msg, replyTarget = null) => {
                if (!msg || typeof msg !== 'object') return;
                if (msg.type === 'tilecalc-frame-applied') {
                    StorageDB.refreshKey(APPLIED_FRAME_KEY);
                    if (typeof DesktopHost !== 'undefined' && DesktopHost.isDesktop()) {
                        DesktopHost.closeChildWindow('frame-editor');
                    }
                    if (!frameModal.classList.contains('hidden')) closeFrameEditor();
                    showToast(`已应用图框「${msg.name}」（${msg.sheetLabel}），导出 DXF / DWG / PDF 将使用该图框`);
                } else if (msg.type === 'tilecalc-quote-ready') {
                    if (typeof replyTarget === 'string') {
                        try {
                            const payload = await buildQuotePayloadAsync();
                            await DesktopHost.postToChild(replyTarget, { type: 'tilecalc-quote-data', payload });
                        } catch (err) { }
                    } else if (replyTarget && !quoteModal.classList.contains('hidden')) {
                        try {
                            const payload = await buildQuotePayloadAsync();
                            replyTarget.postMessage({ type: 'tilecalc-quote-data', payload }, '*');
                        } catch (err) { }
                    }
                } else if (msg.type === 'tilecalc-merchant-save' && msg.payload) {
                    try {
                        const clean = Object.assign({}, msg.payload);
                        delete clean.logoDataUrl;
                        await StorageDB.setJSON(MERCHANT_INFO_KEY, clean);
                    } catch (err) { }
                } else if (msg.type === 'tilecalc-quote-exported') {
                    const fmt = msg.format ? ` ${msg.format}` : '';
                    showToast(`已导出报价单${fmt}（${msg.count} 项，合计 ¥${msg.total}）`);
                } else if (msg.type === 'tilecalc-child-close') {
                    if (typeof replyTarget === 'string' && typeof DesktopHost !== 'undefined' && DesktopHost.isDesktop()) {
                        DesktopHost.closeChildWindow(replyTarget);
                    }
                    if (!quoteModal.classList.contains('hidden')) closeQuote();
                    if (!frameModal.classList.contains('hidden')) closeFrameEditor();
                }
            };
            window.addEventListener('message', e => { handleChildBridgeMessage(e.data, e.source); });
            window._handleDesktopChildMessage = handleChildBridgeMessage;
            $id('btn-export-xlsx-menu')?.addEventListener('click', exportCalculationXLSX);

            const RECENT_PROJECTS_KEY = 'tilecalc.recentProjects';
            const countProjectRooms = (st) => {
                return projectStateValid(st) ? st.floors.reduce((sum, f) => sum + (f.state?.rooms?.length || 0), 0) : 0;
            };
            const readRecentProjects = () => {
                try {
                    const arr = StorageDB.getJSON(RECENT_PROJECTS_KEY, null);
                    return Array.isArray(arr) ? arr.filter(x => x && (x.fileName || x.projectName)) : [];
                } catch (e) { return []; }
            };
            const writeRecentProjects = (list) => {
                const clean = list.slice(0, 3);
                try {
                    StorageDB.setJSON(RECENT_PROJECTS_KEY, clean);
                } catch (e) { /* 忽略存储异常 */ }
            };
            const recordRecentProject = ({ fileName = '', projectName = '', clientName = '', state = null }) => {
                const name = String(projectName || '').trim() || String(fileName || '').replace(/\.(tcalc|json)$/i, '') || '未命名工程';
                const fName = String(fileName || '').trim() || `${name}${PROJECT_FILE_EXT}`;
                const stObj = state || getProjectState({ includeUnderlay: false });
                // 最近工程缓存不含底图，避免数据库体积膨胀
                const slimState = projectStateValid(stObj)
                    ? { floorsEnabled: !!stObj.floorsEnabled, currentFloorId: stObj.currentFloorId, floors: stObj.floors.map(fl => ({ id: fl.id, name: fl.name, state: fl.state })) }
                    : stObj;
                const item = {
                    fileName: fName,
                    projectName: name,
                    clientName: String(clientName || '').trim(),
                    roomCount: countProjectRooms(slimState),
                    savedAt: Date.now(),
                    state: slimState
                };
                const prev = readRecentProjects().filter(x => x.fileName !== item.fileName || x.projectName !== item.projectName);
                writeRecentProjects([item, ...prev]);
            };
            _recordRecentProjectHook = recordRecentProject;
            const formatWelcomeDateTime = (ts) => {
                const t = Number(ts) || 0;
                if (!t) return '';
                const d = new Date(t);
                const pad = n => String(n).padStart(2, '0');
                return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
            };
            const MINI_PLAN_SVG = '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.35"><rect x="4" y="4" width="24" height="24" rx="1.5"/><path d="M4 15h11v13M15 4v7h13M10 15v5M21 11v8" opacity="0.72"/><line x1="8" y1="8" x2="12" y2="8" stroke-dasharray="1.5 1.5" opacity="0.55"/></svg>';
            const renderRecentProjects = (draft = readDraft()) => {
                const grid = $id('ws-recent-grid');
                if (!grid) return;
                // 3 格布局：前 2 格放草稿 / 最近工程 / 打开本地工程，第 3 格固定为「联系作者」
                const recents = readRecentProjects().slice(0, draft ? 1 : 2);
                grid.innerHTML = '';

                const createSlotWrap = () => {
                    const wrap = document.createElement('div');
                    wrap.className = 'ws-recent-slot';
                    return wrap;
                };

                if (draft) {
                    const wrap = createSlotWrap();
                    const title = draft.projectName ? String(draft.projectName).trim() : '未保存工程草稿';
                    const timeStr = formatWelcomeDateTime(draft.savedAt);
                    wrap.innerHTML = `
                        <button id="m-resume-draft" type="button" class="ws-slot-btn" title="恢复继续编辑 (R)">
                            <span class="ws-slot-thumb is-draft">${MINI_PLAN_SVG}</span>
                            <span class="ws-slot-info">
                                <span class="ws-slot-title-row">
                                    <span class="ws-slot-title">${escapeHtmlText(title)}</span>
                                    <span class="ws-draft-badge">草稿</span>
                                </span>
                                <span class="ws-slot-meta">${escapeHtmlText(timeStr || '自动保存')}</span>
                            </span>
                        </button>
                        <button id="ws-draft-del" type="button" class="ws-draft-del" title="删除草稿" aria-label="删除草稿">
                            <i class="ph ph-trash"></i>
                        </button>`;
                    wrap.querySelector('#m-resume-draft').addEventListener('click', () => {
                        closeWelcomeModal();
                        restoreDraft();
                    });
                    wrap.querySelector('#ws-draft-del').addEventListener('click', async (e) => {
                        e.stopPropagation();
                        const ok = await UiDialogs.confirm({
                            title: '删除草稿',
                            message: '确定删除上次未保存的工程草稿吗？',
                            detail: '删除后无法恢复，已保存的工程文件不受影响。',
                            okText: '删除',
                            danger: true
                        });
                        if (!ok) return;
                        clearTimeout(draftTimer);
                        try { StorageDB.remove(DRAFT_KEY); } catch (err) { /* 存储不可用时忽略 */ }
                        renderRecentProjects(null);
                        showToast('已删除草稿');
                    });
                    grid.appendChild(wrap);
                }

                recents.forEach((it) => {
                    const wrap = createSlotWrap();
                    const title = (it.projectName || it.fileName || '未命名工程').replace(/\.(tcalc|json)$/i, '');
                    const timeStr = formatWelcomeDateTime(it.savedAt);
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'ws-slot-btn';
                    btn.title = it.fileName || title;
                    btn.innerHTML = `
                        <span class="ws-slot-thumb">${MINI_PLAN_SVG}</span>
                        <span class="ws-slot-info">
                            <span class="ws-slot-title-row"><span class="ws-slot-title">${escapeHtmlText(title)}</span></span>
                            <span class="ws-slot-meta">${escapeHtmlText(timeStr || `${it.roomCount || 0} 个空间`)}</span>
                        </span>`;
                    btn.addEventListener('click', async () => {
                        if (projectStateValid(it.state)) {
                            closeWelcomeModal();
                            if (!(await confirmSaveBeforeReplace(`打开最近工程「${it.projectName || it.fileName}」`))) return;
                            STATE.currentFilePath = null;
                            STATE.currentFileRevision = null;
                            $id('project-name-input').value = it.projectName || '';
                            if ($id('client-name-input')) $id('client-name-input').value = it.clientName || '';
                            loadProjectState(it.state);
                            resetHistory();
                            fitCanvasToContent();
                            render();
                            showToast(`已打开工程「${it.projectName || it.fileName}」`);
                        } else {
                            showToast(`请选择本地工程文件「${it.fileName || it.projectName}」打开`);
                            openLocalProjectFile();
                        }
                    });
                    wrap.appendChild(btn);
                    grid.appendChild(wrap);
                });

                const totalShown = (draft ? 1 : 0) + recents.length;
                if (totalShown < 2) {
                    const wrap = createSlotWrap();
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'ws-slot-btn';
                    btn.title = `从本地打开 ${PROJECT_FILE_EXT} 工程文件 (O)`;
                    btn.innerHTML = `
                        <span class="ws-slot-thumb"><i class="ph ph-folder-open text-2xl"></i></span>
                        <span class="ws-slot-info">
                            <span class="ws-slot-title-row"><span class="ws-slot-title">打开本地工程</span></span>
                            <span class="ws-slot-meta">导入 ${PROJECT_FILE_EXT} 文件</span>
                        </span>`;
                    btn.addEventListener('click', () => {
                        closeWelcomeModal();
                        openLocalProjectFile();
                    });
                    wrap.appendChild(btn);
                    grid.appendChild(wrap);
                }

                // 第 3 格固定放置「联系作者」（2026年11月30日后显示）
                if (shouldShowContactAuthor()) {
                    const wrap = createSlotWrap();
                    const btn = document.createElement('button');
                    btn.id = 'ws-contact-author';
                    btn.type = 'button';
                    btn.className = 'ws-slot-btn';
                    btn.title = '扫码联系作者 / 咨询反馈';
                    btn.innerHTML = `
                        <span class="ws-slot-thumb"><i class="ph ph-chat-circle-dots text-2xl"></i></span>
                        <span class="ws-slot-info">
                            <span class="ws-slot-title-row"><span class="ws-slot-title">联系作者</span></span>
                            <span class="ws-slot-meta">扫码咨询 / 反馈建议</span>
                        </span>`;
                    btn.addEventListener('click', openContactAuthorModal);
                    wrap.appendChild(btn);
                    grid.appendChild(wrap);
                }
            };

            $id('btn-save-json').addEventListener('click', () => saveCurrentProjectFile());

            // 联系作者入口（顶部栏 + 欢迎页）：2026年11月30日后（2026-12-01 起）显示
            function shouldShowContactAuthor() {
                return Date.now() >= new Date(2026, 11, 1, 0, 0, 0).getTime();
            }

            function openContactAuthorModal() {
                const modal = $id('contact-author-modal');
                if (!modal) return;
                const img = $id('contact-author-qr');
                const fb = $id('contact-author-qr-fallback');
                if (img && fb) {
                    img.classList.remove('hidden');
                    fb.classList.add('hidden');
                    img.onerror = () => {
                        img.classList.add('hidden');
                        fb.classList.remove('hidden');
                    };
                    img.onload = () => {
                        img.classList.remove('hidden');
                        fb.classList.add('hidden');
                    };
                }
                modal.classList.remove('hidden');
            }
            function closeContactAuthorModal() {
                $id('contact-author-modal')?.classList.add('hidden');
            }
            (function initContactAuthorModal() {
                const topBtn = $id('btn-contact-author');
                if (topBtn) {
                    topBtn.classList.toggle('hidden', !shouldShowContactAuthor());
                    topBtn.addEventListener('click', openContactAuthorModal);
                }
                const modal = $id('contact-author-modal');
                if (!modal) return;
                $id('btn-close-contact-author')?.addEventListener('click', closeContactAuthorModal);
                modal.addEventListener('mousedown', (e) => { if (e.target === modal) closeContactAuthorModal(); });
            })();

            function openWelcomeModal() {
                const ws = $id('welcome-screen');
                $id('modal-backdrop').classList.add('hidden');
                renderRecentProjects(readDraft());
                ws.classList.remove('ws-hidden');
            }
            $id('btn-titlebar-brand')?.addEventListener('click', openWelcomeModal);
            $id('btn-titlebar-brand')?.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openWelcomeModal();
                }
            });
            function closeWelcomeModal() {
                $id('welcome-screen').classList.add('ws-hidden');
            }
            window._closeWelcomeModal = closeWelcomeModal;
            (function initWelcomeScreen() {
                const ws = $id('welcome-screen');
                const actions = {
                    'm-start-draw': newProject,
                    'm-open-cv-import': () => { requestCvRecognitionModal(); },
                    'm-load-std': openExamples,
                    'ws-open-frame': () => { $id('btn-frame-editor')?.click(); },
                    'ws-open-guide': () => { $id('btn-open-help').click(); }
                };
                Object.keys(actions).forEach(id => {
                    const el = $id(id);
                    if (el) el.addEventListener('click', () => { closeWelcomeModal(); actions[id](); });
                });
                $id('ws-close').addEventListener('click', closeWelcomeModal);
                ws.addEventListener('mousedown', (e) => { if (e.target === ws) closeWelcomeModal(); });
                const chk = $id('ws-show-startup');
                try { chk.checked = StorageDB.get('tilecalc.hideWelcome') !== '1'; } catch (err) {}
                chk.addEventListener('change', () => {
                    try { StorageDB.set('tilecalc.hideWelcome', chk.checked ? '0' : '1'); } catch (err) {}
                });
                window.addEventListener('keydown', (e) => {
                    if (ws.classList.contains('ws-hidden')) return;
                    if (document.querySelector('.ui-dialog-mask:not(.hidden)')) return;   // 确认框打开时交给对话框处理
                    if (e.ctrlKey || e.metaKey || e.altKey) return;
                    const map = { n: 'm-start-draw', i: 'm-open-cv-import', e: 'm-load-std', r: 'm-resume-draft' };
                    const k = (e.key || '').toLowerCase();
                    if (k === 'o') { e.preventDefault(); e.stopImmediatePropagation(); closeWelcomeModal(); openLocalProjectFile(); return; }
                    if (k === 'escape') {
                        e.preventDefault();
                        e.stopImmediatePropagation();
                        const um = $id('app-update-modal');
                        if (um && !um.classList.contains('hidden')) { $id('btn-close-app-update')?.click(); return; }
                        const cm = $id('contact-author-modal');
                        if (cm && !cm.classList.contains('hidden')) { closeContactAuthorModal(); return; }
                        closeWelcomeModal();
                        return;
                    }
                    if (map[k]) {
                        const target = $id(map[k]);
                        if (!target || !target.offsetParent) return;
                        e.preventDefault();
                        e.stopImmediatePropagation();
                        target.click();
                        return;
                    }
                    if (k === 'enter' || k === ' ' || k === 'tab') return;
                    e.stopImmediatePropagation();
                }, true);
            })();
            window._shouldShowWelcome = () => { try { return StorageDB.get('tilecalc.hideWelcome') !== '1'; } catch (err) { return true; } };

            $id('btn-open-preset').addEventListener('click', openExamples);
            window._openWelcomeModal = openWelcomeModal;

            $id('json-file-input').addEventListener('change', (e) => {
                const f = e.target.files && e.target.files[0];
                const skipConfirm = _skipNextFileInputConfirm;
                _skipNextFileInputConfirm = false;
                if (!f) return;
                const r = new FileReader();
                r.onload = async () => {
                    await openProjectTextContent(r.result, { fileName: f.name, skipConfirm });
                };
                r.readAsText(f);
                e.target.value = '';
            });


            async function openHelpPage() {
                if (typeof DesktopHost !== 'undefined' && DesktopHost.isDesktop() && DesktopHost.openChildWindow) {
                    const winRes = await DesktopHost.openChildWindow({
                        id: 'help',
                        url: 'help.html',
                        title: '操作指南与关于 — EasyTile',
                        width: 940,
                        height: 680
                    });
                    if (winRes && winRes.opened) return;
                }
                const modal = $id('help-modal');
                const iframe = $id('help-iframe');
                if (!modal || !iframe) {
                    window.open('help.html', '_blank', 'width=940,height=680');
                    return;
                }
                if (!iframe.getAttribute('src')) iframe.setAttribute('src', 'help.html');
                modal.classList.remove('hidden');
            }
            function closeHelpModal() {
                $id('help-modal')?.classList.add('hidden');
            }
            $id('btn-open-help').addEventListener('click', openHelpPage);
            $id('btn-close-help-modal')?.addEventListener('click', closeHelpModal);
            $id('help-modal')?.addEventListener('mousedown', (e) => { if (e.target.id === 'help-modal') closeHelpModal(); });
            window.addEventListener('message', (e) => {
                if (e.data && e.data.type === 'easytile:close-help') closeHelpModal();
            });

            $id('btn-close-generic-modal').addEventListener('click', () => {
                $id('modal-backdrop').classList.add('hidden');
            });

            $id('btn-rotate-3d').addEventListener('click', () => {
                isoYawAngle += Math.PI / 4;
                render3DIsometricPreview();
            });
            const c3d = $id('iso-3d-canvas');
            const to3dCoords = (e) => {
                const r = c3d.getBoundingClientRect();
                return {
                    sx: (e.clientX - r.left) * (c3d.width / Math.max(1, r.width)),
                    sy: (e.clientY - r.top) * (c3d.height / Math.max(1, r.height))
                };
            };
            let drag3d = false, lastX3d = 0, startX3d = 0, startY3d = 0, moved3d = false;
            c3d.addEventListener('mousedown', e => {
                if (e.button !== 0) return;
                drag3d = true; moved3d = false;
                lastX3d = e.clientX; startX3d = e.clientX; startY3d = e.clientY;
            });
            c3d.addEventListener('mouseleave', () => {
                if (!drag3d && typeof Elevation !== 'undefined' && Elevation.setHover3D) {
                    Elevation.setHover3D(null);
                    c3d.style.cursor = 'grab';
                }
            });
            window.addEventListener('mousemove', e => {
                if (drag3d) {
                    if (Math.hypot(e.clientX - startX3d, e.clientY - startY3d) > 4) moved3d = true;
                    isoYawAngle += (e.clientX - lastX3d) * 0.012;
                    lastX3d = e.clientX;
                    c3d.style.cursor = 'grabbing';
                    render3DIsometricPreview();
                    return;
                }
                if (e.target === c3d && typeof Elevation !== 'undefined' && Elevation.hit3D) {
                    const { sx, sy } = to3dCoords(e);
                    const hit = Elevation.hit3D(sx, sy);
                    c3d.style.cursor = hit ? 'pointer' : 'grab';
                    Elevation.setHover3D(hit);
                }
            });
            window.addEventListener('mouseup', e => {
                if (!drag3d) return;
                drag3d = false;
                c3d.style.cursor = 'grab';
                if (!moved3d && typeof Elevation !== 'undefined' && Elevation.hit3D) {
                    const { sx, sy } = to3dCoords(e);
                    const hit = Elevation.hit3D(sx, sy);
                    if (hit && Elevation.selectFace) {
                        Elevation.setHover3D(null);
                        Elevation.selectFace(hit.roomId, hit.faceKey);
                    }
                }
            });
        }

        /** 由 presets.json 生成的界面元素：空间命名快捷标签、常用墙厚菜单、工程名默认值 */
        function renderPresetUi() {
            const tags = $id('room-name-presets');
            if (tags) tags.innerHTML = PRESETS.roomNames.map(n => `<button type="button" class="room-preset-tag chip">${escapeHtmlText(n)}</button>`).join('');
            const thMenu = $id('wall-thickness-menu');
            if (thMenu) thMenu.insertAdjacentHTML('beforeend', PRESETS.draw.wallThicknessOptions.map(o => `
                <button type="button" class="combo-dropdown-item font-mono" data-val="${Number(o.mm)}">
                    <span class="font-bold text-slate-800">${Number(o.mm)} mm</span>
                    <span class="text-[11px] text-slate-400">${escapeHtmlText(o.label || '')}</span>
                </button>`).join(''));
            const thInput = $id('wall-thickness-input');
            if (thInput) thInput.value = PRESETS.draw.wallThicknessMM;
            const nameInput = $id('project-name-input');
            if (nameInput && !nameInput.value) nameInput.value = PRESETS.project.defaultName;
            STATE.floorHeightMM = PRESETS.wall.floorHeightMM;
        }

        /** 启动失败（预设 / 花色 JSON 读取失败）：页面上直接给出原因 */
        function showBootError(err) {
            console.error('[启动]', err);
            const box = document.createElement('div');
            box.className = 'boot-error';
            box.innerHTML = `<b>启动失败：预设数据读取失败</b><span>${escapeHtmlText(String(err && err.message || err))}</span>
                <span>请检查 assets/data/presets.json 与 materials.json 是否存在且为合法 JSON，并通过 HTTP 服务或 WebView2 虚拟主机打开（不支持 file://）。</span>`;
            document.body.appendChild(box);
        }

        window.addEventListener('DOMContentLoaded', async () => {
            try {
                await Promise.all([
                    StorageDB.init(),
                    PresetLib.load(),
                    MaterialLib.init()
                ]);
            } catch (err) {
                showBootError(err);
                return;
            }
            renderPresetUi();
            resizeCanvas();
            updateZoomText();
            updateHistoryButtons();
            updateTitleBar();
            $id('project-name-input').addEventListener('input', () => { updateTitleBar(); markDirty(); });
            $id('client-name-input')?.addEventListener('input', markDirty);
            window.addEventListener('beforeunload', (e) => {
                if (!STATE.dirty) return;
                saveDraft();
                if (typeof DesktopHost !== 'undefined' && DesktopHost.isDesktop()) return;
                e.preventDefault();
                e.returnValue = '';
            });
            bindEvents();
            Units.init();
            Elevation.init();
            SidePanel.initStaticCards(document.querySelector('.workstation-sidebar-left'));   // 左侧卡片折叠（与立面卡片共用）
            syncUnderlayUiState();
            initRoomSelectorDropdown();
            refreshViews({ panel: true, results: true, preview3d: true });
            const hostInit = await initDesktopHostIntegration();
            if (typeof MaterialLib !== 'undefined' && MaterialLib.onTexturesReady) {
                MaterialLib.onTexturesReady(() => {
                    refreshViews({ panel: true, inspector: true, preview3d: true, canvas: true });
                    if (typeof Elevation !== 'undefined' && Elevation.isActive && Elevation.isActive() && Elevation.render) {
                        Elevation.render();
                    }
                    if (typeof StylePicker !== 'undefined' && StylePicker.isOpen && StylePicker.isOpen() && StylePicker.redraw) {
                        StylePicker.redraw();
                    }
                });
            }
            if (!(hostInit && hostInit.hasLaunchFile) && window._openWelcomeModal && (!window._shouldShowWelcome || window._shouldShowWelcome())) {
                window._openWelcomeModal();
            }
        });

        async function initDesktopHostIntegration() {
            if (typeof DesktopHost === 'undefined' || !DesktopHost.isDesktop()) return { hasLaunchFile: false };
            const hb = window.HostBridge;
            if (!hb) return { hasLaunchFile: false };

            // 1. 同步主窗口最大化 / 还原按钮图标与提示
            const syncMaxButton = (winState) => {
                const btn = $id('btn-win-max');
                if (!btn) return;
                const isMax = winState === 'maximized' || winState === 'fullscreen';
                const icon = btn.querySelector('i');
                if (icon) icon.className = isMax ? 'ph ph-copy-simple' : 'ph ph-square';
                const label = isMax ? '还原窗口' : '最大化';
                btn.title = label;
                btn.setAttribute('aria-label', label);
            };
            if (hb.window && typeof hb.window.getState === 'function') {
                hb.window.getState().then(syncMaxButton).catch(() => {});
            }
            if (typeof hb.onWindowStateChange === 'function') {
                hb.onWindowStateChange(syncMaxButton);
            }
            updateTitleBar();

            // 2. 子窗体消息监听（报价单、图框编辑器）
            DesktopHost.onChildEvent((ev) => {
                if (!ev) return;
                if (ev.event === 'message' && typeof window._handleDesktopChildMessage === 'function') {
                    window._handleDesktopChildMessage(ev.payload, ev.from || ev.id);
                }
            });

            // 3. 关闭守卫：有未保存改动时先保存草稿并弹出三态保存确认框
            if (hb.files && typeof hb.files.setCloseGuard === 'function') {
                hb.files.setCloseGuard(async () => {
                    if (!STATE.dirty) return true;
                    saveDraft();
                    const projName = ($id('project-name-input')?.value || '').trim() || PRESETS.project.defaultName || '当前工程';
                    const choice = await UiDialogs.confirmSave({
                        title: '退出前是否保存工程？',
                        message: `工程「${projName}」未保存，退出前是否保存文件？`,
                        detail: '点击“保存并退出”将先保存工程文件；点击“不保存”将直接退出程序。',
                        okText: '保存并退出',
                        altText: '不保存',
                        cancelText: '取消',
                        icon: 'ph-floppy-disk'
                    });
                    if (choice === 'save') {
                        return await saveCurrentProjectFile();
                    }
                    return choice === 'discard';
                }).catch(() => {});
            }

            // 4. 文件关联启动 / 桌面图标拖放 / 窗体内拖放 .tcalc 工程文件打开
            let hasLaunchFile = false;
            let hostOpenQueue = Promise.resolve();
            const closeAllOverlaysForProjectOpen = () => {
                if (typeof window._closeWelcomeModal === 'function') window._closeWelcomeModal();
                $id('import-modal')?.classList.add('hidden');
                $id('modal-backdrop')?.classList.add('hidden');
                $id('contact-author-modal')?.classList.add('hidden');
                $id('help-modal')?.classList.add('hidden');
                if (typeof StylePicker !== 'undefined' && StylePicker.isOpen?.()) StylePicker.close();
            };
            const openFromHostPaths = (paths) => {
                if (!Array.isArray(paths) || !paths.length) return;
                const targetPath = paths.find(p => /\.(tcalc|json)$/i.test(String(p || '')));
                if (!targetPath) {
                    const first = String(paths[0] || '');
                    const name = first.split(/[\\/]/).pop() || first;
                    if (name) showToast(`暂不支持打开「${name}」，请拖入 .tcalc 工程文件`);
                    return;
                }
                hasLaunchFile = true;
                hostOpenQueue = hostOpenQueue.then(async () => {
                    try {
                        const res = await DesktopHost.readTextFile(targetPath);
                        if (res && res.content != null) {
                            const ok = await openProjectTextContent(res.content, {
                                fileName: res.name,
                                filePath: res.path,
                                revision: res.revision
                            });
                            if (ok) closeAllOverlaysForProjectOpen();
                        }
                    } catch (err) {
                        showToast('打开工程失败：' + (err?.message || err));
                    }
                });
            };
            DesktopHost.onFileOpen(openFromHostPaths);
            DesktopHost.enableFileDrop(document.body, (err) => {
                if (err && err.message) showToast(err.message);
            });

            // 窗体拖入工程文件时的视觉提示（花色库/识图弹窗有自己的图片拖入区，避免互相遮挡）
            const dropOverlay = $id('project-drop-overlay');
            if (dropOverlay) {
                let dragDepth = 0;
                const isOwnImageDropOpen = () =>
                    (typeof StylePicker !== 'undefined' && StylePicker.isOpen?.()) ||
                    !$id('import-modal')?.classList.contains('hidden');
                const hideDropOverlay = () => { dragDepth = 0; dropOverlay.classList.add('hidden'); };
                document.addEventListener('dragenter', (e) => {
                    if (isOwnImageDropOpen()) return;
                    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
                        dragDepth++;
                        dropOverlay.classList.remove('hidden');
                    }
                });
                document.addEventListener('dragleave', () => {
                    dragDepth = Math.max(0, dragDepth - 1);
                    if (dragDepth === 0) dropOverlay.classList.add('hidden');
                });
                document.addEventListener('drop', hideDropOverlay, true);
                window.addEventListener('blur', hideDropOverlay);
            }

            // 通知宿主文件监听就绪；宿主会先下发启动命令行传入的 .tcalc 文件，再返回 ready 应答
            try {
                await Promise.race([
                    DesktopHost.signalFilesReady(),
                    new Promise(resolve => setTimeout(resolve, 400))
                ]);
            } catch (e) {}

            // 5. 软件更新通知弹窗：宿主在启动 5 秒后检测到新版本会下发 app_update_available
            let pendingUpdateNotice = null;
            const updateModal = $id('app-update-modal');
            const closeUpdateModal = () => {
                updateModal?.classList.add('hidden');
            };
            const showAppUpdateModal = (notice) => {
                if (!notice || !notice.latestVersion || !notice.downloadUrl || !updateModal) return;
                let skipped = '';
                try { skipped = StorageDB.get('tilecalc.skippedUpdateVersion') || ''; } catch (e) {}
                if (skipped && skipped === notice.latestVersion) return;

                pendingUpdateNotice = notice;
                const curEl = $id('upd-cur-ver');
                const newEl = $id('upd-new-ver');
                const notesEl = $id('upd-notes');
                if (curEl) curEl.textContent = 'v' + String(notice.currentVersion || '1.0.0.0').replace(/^v/i, '');
                if (newEl) newEl.textContent = 'v' + String(notice.latestVersion).replace(/^v/i, '');
                if (notesEl) notesEl.textContent = (notice.releaseNotes || '').trim() || '包含功能优化与问题修复，建议前往下载最新版本。';
                updateModal.classList.remove('hidden');
            };

            if (updateModal) {
                $id('btn-close-app-update')?.addEventListener('click', closeUpdateModal);
                $id('btn-upd-later')?.addEventListener('click', closeUpdateModal);
                $id('btn-upd-skip')?.addEventListener('click', () => {
                    if (pendingUpdateNotice && pendingUpdateNotice.latestVersion) {
                        try { StorageDB.set('tilecalc.skippedUpdateVersion', pendingUpdateNotice.latestVersion); } catch (e) {}
                        showToast(`已跳过版本 v${pendingUpdateNotice.latestVersion}`);
                    }
                    closeUpdateModal();
                });
                $id('btn-upd-download')?.addEventListener('click', async () => {
                    const url = pendingUpdateNotice && pendingUpdateNotice.downloadUrl;
                    if (!url) return;
                    const btn = $id('btn-upd-download');
                    if (btn) btn.disabled = true;
                    try {
                        await DesktopHost.openExternalUrl(url);
                        closeUpdateModal();
                    } catch (err) {
                        showToast('打开下载链接失败：' + (err?.message || err));
                    } finally {
                        if (btn) btn.disabled = false;
                    }
                });
            }
            DesktopHost.onUpdateAvailable(showAppUpdateModal);
            return { hasLaunchFile };
        }
