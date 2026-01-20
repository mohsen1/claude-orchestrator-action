/**
 * PR Label-Based State Management
 *
 * Instead of storing all state in .orchestrator/state.json, we use PR labels
 * to track status. This reduces conflicts and makes state visible in GitHub UI.
 *
 * Label Naming Convention:
 * - cco-managed: Base label for all orchestrator PRs
 * - cco-status-* : Current status of the PR
 * - cco-type-* : Type of PR (worker, em, final)
 * - cco-em-{id} : Which EM this belongs to (for workers)
 * - cco-phase-* : Current phase (for issues)
 */
/**
 * Hidden HTML comment marker used to identify orchestrator comments
 * This is more reliable than searching for visible text which could be edited
 */
export declare const ORCHESTRATOR_COMMENT_MARKER = "<!-- cco-orchestrator-comment -->";
export declare const BASE_LABEL = "cco-managed";
export declare const STATUS_LABELS: {
    readonly WORKING: "cco-status-working";
    readonly AWAITING_REVIEW: "cco-status-awaiting-review";
    readonly CHANGES_REQUESTED: "cco-status-changes-requested";
    readonly ADDRESSING_FEEDBACK: "cco-status-addressing-feedback";
    readonly APPROVED: "cco-status-approved";
    readonly READY_TO_MERGE: "cco-status-ready-to-merge";
    readonly MERGED: "cco-status-merged";
    readonly CONFLICTS: "cco-status-conflicts";
    readonly FAILED: "cco-status-failed";
    readonly SKIPPED: "cco-status-skipped";
};
export declare const TYPE_LABELS: {
    readonly WORKER: "cco-type-worker";
    readonly EM: "cco-type-em";
    readonly FINAL: "cco-type-final";
    readonly SETUP: "cco-type-setup";
};
export declare const PHASE_LABELS: {
    readonly ANALYZING: "cco-phase-analyzing";
    readonly PROJECT_SETUP: "cco-phase-project-setup";
    readonly WORKERS_RUNNING: "cco-phase-workers-running";
    readonly WORKERS_REVIEW: "cco-phase-workers-review";
    readonly EMS_MERGING: "cco-phase-ems-merging";
    readonly FINAL_REVIEW: "cco-phase-final-review";
    readonly COMPLETE: "cco-phase-complete";
    readonly FAILED: "cco-phase-failed";
};
export type StatusLabel = typeof STATUS_LABELS[keyof typeof STATUS_LABELS];
export type TypeLabel = typeof TYPE_LABELS[keyof typeof TYPE_LABELS];
export type PhaseLabel = typeof PHASE_LABELS[keyof typeof PHASE_LABELS];
export declare const LABEL_PREFIXES: {
    readonly STATUS: "cco-status-";
    readonly TYPE: "cco-type-";
    readonly PHASE: "cco-phase-";
    readonly EM: "cco-em-";
};
/**
 * Check if a label is an orchestrator-managed label
 */
export declare function isOrchestratorLabel(label: string): boolean;
/**
 * Get all defined orchestrator labels for creating them in the repo
 */
export declare function getAllOrchestratorLabels(): Array<{
    name: string;
    color: string;
    description: string;
}>;
/**
 * Filter labels to get only orchestrator-managed labels
 */
export declare function getOrchestratorLabels(labels: string[]): string[];
/**
 * Get current status from labels
 */
export declare function getStatusFromLabels(labels: string[]): StatusLabel | null;
/**
 * Get PR type from labels
 */
export declare function getTypeFromLabels(labels: string[]): TypeLabel | null;
/**
 * Get phase from labels (for issues)
 */
export declare function getPhaseFromLabels(labels: string[]): PhaseLabel | null;
/**
 * Get EM ID from labels
 */
export declare function getEMIdFromLabels(labels: string[]): number | null;
/**
 * Create EM label for a specific EM ID
 */
export declare function createEMLabel(emId: number): string;
/**
 * Map internal worker status to label
 */
export declare function workerStatusToLabel(status: string): StatusLabel;
/**
 * Map label to internal worker status
 */
export declare function labelToWorkerStatus(label: StatusLabel | null): string;
/**
 * Map phase to phase label
 */
export declare function phaseToLabel(phase: string): PhaseLabel | null;
/**
 * Map phase label back to internal phase
 */
export declare function labelToPhase(label: PhaseLabel | null): string;
//# sourceMappingURL=labels.d.ts.map