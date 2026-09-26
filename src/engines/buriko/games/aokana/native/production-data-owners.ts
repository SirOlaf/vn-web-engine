import type {AokanaBpMemory} from '../bp/memory.js';
import {AokanaBacklog} from './backlog.js';
import {AokanaDiagnosticCounts, AokanaPooledAllocationDiagnostics} from './diagnostic-records.js';
import {AokanaGdbRestore} from './gdb-restore.js';
import {AokanaGridEvaluationWorkers} from './grid-evaluation-workers.js';
import {createGroup80Backlog} from './group-80-backlog.js';
import {createGroup80Input, createGroup81Input} from './group-80-input.js';
import {createGroup80Locks} from './group-80-locks.js';
import {createGroup80NamedBitArrays} from './group-80-named-bit-arrays.js';
import {createGroup80NamedMaps} from './group-80-named-maps.js';
import {createGroup80Persistence} from './group-80-persistence.js';
import {createGroup80ProcedureControl} from './group-80-procedure-control.js';
import {createGroup80Procedures} from './group-80-procedures.js';
import {createGroup80ProductIdentity} from './group-80-product-identity.js';
import {createGroup80RecordHistory} from './group-80-record-history.js';
import {createGroup80SaveSlots} from './group-80-save-slots.js';
import {createGroup80StringLists} from './group-80-string-lists.js';
import {createGroup81GdbRestore} from './group-81-gdb-restore.js';
import {group81Hash} from './group-81-hash.js';
import {createGroup81RecordSearch} from './group-81-record-search.js';
import {createGroup81Records, group81Disabled} from './group-81-records.js';
import {createGroupC0Particle} from './group-c0-particle.js';
import {createGroupC0Splines} from './group-c0-splines.js';
import {createGroupD0Grid} from './group-d0-grid.js';
import {createGroupD0Evaluator} from './group-d0-evaluator.js';
import {createGroupD0SpatialCollision} from './group-d0-spatial-collision.js';
import {createGroupD0SpatialDensity} from './group-d0-spatial-density.js';
import {createGroupD0SpatialRecords} from './group-d0-spatial.js';
import {createGroupD0SpatialQueries} from './group-d0-spatial-queries.js';
import {createGroupD0SpatialSearch} from './group-d0-spatial-search.js';
import {createGroupD0WorldMap} from './group-d0-world-map.js';
import {createGroup90SelectionForegroundOnly} from './group-90-selection-bitmap-process.js';
import {AokanaIndependentProcedures} from './independent-procedure.js';
import {AokanaIndependentIconState} from './independent-icon.js';
import {AokanaLogicalGridManagers} from './logical-grid.js';
import {AokanaLogicalSpatialManagers} from './logical-spatial.js';
import {AokanaNamedBitArrays} from './named-bit-arrays.js';
import {AokanaNamedValueMaps} from './named-value-maps.js';
import {AokanaPersistence, AokanaPersistentMemory} from './persistence.js';
import {AokanaProcedureState} from './procedure.js';
import {AokanaProductIdentity} from './product-identity.js';
import type {AokanaProductionDisplayResourceGraph} from './production-display-resource-graph.js';
import {AokanaNativeRecordBuffers} from './record-buffers.js';
import {AokanaRecordHistories} from './record-history.js';
import {AokanaSaveSlots} from './save-slots.js';
import {AokanaNativeSplines} from './spline-registry.js';
import {AokanaBitmapSelectionState} from './selection-bitmap-state.js';
import {AokanaSelectionState} from './selection-state.js';
import {AokanaStringLists} from './string-lists.js';
import type {AokanaNativeSlotDefinition} from './types.js';
import {AokanaNativeWorldMaps} from './world-map.js';

const boundGraphs = new WeakSet<AokanaProductionDisplayResourceGraph>();
const boundMemories = new WeakSet<AokanaBpMemory>();

/** Shared data owners below the eventual complete BP bank and ECB90 coordinator. */
export class AokanaProductionDataOwners {
  readonly save: AokanaSaveSlots;
  readonly backlog = new AokanaBacklog();
  readonly histories = new AokanaRecordHistories();
  readonly strings = new AokanaStringLists();
  readonly maps = new AokanaNamedValueMaps();
  readonly records = new AokanaNativeRecordBuffers();
  readonly bits = new AokanaNamedBitArrays();
  readonly persistent = new AokanaPersistentMemory();
  readonly persistence: AokanaPersistence;
  readonly gdbRestore: AokanaGdbRestore;
  readonly procedures: AokanaIndependentProcedures;
  readonly procedureState = new AokanaProcedureState();
  readonly productIdentity = new AokanaProductIdentity();
  readonly bitmapSelection = new AokanaBitmapSelectionState();
  readonly textSelection = new AokanaSelectionState();
  readonly independentIcon = new AokanaIndependentIconState();
  readonly allocations = new AokanaPooledAllocationDiagnostics();
  readonly counts = new AokanaDiagnosticCounts();
  readonly grids = new AokanaLogicalGridManagers();
  readonly gridWorkers: AokanaGridEvaluationWorkers;
  readonly spatial = new AokanaLogicalSpatialManagers();
  readonly worldMaps = new AokanaNativeWorldMaps();
  readonly splines = new AokanaNativeSplines();

  constructor(
    readonly graph: AokanaProductionDisplayResourceGraph,
    readonly memory: AokanaBpMemory,
  ) {
    if (boundGraphs.has(graph)) throw new Error('Aokana production graph already has data owners');
    if (boundMemories.has(memory))
      throw new Error('Aokana BP memory already belongs to another production graph');
    if (
      graph.particleFrames.particles !== graph.particles ||
      graph.particles.manager !== graph.manager ||
      graph.manager.locks !== graph.resource.locks ||
      graph.surfaces.allocator !== graph.allocator ||
      graph.resource.processing.allocator !== graph.allocator
    )
      throw new Error('Aokana data owners require the graph particle/display/lock identity');
    this.save = new AokanaSaveSlots(graph.resource.resources, memory);
    this.gridWorkers = new AokanaGridEvaluationWorkers(
      graph.allocator,
      graph.resource.processing,
      this.grids,
    );
    this.persistence = new AokanaPersistence(
      graph.resource.resources,
      memory,
      this.persistent,
      this.strings,
      this.bits,
      graph.adapters,
    );
    this.gdbRestore = new AokanaGdbRestore(this.strings, this.bits);
    this.procedures = new AokanaIndependentProcedures(graph.manager);
    boundGraphs.add(graph);
    boundMemories.add(memory);
  }

  /** B4590's three raw-zero writes after directory-search reset, before drop reset.
   * The eventual ECB90 coordinator must close BP admission and place this call. */
  resetSelectionForegroundDefaults(
    graph: AokanaProductionDisplayResourceGraph,
    memory: AokanaBpMemory,
  ): 'selection-foreground-defaults-reset' {
    if (graph !== this.graph || memory !== this.memory)
      throw new Error('Aokana selection reset requires the bound graph and BP memory');
    this.bitmapSelection.foregroundOnly = 0;
    this.textSelection.foregroundOnly = 0;
    this.independentIcon.foregroundOnly = 0;
    return 'selection-foreground-defaults-reset';
  }

  /** 06FF30(1) after dropped-file reset, before automatic redraw configuration.
   * The eventual ECB90 coordinator must close BP admission and place this call. */
  resetProcedureExecutionForProgram(
    graph: AokanaProductionDisplayResourceGraph,
    memory: AokanaBpMemory,
  ): 'procedure-execution-reset' {
    if (graph !== this.graph || memory !== this.memory)
      throw new Error('Aokana procedure reset requires the bound graph and BP memory');
    this.procedureState.enabled = 1;
    return 'procedure-execution-reset';
  }

  /** Actual-owner partial definitions. AokanaNativeBank still requires the complete inventory. */
  nativeDefinitions(): AokanaNativeSlotDefinition[] {
    if (
      this.gridWorkers.mainProcessing !== this.graph.resource.processing ||
      this.graph.resource.processing.allocator !== this.graph.allocator
    )
      throw new Error('Aokana spatial search requires the graph distributed-processing owner');
    const definitions = [
      ...createGroup80Input(this.graph.input),
      ...createGroup80Locks(this.graph.manager.locks),
      ...createGroup80SaveSlots(this.save),
      ...createGroup80Backlog(this.backlog, this.graph.resource.errors),
      ...createGroup80RecordHistory(this.histories),
      ...createGroup80StringLists(this.strings),
      ...createGroup80NamedMaps(this.maps),
      ...createGroup80NamedBitArrays(this.bits),
      ...createGroup80Persistence(this.persistence),
      ...createGroup80Procedures(this.procedures),
      ...createGroup80ProcedureControl(this.procedureState),
      ...createGroup80ProductIdentity(this.productIdentity),
      ...createGroup81Input(this.graph.input),
      ...group81Hash,
      ...createGroup81RecordSearch(),
      ...createGroup81Records(this.records),
      ...group81Disabled,
      ...createGroup81GdbRestore(this.gdbRestore),
      ...createGroupC0Particle(this.graph.particles, this.graph.resource.errors),
      ...createGroupC0Splines(this.splines),
      ...createGroupD0Grid(this.grids),
      ...createGroupD0Evaluator(this.gridWorkers),
      ...createGroupD0SpatialRecords(this.spatial),
      ...createGroupD0SpatialQueries(this.spatial),
      ...createGroupD0SpatialSearch(this.spatial, this.graph.resource.processing),
      ...createGroupD0SpatialCollision(this.spatial),
      ...createGroupD0SpatialDensity(this.spatial),
      ...createGroupD0WorldMap(this.worldMaps),
      ...createGroup90SelectionForegroundOnly(
        this.bitmapSelection,
        this.textSelection,
        this.independentIcon,
      ),
    ];
    return definitions.map((definition) => ({
      ...definition,
      execute: (context) => {
        if (context.memory !== this.memory)
          throw new Error('Aokana data wrapper requires the aggregate BP memory');
        return definition.execute(context);
      },
    }));
  }
}
