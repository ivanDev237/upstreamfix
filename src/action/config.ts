export interface ActionConfig {
  frequency: 'daily' | 'weekly' | 'manual';
  ignore: string[];
  exclude: string[];
  verify: string[];
  reviewers: string[];
  labels: string[];
  experimental: string[];
}

const defaults: ActionConfig = {
  frequency: 'daily', ignore: [], exclude: [], verify: [], reviewers: [], labels: [], experimental: [],
};
const lists = new Set<keyof ActionConfig>(['ignore', 'exclude', 'verify', 'reviewers', 'labels', 'experimental']);

/** A deliberately small, auditable YAML subset. Unsupported YAML features fail closed. */
export function parseActionConfig(source: string): ActionConfig {
  if (source.length > 16_384) throw new Error('.upstreamfix.yml exceeds 16 KiB.');
  const config: ActionConfig = { ...defaults, ignore: [], exclude: [], verify: [], reviewers: [], labels: [], experimental: [] };
  let active: keyof ActionConfig | undefined;
  const seen = new Set<string>();
  for (const [index, raw] of source.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    const line = raw.replace(/\s+$/, '');
    if (!line || /^\s*#/.test(line)) continue;
    if (/\t|[&*{}[\]!>|]/.test(line)) throw new Error(`Unsupported YAML syntax at .upstreamfix.yml:${index + 1}.`);
    const heading = /^([a-z][a-zA-Z]*):(?:\s*(.*))?$/.exec(line);
    if (heading) {
      const key = heading[1]!;
      if (!['frequency', ...lists].includes(key)) throw new Error(`Unknown .upstreamfix.yml key "${key}" at line ${index + 1}.`);
      if (seen.has(key)) throw new Error(`Duplicate .upstreamfix.yml key "${key}".`);
      seen.add(key);
      active = key as keyof ActionConfig;
      const value = heading[2]?.trim() ?? '';
      if (key === 'frequency') {
        if (!['daily', 'weekly', 'manual'].includes(value)) throw new Error('frequency must be daily, weekly or manual.');
        config.frequency = value as ActionConfig['frequency'];
        active = undefined;
      } else if (value) {
        throw new Error(`${key} must be a YAML list, one item per line; it cannot disable verification or permissions.`);
      }
      continue;
    }
    const item = /^  - (.+)$/.exec(line);
    if (!item || !active || !lists.has(active)) throw new Error(`Invalid .upstreamfix.yml item at line ${index + 1}.`);
    const value = item[1]!.trim();
    if (!value || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`Invalid ${active} value at line ${index + 1}.`);
    const values = config[active] as string[];
    if (values.length >= 20) throw new Error(`${active} has too many values (maximum 20).`);
    if (values.includes(value)) throw new Error(`Duplicate ${active} value: ${value}.`);
    if (active === 'ignore' && !/^[a-z0-9][a-z0-9._-]*@\d+$/i.test(value)) throw new Error(`Invalid ignore migration: ${value}.`);
    if (active === 'experimental' && value !== 'openai@5') throw new Error(`Unsupported experimental migration: ${value}.`);
    if (active === 'exclude' && (!/^[A-Za-z0-9._/-]+$/.test(value) || value.startsWith('/') || value.split('/').some((part) => part === '..' || part === '.' || part === '.git' || !part))) {
      throw new Error(`Invalid exclude path: ${value}.`);
    }
    if (active === 'reviewers' && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value)) throw new Error(`Invalid reviewer: ${value}.`);
    if (active === 'labels' && !/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,49}$/.test(value)) throw new Error(`Invalid label: ${value}.`);
    if (active === 'labels' && /(?:auto[ _.-]*merge|merge[ _.-]*queue|merge[ _.-]*when[ _.-]*ready)/i.test(value)) {
      throw new Error(`The label ${value} could trigger an automatic merge policy.`);
    }
    if (active === 'verify' && value.length > 200) throw new Error('verify command is too long.');
    values.push(value);
  }
  return config;
}

export function shouldRunOnSchedule(frequency: ActionConfig['frequency'], now = new Date()): boolean {
  return frequency === 'daily' || (frequency === 'weekly' && now.getUTCDay() === 1);
}
