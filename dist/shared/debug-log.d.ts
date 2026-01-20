/**
 * Debug Logging for Claude Code Orchestrator
 *
 * When debug mode is enabled, logs events to a separate GitHub issue.
 * This helps diagnose orchestration issues without cluttering the main issue.
 */
import { GitHubClient } from './github.js';
export declare class DebugLogger {
    private enabled;
    private github;
    private issueNumber;
    private buffer;
    private startTime;
    private mainIssueNumber?;
    constructor(github: GitHubClient, enabled: boolean, mainIssueNumber?: number);
    /**
     * Log an event (only if debug mode is enabled)
     */
    log(event: string, details?: Record<string, unknown>, phase?: string): Promise<void>;
    /**
     * Log an error
     */
    logError(event: string, error: Error | string, phase?: string): Promise<void>;
    /**
     * Flush buffered logs to the debug issue
     * Call this at the end of each event handler
     */
    flush(): Promise<void>;
    /**
     * Get repo info from environment
     */
    private getRepoInfo;
    /**
     * Find existing debug issue or create a new one
     */
    private findOrCreateDebugIssue;
    /**
     * Format log entries for GitHub comment
     */
    private formatLogEntries;
    /**
     * Create a summary of the current run for quick reference
     */
    getSummary(): {
        events: number;
        duration: number;
        errors: number;
    };
}
export declare function initDebugLogger(github: GitHubClient, enabled: boolean, mainIssueNumber?: number): DebugLogger;
export declare function getDebugLogger(): DebugLogger | null;
export declare function debugLog(event: string, details?: Record<string, unknown>, phase?: string): Promise<void>;
export declare function debugLogError(event: string, error: Error | string, phase?: string): Promise<void>;
export declare function flushDebugLog(): Promise<void>;
//# sourceMappingURL=debug-log.d.ts.map