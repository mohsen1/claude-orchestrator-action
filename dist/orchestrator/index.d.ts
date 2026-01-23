/**
 * Event-Driven Orchestrator
 *
 * Handles GitHub events and manages state transitions.
 * Each invocation:
 * 1. Reads current state from .orchestrator/state.json
 * 2. Determines action based on event and state
 * 3. Executes action
 * 4. Updates state and exits
 */
import type { ClaudeConfig } from '../shared/config.js';
export type EventType = 'issue_labeled' | 'issue_closed' | 'push' | 'pull_request_opened' | 'pull_request_merged' | 'pull_request_review' | 'workflow_dispatch' | 'schedule' | 'start_em' | 'execute_worker' | 'create_em_pr' | 'check_completion' | 'retry_failed';
export interface OrchestratorEvent {
    type: EventType;
    issueNumber?: number;
    prNumber?: number;
    branch?: string;
    reviewState?: 'approved' | 'changes_requested' | 'commented';
    reviewBody?: string;
    emId?: number;
    workerId?: number;
    retryCount?: number;
    idempotencyToken?: string;
}
export interface OrchestratorContext {
    repo: {
        owner: string;
        name: string;
    };
    token: string;
    configs: ClaudeConfig[];
    options?: {
        maxEms?: number;
        maxWorkersPerEm?: number;
        reviewWaitMinutes?: number;
        prLabel?: string;
    };
}
export declare class EventDrivenOrchestrator {
    private ctx;
    private github;
    private configManager;
    private claude;
    private sdkRunner;
    private state;
    constructor(ctx: OrchestratorContext);
    /**
     * Dispatch an internal event via workflow_dispatch
     * Generates idempotency token and handles retries
     */
    private dispatchEvent;
    /**
     * Add error to history (preserves all errors)
     */
    private addErrorToHistory;
    /**
     * Update the phase and sync the label on the issue
     */
    private setPhase;
    /**
     * Generate a smart executive summary based on current state
     */
    private generateExecutiveSummary;
    /**
     * Run a Claude task with automatic retry on rate limit errors
     * Handles API key rotation and exponential backoff
     */
    private runClaudeTaskWithRetry;
    /**
     * Post or update progress comment on the issue
     */
    private updateProgressComment;
    /**
     * Main entry point - handle an event
     *
     * IMPORTANT: This method should handle ONE event and exit.
     * Long-running work is done by Claude, and state is persisted.
     * The next event (PR merge, review, etc.) triggers the next step.
     */
    handleEvent(event: OrchestratorEvent): Promise<void>;
    /**
     * Handle issue labeled - start new orchestration
     */
    /**
     * Handle issue labeled - analyze and dispatch EMs
     * This handler ONLY analyzes and dispatches - it does NOT execute workers
     */
    private handleIssueLabeled;
    /**
     * Handle issue closed - cleanup all branches and PRs
     */
    private handleIssueClosed;
    /**
     * Handle start_em event - create EM branch and dispatch workers
     */
    private handleStartEM;
    /**
     * Handle execute_worker event - execute worker task and create PR
     */
    private handleExecuteWorker;
    /**
     * Handle create_em_pr event - create PR after all workers merged
     */
    private handleCreateEMPR;
    /**
     * Handle check_completion event - check if all EMs done and create final PR
     */
    private handleCheckCompletion;
    /**
     * Handle retry_failed event - retry a failed worker or EM
     */
    private handleRetryFailed;
    /**
     * Run director analysis to break down issue into EM tasks
     */
    /**
     * Run analysis and dispatch EMs (event-driven version)
     * This ONLY analyzes and dispatches - does NOT execute workers
     */
    private runAnalysisAndDispatch;
    /**
     * Legacy runAnalysis - kept for backward compatibility during migration
     * @deprecated Use runAnalysisAndDispatch instead
     */
    private runAnalysis;
    /**
     * Start ALL pending EMs in parallel
     * This is the key to parallel execution - all EMs work simultaneously
     */
    private startAllPendingEMs;
    /**
     * Start a single EM (called in parallel for multiple EMs)
     */
    private startSingleEM;
    /**
     * Start the next pending EM (legacy - for setup EM which must run first)
     */
    private startNextEM;
    /**
     * Break down an EM task into ATOMIC, VERIFIABLE worker tasks
     *
     * CRITICAL: Each worker must create ONE specific, verifiable change.
     * This prevents merge conflicts and enables true parallelization.
     *
     * Returns tasks with dependency information extracted from task descriptions.
     */
    private breakdownEMTask;
    /**
     * Process worker tasks to extract dependencies and detect file-based conflicts
     *
     * 1. Parse explicit "Depends on Worker-X" patterns from task descriptions
     * 2. Detect implicit dependencies when multiple workers modify the same file
     * 3. Build a dependency graph for topological execution
     */
    private processWorkerDependencies;
    /**
     * Start ALL workers for an EM, respecting dependency order
     *
     * Workers with unmet dependencies wait until their dependencies complete.
     * Workers whose dependencies are met execute in parallel.
     */
    private startAllWorkersForEM;
    /**
     * Execute a single worker task (called in parallel)
     */
    private executeSingleWorker;
    /**
     * Build the prompt for a worker task
     */
    private buildWorkerPrompt;
    /**
     * Start the next pending worker for an EM (legacy sequential mode)
     * Errors are caught and logged, allowing orchestration to continue
     */
    private startNextWorker;
    /**
     * Wait for reviews before merging a PR
     * Polls for reviews to appear, then addresses any comments before allowing merge
     */
    private waitForReviewsBeforeMerge;
    /**
     * Address review comments on a PR before merging
     */
    private addressReviewComments;
    /**
     * Create EM PR after all workers are done
     */
    private createEMPullRequest;
    /**
     * Check if ready for final merge
     */
    private checkFinalMerge;
    /**
     * Create the final PR to main
     */
    private createFinalPR;
    /**
     * Handle PR merged event
     */
    private handlePRMerged;
    /**
     * Find the state node (worker/em) that owns a PR so we can store dedupe metadata.
     */
    private getOrInitReviewTrackingForPR;
    /**
     * Return the set of unaddressed ROOT inline review comments on a PR.
     * A root comment is considered addressed if:
     * - it has a reply containing ORCHESTRATOR_REVIEW_MARKER, OR
     * - it is present in addressedReviewCommentIds in state.
     */
    private getUnaddressedRootReviewCommentIds;
    /**
     * Check if a PR has a Copilot review and is ready to merge
     * Copilot COMMENTED reviews are considered ready to merge (no approval needed)
     */
    private hasCopilotCommentedReview;
    /**
     * Determine whether a PR is ready to merge based on review state and unaddressed comments.
     * We intentionally do NOT require \"APPROVED\" to support Copilot COMMENTED reviews.
     * For Copilot COMMENTED reviews, we don't require all review comments to be addressed.
     */
    private isPRReadyToMerge;
    /**
     * Attempt to merge a PR if it is review-clean.
     */
    private maybeAutoMergePR;
    /**
     * Sync global phase for review/merge work once execution has produced PRs.
     * In practice, project_setup should transition to worker_review once all setup workers are done.
     */
    private syncPhaseForReviewIfReady;
    /**
     * Proactively check for reviews on all PRs and address them
     */
    private checkAndAddressReviews;
    /**
     * Handle PR review event
     */
    private handlePRReview;
    /**
     * Address review feedback on a branch (worker/EM PRs)
     */
    private addressReview;
    /**
     * Process general PR comments (not inline code comments)
     */
    private processGeneralPRComments;
    /**
     * Process each inline comment individually
     */
    private processInlineComments;
    /**
     * Address general review feedback (not inline comments)
     */
    private addressGeneralReviewFeedback;
    /**
     * Address review feedback on the final PR
     */
    private addressFinalPRReview;
    /**
     * Handle progress check - continue any pending work
     */
    private handleProgressCheck;
    /**
     * Attempt to recover from failed state
     * Looks at what work was done and tries to continue from there
     */
    private attemptRecovery;
    /**
     * Continue worker execution
     */
    private continueWorkerExecution;
    /**
     * Check for worker PRs that need conflict resolution or review handling
     * This handles cases where events weren't properly triggered
     */
    private handlePRsNeedingAttention;
    /**
     * Resolve conflicts on a worker PR by rebasing onto the EM branch
     */
    private resolveWorkerConflicts;
    /**
     * Check if PRs can be merged
     */
    private checkAndMergePRs;
    /**
     * Find work branch from a PR branch name
     */
    private findWorkBranchFromPRBranch;
    /**
     * Load state from a work branch
     */
    private loadStateFromWorkBranch;
}
//# sourceMappingURL=index.d.ts.map