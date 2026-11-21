//! # acadrust-wasm（TileCalc 精简版）
//!
//! 瓷砖算量工作站的 CAD 导出内核：把 JS 端生成的 JSON「绘图描述」交给
//! [acadrust](https://github.com/hakanaktt/acadrust)（MPL-2.0，纯 Rust）创建
//! `CadDocument`，再写出 DXF 或 DWG。绘图描述的结构见 [`builder`] 模块。
//!
//! 工作站（`assets/js/app.js`）与图框编辑器（`tukuan.html`）调用 `buildDrawing`；
//! 尺寸标注、表格、图片图块等全部在 Rust 中写出：DXF 与 DWG 都由同一份绘图描述直接生成。
//! PDF 由 `assets/js/dxf-pdf.js` 从 DXF 渲染，不经过本模块。
//!
//! 构建方法见 `tools/README.md`。

use acadrust::{CadDocument, DwgWriter, DxfReader, DxfVersion, DxfWriter};
use wasm_bindgen::prelude::*;

pub mod builder;

/// JS 接口修订号。
pub const ABI_VERSION: u32 = 6;

fn js_err(message: impl AsRef<str>) -> JsValue {
    JsValue::from_str(message.as_ref())
}

/// DXF 版本号 → [`DxfVersion`]；`0` 或未知版本号返回 `None`（调用方回退 AC1032）。
fn version_from_code(code: u32) -> Option<DxfVersion> {
    match code {
        1012 => Some(DxfVersion::AC1012),
        1014 => Some(DxfVersion::AC1014),
        1015 => Some(DxfVersion::AC1015),
        1018 => Some(DxfVersion::AC1018),
        1021 => Some(DxfVersion::AC1021),
        1024 => Some(DxfVersion::AC1024),
        1027 => Some(DxfVersion::AC1027),
        1032 => Some(DxfVersion::AC1032),
        _ => None,
    }
}

/// 把文档写成 DXF（ASCII）或 DWG（二进制）。
fn write_document(doc: &CadDocument, to_dwg: bool) -> Result<Vec<u8>, String> {
    let result = if to_dwg {
        DwgWriter::write_to_vec(doc)
    } else {
        DxfWriter::new(doc).write_to_vec()
    };
    result.map_err(|e| format!("serialize failed: {e}"))
}

/// JS 接口修订号。
#[wasm_bindgen(js_name = abiVersion)]
pub fn abi_version() -> u32 {
    ABI_VERSION
}

/// 内置 acadrust 版本，便于追溯构建。
#[wasm_bindgen(js_name = acadrustVersion)]
pub fn acadrust_version() -> String {
    acadrust::VERSION.to_string()
}

/// 由 JSON 绘图描述直接生成图纸（TileCalc 扩展）。
///
/// `spec_json` 结构见 `builder` 模块说明；`to_dwg` 为 true 时写出 DWG，否则写出 DXF；
/// `version_code` 为 DXF 版本号 (如 1032 = AutoCAD 2018，0 = 默认 AC1032)。
#[wasm_bindgen(js_name = buildDrawing)]
pub fn build_drawing(spec_json: &str, to_dwg: bool, version_code: u32) -> Result<Vec<u8>, JsValue> {
    build_drawing_bytes(spec_json, to_dwg, version_code).map_err(js_err)
}

/// [`build_drawing`] 的原生版本，供 `examples/build_spec.rs` 与单元测试使用。
pub fn build_drawing_bytes(spec_json: &str, to_dwg: bool, version_code: u32) -> Result<Vec<u8>, String> {
    let spec = builder::parse_spec(spec_json)?;
    let version = version_from_code(version_code).unwrap_or(DxfVersion::AC1032);
    let doc = builder::build_document(&spec, version)?;
    write_document(&doc, to_dwg)
}

/// DXF → DWG（读入现有 DXF 后整体写成 DWG；工作站导出已改为 `buildDrawing` 直接写 DWG）。
#[wasm_bindgen(js_name = dxfToDwg)]
pub fn dxf_to_dwg(data: &[u8], version_code: u32) -> Result<Vec<u8>, JsValue> {
    dxf_to_dwg_bytes(data, version_code).map_err(js_err)
}

/// [`dxf_to_dwg`] 的原生版本。
pub fn dxf_to_dwg_bytes(data: &[u8], version_code: u32) -> Result<Vec<u8>, String> {
    let reader = DxfReader::from_reader(std::io::Cursor::new(data.to_vec())).map_err(|e| format!("DXF read failed: {e}"))?;
    let mut doc = reader.read().map_err(|e| format!("DXF read failed: {e}"))?;
    if let Some(v) = version_from_code(version_code) {
        doc.version = v;
    }
    write_document(&doc, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPEC: &str = r#"{"layers":[["TK",7,"CONTINUOUS"]],"styles":[["STANDARD","SimHei","simhei.ttf"]],
        "entities":[{"t":"L","l":"TK","p":[0,0,10,0]},{"t":"S","l":"TK","col":168,"p":[0,0,1,0,0,1,1,1]},
        {"t":"T","l":"TK","p":[0,2],"h":2.5,"s":"图框"}]}"#;

    #[test]
    fn version_codes_fall_back_to_2018() {
        assert_eq!(version_from_code(1021), Some(DxfVersion::AC1021));
        assert_eq!(version_from_code(0), None);
        assert_eq!(version_from_code(9999), None);
    }

    #[test]
    fn builds_dxf_with_entities() {
        let dxf = String::from_utf8(build_drawing_bytes(SPEC, false, 1021).unwrap()).unwrap();
        assert!(dxf.contains("AC1021"));
        assert!(dxf.contains("\nLINE") && dxf.contains("\nSOLID") && dxf.contains("图框"));
    }

    #[test]
    fn builds_dwg() {
        let dwg = build_drawing_bytes(SPEC, true, 1032).unwrap();
        assert_eq!(&dwg[..6], b"AC1032");
    }

    #[test]
    fn dxf_round_trips_to_dwg() {
        let dxf = build_drawing_bytes(SPEC, false, 1021).unwrap();
        let dwg = dxf_to_dwg_bytes(&dxf, 1021).unwrap();
        assert_eq!(&dwg[..6], b"AC1021");
    }

    #[test]
    fn table_writes_mtext_and_metric_style() {
        let spec = r#"{"layers":[["BOM",7,"CONTINUOUS"]],"entities":[{"t":"TB","l":"BOM","col":7,"p":[0,0],
            "cw":[300,900],"rh":[200,200],"cells":[["编号","名称"],["CT1","非常非常长的花色名称会自动缩小字高"]],"th":120}]}"#;
        let dxf = String::from_utf8(build_drawing_bytes(spec, false, 1021).unwrap()).unwrap();
        assert!(dxf.contains("
MTEXT") && dxf.contains("
ACAD_TABLE"));
        assert!(!dxf.contains("
140
0.18"), "英制默认字高应已替换");
    }

    #[test]
    fn dimensions_write_blocks_and_style() {
        let spec = r#"{"layers":[["FLOOR_PLAN",7,"CONTINUOUS"]],"styles":[["CHINESE_TTF","Droid Sans Fallback","chinese-font.ttf"]],"entities":[],
            "dims":[{"layer":"FLOOR_PLAN","bx":1000,"by":0,"def1x":0,"def1y":-50,"def2x":1000,"def2y":-50,"tcX":500,"tcY":80,
            "tx":450,"ty":40,"h":95,"rot":0,"text":"1000","lines":[[-30,0,1030,0],[0,-50,0,50],[1000,-50,1000,50]]}]}"#;
        let dxf = String::from_utf8(build_drawing_bytes(spec, false, 1021).unwrap()).unwrap();
        assert!(dxf.contains("*D1") && dxf.contains("AcDbAlignedDimension"));
        let after = &dxf[dxf.find("$DIMTXT").unwrap()..];
        assert!(after.lines().nth(2).unwrap().trim().starts_with("95"), "DIMTXT");
        let dwg = build_drawing_bytes(spec, true, 1021).unwrap();
        assert_eq!(&dwg[..6], b"AC1021");
    }

    #[test]
    fn bad_spec_is_an_error_not_a_panic() {
        assert!(build_drawing_bytes("{\"entities\":[{\"t\":\"?\"}]}", false, 0).is_err());
    }
}
