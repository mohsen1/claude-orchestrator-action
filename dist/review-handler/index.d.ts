/**
 * Review Handler component
 * Handles PR review events and dispatches appropriate workflows for resumption
 */
export interface ReviewHandlerContext {
    repo: {
        owner: string;
        repo: string;
    };
    token: string;
    pr: {
        number: number;
        headRef: string;
        baseRef: string;
        body: string;
    };
    review: {
        state: 'approved' | 'changes_requested' | 'commented';
        body: string;
    };
    configs: string;
}
/**
 * Review Handler class
 */
export declare class ReviewHandler {
    private context;
    private github;
    constructor(context: ReviewHandlerContext);
    /**
     * Handle a PR review event
     */
    handleReview(): Promise<void>;
    /**
     * Extract session ID from PR body
     */
    private extractSessionId;
    /**
     * Build feedback prompt for resuming session
     */
    private buildFeedbackPrompt;
    /**
     * Dispatch Worker workflow with review feedback
     */
    private dispatchWorkerReview;
    /**
     * Dispatch EM workflow with review feedback
     */
    private dispatchEMReview;
    /**
     * Dispatch Director workflow with review feedback
     */
    private dispatchDirectorReview;
    /**
     * Extract issue number from PR body
     */
    private extractIssueNumber;
}
//# sourceMappingURL=index.d.ts.map