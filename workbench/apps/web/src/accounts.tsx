import { useQueryClient } from '@tanstack/react-query'
import { UserPlus } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { type Account, positionLabels, roles, type Session } from './models'
import { Select, selectOptions } from './select'
import { Badge, Dialog, ErrorBox, Field, Loading, Notice, Panel, request, useData } from './ui'

function AccountDialog({
  account,
  first,
  onClose,
  onSaved,
}: {
  account?: Account
  first: boolean
  onClose: () => void
  onSaved: (account: Account, loginChanged?: boolean) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [selectedRole, setSelectedRole] = useState<string>(first ? 'admin' : account?.role || 'viewer')
  const useDefaultPassword = !account && selectedRole === 'operator'
  const passwordMinimum = first || (account && (account.role === 'admin' || selectedRole === 'admin')) ? 12 : 8
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const form = new FormData(event.currentTarget)
    const role = first ? 'admin' : form.get('role')
    const position = form.get('position') || null
    const active = form.get('active') === 'active'
    const password = String(form.get('password') || '')
    setError(null)
    setBusy(true)
    try {
      if (!account) {
        onSaved(
          await request<Account>('/accounts', {
            username: String(form.get('username')).trim(),
            role,
            ...(position && { position }),
            ...(password && { password }),
          }),
        )
        return
      }
      const changes = {
        ...(role !== account.role && { role }),
        ...(position !== (account.position ?? null) && { position }),
        ...(active !== account.active && { active }),
        ...(password && { password }),
      }
      if (Object.keys(changes).length === 0) return onClose()
      onSaved(
        await request<Account>('/accounts/' + encodeURIComponent(account.id), changes, 'PATCH'),
        Boolean(password || role !== account.role || active !== account.active),
      )
    } catch (err) {
      setError(err)
      setBusy(false)
    }
  }
  return (
    <Dialog
      title={account ? '管理账号 · ' + account.username : '创建账号'}
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <form className="dialog-body stack" onSubmit={save}>
        {first && <Notice>首个账号将成为管理员。创建后，请使用该账号登录。</Notice>}
        {!account && (
          <Field label="账号" hint="3–40 位字母、数字、点、下划线或短横线，以字母或数字开头。">
            <input
              name="username"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              required
              minLength={3}
              maxLength={40}
              pattern="[A-Za-z0-9][A-Za-z0-9._\-]{2,39}"
              placeholder="例如 li.ming"
            />
          </Field>
        )}
        <Field label="职位" hint="职位用于标记团队分工，操作权限由角色决定。">
          <Select
            name="position"
            defaultValue={account?.position || ''}
            options={[{ value: '', label: '未设置' }, ...selectOptions(positionLabels)]}
          />
        </Field>
        <Field label="角色">
          <Select
            name="role"
            disabled={first}
            value={selectedRole}
            onValueChange={setSelectedRole}
            options={['viewer', 'operator', 'admin'].map((value) => ({ value, label: roles[value] }))}
          />
        </Field>
        {account && (
          <Field label="状态">
            <Select
              name="active"
              defaultValue={account.active ? 'active' : 'disabled'}
              options={[
                { value: 'active', label: '已启用' },
                { value: 'disabled', label: '已停用' },
              ]}
            />
          </Field>
        )}
        <Field
          label={account ? '新密码' : '初始密码'}
          hint={
            account
              ? `如需重置密码，请输入 ${passwordMinimum}–128 个字符。留空将保留当前密码。`
              : first
                ? '首个管理员密码需为 12–128 个字符。'
                : useDefaultPassword
                  ? '留空使用运营默认密码，也可以输入 8–128 个字符自定义密码。'
                  : '使用 8–128 个字符，将初始密码私下交给成员。'
          }
        >
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            required={!account && !useDefaultPassword}
            minLength={passwordMinimum}
            maxLength={128}
          />
        </Field>
        {account && <p>重置密码后，成员需重新登录。停用的账号无法登录。</p>}
        <ErrorBox error={error} />
        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button type="submit" disabled={busy} className="primary">
            {busy ? '正在保存…' : account ? '保存更改' : '创建账号'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

export function Accounts({ session }: { session: Session }) {
  const cache = useQueryClient()
  const list = useData<{ items: Account[] }>('/accounts')
  const [editing, setEditing] = useState<Account | 'new' | null>(null)
  const [notice, setNotice] = useState('')
  function saved(account: Account, loginChanged = false) {
    if (session.local || (account.id === session.id && loginChanged)) {
      window.location.replace('/login?next=' + encodeURIComponent('/settings?tab=members'))
      return
    }
    setNotice((editing === 'new' ? '已创建账号 ' : '已更新账号 ') + account.username + '。')
    setEditing(null)
    if (account.id === session.id) void cache.invalidateQueries({ queryKey: ['/session'] })
    void list.refetch()
  }
  return (
    <Panel
      title="成员账号"
      extra={
        <button
          type="button"
          className="primary"
          disabled={!list.isSuccess}
          onClick={() => setEditing('new')}
        >
          <UserPlus />
          创建账号
        </button>
      }
    >
      {notice && (
        <div className="account-notice">
          <Notice success>{notice}</Notice>
        </div>
      )}
      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <div className="panel-body">
          <ErrorBox error={list.error} retry={() => void list.refetch()} />
        </div>
      ) : list.data.items.length === 0 ? (
        <p className="panel-body muted">暂无成员账号。创建首个管理员账号后，即可使用账号密码登录。</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>账号</th>
                <th>职位</th>
                <th>角色</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((a) => (
                <tr key={a.id}>
                  <td>
                    <b>{a.username}</b>
                    {a.id === session.id && <span className="account-me">本人</span>}
                  </td>
                  <td>{a.position ? positionLabels[a.position] : '未设置'}</td>
                  <td>{roles[a.role]}</td>
                  <td>
                    <Badge tone={a.active ? 'teal' : 'neutral'}>{a.active ? '已启用' : '已停用'}</Badge>
                  </td>
                  <td>
                    <button type="button" className="linkbtn" onClick={() => setEditing(a)}>
                      管理
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <AccountDialog
          account={editing === 'new' ? undefined : editing}
          first={session.local}
          onClose={() => setEditing(null)}
          onSaved={saved}
        />
      )}
    </Panel>
  )
}
