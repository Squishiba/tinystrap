export function dedupe(arr) {
  const out = [];
  for (let i = 1; i < arr.length; i++) {
    if (!out.includes(arr[i])) out.push(arr[i]);
  }
  return out;
}