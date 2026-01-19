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
     * Execute a task using the Claude Agent SDK
     */
    executeTask(prompt: string, options?: {
        sessionId?: string;
        allowedTools?: string[];
    }): Promise<SDKTaskResult>;
    private isRateLimitError;
}
//# sourceMappingURL=sdk-runner.d.ts.map