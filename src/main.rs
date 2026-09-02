fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    lq::run_cli(&args);
}
