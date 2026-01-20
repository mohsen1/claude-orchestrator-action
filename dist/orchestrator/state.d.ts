/**
 * Orchestrator State Schema
 *
 * State is persisted to .orchestrator/state.json on the work branch
 * This enables event-driven architecture where workflows can wake up,
 * read state, take action, update state, and exit.
 */
export type Phase = 'initialized' | 'analyzing' | 'project_setup' | 'em_assignment' | 'worker_execution' | 'worker_review' | 'em_merging' | 'em_review' | 'final_merge' | 'final_review' | 'complete' | 'failed';
export type WorkerStatus = 'pending' | 'in_progress' | 'pr_created' | 'changes_requested' | 'approved' | 'merged';
export type EMStatus = 'pending' | 'workers_running' | 'workers_complete' | 'pr_created' | 'changes_requested' | 'approved' | 'merged';
export interface WorkerState {
    id: number;
    task: string;
    files: string[];
    branch: string;
    status: WorkerStatus;
    prNumber?: number;
    prUrl?: string;
    reviewsAddressed: number;
    error?: string;
    startedAt?: string;
    completedAt?: string;
}
export interface EMState {
    id: number;
    task: string;
    focusArea: string;
    branch: string;
    status: EMStatus;
    prNumber?: number;
    prUrl?: string;
    workers: WorkerState[];
    reviewsAddressed: number;
    error?: string;
    startedAt?: string;
    completedAt?: string;
}
export interface ProjectSetup {
    completed: boolean;
    gitignore?: boolean;
    packageJson?: boolean;
    tsconfig?: boolean;
    setupBranch?: string;
    setupPrNumber?: number;
}
export interface OrchestratorState {
    version: number;
    issue: {
        number: number;
        title: string;
        body: string;
    };
    repo: {
        owner: string;
        name: string;
    };
    phase: Phase;
    workBranch: string;
    baseBranch: string;
    projectSetup?: ProjectSetup;
    ems: EMState[];
    pendingEMs?: EMState[];
    finalPr?: {
        number: number;
        url: string;
        reviewsAddressed?: number;
    };
    config: {
        maxEms: number;
        maxWorkersPerEm: number;
        reviewWaitMinutes: number;
        prLabel: string;
    };
    analysisSummary?: string;
    createdAt: string;
    updatedAt: string;
    error?: string;
}
/**
 * Create initial state when starting orchestration
 */
export declare function createInitialState(params: {
    issue: {
        number: number;
        title: string;
        body: string;
    };
    repo: {
        owner: string;
        name: string;
    };
    workBranch: string;
    baseBranch?: string;
    config?: Partial<OrchestratorState['config']>;
}): OrchestratorState;
/**
 * State file path within the repository
 */
export declare const STATE_FILE_PATH = ".orchestrator/state.json";
/**
 * Serialize state to JSON
 */
export declare function serializeState(state: OrchestratorState): string;
/**
 * Parse state from JSON
 */
export declare function parseState(json: string): OrchestratorState;
/**
 * Check if all workers for an EM are complete (merged or approved)
 */
export declare function areAllWorkersComplete(em: EMState): boolean;
/**
 * Check if all EMs are complete (merged)
 */
export declare function areAllEMsComplete(state: OrchestratorState): boolean;
/**
 * Get next pending worker for an EM
 */
export declare function getNextPendingWorker(em: EMState): WorkerState | undefined;
/**
 * Get next EM that needs work
 */
export declare function getNextEMNeedingWork(state: OrchestratorState): EMState | undefined;
/**
 * Update timestamp on state
 */
export declare function touchState(state: OrchestratorState): OrchestratorState;
//# sourceMappingURL=state.d.ts.map