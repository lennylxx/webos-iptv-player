// Whether two catalog lists hold the same items, field for field, in order.
export function sameCatalogItems<T extends object>(left: T[], right: T[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    const keys = Object.keys(left[i]) as Array<keyof T>;
    if (keys.length !== Object.keys(right[i]).length) return false;
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(right[i], key) || left[i][key] !== right[i][key]) {
        return false;
      }
    }
  }
  return true;
}
