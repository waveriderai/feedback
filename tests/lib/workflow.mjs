// Test helpers: pull the exact `run:` / `script:` / `if:` text out of a workflow
// file, and evaluate the small subset of GitHub expressions those `if:`s use.
// No YAML dependency: the extractor handles block scalars (`|`, `>-`) and
// single-line values, which is all these workflows use. actionlint checks the
// YAML itself.
import { readFileSync } from 'node:fs'

const ROOT = new URL('../../', import.meta.url)

/** The n-th value of `key:` in the workflow (block scalars dedented; `>-` folded). */
export function workflowValue(file, key, nth = 0) {
  const lines = readFileSync(new URL(`.github/workflows/${file}`, ROOT), 'utf8').split('\n')
  const re = new RegExp(`^(\\s*)(?:- )?${key}:\\s?(.*)$`)
  let seen = 0
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i])
    if (!m) continue
    if (seen++ !== nth) continue
    const indent = m[1].length
    const rest = m[2].trim()
    if (rest !== '|' && rest !== '>-') return rest
    const block = []
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]
      if (l.trim() !== '' && l.length - l.trimStart().length <= indent) break
      block.push(l)
    }
    while (block.length && block[block.length - 1].trim() === '') block.pop()
    const pad = Math.min(...block.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length))
    const body = block.map((l) => l.slice(pad))
    return rest === '|' ? `${body.join('\n')}\n` : body.join(' ')
  }
  throw new Error(`${file}: no ${key} #${nth}`)
}

// ------------------------------------------------- GitHub expression subset

function tokenize(src) {
  const out = []
  const re = /\s*(?:(\$\{\{|\}\})|('(?:[^']|'')*')|(&&|\|\||==|!=|[!(),])|([A-Za-z_][\w.-]*))/y
  let m
  while (re.lastIndex < src.length && (m = re.exec(src))) {
    if (m[1]) continue
    if (m[2]) out.push({ t: 'str', v: m[2].slice(1, -1).replace(/''/g, "'") })
    else if (m[3]) out.push({ t: 'op', v: m[3] })
    else out.push({ t: 'id', v: m[4] })
  }
  if (src.slice(re.lastIndex).trim()) throw new Error(`cannot tokenize: ${src.slice(re.lastIndex)}`)
  return out
}

const truthy = (v) => !(v === false || v === null || v === undefined || v === 0 || v === '')
const str = (v) => (v === null || v === undefined ? '' : String(v))
// GitHub compares strings case-insensitively, and startsWith ignores case.
const eq = (a, b) => (typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() === b.toLowerCase() : (a ?? null) === (b ?? null))

/** Evaluate `${{ … }}` or a bare expression against `{ github }`. */
export function evaluate(expr, ctx) {
  const toks = tokenize(expr)
  let i = 0
  const peek = () => toks[i]
  const take = (v) => {
    if (!toks[i] || (v && toks[i].v !== v)) throw new Error(`expected ${v} at ${i}`)
    return toks[i++]
  }
  function primary() {
    const tk = take()
    if (tk.t === 'str') return tk.v
    if (tk.v === '(') {
      const v = or()
      take(')')
      return v
    }
    if (tk.v === '!') return !truthy(primary())
    if (tk.t === 'id' && peek()?.v === '(') {
      take('(')
      const args = [or()]
      while (peek()?.v === ',') {
        take(',')
        args.push(or())
      }
      take(')')
      if (tk.v === 'startsWith') return str(args[0]).toLowerCase().startsWith(str(args[1]).toLowerCase())
      throw new Error(`unsupported function ${tk.v}`)
    }
    if (tk.t === 'id') return tk.v.split('.').reduce((o, k) => (o == null ? null : (o[k] ?? null)), ctx)
    throw new Error(`unexpected ${tk.v}`)
  }
  function cmp() {
    let v = primary()
    while (peek()?.v === '==' || peek()?.v === '!=') {
      const op = take().v
      const r = primary()
      v = op === '==' ? eq(v, r) : !eq(v, r)
    }
    return v
  }
  function and() {
    let v = cmp()
    while (peek()?.v === '&&') {
      take()
      const r = cmp()
      v = truthy(v) ? r : v
    }
    return v
  }
  function or() {
    let v = and()
    while (peek()?.v === '||') {
      take()
      const r = and()
      v = truthy(v) ? v : r
    }
    return v
  }
  const v = or()
  if (i !== toks.length) throw new Error('trailing tokens')
  return truthy(v)
}
