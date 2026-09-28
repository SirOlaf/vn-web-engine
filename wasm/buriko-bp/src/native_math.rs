//! `bp/opcodes/native-math.ts`: the statically linked CRT's non-AVX SSE2 trigonometry, atan
//! and powf lowers behind primaries 43-45, 48, 49 and 55.

use crate::fixed::{fixed_result, round_to_int32};
use crate::float::{exponent_field, floor, fround, sqrt, trunc};
use crate::math_tables::{POW_EXPONENTIAL, POW_LOG, POW_RECIPROCAL};
use crate::vm::{load32, Step, Vm};

const PI: f64 = 3.141592653589793;
/// 2^-27.
const TINY_ANGLE: u64 = 0x3e40_0000_0000_0000;
/// 2^-13.
const SMALL_ANGLE: u64 = 0x3f20_0000_0000_0000;

fn truncate_int32(value: f64) -> i32 {
    let result = trunc(value);
    if result.is_nan() || result.is_infinite() || result < -2147483648.0 || result > 2147483647.0 {
        i32::MIN
    } else {
        result as i32
    }
}

/// 140145250/140144270, statically linked CRT's non-AVX SSE2 path, for the fixed-degree domain
/// (|angle| < 572), which never reaches the large reducer 145910.
fn reduce_fixed_angle(angle: f64) -> (u32, f64, f64) {
    let magnitude = angle.abs();
    let quadrant = trunc(magnitude * 0.6366197723675814 + 0.5);
    let mut remainder = magnitude - quadrant * 1.5707963267341256;
    let mut correction = quadrant * 6.077100506506192e-11;
    let mut head = remainder - correction;
    if exponent_field(magnitude) as i32 - exponent_field(head.abs()) as i32 > 15 {
        let previous = remainder;
        let high_correction = quadrant * 6.077100506303966e-11;
        remainder -= high_correction;
        correction = quadrant * 2.0222662487959506e-21 - (previous - remainder - high_correction);
        head = remainder - correction;
    }
    (quadrant as u32, head, remainder - head - correction)
}

fn sine_polynomial(head: f64, tail: f64) -> f64 {
    let square = head * head;
    let cube_square = square * square * square;
    let high = ((1.5918144304485914e-10 * square - 2.5051132068021698e-8) * square
        + 2.7557316103728802e-6)
        * cube_square;
    let low =
        (-0.00019841269836761127 * square + 0.00833333333333095) * square - 0.16666666666666666;
    tail + (head * square * (high + low) - square * 0.5 * tail) + head
}

fn cosine_polynomial(head: f64, tail: f64) -> f64 {
    let square = head * head;
    let cube_square = square * square * square;
    let high = ((-1.138263981623609e-11 * square + 2.0876146382372144e-9) * square
        - 2.755731727234489e-7)
        * cube_square;
    let low =
        (2.4801587298767044e-5 * square - 0.0013888888888887398) * square + 0.041666666666666664;
    let half = square * 0.5;
    let negative_base = half - 1.0;
    let correction = negative_base + 1.0 - half - tail * head;
    (low + high) * (square * square) + correction - negative_base
}

fn fixed_angle(fixed_degrees: u32) -> f64 {
    (fixed_degrees as i32 as f64 * PI) / 11796480.0
}

fn sine_bounded_radians(angle: f64) -> f64 {
    if angle.abs() < 0.7853981633974483 {
        if angle.abs() <= f64::from_bits(TINY_ANGLE) {
            return angle;
        }
        let square = angle * angle;
        let cube_square = square * square * square;
        let high = ((1.5918144304485914e-10 * square - 2.5051132068021698e-8) * square
            + 2.7557316103728802e-6)
            * cube_square;
        let low =
            (-0.00019841269836761127 * square + 0.00833333333333095) * square - 0.16666666666666666;
        return angle + angle * square * (high + low);
    }
    let (quadrant, head, tail) = reduce_fixed_angle(angle);
    let result =
        if quadrant & 1 == 0 { sine_polynomial(head, tail) } else { cosine_polynomial(head, tail) };
    if (quadrant >> 1) & 1 != (angle < 0.0) as u32 {
        0.0 - result
    } else {
        result
    }
}

fn cosine_bounded_radians(angle: f64) -> f64 {
    if angle.abs() < 0.7853981633974483 {
        if angle.abs() < f64::from_bits(TINY_ANGLE) {
            return 1.0;
        }
        let square = angle * angle;
        if angle.abs() < f64::from_bits(SMALL_ANGLE) {
            return 1.0 - square * 0.5;
        }
        let fourth = square * square;
        let eighth = fourth * fourth;
        let term1 = (-0.0013888888888887398 * square + 0.041666666666666664) * fourth;
        let term2 = (-2.755731727234489e-7 * square + 2.4801587298767044e-5) * eighth;
        let term3 = fourth * eighth * (-1.138263981623609e-11 * square + 2.0876146382372144e-9);
        let negative_half = square * -0.5;
        let base = negative_half + 1.0;
        return 1.0 - base + negative_half + (term1 + term2 + term3) + base;
    }
    let (quadrant, head, tail) = reduce_fixed_angle(angle);
    let result =
        if quadrant & 1 == 0 { cosine_polynomial(head, tail) } else { sine_polynomial(head, tail) };
    if (quadrant + 1) & 2 != 0 {
        0.0 - result
    } else {
        result
    }
}

fn sine_fixed_angle(fixed_degrees: u32) -> f64 {
    sine_bounded_radians(fixed_angle(fixed_degrees))
}

fn cosine_fixed_angle(fixed_degrees: u32) -> f64 {
    cosine_bounded_radians(fixed_angle(fixed_degrees))
}

/// 1401434d0: all finite ratios reachable from two signed32 operands.
fn atan_integer_ratio(ratio: f64) -> f64 {
    let negative = ratio.is_sign_negative();
    let mut reduced = ratio.abs();
    let mut high = 0.0;
    let mut low = 0.0;
    if reduced > 2.4375 {
        high = 1.5707963267948966;
        low = f64::from_bits(0x3c91a62633145c06);
        reduced = -1.0 / reduced;
    } else if reduced > 1.1875 {
        high = 0.982793723247329;
        low = f64::from_bits(0x3c7007887af0cbbc);
        reduced = (reduced - 1.5) / (reduced * 1.5 + 1.0);
    } else if reduced > 0.6875 {
        high = 0.7853981633974483;
        low = f64::from_bits(0x3c81a62633145c06);
        reduced = (reduced - 1.0) / (reduced + 1.0);
    } else if reduced > 0.4375 {
        high = 0.4636476090008061;
        low = f64::from_bits(0x3c7a2b7f222f65e0);
        reduced = (reduced + reduced - 1.0) / (reduced + 2.0);
    }
    let square = reduced * reduced;
    let mut numerator = square * 0.00014231690334231778 + 0.030445591950485303;
    numerator = numerator * square + 0.22063878071666743;
    numerator = numerator * square + 0.4476772068054975;
    numerator = numerator * square + 0.2682979205325459;
    let mut denominator = square * 0.03895258739447422 + 0.4246025942038471;
    denominator = denominator * square + 1.4125425993195893;
    denominator = denominator * square + 1.8259678773750707;
    denominator = denominator * square + 0.8048937615976377;
    let result = high - ((numerator * (square * reduced)) / denominator - low - reduced);
    if negative {
        -result
    } else {
        result
    }
}

/// 140024db0 baseline powf, restricted to its complete signed32-fixed input domain.
fn power_fixed(base_cell: u32, exponent_cell: u32) -> f64 {
    let base = fround(fround(base_cell as i32 as f64) / 65536.0);
    let power = fround(fround(exponent_cell as i32 as f64) / 65536.0);
    if power == 0.0 {
        return 1.0;
    }
    if power == 1.0 {
        return base;
    }
    if base == 0.0 {
        return if power < 0.0 { f64::INFINITY } else { 0.0 };
    }
    let mut negative = false;
    if base < 0.0 {
        if power != trunc(power) {
            return f64::NAN;
        }
        negative = (power as i64) % 2 != 0;
    }
    let logarithm;
    let delta = base - 1.0;
    if base < 1.0625 && delta.abs() < 0.0625 {
        let quotient = delta / (delta + 2.0);
        let twice = quotient + quotient;
        let square = twice * twice;
        let cube = twice * square;
        let seventh = square * square * cube;
        let first = cube * (square * 0.012500000003771751 + 0.08333333333333179);
        let second = seventh * (square * 0.0004348877777076146 + 0.0022321399879194482);
        logarithm = delta + (first + second - quotient * delta);
    } else {
        let encoding = base.to_bits();
        let mantissa = encoding & 0x000f_ffff_ffff_ffff;
        let index = ((mantissa >> 44) + ((mantissa >> 43) & 1)) as usize;
        let normalized = f64::from_bits(mantissa | 0x3fe0_0000_0000_0000);
        let table_center = f64::from_bits(((index as u64) | 0x3fe00) << 44);
        let relative = (table_center - normalized) * f64::from_bits(POW_RECIPROCAL[index]);
        let polynomial = relative * relative * (relative * 0.3333333333333333 + 0.5) + relative;
        logarithm = (((encoding >> 52) & 0x7ff) as f64 - 1023.0) * 0.6931471805599453
            + f64::from_bits(POW_LOG[index])
            - polynomial;
    }
    let product = power * logarithm;
    if product > 88.72283935546875 {
        return if negative { f64::NEG_INFINITY } else { f64::INFINITY };
    }
    if product <= -103.2789306640625 {
        return if negative { -0.0 } else { 0.0 };
    }
    let scale = round_to_int32(product * 92.33248261689366);
    let reduced = product - scale as f64 * 0.010830424696249145;
    let polynomial = reduced * reduced * (reduced * 0.16666666666666666 + 0.5) + reduced;
    let factor = f64::from_bits(POW_EXPONENTIAL[(scale & 63) as usize]);
    let encoded =
        (polynomial * factor + factor).to_bits().wrapping_add(((scale >> 6) as i64 as u64) << 52);
    let result = fround(f64::from_bits(encoded));
    if negative {
        -result
    } else {
        result
    }
}

/// 1400315f0, shared by primary 43 and native touch-history direction queries.
fn vector_angle(x: i32, y: i32) -> i32 {
    if x == 0 {
        return if y == 0 {
            0
        } else if y > 0 {
            0x5a0000
        } else {
            0x10e0000
        };
    }
    let arc = atan_integer_ratio(y as f64 / x as f64);
    if x > 0 && y >= 0 {
        truncate_int32((arc * 11796480.0) / PI)
    } else {
        (if x > 0 { 0x1680000 } else { 0xb40000 }) - truncate_int32((arc * -11796480.0) / PI)
    }
}

fn floor_int32(value: f64) -> u32 {
    truncate_int32(floor(value)) as u32
}

pub fn dispatch(vm: &mut Vm, opcode: u32) -> Option<Step<u32>> {
    Some(match opcode {
        0x43 => (|| {
            let y = vm.pop()? as i32;
            let x = vm.pop()? as i32;
            vm.push(vector_angle(x, y) as u32)?;
            Ok(0)
        })(),
        0x44 => (|| {
            let z = vm.pop()? as i32 as f64;
            let y = vm.pop()? as i32 as f64;
            let x = vm.pop()? as i32 as f64;
            vm.push(truncate_int32(sqrt(y * y + x * x + z * z)) as u32)?;
            Ok(0)
        })(),
        0x45 => (|| {
            let z_angle = vm.pop()?;
            let y_angle = vm.pop()?;
            let x_angle = vm.pop()?;
            let source = vm.pop()?;
            let source = vm.pointer(source)?;
            let destination = vm.pop()?;
            let destination = vm.pointer(destination)?;
            let input = source.span(0, 12)?;
            vm.determinate(input, 12)?;
            let (x, y, z) = unsafe {
                (
                    load32(input) as i32 as f64,
                    load32(input + 4) as i32 as f64,
                    load32(input + 8) as i32 as f64,
                )
            };
            let sx = sine_fixed_angle(x_angle);
            let cx = cosine_fixed_angle(x_angle);
            let after_xy = cx * y - sx * z;
            let after_xz = cx * z + sx * y;
            let sy = sine_fixed_angle(y_angle);
            let cy = cosine_fixed_angle(y_angle);
            let after_yx = sy * after_xz + cy * x;
            let sz = sine_fixed_angle(z_angle);
            let cz = cosine_fixed_angle(z_angle);
            let output = destination.span(0, 12)?;
            vm.determinate(output, 12)?;
            vm.store(output, 4, floor_int32(cz * after_yx - sz * after_xy + 0.5))?;
            vm.store(output + 4, 4, floor_int32(cz * after_xy + sz * after_yx + 0.5))?;
            vm.store(output + 8, 4, floor_int32(cy * after_xz - sy * x + 0.5))?;
            Ok(0)
        })(),
        0x48 => (|| {
            let angle = vm.pop()?;
            vm.push(truncate_int32(sine_fixed_angle(angle) * 65536.0) as u32)?;
            Ok(0)
        })(),
        0x49 => (|| {
            let angle = vm.pop()?;
            vm.push(truncate_int32(cosine_fixed_angle(angle) * 65536.0) as u32)?;
            Ok(0)
        })(),
        0x55 => (|| {
            let power = vm.pop()?;
            let base = vm.pop()?;
            vm.push(fixed_result(power_fixed(base, power)) as u32)?;
            Ok(0)
        })(),
        _ => return None,
    })
}
