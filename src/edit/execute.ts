import { Document, type DocValue } from '../doc/Document.ts'
import { Alias } from '../nodes/Alias.ts'
import { isCollection } from '../nodes/identity.ts'
import { Pair } from '../nodes/Pair.ts'
import { Scalar } from '../nodes/Scalar.ts'
import type { Node, Range } from '../nodes/types.ts'
import { YAMLMap } from '../nodes/YAMLMap.ts'
import { YAMLSeq } from '../nodes/YAMLSeq.ts'
import { YAMLSet } from '../nodes/YAMLSet.ts'
import type { ToStringOptions } from '../options.ts'
import { parseDocument } from '../public-api.ts'
import {
  createStringifyContext,
  stringify,
  type StringifyContext
} from '../stringify/stringify.ts'
import { stringifyDocument } from '../stringify/stringifyDocument.ts'
import { stringifyPair } from '../stringify/stringifyPair.ts'
import type { Effect, PlanInternal } from './internal.ts'
import { walkEditNodes, type EditNode, type Snapshot } from './snapshot.ts'
import type { EditConflict, EditRewrite } from './types.ts'

interface Region {
  /** Span in the original source */
  span: [number, number]
  /** Node/pair in the mutated clone to stringify; null for full-document */
  clone: EditNode | null
  /** Original snapshot node id whose span is used; -1 for full document */
  origNodeId: number
  isPair: boolean
  stripFirstItem: boolean
  indentCol: number
  reason: string
  effectIdx: number[]
  fullDoc?: boolean
}

const trimEnd = (source: string, end: number, start: number): number => {
  while (end > start && (source[end - 1] === '\n' || source[end - 1] === '\r'))
    end -= 1
  return end
}

const lineCol = (source: string, offset: number): number => {
  const nl = source.lastIndexOf('\n', offset - 1)
  return offset - (nl + 1)
}

function nodeSpan(source: string, node: Node): [number, number] | null {
  const range = node.range
  if (!range) return null
  if (isCollection(node)) {
    const flow = node.flow === true
    return [range[0], flow ? range[1] : trimEnd(source, range[2], range[0])]
  }
  return [range[0], range[1]]
}

function pairSpan(source: string, pair: Pair): [number, number] | null {
  const key = pair.key as Node
  if (!key?.range) return null
  const start = key.range[0]
  const value = pair.value as Node | null
  if (value?.range) return [start, trimEnd(source, value.range[2], start)]
  return [start, trimEnd(source, key.range[2], start)]
}

function firstItemOf(coll: YAMLMap | YAMLSeq | YAMLSet): Node | null {
  if (coll instanceof YAMLSeq) return (coll[0] as Node) ?? null
  for (const item of coll.values.values()) {
    if (item instanceof Pair) return item.key as Node
    return item as Node
  }
  return null
}

function copyComments(from: Node, to: Node): void {
  if (to.comment == null && from.comment != null) to.comment = from.comment
  if (to.commentBefore == null && from.commentBefore != null)
    to.commentBefore = from.commentBefore
  if (to.spaceBefore == null && from.spaceBefore != null)
    to.spaceBefore = from.spaceBefore
}

function joinComments(a: string | null | undefined, b: string | null | undefined): string | null {
  if (a == null || a === '') return b ?? null
  if (b == null || b === '') return a
  return `${b}\n${a}`
}

// ---------------------------------------------------------------------------
// Simulation: apply all effects to a clone of the document
// ---------------------------------------------------------------------------

interface SeqEdits {
  removals: Set<EditNode>
  insertions: Array<{ origIndex: number; node: EditNode }>
}

export function simulate(
  internal: PlanInternal
): { clone: Document; cloneNodes: EditNode[]; toClone?: Document; toCloneNodes?: EditNode[]; conflicts: EditConflict[] } {
  const { snap, effects, toSnap, toDoc } = internal
  const conflicts: EditConflict[] = []

  const clone = snap.doc.clone()
  const cloneNodes = walkEditNodes(clone)
  if (cloneNodes.length !== snap.nodes.length)
    throw new Error('Document structure changed since plan creation')

  let toClone: Document | undefined
  let toCloneNodes: EditNode[] | undefined
  if (toSnap && toDoc) {
    toClone = toDoc.clone()
    toCloneNodes = walkEditNodes(toClone)
    if (toCloneNodes.length !== toSnap.nodes.length)
      throw new Error('Move target document structure changed since plan creation')
  }

  const nodeFor = (id: number, crossDoc = false): EditNode =>
    (crossDoc ? toCloneNodes! : cloneNodes)[id]

  const seqEdits = new Map<YAMLSeq, SeqEdits & { doc: Document }>()
  const seqEditFor = (seq: YAMLSeq, doc: Document) => {
    let se = seqEdits.get(seq)
    if (!se) {
      se = { removals: new Set(), insertions: [], doc }
      seqEdits.set(seq, se)
    }
    return se
  }

  const createValue = (
    doc: Document,
    value: unknown,
    effect: Effect
  ): Node | null => {
    try {
      return doc.createNode(value)
    } catch (error) {
      conflicts.push({
        code: 'CREATE_NODE_FAILED',
        message: `createNode failed for op ${effect.opIndex}: ${(error as Error).message}`,
        op: effect.opIndex,
        ranges: [effect.range]
      })
      return null
    }
  }

  const findMapKey = (map: YAMLMap | YAMLSet, pair: Pair): unknown => {
    for (const [mk, p] of map.values) if (p === pair) return mk
    return undefined
  }

  const transferCommentsToNext = (
    coll: YAMLMap | YAMLSeq | YAMLSet,
    removedKeyOrItem: Node,
    effect: Effect
  ): void => {
    const cb = removedKeyOrItem.commentBefore
    const sb = removedKeyOrItem.spaceBefore
    if (!cb && !sb) return
    let next: Node | null = null
    if (coll instanceof YAMLSeq) {
      const idx = coll.findIndex(it => it === (removedKeyOrItem as unknown))
      next = null // handled by caller for seqs; see below
      void idx
    }
    void next
    // For maps/sets, find the pair/item following the removed one.
    if (coll instanceof YAMLMap || coll instanceof YAMLSet) {
      let found = false
      for (const item of coll.values.values()) {
        const kn = item instanceof Pair ? (item.key as Node) : (item as Node)
        if (found) {
          kn.commentBefore = joinComments(kn.commentBefore, cb ?? null)
          if (sb) kn.spaceBefore = true
          return
        }
        if (kn === removedKeyOrItem) found = true
      }
    }
    // No following sibling: append to the collection's own trailing comment.
    if (cb) {
      coll.comment = joinComments(coll.comment, cb)
    }
    effect.diagnostics.push({
      level: 'info',
      code: 'COMMENT_MOVED',
      message: 'Comments of the removed item were moved to its parent collection',
      range: removedKeyOrItem.range ?? null
    })
  }

  const removePair = (
    map: YAMLMap,
    pair: Pair,
    effect: Effect,
    moveComments: boolean
  ): void => {
    if (moveComments) transferCommentsToNext(map, pair.key as Node, effect)
    const mk = findMapKey(map, pair)
    if (mk !== undefined) map.values.delete(mk)
    else {
      for (const [k, p] of map.values)
        if (p === pair) {
          map.values.delete(k)
          break
        }
    }
  }

  // Phase 1: in-place edits, map/set structural edits, move map/set parts.
  for (const effect of effects) {
    const crossDoc = !!effect.moveDest?.crossDoc
    switch (effect.kind) {
      case 'set':
      case 'update': {
        const newNode = createValue(
          crossDoc ? toClone! : clone,
          effect.value,
          effect
        )
        if (!newNode) break
        if (effect.slotKind === 'map') {
          const pair = nodeFor(effect.pairId!) as Pair
          if (pair.value) copyComments(pair.value as Node, newNode)
          pair.value = newNode
        } else if (effect.slotKind === 'seq') {
          const seq = nodeFor(effect.parentId!) as YAMLSeq
          const oldItem = nodeFor(effect.nodeId!)
          if (oldItem) copyComments(oldItem as Node, newNode)
          const idx = seq.findIndex(it => it === oldItem)
          if (idx !== -1) seq[idx] = newNode
        } else if (effect.slotKind === 'set') {
          const set = nodeFor(effect.parentId!) as YAMLSet
          const oldItem = nodeFor(effect.nodeId!) as Node
          copyComments(oldItem, newNode)
          for (const [mk, item] of set.values) {
            if (item === oldItem) {
              set.values.delete(mk)
              break
            }
          }
          set.values.set(set.schema.mapKey(newNode), newNode)
        } else {
          // document root
          if (clone.value) copyComments(clone.value, newNode)
          clone.value = newNode as DocValue
        }
        effect.resultNodes.push(newNode)
        break
      }
      case 'add': {
        const parent = nodeFor(effect.parentId!) as YAMLMap | YAMLSeq
        if (parent instanceof YAMLMap) {
          const keyNode = createValue(clone, effect.moveDest?.key ?? effect.value && undefined, effect)
          void keyNode
        }
        break
      }
    }
  }

  void conflicts
  return { clone, cloneNodes, toClone, toCloneNodes, conflicts }
}
