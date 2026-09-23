import { Pair } from '../nodes/Pair.ts'
import { Scalar } from '../nodes/Scalar.ts'
import type { Node, Range } from '../nodes/types.ts'
import { YAMLMap } from '../nodes/YAMLMap.ts'
import { YAMLSeq } from '../nodes/YAMLSeq.ts'
import { YAMLSet } from '../nodes/YAMLSet.ts'
import type { EditConflict, EditPath, EditPathSegment } from './types.ts'
import { isMergePair, mergedKeys, type Snapshot } from './snapshot.ts'

export interface MapSlot {
  kind: 'map'
  map: YAMLMap | YAMLSet
  /** The matched pair (map) or node (set); undefined when the key is absent */
  pair: Pair | undefined
  /** The matched set item */
  item: Node | undefined
  key: unknown
}

export interface SeqSlot {
  kind: 'seq'
  seq: YAMLSeq
  index: number
  item: Node | Pair | undefined
}

export type Slot = MapSlot | SeqSlot

export interface ResolvedPath {
  /** The parent collection of the final step; the Document root value's parent is null */
  parent: YAMLMap | YAMLSeq | YAMLSet | null
  /** The final step, if the path is non-empty */
  slot: Slot | null
  /** The node at the path (pair value, set item, seq item, or root value) */
  node: Node | null
  /** The pair at the path, when the final step addresses a map entry */
  pair: Pair | null
  conflicts: EditConflict[]
}

const segKey = (seg: EditPathSegment): { ok: true; key: unknown; occurrence?: number } | { ok: false } =>
  typeof seg === 'string'
    ? { ok: true, key: seg }
    : typeof seg === 'object' && seg !== null && 'key' in seg
      ? { ok: true, key: seg.key, occurrence: seg.occurrence }
      : { ok: false }

const segIndex = (seg: EditPathSegment): { ok: true; index: number } | { ok: false } =>
  typeof seg === 'number'
    ? { ok: true, index: seg }
    : typeof seg === 'object' && seg !== null && 'index' in seg
      ? { ok: true, index: seg.index }
      : { ok: false }

export function pathToString(path: EditPath): string {
  if (path.length === 0) return '<root>'
  return path
    .map(seg => {
      if (typeof seg === 'string') return JSON.stringify(seg)
      if (typeof seg === 'number') return `[${seg}]`
      if ('key' in seg)
        return seg.occurrence !== undefined
          ? `${JSON.stringify(seg.key)}#${seg.occurrence}`
          : JSON.stringify(seg.key)
      return `[${seg.index}]`
    })
    .join('.')
}

function findPair(map: YAMLMap | YAMLSet, key: unknown): Pair | undefined {
  if (map instanceof YAMLSet) return undefined
  const mk = map.schema.mapKey(key)
  const direct = map.values.get(mk)
  if (direct instanceof Pair) return direct
  if (key instanceof Scalar || key instanceof Pair) {
    const kn = key instanceof Pair ? key.key : key
    for (const pair of map.values.values() as Iterable<Pair>)
      if (pair.key === kn) return pair
  }
  return undefined
}

function findSetItem(set: YAMLSet, key: unknown): Node | undefined {
  const mk = set.schema.mapKey(key)
  const direct = set.values.get(mk)
  if (direct) return direct as Node
  return undefined
}

/** Count duplicate occurrences of `key` within a map's source. */
function dupRanges(snap: Snapshot, map: YAMLMap | YAMLSet, key: unknown): Range[] {
  const byKey = snap.duplicates.get(snap.ids.get(map)!)
  if (!byKey) return []
  const k = typeof key === 'string' ? key : String(key)
  return byKey.get(k) ?? byKey.get('') ?? []
}

/**
 * Resolve a semantic path against the original snapshot. Resolution never
 * silently picks among duplicate keys and never expands merge keys; both are
 * reported as locatable conflicts.
 */
export function resolvePath(
  snap: Snapshot,
  path: EditPath,
  opIndex: number,
  opts: { allowMissingLast?: boolean } = {}
): ResolvedPath {
  const conflicts: EditConflict[] = []
  let current: Node | null = snap.doc.value
  let parent: YAMLMap | YAMLSeq | YAMLSet | null = null
  let slot: Slot | null = null
  let pair: Pair | null = null

  for (let i = 0; i < path.length; ++i) {
    const seg = path[i]
    const isLast = i === path.length - 1
    const rest: EditPath = path.slice(0, i + 1)

    if (current instanceof YAMLMap || current instanceof YAMLSet) {
      const ks = segKey(seg)
      if (!ks.ok) {
        conflicts.push({
          code: 'INVALID_PATH',
          message: `Cannot index into a ${current instanceof YAMLSet ? 'set' : 'map'} with ${JSON.stringify(seg)}; use a { key } segment`,
          op: opIndex,
          ranges: [current.range]
        })
        return { parent, slot, node: null, pair: null, conflicts }
      }
      const { key, occurrence } = ks
      const foundPair = findPair(current, key)
      const foundItem: Node | undefined = current instanceof YAMLSet ? findSetItem(current, key) : undefined

      if (foundPair && isMergePair(snap, foundPair)) {
        conflicts.push({
          code: 'MERGE_KEY',
          message: `The key ${JSON.stringify(key)} at ${pathToString(rest)} is a merge key (<<); merge keys are never silently picked or expanded`,
          op: opIndex,
          ranges: [foundPair.key?.range, current.range]
        })
        return { parent, slot, node: null, pair: null, conflicts }
      }

      const dups = dupRanges(snap, current, key)
      if (dups.length > 0 && foundPair) {
        if (occurrence === undefined) {
          conflicts.push({
            code: 'DUPLICATE_KEY',
            message: `The key ${JSON.stringify(key)} at ${pathToString(rest)} occurs ${dups.length + 1} times in the source; add an explicit { occurrence } to the path segment to choose among the candidates`,
            op: opIndex,
            ranges: [...dups, foundPair.key?.range]
          })
          return { parent, slot, node: null, pair: null, conflicts }
        }
        // Only the last occurrence survives in the composed document.
        if (occurrence !== dups.length) {
          conflicts.push({
            code: 'DUPLICATE_KEY',
            message: `Occurrence ${occurrence} of key ${JSON.stringify(key)} at ${pathToString(rest)} is not represented in the composed document; only occurrence ${dups.length} (the last) is editable`,
            op: opIndex,
            ranges: [dups[occurrence] ?? dups[dups.length - 1], foundPair.key?.range]
          })
          return { parent, slot, node: null, pair: null, conflicts }
        }
      }

      if (!foundPair && !foundItem) {
        // Never silently expand merge keys: check whether the key only
        // exists via a `<<` merge.
        if (current instanceof YAMLMap) {
          const merged = mergedKeys(snap, current)
          const mk = typeof key === 'string' ? key : undefined
          if (mk !== undefined && merged.has(mk)) {
            conflicts.push({
              code: 'MERGE_KEY',
              message: `The key ${JSON.stringify(key)} at ${pathToString(rest)} is only provided by a merge key (<<); it cannot be addressed directly`,
              op: opIndex,
              ranges: [merged.get(mk), current.range]
            })
            return { parent, slot, node: null, pair: null, conflicts }
          }
        }
        if (!isLast || !opts.allowMissingLast) {
          conflicts.push({
            code: 'PATH_NOT_FOUND',
            message: `No key ${JSON.stringify(key)} at ${pathToString(rest)}`,
            op: opIndex,
            ranges: [current.range]
          })
          return { parent, slot, node: null, pair: null, conflicts }
        }
      }

      parent = current
      slot = { kind: 'map', map: current, pair: foundPair, item: foundItem, key }
      pair = foundPair ?? null
      current = foundPair ? (foundPair.value as Node | null) : (foundItem ?? null)
    } else if (current instanceof YAMLSeq) {
      const si = segIndex(seg)
      if (!si.ok || !Number.isInteger(si.index)) {
        conflicts.push({
          code: 'INVALID_PATH',
          message: `Cannot index into a sequence with ${JSON.stringify(seg)}; use a number or { index } segment`,
          op: opIndex,
          ranges: [current.range]
        })
        return { parent, slot, node: null, pair: null, conflicts }
      }
      let index = si.index
      if (index < 0) index += current.length
      const inBounds: boolean = index >= 0 && index < current.length
      if (!inBounds && !(isLast && opts.allowMissingLast && index >= 0 && index <= current.length)) {
        conflicts.push({
          code: 'PATH_NOT_FOUND',
          message: `Index ${si.index} out of bounds (length ${current.length}) at ${pathToString(rest)}`,
          op: opIndex,
          ranges: [current.range]
        })
        return { parent, slot, node: null, pair: null, conflicts }
      }
      parent = current
      const item: Node | Pair | undefined = inBounds ? (current[index] as Node | Pair) : undefined
      slot = { kind: 'seq', seq: current, index, item }
      pair = null
      current = (item as Node) ?? null
    } else {
      const what = current === null ? 'an empty value' : current instanceof Scalar ? 'a scalar' : 'an alias'
      conflicts.push({
        code: 'PATH_NOT_FOUND',
        message: `Cannot descend into ${what} at ${pathToString(rest)}`,
        op: opIndex,
        ranges: [current?.range]
      })
      return { parent, slot, node: null, pair: null, conflicts }
    }
  }

  return { parent, slot, node: current, pair, conflicts }
}
