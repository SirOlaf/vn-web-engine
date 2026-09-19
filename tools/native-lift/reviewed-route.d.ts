import type {CfgModule} from './cfg.d.ts';
import type {GenerationalSlotIr, SlotAnalysisReceipt} from './generational-slots.d.ts';

export interface ReviewedRoutePlan {
  schema: 'reviewed-generational-route/v1';
  exportSha256: string;
  slotIrSha256: string;
  sourceKind: 'synthetic' | 'reviewed-pcode';
  reviewReference: string;
  assumptions: string[];
}

export interface ReviewedRouteResult {
  module: CfgModule;
  slots: GenerationalSlotIr;
  receipt: {
    schema: 'reviewed-generational-route-receipt/v1';
    status: 'complete';
    exportSha256: string;
    slotIr: SlotAnalysisReceipt;
    planSha256: string;
    irSha256: string;
    databaseSha256: string;
    implementation: string;
    nativeInputBindings: Record<string, string>;
    savedState: 'unverified';
  };
}

export function routeReviewedFunction(
  exported: unknown,
  database: unknown,
  plan: ReviewedRoutePlan,
): ReviewedRouteResult;
