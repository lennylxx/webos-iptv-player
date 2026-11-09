// What hide mode conceals in one account's movie or series catalog, small
// enough to send to the worker that filters the catalog for Search.
export interface CatalogConcealment {
  sourceApproved: boolean;
  lockedCategories: string[];
  allowedItems: string[];
  protectedItems: string[];
  /** Whether an item without a category is locked. */
  uncategorizedLocked: boolean;
}

export type CatalogConcealmentTest = (id: string, categoryId: string) => boolean;

// Mirrors ParentalControlService.ruleDecision for a catalog item.
export function catalogConcealmentTest(rules: CatalogConcealment | null): CatalogConcealmentTest {
  if (!rules) return () => false;
  const locked = new Set(rules.lockedCategories);
  const allowed = new Set(rules.allowedItems);
  const protectedItems = new Set(rules.protectedItems);
  return (id, categoryId) => {
    if (allowed.has(id)) return false;
    if (protectedItems.has(id)) return true;
    if (!categoryId) return rules.uncategorizedLocked;
    return !rules.sourceApproved || locked.has(categoryId);
  };
}

export function sameCatalogConcealment(
  left: CatalogConcealment | null,
  right: CatalogConcealment | null,
): boolean {
  if (!left || !right) return left === right;
  return left.sourceApproved === right.sourceApproved
    && left.uncategorizedLocked === right.uncategorizedLocked
    && sameList(left.lockedCategories, right.lockedCategories)
    && sameList(left.allowedItems, right.allowedItems)
    && sameList(left.protectedItems, right.protectedItems);
}

function sameList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
