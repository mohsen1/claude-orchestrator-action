/**
 * Configuration management for Claude API keys
 * Handles rotation when rate limits are hit
 */
/**
 * Manages Claude API config rotation for rate limit handling
 */
export class ConfigManager {
    configs;
    currentIndex;
    /**
     * Initialize with a list of Claude configurations
     * @param configs - Array of Claude configurations
     * @param startIndex - Index to start from (default: 0)
     */
    constructor(configs, startIndex = 0) {
        if (!Array.isArray(configs) || configs.length === 0) {
            throw new Error('configs must be a non-empty array');
        }
        this.configs = configs;
        this.currentIndex = startIndex;
    }
    /**
     * Get the current configuration
     * @returns Current Claude configuration
     */
    getCurrentConfig() {
        return this.configs[this.currentIndex];
    }
    /**
     * Get the current index
     * @returns Current config index
     */
    getCurrentIndex() {
        return this.currentIndex;
    }
    /**
     * Set the current index
     * @param index - Index to set
     */
    setCurrentIndex(index) {
        if (index < 0 || index >= this.configs.length) {
            throw new Error(`index ${index} out of bounds [0, ${this.configs.length})`);
        }
        this.currentIndex = index;
    }
    /**
     * Rotate to the next configuration
     * Wraps around to the first config when exhausted
     * @returns The new current config
     */
    rotateOnRateLimit() {
        this.currentIndex = (this.currentIndex + 1) % this.configs.length;
        return this.getCurrentConfig();
    }
    /**
     * Get the total number of configs
     * @returns Number of configs
     */
    getConfigCount() {
        return this.configs.length;
    }
    /**
     * Check if output contains rate limit indicators
     * @param output - Output to check (stdout, stderr, or combined)
     * @returns true if rate limit detected
     */
    static detectRateLimit(output) {
        const lowerOutput = output.toLowerCase();
        // Check for common rate limit indicators
        return (lowerOutput.includes('rate limit') ||
            lowerOutput.includes('rate_limit') ||
            lowerOutput.includes('429') ||
            lowerOutput.includes('too many requests') ||
            lowerOutput.includes('rate-limit') ||
            lowerOutput.includes('ratelimit'));
    }
    /**
     * Create a ConfigManager from environment variables
     * Expects CLAUDE_CONFIGS to be a JSON string
     * @param configsJson - JSON string of configs array
     * @param startIndex - Starting index (default: 0)
     * @returns ConfigManager instance
     */
    static fromJSON(configsJson, startIndex = 0) {
        try {
            const configs = JSON.parse(configsJson);
            return new ConfigManager(configs, startIndex);
        }
        catch (error) {
            throw new Error(`Failed to parse CLAUDE_CONFIGS: ${error.message}`);
        }
    }
    /**
     * Validate a configs array
     * @param configs - Array of configs to validate
     * @returns true if valid
     * @throws Error if invalid
     */
    static validateConfigs(configs) {
        if (!Array.isArray(configs)) {
            throw new Error('CLAUDE_CONFIGS must be a JSON array');
        }
        if (configs.length === 0) {
            throw new Error('CLAUDE_CONFIGS is empty');
        }
        // Basic validation of each config
        for (let i = 0; i < configs.length; i++) {
            const config = configs[i];
            if (typeof config !== 'object' || config === null) {
                throw new Error(`CLAUDE_CONFIGS[${i}] must be an object`);
            }
            // Each config should have either apiKey or env.ANTHROPIC_API_KEY
            if (!config.apiKey && !config.env?.ANTHROPIC_API_KEY) {
                throw new Error(`CLAUDE_CONFIGS[${i}] must have either apiKey or env.ANTHROPIC_API_KEY`);
            }
        }
        return true;
    }
}
//# sourceMappingURL=config.js.map