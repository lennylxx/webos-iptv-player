// Whether `target` is reachable from `root` through object properties, array
// items, and Map/Set entries: what a heap snapshot would show as retained,
// short of closures and DOM nodes, which this cannot or need not follow.
export function retains(root: object, target: object): boolean {
  const seen = new Set<object>();
  const stack: unknown[] = [root];
  while (stack.length) {
    const value = stack.pop();
    if (value === target) return true;
    if (value === null || typeof value !== 'object' || value === globalThis || seen.has(value)) continue;
    if ((typeof Node !== 'undefined' && value instanceof Node) || ArrayBuffer.isView(value)) continue;
    seen.add(value);
    if (value instanceof Map) {
      value.forEach((item, key) => stack.push(key, item));
    } else if (value instanceof Set) {
      value.forEach(item => stack.push(item));
    }
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && 'value' in descriptor) stack.push(descriptor.value);
    }
  }
  return false;
}
