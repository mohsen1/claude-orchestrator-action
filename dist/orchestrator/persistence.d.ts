/**
 * State Persistence Layer
 *
 * Handles reading and writing orchestrator state to the work branch.
 * State is stored in .orchestrator/state.json
 */
import { OrchestratorState } from './state.js';
/**
 * Load state from the current branch
 * Returns null if state file doesn't exist
 */
export declare function loadState(): Promise<OrchestratorState | null>;
/**
 * Save state to the current branch and commit
 */
export declare function saveState(state: OrchestratorState, message?: string): Promise<void>;
/**
 * Load state from a specific branch
 */
export declare function loadStateFromBranch(branch: string): Promise<OrchestratorState | null>;
/**
 * Initialize state on a new work branch
 */
export declare function initializeState(state: OrchestratorState, workBranch: string, baseBranch?: string): Promise<void>;
/**
 * Find work branch for an issue by checking for state file
 */
export declare function findWorkBranchForIssue(issueNumber: number): Promise<string | null>;
/**
 * Check if orchestration is already in progress for an issue
 */
export declare function isOrchestrationInProgress(issueNumber: number): Promise<boolean>;
//# sourceMappingURL=persistence.d.ts.map