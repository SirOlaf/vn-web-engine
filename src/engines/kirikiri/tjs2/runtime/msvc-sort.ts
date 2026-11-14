/**
 * `std::sort` and `std::stable_sort` of the Visual C++ 2012/2013 standard library, which the
 * reference core is built with. `Array.sort` exposes the algorithm: the order of elements that
 * compare equal after an unstable sort, and the sequence of comparator calls a script
 * comparator observes.
 *
 * `less(a, b)` is the strict weak ordering predicate; it may throw, leaving the array
 * partially sorted as natively.
 */

const ISORT_MAX = 32;

export function msvcSort<T>(a: T[], less: (x: T, y: T) => boolean): void {
  sortRange(a, 0, a.length, a.length, less);
}

function sortRange<T>(
  a: T[],
  first: number,
  last: number,
  ideal: number,
  less: (x: T, y: T) => boolean,
): void {
  let count: number;
  for (; ISORT_MAX < (count = last - first) && 0 < ideal;) {
    const [midFirst, midLast] = unguardedPartition(a, first, last, less);
    ideal = Math.trunc(ideal / 2);
    ideal += Math.trunc(ideal / 2); // allow 1.5 log2(N) divisions
    if (midFirst - first < last - midLast) {
      sortRange(a, first, midFirst, ideal, less);
      first = midLast;
    } else {
      sortRange(a, midLast, last, ideal, less);
      last = midFirst;
    }
  }
  if (ISORT_MAX < count) {
    makeHeap(a, first, last, less);
    sortHeap(a, first, last, less);
  } else if (1 < count) insertionSort(a, first, last, less);
}

function swap<T>(a: T[], i: number, j: number): void {
  const t = a[i]!;
  a[i] = a[j]!;
  a[j] = t;
}

function med3<T>(
  a: T[],
  first: number,
  mid: number,
  last: number,
  less: (x: T, y: T) => boolean,
): void {
  if (less(a[mid]!, a[first]!)) swap(a, mid, first);
  if (less(a[last]!, a[mid]!)) {
    swap(a, last, mid);
    if (less(a[mid]!, a[first]!)) swap(a, mid, first);
  }
}

function median<T>(
  a: T[],
  first: number,
  mid: number,
  last: number,
  less: (x: T, y: T) => boolean,
): void {
  if (40 < last - first) {
    const step = Math.trunc((last - first + 1) / 8);
    med3(a, first, first + step, first + 2 * step, less);
    med3(a, mid - step, mid, mid + step, less);
    med3(a, last - 2 * step, last - step, last, less);
    med3(a, first + step, mid, last - step, less);
  } else med3(a, first, mid, last, less);
}

function unguardedPartition<T>(
  a: T[],
  first: number,
  last: number,
  less: (x: T, y: T) => boolean,
): [number, number] {
  const mid = first + Math.trunc((last - first) / 2);
  median(a, first, mid, last - 1, less);
  let pfirst = mid;
  let plast = pfirst + 1;

  while (first < pfirst && !less(a[pfirst - 1]!, a[pfirst]!) && !less(a[pfirst]!, a[pfirst - 1]!))
    --pfirst;
  while (plast < last && !less(a[plast]!, a[pfirst]!) && !less(a[pfirst]!, a[plast]!)) ++plast;

  let gfirst = plast;
  let glast = pfirst;

  for (;;) {
    for (; gfirst < last; ++gfirst) {
      if (less(a[pfirst]!, a[gfirst]!)) continue;
      else if (less(a[gfirst]!, a[pfirst]!)) break;
      else if (plast++ !== gfirst) swap(a, plast - 1, gfirst);
    }
    for (; first < glast; --glast) {
      if (less(a[glast - 1]!, a[pfirst]!)) continue;
      else if (less(a[pfirst]!, a[glast - 1]!)) break;
      else if (--pfirst !== glast - 1) swap(a, pfirst, glast - 1);
    }
    if (glast === first && gfirst === last) return [pfirst, plast];

    if (glast === first) {
      // no room at bottom, rotate pivot upward
      if (plast !== gfirst) swap(a, pfirst, plast);
      ++plast;
      swap(a, pfirst++, gfirst++);
    } else if (gfirst === last) {
      // no room at top, rotate pivot downward
      if (--glast !== --pfirst) swap(a, glast, pfirst);
      swap(a, pfirst, --plast);
    } else swap(a, gfirst++, --glast);
  }
}

function insertionSort<T>(
  a: T[],
  first: number,
  last: number,
  less: (x: T, y: T) => boolean,
): void {
  if (first === last) return;
  for (let next = first; ++next !== last;) {
    let next1 = next;
    const val = a[next]!;
    if (less(val, a[first]!)) {
      // new earliest element: move the range up by one
      for (let i = next; i > first; i--) a[i] = a[i - 1]!;
      a[first] = val;
    } else {
      for (let first1 = next1; less(val, a[--first1]!); next1 = first1) a[next1] = a[first1]!;
      a[next1] = val;
    }
  }
}

function pushHeap<T>(
  a: T[],
  base: number,
  hole: number,
  top: number,
  val: T,
  less: (x: T, y: T) => boolean,
): void {
  for (
    let idx = Math.trunc((hole - 1) / 2);
    top < hole && less(a[base + idx]!, val);
    idx = Math.trunc((hole - 1) / 2)
  ) {
    a[base + hole] = a[base + idx]!;
    hole = idx;
  }
  a[base + hole] = val;
}

function adjustHeap<T>(
  a: T[],
  base: number,
  hole: number,
  bottom: number,
  val: T,
  less: (x: T, y: T) => boolean,
): void {
  const top = hole;
  let idx = 2 * hole + 2;
  for (; idx < bottom; idx = 2 * idx + 2) {
    if (less(a[base + idx]!, a[base + idx - 1]!)) --idx;
    a[base + hole] = a[base + idx]!;
    hole = idx;
  }
  if (idx === bottom) {
    a[base + hole] = a[base + bottom - 1]!;
    hole = bottom - 1;
  }
  pushHeap(a, base, hole, top, val, less);
}

function makeHeap<T>(a: T[], first: number, last: number, less: (x: T, y: T) => boolean): void {
  const bottom = last - first;
  for (let hole = Math.trunc(bottom / 2); 0 < hole;) {
    --hole;
    adjustHeap(a, first, hole, bottom, a[first + hole]!, less);
  }
}

function sortHeap<T>(a: T[], first: number, last: number, less: (x: T, y: T) => boolean): void {
  for (; 1 < last - first; --last) {
    const val = a[last - 1]!;
    a[last - 1] = a[first]!;
    adjustHeap(a, first, 0, last - 1 - first, val, less);
  }
}

/**
 * `std::stable_sort`: chunks of 32 by insertion sort, then pairwise merges. The result is
 * the stable order; the comparator call sequence follows the buffered merge sort.
 */
export function msvcStableSort<T>(a: T[], less: (x: T, y: T) => boolean): void {
  const n = a.length;
  for (let i = 0; i < n; i += ISORT_MAX) insertionSort(a, i, Math.min(i + ISORT_MAX, n), less);
  const tmp = new Array<T>(n);
  for (let width = ISORT_MAX; width < n; width *= 2) {
    for (let lo = 0; lo < n; lo += 2 * width) {
      const mid = Math.min(lo + width, n),
        hi = Math.min(lo + 2 * width, n);
      let i = lo,
        j = mid,
        k = lo;
      while (i < mid && j < hi) tmp[k++] = less(a[j]!, a[i]!) ? a[j++]! : a[i++]!;
      while (i < mid) tmp[k++] = a[i++]!;
      while (j < hi) tmp[k++] = a[j++]!;
      for (let m = lo; m < hi; m++) a[m] = tmp[m]!;
    }
  }
}
