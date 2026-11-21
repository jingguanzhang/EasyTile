# tools

## acadrust-wasm
CAD 导出内核的 Rust 源码，编译后的产物在 `assets/vendor/acadrust-wasm`。

- `src/builder.rs`：JSON 绘图描述（L 直线 / P 多段线 / C 圆 / T 文字 / S 填充 / TB 原生表格）→ acadrust `CadDocument`
- `src/lib.rs`：wasm 接口 `buildDrawing`、`abiVersion`、`acadrustVersion`
- `examples/build_spec.rs`：本机命令行调试，`cargo run --example build_spec -- spec.json out.dxf`（输出 .dwg 时写 DWG）

### 构建
需要 Rust stable、`rustup target add wasm32-unknown-unknown`、`cargo install wasm-bindgen-cli --version 0.2.129`，然后运行：

```bash
./build-wasm.sh       # 产物写入 assets/vendor/acadrust-wasm
cargo test            # 本机单元测试
```

### 注意
自 v4.8.8 起，DXF / DWG 的全部内容都由 `buildDrawing` 一次生成：图层、文字、表格、尺寸标注（匿名块 `*Dn` + DIMENSION + 标注样式）、图片（像素栅格 → ACI 色块图块 `TK_IMAGE_n`）。JS 端只负责几何与排版数据，不再对 DXF 文本做任何后处理；DWG 直接由同一份描述写出，不再经过 DXF 中转。随包 wasm 已用当前源码重新构建。
