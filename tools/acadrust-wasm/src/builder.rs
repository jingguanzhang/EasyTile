//! # 绘图构建接口 (TileCalc 扩展)
//!
//! 由 JS 端传入一份精简的 JSON「绘图描述」，在 acadrust 中直接创建
//! `CadDocument`（图层 / 线型 / 文字样式 / 实体 / 原生表格），再由 acadrust
//! 写出 DXF 或 DWG。JS 端不再需要自行拼写 DXF 组码。
//!
//! JSON 结构（坐标单位为图纸单位，角度为度）：
//!
//! ```json
//! {
//!   "insunits": 4,
//!   "layers":   [["WALL", 8, "CONTINUOUS"], ...],          // 名称、ACI 颜色、线型
//!   "styles":   [["STANDARD", "SimHei", "simhei.ttf"], ...], // 文字样式、TrueType 字体名、字体文件
//!   "entities": [
//!     {"t":"L",  "l":"WALL", "lt":"DASHED", "p":[x1,y1,x2,y2]},
//!     {"t":"P",  "l":"WALL", "c":true, "p":[x,y,x,y,...], "w":[w0,w1,...]},
//!     {"t":"C",  "l":"ORIG", "p":[cx,cy], "r":10},
//!     {"t":"T",  "l":"MARK", "p":[x,y], "h":40, "s":"文字", "r":90, "col":2, "st":"STANDARD"},
//!     {"t":"S",  "l":"WALL", "col":5, "p":[x1,y1,x2,y2,x3,y3,x4,y4], "g":"img-1"},
//!     {"t":"MT", "l":"NOTE", "p":[x,y], "h":3, "s":"第一行\n第二行", "w":60, "al":1, "ls":1.0, "r":0, "col":7, "st":"STANDARD"},
//!     {"t":"IM", "l":"TK_IMAGE", "p":[左上x,左上y], "w":宽, "h":高, "gw":格数, "gh":格数, "px":"<base64 RGBA>"},
//!     {"t":"TB", "l":"BOM", "col":2, "p":[x,y], "cw":[..], "rh":[..], "cells":[[..]], "th":140,
//!      "pad":[横向内边距, 竖向内边距], "al":[[5,..],..], "ch":[[h,..],..], "cc":[[7,..],..]}
//!   ],
//!   "dims": [{"layer":"FLOOR_PLAN","bx":..,"by":..,"def1x":..,"def1y":..,"def2x":..,"def2y":..,
//!             "tcX":..,"tcY":..,"tx":..,"ty":..,"h":95,"rot":0,"text":"3600","lines":[[x1,y1,x2,y2],..]}]
//! }
//! ```
//!
//! 尺寸标注 (dims) 写成匿名块 `*Dn` + 原生 DIMENSION，标注样式 Standard 同步为公制参数（见 [`add_dimensions`]）。
//!
//! 填充 (S) 带 `g` 时，同一 `g` 的所有 SOLID 放进同一个图块 `TK_IMAGE_n`（n 按出现顺序编号），
//! 在模型空间插入一次：一张图片在 CAD 中是一个可整体选中 / 删除的块参照。
//!
//! 图片 (IM) 传入已缩放到 gw × gh 的 RGBA 像素：每格匹配最近的 AutoCAD 索引色、透明格跳过，
//! 同色行程横向合并、再纵向合并为矩形，写成 SOLID 放进图块 `TK_IMAGE_n`（基点 = 图片左上角）并插入一次。
//!
//! 单行文字 (T) 统一按「左下基线」写入 (JS 端已按字体字宽计算好位置)。
//!
//! 屏幕口径 (`"em": true`，图框编辑器使用)：T / MT / TB 的字高是网页字号 (em)，本模块按黑体字形
//! 换算成 CAD 字高 (A 高 = 0.695 em，见 [`font`])；MT 的 `p` 是首行行框顶边、`lh` 是屏幕行高；
//! TB 的 `bx` 是逐格内边距 [上, 左, 下, 右]（到文字行框），写成单元格级内边距覆盖。
//!
//! 多行文字 (MT) 写成 MTEXT 文本框：`p` 为附着点坐标，`al` 附着点 (1~9，默认 1 左上)，
//! `w` 文本框参考宽度 (0 = 不限宽、不自动换行)，`ls` 行距比例 (默认 1.0)，文字中的 `\n` 为换行。
//!
//! 表格 (TB) 写成 ACAD_TABLE 原生表格，整个排版在本模块完成（见 [`table_layout`]）：
//! - `pad` 单元格内边距，省略时按字高自动取；`al` 单元格对齐 (1~9，同 MTEXT 附着点，默认 5 居中)；
//!   `ch` 单元格最大字高 (默认 `th`)；`cc` 单元格文字颜色 (默认 `col`)；文字中的 `\n` 为换行。
//! - 每格字高按保守字宽自动缩小到能放进「格宽 − 2×内边距」，单元格数据 (140/170/64)、
//!   表格样式与表格级内边距覆盖 (40/41) 写入同样的值；
//! - 匿名块 `*T` 的显示图形用与 CAD 重新生成表格时相同的方式写出：网格线 + 每格一个 MTEXT，
//!   附着点 = 单元格对齐，参考宽度 = 格宽 − 2×内边距。居中 / 靠右由 CAD 按真实字宽计算，
//!   所以打开即显示正确，不必再双击编辑表格才刷新。

use acadrust::entities::table::LegacyTableStyleOverride;
use acadrust::entities::{
    AttachmentPoint, CellStyle, CellStylePropertyFlags, Circle, Dimension, DimensionAligned, EntityType, Insert, Line, LwPolyline, LwVertex, MText, Solid, Table, TableCell, Text,
};
use acadrust::objects::{CellAlignment, ObjectType};
use acadrust::tables::linetype::LineTypeElement;
use acadrust::types::{Color, DxfVersion, Vector2, Vector3};
use acadrust::{BlockRecord, CadDocument, Layer, LineType, TextStyle};
use serde::Deserialize;

#[derive(Deserialize)]
pub struct DrawingSpec {
    #[serde(default = "default_units")]
    insunits: i16,
    #[serde(default)]
    layers: Vec<(String, i16, String)>,
    #[serde(default)]
    styles: Vec<(String, String, String)>,
    #[serde(default)]
    entities: Vec<EntitySpec>,
    /// 屏幕口径字体：[样式名, TrueType 字体名, 字体文件, 大写字母高/em, 上升/em, 下降/em]（见 [`font::Metric`]）
    #[serde(default)]
    fonts: Vec<(String, String, String, f64, f64, f64)>,
    /// 对齐尺寸标注（几何已由 JS 按字体字宽算好，见 [`DimSpec`]）
    #[serde(default)]
    dims: Vec<DimSpec>,
}

/// 对齐尺寸标注：写成匿名块 `*Dn`（尺寸线、两端短刻度线、标注文字，颜色随块）
/// + 原生 DIMENSION (AcDbAlignedDimension)，并把标注样式 Standard 调成与之一致的公制参数。
#[derive(Deserialize)]
pub struct DimSpec {
    #[serde(default)]
    layer: Option<String>,
    /// 尺寸线上的定义点 (DXF 10)
    bx: f64,
    by: f64,
    /// 两条尺寸界线原点 (DXF 13 / 14)
    def1x: f64,
    def1y: f64,
    def2x: f64,
    def2y: f64,
    /// 文字中点 (DXF 11)
    #[serde(rename = "tcX")]
    tc_x: f64,
    #[serde(rename = "tcY")]
    tc_y: f64,
    /// 块内单行文字左下基线位置
    tx: f64,
    ty: f64,
    h: f64,
    #[serde(default)]
    rot: f64,
    #[serde(default)]
    text: String,
    #[serde(default)]
    lines: Vec<[f64; 4]>,
}

fn default_units() -> i16 {
    4
}

#[derive(Deserialize)]
#[serde(tag = "t")]
enum EntitySpec {
    #[serde(rename = "L")]
    Line { l: String, #[serde(default)] lt: Option<String>, p: [f64; 4] },
    #[serde(rename = "P")]
    Poly {
        l: String,
        #[serde(default)]
        lt: Option<String>,
        #[serde(default)]
        c: bool,
        p: Vec<f64>,
        #[serde(default)]
        w: Option<Vec<f64>>,
    },
    #[serde(rename = "C")]
    Circle { l: String, p: [f64; 2], r: f64 },
    #[serde(rename = "T")]
    Text {
        l: String,
        p: [f64; 2],
        h: f64,
        s: String,
        /// true：`h` 是屏幕字号 (em)，按黑体字形换算成 CAD 字高（见 [`font`]）
        #[serde(default)]
        em: bool,
        #[serde(default)]
        r: f64,
        #[serde(default)]
        col: Option<i16>,
        #[serde(default)]
        st: Option<String>,
        /// 屏幕口径字体样式名（`fonts` 中登记，省略 = TK_TEXT 黑体）
        #[serde(default)]
        ff: Option<String>,
        /// 真彩色 0xRRGGBB（优先于 `col`）
        #[serde(default)]
        rgb: Option<i32>,
    },
    #[serde(rename = "MT")]
    MText {
        l: String,
        p: [f64; 2],
        h: f64,
        s: String,
        #[serde(default)]
        w: f64,
        #[serde(default)]
        al: Option<i16>,
        #[serde(default)]
        ls: Option<f64>,
        /// true：`h` 是屏幕字号 (em)、`p` 是首行行框顶边 (附着点 1~3) / 末行行框底边 (7~9)
        #[serde(default)]
        em: bool,
        /// 屏幕行高倍数 (CSS line-height)，仅 `em` 时有效，换算成 MTEXT 行距比例
        #[serde(default)]
        lh: Option<f64>,
        #[serde(default)]
        r: f64,
        #[serde(default)]
        col: Option<i16>,
        #[serde(default)]
        st: Option<String>,
        #[serde(default)]
        ff: Option<String>,
        #[serde(default)]
        rgb: Option<i32>,
        /// 字间距（MTEXT 跟踪系数 \T，1 = 正常，0.75~4）
        #[serde(default)]
        tr: Option<f64>,
    },
    #[serde(rename = "S")]
    Solid { l: String, #[serde(default)] col: Option<i16>, p: [f64; 8], #[serde(default)] g: Option<String> },
    /// 图片：RGBA 像素栅格 (base64) → ACI 色块 SOLID，合成一个图块 TK_IMAGE_n 插入一次（见 [`raster`]）
    #[serde(rename = "IM")]
    Image {
        l: String,
        /// 图片左上角
        p: [f64; 2],
        w: f64,
        h: f64,
        gw: usize,
        gh: usize,
        px: String,
    },
    #[serde(rename = "TB")]
    Table {
        l: String,
        #[serde(default)]
        col: Option<i16>,
        p: [f64; 2],
        cw: Vec<f64>,
        rh: Vec<f64>,
        cells: Vec<Vec<String>>,
        #[serde(default = "default_th")]
        th: f64,
        #[serde(default)]
        pad: Option<[f64; 2]>,
        #[serde(default)]
        al: Vec<Vec<i16>>,
        #[serde(default)]
        ch: Vec<Vec<f64>>,
        #[serde(default)]
        cc: Vec<Vec<i16>>,
        /// true：`th` / `ch` 是屏幕字号 (em)，单元格文字行高为 [`font::CELL_LH`]
        #[serde(default)]
        em: bool,
        /// 单元格内边距 [上, 左, 下, 右]（格边到文字行框），覆盖表格级 `pad`
        #[serde(default)]
        bx: Vec<Vec<[f64; 4]>>,
        /// 单元格字体样式名（`fonts` 中登记，空串 = TK_TEXT 黑体）
        #[serde(default)]
        cf: Vec<Vec<String>>,
        /// 单元格真彩色 0xRRGGBB（-1 = 用 `cc`）
        #[serde(default)]
        crgb: Vec<Vec<i32>>,
        /// 单元格首行标签（堆叠式字段名），与内容写进同一个单元格 MTEXT
        #[serde(default)]
        lb: Vec<Vec<Option<LabelSpec>>>,
    },
}

/// 单元格内的字段名标签（首行）：字号 em、ACI 颜色
#[derive(Deserialize, Clone)]
pub struct LabelSpec {
    pub s: String,
    pub h: f64,
    #[serde(default)]
    pub col: Option<i16>,
}

fn default_th() -> f64 {
    140.0
}

fn v3(x: f64, y: f64) -> Vector3 {
    Vector3::new(x, y, 0.0)
}

fn set_common(e: &mut EntityType, layer: &str, ltype: Option<&str>, color: Option<i16>) {
    let c = e.common_mut();
    c.layer = layer.to_string();
    if let Some(lt) = ltype {
        c.linetype = lt.to_string();
    }
    if let Some(ci) = color {
        c.color = Color::from_index(ci);
    }
}

/// 真彩色 0xRRGGBB → acadrust 颜色（负数 / 省略 = 不覆盖）
fn rgb_color(v: Option<i32>) -> Option<Color> {
    v.filter(|c| *c >= 0).map(|c| Color::Rgb { r: ((c >> 16) & 0xff) as u8, g: ((c >> 8) & 0xff) as u8, b: (c & 0xff) as u8 })
}

fn make_text(layer: &str, x: f64, y: f64, h: f64, s: &str, rot_deg: f64, color: Option<i16>, style: &str) -> EntityType {
    let mut t = Text::with_value(s, v3(x, y));
    t.height = h;
    t.rotation = rot_deg.to_radians();
    t.style = style.to_string();
    let mut e = EntityType::Text(t);
    set_common(&mut e, layer, None, color);
    e
}

fn attachment(code: i16) -> AttachmentPoint {
    match code {
        1 => AttachmentPoint::TopLeft,
        2 => AttachmentPoint::TopCenter,
        3 => AttachmentPoint::TopRight,
        4 => AttachmentPoint::MiddleLeft,
        6 => AttachmentPoint::MiddleRight,
        7 => AttachmentPoint::BottomLeft,
        8 => AttachmentPoint::BottomCenter,
        9 => AttachmentPoint::BottomRight,
        _ => AttachmentPoint::MiddleCenter,
    }
}

fn line_type(name: &str, desc: &str, pattern: &[f64]) -> LineType {
    let mut lt = LineType::new(name);
    lt.description = desc.to_string();
    for &len in pattern {
        lt.add_element(if len >= 0.0 { LineTypeElement::dash(len) } else { LineTypeElement::space(-len) });
    }
    lt.pattern_length = pattern.iter().map(|v| v.abs()).sum();
    lt
}

/// 根据绘图描述创建 acadrust 文档。
pub fn build_document(spec: &DrawingSpec, version: DxfVersion) -> Result<CadDocument, String> {
    let mut doc = CadDocument::with_version(version);
    doc.header.insertion_units = spec.insunits;

    // 线型：虚线 / 点划线 (图纸单位下的花纹长度)
    doc.line_types.add_or_replace(line_type("DASHED", "__ __ __", &[100.0, -50.0]));
    doc.line_types.add_or_replace(line_type("CENTER", "____ _ ____", &[120.0, -30.0, 20.0, -30.0]));

    // 文字样式：绑定 TrueType 中文字体
    // 已存在的同名样式 (如内置 Standard，大小写不敏感) 原地改字体、保留原句柄与名称：
    // 内置标注样式 / 表格样式按句柄引用 Standard，整体替换会使引用失效，
    // AutoCAD 打开时报 Error 67 (AcDbDimStyleTableRecord) 并要求修复。
    for (name, ttf, file) in &spec.styles {
        if let Some(st) = doc.text_styles.get_mut(name.as_str()) {
            st.true_type_font = ttf.clone();
            st.font_file = file.clone();
        } else {
            let mut st = TextStyle::with_truetype(name.as_str(), ttf.as_str());
            st.font_file = file.clone();
            doc.text_styles.add_or_replace(st);
        }
    }

    // 屏幕口径文字 (em) 专用样式：TK_TEXT = 黑体，其余按 `fonts` 登记（宋体 / 楷体 / 微软雅黑 …）；
    // 样式名同时用于 PDF 转换识别「字高 = 大写字母高」
    let fonts = font::Fonts::from_spec(&spec.fonts);
    if doc.text_styles.get(font::EM_STYLE).is_none() {
        let mut st = TextStyle::with_truetype(font::EM_STYLE, "SimHei");
        st.font_file = "simhei.ttf".to_string();
        doc.text_styles.add_or_replace(st);
    }
    for (name, ttf, file, ..) in &spec.fonts {
        if name.eq_ignore_ascii_case(font::EM_STYLE) || doc.text_styles.get(name.as_str()).is_some() {
            continue;
        }
        let mut st = TextStyle::with_truetype(name.as_str(), ttf.as_str());
        st.font_file = file.clone();
        doc.text_styles.add_or_replace(st);
    }

    // 图层
    for (name, color, ltype) in &spec.layers {
        let mut ly = if name == "0" { Layer::layer_0() } else { Layer::new(name.as_str()) };
        ly.color = Color::from_index(*color);
        ly.line_type = ltype.clone();
        doc.layers.add_or_replace(ly);
    }

    let mut min = [f64::INFINITY; 2];
    let mut max = [f64::NEG_INFINITY; 2];
    let mut touch = |x: f64, y: f64| {
        if x.is_finite() && y.is_finite() {
            min[0] = min[0].min(x);
            min[1] = min[1].min(y);
            max[0] = max[0].max(x);
            max[1] = max[1].max(y);
        }
    };

    let mut table_seq = 0usize;
    // 图片色块分组：g → 图块记录句柄
    let mut solid_blocks: std::collections::HashMap<String, acadrust::types::Handle> = std::collections::HashMap::new();
    let mut image_seq = 0usize;
    let mut table_pad: Option<(f64, f64, f64)> = None;
    for ent in &spec.entities {
        match ent {
            EntitySpec::Line { l, lt, p } => {
                touch(p[0], p[1]);
                touch(p[2], p[3]);
                let mut e = EntityType::Line(Line::from_coords(p[0], p[1], 0.0, p[2], p[3], 0.0));
                set_common(&mut e, l, lt.as_deref(), None);
                doc.add_entity(e).map_err(|e| e.to_string())?;
            }
            EntitySpec::Poly { l, lt, c, p, w } => {
                if p.len() < 4 {
                    continue;
                }
                let mut pl = LwPolyline::new();
                for (i, xy) in p.chunks_exact(2).enumerate() {
                    touch(xy[0], xy[1]);
                    let mut v = LwVertex::new(Vector2::new(xy[0], xy[1]));
                    if let Some(ws) = w {
                        let wv = ws.get(i).copied().unwrap_or(0.0);
                        v.start_width = wv;
                        v.end_width = wv;
                    }
                    pl.vertices.push(v);
                }
                pl.is_closed = *c;
                let mut e = EntityType::LwPolyline(pl);
                set_common(&mut e, l, lt.as_deref(), None);
                doc.add_entity(e).map_err(|e| e.to_string())?;
            }
            EntitySpec::Circle { l, p, r } => {
                touch(p[0] - r, p[1] - r);
                touch(p[0] + r, p[1] + r);
                let mut e = EntityType::Circle(Circle::from_coords(p[0], p[1], 0.0, *r));
                set_common(&mut e, l, None, None);
                doc.add_entity(e).map_err(|e| e.to_string())?;
            }
            EntitySpec::Text { l, p, h, s, em, r, col, st, ff, rgb } => {
                touch(p[0], p[1]);
                let (fname, fm) = fonts.get(ff.as_deref());
                let hh = if *em { fm.cad_h(*h) } else { *h };
                let style = if *em { fname } else { st.as_deref().unwrap_or("STANDARD") };
                let mut e = make_text(l, p[0], p[1], hh, s, *r, *col, style);
                if let Some(c) = rgb_color(*rgb) {
                    e.common_mut().color = c;
                }
                doc.add_entity(e).map_err(|e| e.to_string())?;
            }
            EntitySpec::MText { l, p, h, s, w, al, ls, em, lh, r, col, st, ff, rgb, tr } => {
                touch(p[0], p[1]);
                let code = al.unwrap_or(1);
                let (fname, fm) = fonts.get(ff.as_deref());
                let (y, hh, lsf) = if *em {
                    let lh = lh.filter(|v| *v > 0.0).unwrap_or(fm.cell_lh());
                    let dy = match code { 1..=3 => -fm.top_inset(*h, lh), 7..=9 => fm.bottom_inset(*h, lh), _ => 0.0 };
                    (p[1] + dy, fm.cad_h(*h), fm.line_spacing_factor(lh))
                } else {
                    (p[1], *h, ls.filter(|v| *v > 0.0).unwrap_or(1.0))
                };
                let mut value = table_layout::mtext_value(s);
                if let Some(t) = tr.filter(|t| t.is_finite() && (t - 1.0).abs() > 1e-3) {
                    // 字间距：MTEXT 跟踪系数 \T（CAD 允许 0.75 ~ 4），整段生效，双击编辑后保持
                    value = format!("\\T{};{}", r3(t.clamp(0.75, 4.0)), value);
                }
                let mut m = MText::with_value(value, v3(p[0], y));
                m.height = hh;
                m.rectangle_width = w.max(0.0);
                m.attachment_point = attachment(code);
                m.style = if *em { fname } else { st.as_deref().unwrap_or("STANDARD") }.to_string();
                m.line_spacing_factor = lsf;
                if *em {
                    // 屏幕口径：行距「精确」，CAD 双击编辑后不会按字形高度重新放大行距、整段上移
                    m.line_spacing_style = acadrust::entities::LineSpacingStyle::Exactly;
                }
                m.rotation = r.to_radians();
                let mut e = EntityType::MText(Box::new(m));
                set_common(&mut e, l, None, *col);
                if let Some(c) = rgb_color(*rgb) {
                    e.common_mut().color = c;
                }
                doc.add_entity(e).map_err(|e| e.to_string())?;
            }
            EntitySpec::Solid { l, col, p, g } => {
                for xy in p.chunks_exact(2) {
                    touch(xy[0], xy[1]);
                }
                let mut e = EntityType::Solid(Solid::new(
                    v3(p[0], p[1]),
                    v3(p[2], p[3]),
                    v3(p[4], p[5]),
                    v3(p[6], p[7]),
                ));
                set_common(&mut e, l, None, *col);
                if let Some(key) = g.as_deref().filter(|k| !k.is_empty()) {
                    let owner = match solid_blocks.get(key) {
                        Some(h) => *h,
                        None => {
                            image_seq += 1;
                            let h = insert_block(&mut doc, &format!("TK_IMAGE_{image_seq}"), l, 0.0, 0.0)?;
                            solid_blocks.insert(key.to_string(), h);
                            h
                        }
                    };
                    e.common_mut().owner_handle = owner;
                }
                doc.add_entity(e).map_err(|e| e.to_string())?;
            }
            EntitySpec::Image { l, p, w, h, gw, gh, px } => {
                let rgba = raster::decode_base64(px)?;
                if *gw == 0 || *gh == 0 || rgba.len() < gw * gh * 4 {
                    return Err(format!("image raster size mismatch: {}x{} vs {} bytes", gw, gh, rgba.len()));
                }
                let rects = raster::aci_rects(&rgba, *gw, *gh);
                if rects.is_empty() {
                    continue;
                }
                touch(p[0], p[1]);
                touch(p[0] + w, p[1] - h);
                image_seq += 1;
                let owner = insert_block(&mut doc, &format!("TK_IMAGE_{image_seq}"), l, p[0], p[1])?;
                let (cw, chh) = (w / *gw as f64, h / *gh as f64);
                for rc in rects {
                    let x0 = r3(rc.i0 as f64 * cw);
                    let x1 = r3(rc.i1 as f64 * cw);
                    let yt = r3(-(rc.j0 as f64) * chh);
                    let yb = r3(-(rc.j1 as f64) * chh);
                    let mut e = EntityType::Solid(Solid::new(v3(x0, yt), v3(x1, yt), v3(x0, yb), v3(x1, yb)));
                    set_common(&mut e, l, None, Some(rc.c));
                    e.common_mut().owner_handle = owner;
                    doc.add_entity(e).map_err(|e| e.to_string())?;
                }
            }
            EntitySpec::Table { l, col, p, cw, rh, cells, th, pad, al, ch, cc, em, bx, cf, crgb, lb } => {
                table_seq += 1;
                let total_w: f64 = cw.iter().sum();
                let total_h: f64 = rh.iter().sum();
                touch(p[0], p[1]);
                touch(p[0] + total_w, p[1] - total_h);
                let cell_font = |r: usize, c: usize| fonts.get(cf.get(r).and_then(|row| row.get(c)).map(String::as_str).filter(|s| !s.is_empty()));
                let fm: Vec<Vec<font::Metric>> = (0..rh.len()).map(|r| (0..cw.len()).map(|c| cell_font(r, c).1).collect()).collect();
                let lay = table_layout::layout_full(cw, rh, cells, *th, *pad, al, ch, *em, bx, &fm, lb);
                if table_pad.is_none() {
                    table_pad = Some((lay.pad_x, lay.pad_y, if *em { font::cad_h(*th) } else { *th }));
                }
                let base_col = col.unwrap_or(2);
                let cell_col = |r: usize, c: usize| cc.get(r).and_then(|row| row.get(c)).copied().unwrap_or(base_col);
                let cell_color = |r: usize, c: usize| {
                    rgb_color(crgb.get(r).and_then(|row| row.get(c)).copied()).unwrap_or_else(|| Color::from_index(cell_col(r, c)))
                };
                let cell_style = |r: usize, c: usize| if *em { cell_font(r, c).0 } else { "STANDARD" };

                // 匿名块 *T：表格的显示图形 (坐标相对表格左上角)，与 CAD 重新生成表格的结果一致
                let mut br = BlockRecord::new(format!("*T{table_seq}"));
                br.handle = doc.allocate_handle();
                br.block_entity_handle = doc.allocate_handle();
                br.block_end_handle = doc.allocate_handle();
                let br_handle = br.handle;
                doc.block_records.add(br).map_err(|e| e.to_string())?;
                for g in table_layout::grid_lines(cw, rh) {
                    let mut e = EntityType::Line(Line::from_coords(g[0], g[1], 0.0, g[2], g[3], 0.0));
                    set_common(&mut e, l, None, *col);
                    e.common_mut().owner_handle = br_handle;
                    doc.add_entity(e).map_err(|e| e.to_string())?;
                }
                for tc in &lay.cells {
                    if tc.text.is_empty() {
                        continue;
                    }
                    let mut m = MText::with_value(tc.mtext.clone(), v3(tc.x, tc.y));
                    m.height = tc.h;
                    m.rectangle_width = tc.w;
                    m.attachment_point = attachment(tc.align);
                    m.style = cell_style(tc.row, tc.col).to_string();
                    m.line_spacing_factor = 1.0;
                    let mut e = EntityType::MText(Box::new(m));
                    set_common(&mut e, l, None, None);
                    e.common_mut().color = cell_color(tc.row, tc.col);
                    e.common_mut().owner_handle = br_handle;
                    doc.add_entity(e).map_err(|e| e.to_string())?;
                }

                // 原生表格实体 (可在 CAD 中用 TABLE 相关命令编辑)：单元格数据与显示图形使用同一套字高 / 对齐 / 内边距
                let mut t = Table::new(v3(p[0], p[1]), rh.len(), cw.len());
                for (i, w) in cw.iter().enumerate() {
                    t.columns[i].width = *w;
                }
                for (r, h) in rh.iter().enumerate() {
                    t.rows[r].height = *h;
                }
                for tc in &lay.cells {
                    // 单元格内容 = *T 显示图形里同一段 MTEXT（含首行标签格式码），CAD 重新生成表格时排版一致
                    let mut cell = TableCell::text(&tc.mtext);
                    // 单元格样式覆盖：对齐 / 文字颜色 / 文字样式 / 文字高度
                    let mut style = cell.style.take().unwrap_or_else(CellStyle::new);
                    style.alignment = tc.align as i32;
                    style.content_color = cell_color(tc.row, tc.col);
                    style.text_style_name = cell_style(tc.row, tc.col).to_string();
                    style.text_height = tc.h;
                    style.override_flags |= 0x01 | 0x08 | 0x10 | 0x20;
                    if let Some([mt, ml, mb, mr]) = tc.margins {
                        // 单元格级内边距覆盖：CAD 重新生成表格时与显示图形同一位置
                        style.margin_override_flags = 1;
                        style.margin_top = mt;
                        style.margin_left = ml;
                        style.margin_bottom = mb;
                        style.margin_right = mr;
                        style.property_flags |= CellStylePropertyFlags::MARGIN_LEFT
                            | CellStylePropertyFlags::MARGIN_TOP
                            | CellStylePropertyFlags::MARGIN_RIGHT
                            | CellStylePropertyFlags::MARGIN_BOTTOM;
                    }
                    cell.style = Some(style);
                    t.rows[tc.row].cells[tc.col] = cell;
                }
                // 表格级覆盖：单元格水平 / 竖向内边距 (DXF 40 / 41)
                t.legacy_style_override = Some(LegacyTableStyleOverride {
                    flags: 0x08 | 0x10,
                    horizontal_cell_margin: Some(lay.pad_x),
                    vertical_cell_margin: Some(lay.pad_y),
                    ..Default::default()
                });
                t.block_record_handle = Some(br_handle);
                t.block_name = format!("*T{table_seq}");
                let mut e = EntityType::Table(Box::new(t));
                set_common(&mut e, l, None, *col);
                doc.add_entity(e).map_err(|e| e.to_string())?;
            }
        }
    }

    add_dimensions(&mut doc, &spec.dims)?;

    // 表格样式 Standard：公制内边距与字高、所有行居中、不设标题行 / 表头行。
    // acadrust 默认是英制 (字高 0.18 / 0.25、内边距 0.06)，在 CAD 中新增行或重置单元格时文字会骤缩。
    if let Some((px, py, th)) = table_pad {
        for obj in doc.objects.values_mut() {
            if let ObjectType::TableStyle(ts) = obj {
                ts.horizontal_margin = px;
                ts.vertical_margin = py;
                ts.title_suppressed = true;
                ts.header_suppressed = true;
                for rs in [&mut ts.data_row_style, &mut ts.header_row_style, &mut ts.title_row_style] {
                    rs.text_height = th;
                    rs.alignment = CellAlignment::MiddleCenter;
                }
            }
        }
    }

    if min[0].is_finite() {
        const PAD: f64 = 500.0;
        doc.header.model_space_extents_min = Vector3::new(min[0] - PAD, min[1] - PAD, 0.0);
        doc.header.model_space_extents_max = Vector3::new(max[0] + PAD, max[1] + PAD, 0.0);
        doc.header.model_space_limits_min = Vector2::new(min[0] - PAD, min[1] - PAD);
        doc.header.model_space_limits_max = Vector2::new(max[0] + PAD, max[1] + PAD);

        // 打开即「范围缩放」：把 *Active 视口中心放到全部图纸中心、视高按 16:9 屏幕
        // 容下全部图纸（留 6% 边距）。否则 CAD 用默认视口 (中心 0,0) 打开，内容在屏幕外。
        let w = (max[0] - min[0]).max(1.0) + PAD * 2.0;
        let h = (max[1] - min[1]).max(1.0) + PAD * 2.0;
        const ASPECT: f64 = 16.0 / 9.0;
        let view_h = h.max(w / ASPECT) * 1.06;
        let cx = (min[0] + max[0]) / 2.0;
        let cy = (min[1] + max[1]) / 2.0;
        for vp in doc.vports.iter_mut() {
            if vp.name.eq_ignore_ascii_case("*Active") {
                vp.view_center = Vector2::new(cx, cy);
                vp.view_target = Vector3::new(0.0, 0.0, 0.0);
                vp.view_direction = Vector3::new(0.0, 0.0, 1.0);
                vp.view_height = view_h;
                vp.aspect_ratio = ASPECT;
                vp.lower_left = Vector2::new(0.0, 0.0);
                vp.upper_right = Vector2::new(1.0, 1.0);
            }
        }
    }
    Ok(doc)
}

/// 新建图块并在模型空间插入一次，返回图块记录句柄（块内实体以它为 owner）。
fn insert_block(doc: &mut CadDocument, name: &str, layer: &str, x: f64, y: f64) -> Result<acadrust::types::Handle, String> {
    let mut br = BlockRecord::new(name.to_string());
    br.handle = doc.allocate_handle();
    br.block_entity_handle = doc.allocate_handle();
    br.block_end_handle = doc.allocate_handle();
    let h = br.handle;
    doc.block_records.add(br).map_err(|e| e.to_string())?;
    let mut ins = EntityType::Insert(Insert::new(name.to_string(), v3(x, y)));
    set_common(&mut ins, layer, None, None);
    doc.add_entity(ins).map_err(|e| e.to_string())?;
    Ok(h)
}

fn r3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

/// 4 位小数取整（与 JS 端 r2 一致）
fn r4(v: f64) -> f64 {
    (v * 10000.0).round() / 10000.0
}

/// 写入尺寸标注：每个标注一个匿名块 `*Dn` + 一个 DIMENSION；标注样式 Standard 与表头 $DIM* 同步为公制参数
/// （无箭头、尺寸界线不偏移、文字在尺寸线上方、整数精度），在 CAD 中重新生成标注时外观不变。
fn add_dimensions(doc: &mut CadDocument, dims: &[DimSpec]) -> Result<(), String> {
    let Some(first) = dims.first() else { return Ok(()) };
    for (idx, d) in dims.iter().enumerate() {
        let name = format!("*D{}", idx + 1);
        let mut br = BlockRecord::new(name.clone());
        br.handle = doc.allocate_handle();
        br.block_entity_handle = doc.allocate_handle();
        br.block_end_handle = doc.allocate_handle();
        let owner = br.handle;
        doc.block_records.add(br).map_err(|e| e.to_string())?;
        for ln in &d.lines {
            let mut e = EntityType::Line(Line::from_coords(ln[0], ln[1], 0.0, ln[2], ln[3], 0.0));
            set_common(&mut e, "0", None, Some(0));
            e.common_mut().owner_handle = owner;
            doc.add_entity(e).map_err(|e| e.to_string())?;
        }
        if !d.text.is_empty() {
            let mut e = make_text("0", d.tx, d.ty, d.h, &d.text, d.rot, Some(0), "CHINESE_TTF");
            e.common_mut().owner_handle = owner;
            doc.add_entity(e).map_err(|e| e.to_string())?;
        }
        let mut dim = DimensionAligned::new(v3(d.def1x, d.def1y), v3(d.def2x, d.def2y));
        dim.definition_point = v3(d.bx, d.by);
        dim.base.definition_point = dim.definition_point;
        dim.base.text_middle_point = v3(d.tc_x, d.tc_y);
        dim.base.block_name = name;
        dim.base.style_name = "Standard".to_string();
        dim.base.set_text_override(Some(d.text.clone()));
        let mut e = EntityType::Dimension(Box::new(Dimension::Aligned(dim)));
        set_common(&mut e, d.layer.as_deref().unwrap_or("FLOOR_PLAN"), None, None);
        doc.add_entity(e).map_err(|e| e.to_string())?;
    }

    let h = r4(if first.h > 0.0 { first.h } else { 55.0 });
    let exe = r4(h * 0.78);
    let dle = r4(h * 0.33);
    let gap = r4(h * 0.28);
    let hd = &mut doc.header;
    hd.dim_arrow_size = 0.0;
    hd.dim_ext_line_offset = 0.0;
    hd.dim_ext_line_extension = exe;
    hd.dim_line_extension = dle;
    hd.dim_text_height = h;
    hd.dim_line_gap = gap;
    hd.dim_text_inside_horizontal = false;
    hd.dim_text_outside_horizontal = false;
    hd.dim_text_above = 1;
    hd.dim_decimal_places = 0;
    if let Some(st) = doc.dim_styles.get_mut("Standard") {
        st.dimasz = 0.0;
        st.dimexo = 0.0;
        st.dimexe = exe;
        st.dimdle = dle;
        st.dimtxt = h;
        st.dimgap = gap;
        st.dimdec = 0;
        st.dimtih = false;
        st.dimtoh = false;
        st.dimtad = 1;
    }
    Ok(())
}

pub fn parse_spec(json: &str) -> Result<DrawingSpec, String> {
    serde_json::from_str(json).map_err(|e| format!("drawing spec JSON invalid: {e}"))
}

/// 表格排版：内边距、每格字高（按保守字宽自动缩小 / 必要时拆成两行）与 MTEXT 位置。
/// 坐标相对表格左上角，Y 向上为正（向下为负）。
/// CAD 文字样式 STANDARD 使用的 TrueType 字体（黑体 SimHei）字形参数。
///
/// AutoCAD 中 TrueType 文字的「字高」= 大写字母 A 的高度 (yMax)，而网页 / 编辑器里的字号是整个 em。
/// 黑体 em = 256 单位：A 高 178、上升 220、下降 36，所以屏幕字号 fs 对应 CAD 字高 fs × 178/256，
/// 汉字字宽 = 1 em = 字高 × 256/178。编辑器画布与本模块用同一组参数，导出与预览一致。
pub mod font {
    /// 大写字母高 / em
    pub const CAP: f64 = 178.0 / 256.0;
    /// 上升 / em（行框内基线以上部分）
    pub const ASC: f64 = 220.0 / 256.0;
    /// 下降 / em
    pub const DESC: f64 = 36.0 / 256.0;
    /// MTEXT 单倍行距 = 5/3 × CAD 字高
    pub const PITCH: f64 = 5.0 / 3.0;
    /// 表格单元格文字的屏幕行高倍数 = CAD 单倍行距 (5/3 × CAP ≈ 1.159)，表格单元格在 CAD 中只能用单倍行距
    pub const CELL_LH: f64 = PITCH * CAP;
    /// 屏幕口径文字使用的文字样式名（黑体）
    pub const EM_STYLE: &str = "TK_TEXT";

    /// 字体字形参数（相对 em）：AutoCAD TrueType 字高 = 大写字母 A 高 (`cap`)；
    /// `asc` / `desc` 为网页排版用的上升 / 下降（行框 = asc + desc + 半行距 × 2）
    #[derive(Clone, Copy, Debug, PartialEq)]
    pub struct Metric {
        pub cap: f64,
        pub asc: f64,
        pub desc: f64,
    }
    pub const SIMHEI: Metric = Metric { cap: CAP, asc: ASC, desc: DESC };

    impl Metric {
        /// 屏幕字号 → CAD 字高
        pub fn cad_h(&self, fs: f64) -> f64 {
            fs * self.cap
        }
        /// 表格单元格的屏幕行高倍数 = CAD 单倍行距 (5/3 × cap)
        pub fn cell_lh(&self) -> f64 {
            PITCH * self.cap
        }
        fn half_leading(&self, lh: f64) -> f64 {
            (lh - (self.asc + self.desc)) / 2.0
        }
        /// 屏幕行高 lh 的行框顶边 → 首行大写字母顶边的距离
        pub fn top_inset(&self, fs: f64, lh: f64) -> f64 {
            (self.half_leading(lh) + self.asc - self.cap) * fs
        }
        /// 末行基线 → 行框底边的距离
        pub fn bottom_inset(&self, fs: f64, lh: f64) -> f64 {
            (self.half_leading(lh) + self.desc) * fs
        }
        /// 屏幕行高 → MTEXT 行距比例
        pub fn line_spacing_factor(&self, lh: f64) -> f64 {
            lh / (PITCH * self.cap)
        }
    }

    /// 屏幕字号 → CAD 字高（黑体）
    pub fn cad_h(fs: f64) -> f64 {
        SIMHEI.cad_h(fs)
    }
    /// 屏幕行高 lh 的行框顶边 → 首行大写字母顶边的距离（黑体）
    pub fn top_inset(fs: f64, lh: f64) -> f64 {
        SIMHEI.top_inset(fs, lh)
    }
    /// 末行基线 → 行框底边的距离（黑体）
    pub fn bottom_inset(fs: f64, lh: f64) -> f64 {
        SIMHEI.bottom_inset(fs, lh)
    }
    /// 屏幕行高 → MTEXT 行距比例（黑体）
    pub fn line_spacing_factor(lh: f64) -> f64 {
        SIMHEI.line_spacing_factor(lh)
    }

    /// 绘图描述登记的字体样式：样式名 → 字形参数（大小写不敏感），未登记的回落到 TK_TEXT 黑体
    pub struct Fonts(Vec<(String, Metric)>);

    impl Fonts {
        pub fn from_spec(list: &[(String, String, String, f64, f64, f64)]) -> Self {
            let mut v = vec![(EM_STYLE.to_string(), SIMHEI)];
            for (name, _, _, cap, asc, desc) in list {
                if *cap > 0.05 && *cap < 2.0 && !name.eq_ignore_ascii_case(EM_STYLE) {
                    v.push((name.clone(), Metric { cap: *cap, asc: asc.max(0.0), desc: desc.max(0.0) }));
                }
            }
            Fonts(v)
        }
        pub fn get(&self, name: Option<&str>) -> (&str, Metric) {
            if let Some(n) = name {
                if let Some((k, m)) = self.0.iter().find(|(k, _)| k.eq_ignore_ascii_case(n)) {
                    return (k.as_str(), *m);
                }
            }
            (EM_STYLE, SIMHEI)
        }
    }
}

pub mod table_layout {
    /// 黑体汉字在 CAD 中的字宽 = 1 em = 字高 / CAP (≈1.44 倍字高)。
    pub const TTF_EM: f64 = 1.0 / super::font::CAP;
    /// MTEXT 默认行距 (行距系数 1.0) = 5/3 字高。
    pub const LINE_PITCH: f64 = 5.0 / 3.0;

    pub struct CellText {
        pub row: usize,
        pub col: usize,
        /// 文字（`\n` 为换行）
        pub text: String,
        /// 对齐 1~9（同 MTEXT 附着点）
        pub align: i16,
        /// 字高
        pub h: f64,
        /// MTEXT 插入点（相对表格左上角）
        pub x: f64,
        pub y: f64,
        /// MTEXT 参考宽度 = 格宽 − 左右内边距
        pub w: f64,
        /// 单元格级内边距 [上, 左, 下, 右]（CAD 口径：格边到文字字面），None = 用表格级内边距
        pub margins: Option<[f64; 4]>,
        /// 写入 MTEXT / 单元格的文字值（已转义，换行 \P，首行标签带 {\C;\H..x;} 格式码）
        pub mtext: String,
    }

    pub struct Layout {
        pub pad_x: f64,
        pub pad_y: f64,
        pub cells: Vec<CellText>,
    }

    /// 单个字符的保守字宽（em，相对字面高度）
    fn char_em(c: char) -> f64 {
        let cp = c as u32;
        if cp >= 0x2E80 || (0xFF00..=0xFFEF).contains(&cp) {
            1.0
        } else if c == ' ' {
            0.34
        } else if ".,:;!|'`il".contains(c) {
            0.34
        } else if "WMmw@%&".contains(c) {
            0.86
        } else {
            0.6
        }
    }

    /// 一行文字在字高 1 时的保守宽度
    pub fn text_width(s: &str) -> f64 {
        s.chars().map(char_em).sum::<f64>() * TTF_EM
    }

    /// n 行文字在字高 1 时的总高度（首行字面高 + 其余行距）
    fn text_height(n: usize) -> f64 {
        TTF_EM + (n.max(1) - 1) as f64 * LINE_PITCH
    }

    /// 在中点附近找一个分隔符把一行拆成两行（找不到就从中间拆）
    fn split_two(s: &str) -> Option<(String, String)> {
        let chars: Vec<char> = s.chars().collect();
        if chars.len() < 6 {
            return None;
        }
        let mid = chars.len() / 2;
        let mut at = mid;
        'search: for d in 0..=4usize {
            for idx in [mid + d, mid.saturating_sub(d)] {
                if idx > 1 && idx < chars.len() - 1 && ",，、/·; ".contains(chars[idx - 1]) {
                    at = idx;
                    break 'search;
                }
            }
        }
        let a: String = chars[..at].iter().collect::<String>().trim().to_string();
        let b: String = chars[at..].iter().collect::<String>().trim().to_string();
        if a.is_empty() || b.is_empty() { None } else { Some((a, b)) }
    }

    /// 在可用宽高内能放下 lines 的最大字高（不超过 h0）
    fn fit_height(lines: &[&str], h0: f64, inner_w: f64, inner_h: f64) -> f64 {
        let wmax = lines.iter().map(|l| text_width(l)).fold(0.0, f64::max);
        let mut h = h0.min(inner_h / text_height(lines.len()));
        if wmax > 0.0 {
            h = h.min(inner_w / wmax);
        }
        h.max(1e-3)
    }

    pub fn grid_lines(cw: &[f64], rh: &[f64]) -> Vec<[f64; 4]> {
        let tw: f64 = cw.iter().sum();
        let th: f64 = rh.iter().sum();
        let mut out = Vec::with_capacity(cw.len() + rh.len() + 2);
        let mut acc = 0.0;
        for r in 0..=rh.len() {
            out.push([0.0, -acc, tw, -acc]);
            if r < rh.len() {
                acc += rh[r];
            }
        }
        acc = 0.0;
        for c in 0..=cw.len() {
            out.push([acc, 0.0, acc, -th]);
            if c < cw.len() {
                acc += cw[c];
            }
        }
        out
    }

    /// MTEXT 文字值：换行写成 \P，反斜杠与花括号转义
    pub fn mtext_value(s: &str) -> String {
        let mut out = String::with_capacity(s.len());
        for c in s.chars() {
            match c {
                '\\' => out.push_str("\\\\"),
                '{' => out.push_str("\\{"),
                '}' => out.push_str("\\}"),
                '\n' => out.push_str("\\P"),
                '\r' => {}
                _ => out.push(c),
            }
        }
        out
    }

    pub fn layout(cw: &[f64], rh: &[f64], cells: &[Vec<String>], th: f64, pad: Option<[f64; 2]>, al: &[Vec<i16>], ch: &[Vec<f64>]) -> Layout {
        layout_ex(cw, rh, cells, th, pad, al, ch, false, &[])
    }

    /// `em`：字高是屏幕字号；`bx`：单元格内边距 [上, 左, 下, 右]（到屏幕文字行框，行高 CELL_LH）
    #[allow(clippy::too_many_arguments)]
    pub fn layout_ex(cw: &[f64], rh: &[f64], cells: &[Vec<String>], th: f64, pad: Option<[f64; 2]>, al: &[Vec<i16>], ch: &[Vec<f64>], em: bool, bx: &[Vec<[f64; 4]>]) -> Layout {
        layout_full(cw, rh, cells, th, pad, al, ch, em, bx, &[], &[])
    }

    /// 同 [`layout_ex`]，另带逐格字体字形参数 `fm` 与首行标签 `lb`（堆叠式字段名，与内容写进同一个 MTEXT）。
    ///
    /// 表格级内边距 (DXF 40 / 41，CAD 双击编辑单元格后重新生成表格时使用) 取各格 CAD 口径内边距中出现最多的一组，
    /// 让绝大多数格子在 DXF 中不依赖单元格级覆盖也与显示图形同一位置。
    #[allow(clippy::too_many_arguments)]
    pub fn layout_full(
        cw: &[f64], rh: &[f64], cells: &[Vec<String>], th: f64, pad: Option<[f64; 2]>, al: &[Vec<i16>], ch: &[Vec<f64>], em: bool,
        bx: &[Vec<[f64; 4]>], fm: &[Vec<super::font::Metric>], lb: &[Vec<Option<super::LabelSpec>>],
    ) -> Layout {
        use super::font;
        let th = if em { font::cad_h(th) } else { th };
        let min_w = cw.iter().copied().filter(|v| *v > 0.0).fold(f64::INFINITY, f64::min);
        let min_h = rh.iter().copied().filter(|v| *v > 0.0).fold(f64::INFINITY, f64::min);
        let min_w = if min_w.is_finite() { min_w } else { th * 4.0 };
        let min_h = if min_h.is_finite() { min_h } else { th * 2.0 };
        let (px0, py0) = match pad {
            Some([x, y]) if x >= 0.0 && y >= 0.0 => (x, y),
            _ => (th * 0.5, th * 0.3),
        };
        let mut pad_x = px0.min(min_w * 0.2);
        let mut pad_y = py0.min(min_h * 0.2);
        let mut out = Vec::new();
        let mut top = 0.0;
        for (r, &row_h) in rh.iter().enumerate() {
            let mut left = 0.0;
            for (c, &col_w) in cw.iter().enumerate() {
                let metric = fm.get(r).and_then(|row| row.get(c)).copied().unwrap_or(font::SIMHEI);
                let to_cad = |v: f64| if em { metric.cad_h(v) } else { v };
                let label = lb.get(r).and_then(|row| row.get(c)).and_then(|l| l.as_ref()).filter(|l| !l.s.trim().is_empty());
                let raw = cells.get(r).and_then(|row| row.get(c)).map(String::as_str).unwrap_or("");
                let text: String = raw.replace("\r\n", "\n").split('\n').map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join("\n");
                let align = al.get(r).and_then(|row| row.get(c)).copied().filter(|a| (1..=9).contains(a)).unwrap_or(5);
                let fs = ch.get(r).and_then(|row| row.get(c)).copied().filter(|h| *h > 0.0);
                let h0 = fs.map(to_cad).unwrap_or(th);
                let fs = fs.unwrap_or(if em { th / font::CAP } else { th });
                let first_fs = label.map(|l| l.h).filter(|h| *h > 0.0).unwrap_or(fs);
                // 单元格内边距：bx 给定时逐格换算成 CAD 口径（行框 → 字面），否则用表格级内边距
                let m = bx.get(r).and_then(|row| row.get(c)).map(|b| {
                    let (t, b2) = if em {
                        let lh = metric.cell_lh();
                        (b[0] + metric.top_inset(first_fs, lh), b[2] + metric.bottom_inset(fs, lh))
                    } else {
                        (b[0], b[2])
                    };
                    [t.max(0.0), b[1].max(0.0), b2.max(0.0), b[3].max(0.0)]
                });
                let [mt, ml, mb, mr] = m.unwrap_or([pad_y, pad_x, pad_y, pad_x]);
                let inner_w = (col_w - ml - mr).max(col_w * 0.2);
                let inner_h = (row_h - mt - mb).max(row_h * 0.2);
                let (text, h) = if text.is_empty() {
                    let h = match label {
                        Some(l) => fit_height(&[l.s.as_str()], h0, inner_w, inner_h),
                        None => h0,
                    };
                    (text, h)
                } else {
                    let mut lines: Vec<&str> = text.split('\n').collect();
                    if let Some(l) = label {
                        lines.insert(0, l.s.as_str());
                    }
                    let h1 = fit_height(&lines, h0, inner_w, inner_h);
                    // 单行放不下且缩得太小：行高够时拆成两行
                    match (lines.len(), h1 < h0 * 0.7) {
                        (1, true) => match split_two(&text) {
                            Some((a, b)) => {
                                let h2 = fit_height(&[&a, &b], h0, inner_w, inner_h);
                                if h2 > h1 * 1.15 { (format!("{a}\n{b}"), h2) } else { (text.clone(), h1) }
                            }
                            None => (text.clone(), h1),
                        },
                        _ => (text.clone(), h1),
                    }
                };
                let h = (h * 1000.0).floor() / 1000.0;
                let mut mtext = String::new();
                if let Some(l) = label {
                    let ratio = ((l.h / fs).max(0.1) * 1000.0).round() / 1000.0;
                    mtext.push_str(&format!("{{\\C{};\\H{}x;{}}}", l.col.unwrap_or(8), ratio, mtext_value(l.s.trim())));
                    if !text.is_empty() {
                        mtext.push_str("\\P");
                    }
                }
                mtext.push_str(&mtext_value(&text));
                let shown = match label {
                    Some(l) if text.is_empty() => l.s.trim().to_string(),
                    Some(l) => format!("{}\n{}", l.s.trim(), text),
                    None => text,
                };
                let ci = (align - 1) % 3;
                let ri = (align - 1) / 3;
                let x = match ci {
                    0 => left + ml,
                    1 => left + ml + inner_w / 2.0,
                    _ => left + col_w - mr,
                };
                let y = match ri {
                    0 => -(top + mt),
                    1 => -(top + mt + inner_h / 2.0),
                    _ => -(top + row_h - mb),
                };
                out.push(CellText { row: r, col: c, text: shown, align, h, x, y, w: inner_w, margins: m, mtext });
                left += col_w;
            }
            top += row_h;
        }
        // 表格级内边距 = 有文字的格子里最常见的一组 [上, 左]（CAD 口径）
        let mut counts: Vec<((i64, i64), usize, f64, f64)> = Vec::new();
        for tc in out.iter().filter(|t| !t.text.is_empty()) {
            if let Some([mt, ml, _, _]) = tc.margins {
                let key = ((mt * 1000.0).round() as i64, (ml * 1000.0).round() as i64);
                match counts.iter_mut().find(|e| e.0 == key) {
                    Some(e) => e.1 += 1,
                    None => counts.push((key, 1, mt, ml)),
                }
            }
        }
        if let Some(best) = counts.iter().max_by_key(|e| e.1) {
            pad_y = best.2;
            pad_x = best.3;
        }
        Layout { pad_x, pad_y, cells: out }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn long_text_shrinks_to_fit_padded_cell() {
            let cells = vec![vec!["留1.5mm缝,填美缝剂留1.5mm缝".to_string()]];
            let lay = layout(&[600.0], &[200.0], &cells, 120.0, None, &[], &[]);
            let c = &lay.cells[0];
            let w = c.text.split('\n').map(text_width).fold(0.0, f64::max) * c.h;
            assert!(w <= 600.0 - lay.pad_x * 2.0 + 1e-6, "width {w}");
            assert!(lay.pad_x > 0.0 && lay.pad_y > 0.0);
        }

        #[test]
        fn em_cells_use_cad_height_and_cell_margins() {
            let cells = vec![vec!["说明".to_string()]];
            let lay = layout_ex(&[100.0], &[40.0], &cells, 2.4, None, &[vec![1]], &[vec![2.4]], true, &[vec![[6.0, 2.0, 1.0, 2.0]]]);
            let c = &lay.cells[0];
            assert!((c.h - 2.4 * 178.0 / 256.0).abs() < 1e-3);
            let mt = 6.0 + super::super::font::top_inset(2.4, super::super::font::CELL_LH);
            assert!((c.y + mt).abs() < 1e-9 && (c.x - 2.0).abs() < 1e-9);
            assert_eq!(c.margins.map(|m| m[1]), Some(2.0));
        }

        #[test]
        fn label_goes_into_cell_mtext_and_table_margin_is_mode() {
            let cells = vec![vec!["值一\n值二".to_string(), "B".to_string(), "C".to_string()]];
            let lb = vec![vec![Some(super::super::LabelSpec { s: "名称".into(), h: 2.0, col: Some(8) }), None, None]];
            let bx = vec![vec![[1.0, 2.0, 1.0, 2.0], [1.5, 2.2, 1.5, 2.2], [1.5, 2.2, 1.5, 2.2]]];
            let lay = layout_full(&[60.0, 60.0, 60.0], &[30.0], &cells, 2.5, None, &[vec![1, 1, 1]], &[vec![2.5, 2.5, 2.5]], true, &bx, &[], &lb);
            assert_eq!(lay.cells[0].mtext, "{\\C8;\\H0.8x;名称}\\P值一\\P值二");
            let m = super::super::font::SIMHEI;
            assert!((lay.pad_y - (1.5 + m.top_inset(2.5, m.cell_lh()))).abs() < 1e-9);
            assert!((lay.pad_x - 2.2).abs() < 1e-9);
        }

        #[test]
        fn alignment_positions() {
            let cells = vec![vec!["A".to_string(), "B".to_string()]];
            let lay = layout(&[100.0, 100.0], &[40.0], &cells, 10.0, Some([3.0, 2.0]), &[vec![4, 9]], &[]);
            assert_eq!((lay.cells[0].x, lay.cells[0].y), (3.0, -20.0));
            assert_eq!((lay.cells[1].x, lay.cells[1].y), (197.0, -38.0));
        }
    }
}

/// 图片栅格 → AutoCAD 索引色 (ACI) 色块矩形。
pub mod raster {
    /// ACI 调色板（1–255，不含随背景反色的 7）：(aci, r, g, b)
    fn palette() -> Vec<(i16, f64, f64, f64)> {
        let mut pal: Vec<(i16, f64, f64, f64)> = vec![
            (1, 255.0, 0.0, 0.0), (2, 255.0, 255.0, 0.0), (3, 0.0, 255.0, 0.0), (4, 0.0, 255.0, 255.0),
            (5, 0.0, 0.0, 255.0), (6, 255.0, 0.0, 255.0), (8, 128.0, 128.0, 128.0), (9, 192.0, 192.0, 192.0),
        ];
        const V: [f64; 5] = [255.0, 189.0, 129.0, 104.0, 79.0];
        for i in 10..=249i16 {
            let hue = ((i / 10) - 1) as f64 * 15.0;
            let sub = i % 10;
            let v = V[(sub / 2) as usize];
            let sat = if sub % 2 == 1 { 1.0 / 3.0 } else { 1.0 };
            let hf = |n: f64| {
                let kk = (n + hue / 60.0) % 6.0;
                v - v * sat * kk.min(4.0 - kk).min(1.0).max(0.0)
            };
            pal.push((i, hf(5.0).round(), hf(3.0).round(), hf(1.0).round()));
        }
        for (j, g) in [51.0, 91.0, 132.0, 173.0, 214.0, 255.0].iter().enumerate() {
            pal.push((250 + j as i16, *g, *g, *g));
        }
        pal
    }

    /// 最近的 ACI 色号（加权欧氏距离，同 JS 版本）
    fn nearest(pal: &[(i16, f64, f64, f64)], r: f64, g: f64, b: f64) -> i16 {
        let mut best = 255;
        let mut bd = f64::INFINITY;
        for &(i, pr, pg, pb) in pal {
            let rm = (r + pr) / 2.0;
            let (dr, dg, db) = (r - pr, g - pg, b - pb);
            let d = (2.0 + rm / 256.0) * dr * dr + 4.0 * dg * dg + (2.0 + (255.0 - rm) / 256.0) * db * db;
            if d < bd {
                bd = d;
                best = i;
            }
        }
        best
    }

    pub struct Rect {
        pub i0: usize,
        pub i1: usize,
        pub j0: usize,
        pub j1: usize,
        pub c: i16,
    }

    /// 同色行程横向合并、再与上一行同起止同色的矩形纵向合并；alpha < 128 的格子不输出。
    pub fn aci_rects(rgba: &[u8], gw: usize, gh: usize) -> Vec<Rect> {
        let pal = palette();
        let mut cache = std::collections::HashMap::new();
        let mut color = |o: usize| -> i16 {
            if rgba[o + 3] < 128 {
                return -1;
            }
            let (r, g, b) = (rgba[o], rgba[o + 1], rgba[o + 2]);
            let key = ((r as u32 >> 2) << 12) | ((g as u32 >> 2) << 6) | (b as u32 >> 2);
            *cache.entry(key).or_insert_with(|| nearest(&pal, r as f64, g as f64, b as f64))
        };
        let mut rects: Vec<Rect> = Vec::new();
        let mut open: std::collections::HashMap<(usize, usize, i16), usize> = std::collections::HashMap::new();
        for j in 0..gh {
            let row: Vec<i16> = (0..gw).map(|i| color((j * gw + i) * 4)).collect();
            let mut next = std::collections::HashMap::new();
            let mut i = 0;
            while i < gw {
                let c = row[i];
                let mut i1 = i + 1;
                while i1 < gw && row[i1] == c {
                    i1 += 1;
                }
                if c >= 0 {
                    let key = (i, i1, c);
                    let idx = match open.get(&key) {
                        Some(&k) => {
                            rects[k].j1 = j + 1;
                            k
                        }
                        None => {
                            rects.push(Rect { i0: i, i1, j0: j, j1: j + 1, c });
                            rects.len() - 1
                        }
                    };
                    next.insert(key, idx);
                }
                i = i1;
            }
            open = next;
        }
        rects
    }

    /// 标准 base64 解码（可含 data: 前缀与空白）
    pub fn decode_base64(s: &str) -> Result<Vec<u8>, String> {
        let s = s.rsplit(',').next().unwrap_or(s);
        let mut out = Vec::with_capacity(s.len() * 3 / 4);
        let (mut acc, mut bits) = (0u32, 0u32);
        for ch in s.bytes() {
            let v = match ch {
                b'A'..=b'Z' => ch - b'A',
                b'a'..=b'z' => ch - b'a' + 26,
                b'0'..=b'9' => ch - b'0' + 52,
                b'+' | b'-' => 62,
                b'/' | b'_' => 63,
                b'=' => break,
                b' ' | b'\n' | b'\r' | b'\t' => continue,
                _ => return Err("image raster: invalid base64".to_string()),
            } as u32;
            acc = (acc << 6) | v;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                out.push((acc >> bits) as u8);
                acc &= (1 << bits) - 1;
            }
        }
        Ok(out)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn merges_runs_and_skips_transparent() {
            // 2×2：上行红红、下行红 + 透明
            let px = [255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 0, 0];
            let r = aci_rects(&px, 2, 2);
            assert_eq!(r.len(), 2);
            assert_eq!((r[0].i0, r[0].i1, r[0].j1, r[0].c), (0, 2, 1, 1));
        }

        #[test]
        fn base64_round_trip() {
            assert_eq!(decode_base64("data:x;base64,AAEC/w==").unwrap(), vec![0, 1, 2, 255]);
        }
    }
}
