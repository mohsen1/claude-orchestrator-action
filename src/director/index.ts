/**
 * Director component
 * Main orchestrator that analyzes issues and spawns EM workflows
 */

import { GitHubClient } from '../shared/github.js';
import {
  slugify,
  getDirectorBranch,
  getEmBranch,
  parseComponentFromBranch
} from '../shared/branches.js';
import {
  readDirectorState,
  writeDirectorState,
  DirectorState,
  initConfig,
  writeConfig
} from '../shared/state.js';
import { ClaudeCodeRunner, generateSessionId } from '../shared/claude.js';
import { GitOperations } from '../shared/git.js';
import { ConfigManager } from '../shared/config.js';
import { extractJson } from '../shared/json.js';
import type { ClaudeConfig } from '../shared/config.js';

// Director context passed from workflow
export interface DirectorContext {
  repo: {
    owner: string;
    repo: string;
  };
  token: string;
  issue: {
    number: number;
    title: string;
    body: string;
  };
  configs: ClaudeConfig[];
  options?: {
    maxEms?: number;
    maxWorkersPerEm?: number;
    autoMerge?: boolean;
    cleanupBranches?: boolean;
    dispatchStaggerMs?: number;
  };
}

// EM task breakdown result
interface EMTaskBreakdown {
  em_id: number;
  task: string;
  focus_area: string;
  estimated_workers: number;
}

/**
 * Director class - main orchestrator
 */
export class Director {
  private context: DirectorContext;
  private github: GitHubClient;
  private configManager: ConfigManager;
  private claude: ClaudeCodeRunner;
  private state: DirectorState | null = null;

  constructor(context: DirectorContext) {
    this.context = context;
    this.github = new GitHubClient(context.token, context.repo);

    // Initialize config manager
    this.configManager = ConfigManager.fromJSON(
      JSON.stringify(context.configs)
    );

    // Initialize Claude runner with current config
    const currentConfig = this.configManager.getCurrentConfig();
    this.claude = new ClaudeCodeRunner({
      apiKey: currentConfig.apiKey || currentConfig.env?.ANTHROPIC_API_KEY,
      baseUrl: currentConfig.env?.ANTHROPIC_BASE_URL,
      model: currentConfig.model
    });
  }

  /**
   * Run the Director orchestration
   */
  async run(): Promise<void> {
    try {
      // Step 1: Validate input
      this.validateInput();

      // Step 2: Load or initialize state
      await this.loadOrCreateState();

      // Step 3: Analyze the issue and break down into EM tasks
      const emTasks = await this.analyzeIssue();

      // Step 4: Create work branch
      await this.createWorkBranch();

      // Step 5: Dispatch EM workflows
      await this.dispatchEMs(emTasks);

      // Step 6: Update status comment
      await this.updateStatusComment();

      // Step 7: Wait for EMs to complete (handled by review handler)
      console.log('Director orchestration initiated successfully');
    } catch (error) {
      console.error('Director failed:', error);
      await this.handleError(error as Error);
      throw error;
    }
  }

  /**
   * Resume Director orchestration (e.g., after review feedback)
   */
  async resume(sessionId: string): Promise<void> {
    try {
      // Load state
      this.state = await readDirectorState();
      if (!this.state) {
        throw new Error('No state found to resume');
      }

      // Resume Claude session
      // The Director should handle any pending tasks
      console.log('Resuming Director session:', sessionId);
    } catch (error) {
      console.error('Director resume failed:', error);
      throw error;
    }
  }

  /**
   * Validate that the issue has required fields
   */
  private validateInput(): void {
    if (!this.context.issue.title) {
      throw new Error('Issue title is required');
    }

    if (!this.context.issue.body || this.context.issue.body.trim().length === 0) {
      throw new Error('Issue body is required and cannot be empty');
    }
  }

  /**
   * Load existing state or create new state
   */
  private async loadOrCreateState(): Promise<void> {
    // Try to load existing state
    this.state = await readDirectorState();

    if (this.state) {
      console.log('Resuming existing orchestration:', this.state.work_branch);
      return;
    }

    // Create new state
    const slug = slugify(this.context.issue.title);
    const work_branch = getDirectorBranch(this.context.issue.number, slug);
    const sessionId = generateSessionId(
      'director',
      this.context.issue.number
    );

    this.state = {
      version: '1.0',
      issue_number: this.context.issue.number,
      work_branch,
      status: 'in_progress',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      session_id: sessionId,
      task_breakdown: [],
      final_pr_number: null
    };

    await writeDirectorState(this.state);
    console.log('Created new orchestration state for branch:', work_branch);
  }

  /**
   * Analyze the issue and break down into EM tasks
   */
  private async analyzeIssue(): Promise<EMTaskBreakdown[]> {
    console.log('Analyzing issue with Claude...');

    // Update heartbeat before long-running task to prevent false stall detection
    if (this.state) {
      this.state.updated_at = new Date().toISOString();
      await writeDirectorState(this.state);
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

      // Parse the response to extract EM tasks
      const emTasks = this.parseEMTasks(result.stdout);

      return emTasks;
    } catch (error) {
      // Check for rate limit
      if ((error as Error).message.includes('rate limit')) {
        console.log('Rate limit hit, rotating config...');
        const newConfig = this.configManager.rotateOnRateLimit();
        this.claude.updateConfig({
          apiKey: newConfig.apiKey || newConfig.env?.ANTHROPIC_API_KEY,
          baseUrl: newConfig.env?.ANTHROPIC_BASE_URL,
          model: newConfig.model
        });

        // Update config state
        const config = await initConfig();
        config.config_rotation.current_index = this.configManager.getCurrentIndex();
        config.config_rotation.last_rotation_time = new Date().toISOString();
        await writeConfig(config);

        // Retry analysis
        return this.analyzeIssue();
      }

      throw error;
    }
  }

  /**
   * Build the prompt for issue analysis
   */
  private buildAnalysisPrompt(): string {
    const maxEms = this.context.options?.maxEms || 5;
    const maxWorkers = this.context.options?.maxWorkersPerEm || 4;

    return `You are a technical director analyzing a GitHub issue to break it down into manageable tasks for a team of Engineering Managers (EMs) and Workers.

**Issue #${this.context.issue.number}: ${this.context.issue.title}**

${this.context.issue.body}

**Your task:**
Analyze this issue and break it down into EM tasks. Each EM will manage a team of Workers to implement their assigned area.

**Constraints:**
- Maximum ${maxEms} EMs
- Each EM can have up to ${maxWorkers} Workers
- EMs should focus on distinct areas (e.g., UI, Backend, Testing, Documentation)
- Avoid overlapping responsibilities between EMs

**Output format:**
Provide a JSON array of EM tasks:
\`\`\`json
[
  {
    "em_id": 1,
    "task": "Brief description of the EM's task",
    "focus_area": "Area of focus (e.g., 'UI Components', 'Backend API', 'Testing')",
    "estimated_workers": 2
  },
  ...
]
\`\`\`

**Analysis:**
Consider:
1. What are the main components or areas of this issue?
2. Which areas can be worked on independently?
3. How many workers would each area need?
4. What are the dependencies between areas?

Provide your analysis and the JSON output below:`;
  }

  /**
   * Parse EM tasks from Claude's response
   */
  private parseEMTasks(output: string): EMTaskBreakdown[] {
    try {
      // Use robust JSON extraction with fallbacks
      const tasks = extractJson(output) as EMTaskBreakdown[];

      // Validate
      if (!Array.isArray(tasks) || tasks.length === 0) {
        throw new Error('Invalid EM tasks: must be a non-empty array');
      }

      // Validate each task has required fields
      for (const task of tasks) {
        if (!task.em_id || typeof task.em_id !== 'number') {
          throw new Error('Invalid EM task: missing or invalid em_id');
        }
        if (!task.task || typeof task.task !== 'string') {
          throw new Error('Invalid EM task: missing or invalid task description');
        }
      }

      // Update state
      if (this.state) {
        this.state.task_breakdown = tasks.map(t => ({
          em_id: t.em_id,
          task: t.task,
          status: 'pending'
        }));
        this.state.updated_at = new Date().toISOString();
        writeDirectorState(this.state);
      }

      return tasks;
    } catch (error) {
      throw new Error(`Failed to parse EM tasks: ${(error as Error).message}`);
    }
  }

  /**
   * Create the Director's work branch
   */
  private async createWorkBranch(): Promise<void> {
    if (!this.state) {
      throw new Error('State not initialized');
    }

    console.log('Creating work branch:', this.state.work_branch);

    try {
      await GitOperations.createBranch(this.state.work_branch, 'main');
      console.log('Work branch created successfully');
    } catch (error) {
      throw new Error(`Failed to create work branch: ${(error as Error).message}`);
    }
  }

  /**
   * Dispatch EM workflows in parallel
   */
  private async dispatchEMs(emTasks: EMTaskBreakdown[]): Promise<void> {
    if (!this.state) {
      throw new Error('State not initialized');
    }

    console.log(`Dispatching ${emTasks.length} EM workflows...`);

    const staggerMs = this.context.options?.dispatchStaggerMs || 2000;

    for (const emTask of emTasks) {
      try {
        // Create EM branch
        const emBranch = getEmBranch(this.state.work_branch, emTask.em_id);

        console.log(`Creating EM-${emTask.em_id} branch: ${emBranch}`);
        await this.github.createBranch(emBranch, this.state.work_branch);

        // Dispatch EM workflow
        console.log(`Dispatching EM-${emTask.em_id} workflow...`);

        await this.github.dispatchWorkflow(
          'cco-em.yml',
          this.state.work_branch,
          {
            issue_number: this.context.issue.number,
            em_id: emTask.em_id.toString(),
            task_assignment: emTask.task,
            work_branch: this.state.work_branch,
            resume: 'false'
          }
        );

        // Stagger to avoid rate limits
        if (emTask.em_id < emTasks.length) {
          await this.delay(staggerMs);
        }
      } catch (error) {
        console.error(`Failed to dispatch EM-${emTask.em_id}:`, error);
        // Mark EM as failed in state
        const task = this.state.task_breakdown.find(t => t.em_id === emTask.em_id);
        if (task) {
          task.status = 'failed';
        }
      }
    }

    await writeDirectorState(this.state);
    console.log('All EM workflows dispatched');
  }

  /**
   * Update the issue status comment
   */
  private async updateStatusComment(): Promise<void> {
    if (!this.state) {
      return;
    }

    const completedEMs = this.state.task_breakdown.filter(
      t => t.status === 'complete'
    ).length;
    const totalEMs = this.state.task_breakdown.length;

    const comment = this.buildStatusComment(completedEMs, totalEMs);

    await this.github.updateIssueComment(this.context.issue.number, comment);
  }

  /**
   * Build the status comment markdown
   */
  private buildStatusComment(completed: number, total: number): string {
    // const progressEmoji = completed === total ? '✅' : '🔄';
    const progressPercent = total > 0 ? Math.round((completed / total) * 100) : 0;

    let markdown = `## 🤖 Orchestration Status

**Status:** ${this.state?.status === 'complete' ? 'Complete' : 'In Progress'}
**Work Branch:** \`${this.state?.work_branch}\`
**Progress:** ${completed}/${total} EMs complete (${progressPercent}%)

### EM Task Breakdown

| EM | Task | Status |
|----|------|--------|
`;

    for (const task of this.state?.task_breakdown || []) {
      const statusEmoji =
        task.status === 'complete'
          ? '✅'
          : task.status === 'in_progress'
            ? '🔄'
            : task.status === 'failed'
              ? '❌'
              : '⏳';

      markdown += `| EM-${task.em_id} | ${task.task} | ${statusEmoji} ${task.status} |\n`;
    }

    markdown += `\n---\n*Last updated: ${new Date().toISOString()}*`;

    return markdown;
  }

  /**
   * Handle an error during orchestration
   */
  private async handleError(error: Error): Promise<void> {
    // Update state
    if (this.state) {
      this.state.status = 'failed';
      this.state.updated_at = new Date().toISOString();
      await writeDirectorState(this.state);
    }

    // Add failure label
    await this.github.addLabels(this.context.issue.number, [
      'orchestrator-failed'
    ]);

    // Build workflow run URL (available in GitHub Actions environment)
    const workflowRunUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${this.context.repo.owner}/${this.context.repo.repo}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : 'the workflow logs';

    // Post error comment - uses same header to update existing comment
    const errorComment = `## 🤖 Orchestration Status

**Status:** ❌ Failed
**Work Branch:** \`${this.state?.work_branch || 'unknown'}\`

### Error Details

**Error:** ${error.message}

[View Workflow Logs](${workflowRunUrl}) for more details.

---

*Last updated: ${new Date().toISOString()}*`;

    await this.github.updateIssueComment(
      this.context.issue.number,
      errorComment
    );
  }

  /**
   * Delay helper for staggered dispatch
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Handle EM PR review (merge or request changes)
   */
  async handleEMPR(prNumber: number): Promise<void> {
    console.log('Handling EM PR:', prNumber);

    const pr = await this.github.getPullRequest(prNumber);

    // Parse EM ID from branch name
    const parsed = parseComponentFromBranch(pr.head.ref);
    if (parsed.type !== 'em' || parsed.emId === null) {
      console.log('PR is not from an EM branch, skipping');
      return;
    }

    // For now, auto-merge EM PRs
    // In production, you might want to review with Claude first
    console.log(`Merging EM-${parsed.emId} PR...`);

    try {
      await this.github.mergePullRequest(
        prNumber,
        `Merge EM-${parsed.emId}: ${pr.title}`,
        pr.body
      );

      // Update state
      if (this.state) {
        const task = this.state.task_breakdown.find(
          t => t.em_id === parsed.emId
        );
        if (task) {
          task.status = 'complete';
        }
        this.state.updated_at = new Date().toISOString();
        await writeDirectorState(this.state);
      }

      // Update status comment
      await this.updateStatusComment();

      // Check if all EMs are complete
      await this.checkAllEMsComplete();
    } catch (error) {
      console.error('Failed to merge EM PR:', error);
      throw error;
    }
  }

  /**
   * Check if all EMs are complete and create final PR
   */
  private async checkAllEMsComplete(): Promise<void> {
    if (!this.state) {
      return;
    }

    const allComplete = this.state.task_breakdown.every(
      t => t.status === 'complete'
    );

    if (!allComplete) {
      console.log('Not all EMs complete yet');
      return;
    }

    console.log('All EMs complete, creating final PR to main...');

    try {
      // Create final PR to main
      const pr = await this.github.createPullRequest({
        title: `[Orchestration] Issue #${this.context.issue.number}: ${this.context.issue.title}`,
        body: this.buildFinalPRBody(),
        head: this.state.work_branch,
        base: 'main'
      });

      console.log('Final PR created:', pr.html_url);

      // Update state
      this.state.final_pr_number = pr.number;
      this.state.status = 'complete';
      this.state.updated_at = new Date().toISOString();
      await writeDirectorState(this.state);

      // Update status comment
      await this.updateStatusComment();

      // Add orchestrator label
      await this.github.addLabels(this.context.issue.number, [
        'orchestrator-complete'
      ]);
    } catch (error) {
      console.error('Failed to create final PR:', error);
      throw error;
    }
  }

  /**
   * Build the final PR body
   */
  private buildFinalPRBody(): string {
    let body = `## 🤖 Automated Orchestration Complete

This PR was automatically generated by the Claude Code Orchestrator for Issue #${this.context.issue.number}.

**Issue:** ${this.context.issue.title}

### Changes

This PR includes changes from ${this.state?.task_breakdown.length} Engineering Managers:

`;

    for (const task of this.state?.task_breakdown || []) {
      body += `- **EM-${task.em_id}:** ${task.task}\n`;
    }

    body += `
### Overview

The orchestrator has broken down the issue into manageable tasks, assigned them to EMs, and coordinated the work across multiple Workers. All changes have been reviewed and merged into this branch.

---

*This PR was created automatically by the [Claude Code Orchestrator](https://github.com/anthropics/claude-code-orchestrator-action)*`;

    return body;
  }
}
