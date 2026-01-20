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
export type EventType = 'issue_labeled' | 'push' | 'pull_request_opened' | 'pull_request_merged' | 'pull_request_review' | 'workflow_dispatch' | 'schedule';
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
     * Run director analysis to break down issue into EM tasks
     */
    private runAnalysis;
    /**
     * Start the next pending EM
     */
    private startNextEM;
    /**
     * Break down an EM task into worker tasks
     */
    private breakdownEMTask;
    /**
     * Start the next pending worker for an EM
     */
    private startNextWorker;
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