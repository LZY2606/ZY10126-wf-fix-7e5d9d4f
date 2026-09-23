import { Parser } from './src/index.ts'

const src = 'seq:\n\n  # lead\n  - a\n  -\n    x: 1\n  - |\n    hi\n    there\n'
const cst = Array.from(new Parser().parse(src))
const docTok:any = cst[0]
const seq:any = docTok.value.items[1].value
console.dir(seq, {depth:null})
