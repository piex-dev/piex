# @piex-dev/theme-dark-terminal

High-contrast terminal-inspired dark theme for pi, adapted from [opencode-themes/dark-terminal](https://github.com/debugtalk/opencode-themes).

## 深度解读

- 博客：https://piex.dev/zh/blogs/theme-dark-terminal/
- 源稿：[`docs/notes/theme-dark-terminal.md`](../../docs/notes/theme-dark-terminal.md)

## Palette

| Color                       | Hex       |
| --------------------------- | --------- |
| Green (primary accent)      | `#00ff00` |
| Blue (secondary accent)     | `#00aaff` |
| Cyan (info / variable)      | `#00ffcc` |
| Red (error / string)        | `#ff0000` |
| Yellow (warning / function) | `#ffff00` |
| Text                        | `#e0e0e0` |
| Background                  | `#050505` |

A full-on terminal aesthetic — pure `#00ff00` green on `#050505` black, with vivid cyan, blue, red, and yellow accents. No gradients, no pastels, no compromises.

## Design Notes

Key mapping decisions from [dark-terminal](https://github.com/debugtalk/opencode-themes):

| dark-terminal role                          | pi tokens                                                                                   | rationale                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `green` `#00ff00`                           | accent, success, mdHeading, mdListBullet, syntaxNumber, syntaxType, toolDiffAdded, bashMode | Terminal green dominates — accent is always green, syntax types and diffs follow                            |
| `blue` `#00aaff`                            | border, mdLink, customMessageLabel, syntaxKeyword                                           | Blue for structural elements: borders, links, and language keywords                                         |
| `cyan` `#00ffcc`                            | borderAccent, dim, thinkingMedium, syntaxVariable                                           | Cyan for highlighted borders, status/footer dim info, variables, and mid-level thinking intensity           |
| `red` `#ff0000`                             | error, syntaxString, thinkingXhigh                                                          | Pure red for errors, string literals, and the highest thinking level                                        |
| `yellow` `#ffff00`                          | warning, syntaxFunction, thinkingHigh                                                       | Yellow for function names and warnings; bright and attention-grabbing                                       |
| `dimGray` `#aaaaaa`                         | muted, syntaxOperator, syntaxPunctuation, thinkingText, thinkingMinimal                     | Readable gray for secondary text and low-priority syntax elements                                           |
| `darkGray` `#555555`                        | borderMuted, mdQuoteBorder, mdHr, thinkingOff                                               | Dark gray for borders and dividers; visually recessive                                                      |
| `bg` `#050505` / `panelBg` `#0a0a0a`        | selectedBg, userMessageBg, toolPendingBg, export.pageBg                                     | Near-black backgrounds: pure `#050505` for page, slightly lifted for panels                                 |
| `successBg` `#001100` / `errorBg` `#110000` | toolSuccessBg, toolErrorBg                                                                  | Deeply tinted backgrounds for tool success/error states; subtle but recognizable                            |
| `thinkingMax`                               | `#ff0088` (new)                                                                             | No direct equivalent in dark-terminal; bright pink adds a terminal-appropriate top-level thinking indicator |

## Install

```bash
pi install npm:@piex-dev/theme-dark-terminal
```

## Select

```bash
/settings
```

Set `"theme": "dark-terminal"`.

## License

MIT
