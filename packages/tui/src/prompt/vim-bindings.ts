import type { TextareaRenderable } from "@opentui/core"
import { createEffect, createSignal, type Accessor } from "solid-js"
import { useBindings } from "../keymap"
import { createPromptVim, VIM_DESCS, VIM_SEEDS, type VimMode } from "./vim"

export type VimCursorStyle = {
  style: "block" | "underline" | "line" | "default"
  blinking: boolean
}

export type VimBindingsOptions = {
  /** Reactive textarea target; bindings only fire while it is focused. */
  target: Accessor<TextareaRenderable | undefined>
  /** Extra enable guard (dialogs, autocomplete, editing state...). */
  guard?: () => boolean
  disabled?: () => boolean
  /** Initial enabled state (tuiConfig.vim); toggling persists via onToggle. */
  initialEnabled: boolean
  onToggle?: (next: boolean) => void
  cursor?: VimCursorStyle | undefined
  /** What return means outside insert mode (submit / confirm / commit). */
  onSubmit: () => void
}

/**
 * Shared vim modal editing for prompt-like textareas: one keymap layer per
 * textarea (one target subscription — every targeted layer adds a
 * `destroyed` listener on the textarea and Node caps those at 10).
 *
 * ctrl+g toggles vim; escape, printable keys, and return route through the
 * controller in normal/visual modes; return inserts a newline in insert mode
 * so typing never submits. Rejecting cmds (returning false) fall through to
 * lower layers, e.g. escape in normal mode still reaches cancel/interrupt.
 */
export function registerVimBindings(options: VimBindingsOptions) {
  const [vimEnabled, setVimEnabled] = createSignal(options.initialEnabled)
  const [vimMode, setVimMode] = createSignal<VimMode>("insert")
  const vim = createPromptVim({
    editor: () => {
      const area = options.target()
      return area && !area.isDestroyed ? area : undefined
    },
    onModeChange: setVimMode,
  })

  function toggleVim() {
    const next = !vimEnabled()
    setVimEnabled(next)
    options.onToggle?.(next)
    if (next) vim.escape()
    else vim.hardReset()
    setVimMode(vim.mode)
  }

  useBindings(() => {
    const guard = options.guard?.() ?? true
    const vimActive = vimEnabled() && options.target() !== undefined && !(options.disabled?.() ?? false) && guard
    const normal = vimActive && vimMode() !== "insert"
    const insert = vimActive && vimMode() === "insert"
    return {
      target: options.target,
      enabled: options.target() !== undefined && !(options.disabled?.() ?? false) && guard,
      priority: 1,
      bindings: [
        {
          key: "ctrl+g",
          desc: vimEnabled() ? "Vim: disable modal editing" : "Vim: enable modal editing",
          group: "Vim",
          cmd: toggleVim,
        },
        ...(vimActive
          ? [
              {
                key: "escape",
                desc: "Vim: back to normal mode",
                group: "Vim",
                cmd: () => (vim.escape() ? undefined : false),
              },
            ]
          : []),
        ...(normal
          ? [
              ...VIM_SEEDS.map(({ key, char }) => ({
                key,
                ...(VIM_DESCS[char] ? { desc: VIM_DESCS[char] } : {}),
                group: "Vim",
                cmd: () => (vim.key(char) ? undefined : false),
              })),
              {
                key: "ctrl+r",
                desc: VIM_DESCS["ctrl+r"],
                group: "Vim",
                cmd: () => (vim.redo() ? undefined : false),
              },
              {
                key: "return",
                desc: "Vim: submit from normal mode",
                group: "Vim",
                cmd: () => {
                  options.onSubmit()
                  return undefined
                },
              },
            ]
          : []),
        ...(insert
          ? [
              {
                key: "return",
                desc: "Vim: insert newline",
                group: "Vim",
                cmd: () => {
                  const area = options.target()
                  if (!area || area.isDestroyed) return false
                  area.insertText("\n")
                  return undefined
                },
              },
            ]
          : []),
      ],
    }
  })

  createEffect(() => {
    const area = options.target()
    if (!vimEnabled() || !area || area.isDestroyed) return
    if (vimMode() === "insert") {
      if (options.cursor) area.cursorStyle = options.cursor
      return
    }
    area.cursorStyle = { style: "block", blinking: false }
  })

  return { vim, vimEnabled, vimMode, toggleVim }
}
