package vn.bgi;

/**
 * Decodes instruction lengths, control flow and operand-stack effects from module bytes.
 * The SLEIGH specification is the authority for semantics; this decoder only carries the
 * facts the stack analysis needs before any instruction is disassembled.
 */
public final class BgiDecoder {

	/** Module bytes addressed by module offset. Reads outside the module return -1. */
	public interface Bytes {
		int at(int offset);
	}

	public enum Flow {
		/** Continues at the next instruction. */
		NEXT,
		/** 13: unconditional relative jump. */
		JUMP,
		/** 14 and the popped-target form of 15: no statically known successor. */
		JUMP_INDIRECT,
		/** 15 (relative), 37, 3b: relative target or the next instruction. */
		BRANCH,
		/** 15 popped-target form: the next instruction or an unknown target. */
		BRANCH_INDIRECT,
		/** ee: direct call. */
		CALL,
		/** 16: call through a popped code address. */
		CALL_INDIRECT,
		/** ef: call through a global code-address variable. */
		CALL_GLOBAL,
		/** ff with an extension index: call into a registered extension module. */
		CALL_EXTENSION,
		/** 17 and ff f8. */
		RETURN,
	}

	/**
	 * One decoded instruction. {@code pops}/{@code pushes} are -1 when the effect depends on
	 * the callee or on data (calls, formatted text, natives without a known effect).
	 */
	/**
	 * {@code aux} is the native or ff secondary, or the type byte of 08/09/0a; {@code value}
	 * is the constant pushed by 00/01/02.
	 */
	public record Insn(int offset, int length, int opcode, Flow flow, int target, int pops,
			int pushes, int aux, String nativeName, int dataTarget, long value) {
		public int next() {
			return offset + length;
		}

		public boolean knownEffect() {
			return pops >= 0 && pushes >= 0;
		}
	}

	public static final class DecodeException extends Exception {
		public final int offset;

		DecodeException(int offset, String message) {
			super(String.format("0x%x: %s", offset, message));
			this.offset = offset;
		}
	}

	// Operand layouts: b u8, c s8, w u16, s s16, d u32, v varint, t typed varint.
	private static final String[] LAYOUT = new String[256];
	// Fixed effects as {pops, pushes}.
	private static final int[][] EFFECT = new int[256][];

	private static void op(int opcode, String layout, int pops, int pushes) {
		LAYOUT[opcode] = layout;
		EFFECT[opcode] = new int[] { pops, pushes };
	}

	static {
		op(0x00, "c", 0, 1);
		op(0x01, "s", 0, 1);
		op(0x02, "d", 0, 1);
		op(0x04, "w", 0, 1);
		op(0x05, "s", 0, 1);
		op(0x06, "s", 0, 1);
		op(0x08, "b", 1, 1);
		op(0x09, "b", 2, 0);
		op(0x0a, "b", 2, 0);
		op(0x0d, "t", 1, 0);
		op(0x0e, "wt", 0, 0);
		op(0x0f, "w", 1, 0);
		op(0x10, "", 0, 1);
		op(0x11, "", 1, 0);
		op(0x12, "v", 0, 0);
		op(0x13, "s", 0, 0);
		op(0x14, "", 1, 0);
		op(0x17, "", 0, 0);
		op(0x18, "d", 0, 1);
		op(0x19, "w", 0, 1);
		op(0x1a, "wv", 0, 1);
		op(0x1b, "wv", 1, 1);
		op(0x1c, "wc", 0, 1);
		op(0x1d, "w", 1, 1);
		op(0x1e, "w", 1, 1);
		op(0x1f, "t", 1, 1);
		for (int o : new int[] { 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x29, 0x2a, 0x2b,
			0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x38, 0x39, 0x43, 0x55, 0x56, 0x57, 0x66, 0x69 }) {
			op(o, "", 2, 1);
		}
		op(0x28, "", 1, 1);
		op(0x2c, "v", 1, 1);
		op(0x2d, "v", 1, 1);
		op(0x2e, "v", 2, 1);
		op(0x2f, "v", 1, 1);
		op(0x36, "bv", 1, 1);
		op(0x37, "bsv", 1, 0);
		op(0x3a, "", 1, 1);
		op(0x3b, "bs", 2, 0);
		op(0x3c, "c", 1, 1);
		op(0x3e, "b", 3, 0);
		op(0x3f, "bv", 2, 0);
		op(0x40, "", 3, 1);
		op(0x42, "", 3, 1);
		op(0x44, "", 3, 1);
		op(0x45, "", 5, 0);
		op(0x46, "", 4, 1);
		op(0x47, "", 3, 1);
		op(0x48, "", 1, 1);
		op(0x49, "", 1, 1);
		for (int o : new int[] { 0x50, 0x51, 0x52, 0x53, 0x54, 0x58, 0x59, 0x5a, 0x5b, 0x5e, 0x5f,
			0x60, 0x62, 0x6b, 0x6e }) {
			op(o, "", 3, 0);
		}
		op(0x5d, "", 2, 0);
		op(0x61, "", 2, 0);
		op(0x63, "", 3, 1);
		op(0x64, "", 4, 0);
		op(0x65, "", 4, 1);
		op(0x67, "", 4, 1);
		op(0x68, "", 1, 1);
		op(0x6a, "", 2, 0);
		op(0x6c, "", 1, 4);
		op(0x6d, "", 1, 0);
		op(0x70, "", 1, 1);
		op(0x71, "", 1, 1);
		op(0x73, "", 1, 0);
		op(0x74, "", 1, 0);
		op(0x75, "", 3, 1);
		op(0x77, "", 1, 1);
		op(0x78, "", 2, 1);
		op(0x79, "", 1, 0);
		op(0x7a, "", 1, 0);
		op(0x7b, "", 3, 0);
		op(0x7c, "", 2, 1);
		op(0x7d, "", 7, 0);
		op(0x7e, "", 1, 1);
		op(0xe4, "wt", 0, 1);
		op(0xe5, "wt", 1, 1);
		op(0xe6, "wt", 1, 0);
		op(0xe7, "wt", 2, 0);
		op(0xe8, "w", 3, 0);
		op(0xe9, "ww", 1, 0);
		op(0xea, "wwv", 0, 0);
		op(0xec, "v", 2, 0);
		op(0xed, "wv", 1, 0);
		op(0xf0, "dwv", 0, 0);
		op(0xf1, "wwv", 0, 0);
		op(0xf2, "wwwv", 0, 0);
		op(0xf4, "wdws", 0, 0);
		op(0xf5, "wwsws", 0, 0);
		op(0xf7, "wws", 1, 1);
		op(0xf8, "dws", 0, 1);
		op(0xf9, "wsws", 0, 1);
		op(0xfa, "dws", 0, 1);
		op(0xfb, "wws", 0, 1);
	}

	private final Bytes bytes;
	private final BgiRevision revision;
	private final BgiNatives natives;

	public BgiDecoder(Bytes bytes, BgiRevision revision, BgiNatives natives) {
		this.bytes = bytes;
		this.revision = revision;
		this.natives = natives;
	}

	private int pc;
	private int start;

	private int u8() throws DecodeException {
		int b = bytes.at(pc);
		if (b < 0) {
			throw new DecodeException(start, "instruction runs past the module");
		}
		pc++;
		return b;
	}

	private int s16() throws DecodeException {
		int lo = u8();
		return (short) (lo | (u8() << 8));
	}

	private int varint() throws DecodeException {
		int value = 0, shift = 0, b;
		do {
			b = u8();
			value |= (b & 0x7f) << (shift & 31);
			shift += 7;
			if (shift > 70) {
				throw new DecodeException(start, "unterminated varint");
			}
		}
		while ((b & 0x80) != 0);
		if ((b & 0x40) != 0 && shift < 32) {
			value |= -1 << shift;
		}
		return value;
	}

	private int operand(char kind) throws DecodeException {
		switch (kind) {
			case 'b':
				return u8();
			case 'c':
				return (byte) u8();
			case 'w':
				return u8() | (u8() << 8);
			case 's':
				return s16();
			case 'd':
				return u8() | (u8() << 8) | (u8() << 16) | (u8() << 24);
			case 'v':
			case 't':
				return varint();
			default:
				throw new IllegalStateException();
		}
	}

	public Insn decode(int offset) throws DecodeException {
		pc = offset;
		start = offset;
		int opcode = u8();
		if (!natives.isPrimary(opcode)) {
			throw new DecodeException(start,
				String.format("opcode %02x is not installed in BGI %s", opcode, revision.variant));
		}
		Flow flow = Flow.NEXT;
		int target = -1, secondary = -1, dataTarget = -1;
		long value = 0;
		String nativeName = null;
		int pops, pushes;

		if (natives.isBank(opcode) && !(opcode == 0x7f && !revision.relativeConditional)) {
			secondary = u8();
			BgiNatives.Slot slot = natives.slot(opcode, secondary);
			if (slot == null) {
				throw new DecodeException(start,
					String.format("native slot %02x:%02x is not installed", opcode, secondary));
			}
			nativeName = slot.name();
			// A known pop count with an unknown push count (a wait process pushes later)
			// keeps the exact arguments; the stack analysis estimates the result.
			pops = slot.pops();
			pushes = slot.pops() < 0 ? -1 : slot.pushes();
			return new Insn(offset, pc - offset, opcode, flow, target, pops, pushes, secondary,
				nativeName, dataTarget, 0);
		}

		switch (opcode) {
			case 0x03: {
				int control = u8();
				if (control < 0x80) {
					for (int i = 0; i <= control; i++) {
						varint();
					}
					pops = 0;
					pushes = control + 1;
				}
				else if ((control & 0x7c) == 0) {
					pc += new int[] { 1, 2, 4, 8 }[control & 3];
					pops = 0;
					pushes = 1;
				}
				else {
					pops = 0;
					pushes = 0;
				}
				break;
			}
			case 0x0b: {
				pc += u8();
				pops = 1;
				pushes = 0;
				break;
			}
			case 0x0c: {
				u8();
				int count = u8();
				pops = count + 1;
				pushes = 0;
				break;
			}
			case 0x15: {
				int control = u8();
				if (revision.relativeConditional && (control & 8) != 0) {
					target = offset + s16();
					flow = Flow.BRANCH;
					pops = 1;
				}
				else {
					flow = Flow.BRANCH_INDIRECT;
					pops = 2;
				}
				pushes = 0;
				break;
			}
			case 0x16:
				flow = Flow.CALL_INDIRECT;
				pops = -1;
				pushes = -1;
				break;
			case 0x6f:
				pops = -1;
				pushes = -1;
				break;
			case 0x7f:
				// Direct instruction in revisions without a 7f native bank.
				pops = 2;
				pushes = 0;
				break;
			case 0xe2:
			case 0xe3: {
				int count = u8() + 1;
				pc += 2 * count;
				pops = opcode == 0xe2 ? count : 0;
				pushes = opcode == 0xe3 ? count : 0;
				break;
			}
			case 0xee:
				target = offset + s16();
				flow = Flow.CALL;
				pops = -1;
				pushes = -1;
				break;
			case 0xef:
				dataTarget = operand('d') & 0x3fffffff;
				flow = Flow.CALL_GLOBAL;
				pops = -1;
				pushes = -1;
				break;
			case 0xff: {
				secondary = u8();
				if (secondary == 0xf0) {
					pops = 3;
					pushes = 0;
				}
				else if (secondary == 0xf1) {
					pops = 1;
					pushes = 0;
				}
				else if (secondary == 0xf8) {
					flow = Flow.RETURN;
					pops = 0;
					pushes = 0;
				}
				else {
					flow = Flow.CALL_EXTENSION;
					pops = -1;
					pushes = -1;
				}
				break;
			}
			default: {
				String layout = LAYOUT[opcode];
				if (layout == null) {
					throw new DecodeException(start, String.format("undefined opcode %02x", opcode));
				}
				int[] values = new int[layout.length()];
				for (int i = 0; i < values.length; i++) {
					values[i] = operand(layout.charAt(i));
				}
				pops = EFFECT[opcode][0];
				pushes = EFFECT[opcode][1];
				switch (opcode) {
					case 0x00:
					case 0x01:
						value = values[0];
						break;
					case 0x02:
						value = values[0] & 0xffffffffL;
						break;
					case 0x08:
					case 0x0a:
						secondary = values[0];
						break;
					case 0x05:
						dataTarget = offset + values[0];
						break;
					case 0x06:
						target = offset + values[0];
						break;
					case 0x09:
						secondary = values[0];
						if (!revision.storeConsumesValue) {
							pushes = 1;
						}
						break;
					case 0x13:
						target = offset + values[0];
						flow = Flow.JUMP;
						break;
					case 0x14:
						flow = Flow.JUMP_INDIRECT;
						break;
					case 0x17:
						flow = Flow.RETURN;
						break;
					case 0x18:
						dataTarget = values[0] & 0x3fffffff;
						break;
					case 0x37:
					case 0x3b:
						target = offset + values[1];
						flow = Flow.BRANCH;
						break;
					default:
						break;
				}
			}
		}
		return new Insn(offset, pc - offset, opcode, flow, target, pops, pushes, secondary,
			nativeName, dataTarget, value);
	}
}
