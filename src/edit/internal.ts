import type { Document } from '../doc/Document.ts'
import type { Node, Range } from '../nodes/types.ts'
import type { Pair } from '../nodes/Pair.ts'
import type { ToStringOptions } from '../options.ts'
import type { Snapshot } from './snapshot.ts'
import type {
  EditConflict,
  EditDiagnostic,
  EditOperation,
  EditPath,
  EditPathSegment,
  EditPlan,
  EditPlanItem
} from './types.ts'

/** A single resolved effect of an operation on the original snapshot. */
export interface Effect {
  opIndex: number
  op: EditOperation
  kind: 'set' | 'add' | 'delete' | 'rename' | 'move' | 'update'
  /** Matched node or pair in the original document */
  node: Node | Pair | null
  nodeId: number | undefined
  range: Range | null
  /** Parent collection id in the snapshot; undefined for the document root */
  parentId: number | undefined
  slotKind: 'map' | 'seq' | 'set' | 'root' | null
  /** Matched pair id, for map slots */
  pairId: number | undefined
  /** New value for set/update; new key for rename */
  value: unknown
  /** Move destination */
  moveDest?: {
    parent: Node
    parentId: number
    key: unknown
    index: number | undefined
    crossDoc: boolean
  }
  /** Ids removed from the document by this effect */
  discard: Set<number>
  /** Ids relocated by this effect (move) */
  relocate: Set<number>
  /** Id of the moved root node/pair */
  moveRoot: number | undefined
  /** Id of the node/pair modified in place */
  target: number | undefined
  /** Ids of parent collections structurally modified */
  containers: Set<number>
  anchors: string[]
  aliases: Array<{ source: string; range: Range | null }>
  diagnostics: EditDiagnostic[]
  /** Clone nodes/pairs produced when applying this effect (set by simulate) */
  resultNodes: Array<Node | Pair>
}

export interface PlanInternal {
  plan: EditPlan
  items: EditPlanItem[]
  effects: Effect[]
  effectItems: EditPlanItem[]
  snap: Snapshot
  toSnap?: Snapshot
  toDoc?: Document
  toDocHash?: string
  toString?: ToStringOptions
  conflicts: EditConflict[]
  result?: {
    source: string
    doc: Document
    toDoc?: Document
    toSource?: string
  }
}

export type { EditPath, EditPathSegment, EditConflict }
