# Claude Code Orchestrator - Progress Report

**Date:** 2026-01-19
**Goal:** Make the orchestrator system work end-to-end in the e2e-test repo to build a functioning calculator

## Summary

The orchestrator infrastructure is mostly working, but there's a remaining issue with the Claude API call timing out when analyzing issues.

## What Works ✅

### 1. GitHub Actions Workflow Infrastructure
- ✅ Workflow triggers correctly when issue is labeled with `orchestrator` label
- ✅ Single comment per issue - updates existing comment instead of creating new ones
- ✅ Failure comments include workflow run URLs for debugging
- ✅ Director workflow correctly:
  - Checks out the orchestrator-action repository
  - Builds TypeScript code
  - Installs Claude Code CLI
  - Runs the Director with proper environment variables

### 2. Code Fixes Applied
- ✅ **API Key Format Compatibility** (`src/shared/claude.ts`)
  - Added support for `ANTHROPIC_AUTH_TOKEN` in addition to `ANTHROPIC_API_KEY`
  - Modified `buildEnv()` to set both `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` for compatibility

- ✅ **Config Interface Update** (`src/shared/config.ts`)
  - Added `ANTHROPIC_AUTH_TOKEN` to the `ClaudeConfig.env` interface

- ✅ **Director/EM/Worker Config Reading** (`src/director/index.ts`, `src/em/index.ts`, `src/worker/index.ts`)
  - Updated all three components to read API key from `ANTHROPIC_AUTH_TOKEN` when present

### 3. Local Testing
- ✅ Claude CLI works with z.ai API from local machine
- ✅ Director correctly reads and applies API configuration
- ✅ Debug logging confirms: `Director config: {"apiKey":"d50863c184...","baseUrl":"https://api.z.ai/api/anthropic"}`

## What Doesn't Work ❌

### 1. Claude API Timeout in Orchestrator
**Issue:** Director fails with `Error: Claude analysis failed: ` (empty stderr) after ~5 minutes

**Symptoms:**
- GitHub Actions: Claude API times out after 5 minutes (300s)
- Local execution: Same timeout occurs
- The simple `claude -p "What is 2+2?"` command works fine from CLI
- The timeout happens specifically during `analyzeIssue()` when calling `claude.runTask()`

**Root Cause Analysis:**
The issue is in how the orchestrator calls the Claude CLI:
```typescript
const result = await execa('claude', ['-p', '--no-session-persistence', task], {
  env,
  timeout: 300000, // 5 minutes
  reject: false
});
```

When the timeout occurs, execa throws an error that gets caught, but `result.stderr` is empty, making debugging difficult.

**Possible Causes:**
1. The prompt passed to Claude is too complex/long
2. The `--no-session-persistence` flag might be causing issues
3. The Claude CLI might be waiting for interactive input
4. The z.ai API might have different rate limits for non-interactive use

### 2. GitHub Actions Network Restriction
**Issue:** The z.ai API endpoint (`https://api.z.ai/api/anthropic`) is not accessible from GitHub Actions runners

**Evidence:**
- Works perfectly from local machine
- Times out immediately (0s) when triggered from GitHub Actions
- Likely blocked by GitHub Actions network policies or IP-based restrictions

**Solution Needed:**
Use Anthropic's official API endpoint (`https://api.anthropic.com`) instead of z.ai for GitHub Actions.

## Files Modified

1. `src/shared/config.ts` - Added `ANTHROPIC_AUTH_TOKEN` to interface
2. `src/shared/claude.ts` - Fixed `buildEnv()` to properly set both API key formats
3. `src/director/index.ts` - Updated to read `ANTHROPIC_AUTH_TOKEN` from config, added debug logging
4. `src/em/index.ts` - Updated to read `ANTHROPIC_AUTH_TOKEN` from config
5. `src/worker/index.ts` - Updated to read `ANTHROPIC_AUTH_TOKEN` from config
6. `action.yml` - Created reusable GitHub Action definition
7. `.github/workflows/orchestrator.yml` (in e2e-test repo) - Configured to use orchestrator-action

## API Configuration

The user's API configuration at `/Users/mohsenazimi/code/orchestrator-config/api-keys.json`:
```json
[
  {
    "name": "z.ai",
    "source": "z.ai",
    "env": {
      "ANTHROPIC_AUTH_TOKEN": "d50863c184664608b0bcdc38be4cdd2b.gDLlVszjGc669JbP",
      "ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic",
      "API_TIMEOUT_MS": "3000000"
    }
  },
  {
    "name": "z.ai",
    "source": "z.ai",
    "env": {
      "ANTHROPIC_AUTH_TOKEN": "991620b6c04d4decbeaac667bbe96a13.NGUvyhpaP9FSCqCs",
      "ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic",
      "API_TIMEOUT_MS": "3000000"
    }
  }
]
```

## Next Steps

### Option 1: Fix the Timeout Issue (Recommended)
1. Investigate the `analyzeIssue()` prompt - it might be too complex
2. Try removing the `--no-session-persistence` flag
3. Add better error handling and logging to capture the actual timeout/error
4. Consider breaking down the analysis into smaller steps

### Option 2: Use Official Anthropic API
1. Get official Anthropic API keys
2. Update `CLAUDE_CONFIGS` secret in e2e-test repo to use `https://api.anthropic.com`
3. Test with standard `ANTHROPIC_API_KEY` format

### Option 3: Simplify the Test Case
1. Create a simpler test issue (e.g., "Create a hello.txt file")
2. Verify the full orchestration pipeline works with simple tasks
3. Gradually increase complexity

## Testing Commands

### Local Testing
```bash
# Clear state
rm -rf .orchestrator

# Build
npm run build

# Run Director locally
export GITHUB_TOKEN="$(gh auth token)"
export REPO_OWNER="mohsen1"
export REPO_NAME="claude-code-orchestrator-e2e-test"
export ISSUE_NUMBER="25"
export ISSUE_TITLE="Build a functional calculator"
export ISSUE_BODY="Create a calculator"
export CLAUDE_CONFIGS='[{"env":{"ANTHROPIC_AUTH_TOKEN":"d50863c184664608b0bcdc38be4cdd2b.gDLlVszjGc669JbP","ANTHROPIC_BASE_URL":"https://api.z.ai/api/anthropic"}}]'
export MAX_EMS="1"
export MAX_WORKERS_PER_EM="1"
node dist/director/run.js
```

### Test Claude CLI Directly
```bash
export ANTHROPIC_AUTH_TOKEN="d50863c184664608b0bcdc38be4cdd2b.gDLlVszjGc669JbP"
export ANTHROPIC_BASE_URL="https://api.z.ai/api/anthropic"
claude -p "What is 2+2? Answer with just the number."
```

## Current State

- **Infrastructure:** Ready ✅
- **Configuration:** Being applied correctly ✅
- **Local API Access:** Working ✅
- **GitHub Actions API Access:** Blocked by network restrictions ❌
- **Director Analysis:** Timing out ❌

The most critical issue to resolve is the Claude API timeout during issue analysis. Once that works, the full orchestration pipeline should function correctly.


---

## Fixes Applied (2026-01-19)

### 1. Workflow Architecture Fix
The workflows were checking out the **wrong repository**. When triggered from the e2e-test repo, `actions/checkout@v4` was checking out the e2e-test repo (which doesn't have the action code), then trying to run `npm ci` and `npm run build`.

**Fixed:** All workflows now:
- Checkout the `mohsen1/claude-orchestrator-action` repo to get the action code
- Checkout the target repo for working directory context
- Run the compiled JS directly from `orchestrator-action/dist/`

### 2. Removed `.orchestrator/` from Action Repo
State files should only exist in the target repository, not in the action repo. Deleted the accidental state folder and added it to `.gitignore`.

### 3. Dist Folder Now Tracked
GitHub Actions with `node20` runtime require compiled JS to be committed. Removed `dist/` from `.gitignore` so the built files are included.

### 4. Improved Error Handling in Claude Runner
- Added timeout detection with better error messages
- Added logging for API endpoint being used
- Made timeout configurable via `API_TIMEOUT_MS` environment variable
- Removed `--no-session-persistence` flag that may have caused issues

### 5. Added `workflow_call` Support
Director workflow now supports being called as a reusable workflow, enabling other repos to use it properly.

## Remaining Issues

### z.ai API Blocked from GitHub Actions
The z.ai API endpoint (`https://api.z.ai/api/anthropic`) is **NOT accessible** from GitHub Actions runners. This is likely due to:
- IP-based restrictions on z.ai
- GitHub Actions egress IP ranges being blocked

**Solution:** Use Anthropic's official API endpoint (`https://api.anthropic.com`) with a standard `ANTHROPIC_API_KEY` for GitHub Actions.