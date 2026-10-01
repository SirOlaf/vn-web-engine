package vn.bgi;

import java.io.IOException;
import java.io.InputStream;
import java.util.*;

import ghidra.app.util.bin.*;
import ghidra.formats.gfilesystem.*;
import ghidra.app.util.opinion.*;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressSpace;
import ghidra.program.model.lang.LanguageCompilerSpecPair;
import ghidra.program.model.listing.Program;
import ghidra.program.model.mem.Memory;
import ghidra.program.model.mem.MemoryBlock;
import ghidra.program.model.symbol.SourceType;
import ghidra.util.exception.CancelledException;
import ghidra.util.task.TaskMonitor;

/**
 * Loads a decoded BGI program module (._bp): a 16-byte header of payload offset, payload
 * size and two reserved words. The payload is mapped at the revision's module tag;
 * the global, frame and heap banks are uninitialized blocks at their tags.
 */
public class BgiLoader extends AbstractProgramWrapperLoader {

	public static final String NAME = "BGI program module (._bp)";

	@Override
	public String getName() {
		return NAME;
	}

	private record Header(long offset, long size) {}

	private static Header header(ByteProvider provider) throws IOException {
		if (provider.length() < 16) {
			return null;
		}
		BinaryReader reader = new BinaryReader(provider, true);
		long offset = reader.readUnsignedInt(0);
		long size = reader.readUnsignedInt(4);
		if (offset < 16 || size == 0 || offset + size > provider.length() ||
			reader.readUnsignedInt(8) != 0 || reader.readUnsignedInt(12) != 0) {
			return null;
		}
		return new Header(offset, size);
	}

	@Override
	public Collection<LoadSpec> findSupportedLoadSpecs(ByteProvider provider) throws IOException {
		List<LoadSpec> specs = new ArrayList<>();
		Header header = header(provider);
		if (header == null) {
			return specs;
		}
		BgiRevision detected = archiveRevision(provider);
		if (detected == null) {
			detected = detect(List.of(provider.readBytes(header.offset(), header.size())));
		}
		for (BgiRevision revision : BgiRevision.values()) {
			specs.add(new LoadSpec(this, 0,
				new LanguageCompilerSpecPair(revision.languageId(), "default"),
				revision == detected));
		}
		return specs;
	}

	/**
	 * The revision whose installed opcodes and native slots decode the most module code; an
	 * opcode or native slot the revision lacks stops decoding. Later revisions mostly extend
	 * earlier tables, so ties go to the older, more restrictive revision. Returns null when no
	 * revision decodes anything.
	 */
	static BgiRevision detect(List<byte[]> modules) {
		BgiRevision best = null;
		long bestScore = 0;
		for (BgiRevision revision : BgiRevision.values()) {
			try {
				BgiNatives natives = BgiNatives.forRevision(revision);
				long score = 0;
				for (byte[] module : modules) {
					BgiDecoder.Bytes bytes = offset -> offset >= 0 && offset < module.length
							? module[offset] & 0xff
							: -1;
					BgiStackAnalysis analysis =
						new BgiStackAnalysis(bytes, revision, natives, Map.of());
					analysis.discover(List.of(0));
					score += analysis.instructions.size() - 1000L * analysis.errors.size();
				}
				if (best == null || score >= bestScore) {
					best = revision;
					bestScore = score;
				}
			}
			catch (IOException e) {
				// Revision table unavailable; skip it.
			}
		}
		return bestScore > 0 ? best : null;
	}

	/** Payload offset of a module file, or -1 when the header is invalid. */
	static long payloadOffset(byte[] file) throws IOException {
		Header header = header(new ByteArrayProvider(file));
		return header == null ? -1 : header.offset();
	}

	/** The revision of the BGI archive a module was opened from, if any. */
	private static BgiRevision archiveRevision(ByteProvider provider) {
		FSRL fsrl = provider.getFSRL();
		if (fsrl == null || fsrl.getFS() == null || !"bgiarc".equals(fsrl.getFS().getProtocol())) {
			return null;
		}
		try (FileSystemRef ref = FileSystemService.getInstance().getFilesystem(fsrl.getFS(),
			TaskMonitor.DUMMY)) {
			if (ref.getFilesystem() instanceof BgiArchiveFileSystem archive) {
				return archive.revision(TaskMonitor.DUMMY);
			}
		}
		catch (IOException | CancelledException e) {
			// Fall back to the module's own detection.
		}
		return null;
	}

	@Override
	protected void load(Program program, ImporterSettings settings)
			throws CancelledException, IOException {
		ByteProvider provider = settings.provider();
		TaskMonitor monitor = settings.monitor();
		Header header = header(provider);
		if (header == null) {
			throw new IOException("Not a BGI program module");
		}
		BgiRevision revision = BgiRevision.of(program.getLanguage());
		if (revision == null) {
			throw new IOException("Not a BGI language: " + program.getLanguage());
		}
		AddressSpace space = program.getAddressFactory().getDefaultAddressSpace();
		Memory memory = program.getMemory();
		try (InputStream payload = provider.getInputStream(header.offset())) {
			Address module = space.getAddress(revision.moduleTag);
			MemoryBlock block = memory.createInitializedBlock(BgiProgramAnalysis.MODULE_BLOCK,
				module, payload, header.size(), monitor, false);
			block.setPermissions(true, true, true);
			block.setComment("Program module; code addresses carry the module tag");

			bank(memory, space, "globals", 0, revision.moduleTag, "Global data bank");
			bank(memory, space, "frames", revision.frameTag, revision.addressSpan(),
				"Frame bank: locals below the frame cursor, return addresses");
			bank(memory, space, "heap", revision.heapTag, revision.addressSpan(),
				"Thread heap bank");

			program.getSymbolTable().createLabel(module, "module_entry", SourceType.IMPORTED);
			program.getSymbolTable().addExternalEntryPoint(module);
		}
		catch (Exception e) {
			if (e instanceof CancelledException cancelled) {
				throw cancelled;
			}
			throw new IOException("Could not map BGI module: " + e.getMessage(), e);
		}
	}

	private static void bank(Memory memory, AddressSpace space, String name, long start,
			long size, String comment) throws Exception {
		MemoryBlock block =
			memory.createUninitializedBlock(name, space.getAddress(start), size, false);
		block.setPermissions(true, true, false);
		block.setComment(comment);
	}
}
