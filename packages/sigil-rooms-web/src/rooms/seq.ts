export function toSeq(value: string | number): bigint {
  return BigInt(value);
}

export function maxSeq(values: Array<string | number>): string {
  let max = 0n;
  for (const value of values) {
    const seq = toSeq(value);
    if (seq > max) max = seq;
  }
  return max.toString();
}
