# HACK-ATTACK Brand Guidelines

Rev 0.1 — DRAFT for Don Hagell's review, 2026-10-02. Not locked.

Started on Don's instruction (2026-10-02): "extract the legend from common laser lines and all 15 to the
hack-attack brand guidelines". No HACK-ATTACK brand guideline existed before this file; the folder was empty.
Only the colour palette below has a source. Everything else is a placeholder awaiting Don's decisions.

---

## 1. Colour palette — common laser lines

Source: the "Common laser lines" legend on the Force-Field Brand Guidelines canvas (2026-10-01). Image:
`laser-lines-legend.png`. Tokens: `hack-attack-laser-palette.css`, `hack-attack-laser-palette.json`.

| # | Wavelength | Laser | Hex | RGB | Token |
|---|---|---|---|---|---|
| 1 | 405 nm | Violet diode (Blu-ray) | `#8200C8` | 130, 0, 200 | `--laser-405nm` |
| 2 | 445 nm | Blue diode (high power) | `#0028FF` | 0, 40, 255 | `--laser-445nm` |
| 3 | 473 nm | Blue DPSS | `#00B7FF` | 0, 183, 255 | `--laser-473nm` |
| 4 | 488 nm | Argon-ion / OPSL | `#00F7FF` | 0, 247, 255 | `--laser-488nm` |
| 5 | 514.5 nm | Argon-ion green | `#1CFF00` | 28, 255, 0 | `--laser-514_5nm` |
| 6 | 520 nm | Green diode | `#36FF00` | 54, 255, 0 | `--laser-520nm` |
| 7 | 532 nm | Green DPSS (doubled Nd) | `#65FF00` | 101, 255, 0 | `--laser-532nm` |
| 8 | 543.5 nm | Green HeNe | `#8DFF00` | 141, 255, 0 | `--laser-543_5nm` |
| 9 | 561 nm | Yellow-green DPSS | `#C6FF00` | 198, 255, 0 | `--laser-561nm` |
| 10 | 594.1 nm | Yellow HeNe | `#FFD200` | 255, 210, 0 | `--laser-594_1nm` |
| 11 | 604.6 nm | Orange HeNe | `#FFAE00` | 255, 174, 0 | `--laser-604_6nm` |
| 12 | 632.8 nm | Red HeNe | `#FF4300` | 255, 67, 0 | `--laser-632_8nm` |
| 13 | 635 nm | Red diode | `#FF3900` | 255, 57, 0 | `--laser-635nm` |
| 14 | 650 nm | Red diode (DVD, pointers) | `#FF0000` | 255, 0, 0 | `--laser-650nm` |
| 15 | 660 nm | Deep-red diode | `#FF0000` | 255, 0, 0 | `--laser-660nm` |

### Notes on the palette

- The hex values are the Bruton wavelength-to-RGB approximation (gamma 0.8). A single-wavelength laser is more
  saturated than any screen can show; these are best screen matches, not true colours.
- Rows 14 and 15 (650 and 660 nm) resolve to the same hex, `#FF0000`. Rows 12 and 13 (632.8 and 635 nm) are
  nearly identical. As a palette, 15 lines give at most 14 distinct colours `[decision needed: keep all 15 as
  reference, or pick a working subset]`.
- The laser wavelengths and laser types are general knowledge (training data), not from a document Don supplied.
- Several values are very bright, fully saturated colours; check text contrast before using any as a text colour
  on a light background.

---

## 2. Still to define

None of these has a source yet:

1. What HACK-ATTACK is (product, event or project) and its relationship to Spin State Labs.
2. Background and text colours, and which laser colours are primary, accent or status.
3. Typography.
4. Logo or wordmark.
5. Usage rules.

## Sources

- Force-Field Brand Guidelines canvas, "Reference · common laser lines" board, 2026-10-01.
- Don, 2026-10-02: instruction to carry the 15 laser lines into the HACK-ATTACK brand guidelines.
