/**
 * Claude Code CLI runner
 * Handles execution of Claude Code with proper session management
 */

import { execa } from 'execa';
import { randomUUID } from 'node:crypto';

/**
 * Custom error for rate limit detection
 */
export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitError';
  }
}

/**
 * Interface for retry options
 */
export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (attempt: number, error: Error) => void;
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
export class ClaudeCodeRunner {
  private config: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
  };

  constructor(options: ClaudeOptions = {}) {
    this.config = {
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      model: options.model
    };
  }

  /**
   * Run a task with Claude Code (print mode - no file changes)
   * @param task - The task description/prompt
   * @param sessionId - Session ID for context preservation
   * @returns Execution result
   */
  async runTask(task: string, _sessionId: string): Promise<ClaudeResult> {
    const env = this.buildEnv();
    const timeoutMs = parseInt(process.env.API_TIMEOUT_MS || '300000', 10);

    console.log(`Running Claude CLI with timeout: ${timeoutMs}ms`);
    console.log(`API base URL: ${env.ANTHROPIC_BASE_URL || 'default'}`);
    console.log(`API key set: ${env.ANTHROPIC_API_KEY ? 'yes (length: ' + env.ANTHROPIC_API_KEY.length + ')' : 'no'}`);
    console.log(`Auth token set: ${env.ANTHROPIC_AUTH_TOKEN ? 'yes' : 'no'}`);
    console.log(`Task length: ${task.length} chars`);

    try {
      const args = ['-p', '--output-format', 'text', '--verbose'];
      console.log(`Claude CLI args: ${args.join(' ')}`);
      console.log(`Sending task via stdin (${task.length} chars)`);
      
      const result = await execa('claude', args, {
        env,
        timeout: timeoutMs,
        reject: false,
        input: task
      });

      if (result.timedOut) {
        console.error('Claude CLI timed out after', timeoutMs, 'ms');
        return {
          success: false,
          stdout: result.stdout || '',
          stderr: `Command timed out after ${timeoutMs}ms. This may indicate network issues or an unreachable API endpoint.`,
          exitCode: 124
        };
      }

      // Check for rate limits
      this.checkRateLimit(result.stdout, result.stderr);

      if (result.exitCode !== 0) {
        console.error('Claude CLI failed with exit code:', result.exitCode);
        console.error('stderr:', result.stderr);
        console.error('stdout:', result.stdout);
      }

      return {
        success: result.exitCode === 0,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode ?? null
      };
    } catch (error) {
      // Re-throw RateLimitError so retry logic can handle it
      if (error instanceof RateLimitError) {
        throw error;
      }

      const errorMessage = (error as Error).message;
      console.error('Claude CLI execution error:', errorMessage);

      // Check if it's a timeout error
      if (errorMessage.includes('timed out') || errorMessage.includes('ETIMEDOUT')) {
        return {
          success: false,
          stdout: '',
          stderr: `Claude CLI timed out: ${errorMessage}. Check if the API endpoint (${env.ANTHROPIC_BASE_URL || 'default'}) is accessible.`,
          exitCode: 124
        };
      }

      return {
        success: false,
        stdout: '',
        stderr: errorMessage,
        exitCode: 1
      };
    }
  }

  /**
   * Run a task with Claude Code that modifies files
   * Uses --dangerously-skip-permissions to auto-approve file changes
   * @param task - The task description/prompt
   * @returns Execution result
   */
  async runTaskWithFileChanges(task: string): Promise<ClaudeResult> {
    const env = this.buildEnv();
    const timeoutMs = parseInt(process.env.API_TIMEOUT_MS || '600000', 10);

    console.log(`Running Claude CLI (with file changes) with timeout: ${timeoutMs}ms`);
    console.log(`API base URL: ${env.ANTHROPIC_BASE_URL || 'default'}`);
    console.log(`Task length: ${task.length} chars`);

    try {
      // Use --dangerously-skip-permissions to auto-approve file writes
      // NO -p flag - that prevents file modifications
      // Use stdin for the prompt
      const args = [
        '--dangerously-skip-permissions',
        '--output-format', 'stream-json'
      ];
      console.log(`Claude CLI args: ${args.join(' ')} (task via stdin)`);
      
      const result = await execa('claude', args, {
        env,
        timeout: timeoutMs,
        reject: false,
        input: task
      });

      if (result.timedOut) {
        console.error('Claude CLI timed out after', timeoutMs, 'ms');
        return {
          success: false,
          stdout: result.stdout || '',
          stderr: `Command timed out after ${timeoutMs}ms`,
          exitCode: 124
        };
      }

      this.checkRateLimit(result.stdout, result.stderr);

      if (result.exitCode !== 0) {
        console.error('Claude CLI failed with exit code:', result.exitCode);
        console.error('stderr:', result.stderr);
        console.error('stdout (first 500 chars):', result.stdout.substring(0, 500));
      } else {
        console.log('Claude CLI completed successfully');
        console.log('stdout (first 500 chars):', result.stdout.substring(0, 500));
      }

      return {
        success: result.exitCode === 0,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode ?? null
      };
    } catch (error) {
      const errorMessage = (error as Error).message;
      console.error('Claude CLI execution error:', errorMessage);

      return {
        success: false,
        stdout: '',
        stderr: errorMessage,
        exitCode: 1
      };
    }
  }

  /**
   * Resume an existing Claude Code session
   * @param sessionId - Session ID to resume
   * @param prompt - Additional prompt/context for the resumed session
   * @returns Execution result
   */
  async resumeSession(sessionId: string, prompt: string): Promise<ClaudeResult> {
    const env = this.buildEnv();
    const timeoutMs = parseInt(process.env.API_TIMEOUT_MS || '300000', 10);

    try {
      const result = await execa(
        'claude',
        ['-p', '--resume', sessionId, '--output-format', 'text', prompt],
        {
          env,
          timeout: timeoutMs,
          reject: false
        }
      );

      if (result.timedOut) {
        return {
          success: false,
          stdout: result.stdout || '',
          stderr: `Command timed out after ${timeoutMs}ms`,
          exitCode: 124
        };
      }

      // Check for rate limits
      this.checkRateLimit(result.stdout, result.stderr);

      return {
        success: result.exitCode === 0,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode ?? null
      };
    } catch (error) {
      // Re-throw RateLimitError so retry logic can handle it
      if (error instanceof RateLimitError) {
        throw error;
      }

      return {
        success: false,
        stdout: '',
        stderr: (error as Error).message,
        exitCode: 1
      };
    }
  }

  /**
   * Resolve merge conflicts using Claude
   * @param sessionId - Session ID for context
   * @param conflictFiles - List of conflicted files
   * @param targetBranch - Branch being rebased/merged onto
   * @returns Execution result
   */
  async resolveConflicts(
    sessionId: string,
    conflictFiles: string[],
    targetBranch: string
  ): Promise<ClaudeResult> {
    const prompt = [
      `Merge conflict detected during rebase onto ${targetBranch}.`,
      `Conflicted files:\n${conflictFiles.map(f => `  - ${f}`).join('\n')}`,
      '\nPlease resolve these conflicts while preserving the intent of both changes.',
      'After resolving, stage the files and continue the rebase.',
      'If conflicts cannot be automatically resolved, abort the rebase and notify the user.'
    ].join('\n');

    return this.resumeSession(sessionId, prompt);
  }

  /**
   * Generate a summary of changes made in a session
   * @param sessionId - Session ID
   * @param filesModified - List of modified files
   * @returns Execution result with summary in stdout
   */
  async generateChangesSummary(
    sessionId: string,
    filesModified: string[]
  ): Promise<string> {
    const prompt = [
      'Please provide a concise summary (1-2 sentences) of the changes made in this session.',
      filesModified.length > 0
        ? `Modified files:\n${filesModified.map(f => `  - ${f}`).join('\n')}`
        : 'No files were modified.',
      '\nFocus on WHAT was changed and WHY, not HOW.'
    ].join('\n');

    const result = await this.resumeSession(sessionId, prompt);

    if (result.success) {
      return result.stdout.trim();
    }

    return 'Changes: Various modifications based on task requirements.';
  }

  /**
   * Review a pull request and provide feedback
   * @param sessionId - Session ID
   * @param prDescription - PR description/changes
   * @param context - Additional context for the review
   * @returns Execution result with review feedback
   */
  async reviewPullRequest(
    sessionId: string,
    prDescription: string,
    context?: string
  ): Promise<ClaudeResult> {
    const prompt = [
      'Please review the following pull request:',
      prDescription,
      context ? `\nAdditional context:\n${context}` : '',
      '\nProvide feedback on:',
      '1. Code quality and correctness',
      '2. Potential issues or bugs',
      '3. Suggested improvements',
      '\nIf the changes look good, respond with "LGTM" (Looks Good To Me).',
      'Otherwise, provide specific feedback on what needs to be changed.'
    ].join('\n');

    return this.resumeSession(sessionId, prompt);
  }

  /**
   * Check if output contains rate limit indicators
   * @throws RateLimitError if rate limit detected
   */
  private checkRateLimit(stdout: string, stderr: string): void {
    const output = `${stdout} ${stderr}`.toLowerCase();

    if (
      output.includes('rate limit') ||
      output.includes('rate_limit') ||
      output.includes('429') ||
      output.includes('too many requests')
    ) {
      throw new RateLimitError('Rate limit exceeded');
    }
  }

  /**
   * Build environment variables for Claude Code execution
   */
  private buildEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env
    };

    // Support multiple API key formats for compatibility
    // Priority: 1. Configured apiKey  2. Process env ANTHROPIC_API_KEY  3. Process env ANTHROPIC_AUTH_TOKEN
    const apiKey = this.config.apiKey || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
    if (apiKey) {
      // Set ANTHROPIC_API_KEY for standard Anthropic API
      env.ANTHROPIC_API_KEY = apiKey;
      // Also set AUTH_TOKEN for compatibility with z.ai format
      env.ANTHROPIC_AUTH_TOKEN = apiKey;
    }

    if (this.config.baseUrl) {
      env.ANTHROPIC_BASE_URL = this.config.baseUrl;
    }

    if (this.config.model) {
      env.ANTHROPIC_MODEL = this.config.model;
    }

    return env;
  }

  /**
   * Update the runner configuration
   * @param options - New configuration options
   */
  updateConfig(options: ClaudeOptions): void {
    if (options.apiKey !== undefined) {
      this.config.apiKey = options.apiKey;
    }
    if (options.baseUrl !== undefined) {
      this.config.baseUrl = options.baseUrl;
    }
    if (options.model !== undefined) {
      this.config.model = options.model;
    }
  }

  /**
   * Get current configuration
   * @returns Current configuration
   */
  getConfig(): ClaudeOptions {
    return { ...this.config };
  }

  /**
   * Run a task with automatic retry on rate limit errors
   * This is a wrapper around runTask that handles rate limiting with exponential backoff
   * @param task - The task description/prompt
   * @param sessionId - Session ID for context preservation
   * @param options - Retry options
   * @returns Execution result
   */
  async runTaskWithRetry(
    task: string,
    sessionId: string,
    options: RetryOptions = {}
  ): Promise<ClaudeResult> {
    const {
      maxRetries = 5,
      initialDelayMs = 1000,
      maxDelayMs = 60000,
      onRetry
    } = options;

    let lastError: Error | undefined;
    let attempt = 0;

    for (attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.runTask(task, sessionId);
      } catch (error) {
        lastError = error as Error;

        // Only retry on RateLimitError
        if (!(error instanceof RateLimitError)) {
          throw error;
        }

        // If we've exhausted retries, throw the error
        if (attempt >= maxRetries) {
          console.error(`Rate limit: Max retries (${maxRetries}) exceeded`);
          throw lastError;
        }

        // Calculate exponential backoff delay
        const delayMs = Math.min(initialDelayMs * Math.pow(2, attempt), maxDelayMs);
        console.log(`Rate limit detected. Retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})...`);

        // Call onRetry callback if provided
        if (onRetry) {
          onRetry(attempt + 1, lastError);
        }

        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    // Should never reach here, but TypeScript needs it
    throw lastError;
  }

  /**
   * Run a task with file changes and automatic retry on rate limit errors
   * This is a wrapper around runTaskWithFileChanges that handles rate limiting
   * @param task - The task description/prompt
   * @param options - Retry options
   * @returns Execution result
   */
  async runTaskWithFileChangesAndRetry(
    task: string,
    options: RetryOptions = {}
  ): Promise<ClaudeResult> {
    const {
      maxRetries = 5,
      initialDelayMs = 1000,
      maxDelayMs = 60000,
      onRetry
    } = options;

    let lastError: Error | undefined;
    let attempt = 0;

    for (attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.runTaskWithFileChanges(task);
      } catch (error) {
        lastError = error as Error;

        // Only retry on RateLimitError
        if (!(error instanceof RateLimitError)) {
          throw error;
        }

        // If we've exhausted retries, throw the error
        if (attempt >= maxRetries) {
          console.error(`Rate limit: Max retries (${maxRetries}) exceeded`);
          throw lastError;
        }

        // Calculate exponential backoff delay
        const delayMs = Math.min(initialDelayMs * Math.pow(2, attempt), maxDelayMs);
        console.log(`Rate limit detected. Retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})...`);

        // Call onRetry callback if provided
        if (onRetry) {
          onRetry(attempt + 1, lastError);
        }

        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    // Should never reach here, but TypeScript needs it
    throw lastError;
  }
}

/**
 * Generate a unique session ID
 * @param component - Component type (director, em, worker)
 * @param issueNumber - GitHub issue number
 * @param componentId - Component ID (EM ID, Worker ID, etc.)
 * @returns Unique session ID
 */
export function generateSessionId(
  _component: 'director' | 'em' | 'worker',
  _issueNumber: number,
  ..._componentIds: number[]
): string {
  // Generate a valid UUID for Claude Code CLI
  return randomUUID();
}

/**
 * Parse a session ID to extract component information
 * @param sessionId - Session ID to parse
 * @returns Parsed session info
 */
export function parseSessionId(
  sessionId: string
): {
  component: string;
  issueNumber: number;
  componentIds: number[];
} | null {
  const parts = sessionId.split('-');

  if (parts.length < 3) {
    return null;
  }

  const component = parts[0];
  const issueNumber = parseInt(parts[1], 10);

  if (isNaN(issueNumber)) {
    return null;
  }

  // Remaining parts (except timestamp and random) are component IDs
  const componentIds: number[] = [];
  for (let i = 2; i < parts.length - 2; i++) {
    const id = parseInt(parts[i], 10);
    if (!isNaN(id)) {
      componentIds.push(id);
    }
  }

  return { component, issueNumber, componentIds };
}
