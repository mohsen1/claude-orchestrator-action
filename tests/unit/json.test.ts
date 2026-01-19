/**
 * Unit tests for JSON extraction utilities
 */

import { describe, it, expect } from 'vitest';
import { extractJson, safeJsonParse } from '../../src/shared/json';

describe('extractJson', () => {
  describe('Strategy 1: Markdown code blocks', () => {
    it('should extract from ```json ... ``` blocks', () => {
      const output = `Here's the plan:
\`\`\`json
[{"id": 1, "name": "test"}]
\`\`\`
That's the plan.`;

      const result = extractJson(output);
      expect(result).toEqual([{ id: 1, name: 'test' }]);
    });

    it('should handle markdown with whitespace', () => {
      const output = `
        \`\`\`json
        {"key": "value"}
        \`\`\`
      `;

      const result = extractJson(output);
      expect(result).toEqual({ key: 'value' });
    });
  });

  describe('Strategy 2: Generic code blocks', () => {
    it('should extract from ``` ... ``` without json specifier', () => {
      const output = `Result:
\`\`\`
{"items": [1, 2, 3]}
\`\`\`
Done`;

      const result = extractJson(output);
      expect(result).toEqual({ items: [1, 2, 3] });
    });
  });

  describe('Strategy 3: Array/Object boundaries', () => {
    it('should extract JSON by finding array boundaries', () => {
      const output = `The result is [{"id": 1}, {"id": 2}] and that's it`;

      const result = extractJson(output);
      expect(result).toEqual([{ id: 1 }, { id: 2 }]);
    });

    it('should extract JSON by finding object boundaries', () => {
      const output = `Result: {"name": "test", "value": 123} end`;

      const result = extractJson(output);
      expect(result).toEqual({ name: 'test', value: 123 });
    });

    it('should handle nested structures', () => {
      const output = `Data: {"outer": {"inner": [1, 2, 3]}} done`;

      const result = extractJson(output);
      expect(result).toEqual({ outer: { inner: [1, 2, 3] } });
    });

    it('should prioritize objects over arrays', () => {
      const output = `{"test": [1, 2, 3]}`;

      const result = extractJson(output);
      expect(result).toEqual({ test: [1, 2, 3] });
    });
  });

  describe('Strategy 4: Full output parsing', () => {
    it('should parse entire output as JSON if no other strategy works', () => {
      const output = '{"simple": "json"}';

      const result = extractJson(output);
      expect(result).toEqual({ simple: 'json' });
    });
  });

  describe('LLM output variations', () => {
    it('should handle LLM chatter before JSON', () => {
      const output = `Let me think about this...

Here's my analysis:
\`\`\`json
{"result": "success"}
\`\`\`

That's my conclusion!`;

      const result = extractJson(output);
      expect(result).toEqual({ result: 'success' });
    });

    it('should handle LLM chatter after JSON', () => {
      const output = `\`\`\`json
{"status": "complete"}
\`\`\`
Hope this helps! Let me know if you need anything else.`;

      const result = extractJson(output);
      expect(result).toEqual({ status: 'complete' });
    });

    it('should handle malformed markdown (missing closing block)', () => {
      const output = `Here's the JSON:
\`\`\`json
{"broken": true}
No closing block here...`;

      const result = extractJson(output);
      expect(result).toEqual({ broken: true });
    });

    it('should handle no markdown blocks at all', () => {
      const output = `The answer is {"clean": true} right here`;

      const result = extractJson(output);
      expect(result).toEqual({ clean: true });
    });

    it('should handle arrays without markdown', () => {
      const output = `Tasks: [{"id": 1}, {"id": 2}, {"id": 3}]`;

      const result = extractJson(output);
      expect(result).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    });
  });

  describe('Error handling', () => {
    it('should throw error if no JSON found', () => {
      const output = `This is just plain text with no JSON whatsoever`;

      expect(() => extractJson(output)).toThrow('Could not extract JSON');
    });

    it('should throw error for invalid JSON', () => {
      const output = `{"invalid": json structure}`;

      expect(() => extractJson(output)).toThrow();
    });

    it('should provide helpful error message', () => {
      const output = `No JSON here`;

      expect(() => extractJson(output)).toThrow('Could not extract JSON from LLM output');
    });
  });

  describe('Complex real-world scenarios', () => {
    it('should handle EM task breakdown format', () => {
      const output = `Based on the issue, here's the breakdown:

\`\`\`json
[
  {
    "em_id": 1,
    "task": "Implement UI components",
    "focus_area": "Frontend",
    "estimated_workers": 3
  },
  {
    "em_id": 2,
    "task": "Build backend API",
    "focus_area": "Backend",
    "estimated_workers": 2
  }
]
\`\`\`

These EMs can work in parallel.`;

      const result = extractJson(output);
      expect(result).toEqual([
        {
          em_id: 1,
          task: 'Implement UI components',
          focus_area: 'Frontend',
          estimated_workers: 3
        },
        {
          em_id: 2,
          task: 'Build backend API',
          focus_area: 'Backend',
          estimated_workers: 2
        }
      ]);
    });

    it('should handle Worker task format', () => {
      const output = `Worker tasks:

\`\`\`
[
  {
    "worker_id": 1,
    "task": "Create login form",
    "description": "Build the login UI",
    "files": ["src/components/Login.tsx"]
  },
  {
    "worker_id": 2,
    "task": "Add validation",
    "description": "Validate form inputs",
    "files": ["src/utils/validation.ts"]
  }
]
\`\`\`

Ready to execute.`;

      const result = extractJson(output);
      expect(result).toHaveLength(2);
      expect(result[0].worker_id).toBe(1);
      expect(result[1].files).toEqual(['src/utils/validation.ts']);
    });
  });
});

describe('safeJsonParse', () => {
  it('should parse valid JSON', () => {
    expect(safeJsonParse('{"test": true}')).toEqual({ test: true });
    expect(safeJsonParse('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('should throw error with context', () => {
    expect(() => safeJsonParse('invalid', 'Test Config')).toThrow('Failed to parse Test Config');
  });

  it('should include snippet in error message', () => {
    try {
      safeJsonParse('this is a very long invalid json string that should be truncated');
    } catch (error) {
      expect((error as Error).message).toContain('this is a very long invalid json');
    }
  });
});
