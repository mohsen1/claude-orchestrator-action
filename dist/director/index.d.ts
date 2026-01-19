/**
 * Director component
 * Main orchestrator that analyzes issues and spawns EM workflows
 */
import type { ClaudeConfig } from '../shared/config.js';
export interface DirectorContext {
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
        autoMerge?: boolean;
        cleanupBranches?: boolean;
        dispatchStaggerMs?: number;
    };
}
/**
 * Director class - main orchestrator
 */
export declare class Director {
    private context;
    private github;
    private configManager;
    private claude;
    private state;
    constructor(context: DirectorContext);
    /**
     * Run the Director orchestration
     */
    run(): Promise<void>;
    /**
     * Resume Director orchestration (e.g., after review feedback)
     */
    resume(sessionId: string): Promise<void>;
    /**
     * Validate that the issue has required fields
     */
    private validateInput;
    /**
     * Load existing state or create new state
     */
    private loadOrCreateState;
    /**
     * Analyze the issue and break down into EM tasks
     */
    private analyzeIssue;
    /**
     * Build the prompt for issue analysis
     */
    private buildAnalysisPrompt;
    /**
     * Parse EM tasks from Claude's response
     */
    private parseEMTasks;
    /**
     * Create the Director's work branch
     */
    private createWorkBranch;
    /**
     * Dispatch EM workflows in parallel
     */
    private dispatchEMs;
    /**
     * Update the issue status comment
     */
    private updateStatusComment;
    /**
     * Build the status comment markdown
     */
    private buildStatusComment;
    /**
     * Handle an error during orchestration
     */
    private handleError;
    /**
     * Delay helper for staggered dispatch
     */
    private delay;
    /**
     * Handle EM PR review (merge or request changes)
     */
    handleEMPR(prNumber: number): Promise<void>;
    /**
     * Check if all EMs are complete and create final PR
     */
    private checkAllEMsComplete;
    /**
     * Build the final PR body
     */
    private buildFinalPRBody;
}
//# sourceMappingURL=index.d.ts.map