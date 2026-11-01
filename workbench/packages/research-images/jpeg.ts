import { PublicError } from '../contracts/errors'

const maximumBytes = 160 * 1024
const invalid = () =>
  new PublicError('INVALID_INPUT', '请上传已缩小至 512 像素、160 KiB 以内的标准 JPEG 参考图。', 400)
export function cleanResearchJpeg(input: Uint8Array) {
  if (input.length > maximumBytes || input[0] !== 255 || input[1] !== 216) throw invalid()
  const output = new Uint8Array(input.length)
  output.set(input.subarray(0, 2))
  let offset = 2,
    written = 2,
    width = 0,
    height = 0
  while (offset + 4 <= input.length) {
    if (input[offset] !== 255) throw invalid()
    const marker = input[offset + 1],
      length = (input[offset + 2] << 8) | input[offset + 3],
      end = offset + 2 + length
    if (length < 2 || end > input.length) throw invalid()
    if (marker === 192) {
      if (width || length < 11 || input[offset + 4] !== 8) throw invalid()
      height = (input[offset + 5] << 8) | input[offset + 6]
      width = (input[offset + 7] << 8) | input[offset + 8]
      if (!width || !height || width > 512 || height > 512) throw invalid()
    }
    if (marker === 218) {
      if (!width || length < 6 || end >= input.length - 2) throw invalid()
      for (let i = end; i < input.length - 1; i++) {
        if (input[i] !== 255) continue
        const next = input[++i]
        if (next === 217 && i === input.length - 1) {
          output.set(input.subarray(offset), written)
          return { bytes: output.slice(0, written + input.length - offset), width, height }
        }
        if (next !== 0 && !(next >= 208 && next <= 215)) throw invalid()
      }
      throw invalid()
    }
    if ([192, 196, 219, 221].includes(marker)) {
      output.set(input.subarray(offset, end), written)
      written += end - offset
    } else if (!(marker >= 224 && marker <= 239) && marker !== 254) throw invalid()
    offset = end
  }
  throw invalid()
}
