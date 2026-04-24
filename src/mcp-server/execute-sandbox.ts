import vm from 'node:vm';
import type { IndexAPI } from '../shared/index-api.js';

const DEFAULT_TIMEOUT_MS = 5000;

export async function executeInSandbox(
  api: IndexAPI,
  code: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<unknown> {
  // Create a restricted context with only the API and JSON
  const sandbox = {
    api,
    JSON,
  };

  const context = vm.createContext(sandbox);

  // Wrap in async IIFE so user code can use await (for semanticSearch)
  const wrappedCode = `(async () => { ${code} })()`;

  const script = new vm.Script(wrappedCode, {
    filename: 'execute-sandbox.js',
  });

  const result = script.runInContext(context, {
    timeout: timeoutMs,
  });

  // If the result is a promise (from async IIFE), await it
  return await result;
}
