// ComputerV2 Phase 2 — keys and pointer buttons as CDP `Input.*` events. The page's own events only: nothing here
// touches the OS pointer or the user's keyboard. Combos use Phase 1's words: "cmd+s", "return", "shift+tab".
import { AutomationFailure } from "../errors";

export const MOD_ALT = 1;
export const MOD_CTRL = 2;
export const MOD_META = 4;
export const MOD_SHIFT = 8;

const MODIFIER_WORDS: Record<string, number> = {
  cmd: MOD_META, command: MOD_META, meta: MOD_META, super: MOD_META, win: MOD_META,
  ctrl: MOD_CTRL, control: MOD_CTRL,
  alt: MOD_ALT, option: MOD_ALT, opt: MOD_ALT,
  shift: MOD_SHIFT,
};

/** A key's CDP identity: its `key`, `code` and Windows virtual key code, and the text it types (if any). */
export interface KeyDef { key: string; code: string; keyCode: number; text?: string; shiftKey?: string }

const NAMED: Record<string, KeyDef> = {
  return: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  forwarddelete: { key: "Delete", code: "Delete", keyCode: 46 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  insert: { key: "Insert", code: "Insert", keyCode: 45 },
};
for (let i = 1; i <= 12; i++) NAMED[`f${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i };

const PUNCT: Record<string, { code: string; keyCode: number; shift?: boolean }> = {
  "-": { code: "Minus", keyCode: 189 }, "_": { code: "Minus", keyCode: 189, shift: true },
  "=": { code: "Equal", keyCode: 187 }, "+": { code: "Equal", keyCode: 187, shift: true },
  "[": { code: "BracketLeft", keyCode: 219 }, "{": { code: "BracketLeft", keyCode: 219, shift: true },
  "]": { code: "BracketRight", keyCode: 221 }, "}": { code: "BracketRight", keyCode: 221, shift: true },
  "\\": { code: "Backslash", keyCode: 220 }, "|": { code: "Backslash", keyCode: 220, shift: true },
  ";": { code: "Semicolon", keyCode: 186 }, ":": { code: "Semicolon", keyCode: 186, shift: true },
  "'": { code: "Quote", keyCode: 222 }, "\"": { code: "Quote", keyCode: 222, shift: true },
  ",": { code: "Comma", keyCode: 188 }, "<": { code: "Comma", keyCode: 188, shift: true },
  ".": { code: "Period", keyCode: 190 }, ">": { code: "Period", keyCode: 190, shift: true },
  "/": { code: "Slash", keyCode: 191 }, "?": { code: "Slash", keyCode: 191, shift: true },
  "`": { code: "Backquote", keyCode: 192 }, "~": { code: "Backquote", keyCode: 192, shift: true },
};
const SHIFTED_DIGITS = ")!@#$%^&*(";

/** The key for one character (a letter, digit or punctuation mark); undefined for anything else. */
export function keyForChar(ch: string): (KeyDef & { shift: boolean }) | undefined {
  if (/^[a-z]$/.test(ch)) return { key: ch, code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0), text: ch, shift: false };
  if (/^[A-Z]$/.test(ch)) return { key: ch, code: `Key${ch}`, keyCode: ch.charCodeAt(0), text: ch, shift: true };
  if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0), text: ch, shift: false };
  const sd = SHIFTED_DIGITS.indexOf(ch);
  if (sd >= 0) return { key: ch, code: `Digit${sd}`, keyCode: 48 + sd, text: ch, shift: true };
  const p = PUNCT[ch];
  if (p !== undefined) return { key: ch, code: p.code, keyCode: p.keyCode, text: ch, shift: p.shift === true };
  if (ch === " ") return { ...NAMED.space!, shift: false };
  return undefined;
}

/**
 * The macOS editing commands each combo means (AppKit's standard key bindings), sent WITH the key event as
 * `Input.dispatchKeyEvent`'s `commands`: on a Mac it is the native text system — or, in Winter's browser, the app's
 * menu, which no longer sees a held tab's keys — that turns a key into an edit, never the page. A command runs only in
 * an editable element (elsewhere it is not enabled, and the key's ordinary handling — scrolling, a slider — goes on).
 * Return, Tab and Escape carry none: their default handling (submitting a form, moving the focus) is the page's own.
 * Never copy, cut or paste: those reach the user's own clipboard (`parseCombo` refuses them).
 */
const MAC_COMMANDS: Record<string, string[]> = {
  "meta+a": ["selectAll"], "meta+z": ["undo"], "meta+shift+z": ["redo"],
  // deletion
  "backspace": ["deleteBackward"], "shift+backspace": ["deleteBackward"], "alt+backspace": ["deleteWordBackward"],
  "meta+backspace": ["deleteToBeginningOfLine"], "ctrl+backspace": ["deleteBackwardByDecomposingPreviousCharacter"],
  "delete": ["deleteForward"], "alt+delete": ["deleteWordForward"], "meta+delete": ["deleteToEndOfLine"],
  "ctrl+h": ["deleteBackward"], "ctrl+d": ["deleteForward"], "ctrl+k": ["deleteToEndOfParagraph"],
  // the caret
  "arrowleft": ["moveLeft"], "arrowright": ["moveRight"], "arrowup": ["moveUp"], "arrowdown": ["moveDown"],
  "alt+arrowleft": ["moveWordLeft"], "alt+arrowright": ["moveWordRight"],
  "alt+arrowup": ["moveBackward", "moveToBeginningOfParagraph"], "alt+arrowdown": ["moveForward", "moveToEndOfParagraph"],
  "meta+arrowleft": ["moveToBeginningOfLine"], "meta+arrowright": ["moveToEndOfLine"],
  "meta+arrowup": ["moveToBeginningOfDocument"], "meta+arrowdown": ["moveToEndOfDocument"],
  "ctrl+a": ["moveToBeginningOfParagraph"], "ctrl+e": ["moveToEndOfParagraph"],
  "ctrl+b": ["moveBackward"], "ctrl+f": ["moveForward"], "ctrl+p": ["moveUp"], "ctrl+n": ["moveDown"],
  // the selection
  "shift+arrowleft": ["moveLeftAndModifySelection"], "shift+arrowright": ["moveRightAndModifySelection"],
  "shift+arrowup": ["moveUpAndModifySelection"], "shift+arrowdown": ["moveDownAndModifySelection"],
  "alt+shift+arrowleft": ["moveWordLeftAndModifySelection"], "alt+shift+arrowright": ["moveWordRightAndModifySelection"],
  "alt+shift+arrowup": ["moveParagraphBackwardAndModifySelection"], "alt+shift+arrowdown": ["moveParagraphForwardAndModifySelection"],
  "meta+shift+arrowleft": ["moveToBeginningOfLineAndModifySelection"], "meta+shift+arrowright": ["moveToEndOfLineAndModifySelection"],
  "meta+shift+arrowup": ["moveToBeginningOfDocumentAndModifySelection"], "meta+shift+arrowdown": ["moveToEndOfDocumentAndModifySelection"],
};

export interface KeyPress { modifiers: number; def: KeyDef; commands?: string[] }

/** "cmd+shift+z" → the press, or a TypeError naming what it could not read. */
export function parseCombo(combo: string): KeyPress {
  const parts = combo.trim().split("+").map((p) => p.trim()).filter((p) => p.length > 0);
  // "cmd++" (a plus key) splits into an empty last part: keep it as "+".
  if (combo.trim().endsWith("++") || combo.trim() === "+") parts.push("+");
  if (parts.length === 0) throw Object.assign(new TypeError("key() takes a combo such as \"cmd+s\""), { name: "TypeError" });
  let modifiers = 0;
  const last = parts[parts.length - 1]!;
  for (const m of parts.slice(0, -1)) {
    const bit = MODIFIER_WORDS[m.toLowerCase()];
    if (bit === undefined) throw Object.assign(new TypeError(`key(): "${m}" is not a modifier (cmd, ctrl, alt/option, shift)`), { name: "TypeError" });
    modifiers |= bit;
  }
  let def: KeyDef | undefined = NAMED[last.toLowerCase()];
  if (def === undefined && [...last].length === 1) {
    const k = keyForChar(last.length === 1 && /[A-Z]/.test(last) && modifiers !== 0 ? last.toLowerCase() : last);
    if (k !== undefined) { def = k; if (k.shift) modifiers |= MOD_SHIFT; }
  }
  if (def === undefined) throw Object.assign(new TypeError(`key(): "${last}" is not a key name (return, tab, escape, up, a, 1, …)`), { name: "TypeError" });
  // Copy, cut and paste would read or write the user's own clipboard: refused, never sent.
  const k = def.key.toLowerCase();
  if ((modifiers & (MOD_META | MOD_CTRL)) !== 0 && (k === "c" || k === "x" || k === "v")) {
    throw new AutomationFailure("Refused", "copy, cut and paste keys would use the user's clipboard — use paste(text) to put text in, and text() or state() to read it");
  }
  if ((modifiers & MOD_SHIFT) !== 0 && k === "insert") throw new AutomationFailure("Refused", "that key pastes from the user's clipboard — use paste(text)");
  const name = [modifiers & MOD_META ? "meta" : "", modifiers & MOD_CTRL ? "ctrl" : "", modifiers & MOD_ALT ? "alt" : "", modifiers & MOD_SHIFT ? "shift" : "", def.key.toLowerCase()].filter((x) => x.length > 0).join("+");
  const commands = MAC_COMMANDS[name];
  return { modifiers, def, ...(commands === undefined ? {} : { commands }) };
}

/** The two `Input.dispatchKeyEvent` params (down, up) for a press. Text is sent only for a printable key with no
 *  command modifier (shift alone still types). */
export function keyEvents(p: KeyPress): [Record<string, unknown>, Record<string, unknown>] {
  const types = p.def.text !== undefined && (p.modifiers & (MOD_META | MOD_CTRL | MOD_ALT)) === 0;
  const base = { modifiers: p.modifiers, key: p.def.key, code: p.def.code, windowsVirtualKeyCode: p.def.keyCode, nativeVirtualKeyCode: p.def.keyCode };
  const down: Record<string, unknown> = { type: types ? "keyDown" : "rawKeyDown", ...base, ...(types ? { text: p.def.text, unmodifiedText: p.def.text } : {}), ...(p.commands === undefined ? {} : { commands: p.commands }) };
  return [down, { type: "keyUp", ...base }];
}

/** The `Input.dispatchMouseEvent` button name and its `buttons` bit. */
export function buttonOf(b: unknown): { button: "left" | "right" | "middle"; buttons: number } {
  if (b === "right") return { button: "right", buttons: 2 };
  if (b === "middle") return { button: "middle", buttons: 4 };
  return { button: "left", buttons: 1 };
}

export function modifiersOf(list: unknown): number {
  if (!Array.isArray(list)) return 0;
  let m = 0;
  for (const w of list) if (typeof w === "string") m |= MODIFIER_WORDS[w.toLowerCase()] ?? 0;
  return m;
}
