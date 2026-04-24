/**
 * Enhances a violation string with a suggested api.* query that would have
 * prevented the violation. Teaches the primary Claude session how to use
 * the index proactively.
 */
export function enhanceViolationWithQueryHint(violation: string): string {
  // Don't double-hint
  if (violation.includes('api.')) return violation;

  const lower = violation.toLowerCase();

  // DRY violations — suggest semantic search
  if (lower.includes('duplicat') || lower.includes('similar') || lower.includes('existing') || lower.includes('reuse')) {
    const nameMatch = violation.match(/[Ff]unction\s+'(\w+)'/);
    const searchTerm = nameMatch
      ? nameMatch[1].replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
      : 'your function description';
    return `${violation}\n  Hint: Before creating new functions, run: api.semanticSearch('${searchTerm}')`;
  }

  // Documentation compliance — suggest doc search (check before pattern, since "documented" is more specific)
  if (lower.includes('document') || lower.includes('readme') || lower.includes('pattern guide') || lower.includes('best practice')) {
    return `${violation}\n  Hint: Check project documentation: api.searchDocs('relevant topic')`;
  }

  // Pattern violations — suggest directory inspection
  if (lower.includes('naming') || lower.includes('convention') || lower.includes('pattern') || lower.includes('sibling')) {
    return `${violation}\n  Hint: Check directory conventions first: api.functionsByDirectory('path/to/dir')`;
  }

  // Blast radius — suggest callers check
  if (lower.includes('caller') || lower.includes('break') || lower.includes('signature') || lower.includes('blast')) {
    const nameMatch = violation.match(/[Ff]unction\s+'(\w+)'/);
    const funcName = nameMatch ? nameMatch[1] : 'functionName';
    return `${violation}\n  Hint: Check impact before modifying: api.callers('${funcName}')`;
  }

  // JSDoc violations and other local issues — no hint needed
  return violation;
}
