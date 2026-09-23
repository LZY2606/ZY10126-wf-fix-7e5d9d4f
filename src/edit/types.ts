import type { Document } from '../doc/Document.ts'
import type { Node, Range } from '../nodes/types.ts'
import type { Pair } from '../nodes/Pair.ts'
import type { ToStringOptions } from '../options.ts'

/**
 * A single step in an edit path.
 *
 * - `string`: a mapping key (shorthand for `{ key: str }`)
 * - `number`: a sequence index (shorthand for `{ index: n }`)
 * - `{ key, occurrence? }`: a mapping key. When the source contains duplicate
 *   keys, `occurrence` (zero-based) may select among the candidates.
 * - `{ index }`: a sequence index. Negative values count from the end.
 */
export type EditPathSegment =
  | string
  | number
  | { key: unknown; occurrence?: number }
  | { index: number }

/** A semantic path from the document root to a node. */
export type EditPath = readonly EditPathSegment[]

/**
 * Test callback for `update` operations. Called for each direct child of the
 * collection matched by the operation path. For maps the `key` is the pair's
 * key node, for sequences the item's index.
 */
export type EditTestFn = (
  node: Node,
  key: Node | number,
  parent: Node
) => boolean

/**
 * Value callback for `update` operations. Called once per matched node during
 * plan creation, with nodes from the original unmodified document.
 */
export type EditValueFn = (
  node: Node,
  key: Node | number,
  parent: Node
) => unknown

/** A single edit operation, described by semantic paths. */
export type EditOperation =
  | { op: 'set'; path: EditPath; value: unknown }
  | { op: 'delete'; path: EditPath }
  | { op: 'rename'; path: EditPath; to: unknown }
  | {
      op: 'move'
      from: EditPath
      to: EditPath
      /** If set, the subtree is moved into a different document. */
      toDocument?: Document
    }
  | {
      op: 'update'
      path: EditPath
      where: EditTestFn
      set: unknown | EditValueFn
    }

export type EditConflictCode =
  | 'PATH_NOT_FOUND'
  | 'PATH_EXISTS'
  | 'INVALID_PATH'
  | 'DUPLICATE_KEY'
  | 'MERGE_KEY'
  | 'ALIAS_ORPHANED'
  | 'ALIAS_TARGET_CHANGED'
  | 'OVERLAPPING_OPS'
  | 'MOVE_INTO_SELF'
  | 'CALLBACK_ERROR'
  | 'CREATE_NODE_FAILED'
  | 'STRINGIFY_FAILED'
  | 'VERIFY_FAILED'
  | 'STALE_SOURCE'
  | 'STALE_DOCUMENT'

/** A blocking problem found while analysing an edit plan. */
export interface EditConflict {
  code: EditConflictCode
  message: string
  /** Index of the operation in the original operations array, if applicable */
  op?: number
  /** Indices of other operations involved, e.g. for OVERLAPPING_OPS */
  relatedOps?: number[]
  /** Source ranges in the original document locating the conflict */
  ranges: Array<Range | null | undefined>
  /** Line/col positions corresponding to `ranges`, when computable */
  linePos?: Array<{ line: number; col: number } | null>
}

/** A non-blocking note attached to a plan item or the whole plan. */
export interface EditDiagnostic {
  level: 'info' | 'warning'
  code: string
  message: string
  range?: Range | null
}

/** Description of a source range that will be re-written on apply. */
export interface EditRewrite {
  /** Byte offsets `[start, end)` in the original source */
  range: [number, number]
  /** Why this range needs to be rewritten */
  reason: string
}

/** The analysis result for a single operation (or a single `update` match). */
export interface EditPlanItem {
  /** Index of the operation in the original operations array */
  op: number
  /** The operation this item belongs to */
  operation: EditOperation
  /** The node or pair matched by the operation path (identity in the original document) */
  node: Node | Pair | null
  /** The source range of the matched node in the original document */
  range: Range | null
  /** Anchors defined within the affected subtree */
  anchors: string[]
  /** Aliases elsewhere in the document referring into the affected subtree */
  aliases: Array<{ source: string; range: Range | null }>
  /** The minimal ancestor that will be re-written, and why */
  rewrite: EditRewrite | null
  /** Non-blocking notes about this item */
  diagnostics: EditDiagnostic[]
}

export interface EditPlan {
  /** True when no conflicts were found and the plan may be applied */
  ok: boolean
  /** Per-operation analysis results */
  items: EditPlanItem[]
  /** Blocking problems; when non-empty, `ok` is false */
  conflicts: EditConflict[]
  /** Plan-level diagnostics, e.g. rewrite scope expansions */
  diagnostics: EditDiagnostic[]
  /** The final merged source ranges that will be re-written */
  regions: EditRewrite[]
  /** Hash of the source text the plan was created from */
  sourceHash: string
  /** Hash of the document's semantic content at plan creation time */
  docHash: string
  /** The source text the plan was created from */
  source: string
  /**
   * The resulting source text, if the plan is ok. Applying the plan to an
   * unmodified document and source produces exactly this output.
   */
  resultSource?: string
  /**
   * Return the resulting source text. Throws an `EditPlanError` if the plan
   * has conflicts.
   */
  preview(): string
}

export interface EditPlanOptions {
  /**
   * The exact source text the document was parsed from. Required for
   * byte-preserving output and for stale-plan detection. If omitted,
   * `doc.toString()` is used as the baseline.
   */
  source?: string
  /** Stringify options used when re-writing modified regions */
  toString?: ToStringOptions
}

export interface EditApplyOptions {
  /**
   * The current source text. Defaults to the source given at plan creation.
   * If its hash does not match the plan's `sourceHash`, the apply is rejected.
   */
  source?: string
  /**
   * If true, the given document is modified in place after all checks pass.
   * Otherwise (default) the document is left untouched and the result
   * contains a new Document.
   */
  inPlace?: boolean
}

export interface EditResult {
  /** The resulting YAML source text */
  source: string
  /**
   * The resulting document, parsed from `source`. If `inPlace` was set,
   * this is the same object as the input document.
   */
  doc: Document
  /** For cross-document moves, the updated target document */
  toDoc?: Document
  /** For cross-document moves, the re-stringified target document source */
  toSource?: string
  /** The source ranges of the original text that were re-written */
  regions: EditRewrite[]
}

/** Error thrown when applying an edit plan fails. */
export class EditPlanError extends Error {
  conflicts: EditConflict[]
  constructor(message: string, conflicts: EditConflict[] = []) {
    super(message)
    this.name = 'EditPlanError'
    this.conflicts = conflicts
  }
}
