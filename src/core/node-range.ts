/** Conservative check that every supported arm of an engines.node range starts at or above a required major. */
export function guaranteesNodeMajor(range: string, minimum: number): boolean {
  const arms = range.trim().split(/\s*\|\|\s*/);
  return arms.length > 0 && arms.every((arm) => {
    const parts = arm.trim().replace(/^(>=|>|\^|~)\s+(?=\d)/, '$1').split(/\s+/);
    const first = /^(>=|>|\^|~)?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/.exec(parts[0] ?? '');
    if (!first) return false;
    const major = Number(first[2]);
    if (major < minimum) return false;
    if (parts.length === 1) return true;
    return parts.slice(1).every((part) => {
      const bound = /^(<|<=)(\d+)(?:\.\d+){0,2}$/.exec(part);
      return Boolean(bound && Number(bound[2]) > minimum);
    });
  });
}
