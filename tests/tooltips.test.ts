import { expect, test } from "bun:test"
import { getTooltipPosition } from "../src/app/tooltips.js"

test("tooltips are centered below their trigger when there is room", () => {
  expect(
    getTooltipPosition(
      { left: 200, right: 240, top: 80, bottom: 110 },
      { width: 180, height: 60 },
      { width: 800, height: 600 },
    ),
  ).toEqual({ left: 130, top: 118 })
})

test("tooltips stay inside both horizontal viewport edges", () => {
  const size = { width: 240, height: 60 }
  const viewport = { width: 390, height: 700 }
  expect(
    getTooltipPosition({ left: 0, right: 28, top: 80, bottom: 110 }, size, viewport).left,
  ).toBe(12)
  expect(
    getTooltipPosition({ left: 362, right: 390, top: 80, bottom: 110 }, size, viewport).left,
  ).toBe(138)
})

test("tooltips flip above a trigger near the bottom of the viewport", () => {
  expect(
    getTooltipPosition(
      { left: 200, right: 240, top: 540, bottom: 570 },
      { width: 180, height: 80 },
      { width: 800, height: 600 },
    ).top,
  ).toBe(452)
})

test("a tall tooltip stays within the vertical viewport margins", () => {
  expect(
    getTooltipPosition(
      { left: 200, right: 240, top: 120, bottom: 150 },
      { width: 180, height: 260 },
      { width: 800, height: 300 },
    ).top,
  ).toBe(12)
})
