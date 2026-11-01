import type { Locator } from '@playwright/test'

export async function chooseOption(combobox: Locator, label: string) {
  await combobox.click()
  await combobox.page().getByRole('option', { name: label, exact: true }).click()
}
