//! Off-thread CBT terrain kernel (Rust/WASM). Pure-numeric modules (noise, state,
//! classify, emit) are host-testable; the wasm-bindgen glue (cbt_kernel) is added
//! in a later phase. See plan: "Déporter le CBT sur un worker Rust/WASM".

pub mod cbt_classify;
pub mod cbt_emit;
pub mod cbt_kernel;
pub mod cbt_noise;
pub mod cbt_state;

#[cfg(test)]
mod cbt_scenario_test;
