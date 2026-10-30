// Fixture for inline-comment indexing: each declaration below has a signature
// whose first `{` is not its body (or no `{` at all), modeled on real React code
// whose comments were missing from the index. The bodies are stand-ins.
import React from 'react';
import { observer } from 'mobx-react-lite';
import { useCallback, useMemo } from 'react';

/**
 * @what Decides whether a click focuses an image well's contents
 * @how Returns false for empty wells, otherwise whether the node is selected
 * @why Fixture: destructured parameter with an inline object type before the body
 * @param {{ node: { id: string; kind: string }; selected: string[] }} args The clicked node and the selection
 * @returns {boolean} Whether the click focuses the contents
 * @sideeffects None
 * @systemlayer Utility
 * @domain fixture-comments
 * @tags fixture, destructured-params, inline-type
 */
export function shouldFocusContentsOnClick({
  node,
  selected,
}: {
  node: { id: string; kind: string };
  selected: string[];
}): boolean {
  // Empty image wells never enter CONTENTS_FOCUSED, there is nothing to edit yet
  if (node.kind === 'empty') return false;
  return selected.includes(node.id);
}

/**
 * @what Props for the editor
 * @domain fixture-comments
 * @tags fixture, props, interface
 */
interface EditorProps {
  projectId: string;
  items: { id: string }[];
}

/**
 * @what The editor component, wrapped in observer
 * @how Renders a drop-safe container showing the selected asset and target slot
 * @why Fixture: observer(function X({ ...props }: Props) {...}) with comments directly in the body
 * @param {EditorProps} props The project id and items
 * @returns {JSX.Element} The editor container
 * @sideeffects None
 * @systemlayer UI Component
 * @domain fixture-comments
 * @tags fixture, observer-wrapper, react-component
 */
const Editor = observer(function Editor({ projectId, items }: EditorProps) {
  // Swallow accidental OS-file drops so the browser doesn't navigate the tab
  /**
   * @what Cancels a file drop on the editor container
   * @how Calls preventDefault on the drop event
   * @why Fixture: a nested documented handler
   * @param {{ preventDefault(): void }} e The drop event
   * @returns {void}
   * @sideeffects Cancels the browser's default drop navigation
   * @systemlayer UI Helper
   * @domain fixture-comments
   * @tags fixture, nested-documented, event-handler
   */
  const onDrop = (e: { preventDefault(): void }) => {
    // Stop the browser from opening the dropped file
    e.preventDefault();
  };

  const asset = useMemo(function findEditableAssetInSelection() {
    // Prefer explicit selection when present
    return items[0];
  }, [items]);

  // The controls target the SMALLEST slot enclosing the selection:
  // the selected focus area if there is one,
  // otherwise the whole page.
  const targetSlot = useMemo(() => projectId, [projectId]);

  /**
   * @what Navigates to a node
   * @how Returns the node id it was asked to show
   * @why Fixture: a nested documented useCallback whose comments must not repeat under Editor
   * @param {string} id The node to show
   * @returns {string} The node id
   * @sideeffects None
   * @systemlayer UI Helper
   * @domain fixture-comments
   * @tags fixture, nested-documented, use-callback
   */
  const goToNode = useCallback((id: string) => {
    // Scroll the node into view before selecting it
    return id;
  }, []);

  return <div onDrop={onDrop}>{asset?.id}{targetSlot}{goToNode('x')}</div>;
});

/**
 * @what Picks the first item that has an id
 * @how Uses Array.find on the id
 * @why Fixture: a generic whose constraint contains a `{` before the body
 * @param {T[]} items The candidates
 * @returns {T | undefined} The first item with an id
 * @sideeffects None
 * @systemlayer Utility
 * @domain fixture-comments
 * @tags fixture, generics, object-constraint
 */
export function pick<T extends { id: string }>(items: T[]): T | undefined {
  // Pick the first item that has an id
  return items.find(i => i.id);
}

/**
 * @what Doubles a number
 * @how Multiplies by two
 * @why Fixture: an arrow with an expression body and no braces
 * @param {number} n The value
 * @returns {number} Twice the value
 * @sideeffects None
 * @systemlayer Utility
 * @domain fixture-comments
 * @tags fixture, arrow-expression, no-braces
 */
export const double = (n: number) =>
  // Double the input value for display
  n * 2;

/**
 * @what Joins a file path with each name
 * @how Maps names to "path:name" strings (a stand-in body)
 * @why Fixture: a plain signature, the case that already worked
 * @param {string} filePath The file
 * @param {string[]} names The names
 * @returns {string[]} The joined strings
 * @sideeffects None
 * @systemlayer Utility
 * @domain fixture-comments
 * @tags fixture, plain-signature, baseline
 */
export function buildContext(filePath: string, names: string[] = []): string[] {
  // Try semantic search first for better conceptual matching,
  // fall back to FTS if embeddings are unavailable.
  return names.map(n => `${filePath}:${n}`);
}

/**
 * @what A small store class
 * @domain fixture-comments
 * @tags fixture, class, generic-class
 */
export class Store<T extends { id: string }> {
  private items: T[] = [];

  // Items are only ever appended, never reordered
  /**
   * @what Adds an item to the store
   * @how Pushes onto the items array
   * @why Fixture: a documented method nested in a documented class
   * @param {T} item The item
   * @returns {void}
   * @sideeffects Appends to the private items array
   * @systemlayer Utility
   * @domain fixture-comments
   * @tags fixture, class-method, nested-documented
   */
  add(item: T): void {
    // Keep insertion order so the drawer lists items as they were added
    this.items.push(item);
  }
}

/**
 * @what Default-exported drawer component
 * @how Renders an aside when open
 * @why Fixture: export default observer(function X(...) {...})
 * @param {{ open: boolean }} props Whether the drawer is open
 * @returns {JSX.Element | null} The drawer, or nothing
 * @sideeffects None
 * @systemlayer UI Component
 * @domain fixture-comments
 * @tags fixture, export-default, observer-wrapper
 */
export default observer(function Drawer({ open }: { open: boolean }) {
  // Render nothing while the drawer is closed
  return open ? <aside /> : null;
});

export { Editor, React };
