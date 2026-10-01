package vn.bgi;

import java.io.IOException;
import java.nio.charset.Charset;
import java.util.*;

import ghidra.app.util.bin.*;
import ghidra.formats.gfilesystem.*;
import ghidra.formats.gfilesystem.annotations.FileSystemInfo;
import ghidra.formats.gfilesystem.factory.GFileSystemFactoryByteProvider;
import ghidra.formats.gfilesystem.factory.GFileSystemProbeBytesOnly;
import ghidra.util.exception.CancelledException;
import ghidra.util.task.TaskMonitor;

/**
 * BGI ARC20 ("BURIKO ARC20") and PackFile archives, listing only the program modules
 * (names ending in _bp). Entries are returned with their BSE/DSC layers removed, ready for
 * the BGI loader. Use File > Open File System, or batch import, on an archive such as
 * sysprg.arc.
 */
@FileSystemInfo(type = "bgiarc", description = "BGI program archive (ARC20/PackFile)",
		factory = BgiArchiveFileSystem.Factory.class)
public class BgiArchiveFileSystem extends AbstractFileSystem<BgiArchiveFileSystem.Entry> {

	public record Entry(long offset, long size) {}

	private static final String ARC20 = "BURIKO ARC20";
	private static final String PACKFILE = "PackFile    ";

	private ByteProvider provider;

	public BgiArchiveFileSystem(FSRLRoot root, ByteProvider provider, FileSystemService service) {
		super(root, service);
		this.provider = provider;
		this.fsIndex = new FileSystemIndexHelper<>(this, root);
	}

	void mount(TaskMonitor monitor) throws IOException {
		BinaryReader reader = new BinaryReader(provider, true);
		byte[] head = provider.readBytes(0, 16);
		boolean arc20 = BgiArchiveCodec.startsWith(head, ARC20);
		if (!arc20 && !BgiArchiveCodec.startsWith(head, PACKFILE)) {
			throw new IOException("Not a BGI archive");
		}
		long count = reader.readUnsignedInt(12);
		int stride = arc20 ? 128 : 32;
		int nameLength = arc20 ? 96 : 16;
		long base = 16 + count * stride;
		if (base > provider.length()) {
			throw new IOException("Truncated BGI archive index");
		}
		Charset names = Charset.forName("Shift_JIS");
		for (long i = 0; i < count; i++) {
			long at = 16 + i * stride;
			byte[] field = provider.readBytes(at, nameLength);
			int end = 0;
			while (end < field.length && field[end] != 0) {
				end++;
			}
			String name = new String(field, 0, end, names);
			long offset = base + reader.readUnsignedInt(at + nameLength);
			long size = reader.readUnsignedInt(at + nameLength + 4);
			if (offset + size > provider.length()) {
				throw new IOException("BGI archive entry " + name + " exceeds the archive");
			}
			if (name.toLowerCase().endsWith("_bp")) {
				fsIndex.storeFile(name, i, false, size, new Entry(offset, size));
			}
		}
	}

	@Override
	public ByteProvider getByteProvider(GFile file, TaskMonitor monitor)
			throws IOException, CancelledException {
		Entry entry = fsIndex.getMetadata(file);
		if (entry == null) {
			throw new IOException("Unknown archive entry " + file);
		}
		byte[] decoded =
			BgiArchiveCodec.decode(provider.readBytes(entry.offset(), entry.size()));
		return new ByteArrayProvider(decoded, file.getFSRL());
	}

	private BgiRevision revision;
	private boolean revisionKnown;

	/**
	 * The revision that decodes every module of the archive (see {@link BgiLoader#detect}),
	 * or null when none does. Modules of one archive share an engine.
	 */
	public synchronized BgiRevision revision(TaskMonitor monitor)
			throws IOException, CancelledException {
		if (!revisionKnown) {
			List<byte[]> modules = new ArrayList<>();
			for (GFile file : fsIndex.getListing(null)) {
				monitor.checkCancelled();
				try (ByteProvider module = getByteProvider(file, monitor)) {
					byte[] bytes = module.readBytes(0, module.length());
					long offset = BgiLoader.payloadOffset(bytes);
					if (offset >= 0) {
						modules.add(Arrays.copyOfRange(bytes, (int) offset, bytes.length));
					}
				}
			}
			revision = BgiLoader.detect(modules);
			revisionKnown = true;
		}
		return revision;
	}

	@Override
	public List<GFile> getListing(GFile directory) {
		return fsIndex.getListing(directory);
	}

	@Override
	public boolean isClosed() {
		return provider == null;
	}

	@Override
	public void close() throws IOException {
		refManager.onClose();
		if (provider != null) {
			provider.close();
			provider = null;
		}
		fsIndex.clear();
	}

	public static class Factory implements GFileSystemFactoryByteProvider<BgiArchiveFileSystem>,
			GFileSystemProbeBytesOnly {

		@Override
		public int getBytesRequired() {
			return 12;
		}

		@Override
		public boolean probeStartBytes(FSRL containerFSRL, byte[] startBytes) {
			return BgiArchiveCodec.startsWith(startBytes, ARC20) ||
				BgiArchiveCodec.startsWith(startBytes, PACKFILE);
		}

		@Override
		public GFileSystem create(FSRLRoot root, ByteProvider provider,
				FileSystemService service, TaskMonitor monitor)
				throws IOException, CancelledException {
			BgiArchiveFileSystem fs = new BgiArchiveFileSystem(root, provider, service);
			try {
				fs.mount(monitor);
				return fs;
			}
			catch (IOException e) {
				fs.close();
				throw e;
			}
		}
	}
}
