/**
 * Review Handler component
 * Handles PR review events and dispatches appropriate workflows for resumption
 */
import { GitHubClient } from '../shared/github.js';
import { parseComponentFromBranch } from '../shared/branches.js';
/**
 * Review Handler class
 */
export class ReviewHandler {
    context;
    github;
    constructor(context) {
        this.context = context;
        this.github = new GitHubClient(context.token, context.repo);
    }
    /**
     * Handle a PR review event
     */
    async handleReview() {
        console.log('Handling PR review for:', this.context.pr.headRef);
        // Parse the PR to determine which component owns it
        const parsed = parseComponentFromBranch(this.context.pr.headRef);
        if (!parsed.type) {
            console.log('PR is not from an orchestrator branch, skipping');
            return;
        }
        console.log(`PR belongs to component: ${parsed.type}`);
        // Extract session ID from PR body
        const sessionId = this.extractSessionId(this.context.pr.body);
        if (!sessionId) {
            console.log('No session ID found in PR, cannot resume');
            return;
        }
        // Build feedback prompt
        const feedback = this.buildFeedbackPrompt();
        // Dispatch appropriate workflow based on component type
        switch (parsed.type) {
            case 'worker':
                await this.dispatchWorkerReview(parsed, sessionId, feedback);
                break;
            case 'em':
                await this.dispatchEMReview(parsed, sessionId, feedback);
                break;
            case 'director':
                await this.dispatchDirectorReview(parsed, sessionId, feedback);
                break;
            default:
                console.log('Unknown component type:', parsed.type);
        }
    }
    /**
     * Extract session ID from PR body
     */
    extractSessionId(prBody) {
        const match = prBody.match(/Session ID[:\s]*`?([a-zA-Z0-9-]+)`?/i);
        return match ? match[1] : null;
    }
    /**
     * Build feedback prompt for resuming session
     */
    buildFeedbackPrompt() {
        let feedback = '';
        // Add review state
        feedback += `Review State: ${this.context.review.state}\n`;
        // Add review comments if present
        if (this.context.review.body && this.context.review.body.trim().length > 0) {
            feedback += `\nReview Comments:\n${this.context.review.body}\n`;
        }
        // Add instructions
        feedback += `\nPlease address the review feedback and make necessary changes.`;
        return feedback;
    }
    /**
     * Dispatch Worker workflow with review feedback
     */
    async dispatchWorkerReview(parsed, sessionId, feedback) {
        if (parsed.type !== 'worker' || parsed.emId === null || parsed.workerId === null) {
            return;
        }
        console.log(`Dispatching Worker-${parsed.workerId} review response...`);
        try {
            // Extract issue number and EM branch from context
            const issueNumber = this.extractIssueNumber(this.context.pr.body);
            const emBranch = this.context.pr.baseRef;
            if (!issueNumber) {
                throw new Error('Could not extract issue number from PR');
            }
            await this.github.dispatchWorkflow('cco-worker.yml', emBranch, {
                issue_number: issueNumber.toString(),
                em_id: parsed.emId.toString(),
                worker_id: parsed.workerId.toString(),
                task_assignment: `Review feedback:\n${feedback}`,
                em_branch: emBranch,
                resume: 'true',
                session_id: sessionId
            });
            console.log('Worker review response dispatched');
        }
        catch (error) {
            console.error('Failed to dispatch Worker review:', error);
            throw error;
        }
    }
    /**
     * Dispatch EM workflow with review feedback
     */
    async dispatchEMReview(parsed, sessionId, feedback) {
        if (parsed.type !== 'em' || parsed.emId === null) {
            return;
        }
        console.log(`Dispatching EM-${parsed.emId} review response...`);
        try {
            const issueNumber = this.extractIssueNumber(this.context.pr.body);
            const workBranch = this.context.pr.baseRef;
            if (!issueNumber) {
                throw new Error('Could not extract issue number from PR');
            }
            await this.github.dispatchWorkflow('cco-em.yml', workBranch, {
                issue_number: issueNumber.toString(),
                em_id: parsed.emId.toString(),
                task_assignment: `Review feedback:\n${feedback}`,
                workBranch,
                resume: 'true',
                session_id: sessionId
            });
            console.log('EM review response dispatched');
        }
        catch (error) {
            console.error('Failed to dispatch EM review:', error);
            throw error;
        }
    }
    /**
     * Dispatch Director workflow with review feedback
     */
    async dispatchDirectorReview(_parsed, sessionId, _feedback) {
        console.log('Dispatching Director review response...');
        try {
            const issueNumber = this.extractIssueNumber(this.context.pr.body);
            if (!issueNumber) {
                throw new Error('Could not extract issue number from PR');
            }
            await this.github.dispatchWorkflow('cco-director.yml', 'main', {
                issue_number: issueNumber.toString(),
                resume: 'true',
                session_id: sessionId
            });
            console.log('Director review response dispatched');
        }
        catch (error) {
            console.error('Failed to dispatch Director review:', error);
            throw error;
        }
    }
    /**
     * Extract issue number from PR body
     */
    extractIssueNumber(prBody) {
        // Try to find issue number in various formats
        const match = prBody.match(/Issue #?(\d+)/i);
        return match ? parseInt(match[1], 10) : null;
    }
}
//# sourceMappingURL=index.js.map