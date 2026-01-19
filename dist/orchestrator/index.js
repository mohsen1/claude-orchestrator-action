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
import { createInitialState, areAllWorkersComplete, getNextPendingWorker } from './state.js';
import { loadState, saveState, initializeState, findWorkBranchForIssue } from './persistence.js';
export class EventDrivenOrchestrator {
    ctx;
    github;
    configManager;
    claude;
    sdkRunner;
    state = null;
    constructor(ctx) {
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
    async handleEvent(event) {
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
                case 'schedule':
                    await this.handleProgressCheck(event);
                    break;
                default:
                    console.log(`Unhandled event type: ${event.type}`);
            }
        }
        catch (error) {
            console.error('Event handling failed:', error);
            if (this.state) {
                this.state.phase = 'failed';
                this.state.error = error.message;
                await saveState(this.state);
            }
            throw error;
        }
    }
    /**
     * Handle issue labeled - start new orchestration
     */
    async handleIssueLabeled(event) {
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
    async runAnalysis() {
        if (!this.state)
            throw new Error('No state');
        console.log('\n=== Phase: Director Analysis ===');
        this.state.phase = 'analyzing';
        await saveState(this.state);
        const { maxEms, maxWorkersPerEm } = this.state.config;
        const prompt = `You are a technical director analyzing a GitHub issue to break it down into tasks.

**Issue #${this.state.issue.number}: ${this.state.issue.title}**

${this.state.issue.body}

**Your task:**
Break this issue down into EM (Engineering Manager) tasks. Each EM focuses on a distinct area.

**Constraints:**
- Maximum ${maxEms} EMs
- Each EM can have up to ${maxWorkersPerEm} Workers
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
        const sessionId = generateSessionId('director', this.state.issue.number);
        const result = await this.claude.runTask(prompt, sessionId);
        if (!result.success) {
            throw new Error(`Director analysis failed: ${result.stderr}`);
        }
        const emTasks = extractJson(result.stdout);
        if (!Array.isArray(emTasks) || emTasks.length === 0) {
            throw new Error('Director returned no EM tasks');
        }
        // Create EM states
        this.state.ems = emTasks.slice(0, maxEms).map(em => ({
            id: em.em_id,
            task: em.task,
            focusArea: em.focus_area,
            branch: `cco/issue-${this.state.issue.number}-em-${em.em_id}`,
            status: 'pending',
            workers: [],
            reviewsAddressed: 0,
            startedAt: new Date().toISOString()
        }));
        this.state.phase = 'em_assignment';
        await saveState(this.state, `chore: director assigned ${this.state.ems.length} EMs`);
        // Start first EM
        await this.startNextEM();
    }
    /**
     * Start the next pending EM
     */
    async startNextEM() {
        if (!this.state)
            throw new Error('No state');
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
            status: 'pending',
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
    async breakdownEMTask(em) {
        if (!this.state)
            throw new Error('No state');
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
            const tasks = extractJson(result.stdout);
            return Array.isArray(tasks) && tasks.length > 0
                ? tasks.slice(0, maxWorkersPerEm)
                : [{ worker_id: 1, task: em.task, files: [] }];
        }
        catch {
            return [{ worker_id: 1, task: em.task, files: [] }];
        }
    }
    /**
     * Start the next pending worker for an EM
     */
    async startNextWorker(em) {
        if (!this.state)
            throw new Error('No state');
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

**Files to work with:** ${pendingWorker.files.length > 0 ? pendingWorker.files.join(', ') : 'Create whatever files are needed'}

**Context - Original Issue:**
${this.state.issue.body}

**Instructions:**
1. Implement the task completely
2. Create or modify the necessary files
3. Write clean, production-ready code
4. Include necessary imports and exports
5. Do NOT create test files unless specifically asked

Implement this task now.`;
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
            await GitOperations.commitAndPush(`feat(em-${em.id}/worker-${pendingWorker.id}): ${pendingWorker.task.substring(0, 50)}`, pendingWorker.branch);
        }
        else {
            await GitOperations.push(pendingWorker.branch);
        }
        // Create worker PR
        const pr = await this.github.createPullRequest({
            title: `[EM-${em.id}/W-${pendingWorker.id}] ${pendingWorker.task.substring(0, 60)}`,
            body: `## Worker Implementation\n\n**Task:** ${pendingWorker.task}\n\n---\n*Automated by Claude Code Orchestrator*`,
            head: pendingWorker.branch,
            base: em.branch
        });
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
    async createEMPullRequest(em) {
        if (!this.state)
            throw new Error('No state');
        // First merge all worker PRs
        console.log(`\nMerging worker PRs for EM-${em.id}...`);
        for (const worker of em.workers) {
            if (worker.prNumber && (worker.status === 'pr_created' || worker.status === 'approved')) {
                try {
                    await this.github.mergePullRequest(worker.prNumber);
                    worker.status = 'merged';
                    console.log(`  Merged Worker-${worker.id} PR #${worker.prNumber}`);
                }
                catch (error) {
                    console.error(`  Failed to merge Worker-${worker.id} PR:`, error);
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
    async checkFinalMerge() {
        if (!this.state)
            throw new Error('No state');
        // Check if all EMs have PRs created or merged
        const allEMsReady = this.state.ems.every(em => em.status === 'pr_created' || em.status === 'approved' || em.status === 'merged');
        if (!allEMsReady) {
            console.log('Not all EMs are ready for final merge yet');
            return;
        }
        // Merge all EM PRs
        console.log('\n=== Merging EM PRs ===');
        for (const em of this.state.ems) {
            if (em.prNumber && (em.status === 'pr_created' || em.status === 'approved')) {
                try {
                    await this.github.mergePullRequest(em.prNumber);
                    em.status = 'merged';
                    console.log(`Merged EM-${em.id} PR #${em.prNumber}`);
                }
                catch (error) {
                    console.error(`Failed to merge EM-${em.id} PR:`, error);
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
    async createFinalPR() {
        if (!this.state)
            throw new Error('No state');
        console.log('\n=== Creating Final PR ===');
        const body = `## Automated Implementation for Issue #${this.state.issue.number}

**Issue:** ${this.state.issue.title}

### Summary
This PR was automatically generated by the Claude Code Orchestrator.

- **EMs:** ${this.state.ems.length}
- **Total Workers:** ${this.state.ems.reduce((sum, em) => sum + em.workers.length, 0)}

### Breakdown
${this.state.ems.map(em => `
#### EM-${em.id}: ${em.focusArea}
${em.task}
- Workers: ${em.workers.length}
`).join('\n')}

---
Closes #${this.state.issue.number}`;
        const pr = await this.github.createPullRequest({
            title: `feat: ${this.state.issue.title}`,
            body,
            head: this.state.workBranch,
            base: this.state.baseBranch
        });
        this.state.finalPr = { number: pr.number, url: pr.html_url };
        this.state.phase = 'complete';
        await saveState(this.state, `chore: final PR created (#${pr.number})`);
        // Post comment on issue
        await this.github.updateIssueComment(this.state.issue.number, `## Orchestration Complete\n\nFinal PR: #${pr.number}\n${pr.html_url}\n\nPlease review and merge when ready.\n\n---\n*Automated by Claude Code Orchestrator*`);
        console.log(`Final PR created: ${pr.html_url}`);
    }
    /**
     * Handle PR merged event
     */
    async handlePRMerged(event) {
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
    async handlePRReview(event) {
        if (!event.prNumber || !event.branch || event.reviewState !== 'changes_requested') {
            console.log('PR review event: no action needed');
            return;
        }
        // Find work branch
        const workBranch = await this.findWorkBranchFromPRBranch(event.branch);
        if (!workBranch)
            return;
        // Load state
        this.state = await this.loadStateFromWorkBranch(workBranch);
        if (!this.state)
            return;
        // Find the worker or EM that owns this PR
        for (const em of this.state.ems) {
            for (const worker of em.workers) {
                if (worker.prNumber === event.prNumber) {
                    console.log(`Addressing review on Worker-${worker.id} PR`);
                    await this.addressReview(worker.branch, event.reviewBody || '');
                    worker.reviewsAddressed++;
                    worker.status = 'pr_created';
                    await saveState(this.state);
                    return;
                }
            }
            if (em.prNumber === event.prNumber) {
                console.log(`Addressing review on EM-${em.id} PR`);
                await this.addressReview(em.branch, event.reviewBody || '');
                em.reviewsAddressed++;
                em.status = 'pr_created';
                await saveState(this.state);
                return;
            }
        }
    }
    /**
     * Address review feedback on a branch
     */
    async addressReview(branch, reviewBody) {
        await GitOperations.checkout(branch);
        const prompt = `A code reviewer has requested changes. Please address the following feedback:

**Review Feedback:**
${reviewBody}

Please make the necessary changes to address the reviewer's feedback.`;
        const result = await this.sdkRunner.executeTask(prompt);
        if (result.success) {
            const hasChanges = await GitOperations.hasUncommittedChanges();
            if (hasChanges) {
                await GitOperations.commitAndPush('fix: address review feedback', branch);
                console.log('Review feedback addressed and pushed');
            }
        }
    }
    /**
     * Handle progress check - continue any pending work
     */
    async handleProgressCheck(event) {
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
            case 'em_assignment':
            case 'worker_execution':
                await this.continueWorkerExecution();
                break;
            case 'worker_review':
            case 'em_review':
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
    async continueWorkerExecution() {
        if (!this.state)
            return;
        for (const em of this.state.ems) {
            if (em.status === 'pending' || em.status === 'workers_running') {
                const pendingWorker = getNextPendingWorker(em);
                if (pendingWorker) {
                    await this.startNextWorker(em);
                    return;
                }
                else if (areAllWorkersComplete(em)) {
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
    async checkAndMergePRs() {
        if (!this.state)
            return;
        for (const em of this.state.ems) {
            // Try to merge approved worker PRs
            for (const worker of em.workers) {
                if (worker.status === 'approved' && worker.prNumber) {
                    try {
                        await this.github.mergePullRequest(worker.prNumber);
                        worker.status = 'merged';
                    }
                    catch (e) {
                        console.error(`Failed to merge worker PR:`, e);
                    }
                }
            }
            // If all workers merged, create EM PR if not exists
            if (areAllWorkersComplete(em) && !em.prNumber) {
                await this.createEMPullRequest(em);
            }
            // Try to merge approved EM PRs
            if (em.status === 'approved' && em.prNumber) {
                try {
                    await this.github.mergePullRequest(em.prNumber);
                    em.status = 'merged';
                }
                catch (e) {
                    console.error(`Failed to merge EM PR:`, e);
                }
            }
        }
        await saveState(this.state);
        await this.checkFinalMerge();
    }
    /**
     * Find work branch from a PR branch name
     */
    async findWorkBranchFromPRBranch(prBranch) {
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
    async loadStateFromWorkBranch(branch) {
        await GitOperations.checkout(branch);
        await GitOperations.pull(branch);
        return await loadState();
    }
}
//# sourceMappingURL=index.js.map