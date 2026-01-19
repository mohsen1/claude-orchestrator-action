/**
 * Orchestrator State Schema
 *
 * State is persisted to .orchestrator/state.json on the work branch
 * This enables event-driven architecture where workflows can wake up,
 * read state, take action, update state, and exit.
 */
/**
 * Create initial state when starting orchestration
 */
export function createInitialState(params) {
    return {
        version: 1,
        issue: params.issue,
        repo: params.repo,
        phase: 'initialized',
        workBranch: params.workBranch,
        baseBranch: params.baseBranch || 'main',
        ems: [],
        config: {
            maxEms: params.config?.maxEms || 3,
            maxWorkersPerEm: params.config?.maxWorkersPerEm || 3,
            reviewWaitMinutes: params.config?.reviewWaitMinutes || 5
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
}
/**
 * State file path within the repository
 */
export const STATE_FILE_PATH = '.orchestrator/state.json';
/**
 * Serialize state to JSON
 */
export function serializeState(state) {
    return JSON.stringify(state, null, 2);
}
/**
 * Parse state from JSON
 */
export function parseState(json) {
    const state = JSON.parse(json);
    if (state.version !== 1) {
        throw new Error(`Unsupported state version: ${state.version}`);
    }
    return state;
}
/**
 * Check if all workers for an EM are complete (merged or approved)
 */
export function areAllWorkersComplete(em) {
    return em.workers.every(w => w.status === 'merged' || w.status === 'approved');
}
/**
 * Check if all EMs are complete (merged)
 */
export function areAllEMsComplete(state) {
    return state.ems.every(em => em.status === 'merged');
}
/**
 * Get next pending worker for an EM
 */
export function getNextPendingWorker(em) {
    return em.workers.find(w => w.status === 'pending');
}
/**
 * Get next EM that needs work
 */
export function getNextEMNeedingWork(state) {
    return state.ems.find(em => em.status === 'pending' ||
        em.status === 'workers_running' ||
        (em.status === 'workers_complete' && !em.prNumber));
}
/**
 * Update timestamp on state
 */
export function touchState(state) {
    return {
        ...state,
        updatedAt: new Date().toISOString()
    };
}
//# sourceMappingURL=state.js.map