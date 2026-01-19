/**
 * End-to-end orchestrator that runs the full hierarchy inline
 * Director -> EM -> Workers all in one workflow run
 *
 * Uses TmuxClaudeRunner for actual file modifications via interactive Claude CLI
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
    };
}
export declare class E2EOrchestrator {
    private context;
    private github;
    private configManager;
    private claude;
    private tmuxRunner;
    private workBranch;
    private tmuxSessionName;
    constructor(context: E2EContext);
    run(): Promise<void>;
    private sleep;
    private createWorkBranch;
    private analyzeIssue;
    private breakdownEMTask;
    private executeWorkerTask;
    private commitAndPush;
    private createPullRequest;
    private postSuccessComment;
    private postFailureComment;
}
//# sourceMappingURL=index.d.ts.map