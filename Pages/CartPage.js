const { expect } = require('@playwright/test');
const { BasePage } = require('../Base/Basepage.js');

// ─────────────────────────────────────────────────────────────────────────────
// CartPage — cart preview opened from the header cart bag
// ─────────────────────────────────────────────────────────────────────────────

class CartPage extends BasePage {
  constructor(page, context, log) {
    super(page, context, log);

    this.cartIcon = page.locator('a.cart-icon');
    this.cartPreview = page.locator('.cart-preview');
    this.cartItems = this.cartPreview.locator('li.cart-item');
    this.proceedToCheckoutButton = page.getByRole('button', { name: 'PROCEED TO CHECKOUT' });
  }

  /**
   * Opens the cart preview by clicking the cart bag, unless it is already open.
   */
  async openCart() {
    if (!(await this.cartPreview.evaluate((e) => e.classList.contains('active')))) {
      await this.step('Clicking the cart bag');
      await this.cartIcon.click();
    }
    await expect(this.cartPreview).toHaveClass(/active/);
  }

  /**
   * Opens the cart bag if needed, then clicks PROCEED TO CHECKOUT and waits
   * for the checkout page.
   */
  async proceedToCheckout() {
    await this.openCart();
    await this.step('Clicking PROCEED TO CHECKOUT');
    await this.proceedToCheckoutButton.click();
    await expect(this.page).toHaveURL(/#\/cart/);
  }

  /**
   * Returns the cart item whose name matches exactly, ignoring the pack size
   * suffix — "Melon" does NOT match "Musk Melon - 1 Kg".
   */
  getCartItem(productName) {
    const escaped = productName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const namePattern = new RegExp(`^\\s*${escaped}\\s*(-|$)`, 'i');
    return this.cartItems.filter({
      has: this.page.locator('.product-name', { hasText: namePattern }),
    });
  }

  /**
   * Validates the cart against the given Excel rows: for each row, the product
   * must be in the cart with the row's Quantity, unit price and Total.
   *
   * @param {Array<Object>} products   Rows from the "Products" sheet (ExcelHelper.readExcelData)
   * @param {number|number[]} rowNumbers  Excel row number(s) as seen in Excel —
   *        row 1 is the header, so 2 is the first product, e.g. 25 or [2, 3, 4]
   */
  async validateCartItemsByExcelRows(products, rowNumbers) {
    await this.openCart();

    for (const rowNumber of [].concat(rowNumbers)) {
      const row = products[rowNumber - 2];
      if (!row) throw new Error(`Excel row ${rowNumber} has no product data`);

      const { ProductName, Quantity, Total } = row;
      const expectedUnitPrice = Number(row['1 Kg Price'] || row['1/4 Kg Price']);
      await this.step(`Validating Excel row ${rowNumber}: ${ProductName} x ${Quantity} = ${Total}`);

      const item = this.getCartItem(ProductName);
      await expect(item, `Row ${rowNumber}: "${ProductName}" not found in cart`).toHaveCount(1);

      const quantity = parseInt(await item.locator('.quantity').textContent(), 10); // "3 Nos."
      const unitPrice = Number((await item.locator('.product-price').textContent()).trim());
      const amount = Number((await item.locator('.amount').textContent()).trim());

      expect(quantity, `Row ${rowNumber}: ${ProductName} quantity`).toBe(Number(Quantity));
      expect(unitPrice, `Row ${rowNumber}: ${ProductName} unit price`).toBe(expectedUnitPrice);
      expect(amount, `Row ${rowNumber}: ${ProductName} total`).toBe(Number(Total));

      await this.step(`Row ${rowNumber} OK: ${ProductName} qty ${quantity} x ${unitPrice} = ${amount}`);
    }
  }
}

module.exports = { CartPage };
