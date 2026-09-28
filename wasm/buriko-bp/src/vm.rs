//! Run state, arena access, rollback and the dispatch loop.

use core::ptr::{read_unaligned, write_unaligned};

/// Thread registers, region bases and ABI parameters exchanged with JavaScript for one run.
/// Every field is a little-endian `u32`; `bp_control` returns its address.
#[repr(C)]
pub struct Control {
    pub pc: u32,
    pub instruction_start: u32,
    pub stack_index: u32,
    pub frame_cursor: u32,
    /// Arena offset of the operand cells; their tags follow `stack_capacity` cells later.
    pub stack_base: u32,
    pub stack_capacity: u32,
    pub module_base: u32,
    pub module_size: u32,
    pub frame_base: u32,
    pub frame_size: u32,
    pub heap_base: u32,
    pub heap_size: u32,
    pub has_heap: u32,
    pub global_base: u32,
    pub global_size: u32,
    pub frame_floor: u32,
    pub frame_limit: u32,
    /// `moduleFloor + moduleCapacity` of the storage owner (`validCodeAddress`).
    pub code_limit: u32,
    pub address_bits: u32,
    pub address_mask: u32,
    pub module_tag: u32,
    pub frame_tag: u32,
    pub heap_tag: u32,
    pub indirect_handles: u32,
    pub bitmap_offset: u32,
    pub watch_enabled: u32,
    /// Maximum instructions to execute.
    pub limit: u32,
    /// Out: instructions executed and committed.
    pub executed: u32,
    /// Out: handler result of the last executed instruction.
    pub result: u32,
    /// Out: why the run stopped (`STATUS_*`).
    pub status: u32,
    /// Out: entries in the call-site log.
    pub call_log_count: u32,
    /// Out: whether the last executed instruction is batchable.
    pub last_batchable: u32,
}

/// Stopped at `limit`, or because the call-site log is full.
pub const STATUS_LIMIT: u32 = 0;
/// The next instruction must run in TypeScript; it has not been started.
pub const STATUS_HOST: u32 = 1;
/// The last instruction returned a nonzero handler result.
pub const STATUS_RESULT: u32 = 2;
/// The last instruction is not batchable; the host checks its clock before continuing.
pub const STATUS_UNBATCHED: u32 = 3;

/// Opcode flag: wasm implements the opcode and the interpreter uses its canonical handler.
pub const FLAG_ENABLED: u8 = 1;
/// Opcode flag: the scheduler may amortize its clock checkpoint after this opcode.
pub const FLAG_BATCHABLE: u8 = 2;

const CALL_LOG_CAPACITY: usize = 4096;
/// Log entries: a pushed call site, or `CALL_POP` for a removed one.
pub const CALL_POP: u64 = 1 << 32;

const UNDO_CAPACITY: usize = 1024;

static mut CONTROL: Control = Control {
    pc: 0,
    instruction_start: 0,
    stack_index: 0,
    frame_cursor: 0,
    stack_base: 0,
    stack_capacity: 0,
    module_base: 0,
    module_size: 0,
    frame_base: 0,
    frame_size: 0,
    heap_base: 0,
    heap_size: 0,
    has_heap: 0,
    global_base: 0,
    global_size: 0,
    frame_floor: 0,
    frame_limit: 0,
    code_limit: 0,
    address_bits: 0,
    address_mask: 0,
    module_tag: 0,
    frame_tag: 0,
    heap_tag: 0,
    indirect_handles: 0,
    bitmap_offset: 0,
    watch_enabled: 0,
    limit: 0,
    executed: 0,
    result: 0,
    status: 0,
    call_log_count: 0,
    last_batchable: 0,
};
static mut OPCODE_FLAGS: [u8; 256] = [0; 256];
static mut CALL_LOG: [u64; CALL_LOG_CAPACITY] = [0; CALL_LOG_CAPACITY];

#[no_mangle]
pub extern "C" fn bp_control() -> *mut Control {
    core::ptr::addr_of_mut!(CONTROL)
}

#[no_mangle]
pub extern "C" fn bp_opcode_flags() -> *mut u8 {
    core::ptr::addr_of_mut!(OPCODE_FLAGS) as *mut u8
}

#[no_mangle]
pub extern "C" fn bp_call_log() -> *mut u64 {
    core::ptr::addr_of_mut!(CALL_LOG) as *mut u64
}

/// The instruction cannot complete here; it is rolled back and handed to TypeScript.
pub struct Host;
pub type Step<T> = Result<T, Host>;

/// A resolved bank address: region base and size, and the offset within the region.
#[derive(Clone, Copy)]
pub struct Place {
    pub base: u32,
    pub size: u32,
    pub offset: u32,
}

impl Place {
    /// Arena address of `length` bytes at `offset + displacement`, bounds-checked like
    /// `pointerBytes` and the scalar accessors.
    #[inline]
    pub fn span(&self, displacement: u64, length: u64) -> Step<u32> {
        let start = self.offset as u64 + displacement;
        if start + length > self.size as u64 {
            return Err(Host);
        }
        Ok(self.base + start as u32)
    }
}

pub struct Vm {
    pub c: Control,
    undo_address: [u32; UNDO_CAPACITY],
    undo_value: [u32; UNDO_CAPACITY],
    undo_width: [u8; UNDO_CAPACITY],
    undo_count: usize,
    pub call_log_count: usize,
}

#[inline]
pub unsafe fn load8(address: u32) -> u32 {
    *(address as usize as *const u8) as u32
}
#[inline]
pub unsafe fn load16(address: u32) -> u32 {
    read_unaligned(address as usize as *const u16) as u32
}
#[inline]
pub unsafe fn load32(address: u32) -> u32 {
    read_unaligned(address as usize as *const u32)
}
#[inline]
unsafe fn store_raw(address: u32, width: u8, value: u32) {
    match width {
        1 => *(address as usize as *mut u8) = value as u8,
        2 => write_unaligned(address as usize as *mut u16, value as u16),
        _ => write_unaligned(address as usize as *mut u32, value),
    }
}

/// Packed access selectors use signed byte for every selector except 1 and 2.
#[inline]
pub fn access_size(kind: u32) -> u32 {
    match kind {
        2 => 4,
        1 => 2,
        _ => 1,
    }
}

impl Vm {
    // ---- rollback -------------------------------------------------------------------------

    /// Writes `value` with the prior contents logged for rollback.
    #[inline]
    pub fn store(&mut self, address: u32, width: u8, value: u32) -> Step<()> {
        if self.undo_count == UNDO_CAPACITY {
            return Err(Host);
        }
        let old = unsafe {
            match width {
                1 => load8(address),
                2 => load16(address),
                _ => load32(address),
            }
        };
        self.undo_address[self.undo_count] = address;
        self.undo_value[self.undo_count] = old;
        self.undo_width[self.undo_count] = width;
        self.undo_count += 1;
        unsafe { store_raw(address, width, value) };
        Ok(())
    }

    fn rollback(&mut self) {
        while self.undo_count != 0 {
            self.undo_count -= 1;
            let i = self.undo_count;
            unsafe { store_raw(self.undo_address[i], self.undo_width[i], self.undo_value[i]) };
        }
    }

    // ---- provenance -----------------------------------------------------------------------

    /// True when any of `length` arena bytes at `address` is marked indeterminate.
    #[inline]
    pub fn marked(&self, address: u32, length: u32) -> bool {
        let bitmap = self.c.bitmap_offset;
        let mut at = address;
        let end = address + length;
        while at < end {
            let byte = unsafe { load8(bitmap + (at >> 3)) };
            if byte == 0 {
                at = (at | 7) + 1;
                continue;
            }
            if byte & (1 << (at & 7)) != 0 {
                return true;
            }
            at += 1;
        }
        false
    }

    /// Reads and writes of marked bytes fault or edit the side table; both belong to TypeScript.
    #[inline]
    pub fn determinate(&self, address: u32, length: u32) -> Step<()> {
        if self.marked(address, length) {
            Err(Host)
        } else {
            Ok(())
        }
    }

    // ---- banks ----------------------------------------------------------------------------

    /// `BurikoBpMemory.locate` for the banks wasm owns; everything else is host work.
    #[inline]
    pub fn resolve(&self, address: u32) -> Step<Place> {
        if address == 0 {
            return Err(Host);
        }
        let c = &self.c;
        let bank = address >> c.address_bits;
        let offset = address & c.address_mask;
        let (base, size) = match bank {
            0 => {
                if c.indirect_handles != 0 && address & 0x0fff_0000 == 0x0fff_0000 {
                    return Err(Host);
                }
                (c.global_base, c.global_size)
            }
            1 => (c.module_base, c.module_size),
            2 => (c.frame_base, c.frame_size),
            3 => {
                if c.has_heap == 0 {
                    return Err(Host);
                }
                (c.heap_base, c.heap_size)
            }
            _ => return Err(Host),
        };
        Ok(Place { base, size, offset })
    }

    #[inline]
    pub fn read_scalar_bytes(&self, address: u32, width: u32) -> Step<u32> {
        let at = self.resolve(address)?.span(0, width as u64)?;
        self.determinate(at, width)?;
        Ok(unsafe {
            match width {
                1 => load8(at),
                2 => load16(at),
                _ => load32(at),
            }
        })
    }

    /// `readScalar`: selector 2 is a signed DWORD, 1 a signed WORD, others a signed byte.
    #[inline]
    pub fn read_scalar(&self, address: u32, kind: u32) -> Step<u32> {
        let width = access_size(kind);
        let raw = self.read_scalar_bytes(address, width)?;
        Ok(match width {
            1 => raw as u8 as i8 as i32 as u32,
            2 => raw as u16 as i16 as i32 as u32,
            _ => raw,
        })
    }

    #[inline]
    pub fn read_u32(&self, address: u32) -> Step<u32> {
        self.read_scalar_bytes(address, 4)
    }

    /// `writeScalar`: the low `accessSize(kind)` bytes of `value`.
    #[inline]
    pub fn write_scalar(&mut self, address: u32, kind: u32, value: u32) -> Step<()> {
        let width = access_size(kind);
        let at = self.resolve(address)?.span(0, width as u64)?;
        self.determinate(at, width)?;
        self.store(at, width as u8, value)
    }

    /// `pointer()`: resolution faults only.
    #[inline]
    pub fn pointer(&self, address: u32) -> Step<Place> {
        self.resolve(address)
    }

    #[inline]
    pub fn local_address(&self, displacement: u32) -> u32 {
        self.c.frame_cursor.wrapping_sub(displacement) | self.c.frame_tag
    }

    /// `validCodeAddress` of the storage owner.
    #[inline]
    pub fn check_target(&self, target: u32, forbid_zero: bool) -> Step<()> {
        if (forbid_zero && target == 0) || target >= self.c.code_limit {
            Err(Host)
        } else {
            Ok(())
        }
    }

    #[inline]
    pub fn set_pc(&mut self, target: u32) {
        self.c.pc = target;
        self.c.instruction_start = target;
    }

    // ---- decoding -------------------------------------------------------------------------

    #[inline]
    pub fn code_byte(&self, at: u32) -> Step<u32> {
        if at >= self.c.module_size {
            return Err(Host);
        }
        Ok(unsafe { load8(self.c.module_base + at) })
    }

    #[inline]
    pub fn read_u8(&mut self) -> Step<u32> {
        let value = self.code_byte(self.c.pc)?;
        self.c.pc = self.c.pc.wrapping_add(1);
        Ok(value)
    }

    #[inline]
    pub fn read_i8(&mut self) -> Step<i32> {
        Ok(self.read_u8()? as u8 as i8 as i32)
    }

    #[inline]
    pub fn read_u16(&mut self) -> Step<u32> {
        let pc = self.c.pc;
        if pc as u64 + 2 > self.c.module_size as u64 {
            return Err(Host);
        }
        self.c.pc = pc.wrapping_add(2);
        Ok(unsafe { load16(self.c.module_base + pc) })
    }

    #[inline]
    pub fn read_i16(&mut self) -> Step<i32> {
        Ok(self.read_u16()? as u16 as i16 as i32)
    }

    #[inline]
    pub fn read_u32_code(&mut self) -> Step<u32> {
        let pc = self.c.pc;
        if pc as u64 + 4 > self.c.module_size as u64 {
            return Err(Host);
        }
        self.c.pc = pc.wrapping_add(4);
        Ok(unsafe { load32(self.c.module_base + pc) })
    }

    /// The low DWORD of a 64-bit immediate.
    #[inline]
    pub fn read_u64_low(&mut self) -> Step<u32> {
        let pc = self.c.pc;
        if pc as u64 + 8 > self.c.module_size as u64 {
            return Err(Host);
        }
        self.c.pc = pc.wrapping_add(8);
        Ok(unsafe { load32(self.c.module_base + pc) })
    }

    /// Native payload shifts are 32-bit; terminal sign extension is a 64-bit shift.
    #[inline]
    pub fn read_var_int(&mut self) -> Step<i32> {
        let mut pc = self.c.pc;
        let mut value: u32 = 0;
        let mut shift: u32 = 0;
        let mut byte;
        loop {
            byte = self.code_byte(pc)?;
            pc = pc.wrapping_add(1);
            value |= (byte & 0x7f) << (shift & 31);
            shift = shift.wrapping_add(7);
            if byte & 0x80 == 0 {
                break;
            }
        }
        let sign_shift = shift & 63;
        if byte & 0x40 != 0 && sign_shift < 32 {
            value |= u32::MAX << sign_shift;
        }
        self.c.pc = pc;
        Ok(value as i32)
    }

    /// Returns (type, value).
    #[inline]
    pub fn read_typed_var_int(&mut self) -> Step<(u32, i32)> {
        let mut pc = self.c.pc;
        let mut value: i32 = 0;
        let mut shift: u32 = 0;
        let mut kind = 0;
        let mut first = true;
        let mut byte;
        loop {
            byte = self.code_byte(pc)?;
            pc = pc.wrapping_add(1);
            value |= ((byte & 0x7f) << (shift & 31)) as i32;
            shift = shift.wrapping_add(7);
            if first {
                kind = (value & 3) as u32;
                value >>= 2;
                shift = shift.wrapping_sub(2);
                first = false;
            }
            if byte & 0x80 == 0 {
                break;
            }
        }
        let sign_shift = shift & 63;
        if byte & 0x40 != 0 && sign_shift < 32 {
            value |= (u32::MAX << sign_shift) as i32;
        }
        self.c.pc = pc;
        Ok((kind, value))
    }

    /// (displacement-derived local address, type) from a packed 16-bit descriptor.
    #[inline]
    pub fn local_descriptor(&mut self) -> Step<(u32, u32)> {
        let descriptor = self.read_u16()?;
        Ok((self.local_address(descriptor & 0x3fff), descriptor >> 14))
    }

    // ---- operand stack --------------------------------------------------------------------

    #[inline]
    fn cell(&self, index: u32) -> u32 {
        self.c.stack_base + index * 4
    }
    #[inline]
    fn tag(&self, index: u32) -> u32 {
        self.c.stack_base + (self.c.stack_capacity + index) * 4
    }

    #[inline]
    pub fn push(&mut self, value: u32) -> Step<()> {
        let index = self.c.stack_index;
        let capacity = self.c.stack_capacity;
        if index >= capacity {
            return Err(Host);
        }
        self.store(self.cell(index), 4, value)?;
        if unsafe { load32(self.tag(index)) } != 0 {
            self.store(self.tag(index), 4, 0)?;
        }
        let next = index + 1;
        self.c.stack_index = if next >= capacity { 0 } else { next };
        Ok(())
    }

    /// Moves the index down one cell; returns (value, tag).
    #[inline]
    pub fn pop_deferred(&mut self) -> Step<(u32, u32)> {
        let capacity = self.c.stack_capacity;
        let index = if self.c.stack_index == 0 {
            capacity.wrapping_sub(1)
        } else {
            self.c.stack_index - 1
        };
        self.c.stack_index = index;
        if index >= capacity {
            return Err(Host);
        }
        Ok(unsafe { (load32(self.cell(index)), load32(self.tag(index))) })
    }

    /// An unwritten operand faults with its reason, which TypeScript formats.
    #[inline]
    pub fn pop(&mut self) -> Step<u32> {
        let (value, tag) = self.pop_deferred()?;
        if tag != 0 {
            return Err(Host);
        }
        Ok(value)
    }

    /// `writeDeferredScalar` for a determinate operand; a tagged one marks memory (host).
    #[inline]
    pub fn write_deferred(&mut self, address: u32, kind: u32, word: (u32, u32)) -> Step<()> {
        if word.1 != 0 {
            return Err(Host);
        }
        self.write_scalar(address, kind, word.0)
    }

    // ---- call sites -----------------------------------------------------------------------

    #[inline]
    pub fn log_call(&mut self, entry: u64) {
        unsafe { (*core::ptr::addr_of_mut!(CALL_LOG))[self.call_log_count] = entry };
        self.call_log_count += 1;
    }

    // ---- bulk transport -------------------------------------------------------------------

    /// `moveBytes`: both spans are bounds-checked (source first); marked bytes on either
    /// side need the side table.
    pub fn move_bytes(&mut self, destination: Place, source: Place, size: u32) -> Step<()> {
        let from = source.span(0, size as u64)?;
        let to = destination.span(0, size as u64)?;
        self.determinate(from, size)?;
        self.determinate(to, size)?;
        unsafe {
            core::ptr::copy(from as usize as *const u8, to as usize as *mut u8, size as usize)
        };
        Ok(())
    }
}

static mut VM: Vm = Vm {
    c: Control {
        pc: 0,
        instruction_start: 0,
        stack_index: 0,
        frame_cursor: 0,
        stack_base: 0,
        stack_capacity: 0,
        module_base: 0,
        module_size: 0,
        frame_base: 0,
        frame_size: 0,
        heap_base: 0,
        heap_size: 0,
        has_heap: 0,
        global_base: 0,
        global_size: 0,
        frame_floor: 0,
        frame_limit: 0,
        code_limit: 0,
        address_bits: 0,
        address_mask: 0,
        module_tag: 0,
        frame_tag: 0,
        heap_tag: 0,
        indirect_handles: 0,
        bitmap_offset: 0,
        watch_enabled: 0,
        limit: 0,
        executed: 0,
        result: 0,
        status: 0,
        call_log_count: 0,
        last_batchable: 0,
    },
    undo_address: [0; UNDO_CAPACITY],
    undo_value: [0; UNDO_CAPACITY],
    undo_width: [0; UNDO_CAPACITY],
    undo_count: 0,
    call_log_count: 0,
};

fn dispatch(vm: &mut Vm, opcode: u32) -> Step<u32> {
    if let Some(result) = crate::control::dispatch(vm, opcode) {
        return result;
    }
    if let Some(result) = crate::integer::dispatch(vm, opcode) {
        return result;
    }
    if let Some(result) = crate::memory::dispatch(vm, opcode) {
        return result;
    }
    if let Some(result) = crate::locals::dispatch(vm, opcode) {
        return result;
    }
    if let Some(result) = crate::fixed::dispatch(vm, opcode) {
        return result;
    }
    if let Some(result) = crate::native_math::dispatch(vm, opcode) {
        return result;
    }
    Err(Host)
}

/// Runs the thread described by `bp_control` until a stop condition; see `STATUS_*`.
#[no_mangle]
pub extern "C" fn bp_run() {
    let vm = unsafe { &mut *core::ptr::addr_of_mut!(VM) };
    let flags = unsafe { &*core::ptr::addr_of!(OPCODE_FLAGS) };
    vm.c = unsafe { read_unaligned(core::ptr::addr_of!(CONTROL)) };
    vm.call_log_count = 0;
    let limit = vm.c.limit;
    let mut executed = 0;
    let mut status = STATUS_LIMIT;
    let mut result = 0;
    let mut last_batchable = 1;
    while executed < limit {
        // A call instruction appends at most one entry.
        if vm.call_log_count == CALL_LOG_CAPACITY {
            break;
        }
        let pc = vm.c.pc;
        if pc >= vm.c.module_size {
            status = STATUS_HOST;
            break;
        }
        let opcode = unsafe { load8(vm.c.module_base + pc) };
        let flag = flags[opcode as usize];
        if flag & FLAG_ENABLED == 0 {
            status = STATUS_HOST;
            break;
        }
        let saved = (vm.c.pc, vm.c.instruction_start, vm.c.stack_index, vm.c.frame_cursor);
        let saved_log = vm.call_log_count;
        vm.undo_count = 0;
        vm.c.instruction_start = pc;
        vm.c.pc = pc.wrapping_add(1);
        match dispatch(vm, opcode) {
            Ok(value) => {
                executed += 1;
                result = value;
                last_batchable = (flag & FLAG_BATCHABLE != 0) as u32;
                if value != 0 {
                    status = STATUS_RESULT;
                    break;
                }
                if last_batchable == 0 {
                    status = STATUS_UNBATCHED;
                    break;
                }
            }
            Err(Host) => {
                vm.rollback();
                (vm.c.pc, vm.c.instruction_start, vm.c.stack_index, vm.c.frame_cursor) = saved;
                vm.call_log_count = saved_log;
                status = STATUS_HOST;
                break;
            }
        }
    }
    vm.c.executed = executed;
    vm.c.result = result;
    vm.c.status = status;
    vm.c.call_log_count = vm.call_log_count as u32;
    vm.c.last_batchable = last_batchable;
    unsafe { write_unaligned(core::ptr::addr_of_mut!(CONTROL), read_unaligned(&vm.c)) };
}
