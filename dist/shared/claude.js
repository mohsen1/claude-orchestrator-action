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
    constructor(message) {
        super(message);
        this.name = 'RateLimitError';
    }
}
/**
 * Manages execution of Claude Code CLI
 */
export class ClaudeCodeRunner {
    config;
    constructor(options = {}) {
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
    async runTask(task, _sessionId) {
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
        }
        catch (error) {
            const errorMessage = error.message;
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
    async runTaskWithFileChanges(task) {
        const env = this.buildEnv();
        const timeoutMs = parseInt(process.env.API_TIMEOUT_MS || '600000', 10);
        console.log(`Running Claude CLI (with file changes) with timeout: ${timeoutMs}ms`);
        console.log(`API base URL: ${env.ANTHROPIC_BASE_URL || 'default'}`);
        console.log(`Task length: ${task.length} chars`);
        try {
            const args = [
                '--dangerously-skip-permissions',
                '--output-format', 'text',
                '--verbose',
                '-p',
                task
            ];
            console.log(`Claude CLI args: --dangerously-skip-permissions --output-format text --verbose -p [task]`);
            const result = await execa('claude', args, {
                env,
                timeout: timeoutMs,
                reject: false
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
            }
            else {
                console.log('Claude CLI completed successfully');
                console.log('stdout (first 500 chars):', result.stdout.substring(0, 500));
            }
            return {
                success: result.exitCode === 0,
                stdout: result.stdout,
                stderr: result.stderr,
                exitCode: result.exitCode ?? null
            };
        }
        catch (error) {
            const errorMessage = error.message;
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
    async resumeSession(sessionId, prompt) {
        const env = this.buildEnv();
        const timeoutMs = parseInt(process.env.API_TIMEOUT_MS || '300000', 10);
        try {
            const result = await execa('claude', ['-p', '--resume', sessionId, '--output-format', 'text', prompt], {
                env,
                timeout: timeoutMs,
                reject: false
            });
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
        }
        catch (error) {
            return {
                success: false,
                stdout: '',
                stderr: error.message,
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
    async resolveConflicts(sessionId, conflictFiles, targetBranch) {
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
    async generateChangesSummary(sessionId, filesModified) {
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
    async reviewPullRequest(sessionId, prDescription, context) {
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
    checkRateLimit(stdout, stderr) {
        const output = `${stdout} ${stderr}`.toLowerCase();
        if (output.includes('rate limit') ||
            output.includes('rate_limit') ||
            output.includes('429') ||
            output.includes('too many requests')) {
            throw new RateLimitError('Rate limit exceeded');
        }
    }
    /**
     * Build environment variables for Claude Code execution
     */
    buildEnv() {
        const env = {
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
    updateConfig(options) {
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
    getConfig() {
        return { ...this.config };
    }
}
/**
 * Generate a unique session ID
 * @param component - Component type (director, em, worker)
 * @param issueNumber - GitHub issue number
 * @param componentId - Component ID (EM ID, Worker ID, etc.)
 * @returns Unique session ID
 */
export function generateSessionId(_component, _issueNumber, ..._componentIds) {
    // Generate a valid UUID for Claude Code CLI
    return randomUUID();
}
/**
 * Parse a session ID to extract component information
 * @param sessionId - Session ID to parse
 * @returns Parsed session info
 */
export function parseSessionId(sessionId) {
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
    const componentIds = [];
    for (let i = 2; i < parts.length - 2; i++) {
        const id = parseInt(parts[i], 10);
        if (!isNaN(id)) {
            componentIds.push(id);
        }
    }
    return { component, issueNumber, componentIds };
}
//# sourceMappingURL=claude.js.map