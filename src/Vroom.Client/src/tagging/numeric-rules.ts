export function rangeCases(fact: string, boundaries: number[], values: unknown[], factor = 1) {
  if (
    !values.length ||
    boundaries.length !== values.length - 1 ||
    !Number.isFinite(factor) ||
    factor <= 0 ||
    boundaries.some((v, i) => !Number.isFinite(v) || v <= (i ? boundaries[i - 1] : 0))
  )
    return undefined;
  return values.map((value, i) => ({
    id: crypto.randomUUID(),
    value,
    when: {
      op: 'and',
      args: [
        { op: 'gte', args: [{ fact }, { literal: (i ? boundaries[i - 1] : 0) * factor }] },
        ...(i < boundaries.length ? [{ op: 'lt', args: [{ fact }, { literal: boundaries[i] * factor }] }] : []),
      ],
    },
  }));
}
