//! Prints `replica::load_probe(<input>)` from the native build. v2/tools/ci.sh passes the value to node.mjs and
//! browser.mjs, which load the WASM build and must return the same (K1, #2638).

fn main() {
    let input: u32 = std::env::args()
        .nth(1)
        .and_then(|arg| arg.parse().ok())
        .expect("usage: wasm-load <u32 input>");
    println!("{}", replica::load_probe(input));
}
