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
  };
}

/**
 * Manages Claude API config rotation for rate limit handling
 */
export class ConfigManager {
  private configs: ClaudeConfig[];
  private currentIndex: number;

  /**
   * Initialize with a list of Claude configurations
   * @param configs - Array of Claude configurations
   * @param startIndex - Index to start from (default: 0)
   */
  constructor(configs: ClaudeConfig[], startIndex = 0) {
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
  getCurrentConfig(): ClaudeConfig {
    return this.configs[this.currentIndex];
  }

  /**
   * Get the current index
   * @returns Current config index
   */
  getCurrentIndex(): number {
    return this.currentIndex;
  }

  /**
   * Set the current index
   * @param index - Index to set
   */
  setCurrentIndex(index: number): void {
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
  rotateOnRateLimit(): ClaudeConfig {
    this.currentIndex = (this.currentIndex + 1) % this.configs.length;
    return this.getCurrentConfig();
  }

  /**
   * Get the total number of configs
   * @returns Number of configs
   */
  getConfigCount(): number {
    return this.configs.length;
  }

  /**
   * Check if output contains rate limit indicators
   * @param output - Output to check (stdout, stderr, or combined)
   * @returns true if rate limit detected
   */
  static detectRateLimit(output: string): boolean {
    const lowerOutput = output.toLowerCase();

    // Check for common rate limit indicators
    return (
      lowerOutput.includes('rate limit') ||
      lowerOutput.includes('rate_limit') ||
      lowerOutput.includes('429') ||
      lowerOutput.includes('too many requests') ||
      lowerOutput.includes('rate-limit') ||
      lowerOutput.includes('ratelimit')
    );
  }

  /**
   * Create a ConfigManager from environment variables
   * Expects CLAUDE_CONFIGS to be a JSON string
   * @param configsJson - JSON string of configs array
   * @param startIndex - Starting index (default: 0)
   * @returns ConfigManager instance
   */
  static fromJSON(configsJson: string, startIndex = 0): ConfigManager {
    try {
      const configs = JSON.parse(configsJson) as ClaudeConfig[];
      return new ConfigManager(configs, startIndex);
    } catch (error) {
      throw new Error(`Failed to parse CLAUDE_CONFIGS: ${(error as Error).message}`);
    }
  }

  /**
   * Validate a configs array
   * @param configs - Array of configs to validate
   * @returns true if valid
   * @throws Error if invalid
   */
  static validateConfigs(configs: unknown): configs is ClaudeConfig[] {
    if (!Array.isArray(configs)) {
      throw new Error('CLAUDE_CONFIGS must be a JSON array');
    }

    if (configs.length === 0) {
      throw new Error('CLAUDE_CONFIGS is empty');
    }

    // Basic validation of each config
    for (let i = 0; i < configs.length; i++) {
      const config = configs[i] as ClaudeConfig;
      if (typeof config !== 'object' || config === null) {
        throw new Error(`CLAUDE_CONFIGS[${i}] must be an object`);
      }

      // Each config should have either apiKey or env.ANTHROPIC_API_KEY
      if (!config.apiKey && !config.env?.ANTHROPIC_API_KEY) {
        throw new Error(
          `CLAUDE_CONFIGS[${i}] must have either apiKey or env.ANTHROPIC_API_KEY`
        );
      }
    }

    return true;
  }
}
