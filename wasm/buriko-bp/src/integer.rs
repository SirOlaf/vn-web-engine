//! `bp/opcodes/integer.ts`: 32-bit arithmetic, comparisons and widened products.

use crate::vm::{Step, Vm};

/// 1400d0180: comparison/boolean helper. Bit operations return the bit result.
pub fn compare32(operation: u32, left: u32, right: u32) -> u32 {
    let (a, b) = (left as i32, right as i32);
    match operation {
        0 => (a == b) as u32,
        1 => (a != b) as u32,
        2 => (a < b) as u32,
        3 => (a <= b) as u32,
        4 => (a >= b) as u32,
        5 => (a > b) as u32,
        6 => (a & b) as u32,
        7 => (a | b) as u32,
        8 => (a != 0 && b != 0) as u32,
        9 => (a != 0 || b != 0) as u32,
        _ => 0,
    }
}

/// 1400d0230, 1400cf3d0 and 1400cf380 widen signed division to 64 bits.
pub fn arithmetic32(operation: u32, left: u32, right: u32) -> u32 {
    let (a, b) = (left as i32, right as i32);
    (match operation {
        0 => a.wrapping_add(b),
        1 => a.wrapping_sub(b),
        2 => a.wrapping_mul(b),
        3 => {
            if b == 0 {
                i32::MIN
            } else {
                a.wrapping_div(b)
            }
        }
        4 => {
            if b == 0 {
                i32::MIN
            } else {
                a.wrapping_rem(b)
            }
        }
        5 => a & b,
        6 => a | b,
        7 => a ^ b,
        8 => a.wrapping_shl(b as u32),
        9 => ((a as u32).wrapping_shr(b as u32)) as i32,
        10 => a.wrapping_shr(b as u32),
        _ => i32::MIN,
    }) as u32
}

pub fn signed_shift(value: u32, count: i32) -> u32 {
    let v = value as i32;
    (if count < 0 {
        v.wrapping_shr(count.wrapping_neg() as u32)
    } else {
        v.wrapping_shl(count as u32)
    }) as u32
}

fn binary(vm: &mut Vm, operation: fn(u32, u32) -> u32) -> Step<u32> {
    let right = vm.pop()?;
    let left = vm.pop()?;
    vm.push(operation(left, right))?;
    Ok(0)
}

fn immediate(vm: &mut Vm, operation: u32) -> Step<u32> {
    let right = vm.read_var_int()? as u32;
    let left = vm.pop()?;
    vm.push(arithmetic32(operation, left, right))?;
    Ok(0)
}

pub fn dispatch(vm: &mut Vm, opcode: u32) -> Option<Step<u32>> {
    Some(match opcode {
        0x20 => binary(vm, |a, b| arithmetic32(0, a, b)),
        0x21 => binary(vm, |a, b| arithmetic32(1, a, b)),
        0x22 => binary(vm, |a, b| arithmetic32(2, a, b)),
        0x23 => binary(vm, |a, b| arithmetic32(3, a, b)),
        0x24 => binary(vm, |a, b| arithmetic32(4, a, b)),
        0x25 => binary(vm, |a, b| a & b),
        0x26 => binary(vm, |a, b| a | b),
        0x27 => binary(vm, |a, b| a ^ b),
        0x28 => (|| {
            let value = vm.pop()?;
            vm.push(!value)?;
            Ok(0)
        })(),
        0x29 => binary(vm, |a, b| a.wrapping_shl(b)),
        0x2a => binary(vm, |a, b| a.wrapping_shr(b)),
        0x2b => binary(vm, |a, b| (a as i32).wrapping_shr(b) as u32),
        0x2c => immediate(vm, 0),
        0x2d => immediate(vm, 2),
        0x2e => (|| {
            let multiplier = vm.read_var_int()? as u32;
            let value = vm.pop()?;
            let base = vm.pop()?;
            vm.push(value.wrapping_mul(multiplier).wrapping_add(base))?;
            Ok(0)
        })(),
        0x2f => immediate(vm, 3),
        0x30 => binary(vm, |a, b| compare32(0, a, b)),
        0x31 => binary(vm, |a, b| compare32(1, a, b)),
        0x32 => binary(vm, |a, b| compare32(3, a, b)),
        0x33 => binary(vm, |a, b| compare32(4, a, b)),
        0x34 => binary(vm, |a, b| compare32(2, a, b)),
        0x35 => binary(vm, |a, b| compare32(5, a, b)),
        0x36 => (|| {
            let operation = vm.read_u8()?;
            let right = vm.read_var_int()? as u32;
            let left = vm.pop()?;
            vm.push(compare32(operation, left, right))?;
            Ok(0)
        })(),
        0x38 => binary(vm, |a, b| (a != 0 && b != 0) as u32),
        0x39 => binary(vm, |a, b| (a != 0 || b != 0) as u32),
        0x3a => (|| {
            let value = vm.pop()?;
            vm.push((value == 0) as u32)?;
            Ok(0)
        })(),
        0x3c => (|| {
            let count = vm.read_i8()?;
            let value = vm.pop()?;
            vm.push(signed_shift(value, count))?;
            Ok(0)
        })(),
        0x40 => (|| {
            let if_false = vm.pop()?;
            let if_true = vm.pop()?;
            let condition = vm.pop()?;
            vm.push(if condition == 0 { if_false } else { if_true })?;
            Ok(0)
        })(),
        0x42 => (|| {
            let divisor = vm.pop()? as i32 as i64;
            let multiplier = vm.pop()? as i32 as i64;
            let value = vm.pop()? as i32 as i64;
            vm.push(if divisor == 0 {
                0x8000_0000
            } else {
                ((value * multiplier) / divisor) as u32
            })?;
            Ok(0)
        })(),
        0x56 => (|| {
            let right = vm.pop()? as i32 as i64;
            let left = vm.pop()? as i32 as i64;
            vm.push(((left * right) >> 16) as u32)?;
            Ok(0)
        })(),
        0x73 => (|| {
            vm.pop_deferred()?;
            Ok(0)
        })(),
        _ => return None,
    })
}
