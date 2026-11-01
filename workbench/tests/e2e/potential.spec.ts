import { expect, test } from '@playwright/test'
import { chooseOption } from './choose-option'
import { screens } from './screens'

const item = {id:'temu:US:601099558833568',title:'家居收纳架 · 桌面分层款',category:'家居 / 收纳',price:3.8,
  listed:'2026-10-17', observed:'2026-10-31', daySold:9,weekSold:25,grade:'priority'}
for (const [name,width,height] of screens) {
  test.describe(name,()=>{
    test.use({viewport:{width,height},hasTouch:width<981,isMobile:width<981})
    test('潜力新品可读取和筛选',async({page})=>{
      await page.route('**/api/potential?*',route=>route.fulfill({json:{items:[item],total:1,page:1,pageSize:20,
        categories:[item.category],asOf:'2026-10-31'}}))
      await page.goto('/potential')
      const product=page.getByRole('link',{name:item.title})
      await expect(product).toBeVisible()
      await chooseOption(page.getByRole('combobox',{name:'评级范围'}),'优先研究')
      await expect(page).toHaveURL(/grade=priority/)
      if(name==='折叠外屏') {
        await page.setViewportSize({width:802,height:890})
        await expect(page.getByRole('combobox',{name:'评级范围'})).toContainText('优先研究')
        await page.setViewportSize({width,height})
      }
      expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
      const box=await product.boundingBox()
      expect(box!.x+box!.width).toBeLessThanOrEqual(width)
      await product.click()
      await page.getByRole('link',{name:'返回潜力新品'}).click()
      await expect(page).toHaveURL(/potential.*grade=priority/)
    })
  })
}
