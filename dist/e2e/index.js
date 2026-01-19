/**
 * End-to-end orchestrator that runs the full hierarchy inline
 * Director -> EM -> Workers all in one workflow run
 *
 * Uses Claude Agent SDK for proper file modifications
 */
import { GitHubClient } from '../shared/github.js';
import { slugify, getDirectorBranch } from '../shared/branches.js';
import { ClaudeCodeRunner, generateSessionId } from '../shared/claude.js';
import { SDKRunner } from '../shared/sdk-runner.js';
import { GitOperations } from '../shared/git.js';
import { ConfigManager } from '../shared/config.js';
import { extractJson } from '../shared/json.js';
export class E2EOrchestrator {
    context;
    github;
    configManager;
    claude;
    sdkRunner;
    workBranch = '';
    constructor(context) {
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
    async run() {
        console.log('Starting E2E Orchestration...');
        console.log(`Issue #${this.context.issue.number}: ${this.context.issue.title}`);
        try {
            // Step 1: Create work branch
            await this.createWorkBranch();
            // Step 2: Analyze issue and get EM tasks
            console.log('\n=== Phase 1: Director Analysis ===');
            const emTasks = await this.analyzeIssue();
            console.log(`Director identified ${emTasks.length} EM tasks`);
            // Step 3: For each EM, break down into worker tasks and execute
            const allResults = [];
            for (const emTask of emTasks) {
                console.log(`\n=== Phase 2: EM-${emTask.em_id} - ${emTask.focus_area} ===`);
                // Get worker tasks for this EM
                const workerTasks = await this.breakdownEMTask(emTask);
                console.log(`EM-${emTask.em_id} assigned ${workerTasks.length} worker tasks`);
                // Execute each worker task using SDK (with file modifications)
                for (const workerTask of workerTasks) {
                    console.log(`\n--- Worker-${workerTask.worker_id}: ${workerTask.task.substring(0, 50)}... ---`);
                    const result = await this.executeWorkerTask(emTask.em_id, workerTask);
                    allResults.push(result);
                    if (result.success) {
                        console.log(`Worker-${workerTask.worker_id} completed. Files: ${result.filesModified.join(', ') || 'none'}`);
                    }
                    else {
                        console.error(`Worker-${workerTask.worker_id} failed: ${result.error}`);
                    }
                }
            }
            // Step 4: Commit and push all changes
            console.log('\n=== Phase 3: Committing Changes ===');
            await this.commitAndPush();
            // Step 5: Create PR to main
            console.log('\n=== Phase 4: Creating PR ===');
            const pr = await this.createPullRequest(emTasks, allResults);
            console.log(`PR created: ${pr.html_url}`);
            // Step 6: Update issue with success status
            await this.postSuccessComment(pr);
            console.log('\nE2E Orchestration completed successfully!');
        }
        catch (error) {
            console.error('E2E Orchestration failed:', error);
            await this.postFailureComment(error);
            throw error;
        }
    }
    async createWorkBranch() {
        const slug = slugify(this.context.issue.title);
        this.workBranch = getDirectorBranch(this.context.issue.number, slug);
        console.log(`Creating work branch: ${this.workBranch}`);
        await GitOperations.createBranch(this.workBranch, 'main');
        await GitOperations.push(this.workBranch);
        console.log('Work branch created and pushed');
    }
    async analyzeIssue() {
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
        const tasks = extractJson(result.stdout);
        if (!Array.isArray(tasks) || tasks.length === 0) {
            throw new Error('Director returned no EM tasks');
        }
        return tasks.slice(0, maxEms);
    }
    async breakdownEMTask(emTask) {
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
            const tasks = extractJson(result.stdout);
            return Array.isArray(tasks) && tasks.length > 0 ? tasks.slice(0, maxWorkers) : [{
                    worker_id: 1,
                    task: emTask.task,
                    files: []
                }];
        }
        catch {
            return [{
                    worker_id: 1,
                    task: emTask.task,
                    files: []
                }];
        }
    }
    async executeWorkerTask(_emId, workerTask) {
        const prompt = `You are a developer implementing a specific task. Make the actual code changes.

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
        try {
            // Use SDK runner for file modifications
            const result = await this.sdkRunner.executeTask(prompt);
            if (!result.success) {
                return {
                    success: false,
                    error: result.error || 'Unknown error',
                    filesModified: []
                };
            }
            // Get modified files from git
            const filesModified = await GitOperations.getModifiedFiles();
            console.log(`Worker output (first 200 chars): ${result.output.substring(0, 200)}`);
            return {
                success: true,
                filesModified
            };
        }
        catch (error) {
            return {
                success: false,
                error: error.message,
                filesModified: []
            };
        }
    }
    async commitAndPush() {
        const hasChanges = await GitOperations.hasUncommittedChanges();
        if (!hasChanges) {
            console.log('No changes to commit');
            return;
        }
        const files = await GitOperations.getModifiedFiles();
        console.log(`Committing ${files.length} files: ${files.join(', ')}`);
        await GitOperations.commitAndPush(`feat: implement issue #${this.context.issue.number}

${this.context.issue.title}

Automated implementation by Claude Code Orchestrator`);
        console.log('Changes committed and pushed');
    }
    async createPullRequest(emTasks, results) {
        const successCount = results.filter(r => r.success).length;
        const failCount = results.filter(r => !r.success).length;
        const allFiles = [...new Set(results.flatMap(r => r.filesModified))];
        const body = `## Automated Implementation for Issue #${this.context.issue.number}

**Issue:** ${this.context.issue.title}

### Summary

This PR was automatically generated by the Claude Code Orchestrator.

- **EM Tasks:** ${emTasks.length}
- **Worker Tasks:** ${results.length} (${successCount} succeeded, ${failCount} failed)
- **Files Modified:** ${allFiles.length}

### Task Breakdown

${emTasks.map(em => `#### EM-${em.em_id}: ${em.focus_area}\n${em.task}`).join('\n\n')}

### Files Changed

${allFiles.map(f => `- \`${f}\``).join('\n') || 'No files changed'}

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
    async postSuccessComment(pr) {
        const comment = `## Orchestration Complete

The Claude Code Orchestrator has finished implementing this issue.

**Pull Request:** #${pr.number}
${pr.html_url}

Please review the changes and merge when ready.

---
*Automated by Claude Code Orchestrator*`;
        await this.github.updateIssueComment(this.context.issue.number, comment);
    }
    async postFailureComment(error) {
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
//# sourceMappingURL=index.js.map