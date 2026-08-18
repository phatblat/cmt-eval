// Model catalog and pricing, sourced from `omp models --json`.

export type ModelCost = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type ModelInfo = {
  provider: string;
  id: string;
  selector: string;
  thinking: string[] | null;
  cost: ModelCost;
};

export type TokenTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

type RawModel = {
  provider: string;
  id: string;
  selector: string;
  thinking: string[] | null;
  cost: ModelCost;
};

export async function catalog(): Promise<Map<string, ModelInfo>> {
  const proc = Bun.spawn({
    cmd: ["omp", "models", "--json"],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: undefined },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`omp models --json exited ${exitCode}: ${stderr.trim()}`);
  }
  let parsed: { models: RawModel[] };
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`omp models --json produced invalid JSON: ${(err as Error).message}`);
  }
  const map = new Map<string, ModelInfo>();
  for (const m of parsed.models) {
    map.set(m.selector, {
      provider: m.provider,
      id: m.id,
      selector: m.selector,
      thinking: m.thinking,
      cost: m.cost,
    });
  }
  return map;
}

// Catalog prices are USD per 1,000,000 tokens.
export function priceRun(m: ModelInfo, t: TokenTotals): number {
  const perToken = (rate: number, count: number) => (rate / 1_000_000) * count;
  return (
    perToken(m.cost.input, t.input) +
    perToken(m.cost.output, t.output) +
    perToken(m.cost.cacheRead, t.cacheRead) +
    perToken(m.cost.cacheWrite, t.cacheWrite)
  );
}

export function isPriced(m: ModelInfo): boolean {
  return m.cost.input !== 0 || m.cost.output !== 0 || m.cost.cacheRead !== 0 || m.cost.cacheWrite !== 0;
}
