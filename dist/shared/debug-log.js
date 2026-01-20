/**
 * Debug Logging for Claude Code Orchestrator
 *
 * When debug mode is enabled, logs events to a separate GitHub issue.
 * This helps diagnose orchestration issues without cluttering the main issue.
 */
const DEBUG_ISSUE_TITLE = '[CCO Debug Log] Orchestration Events';
const DEBUG_ISSUE_LABEL = 'cco-debug';
export class DebugLogger {
    enabled;
    github;
    issueNumber = null;
    buffer = [];
    startTime;
    mainIssueNumber;
    constructor(github, enabled, mainIssueNumber) {
        this.github = github;
        this.enabled = enabled;
        this.startTime = Date.now();
        this.mainIssueNumber = mainIssueNumber;
    }
    /**
     * Log an event (only if debug mode is enabled)
     */
    async log(event, details, phase) {
        if (!this.enabled)
            return;
        const entry = {
            timestamp: new Date().toISOString(),
            event,
            phase,
            details,
            duration: Date.now() - this.startTime
        };
        this.buffer.push(entry);
        console.log(`[DEBUG] ${entry.timestamp} | ${event}${phase ? ` (${phase})` : ''}`);
        if (details) {
            console.log(`[DEBUG]   ${JSON.stringify(details)}`);
        }
    }
    /**
     * Log an error
     */
    async logError(event, error, phase) {
        await this.log(event, {
            error: error instanceof Error ? error.message : error,
            stack: error instanceof Error ? error.stack?.split('\n').slice(0, 3) : undefined
        }, phase);
    }
    /**
     * Flush buffered logs to the debug issue
     * Call this at the end of each event handler
     */
    async flush() {
        if (!this.enabled || this.buffer.length === 0)
            return;
        try {
            // Find or create debug issue
            if (!this.issueNumber) {
                this.issueNumber = await this.findOrCreateDebugIssue();
            }
            // Format log entries
            const logBody = this.formatLogEntries();
            // Add comment to debug issue
            const octokit = this.github.getOctokit();
            const { owner, repo } = this.getRepoInfo();
            await octokit.rest.issues.createComment({
                owner,
                repo,
                issue_number: this.issueNumber,
                body: logBody
            });
            // Clear buffer
            this.buffer = [];
        }
        catch (error) {
            console.error('[DEBUG] Failed to flush logs:', error);
        }
    }
    /**
     * Get repo info from environment
     */
    getRepoInfo() {
        // Get from GITHUB_REPOSITORY env var (format: owner/repo)
        const fullRepo = process.env.GITHUB_REPOSITORY || '';
        const [owner, repo] = fullRepo.split('/');
        return { owner: owner || '', repo: repo || '' };
    }
    /**
     * Find existing debug issue or create a new one
     */
    async findOrCreateDebugIssue() {
        const octokit = this.github.getOctokit();
        const { owner, repo } = this.getRepoInfo();
        // Search for existing debug issue
        const { data: issues } = await octokit.rest.issues.listForRepo({
            owner,
            repo,
            labels: DEBUG_ISSUE_LABEL,
            state: 'open',
            per_page: 1
        });
        if (issues.length > 0) {
            return issues[0].number;
        }
        // Create new debug issue
        const { data: newIssue } = await octokit.rest.issues.create({
            owner,
            repo,
            title: DEBUG_ISSUE_TITLE,
            body: `This issue tracks debug logs for Claude Code Orchestrator events.

Each comment represents one orchestration event with detailed timing and state information.

**Note:** This issue is automatically created when debug mode is enabled. You can close it to stop logging, or delete comments to reduce size.

---
*Automated by Claude Code Orchestrator*`,
            labels: [DEBUG_ISSUE_LABEL]
        });
        return newIssue.number;
    }
    /**
     * Format log entries for GitHub comment
     */
    formatLogEntries() {
        const runId = process.env.GITHUB_RUN_ID || 'local';
        const eventType = process.env.EVENT_TYPE || 'unknown';
        let body = `## Event: \`${eventType}\`\n\n`;
        body += `**Run ID:** ${runId}\n`;
        body += `**Main Issue:** ${this.mainIssueNumber ? `#${this.mainIssueNumber}` : 'N/A'}\n`;
        body += `**Total Duration:** ${Date.now() - this.startTime}ms\n\n`;
        body += `<details>\n<summary>Event Log (${this.buffer.length} entries)</summary>\n\n`;
        body += '```\n';
        for (const entry of this.buffer) {
            const time = entry.timestamp.split('T')[1].replace('Z', '');
            const durationStr = `+${entry.duration}ms`.padStart(8);
            body += `${time} ${durationStr} | ${entry.event}`;
            if (entry.phase)
                body += ` [${entry.phase}]`;
            body += '\n';
            if (entry.details) {
                const detailStr = JSON.stringify(entry.details);
                if (detailStr.length < 200) {
                    body += `                    | ${detailStr}\n`;
                }
                else {
                    body += `                    | ${detailStr.substring(0, 197)}...\n`;
                }
            }
        }
        body += '```\n</details>\n\n';
        body += `---\n*${new Date().toISOString()}*`;
        return body;
    }
    /**
     * Create a summary of the current run for quick reference
     */
    getSummary() {
        return {
            events: this.buffer.length,
            duration: Date.now() - this.startTime,
            errors: this.buffer.filter(e => e.details?.error).length
        };
    }
}
/**
 * Global debug logger instance
 */
let globalLogger = null;
export function initDebugLogger(github, enabled, mainIssueNumber) {
    globalLogger = new DebugLogger(github, enabled, mainIssueNumber);
    return globalLogger;
}
export function getDebugLogger() {
    return globalLogger;
}
export async function debugLog(event, details, phase) {
    if (globalLogger) {
        await globalLogger.log(event, details, phase);
    }
}
export async function debugLogError(event, error, phase) {
    if (globalLogger) {
        await globalLogger.logError(event, error, phase);
    }
}
export async function flushDebugLog() {
    if (globalLogger) {
        await globalLogger.flush();
    }
}
//# sourceMappingURL=debug-log.js.map