/**
 * Worker component
 * Executes a specific task using Claude Code CLI
 */
import type { ClaudeConfig } from '../shared/config.js';
export interface WorkerContext {
    repo: {
        owner: string;
        repo: string;
    };
    token: string;
    issue: {
        number: number;
    };
    emId: number;
    workerId: number;
    taskAssignment: string;
    emBranch: string;
    configs: ClaudeConfig[];
    resume: boolean;
    sessionId?: string;
    options?: {
        maxRetries?: number;
    };
}
/**
 * Worker class
 */
export declare class Worker {
    private context;
    private github;
    private configManager;
    private claude;
    private state;
    constructor(context: WorkerContext);
    /**
     * Run the Worker task
     */
    run(): Promise<void>;
    /**
     * Resume Worker session (e.g., after review feedback)
     */
    resume(sessionId: string, feedback: string): Promise<void>;
    /**
     * Load existing state or create new state
     */
    private loadOrCreateState;
    /**
     * Create Worker branch
     */
    private createWorkerBranch;
    /**
     * Execute task with Claude Code
     */
    private executeTask;
    /**
     * Build the task prompt for Claude Code
     */
    private buildTaskPrompt;
    /**
     * Generate summary of changes
     */
    private generateChangesSummary;
    /**
     * Commit and push changes
     */
    private commitAndPush;
    /**
     * Create Worker PR to EM branch
     */
    private createWorkerPR;
    /**
     * Build the PR body
     */
    private buildPRBody;
    /**
     * Handle an error during execution
     */
    private handleError;
}
//# sourceMappingURL=index.d.ts.map