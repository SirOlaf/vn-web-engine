// Re-runs BGI stack analysis on every BGI program in the current program's project folder,
// twice, so calls through global code-address slots use the parameter and result counts
// of the modules that export them. Each program is saved after analysis.
//@category BGI
import java.util.ArrayList;
import java.util.List;

import ghidra.app.script.GhidraScript;
import ghidra.app.util.importer.MessageLog;
import ghidra.framework.model.DomainFile;
import ghidra.framework.model.DomainFolder;
import ghidra.program.model.listing.Program;
import vn.bgi.BgiProgramAnalysis;
import vn.bgi.BgiRevision;

public class BgiReanalyzeFolder extends GhidraScript {
	@Override
	protected void run() throws Exception {
		DomainFolder folder = currentProgram.getDomainFile().getParent();
		List<DomainFile> files = new ArrayList<>();
		for (DomainFile file : folder.getFiles()) {
			String language = file.getMetadata().get("Language ID");
			if (language != null && language.startsWith("BGI:")) {
				files.add(file);
			}
		}
		for (int pass = 1; pass <= 2; pass++) {
			for (DomainFile file : files) {
				monitor.checkCancelled();
				monitor.setMessage("BGI pass " + pass + ": " + file.getName());
				Program program = file.equals(currentProgram.getDomainFile()) ? currentProgram
						: (Program) file.getDomainObject(this, true, false, monitor);
				try {
					if (BgiRevision.of(program.getLanguage()) == null) {
						continue;
					}
					MessageLog log = new MessageLog();
					int tx = program.startTransaction("BGI stack analysis");
					try {
						BgiProgramAnalysis.apply(program, monitor, log);
					}
					finally {
						program.endTransaction(tx, true);
					}
					if (program != currentProgram) {
						program.save("BGI stack analysis", monitor);
					}
					if (log.hasMessages()) {
						printerr(file.getName() + ": " + log);
					}
				}
				finally {
					if (program != currentProgram) {
						program.release(this);
					}
				}
			}
		}
		println("Re-analyzed " + files.size() + " BGI programs");
	}
}
