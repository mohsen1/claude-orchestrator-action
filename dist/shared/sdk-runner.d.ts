/**
 * Claude Agent SDK Runner
 *
 * Uses the official @anthropic-ai/claude-agent-sdk for task execution.
 * This properly handles file modifications, unlike CLI print mode.
 */
export interface SDKRunnerOptions {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    workDir?: string;
}
export interface SDKTaskResult {
    success: boolean;
    output: string;
    error?: string;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
}
export declare class SDKRunner {
    private apiKey?;
    private baseUrl?;
    private model?;
    private workDir;
    constructor(options?: SDKRunnerOptions);
    /**
     * Execute a task using the Claude Agent SDK with retry logic
     */
    executeTask(prompt: string, options?: {
        sessionId?: string;
        allowedTools?: string[];
        maxRetries?: number;
    }): Promise<SDKTaskResult>;
    private isNonRetryableError;
    /**
     * Single execution attempt
     */
    private executeTaskOnce;
    private isRateLimitError;
}
//# sourceMappingURL=sdk-runner.d.ts.map