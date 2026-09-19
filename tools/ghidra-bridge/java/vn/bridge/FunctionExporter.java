package vn.bridge;

import java.security.MessageDigest;
import java.time.Instant;
import java.util.*;

import com.google.gson.*;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.framework.Application;
import ghidra.framework.model.DomainFile;
import ghidra.program.model.address.*;
import ghidra.program.model.data.DataType;
import ghidra.program.model.lang.Register;
import ghidra.program.model.listing.*;
import ghidra.program.model.pcode.*;
import ghidra.util.task.TaskMonitor;

/** Fixed, read-only analysis operations. No script compiler, DB writes, or native target execution. */
public final class FunctionExporter {
    public static final String VERSION = "0.2.0";
    public static final Gson JSON = new GsonBuilder().serializeNulls().disableHtmlEscaping().create();

    public static final class ExportFailure extends Exception {
        public final String code;
        public ExportFailure(String code, String message) { super(message); this.code = code; }
    }

    public static final class Request {
        public final String programPath, executableSha256, languageId, imageBase, entryAddress, representation;
        public final int decompileSeconds, maxBodyBytes, maxInstructions, maxPcodeOps;
        public Request(JsonObject json) throws ExportFailure {
            exactKeys(json, Set.of("schema", "binary", "entryAddress", "representation", "limits"));
            require("ghidra-function-request/v1".equals(string(json, "schema")), "invalid-request", "Unsupported request schema");
            JsonObject binary = object(json, "binary");
            exactKeys(binary, Set.of("programPath", "executableSha256", "languageId", "imageBase"));
            programPath = string(binary, "programPath");
            executableSha256 = string(binary, "executableSha256");
            languageId = string(binary, "languageId");
            imageBase = string(binary, "imageBase");
            entryAddress = string(json, "entryAddress");
            representation = json.has("representation") ? string(json, "representation") : "both";
            require(programPath.startsWith("/") && !programPath.endsWith("/"), "invalid-request", "An explicit absolute project program path is required");
            require(executableSha256.matches("[0-9a-f]{64}"), "invalid-request", "Executable SHA-256 must be 64 lowercase hex digits");
            require(canonical(imageBase) && canonical(entryAddress), "invalid-request", "Image base and entry must be canonical unsigned 0x hex addresses");
            require(Set.of("raw", "high", "both").contains(representation), "invalid-request", "representation must be raw, high, or both");
            JsonObject limits = json.has("limits") ? object(json, "limits") : new JsonObject();
            exactKeys(limits, Set.of("decompileSeconds", "maxBodyBytes", "maxInstructions", "maxPcodeOps"));
            decompileSeconds = limit(limits, "decompileSeconds", 30, 120);
            maxBodyBytes = limit(limits, "maxBodyBytes", 1048576, 8388608);
            maxInstructions = limit(limits, "maxInstructions", 20000, 50000);
            maxPcodeOps = limit(limits, "maxPcodeOps", 50000, 100000);
        }
        public Map<String, Object> identity() {
            return map("programPath", programPath, "executableSha256", executableSha256,
                "languageId", languageId, "imageBase", imageBase);
        }
    }

    private static final class Budget {
        final int maximum;
        int used;
        Budget(int maximum) { this.maximum = maximum; }
        void op() throws ExportFailure { require(++used <= maximum, "limit-exceeded", "P-code operation limit exceeded; no truncated export is returned"); }
    }

    public Map<String, Object> export(Program program, Request request, TaskMonitor monitor) throws Exception {
        Map<String, Object> before = state(program);
        require(program.getCurrentTransactionInfo() == null, "program-busy", "A transaction is open; retry after its owner finishes");
        require(identity(program).equals(request.identity()), "identity-mismatch", "Program path, SHA-256, language, or image base does not match the request");
        AddressSpace space = program.getAddressFactory().getDefaultAddressSpace();
        require(!space.isOverlaySpace() && space.getAddressableUnitSize() == 1 && space.getSize() <= 64,
            "unsupported-address-space", "Only byte-addressed, non-overlay default spaces up to 64 bits are supported");
        Address entry = space.getAddress(request.entryAddress.substring(2));
        Function function = program.getFunctionManager().getFunctionAt(entry);
        require(function != null && function.getEntryPoint().equals(entry), "not-exact-entry", "No function starts at the exact requested address");
        require(!function.isExternal(), "external-function", "External functions have no complete native body to export");

        Map<String, Object> evidence = functionEvidence(program, function, request.maxBodyBytes, monitor);
        List<Instruction> instructions = instructions(program, function, ((Number)evidence.get("bodyByteLength")).longValue(), request.maxInstructions, monitor);
        Map<String, Object> result = map("schema", "ghidra-function-export/v1", "status", "complete",
            "capturedAt", Instant.now().toString(),
            "exporter", map("name", "NativeExportBridge", "version", VERSION, "ghidraVersion", Application.getApplicationVersion()),
            "binary", identity(program), "function", evidence, "addressSpaces", addressSpaces(program));
        Budget budget = new Budget(request.maxPcodeOps);
        if (!request.representation.equals("high")) result.put("raw", raw(program, instructions, budget, monitor));
        if (!request.representation.equals("raw")) result.put("high", high(program, function, request.decompileSeconds, budget, monitor));
        monitor.checkCancelled();
        Map<String, Object> after = state(program);
        require(before.equals(after) && program.getCurrentTransactionInfo() == null && identity(program).equals(request.identity()),
            "program-changed", "Program state changed during analysis; no complete export is returned");
        result.put("state", map("before", before, "after", after, "stable", true, "savedState", "unverified"));
        return result;
    }

    private Map<String, Object> functionEvidence(Program program, Function function, int maximum, TaskMonitor monitor) throws Exception {
        List<Map<String, Object>> ranges = new ArrayList<>();
        MessageDigest fullHash = MessageDigest.getInstance("SHA-256");
        long total = 0;
        AddressRangeIterator iterator = function.getBody().getAddressRanges(true);
        while (iterator.hasNext()) {
            AddressRange range = iterator.next();
            long length = range.getLength();
            require(length > 0 && length <= maximum - total, "limit-exceeded", "Function body exceeds the byte limit; no truncated export is returned");
            require(range.getAddressSpace().equals(program.getAddressFactory().getDefaultAddressSpace()),
                "unsupported-address-space", "Function body contains another address space");
            MessageDigest rangeHash = MessageDigest.getInstance("SHA-256");
            for (long offset = 0; offset < length;) {
                monitor.checkCancelled();
                byte[] bytes = new byte[(int)Math.min(65536, length - offset)];
                require(program.getMemory().getBytes(range.getMinAddress().add(offset), bytes) == bytes.length,
                    "unreadable-body", "The complete native body could not be read");
                rangeHash.update(bytes); fullHash.update(bytes); offset += bytes.length;
            }
            ranges.add(map("start", address(range.getMinAddress()), "end", address(range.getMaxAddress()),
                "byteLength", length, "bytesSha256", hex(rangeHash.digest())));
            total += length;
        }
        require(total > 0, "empty-body", "Function body is empty");
        List<Map<String, Object>> parameters = new ArrayList<>();
        for (Parameter parameter : function.getParameters()) {
            parameters.add(map("ordinal", parameter.getOrdinal(), "name", parameter.getName(),
                "typeHint", type(parameter.getDataType()), "storage", storage(program, parameter.getVariableStorage()),
                "source", parameter.getSource().toString(), "auto", parameter.isAutoParameter()));
        }
        return map("entryAddress", address(function.getEntryPoint()), "name", function.getName(true),
            "bodyRanges", ranges, "bodyByteLength", total, "bodySha256", hex(fullHash.digest()),
            "callingConvention", map("name", Objects.toString(function.getCallingConventionName(), "unknown"),
                "compilerSpecId", program.getCompilerSpec().getCompilerSpecID().toString(),
                "signatureSource", function.getSignatureSource().toString(), "customStorage", function.hasCustomVariableStorage(),
                "variadic", function.hasVarArgs(), "noReturn", function.hasNoReturn()),
            "parameters", parameters,
            "returnValue", map("typeHint", type(function.getReturnType()), "storage", storage(program, function.getReturn().getVariableStorage())),
            "thunk", function.isThunk());
    }

    private List<Instruction> instructions(Program program, Function function, long bodyLength, int maximum, TaskMonitor monitor) throws Exception {
        List<Instruction> instructions = new ArrayList<>();
        InstructionIterator iterator = program.getListing().getInstructions(function.getBody(), true);
        long covered = 0;
        while (iterator.hasNext()) {
            monitor.checkCancelled();
            Instruction instruction = iterator.next();
            require(instructions.size() < maximum, "limit-exceeded", "Instruction limit exceeded; no truncated export is returned");
            require(function.getBody().contains(instruction.getMinAddress(), instruction.getMaxAddress()),
                "partial-instruction", "An instruction crosses the exact function body");
            covered += instruction.getLength();
            instructions.add(instruction);
        }
        require(covered == bodyLength, "undecoded-body", "Decoded instructions do not cover every byte of the exact function body");
        return instructions;
    }

    private Map<String, Object> raw(Program program, List<Instruction> instructions, Budget budget, TaskMonitor monitor) throws Exception {
        List<Map<String, Object>> rows = new ArrayList<>();
        int count = 0;
        for (Instruction instruction : instructions) {
            monitor.checkCancelled();
            List<Map<String, Object>> ops = new ArrayList<>();
            int index = 0;
            for (PcodeOp op : instruction.getPcode(true)) {
                budget.op();
                List<Map<String, Object>> inputs = new ArrayList<>();
                for (Varnode node : op.getInputs()) inputs.add(node(program, node));
                ops.add(map("id", "r:" + address(instruction.getAddress()) + ":" + index,
                    "index", index++, "opcode", op.getMnemonic(), "sequence", sequence(op),
                    "output", op.getOutput() == null ? null : node(program, op.getOutput()), "inputs", inputs));
                count++;
            }
            List<String> operands = new ArrayList<>(), targets = new ArrayList<>();
            for (int i = 0; i < instruction.getNumOperands(); ++i) operands.add(instruction.getDefaultOperandRepresentation(i));
            for (Address target : instruction.getFlows()) targets.add(address(target));
            rows.add(map("address", address(instruction.getAddress()), "length", instruction.getLength(),
                "mnemonic", instruction.getMnemonicString(), "operands", operands,
                "flow", map("type", instruction.getFlowType().toString(), "override", instruction.getFlowOverride().toString(),
                    "fallthrough", address(instruction.getFallThrough()), "targets", targets), "ops", ops));
        }
        return map("kind", "raw-pcode", "source", "Instruction.getPcode(true)", "ssa", false,
            "instructions", rows, "instructionCount", rows.size(), "opCount", count);
    }

    private Map<String, Object> high(Program program, Function function, int seconds, Budget budget, TaskMonitor monitor) throws Exception {
        DecompInterface decompiler = new DecompInterface();
        try {
            decompiler.toggleCCode(false);
            decompiler.toggleSyntaxTree(true);
            require(decompiler.setSimplificationStyle("normalize"), "decompiler-profile", "Ghidra did not accept normalize simplification");
            require(decompiler.openProgram(program), "decompiler-open", "Ghidra could not open the exact program in the decompiler");
            DecompileResults results = decompiler.decompileFunction(function, seconds, monitor);
            require(results.decompileCompleted() && results.getHighFunction() != null, "decompile-failed",
                "HighFunction unavailable: " + results.getErrorMessage());
            HighFunction high = results.getHighFunction();
            require(high.getFunction().getEntryPoint().equals(function.getEntryPoint()), "not-exact-entry", "Decompiler returned another function");
            return highGraph(program, high, budget, Objects.toString(results.getErrorMessage(), ""), monitor);
        } finally {
            decompiler.dispose();
        }
    }

    private Map<String, Object> highGraph(Program program, HighFunction high, Budget budget, String message, TaskMonitor monitor) throws Exception {
        List<PcodeBlockBasic> blocks = high.getBasicBlocks();
        require(!blocks.isEmpty(), "empty-high-function", "HighFunction contains no basic blocks");
        IdentityHashMap<PcodeBlock, String> blockIds = new IdentityHashMap<>();
        IdentityHashMap<PcodeOp, String> opIds = new IdentityHashMap<>();
        IdentityHashMap<Varnode, String> varnodeIds = new IdentityHashMap<>();
        List<Varnode> varnodeOrder = new ArrayList<>();
        List<PcodeOpAST> liveOps = new ArrayList<>();
        List<Map<String, Object>> blockRows = new ArrayList<>(), opRows = new ArrayList<>(), varnodeRows = new ArrayList<>();
        Set<Integer> indexes = new HashSet<>();
        for (PcodeBlockBasic block : blocks) {
            require(indexes.add(block.getIndex()), "ambiguous-block", "HighFunction repeats a block index");
            blockIds.put(block, "b" + block.getIndex());
        }
        for (PcodeBlockBasic block : blocks) {
            List<String> ids = new ArrayList<>();
            PcodeOp lastLive = null;
            Iterator<PcodeOp> iterator = block.getIterator();
            while (iterator.hasNext()) {
                monitor.checkCancelled();
                PcodeOp op = iterator.next();
                require(op instanceof PcodeOpAST, "non-ssa-op", "HighFunction block contains a non-AST operation");
                PcodeOpAST ast = (PcodeOpAST)op;
                // Block membership is authoritative. Ghidra 12.1.3's decoder calls
                // insertEnd without markAlive, so its bDead flag remains true even
                // for operations present in the decoded HighFunction block list.
                require(ast.getParent() == block && !opIds.containsKey(op), "ambiguous-op", "Live operation has an inconsistent parent or appears twice");
                budget.op();
                String id = blockIds.get(block) + ":o" + ids.size();
                ids.add(id); opIds.put(op, id); liveOps.add(ast);
                lastLive = op;
                if (op.getOutput() != null) register(op.getOutput(), varnodeIds, varnodeOrder);
                for (Varnode node : op.getInputs()) {
                    require(node != null, "missing-input", "Live operation has a missing input");
                    register(node, varnodeIds, varnodeOrder);
                }
            }
            List<Map<String, Object>> predecessors = new ArrayList<>(), successors = new ArrayList<>();
            for (int i = 0; i < block.getInSize(); ++i) {
                PcodeBlock source = block.getIn(i);
                int reverse = block.getInRevIndex(i);
                require(blockIds.containsKey(source) && reverse >= 0 && reverse < source.getOutSize() &&
                    source.getOut(reverse) == block && source.getOutRevIndex(reverse) == i,
                    "inconsistent-edge", "Predecessor edge does not have a matching successor edge");
                predecessors.add(map("blockId", blockIds.get(source), "sourceSuccessorIndex", reverse));
            }
            for (int i = 0; i < block.getOutSize(); ++i) {
                PcodeBlock target = block.getOut(i);
                int reverse = block.getOutRevIndex(i);
                require(blockIds.containsKey(target) && reverse >= 0 && reverse < target.getInSize() &&
                    target.getIn(reverse) == block && target.getInRevIndex(reverse) == i,
                    "inconsistent-edge", "Successor edge does not have a matching predecessor edge");
                successors.add(map("blockId", blockIds.get(target), "targetPredecessorIndex", reverse));
            }
            blockRows.add(map("id", blockIds.get(block), "index", block.getIndex(),
                "start", address(block.getStart()), "stop", address(block.getStop()),
                "predecessors", predecessors, "successors", successors,
                "conditionalTargets", lastLive != null && lastLive.getOpcode() == PcodeOp.CBRANCH && block.getOutSize() == 2 ?
                    map("falseBlockId", blockIds.get(block.getFalseOut()), "trueBlockId", blockIds.get(block.getTrueOut())) : null,
                "opIds", ids));
        }
        // Ghidra's first decoded basic block is the entry block. Check its coverage,
        // instead of guessing from predecessor count (entry blocks can have backedges).
        require(blocks.get(0).contains(high.getFunction().getEntryPoint()), "entry-block", "First HighFunction basic block does not cover the exact function entry");
        require(!liveOps.isEmpty(), "empty-high-function", "HighFunction contains no attached operations");
        for (PcodeOpAST op : liveOps) {
            PcodeBlockBasic block = op.getParent();
            String id = opIds.get(op);
            List<String> inputs = new ArrayList<>();
            for (Varnode node : op.getInputs()) inputs.add(varnodeIds.get(node));
            Map<String, Object> row = map("id", id, "blockId", blockIds.get(block),
                "index", Integer.parseInt(id.substring(id.lastIndexOf('o') + 1)),
                "opcode", op.getMnemonic(), "sequence", sequence(op),
                "output", op.getOutput() == null ? null : varnodeIds.get(op.getOutput()), "inputs", inputs);
            if (op.getOpcode() == PcodeOp.MULTIEQUAL) {
                require(op.getNumInputs() == block.getInSize(), "phi-edge-mismatch", "Phi input count does not match predecessor edge count");
                List<Map<String, Object>> phi = new ArrayList<>();
                for (int i = 0; i < op.getNumInputs(); ++i) phi.add(map("inputIndex", i, "predecessorIndex", i,
                    "predecessorBlockId", blockIds.get(block.getIn(i)), "predecessorSuccessorIndex", block.getInRevIndex(i),
                    "varnodeId", inputs.get(i)));
                row.put("phiInputs", phi);
            }
            opRows.add(row);
        }
        List<String> inputIds = new ArrayList<>();
        for (Varnode node : varnodeOrder) {
            String id = varnodeIds.get(node);
            PcodeOp definition = node.getDef();
            require(definition == null || opIds.containsKey(definition), "missing-definition", "A live varnode references a definition outside the exported live graph");
            Map<String, Object> row = node(program, node);
            HighVariable variable = node.getHigh();
            if (node.getAddress().getAddressSpace().getType() == AddressSpace.TYPE_VARIABLE) {
                row.put("joinStorage", storage(program, high.buildStorage(node)));
            }
            row.putAll(map("id", id, "ssaUniqueId", node instanceof VarnodeAST ? ((VarnodeAST)node).getUniqueId() : null,
                "flags", map("input", node.isInput(), "constant", node.isConstant(), "addressTied", node.isAddrTied(),
                    "persistent", node.isPersistent(), "unaffected", node.isUnaffected()),
                "definitionOpId", definition == null ? null : opIds.get(definition),
                "typeHint", variable == null ? null : type(variable.getDataType()),
                "high", variable == null ? null : map("className", variable.getClass().getSimpleName(), "name", variable.getName(),
                    "parameterIndex", variable instanceof HighParam ? ((HighParam)variable).getSlot() : null)));
            varnodeRows.add(row);
            if (node.isInput()) inputIds.add(id);
        }
        List<Map<String, Object>> parameters = new ArrayList<>();
        LocalSymbolMap symbols = high.getLocalSymbolMap();
        for (int i = 0; i < symbols.getNumParams(); ++i) {
            HighSymbol symbol = symbols.getParamSymbol(i);
            parameters.add(map("ordinal", i, "name", symbol.getName(), "typeHint", type(symbol.getDataType()),
                "storage", storage(program, symbol.getStorage())));
        }
        return map("kind", "high-pcode", "source", "DecompInterface.HighFunction", "ssa", true,
            "simplificationStyle", "normalize", "entryBlockId", blockIds.get(blocks.get(0)),
            "blocks", blockRows, "ops", opRows, "varnodes", varnodeRows, "inputVarnodeIds", inputIds,
            "parameters", parameters, "prototype", map("callingConvention", Objects.toString(high.getFunctionPrototype().getModelName(), "unknown"),
                "variadic", high.getFunctionPrototype().isVarArg()), "opCount", opRows.size(), "decompilerMessage", message);
    }

    private static void register(Varnode node, IdentityHashMap<Varnode, String> ids, List<Varnode> order) {
        if (!ids.containsKey(node)) { ids.put(node, "v" + order.size()); order.add(node); }
    }

    private Map<String, Object> node(Program program, Varnode node) {
        AddressSpace space = node.getAddress().getAddressSpace();
        Register register = program.getRegister(node.getAddress(), node.getSize());
        String kind = node.isConstant() ? "constant" : node.isRegister() ? "register" : node.isUnique() ? "unique" :
            space.isStackSpace() ? "stack" : space.isMemorySpace() ? "memory" : "other";
        return map("spaceId", space.getSpaceID(), "space", space.getName(), "offset", unsigned(node.getOffset()),
            "size", node.getSize(), "register", register == null ? null : register.getName(), "kind", kind);
    }

    private Map<String, Object> storage(Program program, VariableStorage storage) {
        List<Map<String, Object>> pieces = new ArrayList<>();
        for (Varnode node : storage.getVarnodes()) pieces.add(node(program, node));
        return map("text", storage.toString(), "valid", storage.isValid(), "unassigned", storage.isUnassignedStorage(),
            "forcedIndirect", storage.isForcedIndirect(), "auto", storage.isAutoStorage(), "pieces", pieces);
    }

    private Map<String, Object> type(DataType type) {
        if (type == null) return null;
        return map("name", type.getName(), "path", type.getPathName(), "length", type.getLength(), "metatype", type.getClass().getSimpleName());
    }

    private Map<String, Object> sequence(PcodeOp op) {
        SequenceNumber sequence = op.getSeqnum();
        return map("address", address(sequence.getTarget()), "addressSpace", sequence.getTarget().getAddressSpace().getName(),
            "time", Integer.toUnsignedLong(sequence.getTime()), "order", sequence.getOrder());
    }

    private List<Map<String, Object>> addressSpaces(Program program) {
        List<Map<String, Object>> spaces = new ArrayList<>();
        AddressSpace defaultSpace = program.getAddressFactory().getDefaultAddressSpace();
        List<AddressSpace> declared = new ArrayList<>(Arrays.asList(program.getAddressFactory().getAllAddressSpaces()));
        // DefaultAddressFactory deliberately excludes VARIABLE/join from that array,
        // although HighFunction may use it for compound storage varnodes.
        if (!declared.contains(AddressSpace.VARIABLE_SPACE)) declared.add(AddressSpace.VARIABLE_SPACE);
        for (AddressSpace space : declared) spaces.add(map("id", space.getSpaceID(), "name", space.getName(),
            "type", space.getType(), "sizeBits", space.getSize(), "addressableUnitSize", space.getAddressableUnitSize(),
            "isDefault", space.equals(defaultSpace), "isOverlay", space.isOverlaySpace()));
        return spaces;
    }

    public static Map<String, Object> identity(Program program) {
        return map("programPath", program.getDomainFile().getPathname(), "executableSha256", program.getExecutableSHA256(),
            "languageId", program.getLanguageID().toString(), "imageBase", address(program.getImageBase()));
    }

    public static Map<String, Object> state(Program program) {
        DomainFile file = program.getDomainFile();
        return map("changed", program.isChanged(), "transactionOpen", program.getCurrentTransactionInfo() != null,
            "modificationNumber", Long.toString(program.getModificationNumber()),
            "domainFile", map("programPath", file.getPathname(), "fileId", file.getFileID(),
                "lastModifiedMs", Long.toString(file.getLastModifiedTime()), "version", file.getVersion()));
    }

    public static String address(Address address) {
        return address == null || address == Address.NO_ADDRESS ? null : unsigned(address.getOffset());
    }
    private static String unsigned(long value) { return "0x" + Long.toUnsignedString(value, 16); }
    private static boolean canonical(String value) { return value.matches("0x(?:0|[1-9a-f][0-9a-f]{0,15})"); }
    public static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder();
        for (byte value : bytes) result.append(String.format("%02x", value & 0xff));
        return result.toString();
    }
    public static Map<String, Object> map(Object... values) {
        Map<String, Object> result = new LinkedHashMap<>();
        for (int i = 0; i < values.length; i += 2) result.put((String)values[i], values[i + 1]);
        return result;
    }
    public static void require(boolean condition, String code, String message) throws ExportFailure {
        if (!condition) throw new ExportFailure(code, message);
    }
    private static void exactKeys(JsonObject object, Set<String> keys) throws ExportFailure {
        for (String key : object.keySet()) require(keys.contains(key), "invalid-request", "Unknown request field: " + key);
    }
    private static String string(JsonObject json, String key) throws ExportFailure {
        JsonElement value = json.get(key);
        require(value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isString() && !value.getAsString().isEmpty(),
            "invalid-request", "Expected nonempty string: " + key);
        return value.getAsString();
    }
    private static JsonObject object(JsonObject json, String key) throws ExportFailure {
        JsonElement value = json.get(key);
        require(value != null && value.isJsonObject(), "invalid-request", "Expected object: " + key);
        return value.getAsJsonObject();
    }
    private static int limit(JsonObject json, String key, int fallback, int maximum) throws ExportFailure {
        if (!json.has(key)) return fallback;
        JsonElement value = json.get(key);
        require(value.isJsonPrimitive() && value.getAsJsonPrimitive().isNumber() && value.getAsString().matches("[1-9][0-9]*"),
            "invalid-request", "Expected positive integer limit: " + key);
        long number;
        try { number = Long.parseLong(value.getAsString()); }
        catch (NumberFormatException error) { throw new ExportFailure("invalid-request", "Limit is too large: " + key); }
        require(number <= maximum, "invalid-request", key + " exceeds maximum " + maximum);
        return (int)number;
    }
}
