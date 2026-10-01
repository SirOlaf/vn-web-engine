package vn.bgi;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.*;

/**
 * Archive entry decoders for BGI program modules: the BSE 1.1 header transform and the
 * DSC FORMAT 1.00 Huffman/LZ compression. Ports of src/formats/buriko/bse.ts and dsc.ts.
 */
public final class BgiArchiveCodec {

	private BgiArchiveCodec() {
	}

	/** Removes BSE and DSC layers, in that order, when present. */
	public static byte[] decode(byte[] bytes) throws IOException {
		if (startsWith(bytes, "BSE 1.1\0")) {
			bytes = decodeBse(bytes);
		}
		if (startsWith(bytes, "DSC FORMAT 1.00\0")) {
			bytes = decodeDsc(bytes);
		}
		return bytes;
	}

	static boolean startsWith(byte[] bytes, String signature) {
		byte[] expected = signature.getBytes(StandardCharsets.ISO_8859_1);
		return bytes.length >= expected.length &&
			Arrays.equals(bytes, 0, expected.length, expected, 0, expected.length);
	}

	private static int u16(byte[] b, int at) {
		return (b[at] & 0xff) | ((b[at + 1] & 0xff) << 8);
	}

	private static int i32(byte[] b, int at) {
		return u16(b, at) | (u16(b, at + 2) << 16);
	}

	public static byte[] decodeBse(byte[] bytes) throws IOException {
		if (bytes.length < 80 || !startsWith(bytes, "BSE 1.1\0") || u16(bytes, 8) != 0x101) {
			throw new IOException("Not BSE 1.1 version 0x0101");
		}
		int[] seed = { i32(bytes, 12) };
		java.util.function.IntSupplier random = () -> {
			int x = (((seed[0] * 127) >> 7) + seed[0] * 83 + 53) ^ 0xb97a7e5c;
			seed[0] = (x >>> 16) | (x << 16);
			return seed[0] & 0x7fff;
		};
		byte[] output = Arrays.copyOfRange(bytes, 16, bytes.length);
		boolean[] used = new boolean[64];
		for (int i = 0; i < 64; i++) {
			int index = random.getAsInt() & 63;
			while (used[index]) {
				index = (index + 1) & 63;
			}
			int shift = random.getAsInt() & 7;
			int direction = random.getAsInt() & 1;
			int value = ((output[index] & 0xff) - random.getAsInt()) & 255;
			output[index] = (byte) (direction != 0 ? (value << shift) | (value >>> (8 - shift))
					: (value >>> shift) | (value << (8 - shift)));
			used[index] = true;
		}
		int sum = 0, xor = 0;
		for (int i = 0; i < 64; i++) {
			sum = (sum + (output[i] & 0xff)) & 255;
			xor ^= output[i] & 0xff;
		}
		if (sum != (bytes[10] & 0xff) || xor != (bytes[11] & 0xff)) {
			throw new IOException("BSE checksum mismatch");
		}
		return output;
	}

	public static byte[] decodeDsc(byte[] bytes) throws IOException {
		if (bytes.length < 0x220 || !startsWith(bytes, "DSC FORMAT 1.00\0")) {
			throw new IOException("Not DSC FORMAT 1.00");
		}
		int[] seed = { i32(bytes, 16) };
		long size = i32(bytes, 20) & 0xffffffffL;
		long tokens = i32(bytes, 24) & 0xffffffffL;
		if (size > 0x4000000) {
			throw new IOException("DSC decoded size exceeds the resource limit");
		}
		java.util.function.IntSupplier random = () -> {
			int product = seed[0] * 0x015a4e35;
			seed[0] = product + 1;
			return (product >>> 16) & 255;
		};
		List<int[]> symbols = new ArrayList<>(); // {symbol, length}
		for (int symbol = 0; symbol < 512; symbol++) {
			int length = ((bytes[32 + symbol] & 0xff) - random.getAsInt()) & 255;
			if (length != 0) {
				symbols.add(new int[] { symbol, length });
			}
		}
		symbols.sort((a, b) -> a[1] != b[1] ? a[1] - b[1] : a[0] - b[0]);

		// Canonical tree: each depth assigns leaves first, then splits the remaining nodes.
		List<int[]> nodes = new ArrayList<>(); // {symbol, child0, child1}
		nodes.add(new int[] { -1, -1, -1 });
		List<Integer> level = List.of(0);
		int cursor = 0;
		for (int depth = 0; cursor < symbols.size(); depth++) {
			List<Integer> next = new ArrayList<>();
			for (int index : level) {
				int[] node = nodes.get(index);
				if (cursor < symbols.size() && symbols.get(cursor)[1] == depth) {
					node[0] = symbols.get(cursor++)[0];
				}
				else {
					node[1] = nodes.size();
					node[2] = nodes.size() + 1;
					next.add(node[1]);
					next.add(node[2]);
					nodes.add(new int[] { -1, -1, -1 });
					nodes.add(new int[] { -1, -1, -1 });
					if (nodes.size() > 1023) {
						throw new IOException("Invalid DSC Huffman tree");
					}
				}
			}
			if (next.isEmpty() && cursor < symbols.size()) {
				throw new IOException("Oversubscribed DSC Huffman tree");
			}
			level = next;
		}
		if (symbols.isEmpty() && tokens != 0) {
			throw new IOException("Empty DSC Huffman tree");
		}

		int start = 0x220;
		long bitLength = (long) (bytes.length - start) * 8;
		long[] position = { 0 };
		byte[] output = new byte[(int) size];
		int p = 0;
		for (long token = 0; token < tokens; token++) {
			int[] node = nodes.get(0);
			while (node[0] < 0) {
				if (position[0] >= bitLength || node[1] < 0) {
					throw new IOException("Invalid or truncated DSC code");
				}
				int bit = bit(bytes, start, position[0]++);
				node = nodes.get(node[1 + bit]);
			}
			int symbol = node[0];
			if (symbol < 256) {
				if (p >= size) {
					throw new IOException("DSC output overflow");
				}
				output[p++] = (byte) symbol;
				continue;
			}
			int count = (symbol & 255) + 2;
			if (position[0] + 12 > bitLength) {
				throw new IOException("Truncated DSC stream");
			}
			int distance = 0;
			for (int i = 0; i < 12; i++) {
				distance = (distance << 1) | bit(bytes, start, position[0]++);
			}
			distance += 2;
			if (distance > p) {
				throw new IOException("DSC backreference precedes output");
			}
			if (p + count > size) {
				throw new IOException("DSC output overflow");
			}
			for (int end = p + count; p < end; p++) {
				output[p] = output[p - distance];
			}
		}
		if (p != size) {
			throw new IOException("DSC size mismatch: " + p + " != " + size);
		}
		return output;
	}

	private static int bit(byte[] bytes, int start, long position) {
		return ((bytes[start + (int) (position >>> 3)] & 0xff) >>> (7 - (position & 7))) & 1;
	}
}
