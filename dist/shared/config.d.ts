/**
 * Configuration management for Claude API keys
 * Handles rotation when rate limits are hit
 */
export interface ClaudeConfig {
    apiKey?: string;
    model?: string;
    env?: {
        ANTHROPIC_BASE_URL?: string;
        ANTHROPIC_API_KEY?: string;
        ANTHROPIC_AUTH_TOKEN?: string;
    };
}
/**
 * Manages Claude API config rotation for rate limit handling
 */
export declare class ConfigManager {
    private configs;
    private currentIndex;
    /**
     * Initialize with a list of Claude configurations
     * @param configs - Array of Claude configurations
     * @param startIndex - Index to start from (default: 0)
     */
    constructor(configs: ClaudeConfig[], startIndex?: number);
    /**
     * Get the current configuration
     * @returns Current Claude configuration
     */
    getCurrentConfig(): ClaudeConfig;
    /**
     * Get the current index
     * @returns Current config index
     */
    getCurrentIndex(): number;
    /**
     * Set the current index
     * @param index - Index to set
     */
    setCurrentIndex(index: number): void;
    /**
     * Rotate to the next configuration
     * Wraps around to the first config when exhausted
     * @returns The new current config
     */
    rotateOnRateLimit(): ClaudeConfig;
    /**
     * Get the total number of configs
     * @returns Number of configs
     */
    getConfigCount(): number;
    /**
     * Check if output contains rate limit indicators
     * @param output - Output to check (stdout, stderr, or combined)
     * @returns true if rate limit detected
     */
    static detectRateLimit(output: string): boolean;
    /**
     * Create a ConfigManager from environment variables
     * Expects CLAUDE_CONFIGS to be a JSON string
     * @param configsJson - JSON string of configs array
     * @param startIndex - Starting index (default: 0)
     * @returns ConfigManager instance
     */
    static fromJSON(configsJson: string, startIndex?: number): ConfigManager;
    /**
     * Validate a configs array
     * @param configs - Array of configs to validate
     * @returns true if valid
     * @throws Error if invalid
     */
    static validateConfigs(configs: unknown): configs is ClaudeConfig[];
}
//# sourceMappingURL=config.d.ts.map