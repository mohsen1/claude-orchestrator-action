/**
 * Unit tests for branch naming utilities
 */

import { describe, it, expect } from 'vitest';
import {
  slugify,
  getDirectorBranch,
  getEmBranch,
  getWorkerBranch,
  parseComponentFromBranch,
  isValidOrchestratorBranch,
  getBaseBranch
} from '../../src/shared/branches';

describe('slugify', () => {
  it('should convert title to URL-friendly slug', () => {
    expect(slugify('Add User Authentication')).toBe('add-user-authentication');
    expect(slugify('Fix   Multiple   Spaces')).toBe('fix-multiple-spaces');
    expect(slugify('Remove_underscores_and camelCase')).toBe('remove-underscores-and-camelcase');
  });

  it('should remove special characters', () => {
    expect(slugify('Add feature! @#$%')).toBe('add-feature');
    expect(slugify('Fix bug: critical issue')).toBe('fix-bug-critical-issue');
  });

  it('should handle empty string', () => {
    expect(slugify('')).toBe('');
  });

  it('should truncate to MAX_SLUG_LENGTH', () => {
    const longTitle = 'a'.repeat(100);
    expect(slugify(longTitle).length).toBe(50);
  });

  it('should remove leading/trailing hyphens', () => {
    expect(slugify('---test---')).toBe('test');
  });

  it('should remove consecutive hyphens', () => {
    expect(slugify('test---multiple---hyphens')).toBe('test-multiple-hyphens');
  });
});

describe('getDirectorBranch', () => {
  it('should generate correct director branch name', () => {
    expect(getDirectorBranch(123, 'add-feature')).toBe('cco/123-add-feature');
    expect(getDirectorBranch(1, 'fix-bug')).toBe('cco/1-fix-bug');
  });
});

describe('getEmBranch', () => {
  it('should generate correct EM branch name', () => {
    expect(getEmBranch('cco/123-add-feature', 1)).toBe('cco/123-add-feature-em1');
    expect(getEmBranch('cco/123-add-feature', 5)).toBe('cco/123-add-feature-em5');
  });
});

describe('getWorkerBranch', () => {
  it('should generate correct Worker branch name', () => {
    expect(getWorkerBranch('cco/123-add-feature-em1', 1)).toBe('cco/123-add-feature-em1-w1');
    expect(getWorkerBranch('cco/123-add-feature-em2', 3)).toBe('cco/123-add-feature-em2-w3');
  });
});

describe('parseComponentFromBranch', () => {
  it('should parse director branch', () => {
    const result = parseComponentFromBranch('cco/123-add-feature');
    expect(result.type).toBe('director');
    expect(result.issueNumber).toBe(123);
    expect(result.emId).toBeNull();
    expect(result.workerId).toBeNull();
  });

  it('should parse EM branch', () => {
    const result = parseComponentFromBranch('cco/123-add-feature-em2');
    expect(result.type).toBe('em');
    expect(result.issueNumber).toBe(123);
    expect(result.emId).toBe(2);
    expect(result.workerId).toBeNull();
  });

  it('should parse Worker branch', () => {
    const result = parseComponentFromBranch('cco/123-add-feature-em2-w3');
    expect(result.type).toBe('worker');
    expect(result.issueNumber).toBe(123);
    expect(result.emId).toBe(2);
    expect(result.workerId).toBe(3);
  });

  it('should handle non-orchestrator branches', () => {
    const result = parseComponentFromBranch('main');
    expect(result.type).toBeNull();
    expect(result.issueNumber).toBeNull();
  });

  it('should handle branches without cco/ prefix', () => {
    const result = parseComponentFromBranch('feature/something');
    expect(result.type).toBeNull();
  });

  it('should handle malformed branch names', () => {
    const result = parseComponentFromBranch('cco/not-a-number-test');
    expect(result.type).toBeNull();
  });
});

describe('isValidOrchestratorBranch', () => {
  it('should return true for valid orchestrator branches', () => {
    expect(isValidOrchestratorBranch('cco/123-test')).toBe(true);
    expect(isValidOrchestratorBranch('cco/123-test-em1')).toBe(true);
    expect(isValidOrchestratorBranch('cco/123-test-em1-w2')).toBe(true);
  });

  it('should return false for non-orchestrator branches', () => {
    expect(isValidOrchestratorBranch('main')).toBe(false);
    expect(isValidOrchestratorBranch('feature/test')).toBe(false);
    expect(isValidOrchestratorBranch('cco/not-a-number')).toBe(false);
  });
});

describe('getBaseBranch', () => {
  it('should return main for director branches', () => {
    expect(getBaseBranch('cco/123-test')).toBe('main');
  });

  it('should return director branch for EM branches', () => {
    expect(getBaseBranch('cco/123-test-em1')).toBe('cco/123-test');
  });

  it('should return EM branch for Worker branches', () => {
    expect(getBaseBranch('cco/123-test-em1-w2')).toBe('cco/123-test-em1');
  });

  it('should return main for unknown branches', () => {
    expect(getBaseBranch('feature/test')).toBe('main');
  });
});
