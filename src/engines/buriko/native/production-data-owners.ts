import type {BurikoBpMemory} from '../bp/memory.js';
import {BurikoBacklog} from './backlog.js';
import {BurikoDiagnosticCounts, BurikoPooledAllocationDiagnostics} from './diagnostic-records.js';
import {BurikoGdbRestore} from './gdb-restore.js';
import {BurikoGridEvaluationWorkers} from './grid-evaluation-workers.js';
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
import {BurikoIndependentProcedures} from './independent-procedure.js';
import {BurikoIndependentIconState} from './independent-icon.js';
import {BurikoLogicalGridManagers} from './logical-grid.js';
import {BurikoLogicalSpatialManagers} from './logical-spatial.js';
import {BurikoNamedBitArrays} from './named-bit-arrays.js';
import {BurikoNamedValueMaps} from './named-value-maps.js';
import {BurikoPersistence, BurikoPersistentMemory} from './persistence.js';
import {BurikoProcedureState} from './procedure.js';
import {BurikoProductIdentity} from './product-identity.js';
import type {BurikoProductionDisplayResourceGraph} from './production-display-resource-graph.js';
import {BurikoNativeRecordBuffers} from './record-buffers.js';
import {BurikoRecordHistories} from './record-history.js';
import {BurikoSaveSlots} from './save-slots.js';
import {BurikoNativeSplines} from './spline-registry.js';
import {BurikoBitmapSelectionState} from './selection-bitmap-state.js';
import {BurikoSelectionState} from './selection-state.js';
import {BurikoStringLists} from './string-lists.js';
import type {BurikoNativeSlotDefinition} from './types.js';
import {BurikoNativeWorldMaps} from './world-map.js';

const boundGraphs = new WeakSet<BurikoProductionDisplayResourceGraph>();
const boundMemories = new WeakSet<BurikoBpMemory>();

/** Shared data owners below the eventual complete BP bank and ECB90 coordinator. */
export class BurikoProductionDataOwners {
  readonly save: BurikoSaveSlots;
  readonly backlog = new BurikoBacklog();
  readonly histories = new BurikoRecordHistories();
  readonly strings = new BurikoStringLists();
  readonly maps = new BurikoNamedValueMaps();
  readonly records = new BurikoNativeRecordBuffers();
  readonly bits = new BurikoNamedBitArrays();
  readonly persistent = new BurikoPersistentMemory();
  readonly persistence: BurikoPersistence;
  readonly gdbRestore: BurikoGdbRestore;
  readonly procedures: BurikoIndependentProcedures;
  readonly procedureState = new BurikoProcedureState();
  readonly productIdentity: BurikoProductIdentity;
  readonly bitmapSelection = new BurikoBitmapSelectionState();
  readonly textSelection = new BurikoSelectionState();
  readonly independentIcon = new BurikoIndependentIconState();
  readonly allocations = new BurikoPooledAllocationDiagnostics();
  readonly counts = new BurikoDiagnosticCounts();
  readonly grids = new BurikoLogicalGridManagers();
  readonly gridWorkers: BurikoGridEvaluationWorkers;
  readonly spatial = new BurikoLogicalSpatialManagers();
  readonly worldMaps = new BurikoNativeWorldMaps();
  readonly splines = new BurikoNativeSplines();

  constructor(
    readonly graph: BurikoProductionDisplayResourceGraph,
    readonly memory: BurikoBpMemory,
  ) {
    this.productIdentity = new BurikoProductIdentity(graph.productIdentity);
    if (boundGraphs.has(graph)) throw new Error('Buriko production graph already has data owners');
    if (boundMemories.has(memory))
      throw new Error('Buriko BP memory already belongs to another production graph');
    if (
      graph.particleFrames.particles !== graph.particles ||
      graph.particles.manager !== graph.manager ||
      graph.manager.locks !== graph.resource.locks ||
      graph.surfaces.allocator !== graph.allocator ||
      graph.resource.processing.allocator !== graph.allocator
    )
      throw new Error('Buriko data owners require the graph particle/display/lock identity');
    this.save = new BurikoSaveSlots(graph.resource.resources, memory);
    this.gridWorkers = new BurikoGridEvaluationWorkers(
      graph.allocator,
      graph.resource.processing,
      this.grids,
    );
    this.persistence = new BurikoPersistence(
      graph.resource.resources,
      memory,
      this.persistent,
      this.strings,
      this.bits,
      graph.adapters,
    );
    this.gdbRestore = new BurikoGdbRestore(this.strings, this.bits);
    this.procedures = new BurikoIndependentProcedures(graph.manager);
    boundGraphs.add(graph);
    boundMemories.add(memory);
  }

  /** B4590's three raw-zero writes after directory-search reset, before drop reset.
   * The eventual ECB90 coordinator must close BP admission and place this call. */
  resetSelectionForegroundDefaults(
    graph: BurikoProductionDisplayResourceGraph,
    memory: BurikoBpMemory,
  ): 'selection-foreground-defaults-reset' {
    if (graph !== this.graph || memory !== this.memory)
      throw new Error('Buriko selection reset requires the bound graph and BP memory');
    this.bitmapSelection.foregroundOnly = 0;
    this.textSelection.foregroundOnly = 0;
    this.independentIcon.foregroundOnly = 0;
    return 'selection-foreground-defaults-reset';
  }

  /** 06FF30(1) after dropped-file reset, before automatic redraw configuration.
   * The eventual ECB90 coordinator must close BP admission and place this call. */
  resetProcedureExecutionForProgram(
    graph: BurikoProductionDisplayResourceGraph,
    memory: BurikoBpMemory,
  ): 'procedure-execution-reset' {
    if (graph !== this.graph || memory !== this.memory)
      throw new Error('Buriko procedure reset requires the bound graph and BP memory');
    this.procedureState.enabled = 1;
    return 'procedure-execution-reset';
  }

  /** Actual-owner partial definitions. BurikoNativeBank still requires the complete inventory. */
  nativeDefinitions(): BurikoNativeSlotDefinition[] {
    if (
      this.gridWorkers.mainProcessing !== this.graph.resource.processing ||
      this.graph.resource.processing.allocator !== this.graph.allocator
    )
      throw new Error('Buriko spatial search requires the graph distributed-processing owner');
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
          throw new Error('Buriko data wrapper requires the aggregate BP memory');
        return definition.execute(context);
      },
    }));
  }
}
