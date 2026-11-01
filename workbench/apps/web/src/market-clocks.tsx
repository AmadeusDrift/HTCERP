import { useEffect, useState } from 'react'

const clocks = [
  { label: '北京', city: '北京', zone: 'Asia/Shanghai' },
  { label: '美西', city: '洛杉矶', zone: 'America/Los_Angeles' },
].map((clock) => ({
  ...clock,
  date: new Intl.DateTimeFormat('zh-CN', { timeZone: clock.zone, month: '2-digit', day: '2-digit' }),
  time: new Intl.DateTimeFormat('zh-CN', {
    timeZone: clock.zone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }),
}))

export function MarketClocks() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    let timer: number
    function sync() {
      window.clearTimeout(timer)
      const current = new Date()
      setNow(current)
      timer = window.setTimeout(sync, 60_000 - (current.getTime() % 60_000))
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', sync)
    }
  }, [])

  return (
    <section className="market-clocks" aria-label="市场时钟">
      {clocks.map(({ label, city, zone, date, time }) => (
        <div className="market-clock" key={zone} title={city + ' · ' + zone}>
          <span>
            {label}
            <span className="clock-suffix">时间</span>
          </span>
          <time dateTime={now.toISOString()}>
            <span className="clock-date">{date.format(now)}</span> {time.format(now)}
          </time>
        </div>
      ))}
    </section>
  )
}
