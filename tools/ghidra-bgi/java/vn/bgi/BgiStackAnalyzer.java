package vn.bgi;

import ghidra.app.services.*;
import ghidra.app.util.importer.MessageLog;
import ghidra.program.model.address.AddressSetView;
import ghidra.program.model.listing.Program;
import ghidra.util.exception.CancelledException;
import ghidra.util.task.TaskMonitor;

/**
 * Computes operand-stack depths and call counts for BGI modules and disassembles them with
 * that context. Runs when the module block is created; run it again as a one-shot analysis
 * after adding functions by hand.
 */
public class BgiStackAnalyzer extends AbstractAnalyzer {

	public BgiStackAnalyzer() {
		super("BGI Stack Analysis",
			"Computes BGI operand-stack depths, function parameter/result counts and call " +
				"argument counts, then disassembles the module with them.",
			AnalyzerType.BYTE_ANALYZER);
		setPriority(AnalysisPriority.BLOCK_ANALYSIS.before());
		setDefaultEnablement(true);
		setSupportsOneTimeAnalysis();
	}

	@Override
	public boolean canAnalyze(Program program) {
		return BgiRevision.of(program.getLanguage()) != null;
	}

	@Override
	public boolean added(Program program, AddressSetView set, TaskMonitor monitor, MessageLog log)
			throws CancelledException {
		return BgiProgramAnalysis.apply(program, monitor, log);
	}
}
