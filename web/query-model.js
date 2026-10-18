/** DOM-free helpers, shared by views and reproducible performance probes. */
export function topTypes(types, scoreOf, limit = 12) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('limit must be a nonnegative integer');
  if (!limit) return [];
  const heap = [];
  const worse = (a, b) => a.score < b.score || (a.score === b.score && a.order > b.order);
  const sink = () => {
    let index = 0;
    while (index * 2 + 1 < heap.length) {
      let child = index * 2 + 1;
      if (child + 1 < heap.length && worse(heap[child + 1], heap[child])) child++;
      if (!worse(heap[child], heap[index])) break;
      [heap[index], heap[child]] = [heap[child], heap[index]];
      index = child;
    }
  };
  let order = 0;
  for (const type of types) {
    const item = { type, score: scoreOf(type), order: order++ };
    if (heap.length < limit) {
      heap.push(item);
      let index = heap.length - 1;
      while (index > 0) {
        const parent = (index - 1) >> 1;
        if (!worse(heap[index], heap[parent])) break;
        [heap[index], heap[parent]] = [heap[parent], heap[index]];
        index = parent;
      }
    } else if (worse(heap[0], item)) { heap[0] = item; sink(); }
  }
  return heap.sort((a, b) => b.score - a.score || a.order - b.order).map((item) => item.type);
}

export function createVisibleTypeCache() {
  let bundle, key, visible;
  return (state, matches) => {
    const next = JSON.stringify([state.q, [...state.kinds].sort(), state.langs && [...state.langs].sort(),
      state.minCode, state.hideGenerated, state.depFocus, state.depFocus ? state.selected : null]);
    if (bundle !== state.bundle || key !== next) {
      visible = Object.freeze(state.bundle.types.filter(matches));
      bundle = state.bundle; key = next;
    }
    return visible;
  };
}
