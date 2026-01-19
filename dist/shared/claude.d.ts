/**
 * Claude Code CLI runner
 * Handles execution of Claude Code with proper session management
 */
/**
 * Custom error for rate limit detection
 */
export declare class RateLimitError extends Error {
    constructor(message: string);
}
/**
 * Result of a Claude Code execution
 */
export interface ClaudeResult {
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number | null;
}
/**
 * Options for running Claude Code
 */
export interface ClaudeOptions {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
}
/**
 * Manages execution of Claude Code CLI
 */
export declare class ClaudeCodeRunner {
    private config;
    constructor(options?: ClaudeOptions);
    /**
     * Run a task with Claude Code
     * @param task - The task description/prompt
     * @param sessionId - Session ID for context preservation
     * @returns Execution result
     */
    runTask(task: string, _sessionId: string): Promise<ClaudeResult>;
    /**
     * Resume an existing Claude Code session
     * @param sessionId - Session ID to resume
     * @param prompt - Additional prompt/context for the resumed session
     * @returns Execution result
     */
    resumeSession(sessionId: string, prompt: string): Promise<ClaudeResult>;
    /**
     * Resolve merge conflicts using Claude
     * @param sessionId - Session ID for context
     * @param conflictFiles - List of conflicted files
     * @param targetBranch - Branch being rebased/merged onto
     * @returns Execution result
     */
    resolveConflicts(sessionId: string, conflictFiles: string[], targetBranch: string): Promise<ClaudeResult>;
    /**
     * Generate a summary of changes made in a session
     * @param sessionId - Session ID
     * @param filesModified - List of modified files
     * @returns Execution result with summary in stdout
     */
    generateChangesSummary(sessionId: string, filesModified: string[]): Promise<string>;
    /**
     * Review a pull request and provide feedback
     * @param sessionId - Session ID
     * @param prDescription - PR description/changes
     * @param context - Additional context for the review
     * @returns Execution result with review feedback
     */
    reviewPullRequest(sessionId: string, prDescription: string, context?: string): Promise<ClaudeResult>;
    /**
     * Check if output contains rate limit indicators
     * @throws RateLimitError if rate limit detected
     */
    private checkRateLimit;
    /**
     * Build environment variables for Claude Code execution
     */
    private buildEnv;
    /**
     * Update the runner configuration
     * @param options - New configuration options
     */
    updateConfig(options: ClaudeOptions): void;
    /**
     * Get current configuration
     * @returns Current configuration
     */
    getConfig(): ClaudeOptions;
}
/**
 * Generate a unique session ID
 * @param component - Component type (director, em, worker)
 * @param issueNumber - GitHub issue number
 * @param componentId - Component ID (EM ID, Worker ID, etc.)
 * @returns Unique session ID
 */
export declare function generateSessionId(_component: 'director' | 'em' | 'worker', _issueNumber: number, ..._componentIds: number[]): string;
/**
 * Parse a session ID to extract component information
 * @param sessionId - Session ID to parse
 * @returns Parsed session info
 */
export declare function parseSessionId(sessionId: string): {
    component: string;
    issueNumber: number;
    componentIds: number[];
} | null;
//# sourceMappingURL=claude.d.ts.map