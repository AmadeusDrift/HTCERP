import { expect, it } from 'vitest'
import { cleanResearchJpeg } from '../../packages/research-images/jpeg'

const bytes = (values: number[]) => Uint8Array.from(values)
const fixture = [
  255, 216, 255, 225, 0, 6, 65, 66, 67, 68, 255, 192, 0, 11, 8, 0, 100, 0, 110, 1, 1, 17, 0, 255, 218, 0,
  8, 1, 1, 0, 0, 63, 0, 0, 255, 217,
]
it('checks the dimensions and strips APP metadata from a bounded JPEG', () => {
  const result = cleanResearchJpeg(bytes(fixture))
  expect(result).toMatchObject({ width: 110, height: 100 })
  expect([...result.bytes]).not.toContain(225)
})
it('rejects oversized images, incomplete scans, invalid signatures and huge bodies', () => {
  const large = [...fixture]
  large[15] = 8
  for (const value of [
    bytes(large),
    bytes(fixture.slice(0, -2)),
    bytes([0, 1, 2]),
    new Uint8Array(180000),
  ]) {
    expect(() => cleanResearchJpeg(value)).toThrow()
  }
})
