package vn.bgi;

import java.util.*;

import vn.bgi.BgiDecoder.*;

/**
 * Discovers the functions of one module and computes the operand-stack depth before
 * every instruction, the parameter and result counts of every function, and the
 * argument/result counts of every call.
 *
 * Depths are relative to the function's entry with its parameters below zero. The first
 * path to reach an instruction (fallthrough first) fixes its depth: BGI statements leave
 * unused call results on the stack, so merging paths legitimately disagree, and later
 * statements only use cells they pushed themselves. A wrong estimate therefore stays local
 * instead of accumulating around a loop.
 *
 * Calls whose callee is unknown (through code-address values, global slots or extension
 * modules), formatted text with a non-constant format and natives without a generated
 * effect are estimated: the arguments are the cells pushed since the last statement
 * boundary in the same basic block, and a result is assumed when the next instruction
 * consumes a cell. Such sites are reported as guessed.
 */
public final class BgiStackAnalysis {

	public static final int MAX_PARAMS = 31;
	/** Natives may push several results; a function returns at most its top cell. */
	public static final int MAX_RESULTS = 7;
	public static final int MAX_FUNCTION_RESULTS = 1;
	public static final int SLOTS = 256;

	/**
	 * Instruction context consumed by the SLEIGH specification. {@code jump} is the module
	 * offset a 14/15/16 transfers to when its popped code address is a constant, else -1.
	 */
	public record Context(int sd, int cn, int cm, boolean entry, int fn, int fm, int jump) {}

	public record Function(int entry, int params, int results, boolean complete) {}

	/** A call or variadic instruction whose counts were estimated. */
	public record Guess(int offset, int function, String reason, int args, int results) {}

	public final Map<Integer, Insn> instructions = new TreeMap<>();
	public final Map<Integer, Function> functions = new TreeMap<>();
	public final Map<Integer, Context> context = new HashMap<>();
	public final List<Guess> guesses = new ArrayList<>();
	public final List<String> errors = new ArrayList<>();
	/** Global code-address slots this module stores a function into (push G; push.ca F; store.4). */
	public final Map<Long, Integer> exports = new TreeMap<>();
	/** Module offsets referenced as data by 05 and the format strings of 6f. */
	public final SortedSet<Integer> dataTargets = new TreeSet<>();

	private final BgiDecoder decoder;
	private final BgiDecoder.Bytes bytes;
	private final Set<Integer> entries = new LinkedHashSet<>();
	private final Set<Integer> blockStarts = new HashSet<>();
	private final Map<Integer, Integer> fallthroughPredecessor = new HashMap<>();
	/** 14/15/16 whose popped code address is pushed by the 06 immediately before them. */
	public final Map<Integer, Integer> resolvedTargets = new HashMap<>();
	/** Resolved {args, results} per call-like instruction (args exclude a popped target). */
	private final Map<Integer, int[]> siteCounts = new HashMap<>();
	private final Set<Integer> inProgress = new HashSet<>();
	private final Set<Integer> guessed = new HashSet<>();
	/** {params, results} of functions other modules store into global code-address slots. */
	private final Map<Long, int[]> importedSlots;

	public BgiStackAnalysis(BgiDecoder.Bytes bytes, BgiRevision revision, BgiNatives natives,
			Map<Long, int[]> importedSlots) {
		this.bytes = bytes;
		this.decoder = new BgiDecoder(bytes, revision, natives);
		this.importedSlots = importedSlots;
	}

	/** {params, results} of each exported slot, for other modules. */
	public Map<Long, int[]> exportedSlots() {
		Map<Long, int[]> result = new TreeMap<>();
		for (Map.Entry<Long, Integer> e : exports.entrySet()) {
			Function f = functions.get(e.getValue());
			if (f != null) {
				result.put(e.getKey(), new int[] { f.params(), f.results() });
			}
		}
		return result;
	}

	/** Summaries from a first pass, used for calls into a function still being analyzed. */
	private Map<Integer, Function> previous = Map.of();

	public void run(Collection<Integer> roots) {
		discover(roots);
		for (int entry : entries) {
			summarize(entry);
		}
		// Recursive calls were estimated; analyze again with the previous pass's summaries
		// until they stop changing. A summary at the parameter cap comes from a depth that
		// kept falling and is not reused.
		for (int pass = 1; pass < MAX_PASSES &&
			guesses.stream().anyMatch(g -> g.reason().equals(RECURSIVE)); pass++) {
			Map<Integer, Function> last = new HashMap<>(functions);
			last.values().removeIf(f -> f.params() >= MAX_PARAMS);
			if (pass > 1 && last.equals(previous)) {
				break;
			}
			previous = last;
			functions.clear();
			context.clear();
			guesses.clear();
			guessed.clear();
			siteCounts.clear();
			for (int entry : entries) {
				summarize(entry);
			}
		}
	}

	private static final int MAX_PASSES = 4;

	private static final String RECURSIVE = "recursive call";

	// ------------------------------------------------------------------------
	// Discovery

	private Insn decode(int offset) {
		Insn insn = instructions.get(offset);
		if (insn != null) {
			return insn;
		}
		try {
			insn = decoder.decode(offset);
			instructions.put(offset, insn);
			return insn;
		}
		catch (DecodeException e) {
			errors.add(e.getMessage());
			return null;
		}
	}

	private static boolean fallsThrough(Insn insn) {
		return switch (insn.flow()) {
			case JUMP, JUMP_INDIRECT, RETURN -> false;
			default -> true;
		};
	}

	private boolean isBranch(Insn insn) {
		return insn.flow() == Flow.BRANCH || insn.flow() == Flow.BRANCH_INDIRECT;
	}

	/** Decodes everything reachable from the roots without computing depths. */
	public void discover(Collection<Integer> roots) {
		Deque<Integer> work = new ArrayDeque<>();
		for (int root : roots) {
			if (entries.add(root)) {
				work.add(root);
			}
		}
		Set<Integer> visited = new HashSet<>();
		while (!work.isEmpty()) {
			int pc = work.pop();
			blockStarts.add(pc);
			Insn prev1 = null, prev2 = null;
			while (visited.add(pc)) {
				Insn insn = decode(pc);
				if (insn == null) {
					break;
				}
				if (insn.opcode() == 0x09 && insn.aux() == 2 && prev1 != null && prev2 != null &&
					prev1.opcode() == 0x06 && prev2.opcode() == 0x02) {
					exports.putIfAbsent(prev2.value(), prev1.target());
				}
				prev2 = prev1;
				prev1 = insn;
				if (insn.opcode() == 0x06 && bytes.at(insn.target()) >= 0) {
					// A code address consumed by the next jump is a branch target; any other
					// use (a call, a store into a table) makes it a function entry.
					Insn consumer = decode(insn.next());
					boolean jump = consumer != null && (consumer.flow() == Flow.JUMP_INDIRECT ||
						consumer.flow() == Flow.BRANCH_INDIRECT);
					if (consumer != null && (jump || consumer.flow() == Flow.CALL_INDIRECT)) {
						resolvedTargets.put(consumer.offset(), insn.target());
					}
					if (jump) {
						work.add(insn.target());
						blockStarts.add(insn.target());
					}
					else if (entries.add(insn.target())) {
						work.add(insn.target());
					}
				}
				if (insn.flow() == Flow.CALL && bytes.at(insn.target()) >= 0 &&
					entries.add(insn.target())) {
					work.add(insn.target());
				}
				if (insn.opcode() == 0x05 && bytes.at(insn.dataTarget()) >= 0) {
					dataTargets.add(insn.dataTarget());
				}
				if (insn.flow() == Flow.JUMP || insn.flow() == Flow.BRANCH) {
					work.add(insn.target());
					blockStarts.add(insn.target());
				}
				if (!fallsThrough(insn)) {
					break;
				}
				fallthroughPredecessor.put(insn.next(), pc);
				if (isBranch(insn)) {
					blockStarts.add(insn.next());
				}
				pc = insn.next();
			}
		}
	}

	private List<Integer> successors(Insn insn) {
		List<Integer> result = new ArrayList<>(2);
		switch (insn.flow()) {
			case JUMP -> result.add(insn.target());
			case BRANCH -> {
				result.add(insn.target());
				result.add(insn.next());
			}
			case JUMP_INDIRECT -> {
				Integer target = resolvedTargets.get(insn.offset());
				if (target != null) {
					result.add(target);
				}
			}
			case BRANCH_INDIRECT -> {
				Integer target = resolvedTargets.get(insn.offset());
				if (target != null) {
					result.add(target);
				}
				result.add(insn.next());
			}
			case RETURN -> {
			}
			default -> result.add(insn.next());
		}
		return result;
	}

	// ------------------------------------------------------------------------
	// Function summaries

	private Function summarize(int entry) {
		Function done = functions.get(entry);
		if (done != null) {
			return done;
		}
		if (!inProgress.add(entry)) {
			return null;
		}
		Map<Integer, Integer> depth = new TreeMap<>();
		Deque<Integer> work = new ArrayDeque<>();
		depth.put(entry, 0);
		work.add(entry);
		int min = 0;
		Integer retDepth = null;
		boolean complete = true;
		List<Integer> returns = new ArrayList<>();
		while (!work.isEmpty()) {
			int pc = work.pop();
			Insn insn = instructions.get(pc);
			if (insn == null) {
				complete = false;
				continue;
			}
			int d = depth.get(pc);
			int[] effect = effect(insn, entry);
			d -= effect[0];
			min = Math.min(min, d);
			d += effect[1];
			if (insn.flow() == Flow.RETURN) {
				returns.add(pc);
				retDepth = retDepth == null ? d : Math.min(retDepth, d);
				continue;
			}
			for (int next : successors(insn)) {
				// The first path to reach an instruction fixes its depth (fallthrough first).
				if (!depth.containsKey(next)) {
					depth.put(next, Math.max(d, -MAX_PARAMS));
					work.push(next);
				}
			}
		}
		int params = Math.min(MAX_PARAMS, -min);
		// Statements leave unused results below a function's return value, so only the top
		// cell at return is the result.
		int results = retDepth == null ? 0
				: Math.max(0, Math.min(MAX_FUNCTION_RESULTS, retDepth + params));
		Function function = new Function(entry, params, results, complete);
		functions.put(entry, function);
		inProgress.remove(entry);

		for (Map.Entry<Integer, Integer> e : depth.entrySet()) {
			int pc = e.getKey();
			if (context.containsKey(pc)) {
				continue;
			}
			Insn insn = instructions.get(pc);
			if (insn == null) {
				continue;
			}
			int sd = Math.max(0, Math.min(SLOTS - 1, e.getValue() + params));
			int[] counts = siteCounts.getOrDefault(pc, new int[] { 0, 0 });
			int cn = Math.min(63, counts[0]);
			int cm = Math.min(MAX_RESULTS, counts[1]);
			boolean isEntry = pc == entry;
			int fm = insn.flow() == Flow.RETURN ? Math.min(results, sd) : 0;
			int jump = resolvedTargets.getOrDefault(pc, -1);
			if (jump >= 0 && (jump - pc < Short.MIN_VALUE || jump - pc > Short.MAX_VALUE)) {
				jump = -1;
			}
			context.put(pc, new Context(sd, cn, cm, isEntry, isEntry ? params : 0, fm, jump));
		}
		return function;
	}

	/** {pops, pushes} of an instruction, resolving calls and estimating unknown effects. */
	private int[] effect(Insn insn, int function) {
		if (insn.knownEffect()) {
			return new int[] { insn.pops(), insn.pushes() };
		}
		int[] counts = siteCounts.get(insn.offset());
		if (counts == null) {
			counts = resolve(insn, function);
			siteCounts.put(insn.offset(), counts);
		}
		int extra = insn.flow() == Flow.CALL_INDIRECT ? 1 : insn.opcode() == 0x6f ? 2 : 0;
		return new int[] { counts[0] + extra, counts[1] };
	}

	/** {args, results} for a call-like site; args exclude the popped target or 6f operands. */
	private int[] resolve(Insn insn, int function) {
		Integer callee = null;
		if (insn.flow() == Flow.CALL) {
			callee = insn.target();
		}
		else if (insn.flow() == Flow.CALL_INDIRECT) {
			callee = resolvedTargets.get(insn.offset());
		}
		Long slot = globalSlot(insn);
		if (slot != null && callee == null) {
			callee = exports.get(slot);
			if (callee == null && importedSlots.containsKey(slot)) {
				return importedSlots.get(slot).clone();
			}
		}
		if (callee != null && entries.contains(callee)) {
			Function summary = summarize(callee);
			if (summary == null) {
				summary = previous.get(callee);
			}
			if (summary != null && summary.params() < MAX_PARAMS) {
				return new int[] { summary.params(), summary.results() };
			}
		}
		if (insn.opcode() == 0x6f) {
			Integer previous = fallthroughPredecessor.get(insn.offset());
			Insn push = previous == null ? null : instructions.get(previous);
			if (push != null && push.opcode() == 0x05 && !blockStarts.contains(insn.offset())) {
				int conversions = formatConversions(push.dataTarget());
				if (conversions >= 0) {
					return new int[] { conversions, 0 };
				}
			}
		}
		int pushed = pushedSinceBoundary(insn, function);
		int args;
		String reason;
		if (insn.opcode() == 0x6f) {
			args = Math.max(0, pushed - 2);
			reason = "format string is not a constant";
		}
		else if (insn.flow() == Flow.CALL_INDIRECT) {
			args = Math.max(0, pushed - 1);
			reason = callee != null ? RECURSIVE
					: slot != null
							? String.format(
								"call through global slot 0x%x exported by no analyzed module", slot)
							: "call through a code-address value";
		}
		else if (insn.flow() == Flow.CALL) {
			args = Math.max(0, pushed);
			reason = RECURSIVE;
		}
		else if (insn.flow() == Flow.CALL_GLOBAL) {
			args = Math.max(0, pushed);
			reason = String.format("call through global slot 0x%x exported by no analyzed module",
				slot);
		}
		else if (insn.flow() == Flow.CALL_EXTENSION) {
			args = Math.max(0, pushed);
			reason = "call into an extension module";
		}
		else if (insn.pops() >= 0) {
			args = insn.pops();
			reason = "native " + insn.nativeName() + " pushes its result from a wait process";
		}
		else {
			args = Math.max(0, pushed);
			reason = "native " + insn.nativeName() + " has no generated stack effect";
		}
		args = Math.min(args, MAX_PARAMS);
		int results = insn.opcode() == 0x6f ? 0 : nextConsumes(insn) ? 1 : 0;
		if (guessed.add(insn.offset())) {
			guesses.add(new Guess(insn.offset(), function, reason, args, results));
		}
		return new int[] { args, results };
	}

	/**
	 * The global slot a call reads its target from: ef G, push [G]; call.ind, or
	 * push G; load.4; call.ind.
	 */
	private Long globalSlot(Insn insn) {
		if (insn.flow() == Flow.CALL_GLOBAL) {
			return (long) insn.dataTarget();
		}
		if (insn.flow() != Flow.CALL_INDIRECT || blockStarts.contains(insn.offset())) {
			return null;
		}
		Insn p1 = predecessor(insn);
		if (p1 == null) {
			return null;
		}
		if (p1.opcode() == 0x18) {
			return (long) p1.dataTarget();
		}
		if (p1.opcode() == 0x08 && p1.aux() == 2 && !blockStarts.contains(p1.offset())) {
			Insn p2 = predecessor(p1);
			if (p2 != null && p2.opcode() == 0x02) {
				return p2.value();
			}
		}
		return null;
	}

	private Insn predecessor(Insn insn) {
		Integer previous = fallthroughPredecessor.get(insn.offset());
		return previous == null ? null : instructions.get(previous);
	}

	/** Opcodes after which the expression stack is back at statement level. */
	private static final Set<Integer> BOUNDARY = Set.of(0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
		0x0f, 0x12, 0x13, 0x15, 0x17, 0x37, 0x3b, 0x3e, 0x3f, 0x60, 0x61, 0x62, 0x64, 0x6a,
		0x6b, 0x6d, 0x6e, 0x6f, 0x73, 0xe2, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xec, 0xed, 0xf0,
		0xf1, 0xf2, 0xf4, 0xf5);

	private int pushedSinceBoundary(Insn insn, int function) {
		int net = 0;
		int pc = insn.offset();
		while (!blockStarts.contains(pc)) {
			Integer previous = fallthroughPredecessor.get(pc);
			if (previous == null) {
				break;
			}
			Insn p = instructions.get(previous);
			if (p == null || BOUNDARY.contains(p.opcode()) ||
				(p.nativeName() != null && p.pushes() == 0)) {
				break;
			}
			int[] e = effect(p, function);
			net += e[1] - e[0];
			pc = previous;
		}
		return net;
	}

	private boolean nextConsumes(Insn insn) {
		Insn next = instructions.get(insn.next());
		if (next == null || blockStarts.contains(insn.next())) {
			return false;
		}
		return next.knownEffect() && next.pops() > 0;
	}

	/** Conversions of the VM formatter: %[ -.0-9]*[scdxXf] consume a cell; %% does not. */
	private int formatConversions(int offset) {
		int count = 0;
		for (int pc = offset, limit = offset + 4096; pc < limit;) {
			int b = bytes.at(pc++);
			if (b <= 0) {
				return b == 0 ? count : -1;
			}
			if ((b >= 0x81 && b <= 0x9f) || (b >= 0xe0 && b <= 0xfc)) {
				pc++;
				continue;
			}
			if (b != '%') {
				continue;
			}
			int c = bytes.at(pc++);
			while (c == ' ' || c == '-' || c == '.' || (c >= '0' && c <= '9')) {
				c = bytes.at(pc++);
			}
			if (c == '%') {
				continue;
			}
			if ("scdxXf".indexOf(c) < 0) {
				return -1;
			}
			count++;
		}
		return -1;
	}
}
