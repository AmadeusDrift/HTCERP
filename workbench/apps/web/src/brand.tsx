import { version } from '../../../package.json'

export function Brand() {
  return (
    <>
      <img src="/haetiancity-mark.png" alt="" width="35" height="35" />
      <div>
        <strong>海天城ERP</strong>
        <small>HAETIANCITY ERP v{version}</small>
      </div>
    </>
  )
}
