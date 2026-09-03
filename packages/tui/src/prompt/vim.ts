/**
 * Vim modal editing for the TUI prompt editor.
 *
 * The controller is deliberately decoupled from @opentui/core: it drives any
 * object satisfying the narrow VimEditor interface, which TextareaRenderable
 * satisfies structurally. That keeps the state machine unit-testable against a
 * plain-string fake editor.
 *
 * Multi-stroke semantics (gg, dd, dw, f{char}, r{char}, counts) are resolved
 * inside the controller rather than via keymap sequences, so every keymap
 * binding stays a single stroke.
 */

export type VimMode = "normal" | "insert" | "visual" | "visual-line"

export interface VimEditor {
  readonly plainText: string
  cursorOffset: number
  getTextRange(start: number, end: number): string
  getSelection?(): { start: number; end: number } | null
  setSelection(start: number, end: number): void
  deleteSelection(): boolean
  insertText(text: string): void
  undo(): boolean
  redo(): boolean
}

type CharClass = "space" | "word" | "punct"

function classify(ch: string): CharClass {
  const code = ch.codePointAt(0) ?? 0
  if (ch === "" || /\s/.test(ch)) return "space"
  if (code > 127 || /[A-Za-z0-9_]/.test(ch)) return "word"
  return "punct"
}

function classOf(text: string, index: number, big: boolean): CharClass | undefined {
  const ch = text[index]
  if (ch === undefined) return
  if (big) {
    if (classify(ch) === "space") return "space"
    return "word"
  }
  return classify(ch)
}

export function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1)
  }
  return starts
}

export type LineBounds = { start: number; end: number }

/** Bounds of a logical line; `end` excludes the trailing newline. */
export function lineBounds(text: string, line: number): LineBounds {
  const starts = lineStarts(text)
  const index = Math.max(0, Math.min(line, starts.length - 1))
  const start = starts[index]
  let end = index + 1 < starts.length ? starts[index + 1] - 1 : text.length
  if (end < start) end = start
  return { start, end }
}

export function lineCount(text: string): number {
  let count = 1
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") count++
  }
  return count
}

export function lineOf(text: string, offset: number): number {
  const starts = lineStarts(text)
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (starts[mid] <= offset) low = mid
    else high = mid - 1
  }
  return low
}

export function firstNonBlank(text: string, line: number): number {
  const { start, end } = lineBounds(text, line)
  for (let i = start; i < end; i++) {
    if (!/\s/.test(text[i])) return i
  }
  return end
}

/** Start of the next word at/after `offset` (vim `w`). */
export function wordForward(text: string, offset: number, big = false): number {
  const len = text.length
  let i = offset
  // consume current word/punct run
  if (i < len) {
    const cls = classOf(text, i, big)!
    if (cls !== "space") {
      while (i < len && classOf(text, i, big) === cls) i++
    }
  }
  // skip whitespace (newlines included)
  while (i < len && classify(text[i]) === "space") i++
  return Math.min(i, len)
}

/** End of the word containing/at `offset` (vim `e`). */
export function wordEnd(text: string, offset: number, big = false): number {
  const len = text.length
  if (len === 0) return 0
  let i = Math.min(offset + 1, len - 1)
  while (i < len && classify(text[i]) === "space") i++
  if (i >= len) return len - 1
  const cls = classOf(text, i, big)!
  while (i + 1 < len && classOf(text, i + 1, big) === cls) i++
  return i
}

/** Start of the previous word before `offset` (vim `b`). */
export function wordBackward(text: string, offset: number, big = false): number {
  let i = offset - 1
  while (i >= 0 && classify(text[i]) === "space") i--
  if (i < 0) return 0
  const cls = classOf(text, i, big)!
  while (i - 1 >= 0 && classOf(text, i - 1, big) === cls) i--
  return Math.max(i, 0)
}

/** Find `ch` in the current logical line (vim `f`/`F`/`t`/`T`). */
export function findChar(text: string, offset: number, ch: string, kind: "f" | "F" | "t" | "T"): number {
  const { start, end } = lineBounds(text, lineOf(text, offset))
  if (kind === "f" || kind === "t") {
    const hit = text.indexOf(ch, offset + 1)
    if (hit === -1 || hit >= end) return -1
    return kind === "t" ? hit - 1 : hit
  }
  // Backward searches stop short of the cursor character.
  if (kind === "F") {
    for (let j = offset - 1; j >= start; j--) {
      if (text[j] === ch) return j
    }
    return -1
  }
  // T lands one right of the target.
  for (let j = offset - 2; j >= start; j--) {
    if (text[j] === ch) return j + 1
  }
  return -1
}

const BRACKETS: Record<string, { pair: string; forward: boolean }> = {
  "(": { pair: ")", forward: true },
  "[": { pair: "]", forward: true },
  "{": { pair: "}", forward: true },
  ")": { pair: "(", forward: false },
  "]": { pair: "[", forward: false },
  "}": { pair: "{", forward: false },
}

/** Jump to the bracket matching the one at/after `offset` (vim `%`). */
export function matchBracket(text: string, offset: number): number {
  let i = offset
  while (i < text.length && !BRACKETS[text[i]]) i++
  const open = BRACKETS[text[i]]
  if (!open) return -1
  let depth = 0
  if (open.forward) {
    for (let j = i; j < text.length; j++) {
      if (text[j] === text[i]) depth++
      else if (text[j] === open.pair) {
        depth--
        if (depth === 0) return j
      }
    }
  } else {
    for (let j = i; j >= 0; j--) {
      if (text[j] === text[i]) depth++
      else if (text[j] === open.pair) {
        depth--
        if (depth === 0) return j
      }
    }
  }
  return -1
}

function isBlankLine(text: string, line: number): boolean {
  const b = lineBounds(text, line)
  return b.start === b.end || /^\s*$/.test(text.slice(b.start, b.end))
}

/** Start of the next paragraph boundary going down (vim `}`). */
export function paragraphForward(text: string, offset: number): number {
  const total = lineCount(text)
  const current = lineOf(text, offset)
  for (let line = current + 1; line < total; line++) {
    if (isBlankLine(text, line) && !isBlankLine(text, line - 1)) {
      return lineBounds(text, line).start
    }
  }
  return text.length
}

/** Start of the previous paragraph boundary going up (vim `{`). */
export function paragraphBackward(text: string, offset: number): number {
  const current = lineOf(text, offset)
  for (let line = current - 1; line > 0; line--) {
    if (isBlankLine(text, line) && !isBlankLine(text, line + 1)) {
      return lineBounds(text, line).start
    }
  }
  return lineBounds(text, 0).start
}

function toggleCase(ch: string): string {
  const upper = ch.toUpperCase()
  return ch === upper ? ch.toLowerCase() : upper
}

const MAX_COUNT = 9999

export type FindKind = "f" | "F" | "t" | "T"

export function createPromptVim(options: {
  editor: () => VimEditor | undefined
  onModeChange?: (mode: VimMode) => void
}) {
  const editor = options.editor

  let mode: VimMode = "insert"
  let count: number | null = null
  let count2: number | null = null
  let pendingOp: "d" | "c" | "y" | null = null
  let pendingFind: FindKind | null = null
  let pendingReplace = false
  let pendingG = false
  let lastFind: { kind: FindKind; char: string } | null = null
  let register: { text: string; linewise: boolean } = { text: "", linewise: false }
  let lastChange: (() => void) | null = null
  let replaying = false
  let visualAnchor = 0
  let desiredCol: number | null = null
  // Vim motions are exclusive by default; these extend through the landing
  // character when extending a visual selection.
  const INCLUSIVE_MOTIONS = new Set(["e", "E", "f", "F", "$", "%"])
  let lastMotionInclusive = false

  const setMode = (next: VimMode) => {
    if (mode === next) return
    mode = next
    options.onModeChange?.(next)
    if (mode !== "visual" && mode !== "visual-line") {
      const area = editor()
      if (area) {
        const at = Math.max(0, Math.min(area.cursorOffset, area.plainText.length))
        area.setSelection(at, at)
      }
    }
  }

  const cancelPending = () => {
    count = null
    count2 = null
    pendingOp = null
    pendingFind = null
    pendingReplace = false
    pendingG = false
  }

  const bumpCount = (digit: number) => {
    const next = (count ?? 0) * 10 + digit
    count = next > MAX_COUNT ? MAX_COUNT : next
  }

  const bumpCount2 = (digit: number) => {
    const next = (count2 ?? 0) * 10 + digit
    count2 = next > MAX_COUNT ? MAX_COUNT : next
  }

  const repeatFactor = () => (count ?? 1) * (count2 ?? 1)

  const widthBetween = (text: string, from: number, to: number): number =>
    Bun.stringWidth(text.slice(from, Math.max(from, to)))

  /** Offset at a display column within a line, clamped to the line end. */
  const offsetAtCol = (text: string, line: number, col: number): number => {
    const { start, end } = lineBounds(text, line)
    let width = 0
    for (let i = start; i < end; ) {
      const size = (text.codePointAt(i) ?? 0) > 65535 ? 2 : 1
      const w = Bun.stringWidth(text.slice(i, i + size))
      if (width + w > col) return i
      width += w
      i += size
    }
    return end
  }

  const clampCursor = () => {
    const area = editor()
    if (!area) return
    const text = area.plainText
    const bounds = lineBounds(text, lineOf(text, area.cursorOffset))
    area.cursorOffset = Math.max(bounds.start, Math.min(area.cursorOffset, bounds.end))
  }

  const syncVisualSelection = () => {
    const area = editor()
    if (!area) return
    const text = area.plainText
    const cursor = Math.max(0, Math.min(area.cursorOffset, text.length))
    if (mode === "visual") {
      const lo = Math.min(visualAnchor, cursor)
      const hi = Math.max(visualAnchor, cursor)
      area.setSelection(lo, Math.min(hi + (lastMotionInclusive ? 1 : 0), text.length))
      return
    }
    const loLine = Math.min(lineOf(text, visualAnchor), lineOf(text, cursor))
    const hiLine = Math.max(lineOf(text, visualAnchor), lineOf(text, cursor))
    const start = lineBounds(text, loLine).start
    const hiBound = lineBounds(text, hiLine)
    const end = hiBound.end < text.length ? hiBound.end + 1 : hiBound.end
    area.setSelection(Math.min(start, end), Math.max(start, end))
  }

  const moveTo = (offset: number, opts?: { keepCol?: boolean }) => {
    const area = editor()
    if (!area) return
    const text = area.plainText
    const at = Math.max(0, Math.min(offset, text.length))
    area.cursorOffset = at
    if (!opts?.keepCol) {
      const { start } = lineBounds(text, lineOf(text, at))
      desiredCol = widthBetween(text, start, at)
    }
    if (mode === "visual" || mode === "visual-line") syncVisualSelection()
  }

  const verticalMove = (dir: -1 | 1, lines: number) => {
    const area = editor()
    if (!area) return
    const text = area.plainText
    const current = lineOf(text, area.cursorOffset)
    const target = Math.max(0, Math.min(current + dir * lines, lineCount(text) - 1))
    if (target === current) {
      if (mode === "visual" || mode === "visual-line") syncVisualSelection()
      return
    }
    const col = desiredCol ?? widthBetween(text, lineBounds(text, current).start, area.cursorOffset)
    area.cursorOffset = offsetAtCol(text, target, col)
    if (mode === "visual" || mode === "visual-line") syncVisualSelection()
  }

  const yankRange = (start: number, end: number, linewise: boolean) => {
    const area = editor()
    if (!area || end <= start) return
    let text = area.getTextRange(start, end)
    if (linewise && !text.endsWith("\n")) text += "\n"
    register = { text, linewise }
  }

  const recordChange = (fn: () => void) => {
    lastChange = fn
  }

  /** Record only self-contained edits whose closures recompute from live state. */
  const runReplayable = (fn: () => void) => {
    fn()
    if (replaying) return
    lastChange = () => {
      replaying = true
      try {
        fn()
      } finally {
        replaying = false
      }
    }
  }

  const runChange = (fn: () => void) => {
    fn()
  }

  // ------------------------------------------------------------- operators

  type OpKind = "d" | "c" | "y"

  const applyCharwise = (op: OpKind, a: number, b: number, insertAfter = false) => {
    const area = editor()
    if (!area) return
    const text = area.plainText
    const lo = Math.max(0, Math.min(a, b, text.length))
    const hi = Math.min(Math.max(a, b), text.length)
    if (hi <= lo) {
      if (op === "c") setMode("insert")
      return
    }
    if (op === "y") {
      yankRange(lo, hi, false)
      moveTo(lo)
      return
    }
    deleteRangeAndSettle(op, lo, hi, insertAfter)
  }

  const deleteRangeAndSettle = (op: Exclude<OpKind, "y">, lo: number, hi: number, insertAfter = false) => {
    const area = editor()
    if (!area) return
    yankRange(lo, hi, false)
    area.setSelection(lo, hi)
    area.deleteSelection()
    const after = area.plainText
    if (after.length === 0) {
      area.cursorOffset = 0
    } else {
      const bounds = lineBounds(after, lineOf(after, Math.min(lo, after.length)))
      let at = Math.min(lo, bounds.end)
      // Deletions ending at line end leave the cursor on the new last char,
      // except change ops which enter insert right after the cut.
      if (!insertAfter && op !== "c" && lo >= bounds.end && bounds.end > bounds.start) at = bounds.end - 1
      area.cursorOffset = Math.max(bounds.start, at)
    }
    if (op === "c") setMode("insert")
  }

  const applyLinewise = (op: OpKind, fromLine: number, toLine: number) => {
    const area = editor()
    if (!area) return
    const text = area.plainText
    const maxLine = lineCount(text) - 1
    const loLine = Math.max(0, Math.min(fromLine, toLine, maxLine))
    const hiLine = Math.max(0, Math.min(Math.max(fromLine, toLine), maxLine))
    const start = lineBounds(text, loLine).start
    const hiBound = lineBounds(text, hiLine)
    const end = hiBound.end < text.length ? hiBound.end + 1 : hiBound.end
    if (op === "y") {
      yankRange(start, end, true)
      return
    }
    yankRange(start, end, true)
    area.setSelection(start, end)
    area.deleteSelection()
    let after = area.plainText
    // A linewise delete reaching buffer end can strand the previous line's
    // terminator as an empty final line; vim collapses it.
    if (end >= text.length && after.endsWith("\n")) {
      area.setSelection(after.length - 1, after.length)
      area.deleteSelection()
      after = area.plainText
    }
    if (after.length === 0) {
      area.cursorOffset = 0
    } else {
      const line = Math.min(loLine, lineCount(after) - 1)
      area.cursorOffset = firstNonBlank(after, line)
    }
    if (op === "c") setMode("insert")
  }

  const executeOperator = (op: OpKind, motionCh: string) => {
    const area = editor()
    if (!area) return
    const from = area.cursorOffset
    const text = area.plainText
    const bounds = lineBounds(text, lineOf(text, Math.min(from, text.length)))

    switch (motionCh) {
      case "g": {
        pendingG = true
        pendingOp = op
        return
      }
      case "f":
      case "F":
      case "t":
      case "T": {
        pendingFind = motionCh
        pendingOp = op
        return
      }
      case "G": {
        const total = lineCount(text)
        const target = count !== null ? Math.max(0, Math.min(count - 1, total - 1)) : total - 1
        count = null
        applyLinewise(op, lineOf(text, from), target)
        return
      }
      case "{":
      case "}": {
        const raw = resolveMotionOffset(motionCh, from, 1)
        count = null
        if (raw === undefined) return
        applyLinewise(op, lineOf(text, from), lineOf(text, raw))
        return
      }
      case "j":
      case "k": {
        const lines = repeatFactor()
        count = null
        count2 = null
        applyLinewise(op, lineOf(text, from), lineOf(text, from) + (motionCh === "j" ? lines : -lines))
        return
      }
    }

    let to = resolveMotionOffset(motionCh, from, repeatFactor())
    if (to === undefined) {
      cancelMotionOnly()
      return
    }
    count = null
    count2 = null

    if (motionCh === "b" || motionCh === "B") {
      to = Math.max(to, bounds.start)
    } else if (motionCh === "$") {
      to = bounds.end
    } else if (motionCh === "w" || motionCh === "W") {
      if (op === "c") {
        // cw behaves like ce
        to = wordEnd(text, from, motionCh === "W")
        to = to === from ? Math.min(bounds.end, from + 1) : Math.min(to + 1, bounds.end)
      } else {
        to = Math.min(to, bounds.end)
      }
    } else if (motionCh === "e" || motionCh === "E") {
      to = Math.min(to + 1, bounds.end)
    }

    if (to === from && op !== "c") return
    applyCharwise(op, from, to)
  }

  const cancelMotionOnly = () => {
    count = null
    count2 = null
  }

  /** Resolve a pure motion to an offset; undefined when it cannot move. */
  const resolveMotionOffset = (ch: string, from: number, repeat: number): number | undefined => {
    const area = editor()
    if (!area) return
    const text = area.plainText
    const len = text.length
    const bounds = lineBounds(text, lineOf(text, Math.min(from, len)))
    switch (ch) {
      case "h": {
        let at = from
        for (let n = 0; n < repeat; n++) {
          if (at > bounds.start) at--
          else break
        }
        return at
      }
      case "l": {
        let at = from
        for (let n = 0; n < repeat; n++) {
          if (at < bounds.end) at++
          else break
        }
        return at
      }
      case "w": {
        let at = from
        for (let n = 0; n < repeat; n++) {
          const next = wordForward(text, at)
          if (next === at) break
          at = next
        }
        return at
      }
      case "W": {
        let at = from
        for (let n = 0; n < repeat; n++) {
          const next = wordForward(text, at, true)
          if (next === at) break
          at = next
        }
        return at
      }
      case "b": {
        let at = from
        for (let n = 0; n < repeat; n++) {
          const next = wordBackward(text, at)
          if (next === at) break
          at = next
        }
        return at
      }
      case "B": {
        let at = from
        for (let n = 0; n < repeat; n++) {
          const next = wordBackward(text, at, true)
          if (next === at) break
          at = next
        }
        return at
      }
      case "e":
      case "E": {
        const big = ch === "E"
        let at = from
        for (let n = 0; n < repeat; n++) {
          const next = wordEnd(text, at, big)
          if (next === at && n > 0) break
          at = next
        }
        return at
      }
      case "0":
        return bounds.start
      case "^":
        return firstNonBlank(text, lineOf(text, Math.min(from, len)))
      case "$":
        return Math.max(bounds.start, bounds.end - 1)
      case "G": {
        const total = lineCount(text)
        const line = count !== null ? Math.max(0, Math.min(count - 1, total - 1)) : total - 1
        return firstNonBlank(text, line)
      }
      case "%": {
        const hit = matchBracket(text, Math.min(from, len))
        return hit === -1 ? undefined : hit
      }
      case "{":
        return paragraphBackward(text, Math.min(from, len))
      case "}":
        return paragraphForward(text, Math.min(from, len))
      case ";":
      case ",": {
        if (!lastFind) return undefined
        const opposite: Record<FindKind, FindKind> = { f: "F", F: "f", t: "T", T: "t" }
        const kind = ch === "," ? opposite[lastFind.kind] : lastFind.kind
        const hit = findChar(text, Math.min(from, len), lastFind.char, kind)
        return hit === -1 ? undefined : hit
      }
      default:
        return undefined
    }
  }

  // ---------------------------------------------------------------- visual

  const visualOperate = (kind: "d" | "c" | "y" | "~" | "p" | "r" | "J", arg?: string) => {
    const area = editor()
    if (!area) return
    const linewise = mode === "visual-line"
    const text = area.plainText
    const cursor = Math.max(0, Math.min(area.cursorOffset, text.length))
    let lo = Math.min(visualAnchor, cursor)
    let hi = Math.max(visualAnchor, cursor)

    if (linewise) {
      const loLine = lineOf(text, lo)
      const hiLine = lineOf(text, hi)
      lo = lineBounds(text, loLine).start
      const hiBound = lineBounds(text, hiLine)
      hi = hiBound.end < text.length ? hiBound.end + 1 : hiBound.end
    } else {
      hi = Math.min(hi + (lastMotionInclusive ? 1 : 0), text.length)
    }

    const finishNormal = (at: number) => {
      setMode("normal")
      area.cursorOffset = Math.max(0, Math.min(at, area.plainText.length))
      clampCursor()
    }

    if (kind === "y") {
      yankRange(lo, hi, linewise)
      finishNormal(lo)
      return
    }
    if (kind === "~") {
      const slice = area.getTextRange(lo, hi)
      if (slice) {
        const toggled = Array.from(slice)
          .map((ch) => (ch === "\n" ? ch : toggleCase(ch)))
          .join("")
        area.setSelection(lo, hi)
        area.deleteSelection()
        area.insertText(toggled)
      }
      finishNormal(lo)
      return
    }
    if (kind === "r") {
      const fill = arg ?? ""
      if (fill) {
        const slice = area.getTextRange(lo, hi)
        const replaced = Array.from(slice)
          .map((ch) => (ch === "\n" ? ch : fill))
          .join("")
        area.setSelection(lo, hi)
        area.deleteSelection()
        area.insertText(replaced)
      }
      finishNormal(lo)
      return
    }
    if (kind === "J") {
      const first = lineOf(area.plainText, lo)
      runChange(() => {
        const total = lineCount(area.plainText)
        for (let n = 0; n < total - 1; ) {
          const joinedFrom = lineOf(area.plainText, area.cursorOffset)
          if (!joinAt(joinedFrom)) break
          if (lineOf(area.plainText, area.cursorOffset) === joinedFrom) n++
        }
      })
      finishNormal(firstNonBlank(area.plainText, first))
      return
    }
    if (hi <= lo) {
      if (kind === "c") setMode("insert")
      else finishNormal(lo)
      return
    }
    if (kind === "d") {
      const reachedEnd = hi >= text.length
      yankRange(lo, hi, linewise)
      area.setSelection(lo, hi)
      area.deleteSelection()
      let after = area.plainText
      if (linewise && reachedEnd && after.endsWith("\n")) {
        area.setSelection(after.length - 1, after.length)
        area.deleteSelection()
        after = area.plainText
      }
      finishNormal(lo)
      return
    }
    if (kind === "c") {
      yankRange(lo, hi, linewise)
      area.setSelection(lo, hi)
      area.deleteSelection()
      setMode("insert")
      return
    }
    if (kind === "p") {
      const incoming = { ...register }
      const replaced = area.getTextRange(lo, hi)
      const payload = incoming.linewise ? incoming.text.replace(/\n$/, "") : incoming.text
      area.setSelection(lo, hi)
      area.deleteSelection()
      area.insertText(payload)
      register = { text: replaced, linewise }
      finishNormal(lo)
    }
  }

  // ------------------------------------------------------------ line joins

  const joinAt = (line: number): boolean => {
    const area = editor()
    if (!area) return false
    const text = area.plainText
    if (line >= lineCount(text) - 1) return false
    const cur = lineBounds(text, line)
    const nextContent = firstNonBlank(text, line + 1)
    let trimmedEnd = cur.end
    while (trimmedEnd > cur.start && /[ \t]/.test(text[trimmedEnd - 1])) trimmedEnd--
    const replacement = nextContent < lineBounds(text, line + 1).end ? " " : ""
    area.setSelection(trimmedEnd, nextContent)
    area.deleteSelection()
    if (replacement) area.insertText(replacement)
    // Cursor sits on the join point (the inserted space), like vim.
    area.cursorOffset = trimmedEnd
    return true
  }

  // ----------------------------------------------------------- normal edits

  /** cc/S: clear the line's content, keeping its newline. */
  const clearLineContent = () => {
    const area = editor()
    if (!area) return
    const bounds = lineBounds(area.plainText, lineOf(area.plainText, area.cursorOffset))
    if (bounds.end > bounds.start) {
      yankRange(bounds.start, bounds.end, true)
      area.setSelection(bounds.start, bounds.end)
      area.deleteSelection()
    }
    area.cursorOffset = bounds.start
  }

  const deleteCharsUnder = (repeat: number, backward = false) => {
    const area = editor()
    if (!area) return
    const text = area.plainText
    const at = area.cursorOffset
    const bounds = lineBounds(text, lineOf(text, at))
    if (backward) {
      const lo = Math.max(bounds.start, at - repeat)
      if (lo >= at) return
      applyCharwise("d", lo, at)
      return
    }
    if (at >= bounds.end) return
    applyCharwise("d", at, Math.min(bounds.end, at + repeat))
  }

  const replaceCharAtCursor = (fill: string) => {
    const area = editor()
    if (!area) return
    const at = area.cursorOffset
    const text = area.plainText
    if (at >= text.length || text[at] === "\n") return
    area.setSelection(at, at + 1)
    area.deleteSelection()
    area.insertText(fill)
    area.cursorOffset = at
  }

  const toggleCaseUnderCursor = () => {
    const area = editor()
    if (!area) return
    const at = area.cursorOffset
    const text = area.plainText
    if (at >= text.length || text[at] === "\n") return
    const bounds = lineBounds(text, lineOf(text, at))
    const toggled = toggleCase(text[at])
    area.setSelection(at, at + 1)
    area.deleteSelection()
    area.insertText(toggled)
    // Advance like vim's ~, stopping at the last character of the line.
    area.cursorOffset = Math.min(at + 1, Math.max(bounds.start, bounds.end - 1))
  }

  const openLine = (below: boolean) => {
    const area = editor()
    if (!area) return
    const text = area.plainText
    const bounds = lineBounds(text, lineOf(text, area.cursorOffset))
    area.cursorOffset = below ? bounds.end : bounds.start
    area.insertText("\n")
    // Inserting the newline leaves the cursor one past it; for O that is the
    // first character of the pushed-down line, so step back onto the blank.
    if (!below) area.cursorOffset = bounds.start
    setMode("insert")
  }

  const pasteRegister = (after: boolean, repeat: number) => {
    const area = editor()
    if (!area) return
    for (let n = 0; n < repeat; n++) {
      const text = area.plainText
      const at = Math.max(0, Math.min(area.cursorOffset, text.length))
      if (register.linewise) {
        const bounds = lineBounds(text, lineOf(text, at))
        const core = register.text.replace(/\n$/, "")
        if (!core) continue
        const linesInserted = core.split("\n").length
        if (after) {
          const hasNextLine = bounds.end < text.length
          const pos = hasNextLine ? bounds.end + 1 : bounds.end
          area.cursorOffset = pos
          area.insertText(hasNextLine ? core + "\n" : "\n" + core)
          const pasteStartLine = hasNextLine ? lineOf(area.plainText, pos) : lineOf(area.plainText, pos + 1)
          area.cursorOffset = firstNonBlank(area.plainText, pasteStartLine)
        } else {
          const pos = bounds.start
          area.cursorOffset = pos
          area.insertText(core + "\n")
          area.cursorOffset = firstNonBlank(area.plainText, lineOf(area.plainText, pos))
        }
        void linesInserted
      } else {
        const core = register.text.replace(/\n+$/, "")
        if (!core) continue
        const start = after && at < text.length && text[at] !== "\n" ? at + 1 : at
        area.cursorOffset = start
        area.insertText(core)
        area.cursorOffset = start + core.length - 1
      }
    }
  }

  // -------------------------------------------------------------- public API

  const escape = (): boolean => {
    pendingVisualReplace = false
    if (pendingFind || pendingReplace || pendingG || pendingOp || count !== null || count2 !== null) {
      cancelPending()
      return true
    }
    if (mode === "visual" || mode === "visual-line") {
      setMode("normal")
      return true
    }
    if (mode === "insert") {
      setMode("normal")
      desiredCol = null
      const area = editor()
      if (area) {
        const text = area.plainText
        const bounds = lineBounds(text, lineOf(text, Math.min(area.cursorOffset, text.length)))
        area.cursorOffset = Math.max(bounds.start, Math.min(area.cursorOffset - 1, bounds.end))
      }
      return true
    }
    return false
  }

  const enterInsertMode = (place: "here" | "first-blank" | "after" | "line-end") => {
    const area = editor()
    if (!area) return
    const text = area.plainText
    const bounds = lineBounds(text, lineOf(text, Math.min(area.cursorOffset, text.length)))
    if (place === "first-blank") area.cursorOffset = firstNonBlank(text, lineOf(text, area.cursorOffset))
    if (place === "line-end") area.cursorOffset = bounds.end
    if (place === "after") area.cursorOffset = area.cursorOffset < bounds.end ? area.cursorOffset + 1 : bounds.end
    setMode("insert")
  }

  const key = (input: string | null): boolean => {
    const area = editor()
    if (!area || mode === "insert") return false

    if (input === null) {
      cancelPending()
      pendingVisualReplace = false
      return true
    }

    // Visual replace (r{char}) resolves on the next keystroke.
    if (pendingVisualReplace && (mode === "visual" || mode === "visual-line")) {
      pendingVisualReplace = false
      visualOperate("r", input)
      return true
    }

    // Pending find (f/F/t/T {char}) resolves on the next keystroke, digits
    // included, so it must be checked before count parsing.
    if (pendingFind) {
      const kind = pendingFind
      pendingFind = null
      lastFind = { kind, char: input }
      const op = pendingOp
      pendingOp = null
      const factor = repeatFactor()
      count = null
      count2 = null
      let at = area.cursorOffset
      let moved = false
      for (let n = 0; n < factor; n++) {
        const hit = findChar(area.plainText, at, input, kind)
        if (hit === -1) break
        at = hit
        moved = true
      }
      if (!moved) return true
      lastMotionInclusive = kind === "f" || kind === "F"
      if (op) {
        // f/t land on the char before/at the hit; the exclusive end covers it.
        if (kind === "f" || kind === "t") applyCharwise(op, area.cursorOffset, at + 1)
        else applyCharwise(op, at, area.cursorOffset)
      } else {
        moveTo(at)
      }
      return true
    }

    if (pendingReplace) {
      pendingReplace = false
      count = null
      replaceCharAtCursor(input)
      return true
    }

    if (pendingG) {
      pendingG = false
      if (input === "g") {
        const op = pendingOp
        pendingOp = null
        const target = Math.max(0, (count ?? 1) - 1)
        count = null
        count2 = null
        if (op) applyLinewise(op, lineOf(area.plainText, area.cursorOffset), target)
        else moveTo(firstNonBlank(area.plainText, target))
        return true
      }
      cancelPending()
      return true
    }

    // Counts ahead of everything except mode toggles.
    if (!pendingOp && /^[1-9]$/.test(input)) {
      bumpCount(Number(input))
      return true
    }
    if (!pendingOp && input === "0" && count === null) {
      const at = resolveMotionOffset("0", area.cursorOffset, 1)
      if (at !== undefined) moveTo(at)
      return true
    }
    if (!pendingOp && input === "0" && count !== null) {
      bumpCount(0)
      return true
    }
    if (pendingOp && input === "0" && count2 !== null) {
      bumpCount2(0)
      return true
    }
    if (pendingOp && /^[1-9]$/.test(input)) {
      bumpCount2(Number(input))
      return true
    }
    // "0" after an operator is the line-start motion, not a count digit.

    // Visual mode operators must win over normal-mode operator arming: d/c/y
    // act immediately on the selection instead of starting a pending op.
    if (mode === "visual" || mode === "visual-line") {
      switch (input) {
        case "v":
          setMode(mode === "visual" ? "normal" : "visual")
          return true
        case "V":
          setMode(mode === "visual-line" ? "normal" : "visual-line")
          return true
        case "x":
        case "d":
          visualOperate("d")
          return true
        case "s":
        case "c":
          visualOperate("c")
          return true
        case "y":
          visualOperate("y")
          return true
        case "~":
        case "u":
          visualOperate("~")
          return true
        case "p":
        case "P":
          visualOperate("p")
          return true
        case "J":
          visualOperate("J")
          return true
        case "o": {
          const swap = visualAnchor
          visualAnchor = area.cursorOffset
          moveTo(swap)
          return true
        }
        case "r":
          pendingVisualReplace = true
          return true
      }
    }

    // Operators
    if (pendingOp) {
      const op = pendingOp
      if (input === op) {
        pendingOp = null
        const current = lineOf(area.plainText, area.cursorOffset)
        if (op === "c") {
          // cc clears line content but keeps the newline.
          count = null
          count2 = null
          clearLineContent()
          setMode("insert")
          return true
        }
        const lines = repeatFactor()
        count = null
        count2 = null
        applyLinewise(op, current, current + lines - 1)
        return true
      }
      pendingOp = null
      executeOperator(op, input)
      return true
    }

    if (input === "d" || input === "c" || input === "y") {
      pendingOp = input
      return true
    }

    if (input === "r") {
      pendingReplace = true
      return true
    }
    if (input === "g") {
      pendingG = true
      return true
    }
    if (input === "f" || input === "F" || input === "t" || input === "T") {
      pendingFind = input
      return true
    }

    // Insert-mode entries
    switch (input) {
      case "i":
        enterInsertMode("here")
        return true
      case "I":
        enterInsertMode("first-blank")
        return true
      case "a":
        enterInsertMode("after")
        return true
      case "A":
        enterInsertMode("line-end")
        return true
      case "o":
        openLine(true)
        return true
      case "O":
        openLine(false)
        return true
    }

    switch (input) {
      case "v": {
        visualAnchor = area.cursorOffset
        lastMotionInclusive = false
        setMode("visual")
        return true
      }
      case "V": {
        visualAnchor = area.cursorOffset
        lastMotionInclusive = false
        setMode("visual-line")
        return true
      }
      case "x":
        runReplayable(() => deleteCharsUnder(1))
        return true
      case "X":
        runChange(() => deleteCharsUnder(repeatFactor(), true))
        count = null
        return true
      case "s":
        runReplayable(() => {
          deleteCharsUnder(1)
        })
        setMode("insert")
        return true
      case "S": {
        runChange(() => clearLineContent())
        setMode("insert")
        return true
      }
      case "D":
        runReplayable(() => {
          const bounds = lineBounds(area.plainText, lineOf(area.plainText, area.cursorOffset))
          applyCharwise("d", area.cursorOffset, bounds.end)
        })
        return true
      case "C":
        runChange(() => {
          const bounds = lineBounds(area.plainText, lineOf(area.plainText, area.cursorOffset))
          applyCharwise("d", area.cursorOffset, bounds.end, true)
        })
        setMode("insert")
        return true
      case "J":
        runReplayable(() => {
          joinAt(lineOf(area.plainText, area.cursorOffset))
        })
        return true
      case "~":
        runReplayable(() => toggleCaseUnderCursor())
        return true
      case "p":
        runChange(() => pasteRegister(true, repeatFactor()))
        count = null
        return true
      case "P":
        runChange(() => pasteRegister(false, repeatFactor()))
        count = null
        return true
      case "u": {
        count = null
        area.undo()
        clampCursor()
        return true
      }
      case ".": {
        count = null
        const fn = lastChange
        if (fn && !replaying) {
          replaying = true
          try {
            fn()
          } finally {
            replaying = false
          }
        }
        return true
      }
      default:
        break
    }

    // Plain motions
    if (input === "j" || input === "k") {
      const lines = repeatFactor()
      count = null
      count2 = null
      lastMotionInclusive = false
      verticalMove(input === "j" ? 1 : -1, lines)
      return true
    }
    const factor = repeatFactor()
    const target = resolveMotionOffset(input, area.cursorOffset, factor)
    if (target !== undefined) {
      count = null
      count2 = null
      if (input === "$" || input === "^" || input === "G" || input === "0") desiredCol = null
      lastMotionInclusive = INCLUSIVE_MOTIONS.has(input)
      moveTo(target)
      return true
    }

    // Unmapped printable: consume silently (vim bell equivalent)
    cancelPending()
    return true
  }

  const redo = (): boolean => {
    const area = editor()
    if (!area || mode === "insert") return false
    count = null
    area.redo()
    clampCursor()
    return true
  }

  let pendingVisualReplace = false

  /** Cancel transient state; used when the prompt is externally replaced. */
  const softReset = () => {
    cancelPending()
    pendingVisualReplace = false
    if (mode === "visual" || mode === "visual-line") setMode("normal")
  }

  /** Full reset to insert mode; used after submit or clear. */
  const hardReset = () => {
    softReset()
    lastChange = null
    setMode("insert")
  }

  return {
    get mode() {
      return mode
    },
    get pending() {
      return (
        pendingFind !== null ||
        pendingReplace ||
        pendingVisualReplace ||
        pendingG ||
        pendingOp !== null ||
        count !== null
      )
    },
    escape,
    key,
    redo,
    softReset,
    hardReset,
  }
}

export type VimSeed = { key: string; char: string }

// Every printable stroke is bound so nothing leaks into the buffer in
// normal/visual mode; the controller swallows unmapped keys (vim bell).
// Multi-stroke semantics resolve inside the controller, so each binding is a
// single stroke. Uppercase letters need the explicit shift+ form because a
// bare "A" compiles case-insensitively and would shadow "a". Shifted symbols
// are registered both bare and with shift+ since terminals disagree on
// whether shifted punctuation reports the shift modifier.
function buildSeeds(): VimSeed[] {
  const seeds: VimSeed[] = []
  for (const ch of "abcdefghijklmnopqrstuvwxyz") {
    seeds.push({ key: ch, char: ch })
    seeds.push({ key: `shift+${ch}`, char: ch.toUpperCase() })
  }
  for (const ch of "0123456789") seeds.push({ key: ch, char: ch })
  for (const ch of "`~!@#$%^&*()-_=+[]{}\\|;:'\",.<>/?") {
    seeds.push({ key: ch, char: ch })
    if ('~!@#$%^&*()_+{}|:"<>?'.includes(ch)) seeds.push({ key: `shift+${ch}`, char: ch })
  }
  seeds.push({ key: "space", char: " " })
  return seeds
}

export const VIM_SEEDS: VimSeed[] = buildSeeds()

export const VIM_DESCS: Record<string, string> = {
  h: "Vim: cursor left",
  j: "Vim: cursor down",
  k: "Vim: cursor up",
  l: "Vim: cursor right",
  w: "Vim: next word",
  W: "Vim: next WORD",
  b: "Vim: previous word",
  B: "Vim: previous WORD",
  e: "Vim: end of word",
  E: "Vim: end of WORD",
  "0": "Vim: line start",
  $: "Vim: line end",
  "^": "Vim: first non-blank",
  G: "Vim: last line / goto line",
  "%": "Vim: matching bracket",
  "{": "Vim: previous paragraph",
  "}": "Vim: next paragraph",
  ";": "Vim: repeat find",
  ",": "Vim: repeat find reversed",
  f: "Vim: find char forward",
  F: "Vim: find char backward",
  t: "Vim: till char forward",
  T: "Vim: till char backward",
  g: "Vim: gg prefix",
  d: "Vim: delete operator",
  c: "Vim: change operator",
  y: "Vim: yank operator",
  r: "Vim: replace char",
  x: "Vim: delete char under cursor",
  X: "Vim: delete char before cursor",
  s: "Vim: substitute char",
  S: "Vim: substitute line",
  D: "Vim: delete to line end",
  C: "Vim: change to line end",
  J: "Vim: join lines",
  "~": "Vim: toggle case",
  u: "Vim: undo",
  p: "Vim: paste after",
  P: "Vim: paste before",
  o: "Vim: open line below",
  O: "Vim: open line above",
  i: "Vim: insert",
  I: "Vim: insert at line start",
  a: "Vim: append",
  A: "Vim: append at line end",
  v: "Vim: visual mode",
  V: "Vim: visual line mode",
  ".": "Vim: repeat last change",
  "ctrl+r": "Vim: redo",
}
