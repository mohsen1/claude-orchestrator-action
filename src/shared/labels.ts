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
export const ORCHESTRATOR_COMMENT_MARKER = '<!-- cco-orchestrator-comment -->';

/**
 * Hidden HTML comment marker used in automated review replies/comments
 * to allow robust deduplication of already-addressed feedback.
 */
export const ORCHESTRATOR_REVIEW_MARKER = '<!-- cco-review-addressed -->';

// Base label - all orchestrator PRs get this
export const BASE_LABEL = 'cco-managed';

// Status labels - mutually exclusive, one per PR at a time
export const STATUS_LABELS = {
  WORKING: 'cco-status-working',
  AWAITING_REVIEW: 'cco-status-awaiting-review',
  CHANGES_REQUESTED: 'cco-status-changes-requested',
  ADDRESSING_FEEDBACK: 'cco-status-addressing-feedback',
  APPROVED: 'cco-status-approved',
  READY_TO_MERGE: 'cco-status-ready-to-merge',
  MERGED: 'cco-status-merged',
  CONFLICTS: 'cco-status-conflicts',
  FAILED: 'cco-status-failed',
  SKIPPED: 'cco-status-skipped'
} as const;

// Type labels - what kind of PR is this
export const TYPE_LABELS = {
  WORKER: 'cco-type-worker',
  EM: 'cco-type-em',
  FINAL: 'cco-type-final',
  SETUP: 'cco-type-setup'
} as const;

// Phase labels - for the issue/main work, not individual PRs
export const PHASE_LABELS = {
  ANALYZING: 'cco-phase-analyzing',
  PROJECT_SETUP: 'cco-phase-project-setup',
  WORKERS_RUNNING: 'cco-phase-workers-running',
  WORKERS_REVIEW: 'cco-phase-workers-review',
  EMS_MERGING: 'cco-phase-ems-merging',
  FINAL_REVIEW: 'cco-phase-final-review',
  COMPLETE: 'cco-phase-complete',
  FAILED: 'cco-phase-failed'
} as const;

export type StatusLabel = typeof STATUS_LABELS[keyof typeof STATUS_LABELS];
export type TypeLabel = typeof TYPE_LABELS[keyof typeof TYPE_LABELS];
export type PhaseLabel = typeof PHASE_LABELS[keyof typeof PHASE_LABELS];

// All label prefixes
export const LABEL_PREFIXES = {
  STATUS: 'cco-status-',
  TYPE: 'cco-type-',
  PHASE: 'cco-phase-',
  EM: 'cco-em-'
} as const;

/**
 * Check if a label is an orchestrator-managed label
 */
export function isOrchestratorLabel(label: string): boolean {
  return label === BASE_LABEL || label.startsWith('cco-');
}

/**
 * Get all defined orchestrator labels for creating them in the repo
 */
export function getAllOrchestratorLabels(): Array<{
  name: string;
  color: string;
  description: string;
}> {
  return [
    // Base
    { name: BASE_LABEL, color: '5319E7', description: 'Claude Code Orchestrator managed' },
    
    // Status labels - using a color gradient from blue (working) to green (done)
    { name: STATUS_LABELS.WORKING, color: '0052CC', description: 'Work in progress' },
    { name: STATUS_LABELS.AWAITING_REVIEW, color: '006B75', description: 'Waiting for review' },
    { name: STATUS_LABELS.CHANGES_REQUESTED, color: 'E99695', description: 'Changes requested by reviewer' },
    { name: STATUS_LABELS.ADDRESSING_FEEDBACK, color: 'FBCA04', description: 'Addressing review feedback' },
    { name: STATUS_LABELS.APPROVED, color: '0E8A16', description: 'Approved and ready' },
    { name: STATUS_LABELS.READY_TO_MERGE, color: '2EA44F', description: 'Ready to be merged' },
    { name: STATUS_LABELS.MERGED, color: '6F42C1', description: 'Successfully merged' },
    { name: STATUS_LABELS.CONFLICTS, color: 'D93F0B', description: 'Has merge conflicts' },
    { name: STATUS_LABELS.FAILED, color: 'B60205', description: 'Failed/blocked' },
    { name: STATUS_LABELS.SKIPPED, color: 'CCCCCC', description: 'Skipped (no changes)' },
    
    // Type labels
    { name: TYPE_LABELS.WORKER, color: 'BFD4F2', description: 'Worker PR' },
    { name: TYPE_LABELS.EM, color: 'D4C5F9', description: 'EM (Engineering Manager) PR' },
    { name: TYPE_LABELS.FINAL, color: 'F9D0C4', description: 'Final PR to main' },
    { name: TYPE_LABELS.SETUP, color: 'C2E0C6', description: 'Project setup PR' },
    
    // Phase labels (for issues)
    { name: PHASE_LABELS.ANALYZING, color: '0052CC', description: 'Director analyzing issue' },
    { name: PHASE_LABELS.PROJECT_SETUP, color: 'C2E0C6', description: 'Setting up project' },
    { name: PHASE_LABELS.WORKERS_RUNNING, color: '0052CC', description: 'Workers executing tasks' },
    { name: PHASE_LABELS.WORKERS_REVIEW, color: '006B75', description: 'Workers awaiting review' },
    { name: PHASE_LABELS.EMS_MERGING, color: 'BFD4F2', description: 'Merging EM branches' },
    { name: PHASE_LABELS.FINAL_REVIEW, color: 'F9D0C4', description: 'Final PR in review' },
    { name: PHASE_LABELS.COMPLETE, color: '0E8A16', description: 'Orchestration complete' },
    { name: PHASE_LABELS.FAILED, color: 'B60205', description: 'Orchestration failed' }
  ];
}

/**
 * Filter labels to get only orchestrator-managed labels
 */
export function getOrchestratorLabels(labels: string[]): string[] {
  return labels.filter(isOrchestratorLabel);
}

/**
 * Get current status from labels
 */
export function getStatusFromLabels(labels: string[]): StatusLabel | null {
  const statusLabel = labels.find(l => l.startsWith(LABEL_PREFIXES.STATUS));
  return (statusLabel as StatusLabel) || null;
}

/**
 * Get PR type from labels
 */
export function getTypeFromLabels(labels: string[]): TypeLabel | null {
  const typeLabel = labels.find(l => l.startsWith(LABEL_PREFIXES.TYPE));
  return (typeLabel as TypeLabel) || null;
}

/**
 * Get phase from labels (for issues)
 */
export function getPhaseFromLabels(labels: string[]): PhaseLabel | null {
  const phaseLabel = labels.find(l => l.startsWith(LABEL_PREFIXES.PHASE));
  return (phaseLabel as PhaseLabel) || null;
}

/**
 * Get EM ID from labels
 */
export function getEMIdFromLabels(labels: string[]): number | null {
  const emLabel = labels.find(l => l.startsWith(LABEL_PREFIXES.EM));
  if (emLabel) {
    const match = emLabel.match(/cco:em-(\d+)/);
    if (match) {
      return parseInt(match[1], 10);
    }
  }
  return null;
}

/**
 * Create EM label for a specific EM ID
 */
export function createEMLabel(emId: number): string {
  return `${LABEL_PREFIXES.EM}${emId}`;
}

/**
 * Map internal worker status to label
 */
export function workerStatusToLabel(status: string): StatusLabel {
  switch (status) {
    case 'pending':
      return STATUS_LABELS.WORKING;
    case 'in_progress':
      return STATUS_LABELS.WORKING;
    case 'pr_created':
      return STATUS_LABELS.AWAITING_REVIEW;
    case 'changes_requested':
      return STATUS_LABELS.CHANGES_REQUESTED;
    case 'approved':
      return STATUS_LABELS.APPROVED;
    case 'merged':
      return STATUS_LABELS.MERGED;
    case 'skipped':
      return STATUS_LABELS.SKIPPED;
    case 'failed':
      return STATUS_LABELS.FAILED;
    default:
      return STATUS_LABELS.WORKING;
  }
}

/**
 * Map label to internal worker status
 */
export function labelToWorkerStatus(label: StatusLabel | null): string {
  switch (label) {
    case STATUS_LABELS.WORKING:
      return 'in_progress';
    case STATUS_LABELS.AWAITING_REVIEW:
      return 'pr_created';
    case STATUS_LABELS.CHANGES_REQUESTED:
      return 'changes_requested';
    case STATUS_LABELS.ADDRESSING_FEEDBACK:
      return 'changes_requested';
    case STATUS_LABELS.APPROVED:
      return 'approved';
    case STATUS_LABELS.READY_TO_MERGE:
      return 'approved';
    case STATUS_LABELS.MERGED:
      return 'merged';
    case STATUS_LABELS.SKIPPED:
      return 'skipped';
    case STATUS_LABELS.FAILED:
      return 'failed';
    case STATUS_LABELS.CONFLICTS:
      return 'failed';
    default:
      return 'pending';
  }
}

/**
 * Map phase to phase label
 */
export function phaseToLabel(phase: string): PhaseLabel | null {
  switch (phase) {
    case 'analyzing':
      return PHASE_LABELS.ANALYZING;
    case 'project_setup':
      return PHASE_LABELS.PROJECT_SETUP;
    case 'em_assignment':
    case 'worker_execution':
      return PHASE_LABELS.WORKERS_RUNNING;
    case 'worker_review':
      return PHASE_LABELS.WORKERS_REVIEW;
    case 'em_merging':
    case 'em_review':
      return PHASE_LABELS.EMS_MERGING;
    case 'final_merge':
    case 'final_review':
      return PHASE_LABELS.FINAL_REVIEW;
    case 'complete':
      return PHASE_LABELS.COMPLETE;
    case 'failed':
      return PHASE_LABELS.FAILED;
    default:
      return null;
  }
}

/**
 * Map phase label back to internal phase
 */
export function labelToPhase(label: PhaseLabel | null): string {
  switch (label) {
    case PHASE_LABELS.ANALYZING:
      return 'analyzing';
    case PHASE_LABELS.PROJECT_SETUP:
      return 'project_setup';
    case PHASE_LABELS.WORKERS_RUNNING:
      return 'worker_execution';
    case PHASE_LABELS.WORKERS_REVIEW:
      return 'worker_review';
    case PHASE_LABELS.EMS_MERGING:
      return 'em_review';
    case PHASE_LABELS.FINAL_REVIEW:
      return 'final_review';
    case PHASE_LABELS.COMPLETE:
      return 'complete';
    case PHASE_LABELS.FAILED:
      return 'failed';
    default:
      return 'initialized';
  }
}
