import type { Document } from '../doc/Document.ts'
import { Alias } from '../nodes/Alias.ts'
import { isCollection } from '../nodes/identity.ts'
import { Pair } from '../nodes/Pair.ts'
import { Scalar } from '../nodes/Scalar.ts'
import type { Node, Range } from '../nodes/types.ts'
import { YAMLMap } from '../nodes/YAMLMap.ts'
import { YAMLSeq } from '../nodes/YAMLSeq.ts'
import { YAMLSet } from '../nodes/YAMLSet.ts'
import type { CollectionItem } from '../parse/cst.ts'
import { resolveAsScalar } from '../parse/cst-scalar.ts'

export type EditNode = Node | Pair

export interface Snapshot {
  doc: Document
  /** All nodes & pairs of the document, in document order */
  nodes: EditNode[]
  /** Stable id for each node/pair (index into `nodes`) */
  ids: Map<EditNode, number>
  /** Parent of each node/pair; the parent of the root value is the Document */
  parents: Map<EditNode, EditNode | Document>
  /** All aliases in the document, in document order */
  aliases: Alias[]
  /** Anchor name -> defining nodes, in document order */
  anchors: Map<string, Node[]>
  /** Alias -> id of the node it resolves to in the original document */
  aliasTargets: Map<Alias, number>
  /** Maps/sets containing duplicate keys in the source -> key -> source ranges */
  duplicates: Map<number, Map<string, Range[]>>
  /** Ids of pairs that are merge keys (`<<`) */
  mergePairs: Set<number>
}

const isMergeKeyNode = (key: Node): boolean =>
  key instanceof Scalar &&
  (key.value === '<<' ||
    (typeof key.value === 'symbol' && key.value.description === '<<'))

/**
 * Walk the document, assigning a stable identity to each node and pair, and
 * collect anchor/alias/duplicate/merge-key information. All paths of an edit
 * plan are resolved against this single snapshot, so later operations never
 * observe the effects of earlier ones.
 */
export function createSnapshot(doc: Document): Snapshot {
  const nodes: EditNode[] = []
  const ids = new Map<EditNode, number>()
  const parents = new Map<EditNode, EditNode | Document>()
  const aliases: Alias[] = []
  const anchors = new Map<string, Node[]>()
  const mergePairs = new Set<number>()

  const add = (node: EditNode, parent: EditNode | Document): number => {
    const id = nodes.length
    nodes.push(node)
    ids.set(node, id)
    parents.set(node, parent)
    return id
  }

  const walk = (node: EditNode | null, parent: EditNode | Document): void => {
    if (!node) return
    add(node, parent)
    if (node instanceof Pair) {
      if (isMergeKeyNode(node.key as Node)) mergePairs.add(ids.get(node)!)
      walk(node.key as Node, node)
      walk(node.value, node)
    } else {
      if (node instanceof Alias) aliases.push(node)
      else {
        if (node.anchor) {
          const arr = anchors.get(node.anchor)
          if (arr) arr.push(node)
          else anchors.set(node.anchor, [node])
        }
        if (node instanceof YAMLMap || node instanceof YAMLSet) {
          for (const item of node.values.values()) walk(item, node)
        } else if (node instanceof YAMLSeq) {
          for (const item of node) walk(item, node)
        }
      }
    }
  }
  if (doc.value) walk(doc.value, doc)

  // Resolve each alias against the original document order.
  const aliasTargets = new Map<Alias, number>()
  {
    const ordered: Node[] = []
    const collect = (node: EditNode | null): void => {
      if (!node || node instanceof Pair) {
        if (node instanceof Pair) {
          collect(node.key as Node)
          collect(node.value)
        }
        return
      }
      ordered.push(node)
      if (node instanceof YAMLMap || node instanceof YAMLSet) {
        for (const item of node.values.values()) collect(item)
      } else if (node instanceof YAMLSeq) {
        for (const item of node) collect(item)
      }
    }
    collect(doc.value)
    const anchorNodes: Node[] = []
    for (const node of ordered) {
      if (node instanceof Alias) {
        let found: Node | undefined
        for (const prev of anchorNodes) {
          if (prev.anchor === node.source) found = prev
        }
        if (found) aliasTargets.set(node, ids.get(found)!)
      } else if (node.anchor) {
        anchorNodes.push(node)
      }
    }
  }

  const duplicates = findDuplicates(doc, ids)
  return {
    doc,
    nodes,
    ids,
    parents,
    aliases,
    anchors,
    aliasTargets,
    duplicates,
    mergePairs
  }
}

/** Ids of all nodes & pairs within the subtree rooted at `id`. */
export function subtreeIds(snap: Snapshot, id: number): Set<number> {
  const set = new Set<number>()
  const walk = (node: EditNode | null): void => {
    if (!node) return
    const nid = snap.ids.get(node)
    if (nid !== undefined) set.add(nid)
    if (node instanceof Pair) {
      walk(node.key as Node)
      walk(node.value)
    } else if (node instanceof YAMLMap || node instanceof YAMLSet) {
      for (const item of node.values.values()) walk(item)
    } else if (node instanceof YAMLSeq) {
      for (const item of node) walk(item)
    }
  }
  walk(snap.nodes[id])
  return set
}

function findDuplicates(
  doc: Document,
  ids: Map<EditNode, number>
): Map<number, Map<string, Range[]>> {
  const duplicates = new Map<number, Map<string, Range[]>>()

  const addDup = (mapId: number, key: string, range: Range | null | undefined) => {
    if (!range) return
    let byKey = duplicates.get(mapId)
    if (!byKey) duplicates.set(mapId, (byKey = new Map()))
    const arr = byKey.get(key)
    if (arr) arr.push(range)
    else byKey.set(key, [range])
  }

  // Precise per-key detection from CST source tokens, when available.
  const fromCST = (map: YAMLMap | YAMLSet): boolean => {
    const st = map.srcToken
    if (!st || (st.type !== 'block-map' && st.type !== 'flow-collection'))
      return false
    const seen = new Map<string, Range | null | undefined>()
    let found = false
    for (const item of st.items as CollectionItem[]) {
      const keyToken = item.key
      if (
        !keyToken ||
        (keyToken.type !== 'scalar' &&
          keyToken.type !== 'single-quoted-scalar' &&
          keyToken.type !== 'double-quoted-scalar')
      )
        continue
      const scalar = resolveAsScalar(keyToken)
      if (!scalar) continue
      const key = String(scalar.value)
      const range: Range | null = keyToken
        ? [keyToken.offset, keyToken.offset + keyToken.source.length, keyToken.offset + keyToken.source.length]
        : null
      if (seen.has(key)) {
        addDup(ids.get(map)!, key, seen.get(key))
        addDup(ids.get(map)!, key, range)
        found = true
      } else seen.set(key, range)
    }
    return found
  }

  const dupErrorRanges: Range[] = []
  for (const err of doc.errors) {
    if (err.code === 'DUPLICATE_KEY' && err.pos) {
      const start = err.pos[0]
      const end = typeof err.pos[1] === 'number' ? err.pos[1] : start + 1
      dupErrorRanges.push([start, end, end])
    }
  }

  const walk = (node: EditNode | null): void => {
    if (!node) return
    if (node instanceof Pair) {
      walk(node.key as Node)
      walk(node.value)
      return
    }
    if (node instanceof YAMLMap || node instanceof YAMLSet) {
      if (!fromCST(node) && dupErrorRanges.length > 0 && node.range) {
        // Fallback: attribute duplicate-key parse errors to the enclosing map.
        const [start, , end] = node.range
        for (const range of dupErrorRanges) {
          if (range[0] >= start && range[0] <= end) {
            let byKey = duplicates.get(ids.get(node)!)
            if (!byKey) duplicates.set(ids.get(node)!, (byKey = new Map()))
            const arr = byKey.get('')
            if (arr) arr.push(range)
            else byKey.set('', [range])
          }
        }
      }
      for (const item of node.values.values()) walk(item)
    } else if (node instanceof YAMLSeq) {
      for (const item of node) walk(item)
    }
  }
  walk(doc.value)
  return duplicates
}

/** Keys provided by merge keys (`<<`) of a map, with their source ranges. */
export function mergedKeys(
  snap: Snapshot,
  map: YAMLMap
): Map<string, Range | null> {
  const merged = new Map<string, Range | null>()
  for (const pair of map.values.values()) {
    if (!snap.mergePairs.has(snap.ids.get(pair)!)) continue
    const value = pair.value
    const sources: Node[] = []
    if (value instanceof YAMLMap) sources.push(value)
    else if (value instanceof Alias) {
      const targetId = snap.aliasTargets.get(value)
      const target = targetId !== undefined ? snap.nodes[targetId] : undefined
      if (target instanceof YAMLMap) sources.push(target)
    } else if (value instanceof YAMLSeq) {
      for (const item of value) {
        if (item instanceof YAMLMap) sources.push(item)
        else if (item instanceof Alias) {
          const targetId = snap.aliasTargets.get(item)
          const target =
            targetId !== undefined ? snap.nodes[targetId] : undefined
          if (target instanceof YAMLMap) sources.push(target)
        }
      }
    }
    for (const src of sources) {
      for (const p of (src as YAMLMap).values.values()) {
        const k = p.key
        if (k instanceof Scalar && typeof k.value === 'string') {
          if (!merged.has(k.value)) merged.set(k.value, k.range ?? null)
        }
      }
    }
  }
  return merged
}

export function isMergePair(snap: Snapshot, pair: Pair): boolean {
  const id = snap.ids.get(pair)
  return id !== undefined && snap.mergePairs.has(id)
}

export function isCollectionNode(
  node: unknown
): node is YAMLMap | YAMLSeq | YAMLSet {
  return isCollection(node)
}

/**
 * All nodes & pairs of a document, in the same deterministic document order
 * used by `createSnapshot`. Used to align a document clone with its snapshot.
 */
export function walkEditNodes(doc: Document): EditNode[] {
  const nodes: EditNode[] = []
  const walk = (node: EditNode | null): void => {
    if (!node) return
    nodes.push(node)
    if (node instanceof Pair) {
      walk(node.key as Node)
      walk(node.value)
    } else if (node instanceof YAMLMap || node instanceof YAMLSet) {
      for (const item of node.values.values()) walk(item)
    } else if (node instanceof YAMLSeq) {
      for (const item of node) walk(item)
    }
  }
  if (doc.value) walk(doc.value)
  return nodes
}
