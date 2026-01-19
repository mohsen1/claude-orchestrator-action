# Claude Code Orchestrator Action

A fully autonomous, hierarchical AI-driven development system using GitHub Actions. The system uses a Director → Engineering Manager (EM) → Worker model where each component runs as a GitHub Actions job.

## Overview

This action brings autonomous AI-driven development to any repository. When you add the `orchestrator` label to an issue, the system:

1. **Analyzes** the issue requirements
2. **Breaks down** the work into manageable tasks
3. **Spawns** multiple AI agents in parallel
4. **Executes** the work using Claude Code CLI
5. **Creates** a pull request with all changes

**Zero human intervention required from trigger to final PR.**

## Features

- **Fully Autonomous** - From issue label to merged PR without human intervention
- **Maximum Parallelization** - All EMs and Workers run concurrently
- **Auto-Recovery** - Handles merge conflicts, test failures, and retries automatically
- **State Management** - Git-based state with human-readable progress dashboard
- **Rate Limit Handling** - Automatic config rotation when hitting API limits
- **Watchdog** - Detects and recovers from stalled components

## Quick Start

### 1. Create GitHub Secrets

In your repository, go to **Settings → Secrets and variables → Actions** and add:

| Secret | Description | Required Scopes |
|--------|-------------|-----------------|
| `CCO_PAT` | Personal Access Token for workflow dispatch | `repo`, `workflow` |
| `CLAUDE_CONFIGS` | JSON array of Claude configurations | N/A |

#### CCO_PAT (Personal Access Token)

Create a PAT at https://github.com/settings/tokens with:
- `repo` (Full control of private repositories)
- `workflow` (Update GitHub Action workflows)

**Important:** Use a PAT, NOT `GITHUB_TOKEN` - the default token cannot trigger workflows.

#### CLAUDE_CONFIGS (JSON Array)

Format as a JSON array:

```json
[
  {
    "apiKey": "sk-ant-xxx",
    "model": "claude-sonnet-4-20250514"
  },
  {
    "apiKey": "sk-ant-yyy",
    "model": "claude-sonnet-4-20250514"
  },
  {
    "env": {
      "ANTHROPIC_BASE_URL": "https://api.z.ai/v1",
      "ANTHROPIC_API_KEY": "zai-xxx"
    }
  }
]
```

**Tips:**
- Use multiple API keys to avoid rate limits
- The system auto-rotates through configs when rate limited
- Each config can have either `apiKey` or `env.ANTHROPIC_API_KEY`

### 2. Add the Workflow

Create `.github/workflows/orchestrator.yml` in your repository:

```yaml
name: Claude Code Orchestrator

on:
  issues:
    types: [labeled]

permissions:
  contents: write
  issues: write
  pull-requests: write
  actions: write

jobs:
  orchestrate:
    if: github.event.label.name == 'orchestrator'
    uses: mohsenazimi/claude-orchestrator-action@main
    with:
      claude_configs: ${{ secrets.CLAUDE_CONFIGS }}
      dispatch_token: ${{ secrets.CCO_PAT }}
    secrets: inherit
```

### 3. Trigger the Orchestrator

1. Create a new GitHub issue
2. Add the `orchestrator` label
3. Watch the magic happen! ✨

The orchestrator will:
- Comment on the issue with progress
- Create branches and PRs
- Keep you updated in real-time
- Deliver a final PR to `main`

## Configuration

### Optional Parameters

You can customize the orchestrator with these optional parameters:

```yaml
- uses: mohsenazimi/claude-orchestrator-action@main
  with:
    claude_configs: ${{ secrets.CLAUDE_CONFIGS }}
    dispatch_token: ${{ secrets.CCO_PAT }}
    trigger_label: 'orchestrator'           # Default: 'orchestrator'
    max_ems: 5                               # Default: 5
    max_workers_per_em: 4                    # Default: 4
    auto_merge: true                         # Default: true
    cleanup_branches: true                   # Default: true
    model: 'sonnet'                          # Default: 'sonnet'
    max_retries: 2                           # Default: 2
    dispatch_stagger_ms: 2000                # Default: 2000
    stall_timeout_minutes: 60               # Default: 60
```

### Repository Variables (Optional)

You can also set these as repository variables instead of inputs:

- `MAX_EMS` - Maximum number of Engineering Managers (default: 5)
- `MAX_WORKERS_PER_EM` - Maximum Workers per EM (default: 4)
- `DISPATCH_STAGGER_MS` - Delay between dispatches in ms (default: 2000)
- `STALL_TIMEOUT_MINUTES` - Minutes before marking as stalled (default: 60)

## How It Works

### Architecture

```
┌─────────────────────────────────────────┐
│           GitHub Issue                  │
│     (Add "orchestrator" label)          │
└────────────────┬────────────────────────┘
                 ▼
┌─────────────────────────────────────────┐
│              DIRECTOR                   │
│  • Analyzes issue requirements          │
│  • Determines EM allocation             │
│  • Creates work branch                  │
│  • Spawns EM workflows                  │
└────┬───────────────────┬────────────────┘
     │                   │
     ▼                   ▼
┌────────────┐    ┌────────────┐
│   EM-1     │    │   EM-2     │
│   (UI)     │    │  (Backend) │
└────┬───────┘    └────┬───────┘
     │                 │
┌────┴────┐       ┌────┴────┐
│Worker-1 │       │Worker-1 │
│Worker-2 │       │Worker-2 │
└─────────┘       └─────────┘
```

### Branch Naming

Branches follow the pattern: `cco/{issue}-{slug}-{component}`

- `cco/123-add-feature` - Director work branch
- `cco/123-add-feature-em1` - EM-1 branch
- `cco/123-add-feature-em1-w2` - EM-1 Worker-2 branch

### State Management

State is stored in:
- **Git**: `.orchestrator/` directory (JSON files, human-readable)
- **Issue Comments**: Real-time progress dashboard
- **GitHub Actions Cache**: Claude session data (NOT in Git to avoid bloat)

## Example

**Issue #123: "Add user authentication"**

The Director might create:
- **EM-1 (UI)**: Login form, session display
- **EM-2 (Backend)**: Auth endpoints, middleware
- **EM-3 (Testing)**: Unit tests, integration tests

Each EM spawns 2-3 Workers. All 12+ jobs run in parallel!

## Troubleshooting

### Orchestration Failed

If you see an "orchestrator-failed" label:

1. Check the workflow logs in the Actions tab
2. Look for the specific error message
3. Common issues:
   - **Rate limit**: Add more API keys to `CLAUDE_CONFIGS`
   - **Missing PAT**: Ensure `CCO_PAT` has `repo` and `workflow` scopes
   - **Empty issue body**: Issues need both title AND description

### Stalled Components

If a component stalls for 60+ minutes:
1. The watchdog adds the `orchestrator-stalled` label
2. Check the workflow logs for the stuck component
3. Manually re-trigger if needed

### Merge Conflicts

The system handles conflicts automatically:
- Workers resolve conflicts in context of their task
- EMs resolve with full context of their workers
- Director resolves with complete project context

## Advanced Usage

### Custom Prompting

Include a `PROJECT_DIRECTION.md` file in your repo to guide the AI:

```markdown
# Project Direction

This is a React/TypeScript web application.

## Coding Standards
- Use functional components with hooks
- Follow Airbnb style guide
- Write tests for all new features

## Architecture
- State management: Zustand
- Routing: React Router v6
- API: REST with axios
```

The orchestrator will use this context when breaking down tasks.

### Filtering Issues

Only issues with the `orchestrator` label are processed. You can:
- Manually add the label
- Use GitHub automation to auto-label based on criteria
- Use multiple labels for different orchestrator configurations

## Development

### Local Testing

Install dependencies:
```bash
npm install
```

Build:
```bash
npm run build
```

Test:
```bash
npm test
```

### Project Structure

```
.
├── src/
│   ├── director/       # Director orchestrator
│   ├── em/             # Engineering Manager
│   ├── worker/         # Worker executor
│   ├── review-handler/ # PR review handler
│   ├── watchdog/       # Stall detection
│   └── shared/         # Core utilities
├── .github/workflows/  # Workflow definitions
└── tests/              # Unit, integration, E2E tests
```

## Contributing

Contributions are welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Submit a pull request

## License

MIT License - see LICENSE file for details

## Support

- 📖 [Documentation](https://github.com/mohsenazimi/claude-orchestrator-action)
- 🐛 [Issue Tracker](https://github.com/mohsenazimi/claude-orchestrator-action/issues)
- 💬 [Discussions](https://github.com/mohsenazimi/claude-orchestrator-action/discussions)

---

Made with care by the Claude Code Orchestrator team
