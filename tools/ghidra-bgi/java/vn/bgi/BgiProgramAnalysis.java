package vn.bgi;

import java.io.IOException;
import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.charset.*;
import java.util.*;

import ghidra.app.cmd.disassemble.DisassembleCommand;
import ghidra.app.cmd.function.CreateFunctionCmd;
import ghidra.app.util.importer.MessageLog;
import ghidra.framework.model.DomainFile;
import ghidra.framework.model.DomainFolder;
import ghidra.program.model.address.*;
import ghidra.program.model.data.*;
import ghidra.program.model.lang.Register;
import ghidra.program.model.lang.RegisterValue;
import ghidra.program.model.listing.*;
import ghidra.program.model.listing.Function.FunctionUpdateType;
import ghidra.program.model.mem.*;
import ghidra.program.model.symbol.*;
import ghidra.program.database.function.OverlappingFunctionException;
import ghidra.program.model.util.CodeUnitInsertionException;
import ghidra.util.exception.*;
import ghidra.util.task.TaskMonitor;

/**
 * Runs {@link BgiStackAnalysis} over a loaded module and applies it: instruction context,
 * disassembly, functions with parameter/result counts, text data and bookmarks for
 * estimated call sites. Re-running replaces the module's instructions but keeps
 * user-defined function names and signatures, comments and labels.
 */
public final class BgiProgramAnalysis {

	public static final String MODULE_BLOCK = "module";
	public static final String NATIVE_BLOCK = "natives";
	public static final String BOOKMARK_CATEGORY = "BGI stack";
	/**
	 * Program Information entry listing this module's exported global code-address slots as
	 * {@code slot:params:results:name} (hex slot) separated by semicolons. Sibling programs
	 * read it from file metadata without opening the program.
	 */
	public static final String SLOTS_PROPERTY = "BGI Global Code Slots";

	private BgiProgramAnalysis() {
	}

	/** The block holding the module bytes: the loader's block, else the one at the module tag. */
	public static MemoryBlock moduleBlock(Program program, BgiRevision revision) {
		Memory memory = program.getMemory();
		MemoryBlock block = memory.getBlock(MODULE_BLOCK);
		if (block != null) {
			return block;
		}
		Address tag = program.getAddressFactory().getDefaultAddressSpace().getAddress(
			revision.moduleTag);
		return memory.getBlock(tag);
	}

	public static boolean apply(Program program, TaskMonitor monitor, MessageLog log)
			throws CancelledException {
		BgiRevision revision = BgiRevision.of(program.getLanguage());
		if (revision == null) {
			return false;
		}
		BgiNatives natives;
		try {
			natives = BgiNatives.forLanguage(program.getLanguage(), revision);
		}
		catch (IOException e) {
			log.appendMsg("BGI", "Native slot table unavailable: " + e.getMessage());
			return false;
		}
		MemoryBlock block = moduleBlock(program, revision);
		if (block == null || !block.isInitialized()) {
			log.appendMsg("BGI", "No initialized module block to analyze");
			return false;
		}
		Address base = block.getStart();
		byte[] data = new byte[(int) block.getSize()];
		try {
			block.getBytes(base, data);
		}
		catch (MemoryAccessException e) {
			log.appendException(e);
			return false;
		}
		BgiDecoder.Bytes bytes =
			offset -> offset >= 0 && offset < data.length ? data[offset] & 0xff : -1;

		// Roots: the module entry plus functions already present (user-created or earlier runs).
		List<Integer> roots = new ArrayList<>();
		roots.add(0);
		for (Function f : program.getFunctionManager().getFunctions(
			new AddressSet(block.getStart(), block.getEnd()), true)) {
			roots.add((int) f.getEntryPoint().subtract(base));
		}

		createNativeStubs(program, natives, log);

		monitor.setMessage("BGI: computing operand-stack depths");
		Map<Long, int[]> imported = new HashMap<>();
		Map<Long, String> slotNames = new HashMap<>();
		siblingSlots(program, revision, imported, slotNames);
		BgiStackAnalysis analysis = new BgiStackAnalysis(bytes, revision, natives, imported);
		analysis.run(roots);
		monitor.checkCancelled();

		Listing listing = program.getListing();
		BookmarkManager bookmarks = program.getBookmarkManager();
		AddressSet range = new AddressSet(block.getStart(), block.getEnd());
		bookmarks.removeBookmarks(range, BookmarkType.ANALYSIS, BOOKMARK_CATEGORY, monitor);
		bookmarks.removeBookmarks(range, BookmarkType.WARNING, BOOKMARK_CATEGORY, monitor);

		monitor.setMessage("BGI: applying instruction context");
		AddressSet code = new AddressSet();
		for (BgiDecoder.Insn insn : analysis.instructions.values()) {
			Address start = base.add(insn.offset());
			code.add(start, start.add(insn.length() - 1));
		}
		listing.clearCodeUnits(block.getStart(), block.getEnd(), false, monitor);

		ProgramContext programContext = program.getProgramContext();
		Register contextRegister = programContext.getBaseContextRegister();
		Register sd = program.getRegister("sd");
		Register cn = program.getRegister("cn");
		Register cm = program.getRegister("cm");
		Register fe = program.getRegister("fe");
		Register fn = program.getRegister("fn");
		Register fm = program.getRegister("fm");
		Register jk = program.getRegister("jk");
		Register jo = program.getRegister("jo");
		try {
			programContext.remove(block.getStart(), block.getEnd(), contextRegister);
			for (Map.Entry<Integer, BgiStackAnalysis.Context> e : analysis.context.entrySet()) {
				monitor.checkCancelled();
				BgiDecoder.Insn insn = analysis.instructions.get(e.getKey());
				BgiStackAnalysis.Context c = e.getValue();
				RegisterValue value = new RegisterValue(contextRegister)
						.assign(sd, BigInteger.valueOf(c.sd()))
						.assign(cn, BigInteger.valueOf(c.cn()))
						.assign(cm, BigInteger.valueOf(c.cm()))
						.assign(fe, BigInteger.valueOf(c.entry() ? 1 : 0))
						.assign(fn, BigInteger.valueOf(c.fn()))
						.assign(fm, BigInteger.valueOf(c.fm()));
				if (c.jump() >= 0) {
					// jo is a signed field; its register value is the two's-complement bits.
					long relative = (c.jump() - insn.offset()) & 0xffffL;
					value = value.assign(jk, BigInteger.ONE).assign(jo, BigInteger.valueOf(relative));
				}
				Address start = base.add(insn.offset());
				programContext.setRegisterValue(start, start.add(insn.length() - 1), value);
			}
		}
		catch (ContextChangeException e) {
			log.appendException(e);
			return false;
		}

		monitor.setMessage("BGI: disassembling");
		// Seed every decoded instruction: jumps through unresolved code addresses have no
		// static flow, but their targets were reached by the analysis.
		AddressSet seeds = new AddressSet();
		for (int offset : analysis.instructions.keySet()) {
			seeds.add(base.add(offset));
		}
		DisassembleCommand disassemble = new DisassembleCommand(seeds, code, true);
		disassemble.applyTo(program, monitor);

		monitor.setMessage("BGI: creating functions");
		for (BgiStackAnalysis.Function summary : analysis.functions.values()) {
			monitor.checkCancelled();
			applyFunction(program, base, summary, log);
		}

		for (BgiStackAnalysis.Guess guess : analysis.guesses) {
			bookmarks.setBookmark(base.add(guess.offset()), BookmarkType.ANALYSIS,
				BOOKMARK_CATEGORY, String.format("%s: assumed %d argument(s), %d result(s)",
					guess.reason(), guess.args(), guess.results()));
		}
		for (String error : analysis.errors) {
			log.appendMsg("BGI", error);
		}
		for (BgiStackAnalysis.Function summary : analysis.functions.values()) {
			if (!summary.complete()) {
				bookmarks.setBookmark(base.add(summary.entry()), BookmarkType.WARNING,
					BOOKMARK_CATEGORY, "Function contains undecodable bytes");
			}
		}

		String stem = program.getName().replaceFirst("\\.?_bp$", "").replaceAll("[^A-Za-z0-9_]", "_");
		Map<Long, String> exportedNames = new TreeMap<>();
		for (Map.Entry<Long, Integer> e : analysis.exports.entrySet()) {
			Function f = program.getFunctionManager().getFunctionAt(base.add(e.getValue()));
			if (f != null) {
				exportedNames.put(e.getKey(), stem + "_" + f.getName());
			}
		}
		program.getOptions(Program.PROGRAM_INFO).setString(SLOTS_PROPERTY,
			encodeSlots(analysis.exportedSlots(), exportedNames));
		slotNames.putAll(exportedNames);
		labelSlots(program, slotNames);

		monitor.setMessage("BGI: marking text");
		for (int target : analysis.dataTargets) {
			createText(program, base.add(target), data, target);
		}
		return true;
	}

	/**
	 * Native slots are called as functions in an uninitialized "natives" block, so call sites
	 * show names, arguments and cross-references. Signatures follow the generated table.
	 */
	public static void createNativeStubs(Program program, BgiNatives natives, MessageLog log) {
		AddressSpace space = program.getAddressFactory().getDefaultAddressSpace();
		Memory memory = program.getMemory();
		Address base = space.getAddress(BgiNatives.NATIVE_BASE);
		try {
			if (memory.getBlock(base) == null) {
				MemoryBlock block = memory.createUninitializedBlock(NATIVE_BLOCK, base,
					BgiNatives.NATIVE_SIZE, false);
				block.setPermissions(true, false, true);
				block.setComment("Native slot stubs: primary * 0x400 + secondary * 4");
			}
		}
		catch (Exception e) {
			log.appendMsg("BGI", "Could not create the native stub block: " + e.getMessage());
			return;
		}
		FunctionManager functions = program.getFunctionManager();
		String convention = program.getCompilerSpec().getDefaultCallingConvention().getName();
		DataType text = new PointerDataType(CharDataType.dataType, program.getDataTypeManager());
		for (BgiNatives.Slot slot : natives.slots()) {
			Address entry = space.getAddress(slot.stubOffset());
			try {
				Function function = functions.getFunctionAt(entry);
				if (function == null) {
					function = functions.createFunction(slot.name(), entry, new AddressSet(entry),
						SourceType.ANALYSIS);
				}
				if (function.getSignatureSource().isHigherPriorityThan(SourceType.ANALYSIS)) {
					continue;
				}
				List<Variable> params = new ArrayList<>();
				boolean[] pointers = slot.pointerParams();
				if (pointers != null) {
					for (int i = 0; i < pointers.length; i++) {
						params.add(new ParameterImpl("arg" + (i + 1),
							pointers[i] ? text : IntegerDataType.dataType, program));
					}
				}
				DataType returnType =
					slot.pushes() != 0 ? IntegerDataType.dataType : VoidDataType.dataType;
				function.updateFunction(convention, new ReturnParameterImpl(returnType, program),
					params, FunctionUpdateType.DYNAMIC_STORAGE_ALL_PARAMS, true,
					SourceType.ANALYSIS);
				function.setVarArgs(slot.pointerParams() == null);
				function.setComment(String.format("Native %02x:%02x%s%s", slot.primary(),
					slot.secondary(), slot.source() == null ? "" : ", implemented in " + slot.source(),
					slot.knownEffect() ? ""
							: slot.pops() >= 0
									? "\nA wait process pushes the result; call sites estimate it."
									: "\nStack effect is data-dependent; call sites use estimated counts."));
			}
			catch (InvalidInputException | DuplicateNameException | OverlappingFunctionException e) {
				log.appendMsg("BGI", "Native stub " + slot.name() + ": " + e.getMessage());
			}
		}
	}

	static String encodeSlots(Map<Long, int[]> slots, Map<Long, String> names) {
		StringBuilder text = new StringBuilder();
		for (Map.Entry<Long, int[]> e : slots.entrySet()) {
			if (!text.isEmpty()) {
				text.append(';');
			}
			text.append(Long.toHexString(e.getKey())).append(':').append(e.getValue()[0])
					.append(':').append(e.getValue()[1]).append(':')
					.append(names.getOrDefault(e.getKey(), "").replaceAll("[:;]", "_"));
		}
		return text.toString();
	}

	static void decodeSlots(String text, Map<Long, int[]> into, Map<Long, String> names) {
		if (text == null || text.isEmpty()) {
			return;
		}
		for (String entry : text.split(";")) {
			String[] parts = entry.split(":", -1);
			if (parts.length < 3) {
				continue;
			}
			try {
				long slot = Long.parseLong(parts[0], 16);
				if (into.putIfAbsent(slot, new int[] { Integer.parseInt(parts[1]),
					Integer.parseInt(parts[2]) }) == null && parts.length > 3 &&
					!parts[3].isEmpty()) {
					names.put(slot, parts[3]);
				}
			}
			catch (NumberFormatException e) {
				// Ignore a malformed entry written by another tool.
			}
		}
	}

	/** Labels global code-address slots with the module and function stored into them. */
	private static void labelSlots(Program program, Map<Long, String> names) {
		AddressSpace space = program.getAddressFactory().getDefaultAddressSpace();
		SymbolTable symbols = program.getSymbolTable();
		for (Map.Entry<Long, String> e : names.entrySet()) {
			Address address = space.getAddress(e.getKey());
			Symbol primary = symbols.getPrimarySymbol(address);
			if (primary != null && primary.getSource().isHigherPriorityThan(SourceType.ANALYSIS)) {
				continue;
			}
			try {
				String name = SymbolUtilities.replaceInvalidChars(e.getValue(), true);
				if (primary != null && primary.getSource() == SourceType.ANALYSIS) {
					primary.setName(name, SourceType.ANALYSIS);
				}
				else {
					symbols.createLabel(address, name, SourceType.ANALYSIS).setPrimary();
				}
			}
			catch (InvalidInputException | DuplicateNameException ex) {
				// Keep the existing label.
			}
		}
	}

	/** Slots exported by the other BGI programs of the same revision in this program's folder. */
	private static void siblingSlots(Program program, BgiRevision revision,
			Map<Long, int[]> slots, Map<Long, String> names) {
		DomainFile self = program.getDomainFile();
		DomainFolder folder = self == null ? null : self.getParent();
		if (folder == null) {
			return;
		}
		for (DomainFile file : folder.getFiles()) {
			if (file.getPathname().equals(self.getPathname())) {
				continue;
			}
			Map<String, String> metadata = file.getMetadata();
			String language = metadata.get("Language ID");
			if (language != null && !language.startsWith(revision.languageId())) {
				continue;
			}
			decodeSlots(metadata.get(SLOTS_PROPERTY), slots, names);
		}
	}

	private static void applyFunction(Program program, Address base,
			BgiStackAnalysis.Function summary, MessageLog log) {
		Address entry = base.add(summary.entry());
		FunctionManager functions = program.getFunctionManager();
		Function function = functions.getFunctionAt(entry);
		if (function == null) {
			CreateFunctionCmd create = new CreateFunctionCmd(entry);
			if (!create.applyTo(program)) {
				log.appendMsg("BGI", "Could not create function at " + entry + ": " +
					create.getStatusMsg());
				return;
			}
			function = functions.getFunctionAt(entry);
		}
		try {
			if (function.getSymbol().getSource() == SourceType.DEFAULT) {
				String name = summary.entry() == 0 ? "module_entry"
						: String.format("fn_%04x", summary.entry());
				function.setName(name, SourceType.ANALYSIS);
			}
			if (function.getSignatureSource().isHigherPriorityThan(SourceType.ANALYSIS)) {
				return;
			}
			List<Variable> params = new ArrayList<>();
			for (int i = 0; i < summary.params(); i++) {
				params.add(new ParameterImpl("arg" + (i + 1), IntegerDataType.dataType, program));
			}
			DataType returnType =
				summary.results() > 0 ? IntegerDataType.dataType : VoidDataType.dataType;
			String convention =
				program.getCompilerSpec().getDefaultCallingConvention().getName();
			function.updateFunction(convention, new ReturnParameterImpl(returnType, program), params,
				FunctionUpdateType.DYNAMIC_STORAGE_ALL_PARAMS, true, SourceType.ANALYSIS);
		}
		catch (DuplicateNameException | InvalidInputException e) {
			log.appendException(e);
		}
	}

	/** Defines NUL-terminated text in UTF-8 or Shift_JIS at a 05 target when it decodes cleanly. */
	private static void createText(Program program, Address address, byte[] data, int offset) {
		int end = offset;
		while (end < data.length && data[end] != 0) {
			end++;
		}
		if (end >= data.length || end == offset) {
			return;
		}
		String charset = null;
		for (String candidate : new String[] { "UTF-8", "Shift_JIS" }) {
			if (decodes(data, offset, end, candidate)) {
				charset = candidate;
				break;
			}
		}
		if (charset == null) {
			return;
		}
		Listing listing = program.getListing();
		if (listing.getInstructionContaining(address) != null ||
			listing.getDefinedDataContaining(address) != null) {
			return;
		}
		try {
			Data text = listing.createData(address, TerminatedStringDataType.dataType, end - offset + 1);
			if (!charset.equals("UTF-8") || !isAscii(data, offset, end)) {
				CharsetSettingsDefinition.CHARSET.setCharset(text, charset);
			}
		}
		catch (CodeUnitInsertionException e) {
			// Overlaps data defined by an earlier target.
		}
	}

	private static boolean isAscii(byte[] data, int start, int end) {
		for (int i = start; i < end; i++) {
			if (data[i] < 0) {
				return false;
			}
		}
		return true;
	}

	private static boolean decodes(byte[] data, int start, int end, String charset) {
		CharsetDecoder decoder = Charset.forName(charset).newDecoder()
				.onMalformedInput(CodingErrorAction.REPORT)
				.onUnmappableCharacter(CodingErrorAction.REPORT);
		try {
			String text = decoder.decode(ByteBuffer.wrap(data, start, end - start)).toString();
			for (int i = 0; i < text.length(); i++) {
				char c = text.charAt(i);
				if (c < 0x20 && c != '\n' && c != '\r' && c != '\t') {
					return false;
				}
			}
			return true;
		}
		catch (CharacterCodingException e) {
			return false;
		}
	}
}
