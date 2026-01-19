/**
 * Worker component
 * Executes a specific task using Claude Code CLI
 */

import { GitHubClient } from '../shared/github.js';
import { readWorkerState, writeWorkerState, WorkerState } from '../shared/state.js';
import { ClaudeCodeRunner, generateSessionId } from '../shared/claude.js';
import { GitOperations } from '../shared/git.js';
import { ConfigManager } from '../shared/config.js';
import type { ClaudeConfig } from '../shared/config.js';

// Worker context passed from workflow
export interface WorkerContext {
  repo: {
    owner: string;
    repo: string;
  };
  token: string;
  issue: {
    number: number;
  };
  emId: number;
  workerId: number;
  taskAssignment: string;
  emBranch: string;
  configs: ClaudeConfig[];
  resume: boolean;
  sessionId?: string;
  options?: {
    maxRetries?: number;
  };
}

/**
 * Worker class
 */
export class Worker {
  private context: WorkerContext;
  private github: GitHubClient;
  private configManager: ConfigManager;
  private claude: ClaudeCodeRunner;
  private state: WorkerState | null = null;

  constructor(context: WorkerContext) {
    this.context = context;
    this.github = new GitHubClient(context.token, context.repo);

    // Initialize config manager
    this.configManager = ConfigManager.fromJSON(
      JSON.stringify(context.configs)
    );

    // Initialize Claude runner with current config
    const currentConfig = this.configManager.getCurrentConfig();
    this.claude = new ClaudeCodeRunner({
      apiKey: currentConfig.apiKey || currentConfig.env?.ANTHROPIC_API_KEY || currentConfig.env?.ANTHROPIC_AUTH_TOKEN,
      baseUrl: currentConfig.env?.ANTHROPIC_BASE_URL,
      model: currentConfig.model
    });
  }

  /**
   * Run the Worker task
   */
  async run(): Promise<void> {
    try {
      // Step 1: Load or initialize state
      await this.loadOrCreateState();

      // Step 2: Create Worker branch
      await this.createWorkerBranch();

      // Step 3: Execute task with Claude Code
      await this.executeTask();

      // Step 4: Generate changes summary
      await this.generateChangesSummary();

      // Step 5: Commit and push changes
      await this.commitAndPush();

      // Step 6: Create PR to EM branch
      await this.createWorkerPR();

      console.log('Worker task completed successfully');
    } catch (error) {
      console.error('Worker failed:', error);
      await this.handleError(error as Error);
      throw error;
    }
  }

  /**
   * Resume Worker session (e.g., after review feedback)
   */
  async resume(sessionId: string, feedback: string): Promise<void> {
    try {
      this.state = await readWorkerState(this.context.emId, this.context.workerId);
      if (!this.state) {
        throw new Error('No state found to resume');
      }

      console.log('Resuming Worker session with feedback:', feedback);

      // Resume Claude session with feedback
      const result = await this.claude.resumeSession(sessionId, feedback);

      if (!result.success) {
        throw new Error(`Failed to resume session: ${result.stderr}`);
      }

      // Update changes
      await this.generateChangesSummary();
      await this.commitAndPush();

      console.log('Worker resumed and updated successfully');
    } catch (error) {
      console.error('Worker resume failed:', error);
      await this.handleError(error as Error);
      throw error;
    }
  }

  /**
   * Load existing state or create new state
   */
  private async loadOrCreateState(): Promise<void> {
    this.state = await readWorkerState(this.context.emId, this.context.workerId);

    if (this.state) {
      console.log('Resuming existing Worker state');
      return;
    }

    const workerBranch = `cco/${this.context.issue.number}-${this.context.workerId}`;

    const sessionId = generateSessionId(
      'worker',
      this.context.issue.number,
      this.context.emId,
      this.context.workerId
    );

    this.state = {
      worker_id: this.context.workerId,
      em_id: this.context.emId,
      status: 'in_progress',
      session_id: sessionId,
      branch: workerBranch,
      pr_number: null,
      updated_at: new Date().toISOString(),
      task_assignment: this.context.taskAssignment,
      changes_summary: '',
      files_modified: [],
      retry_count: 0
    };

    await writeWorkerState(this.context.emId, this.context.workerId, this.state);
    console.log('Created new Worker state');
  }

  /**
   * Create Worker branch
   */
  private async createWorkerBranch(): Promise<void> {
    if (!this.state) {
      throw new Error('State not initialized');
    }

    console.log('Creating Worker branch:', this.state.branch);

    try {
      // Checkout EM branch first
      await GitOperations.checkoutBranch(this.context.emBranch);

      // Create and checkout Worker branch
      await GitOperations.createBranch(this.state.branch, this.context.emBranch);
      console.log('Worker branch created successfully');
    } catch (error) {
      throw new Error(`Failed to create Worker branch: ${(error as Error).message}`);
    }
  }

  /**
   * Execute task with Claude Code
   */
  private async executeTask(): Promise<void> {
    if (!this.state) {
      throw new Error('State not initialized');
    }

    console.log('Executing task with Claude Code...');

    // Update heartbeat before long-running task to prevent false stall detection
    this.state.updated_at = new Date().toISOString();
    await writeWorkerState(this.context.emId, this.context.workerId, this.state);

    const maxRetries = this.context.options?.maxRetries || 2;
    let attempt = 0;

    while (attempt <= maxRetries) {
      try {
        const prompt = this.buildTaskPrompt();

        const sessionId = this.state.session_id;
        if (!sessionId) {
          throw new Error('Session ID is required');
        }

        const result = await this.claude.runTask(
          prompt,
          sessionId
        );

        if (!result.success) {
          throw new Error(`Claude execution failed: ${result.stderr}`);
        }

        console.log('Task executed successfully');
        return;
      } catch (error) {
        const errorMessage = (error as Error).message;

        // Check for rate limit
        if (errorMessage.includes('rate limit')) {
          console.log('Rate limit hit, rotating config...');
          const newConfig = this.configManager.rotateOnRateLimit();
          this.claude.updateConfig({
            apiKey: newConfig.apiKey || newConfig.env?.ANTHROPIC_API_KEY,
            baseUrl: newConfig.env?.ANTHROPIC_BASE_URL,
            model: newConfig.model
          });

          // Retry with same attempt count
          continue;
        }

        // Check if we should retry
        if (attempt < maxRetries) {
          console.log(`Task failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying...`);
          attempt++;
          this.state.retry_count = attempt;
          await writeWorkerState(
            this.context.emId,
            this.context.workerId,
            this.state
          );
          continue;
        }

        throw error;
      }
    }
  }

  /**
   * Build the task prompt for Claude Code
   */
  private buildTaskPrompt(): string {
    return `You are a Worker tasked with implementing a specific feature or fix.

**Your Task:**
${this.context.taskAssignment}

**Instructions:**
1. Analyze the codebase to understand the context
2. Implement the required changes
3. Ensure your code follows best practices and existing patterns
4. Test your changes if applicable
5. Commit your changes with a clear commit message

**Important:**
- Make minimal, focused changes
- Don't modify files outside the scope of your task
- Write clear, concise code
- Add comments for complex logic

Start working on this task now.`;
  }

  /**
   * Generate summary of changes
   */
  private async generateChangesSummary(): Promise<void> {
    if (!this.state) {
      return;
    }

    try {
      const modifiedFiles = await GitOperations.getModifiedFiles();
      this.state.files_modified = modifiedFiles;

      if (modifiedFiles.length > 0) {
        const sessionId = this.state.session_id;
        if (!sessionId) {
          this.state.changes_summary = 'Various code changes based on task requirements.';
          return;
        }

        const summary = await this.claude.generateChangesSummary(
          sessionId,
          modifiedFiles
        );

        this.state.changes_summary = summary;
      } else {
        this.state.changes_summary = 'No files were modified.';
      }
    } catch (error) {
      console.error('Failed to generate changes summary:', error);
      this.state.changes_summary = 'Various code changes based on task requirements.';
    }

    this.state.updated_at = new Date().toISOString();
    await writeWorkerState(this.context.emId, this.context.workerId, this.state);
  }

  /**
   * Commit and push changes
   */
  private async commitAndPush(): Promise<void> {
    if (!this.state) {
      throw new Error('State not initialized');
    }

    console.log('Committing and pushing changes...');

    try {
      // Check if there are changes to commit
      const hasChanges = await GitOperations.hasUncommittedChanges();

      if (!hasChanges) {
        console.log('No changes to commit');
        return;
      }

      const commitMessage = `Worker-${this.context.workerId}: ${this.context.taskAssignment.split('\n')[0].substring(0, 72)}`;

      await GitOperations.commitAndPush(commitMessage);

      console.log('Changes committed and pushed successfully');
    } catch (error) {
      throw new Error(`Failed to commit and push: ${(error as Error).message}`);
    }
  }

  /**
   * Create Worker PR to EM branch
   */
  private async createWorkerPR(): Promise<void> {
    if (!this.state) {
      throw new Error('State not initialized');
    }

    console.log('Creating Worker PR to EM branch...');

    try {
      const pr = await this.github.createPullRequest({
        title: `Worker-${this.context.workerId}: ${this.context.taskAssignment.split('\n')[0].substring(0, 60)}`,
        body: this.buildPRBody(),
        head: this.state.branch,
        base: this.context.emBranch
      });

      console.log('Worker PR created:', pr.html_url);

      // Update state
      this.state.pr_number = pr.number;
      this.state.status = 'complete';
      this.state.updated_at = new Date().toISOString();
      await writeWorkerState(this.context.emId, this.context.workerId, this.state);
    } catch (error) {
      throw new Error(`Failed to create Worker PR: ${(error as Error).message}`);
    }
  }

  /**
   * Build the PR body
   */
  private buildPRBody(): string {
    return `## 🤖 Worker-${this.context.workerId} Automated PR

**Task:**
${this.context.taskAssignment}

### Changes Summary

${this.state?.changes_summary || 'No summary available.'}

### Modified Files

${this.state?.files_modified.map(f => `- \`${f}\``).join('\n') || 'No files modified.'}

### Session Information

**Session ID:** \`${this.state?.session_id || 'N/A'}\`

This PR was created automatically by Worker-${this.context.workerId}. The EM will review and merge these changes.

---

*This PR was created automatically by Worker-${this.context.workerId} as part of the [Claude Code Orchestrator](https://github.com/anthropics/claude-code-orchestrator-action)*`;
  }

  /**
   * Handle an error during execution
   */
  private async handleError(_error: Error): Promise<void> {
    if (this.state) {
      this.state.status = 'failed';
      this.state.updated_at = new Date().toISOString();
      await writeWorkerState(this.context.emId, this.context.workerId, this.state);
    }

    // Add failure label to issue
    await this.github.addLabels(this.context.issue.number, [
      `worker-${this.context.emId}-${this.context.workerId}-failed`
    ]);
  }
}
