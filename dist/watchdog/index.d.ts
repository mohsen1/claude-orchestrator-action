/**
 * Watchdog component
 * Detects and recovers from stalled orchestration components
 */
export interface StalledComponent {
    type: 'director' | 'em' | 'worker';
    issueNumber: number;
    emId?: number;
    workerId?: number;
    status: string;
    lastUpdated: string;
    stalledMinutes: number;
}
export interface WatchdogContext {
    repo: {
        owner: string;
        repo: string;
    };
    token: string;
    stallTimeoutMinutes: number;
}
/**
 * Watchdog class
 */
export declare class Watchdog {
    private context;
    private github;
    constructor(context: WatchdogContext);
    /**
     * Check for stalled components and take action
     */
    checkStalled(): Promise<StalledComponent[]>;
    /**
     * Check a specific issue for stalled components
     */
    private checkIssue;
    /**
     * Mark an issue as stalled with labels and comments
     */
    private markIssueStalled;
    /**
     * Build a comment about stalled components
     */
    private buildStalledComment;
    /**
     * Get a human-readable description of a component
     */
    private componentDescription;
    /**
     * Attempt to recover a stalled component
     */
    recoverStalled(component: StalledComponent): Promise<boolean>;
    /**
     * Recover a stalled Director
     */
    private recoverDirector;
    /**
     * Recover a stalled EM
     */
    private recoverEM;
    /**
     * Recover a stalled Worker
     */
    private recoverWorker;
}
//# sourceMappingURL=index.d.ts.map