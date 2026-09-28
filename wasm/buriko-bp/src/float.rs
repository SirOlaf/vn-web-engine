//! JavaScript `Number` operations over `f64`: `Math.fround`, `Math.trunc`, `Math.floor`,
//! `Math.round`, `Math.min` and `Math.sqrt`.

const SIGN: u64 = 1 << 63;
const FRACTION: u64 = (1 << 52) - 1;

/// `Math.fround`.
#[inline]
pub fn fround(value: f64) -> f64 {
    value as f32 as f64
}

/// Unbiased exponent field, 0..=2047.
#[inline]
pub fn exponent_field(value: f64) -> u32 {
    ((value.to_bits() >> 52) & 0x7ff) as u32
}

/// `Math.trunc`.
pub fn trunc(value: f64) -> f64 {
    let bits = value.to_bits();
    let exponent = exponent_field(value) as i32 - 1023;
    if exponent >= 52 {
        return value;
    }
    if exponent < 0 {
        return f64::from_bits(bits & SIGN);
    }
    f64::from_bits(bits & !(FRACTION >> exponent))
}

/// `Math.floor`.
pub fn floor(value: f64) -> f64 {
    let truncated = trunc(value);
    if value < truncated {
        truncated - 1.0
    } else {
        truncated
    }
}

/// `Math.round`: halves round toward +Infinity; negative inputs above -0.5 give -0.
pub fn round(value: f64) -> f64 {
    if value.is_nan() || value.is_infinite() {
        return value;
    }
    let below = floor(value);
    let rounded = if value - below >= 0.5 { below + 1.0 } else { below };
    if rounded == 0.0 && value.is_sign_negative() {
        -0.0
    } else {
        rounded
    }
}

/// `Math.min(left, right)`: NaN propagates and -0 is below +0.
pub fn min(left: f64, right: f64) -> f64 {
    if left.is_nan() || right.is_nan() {
        return f64::NAN;
    }
    if left == right {
        return if left.is_sign_negative() { left } else { right };
    }
    if left < right {
        left
    } else {
        right
    }
}

/// `2 ** exponent` for exponents with a normal binary64 result.
#[inline]
pub fn power_of_two(exponent: i32) -> f64 {
    f64::from_bits(((exponent + 1023) as u64) << 52)
}

/// `Math.sqrt`: IEEE square root, rounded to nearest even.
pub fn sqrt(value: f64) -> f64 {
    if value.is_nan() || value < 0.0 {
        return f64::NAN;
    }
    if value == 0.0 || value.is_infinite() {
        return value;
    }
    let bits = value.to_bits();
    let mut field = exponent_field(value) as i32;
    let mut significand = bits & FRACTION;
    if field == 0 {
        while significand & (1 << 52) == 0 {
            significand <<= 1;
            field -= 1;
        }
        field += 1;
    } else {
        significand |= 1 << 52;
    }
    let mut exponent = field - 1075;
    if exponent & 1 != 0 {
        significand <<= 1;
        exponent -= 1;
    }
    let scaled = (significand as u128) << 60;
    let mut root: u128 = 0;
    let mut remainder = scaled;
    let mut bit: u128 = 1 << 126;
    while bit > scaled {
        bit >>= 2;
    }
    while bit != 0 {
        if remainder >= root + bit {
            remainder -= root + bit;
            root = (root >> 1) + bit;
        } else {
            root >>= 1;
        }
        bit >>= 2;
    }
    let sticky = remainder != 0 || root & 7 != 0;
    let half = root & 8 != 0;
    let mut result = (root >> 4) as u64;
    if half && (sticky || result & 1 != 0) {
        result += 1;
    }
    let mut result_exponent = exponent / 2 - 26;
    if result == 1 << 53 {
        result >>= 1;
        result_exponent += 1;
    }
    f64::from_bits((((result_exponent + 52 + 1023) as u64) << 52) | (result & FRACTION))
}
