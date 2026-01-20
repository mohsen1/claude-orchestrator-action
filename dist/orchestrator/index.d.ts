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
export type EventType = 'issue_labeled' | 'issue_closed' | 'push' | 'pull_request_opened' | 'pull_request_merged' | 'pull_request_review' | 'workflow_dispatch' | 'schedule';
export interface OrchestratorEvent {
    type: EventType;
    issueNumber?: number;
    prNumber?: number;
    branch?: string;
    reviewState?: 'approved' | 'changes_requested' | 'commented';
    reviewBody?: string;
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
     * Post or update progress comment on the issue
     */
    private updateProgressComment;
    /**
     * Main entry point - handle an event
     */
    handleEvent(event: OrchestratorEvent): Promise<void>;
    /**
     * Handle issue labeled - start new orchestration
     */
    private handleIssueLabeled;
    /**
     * Handle issue closed - cleanup all branches and PRs
     */
    private handleIssueClosed;
    /**
     * Run director analysis to break down issue into EM tasks
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
     * Break down an EM task into worker tasks
     */
    private breakdownEMTask;
    /**
     * Start ALL workers for an EM in parallel
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