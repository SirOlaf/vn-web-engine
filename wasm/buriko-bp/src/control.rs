//! `bp/opcodes/control.ts`: immediates, frame cursor, branches, calls and returns.

use crate::integer::compare32;
use crate::vm::{load32, Host, Step, Vm, CALL_POP};

/// Native call records: the call site, then the return address at the frame cursor.
fn enter_call(vm: &mut Vm, return_address: u32) -> Step<()> {
    let cursor = vm.c.frame_cursor;
    if cursor as u64 + 4 > vm.c.frame_limit as u64 {
        return Err(Host);
    }
    vm.log_call(vm.c.instruction_start as u64);
    // writeFrame32: DataView bounds, then the completed write clears provenance.
    if cursor as u64 + 4 > vm.c.frame_size as u64 {
        return Err(Host);
    }
    let at = vm.c.frame_base + cursor;
    vm.determinate(at, 4)?;
    vm.store(at, 4, return_address)?;
    vm.c.frame_cursor = cursor.wrapping_add(4);
    Ok(())
}

fn comparison_branch(vm: &mut Vm, immediate: bool) -> Step<u32> {
    let control = vm.read_u8()?;
    let relative = vm.read_i16()?;
    let right = if immediate { vm.read_var_int()? as u32 } else { vm.pop()? };
    let left = vm.pop()?;
    let comparison = compare32(control & 15, left, right);
    let taken = if control & 0x80 != 0 { comparison != 0 } else { comparison == 0 };
    if taken {
        let target = vm.c.instruction_start.wrapping_add(relative as u32);
        vm.check_target(target, false)?;
        vm.set_pc(target);
    }
    Ok(0)
}

pub fn dispatch(vm: &mut Vm, opcode: u32) -> Option<Step<u32>> {
    Some(match opcode {
        0x00 => (|| {
            let value = vm.read_i8()?;
            vm.push(value as u32)?;
            Ok(0)
        })(),
        0x01 => (|| {
            let value = vm.read_i16()?;
            vm.push(value as u32)?;
            Ok(0)
        })(),
        0x02 => (|| {
            let value = vm.read_u32_code()?;
            vm.push(value)?;
            Ok(0)
        })(),
        0x03 => (|| {
            let control = vm.read_u8()?;
            if control < 0x80 {
                for _ in 0..=control {
                    let value = vm.read_var_int()?;
                    vm.push(value as u32)?;
                }
            } else if control & 0x7c == 0 {
                let value = match control {
                    0x80 => vm.read_i8()? as u32,
                    0x81 => vm.read_i16()? as u32,
                    0x82 => vm.read_u32_code()?,
                    _ => vm.read_u64_low()?,
                };
                vm.push(value)?;
            }
            Ok(0)
        })(),
        0x04 => (|| {
            let displacement = vm.read_u16()?;
            let address = vm.local_address(displacement);
            vm.push(address)?;
            Ok(0)
        })(),
        0x05 => (|| {
            let relative = vm.read_i16()?;
            let value = vm.c.instruction_start.wrapping_add(relative as u32) | vm.c.module_tag;
            vm.push(value)?;
            Ok(0)
        })(),
        0x06 => (|| {
            let relative = vm.read_i16()?;
            let value = vm.c.instruction_start.wrapping_add(relative as u32);
            vm.push(value)?;
            Ok(0)
        })(),
        0x10 => (|| {
            let cursor = vm.c.frame_cursor;
            vm.push(cursor)?;
            Ok(0)
        })(),
        0x11 => (|| {
            let cursor = vm.pop()?;
            if cursor > vm.c.frame_limit {
                return Err(Host);
            }
            vm.c.frame_cursor = cursor;
            Ok(0)
        })(),
        0x12 => (|| {
            let displacement = vm.read_var_int()?;
            vm.c.frame_cursor = vm.c.frame_cursor.wrapping_add(displacement as u32);
            Ok(0)
        })(),
        0x13 => (|| {
            let relative = vm.read_i16()?;
            let target = vm.c.instruction_start.wrapping_add(relative as u32);
            vm.set_pc(target);
            Ok(0)
        })(),
        0x14 => (|| {
            let target = vm.pop()?;
            vm.check_target(target, true)?;
            vm.set_pc(target);
            Ok(0)
        })(),
        0x15 => (|| {
            let control = vm.read_u8()?;
            let target = if control & 8 == 0 {
                vm.pop()?
            } else {
                (vm.read_i16()? as u32).wrapping_add(vm.c.instruction_start)
            };
            let value = vm.pop()? as i32;
            let taken = match control & 7 {
                0 => value != 0,
                1 => value == 0,
                2 => value > 0,
                3 => value >= 0,
                4 => value <= 0,
                5 => value < 0,
                _ => return Err(Host),
            };
            if taken {
                vm.check_target(target, false)?;
                vm.set_pc(target);
            }
            Ok(0)
        })(),
        0x16 => (|| {
            // Native 16 pushes its call record before popping or validating the target.
            enter_call(vm, vm.c.instruction_start.wrapping_add(1))?;
            let target = vm.pop()?;
            vm.check_target(target, true)?;
            vm.set_pc(target);
            Ok(0)
        })(),
        0x17 => (|| {
            if vm.c.frame_cursor <= vm.c.frame_floor {
                return Ok(4);
            }
            let cursor = vm.c.frame_cursor.wrapping_sub(4);
            vm.c.frame_cursor = cursor;
            // readFrame32: DataView bounds, then provenance.
            if cursor as u64 + 4 > vm.c.frame_size as u64 {
                return Err(Host);
            }
            let at = vm.c.frame_base + cursor;
            vm.determinate(at, 4)?;
            let target = unsafe { load32(at) };
            vm.set_pc(target);
            vm.log_call(CALL_POP);
            Ok(0)
        })(),
        0x37 => comparison_branch(vm, true),
        0x3b => comparison_branch(vm, false),
        0xee => (|| {
            let target = (vm.read_i16()? as u32).wrapping_add(vm.c.instruction_start);
            vm.check_target(target, true)?;
            enter_call(vm, vm.c.instruction_start.wrapping_add(3))?;
            vm.set_pc(target);
            Ok(0)
        })(),
        0xef => (|| {
            let descriptor = vm.read_u32_code()?;
            let target = vm.read_scalar(descriptor & 0x3fff_ffff, descriptor >> 30)?;
            vm.check_target(target, true)?;
            enter_call(vm, vm.c.instruction_start.wrapping_add(5))?;
            vm.set_pc(target);
            Ok(0)
        })(),
        _ => return None,
    })
}
