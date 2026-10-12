const { expect } = require('@playwright/test');
const { BasePage } = require('../Base/Basepage.js');

// ─────────────────────────────────────────────────────────────────────────────
// CheckoutPage — page opened by "PROCEED TO CHECKOUT"
// URL: https://rahulshettyacademy.com/seleniumPractise/#/cart
// ─────────────────────────────────────────────────────────────────────────────

class CheckoutPage extends BasePage {
  constructor(page, context, log) {
    super(page, context, log);

    this.rowTotals = page.locator('#productCartTables tbody tr td:nth-child(5)');
    this.totalAmount = page.locator('.totAmt');
  }

  /**
   * Validates "Total Amt" (before discount) against the sum of the Excel Total
   * column for the given rows, and against the sum of the row totals shown in
   * the checkout table.
   *
   * @param {Array<Object>} products   Rows from the "Products" sheet (ExcelHelper.readExcelData)
   * @param {number|number[]} rowNumbers  Excel row number(s) that were added to the cart —
   *        row 1 is the header, so 2 is the first product, e.g. [8, 25]
   */
  async validateTotalAmountByExcelRows(products, rowNumbers) {
    await expect(this.rowTotals.first()).toBeVisible();

    let expectedTotal = 0;
    for (const rowNumber of [].concat(rowNumbers)) {
      const row = products[rowNumber - 2];
      if (!row) throw new Error(`Excel row ${rowNumber} has no product data`);
      expectedTotal += Number(row.Total);
    }

    const rowTotals = (await this.rowTotals.allTextContents()).map((t) => Number(t.trim()));
    const tableSum = rowTotals.reduce((sum, t) => sum + t, 0);
    const totalAmount = Number((await this.totalAmount.textContent()).trim());

    await this.step(`Total Amt: ${totalAmount} | Excel rows ${[].concat(rowNumbers).join(', ')}: ${expectedTotal} | table rows: ${rowTotals.join(' + ')} = ${tableSum}`);
    expect(totalAmount, 'Total Amt vs Excel Total').toBe(expectedTotal);
    expect(totalAmount, 'Total Amt vs sum of checkout row totals').toBe(tableSum);
  }
}

module.exports = { CheckoutPage };
