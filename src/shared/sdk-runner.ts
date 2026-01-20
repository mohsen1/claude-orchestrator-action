/**
 * Claude Agent SDK Runner
 * 
 * Uses the official @anthropic-ai/claude-agent-sdk for task execution.
 * This properly handles file modifications, unlike CLI print mode.
 */

import { spawn } from 'child_process';
import { resolve } from 'path';
import {
  query,
  type SDKResultSuccess,
  type Options as SDKOptions,
  type SpawnOptions,
  type SpawnedProcess,
} from '@anthropic-ai/claude-agent-sdk';

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

export class SDKRunner {
  private apiKey?: string;
  private baseUrl?: string;
  private model?: string;
  private workDir: string;

  constructor(options: SDKRunnerOptions = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
    this.model = options.model;
    this.workDir = options.workDir || process.cwd();
  }

  /**
   * Execute a task using the Claude Agent SDK with retry logic
   */
  async executeTask(prompt: string, options: {
    sessionId?: string;
    allowedTools?: string[];
    maxRetries?: number;
  } = {}): Promise<SDKTaskResult> {
    const maxRetries = options.maxRetries ?? 2;
    let lastError: SDKTaskResult | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const waitTime = Math.min(30000, 5000 * Math.pow(2, attempt - 1)); // 5s, 10s, 20s... max 30s
        console.log(`[SDK] Retry attempt ${attempt}/${maxRetries}, waiting ${waitTime/1000}s...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }

      const result = await this.executeTaskOnce(prompt, options);
      
      if (result.success) {
        return result;
      }

      lastError = result;
      console.error(`[SDK] Attempt ${attempt + 1} failed: ${result.error}`);

      // Don't retry on certain errors
      if (result.error && this.isNonRetryableError(result.error)) {
        console.log('[SDK] Non-retryable error, not retrying');
        break;
      }
    }

    return lastError || {
      success: false,
      output: '',
      error: 'All retry attempts failed',
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0,
    };
  }

  private isNonRetryableError(message: string): boolean {
    return (
      message.includes('invalid_api_key') ||
      message.includes('authentication') ||
      message.includes('permission denied')
    );
  }

  /**
   * Single execution attempt
   */
  private async executeTaskOnce(prompt: string, options: {
    sessionId?: string;
    allowedTools?: string[];
  } = {}): Promise<SDKTaskResult> {
    const startTime = Date.now();

    // Set up environment variables for auth
    if (this.apiKey) {
      process.env.ANTHROPIC_AUTH_TOKEN = this.apiKey;
    }
    if (this.baseUrl) {
      process.env.ANTHROPIC_BASE_URL = this.baseUrl;
    }

    const queryOptions: SDKOptions = {
      resume: options.sessionId,
      cwd: this.workDir,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      allowedTools: options.allowedTools || [
        'Read',
        'Write',
        'Edit',
        'Bash',
        'Glob',
        'Grep',
      ],
      model: this.model,
      // Custom spawner for reliable node path resolution
      spawnClaudeCodeProcess: (spawnOpts: SpawnOptions): SpawnedProcess => {
        const nodeAbsPath = process.execPath;
        const nodeBinDir = nodeAbsPath.replace(/\/node$/, '');
        const env = {
          ...process.env,
          ...spawnOpts.env,
          PATH: `${nodeBinDir}:${spawnOpts.env?.PATH || process.env.PATH}`,
        };
        const command = spawnOpts.command === 'node' ? nodeAbsPath : spawnOpts.command;
        const cwd = spawnOpts.cwd ? resolve(spawnOpts.cwd) : process.cwd();
        const child = spawn(command, spawnOpts.args, {
          cwd,
          env,
          stdio: ['pipe', 'pipe', 'inherit'],
        });
        return child as unknown as SpawnedProcess;
      },
    };

    let result = '';
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      console.log(`[SDK] Executing task in ${this.workDir}`);
      console.log(`[SDK] Prompt (${prompt.length} chars): ${prompt.substring(0, 100)}...`);

      for await (const message of query({ prompt, options: queryOptions })) {
        // Track token usage
        if (message.type === 'assistant' && message.message?.usage) {
          inputTokens += message.message.usage.input_tokens || 0;
          outputTokens += message.message.usage.output_tokens || 0;
        }

        // Log tool usage
        if (message.type === 'assistant' && message.message?.content) {
          for (const block of message.message.content) {
            if (block.type === 'tool_use' && block.name) {
              console.log(`[SDK] Tool: ${block.name}`);
            }
          }
        }

        // Capture final result
        if (message.type === 'result' && 'result' in message) {
          result = (message as SDKResultSuccess).result;
        }
      }

      const durationMs = Date.now() - startTime;
      console.log(`[SDK] Task completed in ${durationMs}ms, tokens: ${inputTokens}+${outputTokens}`);

      return {
        success: true,
        output: result,
        inputTokens,
        outputTokens,
        durationMs,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const durationMs = Date.now() - startTime;

      console.error(`[SDK] Task failed after ${durationMs}ms:`, errorMessage);

      // Check for rate limit
      if (this.isRateLimitError(errorMessage)) {
        console.log('[SDK] Rate limit detected');
      }

      return {
        success: false,
        output: '',
        error: errorMessage,
        inputTokens,
        outputTokens,
        durationMs,
      };
    }
  }

  private isRateLimitError(message: string): boolean {
    return (
      message.includes('429') ||
      message.includes('rate limit') ||
      message.includes('rate_limit') ||
      message.includes('quota exceeded') ||
      message.includes('too many requests')
    );
  }
}
