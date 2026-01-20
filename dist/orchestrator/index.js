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
import { execa } from 'execa';
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
     * Add error to history (preserves all errors)
     */
    addErrorToHistory(message, context) {
        if (!this.state)
            return;
        if (!this.state.errorHistory) {
            this.state.errorHistory = [];
        }
        this.state.errorHistory.push({
            timestamp: new Date().toISOString(),
            phase: this.state.phase,
            message: message.substring(0, 500),
            context
        });
    }
    /**
     * Post or update progress comment on the issue
     */
    async updateProgressComment(error) {
        if (!this.state)
            return;
        // Add error to history if provided
        if (error) {
            this.addErrorToHistory(error);
        }
        const { issue, ems, phase, workBranch, finalPr, createdAt, errorHistory } = this.state;
        // Calculate duration
        const startTime = new Date(createdAt).getTime();
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        const durationStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
        // Build status emoji based on phase
        const phaseEmoji = {
            initialized: '🚀',
            analyzing: '🔍',
            project_setup: '📦',
            em_assignment: '👥',
            worker_execution: '⚙️',
            worker_review: '👀',
            em_merging: '🔀',
            em_review: '📝',
            final_merge: '✅',
            final_review: '🎯',
            complete: '🎉',
            failed: '❌'
        };
        const statusEmoji = phaseEmoji[phase] || '📋';
        const phaseLabel = phase.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
        // Count stats
        const totalWorkers = ems.reduce((sum, em) => sum + em.workers.length, 0);
        const mergedWorkers = ems.reduce((sum, em) => sum + em.workers.filter(w => w.status === 'merged').length, 0);
        const mergedEMs = ems.filter(em => em.status === 'merged').length;
        // Build EM/Worker status table
        let emTable = '';
        if (ems.length > 0) {
            emTable = `\n### Teams & Workers\n\n| Team | Focus | Workers | Status |\n|------|-------|---------|--------|\n`;
            for (const em of ems) {
                const completedWorkers = em.workers.filter(w => w.status === 'merged').length;
                const totalEmWorkers = em.workers.length;
                const workerStatus = totalEmWorkers > 0 ? `${completedWorkers}/${totalEmWorkers}` : 'Pending';
                let emStatusDisplay = em.status;
                if (em.status === 'merged')
                    emStatusDisplay = '✅ Merged';
                else if (em.status === 'pr_created')
                    emStatusDisplay = '🔄 PR #' + (em.prNumber || '');
                else if (em.status === 'workers_running')
                    emStatusDisplay = '⚙️ Working';
                else if (em.status === 'workers_complete')
                    emStatusDisplay = '📝 Workers Done';
                else if (em.status === 'pending')
                    emStatusDisplay = '⏳ Pending';
                emTable += `| EM-${em.id} | ${em.focusArea.substring(0, 30)}${em.focusArea.length > 30 ? '...' : ''} | ${workerStatus} | ${emStatusDisplay} |\n`;
            }
            // Add worker details for ALL EMs that have workers
            for (const em of ems.filter(e => e.workers.length > 0)) {
                emTable += `\n<details><summary>Workers for EM-${em.id}: ${em.focusArea.substring(0, 25)}</summary>\n\n`;
                emTable += `| Worker | Task | Status |\n|--------|------|--------|\n`;
                for (const worker of em.workers) {
                    let wStatusDisplay = worker.status;
                    if (worker.status === 'merged')
                        wStatusDisplay = '✅ Merged';
                    else if (worker.status === 'pr_created')
                        wStatusDisplay = `🔄 [PR #${worker.prNumber}](${worker.prUrl})`;
                    else if (worker.status === 'in_progress')
                        wStatusDisplay = '⚙️ Working';
                    else if (worker.status === 'changes_requested')
                        wStatusDisplay = '📝 Changes Requested';
                    else
                        wStatusDisplay = '⏳ Pending';
                    emTable += `| W-${worker.id} | ${worker.task.substring(0, 40)}${worker.task.length > 40 ? '...' : ''} | ${wStatusDisplay} |\n`;
                }
                emTable += `\n</details>\n`;
            }
        }
        // Build error history section (show ALL errors)
        let errorSection = '';
        if (errorHistory && errorHistory.length > 0) {
            errorSection = `\n### ⚠️ Errors (${errorHistory.length})\n`;
            errorSection += `<details><summary>Click to expand error log</summary>\n\n`;
            for (const err of errorHistory) {
                const errTime = new Date(err.timestamp).toISOString().substring(11, 19);
                errorSection += `**[${errTime}] ${err.phase}**\n\`\`\`\n${err.message}\n\`\`\`\n`;
                if (err.context) {
                    errorSection += `Context: ${err.context}\n`;
                }
                errorSection += '\n';
            }
            errorSection += `</details>\n`;
        }
        // Build final PR section
        const finalPRSection = finalPr
            ? `\n### Final PR\n[#${finalPr.number}](${finalPr.url}) - Reviews addressed: ${finalPr.reviewsAddressed || 0}\n`
            : '';
        // Build the full comment
        const body = `## 🤖 Orchestration Status

${statusEmoji} **Phase:** ${phaseLabel}

| | |
|---|---|
| **Branch** | \`${workBranch}\` |
| **Duration** | ${durationStr} |
| **EMs** | ${mergedEMs}/${ems.length} merged |
| **Workers** | ${mergedWorkers}/${totalWorkers} merged |
${emTable}${finalPRSection}${errorSection}
---
*Last updated: ${new Date().toISOString()}*
*Automated by [Claude Code Orchestrator](https://github.com/mohsen1/claude-orchestrator-action)*`;
        try {
            await this.github.updateIssueComment(issue.number, body);
        }
        catch (err) {
            console.error('Failed to update progress comment:', err);
        }
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
                    // workflow_dispatch can either start new or continue existing
                    if (event.issueNumber) {
                        const existingBranch = await findWorkBranchForIssue(event.issueNumber);
                        if (existingBranch) {
                            await this.handleProgressCheck({ ...event, branch: existingBranch });
                        }
                        else {
                            // No existing branch - start new orchestration
                            await this.handleIssueLabeled(event);
                        }
                    }
                    else {
                        await this.handleProgressCheck(event);
                    }
                    break;
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
                await this.updateProgressComment(error.message);
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
        await this.updateProgressComment();
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
- Project Setup EM should create ALL setup files: .gitignore, package.json, tsconfig.json
- NO other EM should create setup files - they assume setup is done
- Other EMs should wait until setup is complete
- **EMs MUST have completely non-overlapping responsibilities and files**
- Each EM owns specific files/directories that NO other EM touches
- Example: EM-1 owns src/types.ts and src/storage.ts, EM-2 owns src/cli.ts and src/commands/

**Team Sizing - USE ALL AVAILABLE CAPACITY for complex tasks:**
- You have up to ${maxEms} EMs available (not counting setup)
- Each EM can have up to ${maxWorkersPerEm} Workers
- For SIMPLE tasks (1-2 features): Use 1-2 EMs with 1-2 workers each
- For MEDIUM tasks (3-5 features): Use 2-3 EMs with 2-3 workers each  
- For COMPLEX tasks (many features, multiple layers): USE ALL ${maxEms} EMs with ${maxWorkersPerEm} workers each
- More workers = faster completion but ensure non-overlapping work
- When in doubt, USE MORE workers - parallelization speeds up delivery

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
        const analysis = extractJson(result.stdout);
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
            await this.updateProgressComment();
            // Create setup EM state
            this.state.ems = [{
                    id: 0,
                    task: setupEM.task,
                    focusArea: 'Project Setup',
                    branch: `cco/issue-${this.state.issue.number}-setup`,
                    status: 'pending',
                    workers: [],
                    reviewsAddressed: 0,
                    startedAt: new Date().toISOString()
                }];
            // Store other EMs in state for later (after setup completes)
            this.state.pendingEMs = otherEMs.slice(0, maxEms).map((em, idx) => ({
                id: idx + 1,
                task: em.task,
                focusArea: em.focus_area,
                branch: `cco/issue-${this.state.issue.number}-em-${idx + 1}`,
                status: 'pending',
                workers: [],
                reviewsAddressed: 0
            }));
            console.log(`Project setup needed. ${this.state.pendingEMs.length} EMs queued after setup.`);
            await saveState(this.state, `chore: director starting project setup first (${this.state.pendingEMs.length} EMs pending)`);
            // Start setup EM
            await this.startNextEM();
        }
        else {
            // No setup needed, proceed normally
            this.state.ems = otherEMs.slice(0, maxEms).map((em, idx) => ({
                id: idx + 1,
                task: em.task,
                focusArea: em.focus_area,
                branch: `cco/issue-${this.state.issue.number}-em-${idx + 1}`,
                status: 'pending',
                workers: [],
                reviewsAddressed: 0,
                startedAt: new Date().toISOString()
            }));
            this.state.phase = 'em_assignment';
            await saveState(this.state, `chore: director assigned ${this.state.ems.length} EMs`);
            await this.updateProgressComment();
            // Start first EM
            await this.startNextEM();
        }
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
        await this.updateProgressComment();
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

**CRITICAL Constraints:**
- You can use up to ${maxWorkersPerEm} workers - USE MORE for complex tasks!
- **EACH WORKER MUST HAVE COMPLETELY SEPARATE FILES** - NO overlap between workers!
- If Worker-1 creates src/types.ts, NO other worker should touch that file
- Each task should be completable independently without modifying other workers' files
- Specify EXACTLY which files each worker should create or modify
- Tasks should be concrete (e.g., "Create Calculator class in src/calculator.ts")
- If a task requires multiple related files, assign them ALL to the SAME worker

**Worker Sizing:**
- Simple EM task: 1-2 workers
- Medium EM task: 2-3 workers
- Complex EM task: USE ALL ${maxWorkersPerEm} workers
- More workers = parallel execution = faster delivery

**Example of GOOD division:**
- Worker-1: src/types.ts (types only)
- Worker-2: src/storage.ts (storage only, imports from types.ts but doesn't modify it)  
- Worker-3: src/notes.ts (notes only, imports from types.ts and storage.ts)

**Example of BAD division:**
- Worker-1: src/types.ts
- Worker-2: src/types.ts, src/storage.ts  <- BAD! Overlaps with Worker-1

**Output ONLY a JSON array (no other text):**
[
  {
    "worker_id": 1,
    "task": "Specific task with EXACT files this worker will create/modify",
    "files": ["path/to/file1.ts"]
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

**Files to work with:** ${pendingWorker.files?.length > 0 ? pendingWorker.files.join(', ') : 'Create whatever files are needed'}

**Context - Original Issue:**
${this.state.issue.body}

**CRITICAL Instructions:**
1. Create files directly in the current directory (NOT in a subdirectory)
2. NEVER run "npm install" - only create config files
3. Implement the task completely with clean, production-ready code
4. Include necessary imports and exports

**ABSOLUTE RULES:**
- Create files in the ROOT directory, NOT inside any subdirectory
- Do NOT create or commit node_modules under any circumstances
- If creating a Next.js project, do NOT use "npx create-next-app" - manually create the files
- Write the actual file contents, don't run scaffolding commands

**DO NOT create:**
- node_modules/ directory
- Any SUMMARY.md or documentation files
- README.md (unless specifically asked)

**If this is a setup task, create files in THIS ORDER:**
1. .gitignore FIRST (must include: node_modules, .next, .env*, dist)
2. package.json with dependencies
3. tsconfig.json for TypeScript
4. Other config files as needed

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
        // Add label to PR
        await this.github.addLabels(pr.number, [this.state.config.prLabel]);
        pendingWorker.status = 'pr_created';
        pendingWorker.prNumber = pr.number;
        pendingWorker.prUrl = pr.html_url;
        pendingWorker.completedAt = new Date().toISOString();
        this.state.phase = 'worker_review';
        await saveState(this.state, `chore: Worker-${pendingWorker.id} PR created (#${pr.number})`);
        await this.updateProgressComment();
        console.log(`Worker-${pendingWorker.id} PR created: ${pr.html_url}`);
        // Continue with next worker or merge
        await this.startNextWorker(em);
    }
    /**
     * Wait for reviews before merging a PR
     * Uses review_wait_minutes from config to allow automated reviewers (Copilot) time to post
     */
    async waitForReviewsBeforeMerge(prNumber, prCreatedAt) {
        const waitMinutes = this.state?.config.reviewWaitMinutes || 5;
        const waitSeconds = waitMinutes * 60;
        if (prCreatedAt) {
            const createdTime = new Date(prCreatedAt).getTime();
            const now = Date.now();
            const elapsed = (now - createdTime) / 1000;
            if (elapsed < waitSeconds) {
                const waitTime = Math.ceil(waitSeconds - elapsed);
                console.log(`  Waiting ${Math.ceil(waitTime / 60)}m ${waitTime % 60}s for reviews on PR #${prNumber} (configured: ${waitMinutes}m)...`);
                await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
            }
        }
        else {
            // No creation time, wait the full period
            console.log(`  Waiting ${waitMinutes}m for reviews on PR #${prNumber}...`);
            await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
        }
        // Check for any unaddressed reviews
        const reviews = await this.github.getPullRequestReviews(prNumber);
        const hasChangesRequested = reviews.some(r => r.state === 'CHANGES_REQUESTED');
        if (hasChangesRequested) {
            console.log(`  PR #${prNumber} has changes requested - will not merge yet`);
            throw new Error('PR has unaddressed review comments');
        }
        // Check for inline comments that might need addressing
        const comments = await this.github.getPullRequestComments(prNumber);
        if (comments.length > 0) {
            console.log(`  PR #${prNumber} has ${comments.length} review comments - will address them`);
        }
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
                // Wait for reviews before merging
                try {
                    await this.waitForReviewsBeforeMerge(worker.prNumber, worker.completedAt);
                }
                catch (err) {
                    console.log(`  Skipping merge of Worker-${worker.id} PR: ${err.message}`);
                    continue;
                }
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
                }
                else {
                    console.warn(`  Could not merge Worker-${worker.id} PR #${worker.prNumber}: ${result.error}`);
                }
            }
        }
        // Pull latest EM branch
        await GitOperations.checkout(em.branch);
        await GitOperations.pull(em.branch);
        // Check if any workers were actually merged
        const mergedWorkers = em.workers.filter(w => w.status === 'merged');
        if (mergedWorkers.length === 0) {
            console.warn(`EM-${em.id}: No workers merged successfully. Skipping EM PR.`);
            em.status = 'pr_created'; // Mark as done anyway to continue flow
            em.error = 'No workers merged - all had conflicts';
            await saveState(this.state);
            // Continue to next EM
            await this.startNextEM();
            return;
        }
        // Create EM PR to work branch
        try {
            const pr = await this.github.createPullRequest({
                title: `[EM-${em.id}] ${em.focusArea}: ${em.task.substring(0, 50)}`,
                body: `## EM-${em.id}: ${em.focusArea}\n\n**Task:** ${em.task}\n\n**Workers:** ${em.workers.length} (${mergedWorkers.length} merged)\n\n---\n*Automated by Claude Code Orchestrator*`,
                head: em.branch,
                base: this.state.workBranch
            });
            // Add label to PR
            await this.github.addLabels(pr.number, [this.state.config.prLabel]);
            em.status = 'pr_created';
            em.prNumber = pr.number;
            em.prUrl = pr.html_url;
            console.log(`EM-${em.id} PR created: ${pr.html_url}`);
        }
        catch (error) {
            const errMsg = error.message;
            if (errMsg.includes('No commits between')) {
                console.warn(`EM-${em.id}: No commits to PR (branch same as base). Marking as merged.`);
                em.status = 'merged';
            }
            else {
                throw error;
            }
        }
        this.state.phase = 'em_review';
        await saveState(this.state, `chore: EM-${em.id} PR processed`);
        await this.updateProgressComment();
        // Start next EM if any
        await this.startNextEM();
    }
    /**
     * Check if ready for final merge
     */
    async checkFinalMerge() {
        if (!this.state)
            throw new Error('No state');
        // Check if all current EMs have PRs created or merged
        const allEMsReady = this.state.ems.every(em => em.status === 'pr_created' || em.status === 'approved' || em.status === 'merged');
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
                }
                else {
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
    async createFinalPR() {
        if (!this.state)
            throw new Error('No state');
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
        // Create the PR first
        const pr = await this.github.createPullRequest({
            title: `feat: ${this.state.issue.title}`,
            body,
            head: this.state.workBranch,
            base: this.state.baseBranch
        });
        // Add label to final PR
        await this.github.addLabels(pr.number, [this.state.config.prLabel]);
        this.state.finalPr = { number: pr.number, url: pr.html_url, reviewsAddressed: 0 };
        this.state.phase = 'final_review'; // Stay in final_review to handle reviews
        // Save state - keep state file to enable review handling
        // State file will be removed when PR is merged (in handlePRMerged)
        await saveState(this.state, 'chore: final PR created');
        await this.updateProgressComment();
        console.log(`Final PR created: ${pr.html_url}`);
        console.log('Waiting for reviews. State preserved for review handling.');
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
        // Check if this is the final PR being merged
        if (this.state.finalPr?.number === event.prNumber) {
            console.log('Final PR merged! Marking orchestration complete.');
            this.state.phase = 'complete';
            // Remove state file from work branch
            try {
                await execa('git', ['rm', '-f', '.orchestrator/state.json']);
                await execa('git', ['commit', '-m', 'chore: remove orchestrator state file']);
                await GitOperations.push();
            }
            catch (err) {
                console.log('State file cleanup:', err.message);
            }
            await this.updateProgressComment();
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
        if (!workBranch)
            return;
        // Load state
        this.state = await this.loadStateFromWorkBranch(workBranch);
        if (!this.state)
            return;
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
    async addressReview(branch, prNumber, reviewBody) {
        await GitOperations.checkout(branch);
        // Get inline review comments (code comments)
        const reviewComments = await this.github.getPullRequestComments(prNumber);
        // Get general PR comments (issue-style comments)
        const prComments = await this.github.getPullRequestIssueComments(prNumber);
        // Process inline comments individually
        if (reviewComments.length > 0) {
            console.log(`Processing ${reviewComments.length} inline code comments...`);
            await this.processInlineComments(prNumber, reviewComments, branch);
        }
        // Process general PR comments
        const actionableComments = prComments.filter(c => c.user !== 'github-actions[bot]' &&
            !c.body.includes('Automated by Claude') &&
            c.body.length > 10);
        if (actionableComments.length > 0) {
            console.log(`Processing ${actionableComments.length} general PR comments...`);
            await this.processGeneralPRComments(prNumber, actionableComments, branch);
        }
        // If there's also a review body, address it
        if (reviewBody && reviewBody.trim().length > 20) {
            console.log('Addressing review body feedback...');
            await this.addressGeneralReviewFeedback(branch, reviewBody);
        }
        // Commit and push any remaining changes
        const hasChanges = await GitOperations.hasUncommittedChanges();
        if (hasChanges) {
            await GitOperations.commitAndPush('fix: address review feedback', branch);
            console.log('Review feedback addressed and pushed');
        }
        else {
            console.log('All review comments handled');
        }
    }
    /**
     * Process general PR comments (not inline code comments)
     */
    async processGeneralPRComments(prNumber, comments, _branch) {
        for (const comment of comments) {
            console.log(`\n  Processing general comment from ${comment.user}`);
            console.log(`  Comment: "${comment.body.substring(0, 100)}${comment.body.length > 100 ? '...' : ''}"`);
            // Analyze if comment is actionable
            const analysisPrompt = `Analyze this general PR comment and determine if it requires code changes.

**Comment from ${comment.user}:** ${comment.body}

Respond in JSON format only:
{
  "actionable": true or false,
  "reason": "Brief explanation",
  "suggestedAction": "If actionable, what should be done"
}

A comment is actionable if it requests specific code changes (e.g., "use latest packages", "add error handling").
A comment is NOT actionable if it's just a question, acknowledgment, or general discussion.`;
            const analysis = await this.sdkRunner.executeTask(analysisPrompt);
            let isActionable = false;
            let reason = '';
            let suggestedAction = '';
            try {
                const jsonMatch = analysis.output?.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const parsed = JSON.parse(jsonMatch[0]);
                    isActionable = parsed.actionable === true;
                    reason = parsed.reason || '';
                    suggestedAction = parsed.suggestedAction || '';
                }
            }
            catch {
                isActionable = true;
                reason = 'Could not parse, treating as actionable';
            }
            if (isActionable) {
                console.log(`  -> Actionable: ${reason}`);
                const fixPrompt = `Address this PR comment by making the necessary code changes.

**Comment:** ${comment.body}
**Suggested Action:** ${suggestedAction}

Make the changes now. Focus on what the comment is asking for.`;
                await this.sdkRunner.executeTask(fixPrompt);
                // Reply to the comment
                await this.github.addPullRequestComment(prNumber, `Addressed: ${suggestedAction || 'Made the requested changes.'}\n\n_Automated response_`);
                console.log(`  -> Fixed and replied`);
            }
            else {
                console.log(`  -> Not actionable: ${reason}`);
                await this.github.addPullRequestComment(prNumber, `Thank you for the feedback. ${reason}\n\n_Automated response_`);
            }
        }
    }
    /**
     * Process each inline comment individually
     */
    async processInlineComments(prNumber, comments, _branch) {
        for (const comment of comments) {
            // Skip bot comments or already resolved comments
            if (comment.user === 'github-actions[bot]')
                continue;
            console.log(`\n  Processing comment on ${comment.path}:${comment.line || 'N/A'}`);
            console.log(`  Comment: "${comment.body.substring(0, 100)}${comment.body.length > 100 ? '...' : ''}"`);
            // Ask Claude to analyze if the comment is actionable
            const analysisPrompt = `Analyze this code review comment and determine if it requires code changes.

**File:** ${comment.path}
**Line:** ${comment.line || 'N/A'}
**Comment:** ${comment.body}

Respond in JSON format only:
{
  "actionable": true or false,
  "reason": "Brief explanation of why this is or isn't actionable",
  "suggestedFix": "If actionable, describe what code changes should be made"
}

A comment is NOT actionable if:
- It's just a question that doesn't require code changes
- It's praise or acknowledgment
- It suggests something that contradicts the requirements
- It's asking for clarification rather than requesting changes
- The suggestion would break existing functionality

A comment IS actionable if:
- It points out a bug or error
- It suggests a valid improvement
- It identifies missing error handling
- It requests a specific code change that makes sense`;
            const analysis = await this.sdkRunner.executeTask(analysisPrompt);
            let isActionable = false;
            let reason = '';
            let suggestedFix = '';
            try {
                // Parse Claude's response
                const jsonMatch = analysis.output?.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const parsed = JSON.parse(jsonMatch[0]);
                    isActionable = parsed.actionable === true;
                    reason = parsed.reason || '';
                    suggestedFix = parsed.suggestedFix || '';
                }
            }
            catch (e) {
                // If parsing fails, assume actionable to be safe
                isActionable = true;
                reason = 'Could not parse analysis, treating as actionable';
            }
            if (isActionable) {
                console.log(`  -> Actionable: ${reason}`);
                // Make the code changes
                const fixPrompt = `Fix the code based on this review comment.

**File:** ${comment.path}
**Line:** ${comment.line || 'N/A'}  
**Comment:** ${comment.body}
**Suggested Fix:** ${suggestedFix}

Make the necessary code changes now. Only modify the specific file mentioned.
DO NOT create any new files or documentation.`;
                await this.sdkRunner.executeTask(fixPrompt);
                // Reply to the comment with what was done
                await this.github.replyToReviewComment(prNumber, comment.id, `Fixed! ${suggestedFix || 'Made the requested changes.'}`);
                console.log(`  -> Fixed and replied`);
            }
            else {
                console.log(`  -> Not actionable: ${reason}`);
                // Reply explaining why no changes were made
                await this.github.replyToReviewComment(prNumber, comment.id, `Thank you for the feedback. ${reason}\n\nNo code changes were made for this comment.`);
                console.log(`  -> Replied with explanation`);
            }
        }
    }
    /**
     * Address general review feedback (not inline comments)
     */
    async addressGeneralReviewFeedback(_branch, reviewBody) {
        const prompt = `A code reviewer has provided general feedback. Address it if it requires code changes.

**Review Feedback:**
${reviewBody}

**Instructions:**
- Only make code changes if the feedback clearly requires them
- DO NOT create documentation files
- If the feedback is just a question or doesn't require changes, do nothing`;
        await this.sdkRunner.executeTask(prompt);
    }
    /**
     * Address review feedback on the final PR
     */
    async addressFinalPRReview(prNumber, reviewBody) {
        if (!this.state)
            throw new Error('No state');
        await GitOperations.checkout(this.state.workBranch);
        // Get inline review comments (code comments)
        const reviewComments = await this.github.getPullRequestComments(prNumber);
        // Get general PR comments (issue-style comments)
        const prComments = await this.github.getPullRequestIssueComments(prNumber);
        // Process inline comments individually
        if (reviewComments.length > 0) {
            console.log(`Processing ${reviewComments.length} inline code comments on final PR...`);
            await this.processInlineComments(prNumber, reviewComments, this.state.workBranch);
        }
        // Process general PR comments
        const actionableComments = prComments.filter(c => c.user !== 'github-actions[bot]' &&
            !c.body.includes('Automated by Claude') &&
            !c.body.includes('_Automated response_') &&
            c.body.length > 10);
        if (actionableComments.length > 0) {
            console.log(`Processing ${actionableComments.length} general PR comments on final PR...`);
            await this.processGeneralPRComments(prNumber, actionableComments, this.state.workBranch);
        }
        // If there's also a review body, address it
        if (reviewBody && reviewBody.trim().length > 20) {
            console.log('Addressing review body feedback on final PR...');
            await this.addressGeneralReviewFeedback(this.state.workBranch, reviewBody);
        }
        // Commit and push any remaining changes
        const hasChanges = await GitOperations.hasUncommittedChanges();
        if (hasChanges) {
            await GitOperations.commitAndPush('fix: address final PR review feedback', this.state.workBranch);
            console.log('Final PR review feedback addressed and pushed');
        }
        else {
            console.log('All final PR review comments handled');
        }
        this.state.finalPr.reviewsAddressed = (this.state.finalPr.reviewsAddressed || 0) + 1;
        // Don't save state to avoid re-adding state file to PR
        // The state tracking is less critical at this point anyway
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
                    const result = await this.github.mergePullRequest(worker.prNumber);
                    if (result.merged) {
                        worker.status = 'merged';
                    }
                    else {
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
                }
                else {
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