/** Docker's --mount uses comma-separated fields; --volume keeps commas in host paths literal. */
export function dockerBindArgs(source: string, target: string, readonly = false): string[] {
  if (source.includes(',')) return ['--volume', `${source}:${target}${readonly ? ':ro' : ''}`];
  return ['--mount', `type=bind,source=${source},target=${target}${readonly ? ',readonly' : ''}`];
}
