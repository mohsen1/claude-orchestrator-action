# Claude Code Orchestrator Action

An event-driven, hierarchical AI development system using GitHub Actions. The system uses a Director -> Engineering Manager (EM) -> Worker model to break down issues into parallel tasks executed by Claude AI.

## Overview

When you add a label (default: `cco`) to a GitHub issue, this action:

1. **Analyzes** the issue and creates a work plan
2. **Breaks down** work into EM areas (e.g., "Data Layer", "CLI Interface")
3. **Assigns** workers within each EM to handle specific files
4. **Executes** tasks using Claude Code SDK
5. **Creates PRs** in a hierarchical structure (workers -> EM -> main)
6. **Responds** to code reviews automatically

## Key Features

- **Event-Driven**: Wakes up on GitHub events (label, PR merge, review), does work, saves state, exits
- **State Persistence**: Progress saved to `.orchestrator/state.json` in the work branch
- **Hierarchical PRs**: Workers PR to EM branch, EMs PR to work branch, work branch PRs to main
- **Review Handling**: Automatically addresses `changes_requested` reviews
- **Conflict Prevention**: Prompts enforce non-overlapping file assignments between workers

## Quick Start

### 1. Create Secrets

In your repository, go to **Settings -> Secrets and variables -> Actions** and add:

| Secret | Description |
|--------|-------------|
| `CCO_PAT` | GitHub Personal Access Token with `repo` and `workflow` scopes |
| `CLAUDE_CONFIGS` | JSON array of Claude API configurations |

#### CLAUDE_CONFIGS Format

```json
[
  {
    "apiKey": "sk-ant-xxx",
    "model": "claude-sonnet-4-20250514"
  }
]
```

Or with custom base URL:

```json
[
  {
    "env": {
      "ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic",
      "ANTHROPIC_API_KEY": "your-key"
    }
  }
]
```

### 2. Add the Workflow

Create `.github/workflows/orchestrator.yml` in your repository:

```yaml
name: Claude Orchestrator

on:
  issues:
    types: [labeled]
  pull_request:
    types: [closed]
  pull_request_review:
    types: [submitted]
  workflow_dispatch:
    inputs:
      issue_number:
        description: 'Issue number to check/resume'
        required: true
        type: string

permissions:
  contents: write
  issues: write
  pull-requests: write

jobs:
  start:
    if: github.event_name == 'issues' && github.event.label.name == 'cco'
    uses: mohsen1/claude-orchestrator-action/.github/workflows/orchestrate.yml@main
    with:
      event_type: 'issue_labeled'
      issue_number: ${{ github.event.issue.number }}
    secrets:
      CLAUDE_CONFIGS: ${{ secrets.CLAUDE_CONFIGS }}
      CCO_PAT: ${{ secrets.CCO_PAT }}

  on-pr-merged:
    if: |
      github.event_name == 'pull_request' && 
      github.event.pull_request.merged == true &&
      startsWith(github.event.pull_request.head.ref, 'cco/')
    uses: mohsen1/claude-orchestrator-action/.github/workflows/orchestrate.yml@main
    with:
      event_type: 'pull_request_merged'
      pr_number: ${{ github.event.pull_request.number }}
      branch: ${{ github.event.pull_request.head.ref }}
    secrets:
      CLAUDE_CONFIGS: ${{ secrets.CLAUDE_CONFIGS }}
      CCO_PAT: ${{ secrets.CCO_PAT }}

  on-review:
    if: |
      github.event_name == 'pull_request_review' && 
      github.event.review.state == 'changes_requested' &&
      startsWith(github.event.pull_request.head.ref, 'cco/')
    uses: mohsen1/claude-orchestrator-action/.github/workflows/orchestrate.yml@main
    with:
      event_type: 'pull_request_review'
      pr_number: ${{ github.event.pull_request.number }}
      branch: ${{ github.event.pull_request.head.ref }}
      review_state: ${{ github.event.review.state }}
      review_body: ${{ github.event.review.body }}
    secrets:
      CLAUDE_CONFIGS: ${{ secrets.CLAUDE_CONFIGS }}
      CCO_PAT: ${{ secrets.CCO_PAT }}

  manual:
    if: github.event_name == 'workflow_dispatch'
    uses: mohsen1/claude-orchestrator-action/.github/workflows/orchestrate.yml@main
    with:
      event_type: 'workflow_dispatch'
      issue_number: ${{ inputs.issue_number }}
    secrets:
      CLAUDE_CONFIGS: ${{ secrets.CLAUDE_CONFIGS }}
      CCO_PAT: ${{ secrets.CCO_PAT }}
```

### 3. Trigger

1. Create a GitHub issue describing what you want built
2. Add the `cco` label
3. Watch the action work!

## Configuration

### Workflow Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `trigger_label` | `cco` | Label that triggers orchestration |
| `pr_label` | `cco` | Label added to all orchestrator PRs |
| `max_ems` | `3` | Maximum Engineering Managers |
| `max_workers_per_em` | `3` | Maximum workers per EM |

## Architecture

```
Issue labeled 'cco'
        |
        v
    DIRECTOR
    - Analyzes issue
    - Creates work branch (cco/123-feature-name)
    - Determines if setup needed
    - Breaks into EM tasks
        |
        +-- EM-0 (Setup) [if needed]
        |   - Creates .gitignore, package.json, tsconfig.json
        |
        +-- EM-1 (e.g., Data Layer)
        |   |
        |   +-- Worker-1: src/types.ts
        |   +-- Worker-2: src/storage.ts
        |   +-- Worker-3: src/notes.ts
        |
        +-- EM-2 (e.g., CLI Interface)
            |
            +-- Worker-1: src/cli.ts
            +-- Worker-2: src/commands/
```

### Branch Structure

- `cco/123-feature-name` - Main work branch (state stored here)
- `cco/issue-123-setup` - Setup EM branch
- `cco/issue-123-em-1` - EM-1 branch
- `cco/issue-123-em-1-w-1` - Worker-1 branch for EM-1

### PR Flow

1. Workers create PRs to their EM branch
2. Worker PRs are merged into EM branch
3. EM creates PR to work branch
4. EM PRs are merged into work branch
5. Final PR created from work branch to main

## State Management

State is persisted to `.orchestrator/state.json` on the work branch. This includes:
- Current phase (analyzing, worker_execution, em_review, etc.)
- EM and worker states
- PR numbers and URLs
- Error information

The state file is only committed on the main work branch to prevent merge conflicts.

## Phases

1. `initialized` - Work branch created
2. `analyzing` - Director analyzing issue
3. `project_setup` - Setting up project files (if new project)
4. `em_assignment` - EMs assigned tasks
5. `worker_execution` - Workers executing tasks
6. `worker_review` - Worker PRs under review
7. `em_review` - EM PRs under review
8. `final_merge` - Merging to work branch
9. `final_review` - Final PR to main under review
10. `complete` - All done!
11. `failed` - Something went wrong

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Test
npm test
```

### Project Structure

```
src/
  orchestrator/    # Main event-driven orchestrator
    index.ts       # Core logic
    state.ts       # State types and helpers
    persistence.ts # State read/write
    run.ts         # Entry point
  shared/          # Shared utilities
    git.ts         # Git operations
    github.ts      # GitHub API client
    claude.ts      # Claude Code CLI runner
    sdk-runner.ts  # Claude SDK integration
    config.ts      # API config management
    branches.ts    # Branch naming
    json.ts        # JSON parsing
```

## Troubleshooting

### Workers Creating Conflicting Files

If workers are modifying the same files and causing merge conflicts:
- This is a prompt engineering issue - the EM breakdown should assign non-overlapping files
- The latest version includes improved prompts to prevent this

### State File Conflicts

State is only committed on the main work branch, not on EM/worker branches. This prevents conflicts when merging.

### PR Merge Failures

Common causes:
- Merge conflicts between workers (see above)
- Base branch modified during merge - the system retries with branch update
- PR already merged - handled gracefully

## License

MIT
