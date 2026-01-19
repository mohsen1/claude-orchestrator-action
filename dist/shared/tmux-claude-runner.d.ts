/**
 * TmuxClaudeRunner - Runs Claude Code CLI interactively in tmux sessions
 *
 * Key insight: Claude Code CLI's `-p` (print) mode doesn't modify files.
 * To get file modifications, we need to run Claude interactively.
 *
 * This runner:
 * 1. Creates tmux sessions for each Claude instance
 * 2. Starts Claude Code CLI interactively with --dangerously-skip-permissions
 * 3. Sends prompts via tmux send-keys
 * 4. Waits for completion by polling output
 * 5. Captures results via tmux capture-pane
 *
 * CRITICAL: Must wait 3+ seconds after send-keys before pressing Enter
 */
import { EventEmitter } from 'events';
export interface TmuxSession {
    name: string;
    workingDir: string;
    startedAt: Date;
    lastActivity: Date;
    isReady: boolean;
}
export interface RunResult {
    success: boolean;
    output: string;
    error?: string;
    durationMs: number;
}
export declare class TmuxClaudeRunner extends EventEmitter {
    private sessions;
    private apiKey?;
    private baseUrl?;
    constructor(options?: {
        apiKey?: string;
        baseUrl?: string;
    });
    /**
     * Create a new tmux session with Claude running inside
     */
    createSession(name: string, workingDir: string): Promise<TmuxSession>;
    /**
     * Send a prompt to Claude and wait for response
     */
    runPrompt(sessionName: string, prompt: string): Promise<RunResult>;
    /**
     * Send prompt text via tmux send-keys
     * MUST wait 3 seconds after sending before pressing Enter
     */
    private sendPrompt;
    /**
     * Send raw command (for setup, not prompts)
     */
    private sendKeysRaw;
    /**
     * Wait for Claude to finish responding
     */
    private waitForResponse;
    /**
     * Check if Claude is ready for input
     */
    private isReadyForInput;
    /**
     * Capture tmux pane content
     */
    private capturePane;
    /**
     * Clean output by removing Claude UI elements
     */
    private cleanOutput;
    /**
     * Escape special characters for tmux send-keys
     */
    private escapeForTmux;
    /**
     * Check if a tmux session exists
     */
    private sessionExists;
    /**
     * Kill a tmux session
     */
    killSession(name: string): Promise<void>;
    /**
     * Kill all managed sessions
     */
    killAllSessions(): Promise<void>;
    /**
     * Get all active sessions
     */
    getSessions(): TmuxSession[];
    /**
     * Sleep helper
     */
    private sleep;
}
/**
 * Factory function to create a TmuxClaudeRunner from environment
 */
export declare function createTmuxRunner(): TmuxClaudeRunner;
//# sourceMappingURL=tmux-claude-runner.d.ts.map