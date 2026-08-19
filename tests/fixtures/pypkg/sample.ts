/**
 * @what Sample TypeScript function used to verify the TS indexing path is unaffected by the Python extraction branch
 * @how Returns a constant value
 * @why Co-locating a .ts fixture next to the Python fixtures in the same buildIndex() run proves both language branches execute correctly side by side
 *
 * @returns {number} Always 42
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain code-index, fixtures
 * @tags fixture, typescript, regression, sample
 */
export function sampleTsFunction(): number {
  return 42;
}
