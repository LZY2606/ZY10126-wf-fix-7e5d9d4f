import type { Document } from '../doc/Document.ts'
import { Alias } from '../nodes/Alias.ts'
import { Pair } from '../nodes/Pair.ts'
import { Scalar } from '../nodes/Scalar.ts'
import type { Node } from '../nodes/types.ts'
import { YAMLMap } from '../nodes/YAMLMap.ts'
import { YAMLSeq } from '../nodes/YAMLSeq.ts'
import { YAMLSet } from '../nodes/YAMLSet.ts'

/**
 * Dual 32-bit FNV-1a hash of a string, rendered as 16 hex chars.
 * Used to detect changes to the source text between plan creation and apply.
 */
export function hashSource(src: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x811c9dc5 ^ 0xdeadbeef
  for (let i = 0; i < src.length; ++i) {
    const c = src.charCodeAt(i)
    h1 = Math.imul(h1 ^ (c & 0xff), 0x01000193)
    h1 = Math.imul(h1 ^ (c >>> 8), 0x01000193)
    h2 = Math.imul(h2 ^ c, 0x01000193)
    h2 = Math.imul(h2 ^ i, 0x01000193)
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0')
  return hex(h1) + hex(h2)
}

/**
 * A structural fingerprint of a document's semantic content, including node
 * types, scalar values, anchors, tags, aliases and comments. Used to detect
 * in-place document modifications between plan creation and apply.
 */
export function hashDocument(doc: Document): string {
  const parts: string[] = []
  const addNode = (node: Node | Pair | null): void => {
    if (!node) {
      parts.push('∅')
      return
    }
    if (node instanceof Pair) {
      parts.push('P(')
      addNode(node.key)
      addNode(node.value)
      parts.push(')')
      return
    }
    if (node instanceof Scalar) {
      parts.push(
        `S(${JSON.stringify(node.value)},${node.anchor ?? ''},${node.tag ?? ''},${node.comment ?? ''},${node.commentBefore ?? ''},${node.spaceBefore ? 1 : 0})`
      )
      return
    }
    if (node instanceof Alias) {
      parts.push(
        `A(${node.source},${node.comment ?? ''},${node.commentBefore ?? ''})`
      )
      return
    }
    parts.push(
      `${node.constructor.name}[${node.anchor ?? ''},${node.tag ?? ''},${node.flow ? 'F' : ''},${node.comment ?? ''},${node.commentBefore ?? ''},${node.spaceBefore ? 1 : 0}](`
    )
    if (node instanceof YAMLMap) {
      for (const pair of node.values.values()) addNode(pair)
    } else if (node instanceof YAMLSeq) {
      for (const item of node) addNode(item)
    } else if (node instanceof YAMLSet) {
      for (const item of node.values.values()) addNode(item)
    }
    parts.push(')')
  }
  parts.push(`D(${doc.commentBefore ?? ''},${doc.comment ?? ''})`)
  addNode(doc.value)
  return hashSource(parts.join(''))
}
