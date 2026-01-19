/**
 * Orchestrator State Schema
 * 
 * State is persisted to .orchestrator/state.json on the work branch
 * This enables event-driven architecture where workflows can wake up,
 * read state, take action, update state, and exit.
 */

export type Phase = 
  | 'initialized'      // Work branch created, ready for analysis
  | 'analyzing'        // Director is analyzing the issue
  | 'project_setup'    // Setting up project foundation (gitignore, package.json, etc.)
  | 'em_assignment'    // EMs have been assigned tasks
  | 'worker_execution' // Workers are executing tasks
  | 'worker_review'    // Waiting for reviews on worker PRs
  | 'em_merging'       // Merging worker PRs into EM branches
  | 'em_review'        // Waiting for reviews on EM PRs
  | 'final_merge'      // Merging EM PRs into work branch
  | 'final_review'     // Waiting for reviews on final PR
  | 'complete'         // Final PR merged or ready
  | 'failed';          // Orchestration failed

export type WorkerStatus = 
  | 'pending'          // Not started
  | 'in_progress'      // Claude is working
  | 'pr_created'       // PR created, waiting for review
  | 'changes_requested'// Review requested changes
  | 'approved'         // PR approved
  | 'merged';          // PR merged into EM branch

export type EMStatus = 
  | 'pending'          // Not started
  | 'workers_running'  // Workers are executing
  | 'workers_complete' // All workers done, ready to merge
  | 'pr_created'       // EM PR created to work branch
  | 'changes_requested'// Review requested changes
  | 'approved'         // PR approved
  | 'merged';          // PR merged into work branch

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
  
  // Issue info
  issue: {
    number: number;
    title: string;
    body: string;
  };
  
  // Repository info
  repo: {
    owner: string;
    name: string;
  };
  
  // Current phase
  phase: Phase;
  
  // Branch names
  workBranch: string;
  baseBranch: string; // Usually 'main'
  
  // Project setup tracking
  projectSetup?: ProjectSetup;
  
  // EM and Worker states
  ems: EMState[];
  
  // Final PR info
  finalPr?: {
    number: number;
    url: string;
    reviewsAddressed?: number;
  };
  
  // Configuration
  config: {
    maxEms: number;
    maxWorkersPerEm: number;
    reviewWaitMinutes: number;
    prLabel: string;
  };
  
  // Director's analysis summary (for PR description)
  analysisSummary?: string;
  
  // Timestamps
  createdAt: string;
  updatedAt: string;
  
  // Error info if failed
  error?: string;
}

/**
 * Create initial state when starting orchestration
 */
export function createInitialState(params: {
  issue: { number: number; title: string; body: string };
  repo: { owner: string; name: string };
  workBranch: string;
  baseBranch?: string;
  config?: Partial<OrchestratorState['config']>;
}): OrchestratorState {
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
      reviewWaitMinutes: params.config?.reviewWaitMinutes || 5,
      prLabel: params.config?.prLabel || 'cco'
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
export function serializeState(state: OrchestratorState): string {
  return JSON.stringify(state, null, 2);
}

/**
 * Parse state from JSON
 */
export function parseState(json: string): OrchestratorState {
  const state = JSON.parse(json) as OrchestratorState;
  
  if (state.version !== 1) {
    throw new Error(`Unsupported state version: ${state.version}`);
  }
  
  return state;
}

/**
 * Check if all workers for an EM are complete (merged or approved)
 */
export function areAllWorkersComplete(em: EMState): boolean {
  return em.workers.every(w => w.status === 'merged' || w.status === 'approved');
}

/**
 * Check if all EMs are complete (merged)
 */
export function areAllEMsComplete(state: OrchestratorState): boolean {
  return state.ems.every(em => em.status === 'merged');
}

/**
 * Get next pending worker for an EM
 */
export function getNextPendingWorker(em: EMState): WorkerState | undefined {
  return em.workers.find(w => w.status === 'pending');
}

/**
 * Get next EM that needs work
 */
export function getNextEMNeedingWork(state: OrchestratorState): EMState | undefined {
  return state.ems.find(em => 
    em.status === 'pending' || 
    em.status === 'workers_running' ||
    (em.status === 'workers_complete' && !em.prNumber)
  );
}

/**
 * Update timestamp on state
 */
export function touchState(state: OrchestratorState): OrchestratorState {
  return {
    ...state,
    updatedAt: new Date().toISOString()
  };
}
