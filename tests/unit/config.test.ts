/**
 * Unit tests for config management
 */

import { describe, it, expect } from 'vitest';
import { ConfigManager } from '../../src/shared/config';

describe('ConfigManager', () => {
  it('should initialize with configs array', () => {
    const configs = [
      { apiKey: 'key1' },
      { apiKey: 'key2' }
    ];

    const manager = new ConfigManager(configs);

    expect(manager.getCurrentConfig()).toEqual(configs[0]);
    expect(manager.getCurrentIndex()).toBe(0);
    expect(manager.getConfigCount()).toBe(2);
  });

  it('should rotate to next config on rate limit', () => {
    const configs = [
      { apiKey: 'key1' },
      { apiKey: 'key2' },
      { apiKey: 'key3' }
    ];

    const manager = new ConfigManager(configs);

    expect(manager.getCurrentIndex()).toBe(0);

    manager.rotateOnRateLimit();
    expect(manager.getCurrentIndex()).toBe(1);
    expect(manager.getCurrentConfig()).toEqual(configs[1]);

    manager.rotateOnRateLimit();
    expect(manager.getCurrentIndex()).toBe(2);
  });

  it('should wrap around to first config after reaching end', () => {
    const configs = [
      { apiKey: 'key1' },
      { apiKey: 'key2' }
    ];

    const manager = new ConfigManager(configs, 1); // Start at index 1

    manager.rotateOnRateLimit();
    expect(manager.getCurrentIndex()).toBe(0); // Wrapped to start
  });

  it('should start from specified index', () => {
    const configs = [
      { apiKey: 'key1' },
      { apiKey: 'key2' },
      { apiKey: 'key3' }
    ];

    const manager = new ConfigManager(configs, 2);
    expect(manager.getCurrentIndex()).toBe(2);
    expect(manager.getCurrentConfig()).toEqual(configs[2]);
  });

  it('should throw error for empty configs array', () => {
    expect(() => new ConfigManager([])).toThrow('configs must be a non-empty array');
  });

  it('should throw error for invalid index', () => {
    const configs = [{ apiKey: 'key1' }];
    const manager = new ConfigManager(configs);

    expect(() => manager.setCurrentIndex(5)).toThrow('index 5 out of bounds');
    expect(() => manager.setCurrentIndex(-1)).toThrow('index -1 out of bounds');
  });

  describe('detectRateLimit', () => {
    it('should detect rate limit errors', () => {
      expect(ConfigManager.detectRateLimit('Rate limit exceeded')).toBe(true);
      expect(ConfigManager.detectRateLimit('rate_limit error')).toBe(true);
      expect(ConfigManager.detectRateLimit('429 Too Many Requests')).toBe(true);
      expect(ConfigManager.detectRateLimit('Too many requests')).toBe(true);
      expect(ConfigManager.detectRateLimit('rate-limit hit')).toBe(true);
    });

    it('should not detect rate limit in normal output', () => {
      expect(ConfigManager.detectRateLimit('Task completed successfully')).toBe(false);
      expect(ConfigManager.detectRateLimit('Error: Something else')).toBe(false);
      expect(ConfigManager.detectRateLimit('')).toBe(false);
    });

    it('should be case insensitive', () => {
      expect(ConfigManager.detectRateLimit('RATE LIMIT EXCEEDED')).toBe(true);
      expect(ConfigManager.detectRateLimit('Rate_Limit')).toBe(true);
    });
  });

  describe('fromJSON', () => {
    it('should create ConfigManager from JSON string', () => {
      const json = JSON.stringify([
        { apiKey: 'key1' },
        { apiKey: 'key2' }
      ]);

      const manager = ConfigManager.fromJSON(json);
      expect(manager.getConfigCount()).toBe(2);
      expect(manager.getCurrentConfig()).toEqual({ apiKey: 'key1' });
    });

    it('should throw error for invalid JSON', () => {
      expect(() => ConfigManager.fromJSON('not json')).toThrow('Failed to parse CLAUDE_CONFIGS');
    });

    it('should throw error for empty array', () => {
      expect(() => ConfigManager.fromJSON('[]')).toThrow('configs must be a non-empty array');
    });

    it('should throw error for non-array', () => {
      expect(() => ConfigManager.fromJSON('{}')).toThrow('configs must be a non-empty array');
    });
  });

  describe('validateConfigs', () => {
    it('should pass valid configs', () => {
      const configs = [
        { apiKey: 'key1' },
        { env: { ANTHROPIC_API_KEY: 'key2' } }
      ];

      expect(ConfigManager.validateConfigs(configs)).toBe(true);
    });

    it('should throw error for non-array', () => {
      expect(() => ConfigManager.validateConfigs(null)).toThrow('must be a JSON array');
    });

    it('should throw error for empty array', () => {
      expect(() => ConfigManager.validateConfigs([])).toThrow('CLAUDE_CONFIGS is empty');
    });

    it('should throw error for config without API key', () => {
      const configs = [{ model: 'sonnet' }];
      expect(() => ConfigManager.validateConfigs(configs)).toThrow('must have either apiKey or env.ANTHROPIC_API_KEY');
    });
  });
});
