package vn.bgi;

import ghidra.program.model.lang.Language;

/** Bytecode revisions with distinct encodings, address tags or native tables. */
public enum BgiRevision {
	R1685("1.685.3", "1685", 0x10000000L, 0x20000000L, 0x30000000L, true, true),
	R1665("1.665", "1665", 0x04000000L, 0x08000000L, 0x0c000000L, true, false),
	R1658("1.658.5", "1658", 0x04000000L, 0x08000000L, 0x0c000000L, false, false),
	R1520("1.520.6", "1520", 0x04000000L, 0x08000000L, 0x0c000000L, false, false);

	public final String variant;
	/** Suffix of the generated per-revision language files. */
	public final String fileId;
	public final long moduleTag;
	public final long frameTag;
	public final long heapTag;
	/** 15 has a relative form selected by control bit 3, and 7f is a native bank. */
	public final boolean relativeConditional;
	/** 09 does not push the stored value back. */
	public final boolean storeConsumesValue;

	BgiRevision(String variant, String fileId, long moduleTag, long frameTag, long heapTag,
			boolean relativeConditional, boolean storeConsumesValue) {
		this.variant = variant;
		this.fileId = fileId;
		this.moduleTag = moduleTag;
		this.frameTag = frameTag;
		this.heapTag = heapTag;
		this.relativeConditional = relativeConditional;
		this.storeConsumesValue = storeConsumesValue;
	}

	public String languageId() {
		return "BGI:LE:32:" + variant;
	}

	public long addressSpan() {
		return frameTag - moduleTag;
	}

	public static BgiRevision of(Language language) {
		if (!"BGI".equals(language.getProcessor().toString())) {
			return null;
		}
		String id = language.getLanguageID().getIdAsString();
		for (BgiRevision revision : values()) {
			if (revision.languageId().equals(id)) {
				return revision;
			}
		}
		return null;
	}
}
