//! `bp/opcodes/fixed.ts`: Q16 interpolation, division and vectors, and 64-bit integers.

use crate::float::{floor, fround as f, min, power_of_two, round, sqrt};
use crate::vm::{load32, Host, Place, Step, Vm};

/// CVTPS2DQ under the native SSE2 baseline profile: nearest, ties to even.
pub fn round_to_int32(value: f64) -> i32 {
    if value.is_nan() || value.is_infinite() {
        return i32::MIN;
    }
    let below = floor(value);
    let fraction = value - below;
    let rounded = if fraction > 0.5 || (fraction == 0.5 && (below as i64) & 1 != 0) {
        below + 1.0
    } else {
        below
    };
    if rounded < -2147483648.0 || rounded > 2147483647.0 {
        i32::MIN
    } else {
        rounded as i32
    }
}

/// Native fixed result snaps fractions strictly below 64 or above 65472.
pub fn fixed_result(value: f64) -> i32 {
    let raw = round_to_int32(f(value * 65536.0));
    let integral = raw & 0xffff_0000u32 as i32;
    let fraction = raw.wrapping_sub(integral);
    if fraction < 64 {
        return integral;
    }
    if fraction > 65472 {
        return integral.wrapping_add(65536);
    }
    raw
}

fn fixed_float(value: u32) -> f64 {
    f(f(value as i32 as f64) * (1.0 / 65536.0))
}

/// Measured Rosetta x86 RCPSS seed (`burikoRosettaSseReciprocal`); zero, subnormal and
/// non-finite inputs throw there.
pub fn sse_reciprocal(input: f64) -> Step<f64> {
    let bits = (input as f32).to_bits();
    let exponent = (bits >> 23) & 255;
    if exponent == 0 || exponent == 255 {
        return Err(Host);
    }
    let index = ((bits >> 12) & 2047) as f64;
    let normalized = round(8192.0 / (1.0 + (index + 0.5) / 2048.0)) / 8192.0;
    let result = f(normalized * power_of_two(127 - exponent as i32));
    Ok(if bits >> 31 != 0 { -result } else { result })
}

/// Measured RSQRTSS seed (`burikoRosettaSseReciprocalSqrt`); non-positive-normal inputs throw
/// there.
pub fn sse_reciprocal_sqrt(input: f64) -> Step<f64> {
    let bits = (input as f32).to_bits();
    let exponent_bits = (bits >> 23) & 255;
    if bits >> 31 != 0 || exponent_bits == 0 || exponent_bits == 255 {
        return Err(Host);
    }
    let exponent = exponent_bits as i32 - 127;
    let parity = exponent & 1;
    let index = ((bits >> 13) & 1023) as f64;
    let normalized =
        round(8192.0 / sqrt((1.0 + (index + 0.5) / 1024.0) * power_of_two(parity))) / 8192.0;
    Ok(f(normalized * power_of_two(-(exponent - parity) / 2)))
}

/// The native approximate reciprocal seed; every Newton-refinement operation rounds to f32.
pub fn refined_reciprocal(denominator: f64) -> Step<f64> {
    let seed = sse_reciprocal(denominator)?;
    Ok(f(f(seed + seed) - f(f(seed * seed) * denominator)))
}

pub fn divide_fixed(numerator: u32, denominator: u32) -> Step<i32> {
    if denominator == 0 {
        return Ok(0);
    }
    Ok(fixed_result(f(refined_reciprocal(fixed_float(denominator))? * fixed_float(numerator))))
}

/// `pointerView(p.add(displacement), length)` for a read: bounds, then provenance.
fn read_span(vm: &Vm, place: Place, displacement: u32, length: u32) -> Step<u32> {
    let at = place.span(displacement as u64, length as u64)?;
    vm.determinate(at, length)?;
    Ok(at)
}

/// A write clears marks, which is side-table work.
fn write_span(vm: &Vm, place: Place, displacement: u32, length: u32) -> Step<u32> {
    read_span(vm, place, displacement, length)
}

fn read_vector(vm: &Vm, place: Place) -> Step<[u32; 4]> {
    let at = read_span(vm, place, 0, 16)?;
    Ok(unsafe { [load32(at), load32(at + 4), load32(at + 8), load32(at + 12)] })
}

fn write_vector(vm: &mut Vm, place: Place, values: [u32; 4]) -> Step<()> {
    let at = write_span(vm, place, 0, 16)?;
    for (i, value) in values.into_iter().enumerate() {
        vm.store(at + i as u32 * 4, 4, value)?;
    }
    Ok(())
}

fn read_i64(vm: &Vm, place: Place) -> Step<i64> {
    let at = read_span(vm, place, 0, 8)?;
    Ok(unsafe { (load32(at) as u64 | (load32(at + 4) as u64) << 32) as i64 })
}

fn pointers(vm: &mut Vm) -> Step<(Place, Place, Place)> {
    let right = vm.pop()?;
    let right = vm.pointer(right)?;
    let left = vm.pop()?;
    let left = vm.pointer(left)?;
    let destination = vm.pop()?;
    let destination = vm.pointer(destination)?;
    Ok((right, left, destination))
}

fn integer64(vm: &mut Vm, operation: u32) -> Step<u32> {
    let (right, left, destination) = pointers(vm)?;
    let b = read_i64(vm, right)?;
    let a = if operation == 3 && b == 0 { 0 } else { read_i64(vm, left)? };
    let result = match operation {
        0 => a.wrapping_add(b),
        1 => a.wrapping_sub(b),
        2 => a.wrapping_mul(b),
        3 if b == 0 => i64::MIN,
        _ => {
            if b == 0 || (a == i64::MIN && b == -1) {
                return Err(Host);
            }
            if operation == 3 {
                a / b
            } else {
                a % b
            }
        }
    };
    let at = write_span(vm, destination, 0, 8)?;
    vm.store(at, 4, result as u32)?;
    vm.store(at + 4, 4, (result >> 32) as u32)?;
    Ok(0)
}

fn vector(vm: &mut Vm, operation: fn(u32, u32) -> u32) -> Step<u32> {
    let (right, left, destination) = pointers(vm)?;
    let a = read_vector(vm, left)?;
    let b = read_vector(vm, right)?;
    write_vector(vm, destination, core::array::from_fn(|i| operation(a[i], b[i])))?;
    Ok(0)
}

fn product16(value: u32, multiplier: u32) -> u32 {
    ((value as i32 as i64 * multiplier as i32 as i64) >> 16) as u32
}

fn clamp_ratio(ratio: f64) -> f64 {
    if ratio < 0.0 {
        0.0
    } else {
        min(1.0, ratio)
    }
}

pub fn dispatch(vm: &mut Vm, opcode: u32) -> Option<Step<u32>> {
    Some(match opcode {
        0x46 => (|| {
            let denominator = vm.pop()? as i32;
            let numerator = vm.pop()? as i32;
            let end = vm.pop()? as i32;
            let start = vm.pop()? as i32;
            let ratio =
                if denominator == 0 { 0.0 } else { f(f(numerator as f64) / f(denominator as f64)) };
            let clamped = clamp_ratio(ratio);
            let (end, start) = (f(end as f64), f(start as f64));
            vm.push(fixed_result(f(f(f(end - start) * clamped) + start)) as u32)?;
            Ok(0)
        })(),
        0x47 => (|| {
            let ratio = fixed_float(vm.pop()?);
            let end = fixed_float(vm.pop()?);
            let start = fixed_float(vm.pop()?);
            let clamped = clamp_ratio(ratio);
            vm.push(fixed_result(f(f(f(end - start) * clamped) + start)) as u32)?;
            Ok(0)
        })(),
        0x50 => integer64(vm, 0),
        0x51 => integer64(vm, 1),
        0x52 => integer64(vm, 2),
        0x53 => integer64(vm, 3),
        0x54 => integer64(vm, 4),
        0x57 => (|| {
            let divisor = vm.pop()?;
            let value = vm.pop()?;
            let result = divide_fixed(value, divisor)?;
            vm.push(result as u32)?;
            Ok(0)
        })(),
        0x58 => vector(vm, |a, b| a.wrapping_add(b)),
        0x59 => vector(vm, |a, b| a.wrapping_sub(b)),
        0x5a => (|| {
            let (right, left, destination) = pointers(vm)?;
            for i in 0..4 {
                let a = unsafe { load32(read_span(vm, left, i * 4, 4)?) };
                let b = unsafe { load32(read_span(vm, right, i * 4, 4)?) };
                let at = write_span(vm, destination, i * 4, 4)?;
                vm.store(at, 4, product16(a, b))?;
            }
            Ok(0)
        })(),
        0x5b => (|| {
            let (right, left, destination) = pointers(vm)?;
            let b = read_vector(vm, right)?;
            let a = read_vector(vm, left)?;
            let mut result = [0; 4];
            for i in 0..4 {
                result[i] = divide_fixed(a[i], b[i])? as u32;
            }
            write_vector(vm, destination, result)?;
            Ok(0)
        })(),
        0x5d => (|| {
            let source = vm.pop()?;
            let source = vm.pointer(source)?;
            let destination = vm.pop()?;
            let destination = vm.pointer(destination)?;
            let input = read_vector(vm, source)?.map(fixed_float);
            let (x, y, z) = (input[0], input[1], input[2]);
            let square = f(f(x * x) + f(f(y * y) + f(z * z)));
            let mut result = [0; 4];
            if square > 0.0 {
                let seed = sse_reciprocal_sqrt(square)?;
                let correction = f(f(f(f(square * seed) * seed) * seed) * -0.5);
                let inverse = f(f(seed * 1.5) + correction);
                result = [f(inverse * x), f(inverse * y), f(inverse * z), f(square * inverse)]
                    .map(|value| fixed_result(value) as u32);
            }
            write_vector(vm, destination, result)?;
            Ok(0)
        })(),
        0x5e => (|| {
            let multiplier = vm.pop()?;
            let source = vm.pop()?;
            let source = vm.pointer(source)?;
            let destination = vm.pop()?;
            let destination = vm.pointer(destination)?;
            for i in 0..4 {
                let value = unsafe { load32(read_span(vm, source, i * 4, 4)?) };
                let at = write_span(vm, destination, i * 4, 4)?;
                vm.store(at, 4, product16(value, multiplier))?;
            }
            Ok(0)
        })(),
        0x5f => (|| {
            let divisor = vm.pop()?;
            let source = vm.pop()?;
            let source = vm.pointer(source)?;
            let destination = vm.pop()?;
            let destination = vm.pointer(destination)?;
            let mut result = [0; 4];
            if divisor != 0 {
                let values = read_vector(vm, source)?;
                for i in 0..4 {
                    result[i] = divide_fixed(values[i], divisor)? as u32;
                }
            }
            write_vector(vm, destination, result)?;
            Ok(0)
        })(),
        _ => return None,
    })
}
