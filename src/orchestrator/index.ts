/**
 * Event-Driven Orchestrator
 * 
 * Handles GitHub events and manages state transitions.
 * Each invocation:
 * 1. Reads current state from .orchestrator/state.json
 * 2. Determines action based on event and state
 * 3. Executes action
 * 4. Updates state and exits
 */

import { GitHubClient } from '../shared/github.js';
import { GitOperations } from '../shared/git.js';
import { SDKRunner } from '../shared/sdk-runner.js';
import { ClaudeCodeRunner, generateSessionId } from '../shared/claude.js';
import { ConfigManager } from '../shared/config.js';
import { extractJson } from '../shared/json.js';
import { slugify, getDirectorBranch } from '../shared/branches.js';
import {
  OrchestratorState,
  EMState,
  createInitialState,
  areAllWorkersComplete,
  getNextPendingWorker
} from './state.js';
import { loadState, saveState, initializeState, findWorkBranchForIssue } from './persistence.js';
import type { ClaudeConfig } from '../shared/config.js';

export type EventType = 
  | 'issue_labeled'        // Start orchestration
  | 'push'                 // Code pushed to a branch
  | 'pull_request_opened'  // PR opened
  | 'pull_request_merged'  // PR merged
  | 'pull_request_review'  // Review submitted
  | 'workflow_dispatch'    // Manual trigger
  | 'schedule';            // Scheduled check

export interface OrchestratorEvent {
  type: EventType;
  issueNumber?: number;
  prNumber?: number;
  branch?: string;
  reviewState?: 'approved' | 'changes_requested' | 'commented';
  reviewBody?: string;
}

export interface OrchestratorContext {
  repo: { owner: string; name: string };
  token: string;
  configs: ClaudeConfig[];
  options?: {
    maxEms?: number;
    maxWorkersPerEm?: number;
    reviewWaitMinutes?: number;
    prLabel?: string;
  };
}

export class EventDrivenOrchestrator {
  private ctx: OrchestratorContext;
  private github: GitHubClient;
  private configManager: ConfigManager;
  private claude: ClaudeCodeRunner;
  private sdkRunner: SDKRunner;
  private state: OrchestratorState | null = null;

  constructor(ctx: OrchestratorContext) {
    this.ctx = ctx;
    this.github = new GitHubClient(ctx.token, { owner: ctx.repo.owner, repo: ctx.repo.name });
    this.configManager = ConfigManager.fromJSON(JSON.stringify(ctx.configs));

    const currentConfig = this.configManager.getCurrentConfig();
    const apiKey = currentConfig.apiKey || currentConfig.env?.ANTHROPIC_API_KEY || currentConfig.env?.ANTHROPIC_AUTH_TOKEN;

    this.claude = new ClaudeCodeRunner({
      apiKey,
      baseUrl: currentConfig.env?.ANTHROPIC_BASE_URL,
      model: currentConfig.model
    });

    this.sdkRunner = new SDKRunner({
      apiKey,
      baseUrl: currentConfig.env?.ANTHROPIC_BASE_URL,
      model: currentConfig.model,
      workDir: process.cwd()
    });
  }

  /**
   * Main entry point - handle an event
   */
  async handleEvent(event: OrchestratorEvent): Promise<void> {
    console.log(`\n=== Handling event: ${event.type} ===`);
    console.log(`Event details:`, JSON.stringify(event, null, 2));

    try {
      switch (event.type) {
        case 'issue_labeled':
          await this.handleIssueLabeled(event);
          break;
        case 'pull_request_merged':
          await this.handlePRMerged(event);
          break;
        case 'pull_request_review':
          await this.handlePRReview(event);
          break;
        case 'workflow_dispatch':
          // workflow_dispatch can either start new or continue existing
          if (event.issueNumber) {
            const existingBranch = await findWorkBranchForIssue(event.issueNumber);
            if (existingBranch) {
              await this.handleProgressCheck({ ...event, branch: existingBranch });
            } else {
              // No existing branch - start new orchestration
              await this.handleIssueLabeled(event);
            }
          } else {
            await this.handleProgressCheck(event);
          }
          break;
        case 'schedule':
          await this.handleProgressCheck(event);
          break;
        default:
          console.log(`Unhandled event type: ${event.type}`);
      }
    } catch (error) {
      console.error('Event handling failed:', error);
      if (this.state) {
        this.state.phase = 'failed';
        this.state.error = (error as Error).message;
        await saveState(this.state);
      }
      throw error;
    }
  }

  /**
   * Handle issue labeled - start new orchestration
   */
  private async handleIssueLabeled(event: OrchestratorEvent): Promise<void> {
    if (!event.issueNumber) {
      throw new Error('Issue number required for issue_labeled event');
    }

    // Check if orchestration already in progress
    const existingBranch = await findWorkBranchForIssue(event.issueNumber);
    if (existingBranch) {
      console.log(`Orchestration already in progress on branch: ${existingBranch}`);
      await this.handleProgressCheck({ ...event, branch: existingBranch });
      return;
    }

    // Get issue details
    const issue = await this.github.getIssue(event.issueNumber);
    console.log(`Starting orchestration for issue #${issue.number}: ${issue.title}`);

    // Create work branch name
    const slug = slugify(issue.title);
    const workBranch = getDirectorBranch(issue.number, slug);

    // Initialize state
    this.state = createInitialState({
      issue: { number: issue.number, title: issue.title, body: issue.body },
      repo: this.ctx.repo,
      workBranch,
      config: this.ctx.options
    });

    // Create work branch and save initial state
    await initializeState(this.state, workBranch);

    // Move to analysis phase
    await this.runAnalysis();
  }

  /**
   * Run director analysis to break down issue into EM tasks
   */
  private async runAnalysis(): Promise<void> {
    if (!this.state) throw new Error('No state');

    console.log('\n=== Phase: Director Analysis ===');
    this.state.phase = 'analyzing';
    await saveState(this.state);

    const { maxEms, maxWorkersPerEm } = this.state.config;

    const prompt = `You are a technical director analyzing a GitHub issue to break it down into tasks.

**Issue #${this.state.issue.number}: ${this.state.issue.title}**

${this.state.issue.body}

**Your task:**
1. First, determine if this project needs initial setup (gitignore, package.json, tsconfig, etc.)
2. Break this issue down into EM (Engineering Manager) tasks. Each EM focuses on a distinct area.
3. Provide a brief summary for the PR description.

**Important Guidelines:**
- If this is a new project, include a "Project Setup" EM (id: 0) that runs FIRST
- Project Setup EM should create: .gitignore, package.json, tsconfig.json, basic folder structure
- Other EMs should wait until setup is complete
- Scale team size based on complexity: simple tasks = 1-2 workers, complex = 2-3 workers
- EMs should have non-overlapping responsibilities

**Constraints:**
- Maximum ${maxEms} EMs (not counting setup)
- Each EM can have up to ${maxWorkersPerEm} Workers

**Output ONLY a JSON object (no other text):**
{
  "needs_setup": true,
  "summary": "Brief summary of the implementation plan for PR description",
  "ems": [
    {
      "em_id": 0,
      "task": "Set up project foundation with .gitignore, package.json, tsconfig.json",
      "focus_area": "Project Setup",
      "estimated_workers": 1,
      "must_complete_first": true
    },
    {
      "em_id": 1,
      "task": "Description of what this EM should accomplish",
      "focus_area": "e.g., Core Logic, UI, Testing",
      "estimated_workers": 2,
      "must_complete_first": false
    }
  ]
}`;

    const sessionId = generateSessionId('director', this.state.issue.number);
    const result = await this.claude.runTask(prompt, sessionId);

    if (!result.success) {
      throw new Error(`Director analysis failed: ${result.stderr}`);
    }

    const analysis = extractJson(result.stdout) as {
      needs_setup: boolean;
      summary: string;
      ems: Array<{
        em_id: number;
        task: string;
        focus_area: string;
        estimated_workers: number;
        must_complete_first?: boolean;
      }>;
    };

    if (!analysis.ems || !Array.isArray(analysis.ems) || analysis.ems.length === 0) {
      throw new Error('Director returned no EM tasks');
    }

    // Store summary for PR description
    this.state.analysisSummary = analysis.summary;

    // Check if we need project setup first
    const setupEM = analysis.ems.find(em => em.must_complete_first || em.focus_area === 'Project Setup');
    const otherEMs = analysis.ems.filter(em => !em.must_complete_first && em.focus_area !== 'Project Setup');

    if (setupEM) {
      // Run setup phase first
      this.state.projectSetup = { completed: false };
      this.state.phase = 'project_setup';

      // Create setup EM state
      this.state.ems = [{
        id: 0,
        task: setupEM.task,
        focusArea: 'Project Setup',
        branch: `cco/issue-${this.state.issue.number}-setup`,
        status: 'pending' as const,
        workers: [],
        reviewsAddressed: 0,
        startedAt: new Date().toISOString()
      }];

      // Store other EMs in state for later (after setup completes)
      this.state.pendingEMs = otherEMs.slice(0, maxEms).map((em, idx) => ({
        id: idx + 1,
        task: em.task,
        focusArea: em.focus_area,
        branch: `cco/issue-${this.state!.issue.number}-em-${idx + 1}`,
        status: 'pending' as const,
        workers: [],
        reviewsAddressed: 0
      }));

      console.log(`Project setup needed. ${this.state.pendingEMs.length} EMs queued after setup.`);
      await saveState(this.state, `chore: director starting project setup first (${this.state.pendingEMs.length} EMs pending)`);

      // Start setup EM
      await this.startNextEM();
    } else {
      // No setup needed, proceed normally
      this.state.ems = otherEMs.slice(0, maxEms).map((em, idx) => ({
        id: idx + 1,
        task: em.task,
        focusArea: em.focus_area,
        branch: `cco/issue-${this.state!.issue.number}-em-${idx + 1}`,
        status: 'pending' as const,
        workers: [],
        reviewsAddressed: 0,
        startedAt: new Date().toISOString()
      }));

      this.state.phase = 'em_assignment';
      await saveState(this.state, `chore: director assigned ${this.state.ems.length} EMs`);

      // Start first EM
      await this.startNextEM();
    }
  }

  /**
   * Start the next pending EM
   */
  private async startNextEM(): Promise<void> {
    if (!this.state) throw new Error('No state');

    const pendingEM = this.state.ems.find(em => em.status === 'pending');
    if (!pendingEM) {
      // All EMs have started, check if we need to create final PR
      await this.checkFinalMerge();
      return;
    }

    console.log(`\n=== Starting EM-${pendingEM.id}: ${pendingEM.focusArea} ===`);

    // Create EM branch
    await GitOperations.checkout(this.state.workBranch);
    await GitOperations.createBranch(pendingEM.branch, this.state.workBranch);
    await GitOperations.push(pendingEM.branch);

    // Break down into worker tasks
    const workerTasks = await this.breakdownEMTask(pendingEM);

    // Create worker states
    pendingEM.workers = workerTasks.map(wt => ({
      id: wt.worker_id,
      task: wt.task,
      files: wt.files,
      branch: `${pendingEM.branch}-w-${wt.worker_id}`,
      status: 'pending' as const,
      reviewsAddressed: 0
    }));

    pendingEM.status = 'workers_running';
    this.state.phase = 'worker_execution';
    await saveState(this.state, `chore: EM-${pendingEM.id} assigned ${workerTasks.length} workers`);

    // Start first worker
    await this.startNextWorker(pendingEM);
  }

  /**
   * Break down an EM task into worker tasks
   */
  private async breakdownEMTask(em: EMState): Promise<Array<{
    worker_id: number;
    task: string;
    files: string[];
  }>> {
    if (!this.state) throw new Error('No state');

    const { maxWorkersPerEm } = this.state.config;

    const prompt = `You are an Engineering Manager breaking down a task into worker assignments.

**Your EM Task:** ${em.task}
**Focus Area:** ${em.focusArea}

**Context - Original Issue:**
${this.state.issue.body}

**Constraints:**
- Maximum ${maxWorkersPerEm} workers
- Each task should be completable independently
- Specify which files each worker should create or modify
- Tasks should be concrete (e.g., "Create Calculator class with add/subtract methods")

**Output ONLY a JSON array (no other text):**
[
  {
    "worker_id": 1,
    "task": "Specific task description with implementation details",
    "files": ["path/to/file1.ts", "path/to/file2.ts"]
  }
]`;

    const sessionId = generateSessionId('em', this.state.issue.number, em.id);
    const result = await this.claude.runTask(prompt, sessionId);

    if (!result.success) {
      console.error(`EM-${em.id} breakdown failed: ${result.stderr}`);
      return [{ worker_id: 1, task: em.task, files: [] }];
    }

    try {
      const tasks = extractJson(result.stdout) as Array<{
        worker_id: number;
        task: string;
        files: string[];
      }>;
      return Array.isArray(tasks) && tasks.length > 0 
        ? tasks.slice(0, maxWorkersPerEm) 
        : [{ worker_id: 1, task: em.task, files: [] }];
    } catch {
      return [{ worker_id: 1, task: em.task, files: [] }];
    }
  }

  /**
   * Start the next pending worker for an EM
   */
  private async startNextWorker(em: EMState): Promise<void> {
    if (!this.state) throw new Error('No state');

    const pendingWorker = getNextPendingWorker(em);
    if (!pendingWorker) {
      // All workers done, create EM PR
      await this.createEMPullRequest(em);
      return;
    }

    console.log(`\n--- Starting Worker-${pendingWorker.id}: ${pendingWorker.task.substring(0, 50)}... ---`);

    // Create worker branch
    await GitOperations.checkout(em.branch);
    await GitOperations.createBranch(pendingWorker.branch, em.branch);

    pendingWorker.status = 'in_progress';
    pendingWorker.startedAt = new Date().toISOString();
    await saveState(this.state);

    // Execute worker task
    const prompt = `You are a developer implementing a specific task. Make the actual code changes.

**Your Task:** ${pendingWorker.task}

**Files to work with:** ${pendingWorker.files?.length > 0 ? pendingWorker.files.join(', ') : 'Create whatever files are needed'}

**Context - Original Issue:**
${this.state.issue.body}

**CRITICAL Instructions:**
1. Implement the task completely
2. Create or modify ONLY the necessary source code files
3. Write clean, production-ready TypeScript/JavaScript code
4. Include necessary imports and exports

**DO NOT create these files:**
- IMPLEMENTATION_SUMMARY.md or any summary/documentation files
- README.md (unless specifically asked)
- test files (unless specifically asked)
- Any files that explain what you did - just do the code

If this is a setup task, ensure you create:
- .gitignore with node_modules, dist, .env, etc.
- package.json with appropriate dependencies
- tsconfig.json if TypeScript is used

Implement this task now - code only, no documentation files.`;

    const result = await this.sdkRunner.executeTask(prompt);

    if (!result.success) {
      pendingWorker.status = 'pending'; // Reset to retry
      pendingWorker.error = result.error;
      await saveState(this.state);
      throw new Error(`Worker-${pendingWorker.id} failed: ${result.error}`);
    }

    // Commit and push
    const hasChanges = await GitOperations.hasUncommittedChanges();
    if (hasChanges) {
      await GitOperations.commitAndPush(
        `feat(em-${em.id}/worker-${pendingWorker.id}): ${pendingWorker.task.substring(0, 50)}`,
        pendingWorker.branch
      );
    } else {
      await GitOperations.push(pendingWorker.branch);
    }

    // Create worker PR
    const pr = await this.github.createPullRequest({
      title: `[EM-${em.id}/W-${pendingWorker.id}] ${pendingWorker.task.substring(0, 60)}`,
      body: `## Worker Implementation\n\n**Task:** ${pendingWorker.task}\n\n---\n*Automated by Claude Code Orchestrator*`,
      head: pendingWorker.branch,
      base: em.branch
    });

    // Add label to PR
    await this.github.addLabels(pr.number, [this.state.config.prLabel]);

    pendingWorker.status = 'pr_created';
    pendingWorker.prNumber = pr.number;
    pendingWorker.prUrl = pr.html_url;
    pendingWorker.completedAt = new Date().toISOString();

    this.state.phase = 'worker_review';
    await saveState(this.state, `chore: Worker-${pendingWorker.id} PR created (#${pr.number})`);

    console.log(`Worker-${pendingWorker.id} PR created: ${pr.html_url}`);

    // Continue with next worker or merge
    await this.startNextWorker(em);
  }

  /**
   * Create EM PR after all workers are done
   */
  private async createEMPullRequest(em: EMState): Promise<void> {
    if (!this.state) throw new Error('No state');

    // First merge all worker PRs
    console.log(`\nMerging worker PRs for EM-${em.id}...`);
    for (const worker of em.workers) {
      if (worker.prNumber && (worker.status === 'pr_created' || worker.status === 'approved')) {
        let result = await this.github.mergePullRequest(worker.prNumber);
        
        // If base branch was modified, try to update and retry
        if (!result.merged && result.error?.includes('Base branch modified')) {
          console.log(`  Updating Worker-${worker.id} PR #${worker.prNumber} branch...`);
          const updated = await this.github.updatePullRequestBranch(worker.prNumber);
          if (updated) {
            // Wait a moment for GitHub to process the update
            await new Promise(resolve => setTimeout(resolve, 2000));
            result = await this.github.mergePullRequest(worker.prNumber);
          }
        }
        
        if (result.merged) {
          worker.status = 'merged';
          console.log(`  Merged Worker-${worker.id} PR #${worker.prNumber}${result.alreadyMerged ? ' (was already merged)' : ''}`);
        } else {
          console.warn(`  Could not merge Worker-${worker.id} PR #${worker.prNumber}: ${result.error}`);
        }
      }
    }

    // Pull latest EM branch
    await GitOperations.checkout(em.branch);
    await GitOperations.pull(em.branch);

    // Create EM PR to work branch
    const pr = await this.github.createPullRequest({
      title: `[EM-${em.id}] ${em.focusArea}: ${em.task.substring(0, 50)}`,
      body: `## EM-${em.id}: ${em.focusArea}\n\n**Task:** ${em.task}\n\n**Workers:** ${em.workers.length}\n\n---\n*Automated by Claude Code Orchestrator*`,
      head: em.branch,
      base: this.state.workBranch
    });

    // Add label to PR
    await this.github.addLabels(pr.number, [this.state.config.prLabel]);

    em.status = 'pr_created';
    em.prNumber = pr.number;
    em.prUrl = pr.html_url;

    this.state.phase = 'em_review';
    await saveState(this.state, `chore: EM-${em.id} PR created (#${pr.number})`);

    console.log(`EM-${em.id} PR created: ${pr.html_url}`);

    // Start next EM if any
    await this.startNextEM();
  }

  /**
   * Check if ready for final merge
   */
  private async checkFinalMerge(): Promise<void> {
    if (!this.state) throw new Error('No state');

    // Check if all current EMs have PRs created or merged
    const allEMsReady = this.state.ems.every(em => 
      em.status === 'pr_created' || em.status === 'approved' || em.status === 'merged'
    );

    if (!allEMsReady) {
      console.log('Not all EMs are ready for final merge yet');
      return;
    }

    // If there are pending EMs (from setup phase), add them now and continue
    if (this.state.pendingEMs && this.state.pendingEMs.length > 0) {
      console.log(`\n=== Adding ${this.state.pendingEMs.length} pending EMs after setup ===`);
      
      // Merge setup EM first
      for (const em of this.state.ems) {
        if (em.prNumber && (em.status === 'pr_created' || em.status === 'approved')) {
          const result = await this.github.mergePullRequest(em.prNumber);
          if (result.merged) {
            em.status = 'merged';
            console.log(`Merged setup EM-${em.id} PR #${em.prNumber}`);
          }
        }
      }
      
      // Add pending EMs to the active list
      this.state.ems.push(...this.state.pendingEMs);
      this.state.pendingEMs = [];
      this.state.phase = 'em_assignment';
      
      await saveState(this.state, `chore: setup complete, adding ${this.state.ems.length - 1} implementation EMs`);
      
      // Start the next EM
      await this.startNextEM();
      return;
    }

    // Merge all EM PRs
    console.log('\n=== Merging EM PRs ===');
    for (const em of this.state.ems) {
      if (em.prNumber && (em.status === 'pr_created' || em.status === 'approved')) {
        const result = await this.github.mergePullRequest(em.prNumber);
        if (result.merged) {
          em.status = 'merged';
          console.log(`Merged EM-${em.id} PR #${em.prNumber}${result.alreadyMerged ? ' (was already merged)' : ''}`);
        } else {
          console.warn(`Could not merge EM-${em.id} PR #${em.prNumber}: ${result.error}`);
        }
      }
    }

    // Pull latest work branch
    await GitOperations.checkout(this.state.workBranch);
    await GitOperations.pull(this.state.workBranch);

    this.state.phase = 'final_merge';
    await saveState(this.state);

    // Create final PR to main
    await this.createFinalPR();
  }

  /**
   * Create the final PR to main
   */
  private async createFinalPR(): Promise<void> {
    if (!this.state) throw new Error('No state');

    console.log('\n=== Creating Final PR ===');

    // Build comprehensive PR body with analysis summary
    const summarySection = this.state.analysisSummary 
      ? `### Implementation Summary\n${this.state.analysisSummary}\n\n`
      : '';

    const body = `## Automated Implementation for Issue #${this.state.issue.number}

**Issue:** ${this.state.issue.title}

${summarySection}### Orchestration Details
- **EMs:** ${this.state.ems.length}
- **Total Workers:** ${this.state.ems.reduce((sum, em) => sum + em.workers.length, 0)}

### Task Breakdown
${this.state.ems.map(em => `
#### EM-${em.id}: ${em.focusArea}
${em.task}
- Workers: ${em.workers.length}
${em.workers.map(w => `  - Worker-${w.id}: ${w.task.substring(0, 60)}...`).join('\n')}
`).join('\n')}

---
Closes #${this.state.issue.number}

*Automated by Claude Code Orchestrator*`;

    const pr = await this.github.createPullRequest({
      title: `feat: ${this.state.issue.title}`,
      body,
      head: this.state.workBranch,
      base: this.state.baseBranch
    });

    // Add label to final PR
    await this.github.addLabels(pr.number, [this.state.config.prLabel]);

    this.state.finalPr = { number: pr.number, url: pr.html_url, reviewsAddressed: 0 };
    this.state.phase = 'final_review';  // Wait for final review
    await saveState(this.state, `chore: final PR created (#${pr.number})`);

    // Post comment on issue
    await this.github.updateIssueComment(this.state.issue.number,
      `## Orchestration Complete\n\nFinal PR: #${pr.number}\n${pr.html_url}\n\nThe PR will respond to code review feedback automatically.\n\n---\n*Automated by Claude Code Orchestrator*`
    );

    console.log(`Final PR created: ${pr.html_url}`);
  }

  /**
   * Handle PR merged event
   */
  private async handlePRMerged(event: OrchestratorEvent): Promise<void> {
    if (!event.prNumber || !event.branch) {
      console.log('PR merged event missing prNumber or branch');
      return;
    }

    // Find work branch from PR branch name
    const workBranch = await this.findWorkBranchFromPRBranch(event.branch);
    if (!workBranch) {
      console.log('Could not find work branch for merged PR');
      return;
    }

    // Load state
    this.state = await this.loadStateFromWorkBranch(workBranch);
    if (!this.state) {
      console.log('No state found for work branch');
      return;
    }

    // Update state based on which PR was merged
    for (const em of this.state.ems) {
      // Check if it's a worker PR
      for (const worker of em.workers) {
        if (worker.prNumber === event.prNumber) {
          worker.status = 'merged';
          console.log(`Worker-${worker.id} PR merged`);
        }
      }

      // Check if it's an EM PR
      if (em.prNumber === event.prNumber) {
        em.status = 'merged';
        console.log(`EM-${em.id} PR merged`);
      }
    }

    await saveState(this.state);

    // Check if we should proceed
    await this.handleProgressCheck(event);
  }

  /**
   * Handle PR review event
   */
  private async handlePRReview(event: OrchestratorEvent): Promise<void> {
    if (!event.prNumber || !event.branch) {
      console.log('PR review event: missing prNumber or branch');
      return;
    }

    // Only act on changes_requested or commented (for Copilot reviews with comments)
    if (event.reviewState !== 'changes_requested' && event.reviewState !== 'commented') {
      console.log(`PR review event: state is ${event.reviewState}, no action needed`);
      return;
    }

    // For 'commented' reviews, check if there's actual actionable feedback
    if (event.reviewState === 'commented' && (!event.reviewBody || event.reviewBody.length < 20)) {
      console.log('PR review event: commented but no substantial feedback');
      return;
    }

    // Find work branch
    const workBranch = await this.findWorkBranchFromPRBranch(event.branch);
    if (!workBranch) return;

    // Load state
    this.state = await this.loadStateFromWorkBranch(workBranch);
    if (!this.state) return;

    // Check if this is the final PR
    if (this.state.finalPr?.number === event.prNumber) {
      console.log('Addressing review on final PR');
      await this.addressFinalPRReview(event.prNumber, event.reviewBody || '');
      return;
    }

    // Find the worker or EM that owns this PR
    for (const em of this.state.ems) {
      for (const worker of em.workers) {
        if (worker.prNumber === event.prNumber) {
          console.log(`Addressing review on Worker-${worker.id} PR`);
          await this.addressReview(worker.branch, event.prNumber, event.reviewBody || '');
          worker.reviewsAddressed++;
          worker.status = 'pr_created';
          await saveState(this.state);
          return;
        }
      }

      if (em.prNumber === event.prNumber) {
        console.log(`Addressing review on EM-${em.id} PR`);
        await this.addressReview(em.branch, event.prNumber, event.reviewBody || '');
        em.reviewsAddressed++;
        em.status = 'pr_created';
        await saveState(this.state);
        return;
      }
    }
  }

  /**
   * Address review feedback on a branch (worker/EM PRs)
   */
  private async addressReview(branch: string, prNumber: number, reviewBody: string): Promise<void> {
    await GitOperations.checkout(branch);

    // Also fetch review comments from the PR for more context
    const reviewComments = await this.github.getPullRequestComments(prNumber);
    const commentContext = reviewComments.length > 0 
      ? `\n\n**Inline Review Comments:**\n${reviewComments.map(c => `- ${c.path}:${c.line}: ${c.body}`).join('\n')}`
      : '';

    const prompt = `A code reviewer has provided feedback on this PR. Please address ALL the issues mentioned.

**Review Feedback:**
${reviewBody}${commentContext}

**Instructions:**
1. Address each point raised in the review
2. Make the necessary code changes
3. DO NOT create documentation files - just fix the code
4. Be thorough - address ALL comments, not just some

Make the changes now.`;

    const result = await this.sdkRunner.executeTask(prompt);

    if (result.success) {
      const hasChanges = await GitOperations.hasUncommittedChanges();
      if (hasChanges) {
        await GitOperations.commitAndPush('fix: address review feedback', branch);
        console.log('Review feedback addressed and pushed');
      } else {
        console.log('No changes needed to address review');
      }
    }
  }

  /**
   * Address review feedback on the final PR
   */
  private async addressFinalPRReview(prNumber: number, reviewBody: string): Promise<void> {
    if (!this.state) throw new Error('No state');

    await GitOperations.checkout(this.state.workBranch);

    // Fetch review comments
    const reviewComments = await this.github.getPullRequestComments(prNumber);
    const commentContext = reviewComments.length > 0 
      ? `\n\n**Inline Review Comments:**\n${reviewComments.map(c => `- ${c.path}:${c.line}: ${c.body}`).join('\n')}`
      : '';

    const prompt = `A code reviewer has provided feedback on the final PR. Please address ALL the issues mentioned.

**Review Feedback:**
${reviewBody}${commentContext}

**Instructions:**
1. Address each point raised in the review
2. Make the necessary code changes across any files that need fixing
3. DO NOT create documentation files - just fix the code
4. Be thorough - address ALL comments

Make the changes now.`;

    const result = await this.sdkRunner.executeTask(prompt);

    if (result.success) {
      const hasChanges = await GitOperations.hasUncommittedChanges();
      if (hasChanges) {
        await GitOperations.commitAndPush('fix: address final PR review feedback', this.state.workBranch);
        this.state.finalPr!.reviewsAddressed = (this.state.finalPr!.reviewsAddressed || 0) + 1;
        await saveState(this.state);
        console.log('Final PR review feedback addressed and pushed');
      } else {
        console.log('No changes needed to address final PR review');
      }
    }
  }

  /**
   * Handle progress check - continue any pending work
   */
  private async handleProgressCheck(event: OrchestratorEvent): Promise<void> {
    const branch = event.branch || (event.issueNumber ? await findWorkBranchForIssue(event.issueNumber) : null);
    if (!branch) {
      console.log('No work branch found for progress check');
      return;
    }

    this.state = await this.loadStateFromWorkBranch(branch);
    if (!this.state) {
      console.log('No state found');
      return;
    }

    console.log(`Current phase: ${this.state.phase}`);

    switch (this.state.phase) {
      case 'initialized':
        await this.runAnalysis();
        break;
      case 'analyzing':
        console.log('Analysis in progress...');
        break;
      case 'project_setup':
        // Continue with setup phase - treat it like worker execution
        await this.continueWorkerExecution();
        break;
      case 'em_assignment':
      case 'worker_execution':
        await this.continueWorkerExecution();
        break;
      case 'worker_review':
      case 'em_review':
      case 'final_review':
        await this.checkAndMergePRs();
        break;
      case 'em_merging':
      case 'final_merge':
        await this.checkFinalMerge();
        break;
      case 'complete':
        console.log('Orchestration already complete');
        break;
      case 'failed':
        console.log('Orchestration failed, manual intervention needed');
        break;
    }
  }

  /**
   * Continue worker execution
   */
  private async continueWorkerExecution(): Promise<void> {
    if (!this.state) return;

    for (const em of this.state.ems) {
      if (em.status === 'pending' || em.status === 'workers_running') {
        const pendingWorker = getNextPendingWorker(em);
        if (pendingWorker) {
          await this.startNextWorker(em);
          return;
        } else if (areAllWorkersComplete(em)) {
          await this.createEMPullRequest(em);
          return;
        }
      }
    }

    // All EMs done with workers
    await this.checkFinalMerge();
  }

  /**
   * Check if PRs can be merged
   */
  private async checkAndMergePRs(): Promise<void> {
    if (!this.state) return;

    for (const em of this.state.ems) {
      // Try to merge approved worker PRs
      for (const worker of em.workers) {
        if (worker.status === 'approved' && worker.prNumber) {
          const result = await this.github.mergePullRequest(worker.prNumber);
          if (result.merged) {
            worker.status = 'merged';
          } else {
            console.warn(`Could not merge worker PR #${worker.prNumber}: ${result.error}`);
          }
        }
      }

      // If all workers merged, create EM PR if not exists
      if (areAllWorkersComplete(em) && !em.prNumber) {
        await this.createEMPullRequest(em);
      }

      // Try to merge approved EM PRs
      if (em.status === 'approved' && em.prNumber) {
        const result = await this.github.mergePullRequest(em.prNumber);
        if (result.merged) {
          em.status = 'merged';
        } else {
          console.warn(`Could not merge EM PR #${em.prNumber}: ${result.error}`);
        }
      }
    }

    await saveState(this.state);
    await this.checkFinalMerge();
  }

  /**
   * Find work branch from a PR branch name
   */
  private async findWorkBranchFromPRBranch(prBranch: string): Promise<string | null> {
    // Branch patterns:
    // Worker: cco/issue-123-em-1-w-1
    // EM: cco/issue-123-em-1
    // Work: cco/123-slug
    const match = prBranch.match(/cco\/issue-(\d+)/);
    if (match) {
      return await findWorkBranchForIssue(parseInt(match[1], 10));
    }
    return null;
  }

  /**
   * Load state from a work branch
   */
  private async loadStateFromWorkBranch(branch: string): Promise<OrchestratorState | null> {
    await GitOperations.checkout(branch);
    await GitOperations.pull(branch);
    return await loadState();
  }
}
