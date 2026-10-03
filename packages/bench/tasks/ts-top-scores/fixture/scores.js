// Return the top `n` scores, highest first, as a NEW array.
// The caller's array must come out of this call unchanged.
export function topScores(scores, n) {
  scores.sort((a, b) => b - a);
  return scores.slice(0, n);
}
