/**
 * Engineering Manager (EM) component
 * Manages Workers for a specific task area
 */
import type { ClaudeConfig } from '../shared/config.js';
export interface EMContext {
    repo: {
        owner: string;
        repo: string;
    };
    token: string;
    issue: {
        number: number;
    };
    emId: number;
    taskAssignment: string;
    workBranch: string;
    configs: ClaudeConfig[];
    resume: boolean;
    sessionId?: string;
    options?: {
        maxWorkers?: number;
        dispatchStaggerMs?: number;
    };
}
/**
 * Engineering Manager class
 */
export declare class EngineeringManager {
    private context;
    private github;
    private configManager;
    private claude;
    private state;
    constructor(context: EMContext);
    /**
     * Run the EM orchestration
     */
    run(): Promise<void>;
    /**
     * Resume EM session (e.g., after review feedback)
     */
    resume(sessionId: string): Promise<void>;
    /**
     * Load existing state or create new state
     */
    private loadOrCreateState;
    /**
     * Create EM branch
     */
    private createEMBranch;
    /**
     * Analyze the EM task and break down into worker tasks
     */
    private analyzeTask;
    /**
     * Build the prompt for task analysis
     */
    private buildAnalysisPrompt;
    /**
     * Parse Worker tasks from Claude's response
     */
    private parseWorkerTasks;
    /**
     * Dispatch Worker workflows in parallel
     */
    private dispatchWorkers;
    /**
     * Handle Worker PR review
     */
    handleWorkerPR(prNumber: number): Promise<void>;
    /**
     * Check if all Workers are complete and create EM PR
     */
    private checkAllWorkersComplete;
    /**
     * Generate summary of changes
     */
    private generateChangesSummary;
    /**
     * Build the PR body
     */
    private buildPRBody;
    /**
     * Handle an error during orchestration
     */
    private handleError;
    /**
     * Delay helper
     */
    private delay;
}
//# sourceMappingURL=index.d.ts.map