export function merge(intervals) {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const current of sorted) {
    const last = out[out.length - 1];
    if (last && current[0] <= last[1]) {
      out[out.length - 1] = [last[0], current[1]];
    } else {
      out.push([current[0], current[1]]);
    }
  }
  return out;
}
