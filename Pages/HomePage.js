const { expect } = require('@playwright/test');
const { BasePage } = require('../Base/Basepage.js');

// ─────────────────────────────────────────────────────────────────────────────
// HomePage — GreenKart product listing page
// URL: https://rahulshettyacademy.com/seleniumPractise/#/
// ─────────────────────────────────────────────────────────────────────────────

class HomePage extends BasePage {
  constructor(page, context, log) {
    super(page, context, log);

    this.baseUrl = 'https://rahulshettyacademy.com/seleniumPractise/#/';

    // ── Header locators ──────────────────────────────────────────────────────
    this.brandLogo = page.locator('.brand.greenLogo');
    this.searchField = page.getByPlaceholder('Search for Vegetables and Fruits');
    this.searchButton = page.locator('.search-button');
    this.topDealsLink = page.getByRole('link', { name: 'Top Deals' });
    this.flightBookingLink = page.getByRole('link', { name: 'Flight Booking' });
    this.cartItemsCount = page.locator('.cart-info tr').filter({ hasText: 'Items' }).locator('strong');
    this.cartTotalPrice = page.locator('.cart-info tr').filter({ hasText: 'Price' }).locator('strong');
    this.cartIcon = page.locator('a.cart-icon');
    this.proceedToCheckoutButton = page.getByRole('button', { name: 'PROCEED TO CHECKOUT' });

    // ── Product card locators ────────────────────────────────────────────────
    // Every product card shares the same structure, so per-product locators
    // are resolved from the product name (see getProductCard) instead of
    // being hard-coded one by one.
    this.productCards = page.locator('div.product');
    this.productNames = page.locator('h4.product-name');
  }

  /**
   * Navigates to the GreenKart home page and waits for products to load.
   */
  async navigateToHome() {
    await this.step(`Navigating to ${this.baseUrl}`);
    await this.page.goto(this.baseUrl);
    await expect(this.productCards.first()).toBeVisible();
  }

  /**
   * Returns the product card whose name matches exactly, ignoring the pack
   * size suffix — "Mango" matches "Mango - 1 Kg", and "Melon" does NOT match
   * "Musk Melon - 1 Kg" or "Water Melon - 1 Kg".
   */
  getProductCard(productName) {
    const escaped = productName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const namePattern = new RegExp(`^\\s*${escaped}\\s*(-|$)`, 'i');
    return this.productCards.filter({
      has: this.page.locator('h4.product-name', { hasText: namePattern }),
    });
  }

  /**
   * Adds the products from the given Excel rows to the cart, one row at a time:
   * sets the card quantity to the row's Quantity using "+", then clicks
   * ADD TO CART for that product.
   *
   * @param {Array<{ProductName: string, Quantity: string|number}>} products
   *        Rows from the "Products" sheet (ExcelHelper.readExcelData)
   * @param {number|number[]} rowNumbers  Excel row number(s) as seen in Excel —
   *        row 1 is the header, so 2 is the first product, e.g. [5, 6, 7]
   */
  async addProductsToCart(products, rowNumbers) {
    for (const rowNumber of [].concat(rowNumbers)) {
      const row = products[rowNumber - 2];
      if (!row) throw new Error(`Excel row ${rowNumber} has no product data`);

      const { ProductName, Quantity } = row;
      const quantity = parseInt(Quantity, 10);
      if (!ProductName || !quantity || quantity < 1) {
        throw new Error(`Excel row ${rowNumber} has an invalid product/quantity: "${ProductName}" / "${Quantity}"`);
      }
      await this.step(`Excel row ${rowNumber}: adding ${ProductName} with quantity ${quantity}`);

      const card = this.getProductCard(ProductName);
      await expect(card, `Product "${ProductName}" not found on the page`).toHaveCount(1);

      // Quantity defaults to 1, so click "+" (quantity - 1) times.
      const incrementButton = card.locator('a.increment');
      const decrementButton = card.locator('a.decrement');
      const quantityField = card.locator('input.quantity');
      if (quantity === 1) {
        // The site reuses the quantity from the last +/- click when a card's
        // quantity was never touched, so "+" then "-" registers 1 for this card.
        await incrementButton.click();
        await decrementButton.click();
      }
      for (let i = 1; i < quantity; i++) {
        await incrementButton.click();
      }
      await expect(quantityField).toHaveValue(String(quantity));
      await this.step(`Excel row ${rowNumber}: clicked "+" ${quantity - 1} time(s), ${ProductName} quantity is ${quantity}`);

      await card.getByRole('button', { name: 'ADD TO CART' }).click();
      await this.step(`Excel row ${rowNumber}: added ${quantity} x ${ProductName} to cart`);
    }
  }

  /** Returns the "Items" count shown in the header cart summary. */
  async getCartItemsCount() {
    return Number((await this.cartItemsCount.textContent()).trim());
  }

  /** Returns the "Price" total shown in the header cart summary. */
  async getCartTotalPrice() {
    return Number((await this.cartTotalPrice.textContent()).trim());
  }

  /** Returns the unit price displayed on a product's card. */
  async getProductPrice(productName) {
    const price = await this.getProductCard(productName).locator('p.product-price').textContent();
    return Number(price.trim());
  }
}

module.exports = { HomePage };
