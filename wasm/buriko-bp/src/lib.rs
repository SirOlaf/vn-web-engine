//! Buriko BP interpreter core over the shared VM arena.
//!
//! The module imports the arena's linear memory, so every region offset is a wasm address.
//! `run` executes pure primary opcodes of one thread. An instruction that would fault, or that
//! needs host state (provenance side tables, write watches, pooled or indirect banks, the heap
//! allocator), is rolled back and reported as `STATUS_HOST`; the TypeScript handler then runs
//! that instruction on the same arena state and raises the exact native error if there is one.
#![no_std]

mod control;
mod integer;
mod locals;
mod memory;
mod vm;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

pub use vm::{bp_control, bp_opcode_flags, bp_call_log, bp_run};
