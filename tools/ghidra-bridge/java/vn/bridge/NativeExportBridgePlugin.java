package vn.bridge;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;
import javax.swing.SwingUtilities;
import com.google.gson.*;
import com.sun.net.httpserver.*;
import ghidra.app.plugin.PluginCategoryNames;
import ghidra.app.services.ProgramManager;
import ghidra.framework.Application;
import ghidra.framework.plugintool.*;
import ghidra.framework.plugintool.util.PluginStatus;
import ghidra.program.model.listing.Program;
import ghidra.util.Msg;
import ghidra.util.task.TaskMonitor;

@PluginInfo(status = PluginStatus.RELEASED, packageName = "VN Web Engine",
    category = PluginCategoryNames.ANALYSIS,
    shortDescription = "Read-only exact function export bridge",
    description = "Exports decoded instructions and HighFunction SSA to explicit artifact files. No script or program mutation endpoints.",
    servicesRequired = {ProgramManager.class})
public final class NativeExportBridgePlugin extends Plugin {
    private HttpServer server;
    private ExecutorService executor;
    private final Semaphore capture = new Semaphore(1);
    public NativeExportBridgePlugin(PluginTool tool) { super(tool); }

    @Override protected void init() {
        super.init();
        try {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 18493), 4);
            executor = Executors.newFixedThreadPool(2, runnable -> {
                Thread thread = new Thread(runnable, "NativeExportBridge"); thread.setDaemon(true); return thread;
            });
            server.setExecutor(executor);
            server.createContext("/v1/health", this::health);
            server.createContext("/v1/function", exchange -> function(exchange, false));
            server.createContext("/v1/function/file", exchange -> function(exchange, true));
            server.start();
            Msg.info(this, "NativeExportBridge " + FunctionExporter.VERSION + " listening on http://127.0.0.1:18493 (program reads and new artifact files)");
        } catch (IOException error) {
            if (server != null) server.stop(0);
            if (executor != null) executor.shutdownNow();
            Msg.error(this, "NativeExportBridge could not bind 127.0.0.1:18493; no fallback address is used", error);
        }
    }

    private boolean route(HttpExchange exchange, String path, String method) throws IOException {
        if (!exchange.getRequestURI().getPath().equals(path) || exchange.getRequestURI().getRawQuery() != null) {
            error(exchange, 404, "unknown-route", "No such bridge operation"); return false;
        }
        if (!exchange.getRequestMethod().equals(method)) {
            error(exchange, 405, "method-not-allowed", "Expected " + method); return false;
        }
        if (exchange.getRequestHeaders().containsKey("Origin")) {
            error(exchange, 403, "browser-origin", "Browser-origin requests are not supported"); return false;
        }
        return true;
    }

    private void health(HttpExchange exchange) throws IOException {
        if (!route(exchange, "/v1/health", "GET")) return;
        send(exchange, 200, FunctionExporter.map("schema", "ghidra-bridge-health/v1", "bridgeVersion", FunctionExporter.VERSION,
            "ghidraVersion", Application.getApplicationVersion(), "capabilities", new String[]{"function-export", "function-export-file"}));
    }

    private void function(HttpExchange exchange, boolean toFile) throws IOException {
        if (!route(exchange, toFile ? "/v1/function/file" : "/v1/function", "POST")) return;
        String contentType = exchange.getRequestHeaders().getFirst("Content-Type");
        if (contentType == null || !contentType.split(";", 2)[0].strip().equalsIgnoreCase("application/json") ||
                !"1".equals(exchange.getRequestHeaders().getFirst("X-VN-Bridge"))) {
            error(exchange, 415, "request-format", "Use application/json and X-VN-Bridge: 1"); return;
        }
        if (!capture.tryAcquire()) { error(exchange, 409, "bridge-busy", "One function export is already running"); return; }
        Object consumer = new Object();
        Program program = null;
        try {
            byte[] bytes = exchange.getRequestBody().readNBytes(16385);
            FunctionExporter.require(bytes.length <= 16384, "request-too-large", "Request exceeds 16 KiB");
            JsonElement input = JsonParser.parseString(new String(bytes, StandardCharsets.UTF_8));
            FunctionExporter.require(input.isJsonObject(), "invalid-request", "Expected a JSON object");
            FunctionFileExporter.Request fileRequest = toFile ? new FunctionFileExporter.Request(input.getAsJsonObject()) : null;
            FunctionExporter.Request request = toFile ? fileRequest.capture : new FunctionExporter.Request(input.getAsJsonObject());
            program = resolveProgram(request.programPath, consumer);
            send(exchange, 200, toFile ? new FunctionFileExporter().export(program, fileRequest, TaskMonitor.DUMMY) :
                new FunctionExporter().export(program, request, TaskMonitor.DUMMY));
        } catch (FunctionExporter.ExportFailure failure) {
            error(exchange, failure.code.equals("program-busy") || failure.code.equals("program-changed") || failure.code.equals("file-exists") ? 409 : 422, failure.code, failure.getMessage());
        } catch (JsonParseException failure) {
            error(exchange, 400, "invalid-json", "Request is not valid JSON");
        } catch (Exception failure) {
            Msg.error(this, "NativeExportBridge export failed", failure);
            error(exchange, 500, "export-failed", failure.getClass().getSimpleName() + ": " + failure.getMessage());
        } finally {
            if (program != null) program.release(consumer);
            capture.release();
            exchange.close();
        }
    }

    private Program resolveProgram(String path, Object consumer) throws Exception {
        AtomicReference<Program> found = new AtomicReference<>();
        AtomicReference<Exception> failure = new AtomicReference<>();
        SwingUtilities.invokeAndWait(() -> {
            try {
                ProgramManager manager = tool.getService(ProgramManager.class);
                FunctionExporter.require(manager != null, "program-manager", "Enable this plugin in a CodeBrowser tool");
                for (Program program : manager.getAllOpenPrograms()) {
                    if (!program.getDomainFile().getPathname().equals(path)) continue;
                    FunctionExporter.require(found.get() == null, "ambiguous-program", "More than one open program has this exact path");
                    found.set(program);
                }
                FunctionExporter.require(found.get() != null, "program-not-open", "The explicitly named program is not open in this CodeBrowser");
                found.get().addConsumer(consumer);
            } catch (Exception error) { failure.set(error); }
        });
        if (failure.get() != null) throw failure.get();
        return found.get();
    }

    private void error(HttpExchange exchange, int status, String code, String message) throws IOException {
        send(exchange, status, FunctionExporter.map("schema", "ghidra-bridge-error/v1", "status", "error", "code", code, "message", message));
    }

    private void send(HttpExchange exchange, int status, Map<String, Object> value) throws IOException {
        byte[] bytes = FunctionExporter.JSON.toJson(value).getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.getResponseHeaders().set("X-Content-Type-Options", "nosniff");
        exchange.sendResponseHeaders(status, bytes.length);
        try (var output = exchange.getResponseBody()) { output.write(bytes); }
    }

    @Override protected void dispose() {
        if (server != null) server.stop(0);
        if (executor != null) executor.shutdownNow();
        super.dispose();
    }
}
