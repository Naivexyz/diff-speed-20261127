// Fast drop-in for makefun-diff 1.0.0's diffPatch, written from the rule in its header.
// Returns exactly the same patch string for every input, faster:
//  - lines are interned to integer ids (one shared Map per case), so every line
//    comparison in the search is one integer === instead of a string compare;
//  - the common prefix/suffix are trimmed on the integer arrays;
//  - Myers's greedy search runs on the integer arrays, storing every level's
//    furthest-x vector (Uint16Array while the trimmed lengths fit in 16 bits,
//    Int32Array otherwise; a sentinel marks no path) so the exact script can be
//    rebuilt by backtracking with the same rule (deletion wins a tie, no move
//    past either end, no edge-diagonal pruning, snakes walked to the end);
//  - the patch is built straight from the runs, without per-line objects.

const FORMAT = 'makefun-diff/1';
const CONTEXT = 3;
const KEEP = 0;
const DEL = 1;
const INS = 2;
/** Added to a bare last line's id, so a line "x" with no newline differs from "x\n". */
const BARE = 1 << 28;

/** One text, split into lines and interned: ids, the split parts, and whether the last line is bare. */
function tokenize(text, intern) {
  const parts = text.split('\n');
  const last = parts.length - 1;
  const bare = parts[last] !== '';
  const n = bare ? parts.length : last;
  const ids = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let id = intern.get(parts[i]);
    if (id === undefined) {
      id = intern.size;
      intern.set(parts[i], id);
    }
    ids[i] = i === last && bare ? id + BARE : id;
  }
  return { ids, parts, bare, n };
}

/**
 * The edit script of the trimmed region a[0..na) into b[0..nb), as merged runs
 * { kinds: number[], counts: number[] } in forward order, kinds KEEP/DEL/INS.
 * Exactly the reference's script: same iteration order, same tie-break.
 *
 * Every level's furthest-x vector is kept for the backtrack. A level d is a
 * typed array of length 2d+5, diagonal k at index k+d+2, the two slots at each
 * end holding NONE so the neighbours of the edge diagonals read as no path
 * without a bounds check. x values fit in 16 bits while na, nb < 65535, so
 * that case uses Uint16Array (half the memory traffic); larger inputs fall
 * back to Int32Array.
 */
function myersRuns(a, b, na, nb) {
  const use16 = na < 65535 && nb < 65535;
  const Ctor = use16 ? Uint16Array : Int32Array;
  const NONE = use16 ? 0xffff : -1;
  const BYTES = use16 ? 2 : 4;
  const Vs = [];
  // Levels are views into a few large chunks, not one allocation each: a case
  // needs ~D^2 elements, and thousands of separate ArrayBuffers cost the
  // kernel (and the GC) far more than a handful of chunks.
  const CHUNK = 1 << 22;
  let chunk = new Ctor(CHUNK);
  let chunkOff = 0;
  const allocLevel = (len) => {
    if (chunkOff + len > CHUNK) {
      chunk = new Ctor(CHUNK);
      chunkOff = 0;
    }
    const v = new Ctor(chunk.buffer, chunkOff * BYTES, len);
    chunkOff += len;
    return v;
  };
  // d = 0: the snake from (0, 0).
  let x = 0;
  const lim0 = na < nb ? na : nb;
  while (x < lim0 && a[x] === b[x]) x++;
  const v0 = allocLevel(5);
  v0[0] = NONE;
  v0[1] = NONE;
  v0[2] = x;
  v0[3] = NONE;
  v0[4] = NONE;
  Vs.push(v0);
  let D = 0;
  let kEnd = 0;
  let reached = x >= na && x >= nb;
  // The snake's limit is min(na, nb + k): below k = na - nb it is nb + k,
  // above it na. The loop is split at that k so neither range recomputes it,
  // and the limit lets the JIT prove both snake loads in bounds.
  const kCap = na - nb;
  if (!reached) {
    outer: for (let d = 1; d <= na + nb; d++) {
      const prev = Vs[d - 1];
      const cur = allocLevel(2 * d + 5);
      cur[0] = NONE;
      cur[1] = NONE;
      cur[2 * d + 3] = NONE;
      cur[2 * d + 4] = NONE;
      Vs.push(cur);
      let limx = nb - d;
      let k = -d;
      const kAEnd = kCap < d ? kCap : d;
      for (; k < kAEnd; k += 2) {
        const j = k + d + 2;
        const rm = prev[j - 2];
        const ad = prev[j];
        let xx;
        if (rm !== NONE && rm < na && (ad === NONE || ad - k > nb || rm >= ad - 1)) xx = rm + 1;
        else if (ad !== NONE && ad - k <= nb) xx = ad;
        else {
          cur[j] = NONE;
          limx += 2;
          continue;
        }
        while (xx < limx && a[xx] === b[xx - k]) xx++;
        cur[j] = xx;
        if (xx >= na && xx - k >= nb) {
          D = d;
          kEnd = k;
          reached = true;
          break outer;
        }
        limx += 2;
      }
      for (; k <= d; k += 2) {
        const j = k + d + 2;
        const rm = prev[j - 2];
        const ad = prev[j];
        let xx;
        if (rm !== NONE && rm < na && (ad === NONE || ad - k > nb || rm >= ad - 1)) xx = rm + 1;
        else if (ad !== NONE && ad - k <= nb) xx = ad;
        else {
          cur[j] = NONE;
          continue;
        }
        while (xx < na && a[xx] === b[xx - k]) xx++;
        cur[j] = xx;
        if (xx >= na && xx - k >= nb) {
          D = d;
          kEnd = k;
          reached = true;
          break outer;
        }
      }
    }
    if (!reached) throw new Error('makefun-diff: the search ended without reaching both ends');
  }
  // Backtrack from (D, kEnd), recomputing each level's choice from Vs[d - 1].
  const rk = [];
  const rc = [];
  x = Vs[D][kEnd + D + 2];
  let d = D;
  let k = kEnd;
  while (d > 0) {
    const prev = Vs[d - 1];
    const j = k + d + 2;
    const rm = prev[j - 2];
    const ad = prev[j];
    let kind;
    let xBefore;
    let pk;
    if (rm !== NONE && rm < na && (ad === NONE || ad - k > nb || rm >= ad - 1)) {
      kind = DEL;
      xBefore = rm + 1;
      pk = k - 1;
    } else {
      kind = INS;
      xBefore = ad;
      pk = k + 1;
    }
    if (x > xBefore) {
      rk.push(KEEP);
      rc.push(x - xBefore);
    }
    rk.push(kind);
    rc.push(1);
    x = kind === DEL ? rm : ad;
    k = pk;
    d--;
  }
  if (x > 0) {
    rk.push(KEEP);
    rc.push(x);
  }
  // Reverse and merge adjacent runs of the same kind.
  const kinds = [];
  const counts = [];
  for (let i = rk.length - 1; i >= 0; i--) {
    const kind = rk[i];
    const count = rc[i];
    if (kinds.length > 0 && kinds[kinds.length - 1] === kind) counts[counts.length - 1] += count;
    else {
      kinds.push(kind);
      counts.push(count);
    }
  }
  return { kinds, counts };
}

/** A line as the patch writes it: op + line, a newline, and "%" on its own line when it had none. */
function pushLine(out, op, part, bare) {
  if (bare) out.push(op + part + '\n%\n');
  else out.push(op + part + '\n');
}

/** makefun-diff 1.0.0's answer for one case's input. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const intern = new Map();
  const A = tokenize(input.old, intern);
  const B = tokenize(input.new, intern);
  const a = A.ids;
  const b = B.ids;
  const n = A.n;
  const m = B.n;
  let prefix = 0;
  while (prefix < n && prefix < m && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && a[n - 1 - suffix] === b[m - 1 - suffix]) suffix++;
  const na = n - prefix - suffix;
  const nb = m - prefix - suffix;
  const mid = myersRuns(a.subarray(prefix, n - suffix), b.subarray(prefix, m - suffix), na, nb);

  // The full run list: prefix keep, the middle runs, suffix keep.
  const kinds = [];
  const counts = [];
  const addRun = (kind, count) => {
    if (count <= 0) return;
    if (kinds.length > 0 && kinds[kinds.length - 1] === kind) counts[counts.length - 1] += count;
    else {
      kinds.push(kind);
      counts.push(count);
    }
  };
  addRun(KEEP, prefix);
  for (let i = 0; i < mid.kinds.length; i++) addRun(mid.kinds[i], mid.counts[i]);
  addRun(KEEP, suffix);

  // The change runs: each a stretch of deletions and insertions between two kept lines.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (let i = 0; i < kinds.length; i++) {
    const kind = kinds[i];
    const count = counts[i];
    if (kind === KEEP) {
      o += count;
      p += count;
      continue;
    }
    let c = changes.length > 0 ? changes[changes.length - 1] : undefined;
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (kind === DEL) {
      c.dels += count;
      o += count;
      deleted += count;
    } else {
      c.ins += count;
      p += count;
      inserted += count;
    }
  }

  // The hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks.length > 0 ? hunks[hunks.length - 1] : undefined;
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }
  const out = [`${FORMAT} old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  const aParts = A.parts;
  const bParts = B.parts;
  const aLast = A.parts.length - 1;
  const bLast = B.parts.length - 1;
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) pushLine(out, '=', aParts[at], A.bare && at === aLast);
      for (let i = 0; i < c.dels; i++) pushLine(out, '-', aParts[c.o + i], A.bare && c.o + i === aLast);
      for (let i = 0; i < c.ins; i++) pushLine(out, '+', bParts[c.p + i], B.bare && c.p + i === bLast);
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) pushLine(out, '=', aParts[at], A.bare && at === aLast);
  }
  return out.join('');
}
