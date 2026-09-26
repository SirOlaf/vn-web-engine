package vn.bridge;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import ghidra.GhidraApplicationLayout;
import ghidra.framework.Application;
import ghidra.framework.HeadlessGhidraApplicationConfiguration;
import ghidra.program.database.ProgramDB;
import ghidra.program.disassemble.Disassembler;
import ghidra.program.model.address.*;
import ghidra.program.model.data.IntegerDataType;
import ghidra.program.model.lang.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.SourceType;
import ghidra.program.util.DefaultLanguageService;
import ghidra.util.task.TaskMonitor;

/** Decodes/decompiles invented instruction strings only. Target instructions are never executed. */
public final class SyntheticExportCheck {
    public static void main(String[] args) throws Exception {
        if (args.length != 2) throw new IllegalArgumentException("Expected Ghidra installation and fresh output directory");
        Path output = Path.of(args[1]).toAbsolutePath();
        Files.createDirectories(output);
        for (String setting : List.of("tempdir", "cachedir", "settingsdir")) {
            Path directory = output.resolve(setting);
            Files.createDirectories(directory);
            System.setProperty("application." + setting, directory.toString());
        }
        System.setProperty("java.awt.headless", "true");
        HeadlessGhidraApplicationConfiguration configuration = new HeadlessGhidraApplicationConfiguration();
        configuration.setInitializeLogging(false);
        Application.initializeApplication(new GhidraApplicationLayout(new File(args[0])), configuration);

        // Invented Windows x64 functions using ECX input and EAX result.
        // branch: return (value > 0 ? value + 5 : value - 3) + 1;
        exportOne(output, "branch", "85c97e058d4105eb038d41fd83c001c3", true);
        // loop: signed sum while (--value > 0), with value <= 0 returning zero.
        exportOne(output, "loop", "31c085c97e0701c883e9017ff9c3", true);
        // add: return value + 5 (int32 wrapping semantics).
        exportOne(output, "add", "8d4105c3", false);
        System.out.println("SYNTHETIC_EXPORT_CHECK=" + FunctionExporter.JSON.toJson(FunctionExporter.map(
            "status", "passed", "fixtures", List.of("branch", "loop", "add"), "fileExports", 5, "targetInstructionsExecuted", false)));
    }

    @SuppressWarnings("unchecked")
    private static void exportOne(Path directory, String name, String code, boolean requirePhi) throws Exception {
        Object consumer = new Object();
        Language language = DefaultLanguageService.getLanguageService().getLanguage(new LanguageID("x86:LE:64:default"));
        CompilerSpec compiler = language.getCompilerSpecByID(new CompilerSpecID("windows"));
        ProgramDB program = new ProgramDB("synthetic-" + name + ".exe", language, compiler, consumer);
        try {
            byte[] bytes = HexFormat.of().parseHex(code);
            Address base = program.getAddressFactory().getDefaultAddressSpace().getAddress(0x140000000L);
            Address entry = base.add(0x1000);
            AddressSet body = new AddressSet(entry, entry.add(bytes.length - 1));
            int transaction = program.startTransaction("Build invented synthetic function");
            try {
                program.setImageBase(base, true);
                program.setExecutableSHA256(FunctionExporter.hex(MessageDigest.getInstance("SHA-256").digest(bytes)));
                program.getMemory().createInitializedBlock(".text", entry, new ByteArrayInputStream(bytes), bytes.length, TaskMonitor.DUMMY, false).setExecute(true);
                AddressSet decoded = Disassembler.getDisassembler(program, TaskMonitor.DUMMY, null).disassemble(entry, body, true);
                check(decoded.equals(body), "Synthetic instruction decoding did not cover the full body");
                Function function = program.getFunctionManager().createFunction("Synthetic_" + name, entry, body, SourceType.USER_DEFINED);
                function.setCallingConvention("__fastcall");
                function.setReturnType(IntegerDataType.dataType, SourceType.USER_DEFINED);
                function.replaceParameters(Function.FunctionUpdateType.CUSTOM_STORAGE, true, SourceType.USER_DEFINED,
                    new ParameterImpl("value", IntegerDataType.dataType, program.getRegister("ECX"), program));
            } finally { program.endTransaction(transaction, true); }
            JsonObject request = FunctionExporter.JSON.toJsonTree(FunctionExporter.map(
                "schema", "ghidra-function-request/v1", "binary", FunctionExporter.identity(program),
                "entryAddress", FunctionExporter.address(entry), "representation", "both")).getAsJsonObject();
            Map<String, Object> stateBefore = FunctionExporter.state(program);
            Map<String, Object> result = new FunctionExporter().export(program, new FunctionExporter.Request(request), TaskMonitor.DUMMY);
            Files.writeString(directory.resolve(name + ".json"), FunctionExporter.JSON.toJson(result) + "\n", StandardCharsets.UTF_8, StandardOpenOption.CREATE_NEW);
            check(stateBefore.equals(FunctionExporter.state(program)), "Read-only export changed synthetic program state");
            Map<String, Object> raw = (Map<String, Object>)result.get("raw"), high = (Map<String, Object>)result.get("high");
            check(raw.get("ssa").equals(false) && high.get("ssa").equals(true), "Raw and HighFunction representations were confused");
            List<Map<String, Object>> ops = (List<Map<String, Object>>)high.get("ops");
            List<Map<String, Object>> blocks = (List<Map<String, Object>>)high.get("blocks");
            Map<String, Map<String, Object>> blocksById = new HashMap<>();
            for (Map<String, Object> block : blocks) blocksById.put((String)block.get("id"), block);
            int phis = 0;
            for (Map<String, Object> op : ops) {
                if (!"MULTIEQUAL".equals(op.get("opcode"))) continue;
                phis++;
                List<Map<String, Object>> phi = (List<Map<String, Object>>)op.get("phiInputs");
                List<String> inputs = (List<String>)op.get("inputs");
                List<Map<String, Object>> predecessors = (List<Map<String, Object>>)blocksById.get(op.get("blockId")).get("predecessors");
                check(phi.size() == inputs.size() && phi.size() == predecessors.size(), "Phi input/edge arity differs");
                for (int i = 0; i < phi.size(); ++i) {
                    check(phi.get(i).get("varnodeId").equals(inputs.get(i)), "Phi input order differs");
                    check(phi.get(i).get("predecessorBlockId").equals(predecessors.get(i).get("blockId")), "Phi predecessor order differs");
                    check(phi.get(i).get("predecessorSuccessorIndex").equals(predecessors.get(i).get("sourceSuccessorIndex")), "Phi reverse edge differs");
                }
            }
            if (requirePhi) check(phis > 0, "Expected a real HighFunction phi in synthetic " + name);
            check(!((List<?>)high.get("parameters")).isEmpty(), "HighFunction parameter storage was not exported");
            Set<String> ids = new HashSet<>();
            for (Map<String, Object> node : (List<Map<String, Object>>)high.get("varnodes")) check(ids.add((String)node.get("id")), "SSA IDs are not unique");

            checkFileExport(program, request, directory, name, "both", result);
            if (name.equals("add")) {
                checkFileExport(program, request, directory, name, "raw", result);
                checkFileExport(program, request, directory, name, "high", result);
                checkFileRefusals(program, request, directory);
            }
            check(stateBefore.equals(FunctionExporter.state(program)), "File export changed synthetic program state");

            JsonObject wrong = request.deepCopy();
            wrong.addProperty("entryAddress", FunctionExporter.address(entry.add(1)));
            expectFailure(program, wrong, "not-exact-entry");
            wrong = request.deepCopy(); wrong.getAsJsonObject("binary").addProperty("executableSha256", "0".repeat(64));
            expectFailure(program, wrong, "identity-mismatch");
            wrong = request.deepCopy(); JsonObject limits = new JsonObject(); limits.addProperty("maxPcodeOps", 1); wrong.add("limits", limits);
            expectFailure(program, wrong, "limit-exceeded");
            transaction = program.startTransaction("Synthetic busy-state check");
            try { expectFailure(program, request, "program-busy"); }
            finally { program.endTransaction(transaction, true); }
        } finally { program.release(consumer); }
    }

    private static void expectFailure(Program program, JsonObject json, String code) throws Exception {
        try {
            new FunctionExporter().export(program, new FunctionExporter.Request(json), TaskMonitor.DUMMY);
            throw new AssertionError("Expected export refusal: " + code);
        } catch (FunctionExporter.ExportFailure failure) { check(code.equals(failure.code), "Unexpected export refusal " + failure.code); }
    }

    private static JsonObject fileRequest(JsonObject capture, Path destination, String representation) {
        JsonObject json = capture.deepCopy();
        json.addProperty("schema", "ghidra-function-file-request/v1");
        json.addProperty("outputPath", destination.toString());
        json.addProperty("representation", representation);
        return json;
    }

    private static void checkFileExport(Program program, JsonObject request, Path directory, String name,
            String representation, Map<String, Object> inline) throws Exception {
        Path artifact = directory.resolve(name + "-file-" + representation + ".json");
        JsonObject json = fileRequest(request, artifact, representation);
        Map<String, Object> result = new FunctionFileExporter().export(program, new FunctionFileExporter.Request(json), TaskMonitor.DUMMY);
        JsonObject receipt = FunctionExporter.JSON.toJsonTree(result).getAsJsonObject();
        byte[] bytes = Files.readAllBytes(artifact);
        JsonObject written = JsonParser.parseString(new String(bytes, StandardCharsets.UTF_8)).getAsJsonObject();
        check(receipt.get("schema").getAsString().equals("ghidra-function-file-receipt/v1"), "Wrong file receipt schema");
        check(!receipt.has("raw") && !receipt.has("high"), "Graph leaked into file receipt");
        check(FunctionExporter.JSON.toJson(receipt).length() < 4096, "Synthetic file receipt is not compact");
        JsonObject file = receipt.getAsJsonObject("file"), counts = receipt.getAsJsonObject("counts");
        check(file.get("path").getAsString().equals(artifact.toRealPath().toString()), "Receipt path is not canonical");
        check(file.get("byteLength").getAsLong() == bytes.length, "File byte count differs");
        check(file.get("sha256").getAsString().equals(FunctionExporter.hex(MessageDigest.getInstance("SHA-256").digest(bytes))), "File hash differs");
        check(written.get("function").equals(FunctionExporter.JSON.toJsonTree(inline.get("function"))), "File function evidence differs from inline capture");
        for (String kind : List.of("raw", "high")) {
            boolean present = representation.equals("both") || representation.equals(kind);
            check(written.has(kind) == present, "File representation selection differs");
            if (present) check(written.get(kind).equals(FunctionExporter.JSON.toJsonTree(inline.get(kind))), "File graph differs from inline capture");
        }
        check(counts.get("instructions").isJsonNull() == representation.equals("high"), "Raw count selection differs");
        check(counts.get("highBlocks").isJsonNull() == representation.equals("raw"), "High count selection differs");
        if (!representation.equals("high")) check(counts.get("instructions").equals(written.getAsJsonObject("raw").get("instructionCount")) &&
            counts.get("rawOps").equals(written.getAsJsonObject("raw").get("opCount")), "Raw counts differ");
        if (!representation.equals("raw")) check(counts.get("highBlocks").getAsInt() == written.getAsJsonObject("high").getAsJsonArray("blocks").size() &&
            counts.get("highOps").equals(written.getAsJsonObject("high").get("opCount")), "High counts differ");
        if (Files.getFileStore(artifact).supportsFileAttributeView("posix"))
            check(Files.getPosixFilePermissions(artifact).equals(java.nio.file.attribute.PosixFilePermissions.fromString("rw-------")), "Artifact permissions are not private");
        Files.writeString(directory.resolve(name + "-file-" + representation + ".receipt.json"), FunctionExporter.JSON.toJson(receipt) + "\n",
            StandardCharsets.UTF_8, StandardOpenOption.CREATE_NEW);
        expectFileFailure(program, json, "file-exists");
        check(Arrays.equals(bytes, Files.readAllBytes(artifact)), "Existing file changed after refusal");
    }

    private static void checkFileRefusals(Program program, JsonObject request, Path directory) throws Exception {
        Path race = directory.resolve("race.json");
        FunctionFileExporter.Request prepared = new FunctionFileExporter.Request(fileRequest(request, race, "both"));
        Files.writeString(race, "existing artifact", StandardOpenOption.CREATE_NEW);
        try {
            new FunctionFileExporter().export(program, prepared, TaskMonitor.DUMMY);
            throw new AssertionError("File created after preflight was overwritten");
        } catch (FunctionExporter.ExportFailure failure) { check(failure.code.equals("file-exists"), "Unexpected publication refusal"); }
        check(Files.readString(race).equals("existing artifact"), "Publication race replaced existing data");
        Path symlink = directory.resolve("symlink.json"), hardlink = directory.resolve("hardlink.json");
        Files.createSymbolicLink(symlink, race);
        Files.createLink(hardlink, race);
        expectFileFailure(program, fileRequest(request, symlink, "both"), "file-exists");
        expectFileFailure(program, fileRequest(request, hardlink, "both"), "file-exists");
        check(Files.readString(race).equals("existing artifact"), "Linked artifact changed");
        for (Path invalid : List.of(Path.of("relative.json"), directory.resolve("wrong.txt"),
                directory.resolve(".." + File.separator + "traversal.json"), directory.resolve("missing/child.json")))
            expectFileFailure(program, fileRequest(request, invalid, "both"), "invalid-destination");
        JsonObject invalid = fileRequest(request, directory.resolve("limit.json"), "both");
        JsonObject limits = new JsonObject(); limits.addProperty("maxPcodeOps", 1); invalid.add("limits", limits);
        expectFileFailure(program, invalid, "limit-exceeded");
        check(!Files.exists(directory.resolve("limit.json")), "Failed capture published a partial artifact");
        try (var entries = Files.list(directory)) {
            check(entries.noneMatch(p -> p.getFileName().toString().startsWith(".vn-native-export-")), "Export left temporary artifacts behind");
        }
    }

    private static void expectFileFailure(Program program, JsonObject json, String code) throws Exception {
        try {
            new FunctionFileExporter().export(program, new FunctionFileExporter.Request(json), TaskMonitor.DUMMY);
            throw new AssertionError("Expected file export refusal: " + code);
        } catch (FunctionExporter.ExportFailure failure) { check(code.equals(failure.code), "Unexpected file export refusal " + failure.code); }
    }
    private static void check(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
}
