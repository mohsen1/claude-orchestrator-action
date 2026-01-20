#!/usr/bin/env node
/**
 * Event-driven orchestrator entry point
 *
 * Called by GitHub workflows on various events.
 * Reads event type and payload from environment, dispatches to orchestrator.
 *
 * IMPORTANT: This is designed to be truly event-driven.
 * Each invocation handles ONE event, updates state, and exits.
 * Long-running operations should trigger new workflow events.
 */
export {};
//# sourceMappingURL=run.d.ts.map