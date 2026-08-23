import { describe, expect, test } from "bun:test"
import {
  createPromptVim,
  findChar,
  lineBounds,
  matchBracket,
  wordBackward,
  wordEnd,
  wordForward,
  type VimEditor,
  type VimMode,
} from "../../src/prompt/vim"

class FakeEditor implements VimEditor {
  text: string
  offset: number
  private undoStack: { text: string; offset: number }[] = []
  private redoStack: { text: string; offset: number }[] = []

  constructor(text: string, offset?: number) {
    this.text = text
    this.offset = offset ?? text.length
  }

  get plainText() {
    return this.text
  }

  get cursorOffset() {
    return this.offset
  }

  set cursorOffset(value: number) {
    this.offset = Math.max(0, Math.min(value, this.text.length))
  }

  getTextRange(start: number, end: number) {
    return this.text.slice(start, end)
  }

  setSelection(start: number, end: number) {
    void start
    void end
  }

  private mutate(fn: () => void) {
    const before = { text: this.text, offset: this.offset }
    fn()
    if (before.text === this.text) return
    const top = this.undoStack.at(-1)
    if (!top || top.text !== before.text || top.offset !== before.offset) {
      this.undoStack.push(before)
      this.redoStack = []
    }
  }

  deleteSelection() {
    let done = false
    this.mutate(() => {
      done = false
    })
    // selection is virtual in the fake; deletion happens through replaceRange
    void done
    return true
  }

  insertText(text: string) {
    this.mutate(() => {
      this.text = this.text.slice(0, this.offset) + text + this.text.slice(this.offset)
      this.offset += text.length
    })
  }

  /** Test-only helper mirroring what setSelection+deleteSelection does natively. */
  replaceRange(start: number, end: number) {
    this.mutate(() => {
      this.text = this.text.slice(0, start) + this.text.slice(Math.max(start, end))
      this.offset = Math.min(start, this.text.length)
    })
  }

  undo() {
    const prev = this.undoStack.pop()
    if (!prev) return false
    this.redoStack.push({ text: this.text, offset: this.offset })
    this.text = prev.text
    this.offset = Math.min(prev.offset, this.text.length)
    return true
  }

  redo() {
    const next = this.redoStack.pop()
    if (!next) return false
    this.undoStack.push({ text: this.text, offset: this.offset })
    this.text = next.text
    this.offset = Math.min(next.offset, this.text.length)
    return true
  }
}

/**
 * The real TextareaRenderable performs setSelection(lo, hi) followed by
 * deleteSelection(); bridge those onto the fake's range replacement so
 * operator tests exercise the same controller code paths.
 */
class NativeLikeEditor extends FakeEditor {
  private selection: { lo: number; hi: number } | null = null

  override setSelection(start: number, end: number) {
    this.selection = { lo: Math.min(start, end), hi: Math.max(start, end) }
  }

  override deleteSelection() {
    const sel = this.selection
    this.selection = null
    if (!sel || sel.hi <= sel.lo) return false
    this.replaceRange(sel.lo, sel.hi)
    return true
  }
}

type Harness = ReturnType<typeof harness>

function harness(text: string, offset?: number) {
  const editor = new NativeLikeEditor(text, offset)
  const modes: VimMode[] = []
  const vim = createPromptVim({
    editor: () => editor,
    onModeChange: (mode) => modes.push(mode),
  })
  // Enter normal mode like pressing escape; col-0 starts keep this lossless.
  vim.escape()
  editor.cursorOffset = offset ?? text.length
  /**
   * Feed keys as typed characters ("x"), space (" "), or shift letters
   * already uppercased by the caller ("A") exactly like the component maps
   * event names.
   */
  const type = (...keys: string[]) => {
    for (const key of keys) expect(vim.key(key)).toBe(true)
  }
  const state = () => ({ text: editor.plainText, cursor: editor.cursorOffset })
  return { editor, vim, modes, type, state }
}

describe("vim pure helpers", () => {
  test("lineBounds excludes newlines", () => {
    const text = "ab\ncd\nef"
    expect(lineBounds(text, 0)).toEqual({ start: 0, end: 2 })
    expect(lineBounds(text, 1)).toEqual({ start: 3, end: 5 })
    expect(lineBounds(text, 2)).toEqual({ start: 6, end: 8 })
  })

  test("word motion classes", () => {
    const text = "foo.bar baz\nquux"
    expect(wordForward(text, 0)).toBe(3)
    expect(wordForward(text, 3)).toBe(4)
    expect(wordForward(text, 4)).toBe(8)
    expect(wordBackward(text, 16)).toBe(12)
    expect(wordEnd(text, 12)).toBe(15)
  })

  test("findChar is line-scoped", () => {
    const text = "ab a\nb a"
    expect(findChar(text, 0, "a", "f")).toBe(3)
    expect(findChar(text, 4, "a", "F")).toBe(3)
    expect(findChar(text, 0, "a", "F")).toBe(-1)
  })

  test("matchBracket handles nesting both directions", () => {
    const text = "a(b(c)d)e"
    expect(matchBracket(text, 1)).toBe(7)
    expect(matchBracket(text, 7)).toBe(1)
    expect(matchBracket(text, 3)).toBe(5)
  })
})

describe("vim modes", () => {
  test("escape toggles between insert and normal", () => {
    const t = harness("")
    t.vim.key("i")
    expect(t.vim.mode).toBe("insert")
    expect(t.vim.escape()).toBe(true)
    expect(t.vim.mode).toBe("normal")
  })

  test("escape in normal mode rejects so global handlers run", () => {
    const t = harness("abc")
    expect(t.vim.escape()).toBe(false)
  })

  test("insert entry points place the cursor correctly", () => {
    const a = harness("one two", 0)
    a.type("w")
    a.type("i")
    expect(a.state().cursor).toBe(4)

    const b = harness("  indented", 0)
    b.type("I")
    expect(b.vim.mode).toBe("insert")
    expect(b.state().cursor).toBe(2)

    const c = harness("end", 0)
    c.type("A")
    expect(c.state().cursor).toBe(3)

    const d = harness("mid", 0)
    d.type("a")
    expect(d.state().cursor).toBe(1)
  })

  test("o and O open lines and enter insert", () => {
    const below = harness("first", 1)
    below.type("o")
    expect(below.vim.mode).toBe("insert")
    below.editor.insertText("second")
    below.vim.escape()
    // escape backs onto the last typed character
    expect(below.state()).toEqual({ text: "first\nsecond", cursor: 11 })

    const above = harness("first", 1)
    above.type("O")
    above.editor.insertText("zeroth")
    above.vim.escape()
    expect(above.state()).toEqual({ text: "zeroth\nfirst", cursor: 5 })
  })
})

describe("vim motions", () => {
  test("h j k l move across lines preserving column intent", () => {
    const t = harness("alpha\nbeta\ngamma", 0)
    t.type("l", "l")
    expect(t.state().cursor).toBe(2)
    t.type("j")
    expect(t.state().cursor).toBe(8)
    t.type("j")
    expect(t.state().cursor).toBe(13)
    t.type("k", "k")
    expect(t.state().cursor).toBe(2)
    t.type("h", "h")
    expect(t.state().cursor).toBe(0)
  })

  test("count prefixes scale motions", () => {
    const t = harness("abcdef", 0)
    t.type("3", "l")
    expect(t.state().cursor).toBe(3)
    t.type("9", "h")
    expect(t.state().cursor).toBe(0)
  })

  test("$ ^ 0 G and count-goto-line", () => {
    const t = harness("ab cd\n ef gh\nij", 0)
    t.type("$")
    expect(t.state().cursor).toBe(4)
    t.type("^")
    expect(t.state().cursor).toBe(0)
    t.type("j", "$")
    expect(t.state().cursor).toBe(11)
    t.type("0")
    expect(t.state().cursor).toBe(6)
    t.type("G")
    expect(t.state().cursor).toBe(13)
    t.type("g", "g")
    expect(t.state().cursor).toBe(0)
    t.type("3", "G")
    expect(t.state().cursor).toBe(13)
    t.type("g", "g")
    expect(t.state().cursor).toBe(0)
  })

  test("word motions cross punctuation and lines", () => {
    const t = harness("foo.bar baz", 0)
    // w treats punctuation runs as words, like vim
    t.type("w")
    expect(t.state().cursor).toBe(3)
    t.type("w")
    expect(t.state().cursor).toBe(4)
    t.type("e")
    expect(t.state().cursor).toBe(6)
    t.type("b")
    expect(t.state().cursor).toBe(4)
  })

  test("find family with ; and , repeats", () => {
    const t = harness("a b a b a", 0)
    t.type("f", "b")
    expect(t.state().cursor).toBe(2)
    t.type(";")
    expect(t.state().cursor).toBe(6)
    t.type(",")
    expect(t.state().cursor).toBe(2)
    t.type("t", "b")
    expect(t.state().cursor).toBe(5)
    t.type("T", "a")
    expect(t.state().cursor).toBe(1)
  })

  test("% jumps matching brackets", () => {
    const t = harness("fn(x, (y)) end", 2)
    t.type("%")
    expect(t.state().cursor).toBe(9)
  })

  test("paragraph braces land on blank lines", () => {
    const t = harness("one\ntwo\n\nthree", 0)
    t.type("}")
    expect(t.state().cursor).toBe(8)
    t.type("{")
    expect(t.state().cursor).toBe(0)
  })

  test("unmapped printable keys are swallowed without edits", () => {
    const t = harness("abc", 1)
    t.type("z")
    expect(t.state()).toEqual({ text: "abc", cursor: 1 })
  })
})

describe("vim operators", () => {
  test("dw stops at line end instead of eating the newline", () => {
    const t = harness("ab  \nnext", 0)
    t.type("d", "w")
    expect(t.state()).toEqual({ text: "\nnext", cursor: 0 })
  })

  test("cw behaves like ce and enters insert", () => {
    const t = harness("foo bar", 0)
    t.type("c", "w")
    expect(t.vim.mode).toBe("insert")
    t.editor.insertText("nee")
    t.vim.escape()
    expect(t.state()).toEqual({ text: "nee bar", cursor: 2 })
  })

  test("de deletes inclusive of word end", () => {
    const t = harness("foo bar", 0)
    t.type("d", "e")
    expect(t.state()).toEqual({ text: " bar", cursor: 0 })
  })

  test("dd removes the whole line and 2dd spans lines", () => {
    const two = harness("l1\nkeep", 0)
    two.type("d", "d")
    expect(two.state()).toEqual({ text: "keep", cursor: 0 })

    const three = harness("l1\nl2\nl3", 0)
    three.type("2", "d", "d")
    expect(three.state()).toEqual({ text: "l3", cursor: 0 })
  })

  test("cc clears the line keeping the newline", () => {
    const t = harness("old\nstay", 0)
    t.type("c", "c")
    expect(t.vim.mode).toBe("insert")
    t.editor.insertText("new")
    t.vim.escape()
    expect(t.state()).toEqual({ text: "new\nstay", cursor: 2 })
  })

  test("d$ D d0 and d^", () => {
    const a = harness("keep cut", 0)
    a.type("l", "l", "l", "l")
    a.type("d", "$")
    expect(a.state()).toEqual({ text: "keep", cursor: 3 })

    const b = harness("keep cut", 0)
    b.type("l", "l")
    b.type("D")
    expect(b.state()).toEqual({ text: "ke", cursor: 1 })

    const c = harness("cut keep", 5)
    c.type("d", "0")
    expect(c.state()).toEqual({ text: "eep", cursor: 0 })
  })

  test("df and dt delete through and up to the target", () => {
    const f = harness("va,b", 0)
    f.type("d", "f", ",")
    expect(f.state()).toEqual({ text: "b", cursor: 0 })

    const t = harness("va,b", 0)
    t.type("d", "t", ",")
    expect(t.state()).toEqual({ text: ",b", cursor: 0 })
  })

  test("yy p duplicates lines and P pastes above", () => {
    const dup = harness("l1\nl2", 0)
    dup.type("y", "y")
    dup.type("p")
    expect(dup.state()).toEqual({ text: "l1\nl1\nl2", cursor: 3 })

    const above = harness("l1\nl2", 3)
    above.type("y", "y")
    above.type("P")
    expect(above.state()).toEqual({ text: "l1\nl2\nl2", cursor: 3 })
  })

  test("yw p pastes charwise after the cursor", () => {
    const t = harness("ab cd", 0)
    t.type("y", "w")
    t.type("w")
    t.type("P")
    expect(t.state()).toEqual({ text: "ab ab cd", cursor: 5 })
  })

  test("dG deletes to the last line linewise", () => {
    const t = harness("l1\nl2\nl3", 0)
    t.type("j")
    t.type("d", "G")
    expect(t.state()).toEqual({ text: "l1", cursor: 0 })
  })

  test("operator counts compose: d2w and 2dw", () => {
    const text = "one two three four"
    const a = harness(text, 0)
    a.type("d", "2", "w")
    expect(a.state()).toEqual({ text: "three four", cursor: 0 })
    const b = harness(text, 0)
    b.type("2", "d", "w")
    expect(b.state()).toEqual({ text: "three four", cursor: 0 })
  })
})

describe("vim edits", () => {
  test("x X r s S behave", () => {
    const x = harness("abc", 1)
    x.type("x")
    expect(x.state()).toEqual({ text: "ac", cursor: 1 })

    const bigX = harness("abc", 2)
    bigX.type("X")
    expect(bigX.state()).toEqual({ text: "ac", cursor: 1 })

    const r = harness("abc", 1)
    r.type("r", "Z")
    expect(r.state()).toEqual({ text: "aZc", cursor: 1 })

    const s = harness("abc", 0)
    s.type("s")
    s.editor.insertText("X")
    s.vim.escape()
    expect(s.state()).toEqual({ text: "Xbc", cursor: 0 })

    const line = harness("gone\nstay", 0)
    line.type("S")
    line.editor.insertText("here")
    line.vim.escape()
    expect(line.state()).toEqual({ text: "here\nstay", cursor: 3 })
  })

  test("C changes to end of line only", () => {
    const t = harness("head tail\nnext", 5)
    t.type("C")
    t.editor.insertText("over")
    t.vim.escape()
    expect(t.state()).toEqual({ text: "head over\nnext", cursor: 8 })
  })

  test("J joins with single-space collapse", () => {
    const t = harness("left  \n  right", 0)
    t.type("J")
    expect(t.state()).toEqual({ text: "left right", cursor: 4 })
  })

  test("~ flips case and advances", () => {
    const t = harness("aBc", 0)
    t.type("~", "~", "~")
    expect(t.state()).toEqual({ text: "AbC", cursor: 2 })
  })

  test("u undoes and ctrl+r redoes", () => {
    const t = harness("abc", 0)
    t.type("x")
    expect(t.state()).toEqual({ text: "bc", cursor: 0 })
    t.type("u")
    expect(t.state()).toEqual({ text: "abc", cursor: 0 })
    expect(t.vim.redo()).toBe(true)
    expect(t.state()).toEqual({ text: "bc", cursor: 0 })
  })

  test("dot repeats simple changes", () => {
    const t = harness("aaaa", 0)
    t.type("x")
    t.type(".")
    expect(t.state()).toEqual({ text: "aa", cursor: 0 })
  })
})

describe("vim visual mode", () => {
  test("v e d deletes a wordwise selection", () => {
    const t = harness("big word here", 0)
    t.type("v", "e")
    t.type("d")
    expect(t.state()).toEqual({ text: " word here", cursor: 0 })
  })

  test("V j d deletes whole lines", () => {
    const t = harness("l1\nl2\nkeep", 0)
    t.type("V", "j", "d")
    expect(t.state()).toEqual({ text: "keep", cursor: 0 })
  })

  test("V y p duplicates lines", () => {
    const t = harness("l1\nl2", 0)
    t.type("V", "y", "p")
    expect(t.state()).toEqual({ text: "l1\nl1\nl2", cursor: 3 })
  })

  test("visual yank then paste charwise", () => {
    const t = harness("copy me now", 0)
    t.type("v", "w") // selects "copy " through the word start
    t.type("y")
    t.type("$", "p")
    expect(t.state()).toEqual({ text: "copy me nowcopy ", cursor: 15 })
  })

  test("visual r fills the selection", () => {
    const t = harness("secret hidden", 0)
    t.type("v", "w", "r", "*")
    expect(t.state()).toEqual({ text: "*******hidden", cursor: 0 })
  })

  test("visual ~ toggles the selection case", () => {
    const t = harness("miXeD case", 0)
    t.type("v", "e", "~")
    expect(t.state()).toEqual({ text: "MIxEd case", cursor: 0 })
  })

  test("visual c replaces and enters insert", () => {
    const t = harness("replace me", 0)
    t.type("v", "w", "c")
    expect(t.vim.mode).toBe("insert")
    // w is exclusive: the selection stops before the next word, dropping the
    // separating space (same as vim).
    t.editor.insertText("kept")
    t.vim.escape()
    expect(t.state()).toEqual({ text: "keptme", cursor: 3 })
  })

  test("escape exits visual without edits", () => {
    const t = harness("stable", 0)
    t.type("v", "j")
    expect(t.vim.escape()).toBe(true)
    expect(t.vim.mode).toBe("normal")
    expect(t.state()).toEqual({ text: "stable", cursor: 0 })
  })
})
