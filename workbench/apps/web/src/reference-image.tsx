import { ImagePlus, X } from 'lucide-react'
import { useState } from 'react'
import { ErrorBox, request, useAccess } from './ui'

export async function prepareReference(file: File) {
  if (!['image/jpeg', 'image/png'].includes(file.type)) throw new Error('请选择 JPEG 或 PNG 图片。')
  if (file.size > 16 * 1024 * 1024) throw new Error('原图超过 16 MB，请先缩小图片。')
  const src = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = src
    await img.decode()
    const scale = Math.min(1, 512 / Math.max(img.naturalWidth, img.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('浏览器无法处理该图片，请尝试另一张图。')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    for (const quality of [0.82, 0.65, 0.45]) {
      const dataUrl = canvas.toDataURL('image/jpeg', quality)
      if (atob(dataUrl.split(',')[1]).length <= 160 * 1024) return dataUrl
    }
    throw new Error('压缩后仍超过 160 KB，请选择更小的参考图。')
  } finally {
    URL.revokeObjectURL(src)
  }
}
export function ReferenceImage({ id, change }: { id: string; change: (id: string) => void }) {
  const { edit } = useAccess(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  async function upload(file?: File) {
    if (!file || busy) return
    setBusy(true)
    setError('')
    try {
      const dataUrl = await prepareReference(file)
      const saved = await request<{ id: string }>('/research-images', { dataUrl })
      change(saved.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : '上传失败，请重新选择参考图。')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="reference-image">
      <div className="spread">
        <h3>
          <ImagePlus size={15} /> 商品参考图
        </h3>
        <small>可选 · 私有附件</small>
      </div>
      <p>可上传图片与商品资料人工对照，再选定研究对象。</p>
      {id ? (
        <div className="reference-preview">
          <img src={'/api/research-images/' + encodeURIComponent(id)} alt="待人工对照的商品参考图" />
          <span>已添加参考图</span>
          <button type="button" className="icon" aria-label="移除参考图" onClick={() => change('')}>
            <X />
          </button>
        </div>
      ) : (
        <input
          type="file"
          aria-label="上传商品参考图"
          accept="image/png,image/jpeg"
          disabled={!edit || busy}
          onChange={(e) => {
            void upload(e.target.files?.[0])
            e.target.value = ''
          }}
        />
      )}
      {busy && <small role="status">正在压缩并上传…</small>}
      <ErrorBox error={error} />
    </div>
  )
}
