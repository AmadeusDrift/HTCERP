import { KeyRound } from 'lucide-react'
import { type FormEvent, useRef, useState } from 'react'
import type { GeekSlot } from './models'
import { Dialog, ErrorBox, Field, request } from './ui'

const providers = {
  geekbi: {
    name: '极鲸云 API',
    fields: { GB_APP_KEY: 'App Key', GB_APP_SECRET: 'App Secret' },
  },
  amazon: {
    name: 'Amazon SP-API',
    fields: {
      SP_CLIENT_ID: 'LWA Client ID',
      SP_CLIENT_SECRET: 'LWA Client Secret',
      SP_REFRESH_TOKEN: 'Refresh Token',
    },
  },
  openrouter: {
    name: 'OpenRouter',
    fields: { OPENROUTER_API_KEY: 'API Key' },
  },
}

export type CredentialProvider = keyof typeof providers

export function ConnectionCredentials({
  provider,
  configured,
  available,
  slots,
  onSaved,
}: {
  provider: CredentialProvider
  configured: boolean
  available: boolean
  slots?: GeekSlot[]
  onSaved: () => void
}) {
  const { name, fields } = providers[provider]
  const form = useRef<HTMLFormElement>(null)
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [slot, setSlot] = useState(1)
  const isBound = (n: number) => slots?.find((s) => s.slot === n)?.configured ?? false
  const bindingLabel = (n: number) => {
    const row = slots?.find(s => s.slot === n)
    if (!row) return '未核对'
    if (row.binding === 'locked') return '无法读取'
    if (row.binding === 'incomplete') return '待补全'
    return row.configured ? '已绑定' : '未绑定'
  }
  const action = configured ? '更新凭据' : '配置连接'

  function close() {
    if (saving) return
    form.current?.reset()
    setOpen(false)
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!available || saving) return
    const credentials = Object.fromEntries(new FormData(event.currentTarget))
    if (Object.values(credentials).some((v) => typeof v !== 'string' || !v || v.trim() !== v)) {
      setError('请填写全部凭据，并去除首尾空白。')
      return
    }
    setSaving(true)
    setError('')
    try {
      const result = await request<{ ok: boolean }>('/connections/' + provider + '/credentials', {
        credentials,
        ...(provider === 'geekbi' && slot !== 1 ? { slot } : {}),
      })
      if (result?.ok !== true) throw new Error()
      form.current?.reset()
      setOpen(false)
      setSaved(true)
      onSaved()
    } catch {
      setError('凭据保存失败。请核对所有字段并重试。')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      {saved && (
        <span role="status">
          {provider === 'geekbi' ? '第 ' + slot + ' 组凭据已保存' : '凭据已保存'}
        </span>
      )}
      <button
        type="button"
        aria-haspopup="dialog"
        disabled={!available}
        title={available ? undefined : '服务端尚未启用凭据保存'}
        onClick={() => {
          setError('')
          setSaved(false)
          setSlot(1)
          setOpen(true)
        }}
      >
        <KeyRound />
        {action}
      </button>
      {open && available && (
        <Dialog title={name + ' · ' + action} onClose={close}>
          <form ref={form} className="dialog-body stack" autoComplete="off" onSubmit={save}>
            {provider === 'geekbi' && (
              <fieldset className="geekbi-slots">
                <legend>选择要配置的密钥组</legend>
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    aria-pressed={slot === n}
                    disabled={saving}
                    onClick={() => {
                      if (n === slot) return
                      form.current?.reset()
                      setSlot(n)
                      setError('')
                    }}
                  >
                    <b>第 {n} 组</b>
                    <small>{bindingLabel(n)}</small>
                  </button>
                ))}
              </fieldset>
            )}
            <p>
              {(provider === 'geekbi' ? isBound(slot) : configured)
                ? '请重新填写全部字段。保存后，整组凭据将替换当前配置。'
                : '请填写该服务的全部凭据。'}
              保存后仅显示绑定状态。
            </p>
            {Object.entries(fields).map(([key, label]) => (
              <Field key={key} label={label + '（' + key + '）'}>
                <input
                  type="password"
                  name={key}
                  autoComplete="off"
                  spellCheck={false}
                  autoCapitalize="none"
                  required
                  readOnly={saving}
                  maxLength={4096}
                />
              </Field>
            ))}
            <ErrorBox error={error} />
            <div className="dialog-actions">
              <button type="button" disabled={saving} onClick={close}>
                取消
              </button>
              <button type="submit" className="primary" disabled={saving}>
                {saving ? '正在保存…' : '保存凭据'}
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </>
  )
}
