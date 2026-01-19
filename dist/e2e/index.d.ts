/**
 * End-to-end orchestrator with hierarchical PR structure
 *
 * Branch/PR Hierarchy:
 * main
 *   └── cco/issue-X-slug (Director's work branch)
 *         ├── cco/issue-X-em-1 (EM-1's branch)
 *         │     ├── cco/issue-X-em-1-w-1 → PR to EM-1 branch
 *         │     └── cco/issue-X-em-1-w-2 → PR to EM-1 branch
 *         │     └── EM-1 PR → work branch
 *         └── cco/issue-X-em-2 (EM-2's branch)
 *               └── Workers → PRs to EM-2
 *               └── EM-2 PR → work branch
 *         └── Final PR: work branch → main
 */
import type { ClaudeConfig } from '../shared/config.js';
export interface E2EContext {
    repo: {
        owner: string;
        repo: string;
    };
    token: string;
    issue: {
        number: number;
        title: string;
        body: string;
    };
    configs: ClaudeConfig[];
    options?: {
        maxEms?: number;
        maxWorkersPerEm?: number;
        reviewWaitMinutes?: number;
    };
}
export declare class E2EOrchestrator {
    private context;
    private github;
    private configManager;
    private claude;
    private sdkRunner;
    private workBranch;
    private issueSlug;
    constructor(context: E2EContext);
    run(): Promise<void>;
    private createWorkBranch;
    private getEMBranch;
    private getWorkerBranch;
    private processEM;
    private processWorker;
    private buildWorkerPrompt;
    /**
     * Wait for the configured review period, handle any reviews, then merge PRs
     */
    private waitForReviewsAndMerge;
    /**
     * Handle a review that requests changes
     */
    private handleReviewChangesRequested;
    /**
     * Handle an inline review comment
     */
    private handleInlineComment;
    private sleep;
    private createWorkerPullRequest;
    private createEMPullRequest;
    private createFinalPR;
    private analyzeIssue;
    private breakdownEMTask;
    private postSuccessComment;
    private postFailureComment;
}
//# sourceMappingURL=index.d.ts.map