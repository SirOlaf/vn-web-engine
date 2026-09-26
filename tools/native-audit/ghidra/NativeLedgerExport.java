// Export exact-address live and persisted function evidence without renaming or saving.
// Args: /program/path executable-sha256 language-id 0ximage-base 0xentry [0xentry ...]
// @category VNWebEngine

import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.google.gson.Gson;

import ghidra.app.script.GhidraScript;
import ghidra.framework.model.DomainFile;
import ghidra.framework.model.DomainObject;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressRange;
import ghidra.program.model.address.AddressRangeIterator;
import ghidra.program.model.address.AddressSpace;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.Program;

public class NativeLedgerExport extends GhidraScript {
    private static final long MAX_FUNCTION_BYTES = 16L * 1024 * 1024;

    @Override
    public void run() throws Exception {
        // GhidraScript.start() opened an untouched per-script transaction before run().
        // FlatProgramAPI.end closes only its private transactionID, never other entries.
        // End that empty entry now so that an unrelated transaction is visible below.
        end(true);
        String[] args = getScriptArgs();
        if (args.length < 5) throw new IllegalArgumentException(
            "Expected /program/path executable-sha256 language-id 0ximage-base 0xentry [0xentry ...]");
        if (currentProgram == null || !args[0].startsWith("/") ||
                !currentProgram.getDomainFile().getPathname().equals(args[0])) {
            throw new IllegalArgumentException("Explicit program path does not match the selected program");
        }
        Program live = currentProgram;
        Map<String, Object> expectedIdentity = map(
            "programPath", args[0], "executableSha256", args[1],
            "languageId", args[2], "imageBase", args[3]);
        if (!args[1].matches("[0-9a-f]{64}") || !identity(live).equals(expectedIdentity)) {
            throw new IllegalArgumentException("Program hash, language, or image base does not match explicit attribution");
        }
        if (live.getCurrentTransactionInfo() != null) {
            throw new IllegalStateException("Another transaction is open; retry after its owner finishes");
        }
        DomainFile domainFile = live.getDomainFile();
        if (!domainFile.exists() || domainFile.isLink()) {
            throw new IllegalStateException("A real persisted project program, not a proxy or link, is required");
        }
        AddressSpace space = live.getAddressFactory().getDefaultAddressSpace();
        if (space.isOverlaySpace() || space.getAddressableUnitSize() != 1 || space.getSize() > 64) {
            throw new IllegalArgumentException("Only default, byte-addressed, non-overlay spaces up to 64 bits are supported");
        }
        List<String> addresses = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        for (int i = 4; i < args.length; ++i) {
            Address address = parseAddress(live, args[i]);
            if (!seen.add(hexAddress(address))) throw new IllegalArgumentException("Duplicate entry address");
            addresses.add(args[i]);
        }
        List<String> errors = new ArrayList<>();
        Map<String, Object> result = map(
            "schema", "ghidra-ledger-snapshot/v1",
            "capturedAt", Instant.now().toString(),
            "exporter", map("name", "NativeLedgerExport", "version", 1, "ghidraVersion", getGhidraVersion()),
            "identity", identity(live),
            "errors", errors,
            "stateBefore", state(live));
        result.put("readback", readback(live, addresses));
        Object consumer = new Object();
        DomainObject persisted = null;
        try {
            Map<String, Object> sourceFile = fileStamp(domainFile);
            persisted = domainFile.getImmutableDomainObject(consumer, DomainFile.DEFAULT_VERSION, monitor);
            if (!(persisted instanceof Program) || persisted == live) {
                throw new IllegalStateException("The persisted read did not return a separate program");
            }
            Program saved = (Program) persisted;
            result.put("savedReadback", map(
                "method", "DomainFile.getImmutableDomainObject(DEFAULT_VERSION)",
                "separateInstance", saved != live,
                "changeable", saved.isChangeable(),
                "changed", saved.isChanged(),
                "sourceFile", sourceFile,
                "identity", identity(saved),
                "readback", readback(saved, addresses)));
        } catch (Exception error) {
            errors.add("Persisted readback failed: " + error.getClass().getSimpleName() + ": " + error.getMessage());
        } finally {
            if (persisted != null) persisted.release(consumer);
        }
        result.put("stateAfter", state(live));
        println("NATIVE_LEDGER_SNAPSHOT_JSON=" + new Gson().toJson(result));
    }

    private List<Map<String, Object>> readback(Program program, List<String> addresses) throws Exception {
        List<Map<String, Object>> entries = new ArrayList<>();
        for (String text : addresses) {
            monitor.checkCancelled();
            Map<String, Object> entry = map("address", text, "lookup", "FunctionManager.getFunctionAt");
            try {
                Address address = parseAddress(program, text);
                // Never use getFunctionContaining, lookup by name, or a cached earlier body.
                Function function = program.getFunctionManager().getFunctionAt(address);
                if (function == null || !address.equals(function.getEntryPoint())) {
                    throw new IllegalStateException("No function starts at the exact requested address");
                }
                entry.put("function", functionEvidence(program, function));
            } catch (Exception error) {
                entry.put("error", error.getClass().getSimpleName() + ": " + error.getMessage());
            }
            entries.add(entry);
        }
        return entries;
    }

    private Map<String, Object> functionEvidence(Program program, Function function) throws Exception {
        List<Map<String, Object>> ranges = new ArrayList<>();
        MessageDigest fullHash = MessageDigest.getInstance("SHA-256");
        long totalBytes = 0;
        AddressRangeIterator iterator = function.getBody().getAddressRanges(true);
        while (iterator.hasNext()) {
            AddressRange range = iterator.next();
            long length = range.getLength();
            if (length <= 0 || length > MAX_FUNCTION_BYTES - totalBytes) {
                throw new IllegalStateException("Function exceeds the 16 MiB export limit");
            }
            Address start = range.getMinAddress(), end = range.getMaxAddress();
            if (!start.getAddressSpace().equals(program.getAddressFactory().getDefaultAddressSpace()) ||
                    !end.getAddressSpace().equals(start.getAddressSpace())) {
                throw new IllegalStateException("Body range is not in the default address space");
            }
            MessageDigest rangeHash = MessageDigest.getInstance("SHA-256");
            for (long offset = 0; offset < length;) {
                monitor.checkCancelled();
                int count = (int) Math.min(65536, length - offset);
                byte[] bytes = new byte[count];
                if (program.getMemory().getBytes(start.add(offset), bytes) != count) {
                    throw new IllegalStateException("Could not read the complete function body");
                }
                rangeHash.update(bytes);
                fullHash.update(bytes);
                offset += count;
            }
            ranges.add(map("start", hexAddress(start), "end", hexAddress(end),
                "byteLength", length, "bytesSha256", hexBytes(rangeHash.digest())));
            totalBytes += length;
        }
        if (totalBytes == 0) throw new IllegalStateException("Function body is empty");
        return map("entryAddress", hexAddress(function.getEntryPoint()), "name", function.getName(true),
            "bodyRanges", ranges, "bodyByteLength", totalBytes, "bodySha256", hexBytes(fullHash.digest()));
    }

    private Map<String, Object> identity(Program program) {
        return map("programPath", program.getDomainFile().getPathname(),
            "executableSha256", program.getExecutableSHA256(),
            "languageId", program.getLanguageID().toString(),
            "imageBase", hexAddress(program.getImageBase()));
    }

    private Map<String, Object> fileStamp(DomainFile file) {
        return map("programPath", file.getPathname(), "fileId", file.getFileID(),
            "exists", file.exists(), "lastModifiedMs", Long.toString(file.getLastModifiedTime()),
            "version", file.getVersion());
    }

    private Map<String, Object> state(Program program) {
        return map("changed", program.isChanged(),
            "transactionOpen", program.getCurrentTransactionInfo() != null,
            "modificationNumber", Long.toString(program.getModificationNumber()),
            "domainFile", fileStamp(program.getDomainFile()));
    }

    private Address parseAddress(Program program, String text) throws Exception {
        if (!text.matches("0x(?:0|[1-9a-f][0-9a-f]{0,15})")) {
            throw new IllegalArgumentException("Expected a canonical unsigned hex address: " + text);
        }
        Address address = program.getAddressFactory().getDefaultAddressSpace().getAddress(text.substring(2));
        if (address == null || !hexAddress(address).equals(text)) {
            throw new IllegalArgumentException("Address does not fit the program's default address space");
        }
        return address;
    }

    private String hexAddress(Address address) {
        return "0x" + Long.toUnsignedString(address.getOffset(), 16);
    }

    private String hexBytes(byte[] bytes) {
        StringBuilder result = new StringBuilder();
        for (byte value : bytes) result.append(String.format("%02x", value & 0xff));
        return result.toString();
    }

    private Map<String, Object> map(Object... values) {
        Map<String, Object> result = new LinkedHashMap<>();
        for (int i = 0; i < values.length; i += 2) result.put((String) values[i], values[i + 1]);
        return result;
    }
}
