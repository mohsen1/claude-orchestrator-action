/**
 * Engineering Manager (EM) component
 * Manages Workers for a specific task area
 */

import { GitHubClient } from '../shared/github.js';
import { getWorkerBranch, parseComponentFromBranch } from '../shared/branches.js';
import { readEmState, writeEmState, EMState } from '../shared/state.js';
import { ClaudeCodeRunner, generateSessionId } from '../shared/claude.js';
import { GitOperations } from '../shared/git.js';
import { ConfigManager } from '../shared/config.js';
import { extractJson } from '../shared/json.js';
import type { ClaudeConfig } from '../shared/config.js';

// EM context passed from workflow
export interface EMContext {
  repo: {
    owner: string;
    repo: string;
  };
  token: string;
  issue: {
    number: number;
  };
  emId: number;
  taskAssignment: string;
  workBranch: string;
  configs: ClaudeConfig[];
  resume: boolean;
  sessionId?: string;
  options?: {
    maxWorkers?: number;
    dispatchStaggerMs?: number;
  };
}

// Worker task breakdown
interface WorkerTask {
  worker_id: number;
  task: string;
  description: string;
  files: string[];
}

/**
 * Engineering Manager class
 */
export class EngineeringManager {
  private context: EMContext;
  private github: GitHubClient;
  private configManager: ConfigManager;
  private claude: ClaudeCodeRunner;
  private state: EMState | null = null;

  constructor(context: EMContext) {
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
   * Run the EM orchestration
   */
  async run(): Promise<void> {
    try {
      // Step 1: Load or initialize state
      await this.loadOrCreateState();

      // Step 2: Create EM branch
      await this.createEMBranch();

      // Step 3: Analyze task and break down into worker tasks
      const workerTasks = await this.analyzeTask();

      // Step 4: Dispatch Worker workflows
      await this.dispatchWorkers(workerTasks);

      console.log('EM orchestration initiated successfully');
    } catch (error) {
      console.error('EM failed:', error);
      await this.handleError(error as Error);
      throw error;
    }
  }

  /**
   * Resume EM session (e.g., after review feedback)
   */
  async resume(sessionId: string): Promise<void> {
    try {
      this.state = await readEmState(this.context.emId);
      if (!this.state) {
        throw new Error('No state found to resume');
      }

      // Resume Claude session with feedback
      console.log('Resuming EM session:', sessionId);
    } catch (error) {
      console.error('EM resume failed:', error);
      throw error;
    }
  }

  /**
   * Load existing state or create new state
   */
  private async loadOrCreateState(): Promise<void> {
    this.state = await readEmState(this.context.emId);

    if (this.state) {
      console.log('Resuming existing EM state');
      return;
    }

    const emBranch = getWorkerBranch(this.context.workBranch, this.context.emId).replace(
      /-w\d+$/,
      ''
    );

    const sessionId = generateSessionId(
      'em',
      this.context.issue.number,
      this.context.emId
    );

    this.state = {
      em_id: this.context.emId,
      status: 'in_progress',
      session_id: sessionId,
      branch: emBranch,
      pr_number: null,
      updated_at: new Date().toISOString(),
      task_assignment: this.context.taskAssignment,
      changes_summary: '',
      files_modified: [],
      workers: []
    };

    await writeEmState(this.context.emId, this.state);
    console.log('Created new EM state');
  }

  /**
   * Create EM branch
   */
  private async createEMBranch(): Promise<void> {
    if (!this.state) {
      throw new Error('State not initialized');
    }

    console.log('Creating EM branch:', this.state.branch);

    try {
      // Checkout work branch first
      await GitOperations.checkoutBranch(this.context.workBranch);

      // Create and checkout EM branch
      await GitOperations.createBranch(this.state.branch, this.context.workBranch);
      console.log('EM branch created successfully');
    } catch (error) {
      throw new Error(`Failed to create EM branch: ${(error as Error).message}`);
    }
  }

  /**
   * Analyze the EM task and break down into worker tasks
   */
  private async analyzeTask(): Promise<WorkerTask[]> {
    console.log('Analyzing EM task with Claude...');

    // Update heartbeat before long-running task to prevent false stall detection
    if (this.state) {
      this.state.updated_at = new Date().toISOString();
      await writeEmState(this.context.emId, this.state);
    }

    const prompt = this.buildAnalysisPrompt();

    try {
      const sessionId = this.state!.session_id;
      if (!sessionId) {
        throw new Error('Session ID is required');
      }

      const result = await this.claude.runTask(
        prompt,
        sessionId
      );

      if (!result.success) {
        throw new Error(`Claude analysis failed: ${result.stderr}`);
      }

      // Parse the response to extract worker tasks
      const workerTasks = this.parseWorkerTasks(result.stdout);

      return workerTasks;
    } catch (error) {
      if ((error as Error).message.includes('rate limit')) {
        console.log('Rate limit hit, rotating config...');
        const newConfig = this.configManager.rotateOnRateLimit();
        this.claude.updateConfig({
          apiKey: newConfig.apiKey || newConfig.env?.ANTHROPIC_API_KEY,
          baseUrl: newConfig.env?.ANTHROPIC_BASE_URL,
          model: newConfig.model
        });

        return this.analyzeTask();
      }

      throw error;
    }
  }

  /**
   * Build the prompt for task analysis
   */
  private buildAnalysisPrompt(): string {
    const maxWorkers = this.context.options?.maxWorkers || 4;

    return `You are an Engineering Manager (EM) responsible for breaking down a task into Worker-sized units.

**Your Task:** ${this.context.taskAssignment}

**Your role:**
Break this task down into specific, actionable sub-tasks that can be assigned to individual Workers. Each worker should be able to complete their task independently with minimal coordination.

**Constraints:**
- Maximum ${maxWorkers} Workers
- Workers should focus on specific files or components
- Avoid overlapping work between Workers
- Each task should be clear and actionable

**Output format:**
Provide a JSON array of Worker tasks:
\`\`\`json
[
  {
    "worker_id": 1,
    "task": "Brief description of what the worker should do",
    "description": "Detailed instructions for the worker",
    "files": ["file1.ts", "file2.ts"]
  },
  ...
]
\`\`\`

**Analysis:**
Consider:
1. What are the logical sub-components of this task?
2. Which files or areas need to be modified?
3. What tasks can be done in parallel?
4. What are the dependencies between tasks?

Provide your analysis and the JSON output below:`;
  }

  /**
   * Parse Worker tasks from Claude's response
   */
  private parseWorkerTasks(output: string): WorkerTask[] {
    try {
      // Use robust JSON extraction with fallbacks
      const tasks = extractJson(output) as WorkerTask[];

      // Validate
      if (!Array.isArray(tasks) || tasks.length === 0) {
        throw new Error('Invalid Worker tasks: must be a non-empty array');
      }

      // Validate each task has required fields
      for (const task of tasks) {
        if (!task.worker_id || typeof task.worker_id !== 'number') {
          throw new Error('Invalid Worker task: missing or invalid worker_id');
        }
        if (!task.task || typeof task.task !== 'string') {
          throw new Error('Invalid Worker task: missing or invalid task description');
        }
      }

      // Update state
      if (this.state) {
        this.state.workers = tasks.map(t => ({
          worker_id: t.worker_id,
          task: t.task,
          status: 'pending'
        }));
        this.state.updated_at = new Date().toISOString();
        writeEmState(this.context.emId, this.state);
      }

      return tasks;
    } catch (error) {
      throw new Error(`Failed to parse Worker tasks: ${(error as Error).message}`);
    }
  }

  /**
   * Dispatch Worker workflows in parallel
   */
  private async dispatchWorkers(workerTasks: WorkerTask[]): Promise<void> {
    if (!this.state) {
      throw new Error('State not initialized');
    }

    console.log(`Dispatching ${workerTasks.length} Worker workflows...`);

    const staggerMs = this.context.options?.dispatchStaggerMs || 2000;

    for (const workerTask of workerTasks) {
      try {
        // Create Worker branch
        const workerBranch = getWorkerBranch(
          this.state.branch,
          workerTask.worker_id
        );

        console.log(`Creating Worker-${workerTask.worker_id} branch: ${workerBranch}`);
        await this.github.createBranch(workerBranch, this.state.branch);

        // Dispatch Worker workflow
        console.log(`Dispatching Worker-${workerTask.worker_id} workflow...`);

        const fullTask = `${workerTask.task}\n\n${workerTask.description}`;

        await this.github.dispatchWorkflow(
          'cco-worker.yml',
          this.state.branch,
          {
            issue_number: this.context.issue.number.toString(),
            em_id: this.context.emId.toString(),
            worker_id: workerTask.worker_id.toString(),
            task_assignment: fullTask,
            em_branch: this.state.branch,
            resume: 'false'
          }
        );

        // Stagger to avoid rate limits
        if (workerTask.worker_id < workerTasks.length) {
          await this.delay(staggerMs);
        }
      } catch (error) {
        console.error(`Failed to dispatch Worker-${workerTask.worker_id}:`, error);
        // Mark Worker as failed in state
        const worker = this.state.workers.find(
          w => w.worker_id === workerTask.worker_id
        );
        if (worker) {
          worker.status = 'failed';
        }
      }
    }

    await writeEmState(this.context.emId, this.state);
    console.log('All Worker workflows dispatched');
  }

  /**
   * Handle Worker PR review
   */
  async handleWorkerPR(prNumber: number): Promise<void> {
    console.log('Handling Worker PR:', prNumber);

    const pr = await this.github.getPullRequest(prNumber);

    // Parse Worker ID from branch name
    const parsed = parseComponentFromBranch(pr.head.ref);
    if (parsed.type !== 'worker' || parsed.workerId === null) {
      console.log('PR is not from a Worker branch, skipping');
      return;
    }

    // Check if this Worker belongs to this EM
    if (parsed.emId !== this.context.emId) {
      console.log('PR is not from this EM, skipping');
      return;
    }

    console.log(`Merging Worker-${parsed.workerId} PR...`);

    try {
      await this.github.mergePullRequest(
        prNumber,
        `Merge Worker-${parsed.workerId}: ${pr.title}`,
        pr.body
      );

      // Update state
      if (this.state) {
        const worker = this.state.workers.find(
          w => w.worker_id === parsed.workerId
        );
        if (worker) {
          worker.status = 'complete';
        }
        this.state.updated_at = new Date().toISOString();
        await writeEmState(this.context.emId, this.state);
      }

      // Check if all Workers are complete
      await this.checkAllWorkersComplete();
    } catch (error) {
      console.error('Failed to merge Worker PR:', error);
      throw error;
    }
  }

  /**
   * Check if all Workers are complete and create EM PR
   */
  private async checkAllWorkersComplete(): Promise<void> {
    if (!this.state) {
      return;
    }

    const allComplete = this.state.workers.every(w => w.status === 'complete');

    if (!allComplete) {
      console.log('Not all Workers complete yet');
      return;
    }

    console.log('All Workers complete, creating EM PR to Director branch...');

    try {
      // Generate changes summary
      await this.generateChangesSummary();

      // Create PR to Director branch
      const pr = await this.github.createPullRequest({
        title: `EM-${this.context.emId}: ${this.context.taskAssignment}`,
        body: this.buildPRBody(),
        head: this.state.branch,
        base: this.context.workBranch
      });

      console.log('EM PR created:', pr.html_url);

      // Update state
      this.state.pr_number = pr.number;
      this.state.status = 'complete';
      this.state.updated_at = new Date().toISOString();
      await writeEmState(this.context.emId, this.state);
    } catch (error) {
      console.error('Failed to create EM PR:', error);
      throw error;
    }
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
    } catch (error) {
      console.error('Failed to generate changes summary:', error);
      this.state.changes_summary = 'Various code changes based on task requirements.';
    }
  }

  /**
   * Build the PR body
   */
  private buildPRBody(): string {
    let body = `## 🤖 EM-${this.context.emId} Automated PR

**Task:** ${this.context.taskAssignment}

### Changes Summary

${this.state?.changes_summary || 'No summary available.'}

### Modified Files

${this.state?.files_modified.map(f => `- \`${f}\``).join('\n') || 'No files listed.'}

### Workers

This PR includes work from ${this.state?.workers.length || 0} Workers:

`;

    for (const worker of this.state?.workers || []) {
      const statusEmoji =
        worker.status === 'complete'
          ? '✅'
          : worker.status === 'failed'
            ? '❌'
            : '⏳';
      body += `- ${statusEmoji} **Worker-${worker.worker_id}:** ${worker.task}\n`;
    }

    body += `
---

*This PR was created automatically by EM-${this.context.emId} as part of the [Claude Code Orchestrator](https://github.com/anthropics/claude-code-orchestrator-action)*`;

    return body;
  }

  /**
   * Handle an error during orchestration
   */
  private async handleError(_error: Error): Promise<void> {
    if (this.state) {
      this.state.status = 'failed';
      this.state.updated_at = new Date().toISOString();
      await writeEmState(this.context.emId, this.state);
    }

    // Add failure label to issue
    await this.github.addLabels(this.context.issue.number, [
      `em-${this.context.emId}-failed`
    ]);
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
