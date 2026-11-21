// cargo run --example build_spec -- spec.json out.dxf|out.dwg
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let json = std::fs::read_to_string(&a[1]).unwrap();
    let to_dwg = a[2].ends_with(".dwg");
    let bytes = acadrust_wasm::build_drawing_bytes(&json, to_dwg, 1032).unwrap();
    std::fs::write(&a[2], bytes).unwrap();
}
