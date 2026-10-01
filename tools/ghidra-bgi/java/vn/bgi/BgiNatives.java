package vn.bgi;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

import com.google.gson.*;

import generic.jar.ResourceFile;
import ghidra.framework.Application;
import ghidra.program.model.lang.SleighLanguageDescription;
import ghidra.program.model.lang.Language;
import ghidra.program.model.lang.LanguageDescription;

/** Native slot names and operand-stack effects generated from the engine sources. */
public final class BgiNatives {

	/** Stub functions of native slots live at NATIVE_BASE + primary * 0x400 + secondary * 4. */
	public static final long NATIVE_BASE = 0xf0000000L;
	public static final long NATIVE_SIZE = 0x40000L;

	/**
	 * A native slot; pops/pushes are -1 when the generator could not determine them.
	 * {@code pointerParams[i]} marks argument i (push order) as a VM pointer.
	 */
	public record Slot(int primary, int secondary, String name, int pops, int pushes,
			boolean[] pointerParams, String source) {
		public long stubOffset() {
			return NATIVE_BASE + primary * 0x400L + secondary * 4L;
		}

		public boolean knownEffect() {
			return pops >= 0 && pushes >= 0;
		}
	}

	private final Map<Integer, Slot> slots;
	private final boolean[] banks = new boolean[256];
	private final boolean[] primaries = new boolean[256];

	private BgiNatives(Map<Integer, Slot> slots, boolean[] primaries) {
		this.slots = slots;
		for (Slot slot : slots.values()) {
			banks[slot.primary] = true;
		}
		System.arraycopy(primaries, 0, this.primaries, 0, 256);
	}

	/** True when the revision's primary dispatch table has a handler for the opcode. */
	public boolean isPrimary(int opcode) {
		return primaries[opcode & 0xff];
	}

	public boolean isBank(int primary) {
		return banks[primary & 0xff];
	}

	public java.util.Collection<Slot> slots() {
		return slots.values();
	}

	public Slot slot(int primary, int secondary) {
		return slots.get(((primary & 0xff) << 8) | (secondary & 0xff));
	}

	private static final Map<String, BgiNatives> CACHE = new HashMap<>();

	/** Reads bgi_natives_<revision>.json beside the language's compiled SLEIGH file. */
	public static BgiNatives forLanguage(Language language, BgiRevision revision)
			throws IOException {
		LanguageDescription description = language.getLanguageDescription();
		if (!(description instanceof SleighLanguageDescription sleigh)) {
			throw new IOException("BGI language is not a SLEIGH language");
		}
		return read(sleigh.getSlaFile().getParentFile().getFile(false), revision);
	}

	/** Reads the table from the installed extension's data/languages directory. */
	public static BgiNatives forRevision(BgiRevision revision) throws IOException {
		ResourceFile file = Application.getModuleDataFile(MODULE,
			"languages/bgi_natives_" + revision.fileId + ".json");
		return read(file.getParentFile().getFile(false), revision);
	}

	private static final String MODULE = "BGI";

	static synchronized BgiNatives read(File directory, BgiRevision revision)
			throws IOException {
		String key = revision.fileId;
		BgiNatives cached = CACHE.get(key);
		if (cached != null) {
			return cached;
		}
		File file = new File(directory, "bgi_natives_" + revision.fileId + ".json");
		try (Reader reader = new InputStreamReader(new FileInputStream(file),
			StandardCharsets.UTF_8)) {
			JsonObject root = JsonParser.parseReader(reader).getAsJsonObject();
			Map<Integer, Slot> slots = new HashMap<>();
			for (JsonElement element : root.getAsJsonArray("natives")) {
				JsonObject n = element.getAsJsonObject();
				int primary = n.get("primary").getAsInt();
				int secondary = n.get("secondary").getAsInt();
				int pops = n.get("pops").isJsonNull() ? -1 : n.get("pops").getAsInt();
				int pushes = n.get("pushes").isJsonNull() ? -1 : n.get("pushes").getAsInt();
				boolean[] pointers = null;
				if (n.has("params") && !n.get("params").isJsonNull()) {
					JsonArray params = n.getAsJsonArray("params");
					pointers = new boolean[params.size()];
					for (int i = 0; i < pointers.length; i++) {
						pointers[i] = "ptr".equals(params.get(i).getAsString());
					}
				}
				String source = n.has("source") && !n.get("source").isJsonNull()
						? n.get("source").getAsString()
						: null;
				slots.put((primary << 8) | secondary, new Slot(primary, secondary,
					n.get("name").getAsString(), pops, pushes, pointers, source));
			}
			boolean[] primaries = new boolean[256];
			for (JsonElement element : root.getAsJsonArray("primaries")) {
				primaries[element.getAsInt() & 0xff] = true;
			}
			BgiNatives natives = new BgiNatives(slots, primaries);
			CACHE.put(key, natives);
			return natives;
		}
		catch (JsonParseException | IllegalStateException e) {
			throw new IOException("Malformed " + file + ": " + e.getMessage(), e);
		}
	}
}
