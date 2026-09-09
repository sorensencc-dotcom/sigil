function labelsKey(labels = {}) {
  return Object.keys(labels).sort().map((key) => `${key}=${String(labels[key])}`).join(',');
}

export function createRelayMetrics() {
  const values = new Map();
  const observations = new Map();
  const key = (name, labels) => `${name}{${labelsKey(labels)}}`;
  return Object.freeze({
    increment(name, amount = 1, labels = {}) {
      const metricKey = key(name, labels);
      values.set(metricKey, (values.get(metricKey) ?? 0) + amount);
    },
    observe(name, value, labels = {}) {
      const metricKey = key(name, labels);
      const series = observations.get(metricKey) ?? [];
      series.push(value);
      observations.set(metricKey, series);
    },
    set(name, value, labels = {}) { values.set(key(name, labels), value); },
    snapshot() {
      return {
        counters: Object.fromEntries(values),
        observations: Object.fromEntries([...observations].map(([metricKey, series]) => [metricKey, [...series]])),
      };
    },
  });
}
