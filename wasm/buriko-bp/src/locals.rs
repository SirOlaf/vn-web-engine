//! `bp/opcodes/locals.ts`: fused local-descriptor loads, stores and address arithmetic.

use crate::integer::signed_shift;
use crate::vm::{Host, Step, Vm};

pub fn dispatch(vm: &mut Vm, opcode: u32) -> Option<Step<u32>> {
    Some(match opcode {
        0x1a => (|| {
            let (local, kind) = vm.local_descriptor()?;
            let offset = vm.read_var_int()? as u32;
            let value = vm.read_scalar(local, kind)?;
            vm.push(value.wrapping_add(offset))?;
            Ok(0)
        })(),
        0x1b => (|| {
            let (local, kind) = vm.local_descriptor()?;
            let scale = vm.read_var_int()? as u32;
            let base = vm.pop()?;
            let value = vm.read_scalar(local, kind)?;
            vm.push(value.wrapping_mul(scale).wrapping_add(base))?;
            Ok(0)
        })(),
        0x1c => (|| {
            let (local, kind) = vm.local_descriptor()?;
            let count = vm.read_i8()?;
            let value = vm.read_scalar(local, kind)?;
            vm.push(signed_shift(value, count))?;
            Ok(0)
        })(),
        0x1d => (|| {
            let (local, kind) = vm.local_descriptor()?;
            let value = vm.pop()?;
            let scalar = vm.read_scalar(local, kind)?;
            vm.push(scalar.wrapping_mul(value))?;
            Ok(0)
        })(),
        0x1e => (|| {
            let (local, kind) = vm.local_descriptor()?;
            let value = vm.pop()? as i32;
            let divisor = vm.read_scalar(local, kind)? as i32;
            // This handler uses 32-bit IDIV; unlike 23, INT_MIN/-1 traps.
            if value == i32::MIN && divisor == -1 {
                return Err(Host);
            }
            vm.push(if divisor == 0 { 0x8000_0000 } else { (value / divisor) as u32 })?;
            Ok(0)
        })(),
        0xe2 => (|| {
            let count = vm.read_u8()? + 1;
            for _ in 0..count {
                let (local, kind) = vm.local_descriptor()?;
                vm.pointer(local)?;
                let word = vm.pop_deferred()?;
                vm.write_deferred(local, kind, word)?;
            }
            Ok(0)
        })(),
        0xe3 => (|| {
            let count = vm.read_u8()? + 1;
            for _ in 0..count {
                let (local, kind) = vm.local_descriptor()?;
                let value = vm.read_scalar(local, kind)?;
                vm.push(value)?;
            }
            Ok(0)
        })(),
        0xe4 => (|| {
            let (local, kind) = vm.local_descriptor()?;
            let (item_kind, item_value) = vm.read_typed_var_int()?;
            let base = vm.read_scalar(local, kind)?;
            let value = vm.read_scalar(base.wrapping_add(item_value as u32), item_kind)?;
            vm.push(value)?;
            Ok(0)
        })(),
        0xe5 => (|| {
            let (local, kind) = vm.local_descriptor()?;
            let (item_kind, item_value) = vm.read_typed_var_int()?;
            let base = vm.pop()?;
            let index = vm.read_scalar(local, kind)?;
            let address = base.wrapping_add(index.wrapping_mul(item_value as u32));
            let value = vm.read_scalar(address, item_kind)?;
            vm.push(value)?;
            Ok(0)
        })(),
        0xe6 => (|| {
            let (local, kind) = vm.local_descriptor()?;
            let (item_kind, item_value) = vm.read_typed_var_int()?;
            let destination = vm.pop()?;
            vm.pointer(destination)?;
            let value = vm.read_scalar(local, kind)?.wrapping_add(item_value as u32);
            vm.write_scalar(destination, item_kind, value)?;
            Ok(0)
        })(),
        0xe7 => (|| {
            let (local, kind) = vm.local_descriptor()?;
            let (item_kind, item_value) = vm.read_typed_var_int()?;
            let base = vm.pop()?;
            let destination = vm.pop()?;
            vm.pointer(destination)?;
            let value = vm
                .read_scalar(local, kind)?
                .wrapping_mul(item_value as u32)
                .wrapping_add(base);
            vm.write_scalar(destination, item_kind, value)?;
            Ok(0)
        })(),
        0xe8 => (|| {
            let (local, kind) = vm.local_descriptor()?;
            let if_false = vm.pop()?;
            let if_true = vm.pop()?;
            let condition = vm.pop()?;
            vm.write_scalar(local, kind, if condition == 0 { if_false } else { if_true })?;
            Ok(0)
        })(),
        0xe9 => (|| {
            let (local, kind) = vm.local_descriptor()?;
            let offset = vm.read_u16()?;
            let value = vm.pop()?;
            let base = vm.read_u32(local)?;
            vm.write_scalar(base.wrapping_add(offset), kind, value)?;
            Ok(0)
        })(),
        0xea => (|| {
            let (local, kind) = vm.local_descriptor()?;
            let offset = vm.read_u16()?;
            let value = vm.read_var_int()? as u32;
            let base = vm.read_u32(local)?;
            vm.write_scalar(base.wrapping_add(offset), kind, value)?;
            Ok(0)
        })(),
        0xf0 => (|| {
            let destination = vm.read_u32_code()?;
            let (local, kind) = vm.local_descriptor()?;
            let offset = vm.read_var_int()? as u32;
            vm.pointer(destination)?;
            let value = vm.read_u32(local)?.wrapping_add(offset);
            vm.write_scalar(destination, kind, value)?;
            Ok(0)
        })(),
        0xf1 => (|| {
            let destination = vm.read_u16()?;
            let destination = vm.local_address(destination);
            let (local, kind) = vm.local_descriptor()?;
            let offset = vm.read_var_int()? as u32;
            vm.pointer(destination)?;
            let value = vm.read_u32(local)?.wrapping_add(offset);
            vm.write_scalar(destination, kind, value)?;
            Ok(0)
        })(),
        0xf2 => (|| {
            let destination_local = vm.read_u16()?;
            let destination_local = vm.local_address(destination_local);
            let destination_offset = vm.read_u16()?;
            let (local, kind) = vm.local_descriptor()?;
            let offset = vm.read_var_int()? as u32;
            let destination = vm.read_u32(destination_local)?.wrapping_add(destination_offset);
            vm.pointer(destination)?;
            let value = vm.read_u32(local)?.wrapping_add(offset);
            vm.write_scalar(destination, kind, value)?;
            Ok(0)
        })(),
        0xf4 => (|| {
            let destination = vm.read_u16()?;
            let destination = vm.local_address(destination);
            let base = vm.read_u32_code()?;
            let (local, kind) = vm.local_descriptor()?;
            let scale = vm.read_i16()? as u32;
            vm.pointer(destination)?;
            let value = vm.read_u32(local)?.wrapping_mul(scale).wrapping_add(base);
            vm.write_scalar(destination, kind, value)?;
            Ok(0)
        })(),
        0xf5 => (|| {
            let destination = vm.read_u16()?;
            let destination = vm.local_address(destination);
            let base_local = vm.read_u16()?;
            let base_local = vm.local_address(base_local);
            let offset = vm.read_i16()? as u32;
            let (local, kind) = vm.local_descriptor()?;
            let scale = vm.read_i16()? as u32;
            vm.pointer(destination)?;
            let base = vm.read_u32(base_local)?;
            let value = vm.read_u32(local)?;
            let result = value.wrapping_mul(scale).wrapping_add(base).wrapping_add(offset);
            vm.write_scalar(destination, kind, result)?;
            Ok(0)
        })(),
        0xf7 => (|| {
            let (local, kind) = vm.local_descriptor()?;
            let offset = vm.read_u16()?;
            let scale = vm.read_i16()? as u32;
            let base = vm.pop()?;
            let address = vm.read_u32(local)?.wrapping_add(offset);
            let value = vm.read_scalar(address, kind)?;
            vm.push(value.wrapping_mul(scale).wrapping_add(base))?;
            Ok(0)
        })(),
        0xf8 => (|| {
            let base = vm.read_u32_code()?;
            let local = vm.read_u16()?;
            let local = vm.local_address(local);
            let scale = vm.read_i16()? as u32;
            let value = vm.read_u32(local)?;
            vm.push(value.wrapping_mul(scale).wrapping_add(base))?;
            Ok(0)
        })(),
        0xf9 => (|| {
            let base_local = vm.read_u16()?;
            let base_local = vm.local_address(base_local);
            let offset = vm.read_i16()? as u32;
            let local = vm.read_u16()?;
            let local = vm.local_address(local);
            let scale = vm.read_i16()? as u32;
            let base = vm.read_u32(base_local)?;
            let index = vm.read_u32(local)?;
            vm.push(index.wrapping_mul(scale).wrapping_add(base).wrapping_add(offset))?;
            Ok(0)
        })(),
        0xfa => (|| {
            let base = vm.read_u32_code()?;
            let (local, kind) = vm.local_descriptor()?;
            let scale = vm.read_i16()? as u32;
            let address = vm.read_u32(local)?.wrapping_mul(scale).wrapping_add(base);
            let value = vm.read_scalar(address, kind)?;
            vm.push(value)?;
            Ok(0)
        })(),
        0xfb => (|| {
            let base = vm.read_u16()?;
            let base = vm.local_address(base);
            let (local, kind) = vm.local_descriptor()?;
            let scale = vm.read_i16()? as u32;
            let address = vm.read_u32(local)?.wrapping_mul(scale).wrapping_add(base);
            let value = vm.read_scalar(address, kind)?;
            vm.push(value)?;
            Ok(0)
        })(),
        _ => return None,
    })
}
