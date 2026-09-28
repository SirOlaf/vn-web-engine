//! `bp/opcodes/memory.ts`: scalar loads and stores, sequences and bulk transport.
//! Write-watch reports, provenance marking and the heap allocator stay in TypeScript.

use crate::integer::{arithmetic32, compare32};
use crate::vm::{access_size, load8, Host, Place, Step, Vm};

/// 09/0A with write watches disabled; watched stores are host work.
fn watched_store(vm: &mut Vm, reverse: bool) -> Step<u32> {
    if vm.c.watch_enabled != 0 {
        return Err(Host);
    }
    let (address, value);
    if reverse {
        address = vm.pop()?;
        vm.pointer(address)?;
        value = vm.pop_deferred()?;
    } else {
        value = vm.pop_deferred()?;
        address = vm.pop()?;
        vm.pointer(address)?;
    }
    let kind = vm.read_u8()?;
    vm.write_deferred(address, kind, value)?;
    Ok(0)
}

fn calculate_store(vm: &mut Vm, immediate: bool) -> Step<u32> {
    let control = vm.read_u8()?;
    let right = if immediate { vm.read_var_int()? as u32 } else { vm.pop()? };
    let left = vm.pop()?;
    let address = vm.pop()?;
    vm.pointer(address)?;
    let value = if control & 0x20 != 0 {
        compare32(control & 31, left, right)
    } else {
        arithmetic32(control & 31, left, right)
    };
    vm.write_scalar(address, control >> 6, value)?;
    Ok(0)
}

/// Resolved module bytes at the current pc, as `new BurikoBpPointer(moduleRegion, pc)`.
fn code_place(vm: &Vm) -> Place {
    Place { base: vm.c.module_base, size: vm.c.module_size, offset: vm.c.pc }
}

/// Bulk ops that check write watches, when watches are enabled.
fn unwatched(vm: &Vm) -> Step<()> {
    if vm.c.watch_enabled != 0 {
        Err(Host)
    } else {
        Ok(())
    }
}

fn equal_bytes(left: u32, right: u32, size: u32) -> bool {
    (0..size).all(|i| unsafe { load8(left + i) == load8(right + i) })
}

pub fn dispatch(vm: &mut Vm, opcode: u32) -> Option<Step<u32>> {
    Some(match opcode {
        0x08 => (|| {
            let address = vm.pop()?;
            vm.pointer(address)?;
            let kind = vm.read_u8()?;
            let value = vm.read_scalar(address, kind)?;
            vm.push(value)?;
            Ok(0)
        })(),
        0x09 => watched_store(vm, false),
        0x0a => watched_store(vm, true),
        0x0b => (|| {
            let destination = vm.pop()?;
            let destination = vm.pointer(destination)?;
            let length = vm.read_u8()?;
            let last = vm.c.pc.wrapping_add(length).wrapping_sub(1);
            if last < vm.c.code_limit {
                let source = code_place(vm);
                vm.move_bytes(destination, source, length)?;
                vm.c.pc = vm.c.pc.wrapping_add(length);
            }
            Ok(0)
        })(),
        0x0c => (|| {
            let kind = vm.read_u8()?;
            let count = vm.read_u8()?;
            // Values are consumed top first; the sequence writes them bottom first.
            let mut values = [0u32; 256];
            for i in 0..count as usize {
                values[i] = vm.pop()?;
            }
            let address = vm.pop()?;
            unwatched(vm)?;
            let destination = vm.pointer(address)?;
            if count == 0 {
                return Ok(0);
            }
            if kind > 2 {
                return Err(Host);
            }
            let width = access_size(kind);
            for i in 0..count {
                let at = destination.span((i * width) as u64, width as u64)?;
                vm.determinate(at, width)?;
                vm.store(at, width as u8, values[(count - i - 1) as usize])?;
            }
            Ok(0)
        })(),
        0x0d => (|| {
            let (kind, value) = vm.read_typed_var_int()?;
            let address = vm.pop()?;
            vm.write_scalar(address, kind, value as u32)?;
            Ok(0)
        })(),
        0x0e => (|| {
            let displacement = vm.read_u16()?;
            let (kind, value) = vm.read_typed_var_int()?;
            let address = vm.local_address(displacement);
            vm.write_scalar(address, kind, value as u32)?;
            Ok(0)
        })(),
        0x0f => (|| {
            let (address, kind) = vm.local_descriptor()?;
            let word = vm.pop_deferred()?;
            vm.write_deferred(address, kind, word)?;
            Ok(0)
        })(),
        0x18 => (|| {
            let descriptor = vm.read_u32_code()?;
            let value = vm.read_scalar(descriptor & 0x3fff_ffff, descriptor >> 30)?;
            vm.push(value)?;
            Ok(0)
        })(),
        0x19 => (|| {
            let (address, kind) = vm.local_descriptor()?;
            let value = vm.read_scalar(address, kind)?;
            vm.push(value)?;
            Ok(0)
        })(),
        0x1f => (|| {
            let (kind, offset) = vm.read_typed_var_int()?;
            let base = vm.pop()?;
            let value = vm.read_scalar(base.wrapping_add(offset as u32), kind)?;
            vm.push(value)?;
            Ok(0)
        })(),
        0x3e => calculate_store(vm, false),
        0x3f => calculate_store(vm, true),
        0x60 => (|| {
            let size = vm.pop()?;
            let source = vm.pop()?;
            let source = vm.pointer(source)?;
            let address = vm.pop()?;
            unwatched(vm)?;
            let destination = vm.pointer(address)?;
            vm.move_bytes(destination, source, size)?;
            Ok(0)
        })(),
        0x61 | 0x62 => (|| {
            let value = if opcode == 0x62 { vm.pop()? } else { 0 };
            let size = vm.pop()?;
            let address = vm.pop()?;
            unwatched(vm)?;
            let at = vm.pointer(address)?.span(0, size as u64)?;
            vm.determinate(at, size)?;
            // A fill is the instruction's only write; there is nothing to roll back after it.
            unsafe {
                core::ptr::write_bytes(at as usize as *mut u8, value as u8, size as usize)
            };
            Ok(0)
        })(),
        0x63 => (|| {
            let size = vm.pop()?;
            let right = vm.pop()?;
            let right = vm.pointer(right)?;
            let left = vm.pop()?;
            let left = vm.pointer(left)?;
            let a = left.span(0, size as u64)?;
            vm.determinate(a, size)?;
            let b = right.span(0, size as u64)?;
            vm.determinate(b, size)?;
            vm.push(equal_bytes(a, b, size) as u32)?;
            Ok(0)
        })(),
        0x64 => (|| {
            let source = vm.pop()?;
            let source = vm.pointer(source)?;
            let count = vm.pop()?;
            let size = vm.pop()?;
            let destination = vm.pop()?;
            let destination = vm.pointer(destination)?;
            if count == 0 {
                return Ok(0);
            }
            // Every repetition revalidates both spans; validating the widest up front is
            // equivalent because a failing repetition would fault before any later write.
            let from = source.span(0, size as u64)?;
            let to = destination.span(0, size as u64 * count as u64)?;
            vm.determinate(from, size)?;
            vm.determinate(to, (size as u64 * count as u64) as u32)?;
            if size != 0 {
                for i in 0..count {
                    unsafe {
                        core::ptr::copy(
                            from as usize as *const u8,
                            (to + i * size) as usize as *mut u8,
                            size as usize,
                        )
                    };
                }
            }
            Ok(0)
        })(),
        0x65 => (|| {
            let needle = vm.pop()?;
            let needle = vm.pointer(needle)?;
            let count = vm.pop()?;
            let size = vm.pop()?;
            let haystack = vm.pop()?;
            let haystack = vm.pointer(haystack)?;
            let mut found: u32 = u32::MAX;
            for i in 0..count {
                let a = haystack.span(i as u64 * size as u64, size as u64)?;
                vm.determinate(a, size)?;
                let b = needle.span(0, size as u64)?;
                vm.determinate(b, size)?;
                if equal_bytes(a, b, size) {
                    found = i;
                    break;
                }
            }
            vm.push(found)?;
            Ok(0)
        })(),
        0xec => (|| {
            let size = vm.read_var_int()? as u32;
            let source = vm.pop()?;
            let source = vm.pointer(source)?;
            let destination = vm.pop()?;
            let destination = vm.pointer(destination)?;
            vm.move_bytes(destination, source, size)?;
            Ok(0)
        })(),
        0xed => (|| {
            let displacement = vm.read_u16()?;
            let size = vm.read_var_int()? as u32;
            let destination = vm.pop()?;
            let destination = vm.pointer(destination)?;
            let source = vm.local_address(displacement);
            let source = vm.pointer(source)?;
            vm.move_bytes(destination, source, size)?;
            Ok(0)
        })(),
        _ => return None,
    })
}
