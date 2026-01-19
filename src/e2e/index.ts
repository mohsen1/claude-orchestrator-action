/**
 * End-to-end orchestrator with hierarchical PR structure
 * 
 * Branch/PR Hierarchy:
 * main
 *   └── cco/issue-X-slug (Director's work branch)
 *         ├── cco/issue-X-em-1 (EM-1's branch)
 *         │     ├── cco/issue-X-em-1-w-1 → PR to EM-1 branch
 *         │     └── cco/issue-X-em-1-w-2 → PR to EM-1 branch
 *         │     └── EM-1 PR → work branch
 *         └── cco/issue-X-em-2 (EM-2's branch)
 *               └── Workers → PRs to EM-2
 *               └── EM-2 PR → work branch
 *         └── Final PR: work branch → main
 */

import { GitHubClient } from '../shared/github.js';
import { slugify, getDirectorBranch } from '../shared/branches.js';
import { ClaudeCodeRunner, generateSessionId } from '../shared/claude.js';
import { SDKRunner } from '../shared/sdk-runner.js';
import { GitOperations } from '../shared/git.js';
import { ConfigManager } from '../shared/config.js';
import { extractJson } from '../shared/json.js';
import type { ClaudeConfig } from '../shared/config.js';

export interface E2EContext {
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
    reviewWaitMinutes?: number;
  };
}

interface EMTask {
  em_id: number;
  task: string;
  focus_area: string;
  estimated_workers: number;
}

interface WorkerTask {
  worker_id: number;
  task: string;
  files: string[];
}

interface WorkerResult {
  emId: number;
  workerId: number;
  success: boolean;
  error?: string;
  filesModified: string[];
  branch: string;
  prNumber?: number;
  prUrl?: string;
}

interface EMResult {
  emId: number;
  focusArea: string;
  success: boolean;
  workerResults: WorkerResult[];
  branch: string;
  prNumber?: number;
  prUrl?: string;
}

export class E2EOrchestrator {
  private context: E2EContext;
  private github: GitHubClient;
  private configManager: ConfigManager;
  private claude: ClaudeCodeRunner;
  private sdkRunner: SDKRunner;
  private workBranch: string = '';
  private issueSlug: string = '';

  constructor(context: E2EContext) {
    this.context = context;
    this.github = new GitHubClient(context.token, context.repo);
    this.configManager = ConfigManager.fromJSON(JSON.stringify(context.configs));

    const currentConfig = this.configManager.getCurrentConfig();
    const apiKey = currentConfig.apiKey || currentConfig.env?.ANTHROPIC_API_KEY || currentConfig.env?.ANTHROPIC_AUTH_TOKEN;

    // For analysis tasks (read-only, uses CLI print mode)
    this.claude = new ClaudeCodeRunner({
      apiKey,
      baseUrl: currentConfig.env?.ANTHROPIC_BASE_URL,
      model: currentConfig.model
    });

    // For worker tasks (file modifications, uses SDK)
    this.sdkRunner = new SDKRunner({
      apiKey,
      baseUrl: currentConfig.env?.ANTHROPIC_BASE_URL,
      model: currentConfig.model,
      workDir: process.cwd()
    });
  }

  async run(): Promise<void> {
    console.log('Starting E2E Orchestration with Hierarchical PRs...');
    console.log(`Issue #${this.context.issue.number}: ${this.context.issue.title}`);

    try {
      // Step 1: Create work branch (Director's branch)
      await this.createWorkBranch();

      // Step 2: Analyze issue and get EM tasks
      console.log('\n=== Phase 1: Director Analysis ===');
      const emTasks = await this.analyzeIssue();
      console.log(`Director identified ${emTasks.length} EM tasks`);

      // Step 3: Process each EM with their own branch and worker PRs
      const emResults: EMResult[] = [];
      
      for (const emTask of emTasks) {
        console.log(`\n=== Phase 2: EM-${emTask.em_id} - ${emTask.focus_area} ===`);
        const emResult = await this.processEM(emTask);
        emResults.push(emResult);
      }

      // Step 4: Create final PR from work branch to main
      console.log('\n=== Phase 3: Creating Final PR ===');
      const finalPr = await this.createFinalPR(emTasks, emResults);
      console.log(`Final PR created: ${finalPr.html_url}`);

      // Step 5: Update issue with success status
      await this.postSuccessComment(finalPr, emResults);

      console.log('\nE2E Orchestration completed successfully!');
    } catch (error) {
      console.error('E2E Orchestration failed:', error);
      await this.postFailureComment(error as Error);
      throw error;
    }
  }

  private async createWorkBranch(): Promise<void> {
    this.issueSlug = slugify(this.context.issue.title);
    this.workBranch = getDirectorBranch(this.context.issue.number, this.issueSlug);
    
    console.log(`Creating work branch: ${this.workBranch}`);
    
    await GitOperations.createBranch(this.workBranch, 'main');
    await GitOperations.push(this.workBranch);
    
    console.log('Work branch created and pushed');
  }

  private getEMBranch(emId: number): string {
    return `cco/issue-${this.context.issue.number}-em-${emId}`;
  }

  private getWorkerBranch(emId: number, workerId: number): string {
    return `cco/issue-${this.context.issue.number}-em-${emId}-w-${workerId}`;
  }

  private async processEM(emTask: EMTask): Promise<EMResult> {
    const emBranch = this.getEMBranch(emTask.em_id);
    
    // Create EM branch from work branch
    console.log(`Creating EM branch: ${emBranch}`);
    await GitOperations.checkout(this.workBranch);
    await GitOperations.createBranch(emBranch, this.workBranch);
    await GitOperations.push(emBranch);

    // Get worker tasks for this EM
    const workerTasks = await this.breakdownEMTask(emTask);
    console.log(`EM-${emTask.em_id} assigned ${workerTasks.length} worker tasks`);

    // Process each worker with their own branch and PR
    const workerResults: WorkerResult[] = [];
    
    for (const workerTask of workerTasks) {
      console.log(`\n--- Worker-${workerTask.worker_id}: ${workerTask.task.substring(0, 50)}... ---`);
      const workerResult = await this.processWorker(emTask.em_id, emBranch, workerTask);
      workerResults.push(workerResult);
      
      if (workerResult.success) {
        console.log(`Worker-${workerTask.worker_id} PR created: ${workerResult.prUrl}`);
      } else {
        console.error(`Worker-${workerTask.worker_id} failed: ${workerResult.error}`);
      }
    }

    // Wait for reviews and handle them before merging
    const reviewWaitMinutes = this.context.options?.reviewWaitMinutes ?? 5;
    await this.waitForReviewsAndMerge(workerResults, reviewWaitMinutes);

    // Pull latest EM branch after merges
    await GitOperations.checkout(emBranch);
    await GitOperations.pull(emBranch);

    // Create EM PR to work branch
    const emPr = await this.createEMPullRequest(emTask, emBranch, workerResults);

    return {
      emId: emTask.em_id,
      focusArea: emTask.focus_area,
      success: workerResults.some(r => r.success),
      workerResults,
      branch: emBranch,
      prNumber: emPr.number,
      prUrl: emPr.html_url
    };
  }

  private async processWorker(emId: number, emBranch: string, workerTask: WorkerTask): Promise<WorkerResult> {
    const workerBranch = this.getWorkerBranch(emId, workerTask.worker_id);
    
    try {
      // Create worker branch from EM branch
      console.log(`Creating worker branch: ${workerBranch}`);
      await GitOperations.checkout(emBranch);
      await GitOperations.createBranch(workerBranch, emBranch);

      // Execute the task
      const prompt = this.buildWorkerPrompt(workerTask);
      const result = await this.sdkRunner.executeTask(prompt);

      if (!result.success) {
        return {
          emId,
          workerId: workerTask.worker_id,
          success: false,
          error: result.error || 'Unknown error',
          filesModified: [],
          branch: workerBranch
        };
      }

      // Commit and push changes
      const hasChanges = await GitOperations.hasUncommittedChanges();
      if (hasChanges) {
        await GitOperations.commitAndPush(
          `feat(em-${emId}/worker-${workerTask.worker_id}): ${workerTask.task.substring(0, 50)}\n\nAutomated implementation by Claude Code Orchestrator`,
          workerBranch
        );
      } else {
        // Push branch even if no changes (for PR creation)
        await GitOperations.push(workerBranch);
      }

      // Get modified files
      const filesModified = await GitOperations.getModifiedFiles();

      // Create PR from worker branch to EM branch
      const pr = await this.createWorkerPullRequest(emId, workerTask, workerBranch, emBranch, filesModified);

      console.log(`Worker output (first 200 chars): ${result.output.substring(0, 200)}`);

      return {
        emId,
        workerId: workerTask.worker_id,
        success: true,
        filesModified,
        branch: workerBranch,
        prNumber: pr.number,
        prUrl: pr.html_url
      };
    } catch (error) {
      return {
        emId,
        workerId: workerTask.worker_id,
        success: false,
        error: (error as Error).message,
        filesModified: [],
        branch: workerBranch
      };
    }
  }

  private buildWorkerPrompt(workerTask: WorkerTask): string {
    return `You are a developer implementing a specific task. Make the actual code changes.

**Your Task:** ${workerTask.task}

**Files to work with:** ${workerTask.files.length > 0 ? workerTask.files.join(', ') : 'Create whatever files are needed'}

**Context - Original Issue:**
${this.context.issue.body}

**Instructions:**
1. Implement the task completely
2. Create or modify the necessary files
3. Write clean, production-ready code
4. Include necessary imports and exports
5. Do NOT create test files unless specifically asked

Implement this task now.`;
  }

  /**
   * Wait for the configured review period, handle any reviews, then merge PRs
   */
  private async waitForReviewsAndMerge(workerResults: WorkerResult[], reviewWaitMinutes: number): Promise<void> {
    const successfulWorkers = workerResults.filter(w => w.success && w.prNumber);
    
    if (successfulWorkers.length === 0) {
      console.log('No successful worker PRs to merge');
      return;
    }

    console.log(`\n=== Review Period: ${reviewWaitMinutes} minutes ===`);
    console.log(`Waiting for human reviews on ${successfulWorkers.length} worker PRs...`);
    console.log('PRs open for review:');
    for (const worker of successfulWorkers) {
      console.log(`  - Worker-${worker.workerId}: PR #${worker.prNumber} (${worker.prUrl})`);
    }

    const reviewWaitMs = reviewWaitMinutes * 60 * 1000;
    const pollIntervalMs = 30 * 1000; // Check every 30 seconds
    const startTime = Date.now();
    const handledReviews = new Set<string>(); // Track handled reviews to avoid duplicates

    while (Date.now() - startTime < reviewWaitMs) {
      const elapsedMinutes = Math.floor((Date.now() - startTime) / 60000);
      const remainingMinutes = reviewWaitMinutes - elapsedMinutes;
      console.log(`\n[${elapsedMinutes}m/${reviewWaitMinutes}m] Checking for reviews... (${remainingMinutes}m remaining)`);

      // Check each worker PR for reviews
      for (const worker of successfulWorkers) {
        if (!worker.prNumber) continue;

        try {
          const reviews = await this.github.getPullRequestReviews(worker.prNumber);
          
          for (const review of reviews) {
            const reviewKey = `${worker.prNumber}-${review.id}`;
            
            if (handledReviews.has(reviewKey)) continue;
            handledReviews.add(reviewKey);

            console.log(`  Review on PR #${worker.prNumber} by ${review.user}: ${review.state}`);

            if (review.state === 'CHANGES_REQUESTED') {
              console.log(`  Addressing requested changes...`);
              await this.handleReviewChangesRequested(worker, review.body);
            } else if (review.state === 'APPROVED') {
              console.log(`  PR #${worker.prNumber} approved by ${review.user}`);
            } else if (review.state === 'COMMENTED' && review.body) {
              console.log(`  Comment: "${review.body.substring(0, 100)}..."`);
              // Optionally respond to comments
            }
          }

          // Also check for inline review comments
          const comments = await this.github.getPullRequestComments(worker.prNumber);
          for (const comment of comments) {
            const commentKey = `${worker.prNumber}-comment-${comment.id}`;
            
            if (handledReviews.has(commentKey)) continue;
            handledReviews.add(commentKey);

            console.log(`  Inline comment on ${comment.path} by ${comment.user}`);
            await this.handleInlineComment(worker, comment);
          }
        } catch (error) {
          console.error(`  Error checking reviews for PR #${worker.prNumber}:`, error);
        }
      }

      // Wait before next poll
      if (Date.now() - startTime < reviewWaitMs) {
        await this.sleep(pollIntervalMs);
      }
    }

    console.log(`\n=== Review period ended ===`);
    console.log('Merging worker PRs...');

    // Merge all successful worker PRs
    for (const worker of successfulWorkers) {
      if (!worker.prNumber) continue;
      
      try {
        console.log(`Merging Worker-${worker.workerId} PR #${worker.prNumber}`);
        await this.github.mergePullRequest(worker.prNumber);
      } catch (error) {
        console.error(`Failed to merge Worker PR #${worker.prNumber}:`, error);
      }
    }
  }

  /**
   * Handle a review that requests changes
   */
  private async handleReviewChangesRequested(worker: WorkerResult, reviewBody: string): Promise<void> {
    if (!reviewBody || !worker.prNumber) return;

    try {
      // Checkout the worker branch
      await GitOperations.checkout(worker.branch);

      // Create a prompt for the worker to address the review
      const prompt = `A code reviewer has requested changes on your PR. Please address the following feedback:

**Review Feedback:**
${reviewBody}

**Your previous implementation is in the current branch.**

Please make the necessary changes to address the reviewer's feedback. Be thorough and ensure the changes align with the review comments.`;

      console.log(`  Running Claude to address review feedback...`);
      const result = await this.sdkRunner.executeTask(prompt);

      if (result.success) {
        // Commit and push the changes
        const hasChanges = await GitOperations.hasUncommittedChanges();
        if (hasChanges) {
          await GitOperations.commitAndPush(
            `fix: address review feedback\n\nChanges based on reviewer comments`,
            worker.branch
          );
          console.log(`  Changes committed and pushed`);
          
          // Add a comment to the PR
          await this.github.addPullRequestComment(
            worker.prNumber,
            `I've addressed the review feedback. Please take another look.\n\n---\n*Automated response by Claude Code Orchestrator*`
          );
        } else {
          console.log(`  No changes needed based on review`);
        }
      } else {
        console.error(`  Failed to address review: ${result.error}`);
      }
    } catch (error) {
      console.error(`  Error handling review changes:`, error);
    }
  }

  /**
   * Handle an inline review comment
   */
  private async handleInlineComment(worker: WorkerResult, comment: {
    id: number;
    user: string;
    body: string;
    path: string;
    line: number | null;
  }): Promise<void> {
    if (!comment.body || !worker.prNumber) return;

    try {
      // Checkout the worker branch
      await GitOperations.checkout(worker.branch);

      // Create a prompt for the worker to address the inline comment
      const prompt = `A code reviewer left an inline comment on your PR that needs attention:

**File:** ${comment.path}
${comment.line ? `**Line:** ${comment.line}` : ''}
**Comment:** ${comment.body}

Please review the comment and make any necessary changes to the file. If the comment is a question or doesn't require code changes, just acknowledge it.`;

      console.log(`  Running Claude to address inline comment on ${comment.path}...`);
      const result = await this.sdkRunner.executeTask(prompt);

      if (result.success) {
        const hasChanges = await GitOperations.hasUncommittedChanges();
        if (hasChanges) {
          await GitOperations.commitAndPush(
            `fix: address review comment on ${comment.path}`,
            worker.branch
          );
          console.log(`  Changes committed`);
        }

        // Reply to the comment
        await this.github.replyToReviewComment(
          worker.prNumber,
          comment.id,
          `Addressed. ${hasChanges ? 'Changes pushed.' : 'No code changes needed.'}\n\n---\n*Automated response*`
        );
      }
    } catch (error) {
      console.error(`  Error handling inline comment:`, error);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async createWorkerPullRequest(
    emId: number,
    workerTask: WorkerTask,
    workerBranch: string,
    emBranch: string,
    filesModified: string[]
  ): Promise<{ number: number; html_url: string }> {
    const body = `## Worker Implementation

**EM:** EM-${emId}
**Worker:** Worker-${workerTask.worker_id}

### Task
${workerTask.task}

### Files Changed
${filesModified.map(f => `- \`${f}\``).join('\n') || 'No files tracked (check diff)'}

---
*Automated by Claude Code Orchestrator*
*This PR will be auto-merged into the EM branch*`;

    const pr = await this.github.createPullRequest({
      title: `[EM-${emId}/W-${workerTask.worker_id}] ${workerTask.task.substring(0, 60)}`,
      body,
      head: workerBranch,
      base: emBranch
    });

    return { number: pr.number, html_url: pr.html_url };
  }

  private async createEMPullRequest(
    emTask: EMTask,
    emBranch: string,
    workerResults: WorkerResult[]
  ): Promise<{ number: number; html_url: string }> {
    const successCount = workerResults.filter(r => r.success).length;
    const failCount = workerResults.filter(r => !r.success).length;
    const allFiles = [...new Set(workerResults.flatMap(r => r.filesModified))];

    const body = `## EM-${emTask.em_id}: ${emTask.focus_area}

### Task
${emTask.task}

### Worker Summary
- **Total Workers:** ${workerResults.length}
- **Succeeded:** ${successCount}
- **Failed:** ${failCount}

### Worker PRs
${workerResults.map(r => 
  `- Worker-${r.workerId}: ${r.success ? `Merged (PR #${r.prNumber})` : `Failed: ${r.error}`}`
).join('\n')}

### Files Changed
${allFiles.map(f => `- \`${f}\``).join('\n') || 'No files tracked (check diff)'}

---
*Automated by Claude Code Orchestrator*`;

    const pr = await this.github.createPullRequest({
      title: `[EM-${emTask.em_id}] ${emTask.focus_area}: ${emTask.task.substring(0, 50)}`,
      body,
      head: emBranch,
      base: this.workBranch
    });

    return { number: pr.number, html_url: pr.html_url };
  }

  private async createFinalPR(
    emTasks: EMTask[],
    emResults: EMResult[]
  ): Promise<{ number: number; html_url: string }> {
    // First merge all EM PRs
    for (const emResult of emResults) {
      if (emResult.prNumber) {
        try {
          console.log(`Merging EM-${emResult.emId} PR #${emResult.prNumber}`);
          await this.github.mergePullRequest(emResult.prNumber);
        } catch (error) {
          console.error(`Failed to merge EM PR #${emResult.prNumber}:`, error);
        }
      }
    }

    // Pull latest work branch
    await GitOperations.checkout(this.workBranch);
    await GitOperations.pull(this.workBranch);

    const totalWorkers = emResults.reduce((sum, em) => sum + em.workerResults.length, 0);
    const successWorkers = emResults.reduce((sum, em) => sum + em.workerResults.filter(w => w.success).length, 0);
    const allFiles = [...new Set(emResults.flatMap(em => em.workerResults.flatMap(w => w.filesModified)))];

    const body = `## Automated Implementation for Issue #${this.context.issue.number}

**Issue:** ${this.context.issue.title}

### Summary

This PR was automatically generated by the Claude Code Orchestrator using a hierarchical PR structure.

- **EM Tasks:** ${emTasks.length}
- **Total Workers:** ${totalWorkers} (${successWorkers} succeeded)
- **Files Modified:** ${allFiles.length}

### Hierarchy

${emResults.map(em => `
#### EM-${em.emId}: ${em.focusArea}
- **PR:** #${em.prNumber}
- **Workers:** ${em.workerResults.length}
${em.workerResults.map(w => `  - Worker-${w.workerId}: ${w.success ? `PR #${w.prNumber}` : `Failed: ${w.error}`}`).join('\n')}
`).join('\n')}

### Files Changed
${allFiles.map(f => `- \`${f}\``).join('\n') || 'Check individual PRs for changes'}

---
Closes #${this.context.issue.number}`;

    const pr = await this.github.createPullRequest({
      title: `feat: ${this.context.issue.title}`,
      body,
      head: this.workBranch,
      base: 'main'
    });

    return { number: pr.number, html_url: pr.html_url };
  }

  private async analyzeIssue(): Promise<EMTask[]> {
    const maxEms = this.context.options?.maxEms || 3;
    const maxWorkers = this.context.options?.maxWorkersPerEm || 3;

    const prompt = `You are a technical director analyzing a GitHub issue to break it down into tasks.

**Issue #${this.context.issue.number}: ${this.context.issue.title}**

${this.context.issue.body}

**Your task:**
Break this issue down into EM (Engineering Manager) tasks. Each EM focuses on a distinct area.

**Constraints:**
- Maximum ${maxEms} EMs
- Each EM can have up to ${maxWorkers} Workers
- EMs should have non-overlapping responsibilities
- Keep tasks focused and actionable

**Output ONLY a JSON array (no other text):**
[
  {
    "em_id": 1,
    "task": "Description of what this EM should accomplish",
    "focus_area": "e.g., Core Logic, UI, Testing",
    "estimated_workers": 2
  }
]`;

    const sessionId = generateSessionId('director', this.context.issue.number);
    const result = await this.claude.runTask(prompt, sessionId);

    if (!result.success) {
      throw new Error(`Director analysis failed: ${result.stderr}`);
    }

    const tasks = extractJson(result.stdout) as EMTask[];
    
    if (!Array.isArray(tasks) || tasks.length === 0) {
      throw new Error('Director returned no EM tasks');
    }

    return tasks.slice(0, maxEms);
  }

  private async breakdownEMTask(emTask: EMTask): Promise<WorkerTask[]> {
    const maxWorkers = this.context.options?.maxWorkersPerEm || 3;

    const prompt = `You are an Engineering Manager breaking down a task into worker assignments.

**Your EM Task:** ${emTask.task}
**Focus Area:** ${emTask.focus_area}

**Context - Original Issue:**
${this.context.issue.body}

**Your task:**
Break this down into specific, actionable worker tasks. Each worker will implement one piece.

**Constraints:**
- Maximum ${maxWorkers} workers
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

    const sessionId = generateSessionId('em', this.context.issue.number, emTask.em_id);
    const result = await this.claude.runTask(prompt, sessionId);

    if (!result.success) {
      console.error(`EM-${emTask.em_id} breakdown failed: ${result.stderr}`);
      return [{
        worker_id: 1,
        task: emTask.task,
        files: []
      }];
    }

    try {
      const tasks = extractJson(result.stdout) as WorkerTask[];
      return Array.isArray(tasks) && tasks.length > 0 ? tasks.slice(0, maxWorkers) : [{
        worker_id: 1,
        task: emTask.task,
        files: []
      }];
    } catch {
      return [{
        worker_id: 1,
        task: emTask.task,
        files: []
      }];
    }
  }

  private async postSuccessComment(pr: { number: number; html_url: string }, emResults: EMResult[]): Promise<void> {
    const comment = `## Orchestration Complete

The Claude Code Orchestrator has finished implementing this issue using a hierarchical PR structure.

**Final PR:** #${pr.number}
${pr.html_url}

### PR Hierarchy
${emResults.map(em => `
- **EM-${em.emId} (${em.focusArea}):** PR #${em.prNumber}
${em.workerResults.map(w => `  - Worker-${w.workerId}: PR #${w.prNumber || 'N/A'}`).join('\n')}
`).join('')}

Please review the changes and merge when ready.

---
*Automated by Claude Code Orchestrator*`;

    await this.github.updateIssueComment(this.context.issue.number, comment);
  }

  private async postFailureComment(error: Error): Promise<void> {
    const workflowUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${this.context.repo.owner}/${this.context.repo.repo}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : '';

    const comment = `## Orchestration Failed

The Claude Code Orchestrator encountered an error.

**Error:** ${error.message}

${workflowUrl ? `[View Workflow Logs](${workflowUrl})` : ''}

---
*Automated by Claude Code Orchestrator*`;

    await this.github.updateIssueComment(this.context.issue.number, comment);
  }
}
