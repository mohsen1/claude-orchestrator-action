/**
 * JSON parsing utilities for LLM outputs
 * Provides robust extraction with multiple fallback strategies
 */

/**
 * Extract JSON from LLM output with multiple fallback strategies
 * @param output - Raw LLM output
 * @returns Parsed JSON object
 * @throws Error if JSON cannot be extracted or parsed
 */
export function extractJson(output: string): any {
  // Strategy 1: Extract from markdown code blocks (```json ... ```)
  const markdownMatch = output.match(/```json\s*([\s\S]*?)\s*```/);
  if (markdownMatch) {
    try {
      return JSON.parse(markdownMatch[1].trim());
    } catch {
      // Continue to next strategy
    }
  }

  // Strategy 2: Extract from generic code blocks (``` ... ```)
  const genericMatch = output.match(/```\s*([\s\S]*?)\s*```/);
  if (genericMatch) {
    try {
      return JSON.parse(genericMatch[1].trim());
    } catch {
      // Continue to next strategy
    }
  }

  // Strategy 3: Find JSON object/array boundaries
  // Need to match brackets properly: [ with ] and { with }

  // Try object boundaries first (prioritize objects over arrays)
  const firstBrace = output.indexOf('{');
  if (firstBrace !== -1) {
    const lastBrace = output.lastIndexOf('}');
    if (lastBrace > firstBrace) {
      try {
        const jsonStr = output.substring(firstBrace, lastBrace + 1);
        return JSON.parse(jsonStr);
      } catch {
        // Continue to array extraction
      }
    }
  }

  // Try array boundaries
  const firstBracket = output.indexOf('[');
  if (firstBracket !== -1) {
    const lastBracket = output.lastIndexOf(']');
    if (lastBracket > firstBracket) {
      try {
        const jsonStr = output.substring(firstBracket, lastBracket + 1);
        return JSON.parse(jsonStr);
      } catch {
        // Continue to next strategy
      }
    }
  }

  // Strategy 4: Try parsing entire output as JSON
  try {
    return JSON.parse(output.trim());
  } catch {
    // All strategies failed
  }

  throw new Error(
    'Could not extract JSON from LLM output. Tried: ' +
      'markdown code blocks, generic code blocks, array/object boundaries, and full output parsing.'
  );
}

/**
 * Safely parse JSON with fallback error message
 * @param jsonStr - JSON string to parse
 * @param context - Context for error messages
 * @returns Parsed object
 */
export function safeJsonParse(jsonStr: string, context = 'JSON'): any {
  try {
    return JSON.parse(jsonStr);
  } catch (error) {
    throw new Error(
      `Failed to parse ${context}: ${(error as Error).message}\n` +
      `Input: ${jsonStr.substring(0, 200)}...`
    );
  }
}
