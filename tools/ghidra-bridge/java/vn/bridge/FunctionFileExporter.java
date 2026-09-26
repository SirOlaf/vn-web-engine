package vn.bridge;

import java.io.*;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.DigestOutputStream;
import java.security.MessageDigest;
import java.util.*;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import ghidra.program.model.listing.Program;
import ghidra.util.task.TaskMonitor;

/** Streams a complete capture to an exclusive artifact; HTTP receives only its receipt. */
public final class FunctionFileExporter {
    public static final class Request {
        public final FunctionExporter.Request capture;
        public final Path destination;

        public Request(JsonObject json) throws Exception {
            JsonElement schema = json.get("schema"), output = json.get("outputPath");
            FunctionExporter.require(schema != null && schema.isJsonPrimitive() &&
                schema.getAsJsonPrimitive().isString() && "ghidra-function-file-request/v1".equals(schema.getAsString()),
                "invalid-request", "Expected ghidra-function-file-request/v1");
            FunctionExporter.require(output != null && output.isJsonPrimitive() && output.getAsJsonPrimitive().isString(),
                "invalid-destination", "An explicit absolute outputPath ending in .json is required");
            JsonObject inner = json.deepCopy();
            inner.remove("outputPath");
            inner.addProperty("schema", "ghidra-function-request/v1");
            capture = new FunctionExporter.Request(inner);
            destination = prepareDestination(output.getAsString());
        }
    }

    public Map<String, Object> export(Program program, Request request, TaskMonitor monitor) throws Exception {
        Map<String, Object> capture = new FunctionExporter().export(program, request.capture, monitor);
        monitor.checkCancelled();
        return publish(capture, request.destination, request.capture.representation);
    }

    private static Path prepareDestination(String value) throws Exception {
        FunctionExporter.require(!value.isEmpty() && value.endsWith(".json") && value.chars().noneMatch(c -> c < 32),
            "invalid-destination", "outputPath must end in .json and contain no control characters");
        Path supplied;
        try { supplied = Path.of(value); }
        catch (InvalidPathException error) { throw new FunctionExporter.ExportFailure("invalid-destination", "Invalid outputPath"); }
        FunctionExporter.require(supplied.isAbsolute() && supplied.getFileName() != null && supplied.getParent() != null,
            "invalid-destination", "outputPath must be an absolute file path");
        for (Path part : supplied) FunctionExporter.require(!part.toString().equals(".."),
            "invalid-destination", "Parent traversal is not permitted in outputPath");
        Path parent;
        try { parent = supplied.getParent().toRealPath(); }
        catch (IOException error) { throw new FunctionExporter.ExportFailure("invalid-destination", "The output parent must be an existing accessible directory"); }
        FunctionExporter.require(Files.isDirectory(parent), "invalid-destination", "The output parent must already be a directory");
        Path destination = parent.resolve(supplied.getFileName());
        FunctionExporter.require(!Files.exists(destination, LinkOption.NOFOLLOW_LINKS),
            "file-exists", "Output already exists; choose a new artifact path");
        return destination;
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> publish(Map<String, Object> capture, Path destination, String representation) throws Exception {
        Map<String, Object> function = (Map<String, Object>)capture.get("function");
        Map<String, Object> raw = (Map<String, Object>)capture.get("raw"), high = (Map<String, Object>)capture.get("high");
        Map<String, Object> after = (Map<String, Object>)((Map<String, Object>)capture.get("state")).get("after");
        FunctionExporter.require(((String)function.get("name")).length() <= 4096,
            "receipt-limit", "Function name exceeds the compact receipt limit");
        Map<String, Object> receipt = FunctionExporter.map("schema", "ghidra-function-file-receipt/v1", "status", "complete",
            "binary", capture.get("binary"),
            "function", FunctionExporter.map("entryAddress", function.get("entryAddress"), "name", function.get("name"),
                "bodySha256", function.get("bodySha256"), "bodyByteLength", function.get("bodyByteLength")),
            "representation", representation,
            "counts", FunctionExporter.map("instructions", raw == null ? null : raw.get("instructionCount"),
                "rawOps", raw == null ? null : raw.get("opCount"), "highBlocks", high == null ? null : ((List<?>)high.get("blocks")).size(),
                "highOps", high == null ? null : high.get("opCount")),
            "state", FunctionExporter.map("stable", true, "savedState", "unverified", "changed", after.get("changed"),
                "modificationNumber", after.get("modificationNumber")),
            "exporter", capture.get("exporter"));

        Path parent = destination.getParent();
        Path temporary = Files.getFileStore(parent).supportsFileAttributeView("posix") ?
            Files.createTempFile(parent, ".vn-native-export-", ".tmp", PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------"))) :
            Files.createTempFile(parent, ".vn-native-export-", ".tmp");
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (Writer writer = new BufferedWriter(new OutputStreamWriter(new DigestOutputStream(
                    Files.newOutputStream(temporary, StandardOpenOption.WRITE, StandardOpenOption.TRUNCATE_EXISTING), digest), StandardCharsets.UTF_8))) {
                FunctionExporter.JSON.toJson(capture, writer);
                writer.write('\n');
            }
            try (FileChannel channel = FileChannel.open(temporary, StandardOpenOption.WRITE)) { channel.force(true); }
            receipt.put("file", FunctionExporter.map("path", destination.toString(), "byteLength", Files.size(temporary),
                "sha256", FunctionExporter.hex(digest.digest()), "contentSchema", "ghidra-function-export/v1"));
            // Hard-link publication is atomic and cannot replace a file/symlink
            // that appeared after preflight. ATOMIC_MOVE may replace a target.
            try { Files.createLink(destination, temporary); }
            catch (FileAlreadyExistsException error) {
                throw new FunctionExporter.ExportFailure("file-exists", "Output already exists; no artifact was replaced");
            }
            return receipt;
        } finally { Files.deleteIfExists(temporary); }
    }
}
