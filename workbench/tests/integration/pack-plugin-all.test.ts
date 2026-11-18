import { existsSync, readFileSync } from 'node:fs'
import { chromium, type Page } from '@playwright/test'
import { expect, it } from 'vitest'
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const executablePath = process.env.PLAYWRIGHT_BROWSER_PATH ?? (existsSync(edge) ? edge : undefined)
const dir = new URL('../../extensions/sellerflex-inventory/', import.meta.url)
const source = (name: string) => existsSync(new URL(name,dir)) ? readFileSync(new URL(name,dir),'utf8') : ''
async function setup(page: Page, mode = 'ok') {
  await page.route('https://sellerflex.amazon.com/**', route => route.fulfill({contentType:'text/html',body:`<div id="awui-transshipment-pack-page">
    <input placeholder="Search by transshipment ID" value=""><input id="datepicker-1" value="11/17/2026">
    <div role="combobox" id="select-1">Shipout Time: 4:00 PM</div>
    <span><div>Ready to pack (3)</div><input role="tab" type="radio" value="READY_TO_PACK" checked></span>
    <span><div>Packed (640)</div><input role="tab" type="radio" value="PACKED"></span>
    <button id="export" disabled>Download &amp; print all transshipments</button><button id="pack">Pack</button>
    <table><thead><tr><th><input id="select-all" type="checkbox"></th><th>Transshipment ID</th><th>SKU details</th><th>MSKU</th><th>Content</th><th>Units</th></tr></thead><tbody></tbody></table><button id="more">Load More</button></div>`}))
  await page.goto('https://sellerflex.amazon.com/transshipments/pack')
  await page.evaluate(mode => {
    const test = {more:0,exports:0,packed:0,messages:[] as any[],mode}; (window as any).allTest=test
    const root=document.getElementById('awui-transshipment-pack-page')!,tbody=root.querySelector('tbody')!
    const row=(n:number)=>`<tr><td><input type="checkbox" ${n===1?'checked':''}></td><td>TR${n}</td><td>FN${n}</td><td>SKU${n}</td><td>Product ${n}</td><td>${n}</td></tr>`
    tbody.innerHTML=row(1)
    root.addEventListener('change',()=>{ (document.getElementById('export') as HTMLButtonElement).disabled=!root.querySelector('tbody input:checked') })
    document.getElementById('select-all')!.addEventListener('change',event=>{root.querySelectorAll<HTMLInputElement>('tbody input').forEach(c=>c.checked=(event.target as HTMLInputElement).checked)})
    document.getElementById('more')!.addEventListener('click',()=>{
      test.more++;const more=document.getElementById('more') as HTMLButtonElement;more.disabled=true
      if(mode==='stall')return
      setTimeout(()=>{
        if(mode==='filter-change')(document.getElementById('datepicker-1') as HTMLInputElement).value='11/18/2026'
        if(mode==='count-change')root.querySelector('[role="tab"]')!.previousElementSibling!.textContent='Ready to pack (4)'
        if(test.more<=2)tbody.insertAdjacentHTML('beforeend',row(test.more+1))
        if(mode==='partial'||test.more===2&&mode!=='retained-more'||mode==='retained-more'&&test.more===4)more.remove();else more.disabled=false
      },60)
    })
    document.getElementById('pack')!.addEventListener('click',()=>test.packed++)
    document.getElementById('export')!.addEventListener('click',()=>{
      test.exports++
      const selected=[...root.querySelectorAll<HTMLTableRowElement>('tbody tr')].filter(r=>r.querySelector<HTMLInputElement>('input')!.checked)
      const dialog=document.createElement('div');dialog.setAttribute('role','dialog')
      dialog.innerHTML='<h2>Order List</h2><button id="native-xlsx">Download order list</button><table><thead><tr><th>Product title</th><th>SKU</th><th>FNSKU</th><th>Transfer Id</th><th>Units</th></tr></thead><tbody>'+selected.map((r,i)=>{const cells=[...r.querySelectorAll('td')].map(c=>c.textContent);return `<tr><td>${cells[4]}</td><td>${mode==='wrong-dialog'&&i===0?'WRONG':cells[3]}</td><td>${cells[2]}</td><td>${cells[1]}</td><td>${cells[5]}</td></tr>`}).join('')+'</tbody></table>'
      root.appendChild(dialog)
      document.getElementById('native-xlsx')!.addEventListener('click',()=>{
        const a=document.createElement('a');a.download='transshipment-order-list-2026-11-17.xlsx';a.href='data:application/octet-stream;base64,'+btoa('PK\x03\x04all-orders');a.click()
      })
    })
    ;(window as any).chrome={runtime:{sendMessage:async(message:any)=>{
      test.messages.push(message)
      if(message.operation==='resume')return {ok:true,value:null}
      return {ok:true,value:{batch:{id:'all-batch',labelSource:'AMAZON_API',labelGroups:[{group:'Group',ready:true}],state:'READY',totalRows:3,newRows:3,skippedRows:0,conflicts:[]}}}
    }}}
  },mode)
  for(const file of ['pack-export-main.js','pack-all.js','pack-content.js'])if(source(file))await page.addScriptTag({content:source(file)})
}
it.each(['ok','retained-more'])('loads every native page (%s), selects all rows, validates the dialog and automatically uploads exactly once',async(mode)=>{
  const browser=await chromium.launch({executablePath,headless:true})
  try{
    const page=await browser.newPage();await setup(page,mode)
    expect(await page.locator('#sf-pack-all').count()).toBe(1)
    await page.locator('#sf-pack-all').click()
    await page.evaluate(()=>document.getElementById('sf-pack-all')!.dispatchEvent(new MouseEvent('click',{bubbles:true})))
    await page.waitForFunction(()=>!(document.querySelector('#sf-pack-all') as HTMLButtonElement).disabled)
    expect(await page.locator('#sf-pack-all-status').innerText()).toContain('订单 3 行')
    const state=await page.evaluate(()=>({ ...((window as any).allTest),checked:[...document.querySelectorAll<HTMLInputElement>('#awui-transshipment-pack-page > table tbody input')].every(c=>c.checked)}))
    expect(state.more).toBe(mode==='retained-more'?4:2);expect(state.exports).toBe(1);expect(state.packed).toBe(0);expect(state.checked).toBe(true)
    expect(await page.locator('#more').count()).toBe(0)
    const sent=state.messages.filter((m:any)=>m.operation==='enqueue');expect(sent).toHaveLength(1)
    expect(sent[0].input.rows.map((r:any)=>[r.transferId,r.sku,r.units])).toEqual([['TR1','SKU1',1],['TR2','SKU2',2],['TR3','SKU3',3]])
    expect(await page.locator('#sf-pack-all-status').innerText()).toContain('订单 3 行')
  }finally{await browser.close()}
},20000)
it('supports already-loaded multi-SKU orders with row-spanned IDs and styled hidden native checkboxes',async()=>{
  const browser=await chromium.launch({executablePath,headless:true})
  try{
    const page=await browser.newPage();await setup(page)
    const result=await page.evaluate(async()=>{
      const root=document.getElementById('awui-transshipment-pack-page')!
      root.querySelector('[role="tab"]')!.previousElementSibling!.textContent='Ready to pack (1)'
      document.getElementById('more')!.remove()
      root.querySelector('tbody')!.innerHTML='<tr><td rowspan="2"><input type="checkbox" style="display:none"></td><td rowspan="2">TR1</td><td>FN1</td><td>SKU1</td><td>One</td><td>1</td></tr><tr><td>FN2</td><td>SKU2</td><td>Two</td><td>2</td></tr>'
      const loaded=await (window as any).SellerFlexPackAll.loadAndSelect(document.getElementById('sf-pack-all-status'),new AbortController().signal)
      loaded.verify();return {rows:loaded.rows,more:(window as any).allTest.more,checked:root.querySelector<HTMLInputElement>('tbody input')!.checked}
    })
    expect(result.rows.map((r:any)=>[r.transferId,r.sku,r.units])).toEqual([['TR1','SKU1',1],['TR1','SKU2',2]])
    expect(result.more).toBe(0);expect(result.checked).toBe(true)
  }finally{await browser.close()}
},20000)
it('rechecks main-page quantities after the asynchronous ERP resume before downloading or enqueueing',async()=>{
  const browser=await chromium.launch({executablePath,headless:true})
  try{
    const page=await browser.newPage();await setup(page)
    await page.evaluate(()=>{(window as any).chrome.runtime.sendMessage=async(message:any)=>{
      (window as any).allTest.messages.push(message)
      document.querySelector('#awui-transshipment-pack-page > table tbody tr td:last-child')!.textContent='9'
      return {ok:true,value:null}
    }})
    await page.locator('#sf-pack-all').click()
    await page.waitForFunction(()=>!(document.querySelector('#sf-pack-all') as HTMLButtonElement).disabled)
    expect(await page.locator('#sf-pack-all-status').innerText()).toContain('变化')
    expect(await page.evaluate(()=>(window as any).allTest.messages.map((m:any)=>m.operation))).toEqual(['resume'])
  }finally{await browser.close()}
},20000)
it.each(['partial','filter-change','count-change','wrong-dialog'])('stops %s instead of uploading an incomplete or changed selection',async(mode)=>{
  const browser=await chromium.launch({executablePath,headless:true})
  try{
    const page=await browser.newPage();await setup(page,mode)
    expect(await page.locator('#sf-pack-all').count()).toBe(1)
    await page.locator('#sf-pack-all').click()
    await page.waitForFunction(()=>!(document.querySelector('#sf-pack-all') as HTMLButtonElement).disabled)
    expect(await page.evaluate(()=>(window as any).allTest.messages)).toEqual([])
    expect(await page.locator('#sf-pack-all-status').innerText()).toMatch(/不足|变化|不一致/)
  }finally{await browser.close()}
},20000)
it('cancels a stalled load and never selects, opens exports or sends orders',async()=>{
  const browser=await chromium.launch({executablePath,headless:true})
  try{
    const page=await browser.newPage();await setup(page,'stall')
    expect(await page.locator('#sf-pack-all').count()).toBe(1)
    await page.locator('#sf-pack-all').click();await page.locator('#sf-pack-all-cancel').click()
    await page.waitForFunction(()=>!(document.querySelector('#sf-pack-all') as HTMLButtonElement).disabled)
    expect(await page.locator('#sf-pack-all-status').innerText()).toContain('已取消')
    expect(await page.evaluate(()=>(window as any).allTest.exports)).toBe(0)
  }finally{await browser.close()}
},20000)
