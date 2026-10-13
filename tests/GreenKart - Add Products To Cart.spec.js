const { test, expect } = require('../utils/baseTest.js');
const path = require('path');
const ExcelHelper = require('../utils/excelHelper.js');

const { HomePage } = require('../Pages/HomePage.js');
const { CartPage } = require('../Pages/CartPage.js');
const { CheckoutPage } = require('../Pages/CheckoutPage.js');

// -------------------------------------------------
// Excel path
// -------------------------------------------------
const workbookPath = path.resolve(__dirname, '../testdata/GreenKart-TestData.xlsx');
let sheetDataMap = new Map();

// -------------------------------------------------
// Load Excel only once — one sheet per Page class
// -------------------------------------------------
test.beforeAll(async () => {
  const sheetNames = await ExcelHelper.getWorksheetNames(workbookPath);

  for (const sheetName of sheetNames) {
    const sheetData = await ExcelHelper.readExcelData(workbookPath, sheetName);
    sheetDataMap.set(sheetName, sheetData);
  }

  console.log('✅ Loaded Excel sheets:', [...sheetDataMap.keys()]);
});

// -------------------------------------------------
// Test Suite
// -------------------------------------------------
test.describe('GreenKart - Add Products To Cart', () => {
  let homePage;
  let cartPage;
  let checkoutPage;

  test.beforeEach(async ({ page, context, log }) => {
    homePage = new HomePage(page, context, log);
    cartPage = new CartPage(page, context, log);
    checkoutPage = new CheckoutPage(page, context, log);
  });

  test('Add products with quantities from Excel to cart @1', async ({ log }) => {
    // Excel rows (as numbered in Excel, header = row 1) used by every step
    const EXCEL_ROWS = [14,15,20]

    const products = sheetDataMap.get('Products');
    const selected = EXCEL_ROWS
      .map((r) => `${products[r - 2].ProductName} x ${products[r - 2].Quantity}`)
      .join(', ');
    await log(`Excel rows ${EXCEL_ROWS.join(', ')}: ${selected}`);

    await test.step('Step 1: Navigate to the GreenKart URL', async () => {
      await homePage.navigateToHome();
      await expect(homePage.page).toHaveURL(homePage.baseUrl);
      await expect(homePage.brandLogo).toBeVisible();
    });

    await test.step(`Step 2: Add Excel rows ${EXCEL_ROWS.join(', ')} to cart (${selected})`, async () => {
      await homePage.addProductsToCart(products, EXCEL_ROWS);
    });

    await test.step(`Step 3: Open cart bag and validate products, quantities and totals (${selected})`, async () => {
      await cartPage.validateCartItemsByExcelRows(products, EXCEL_ROWS);
    });

    await test.step('Step 4: Proceed to checkout and validate Total Amt', async () => {
      await cartPage.proceedToCheckout();
      await checkoutPage.validateTotalAmountByExcelRows(products, EXCEL_ROWS);
    });
  });


test('Add products with quantities from Excel to cart @2', async ({ log }) => {
    // Excel rows (as numbered in Excel, header = row 1) used by every step
    const EXCEL_ROWS = [5,9,13]

    const products = sheetDataMap.get('Products');
    const selected = EXCEL_ROWS
      .map((r) => `${products[r - 2].ProductName} x ${products[r - 2].Quantity}`)
      .join(', ');
    await log(`Excel rows ${EXCEL_ROWS.join(', ')}: ${selected}`);

    await test.step('Step 1: Navigate to the GreenKart URL', async () => {
      await homePage.navigateToHome();
      await expect(homePage.page).toHaveURL(homePage.baseUrl);
      await expect(homePage.brandLogo).toBeVisible();
    });

    await test.step(`Step 2: Add Excel rows ${EXCEL_ROWS.join(', ')} to cart (${selected})`, async () => {
      await homePage.addProductsToCart(products, EXCEL_ROWS);
    });

    await test.step(`Step 3: Open cart bag and validate products, quantities and totals (${selected})`, async () => {
      await cartPage.validateCartItemsByExcelRows(products, EXCEL_ROWS);
    });

    await test.step('Step 4: Proceed to checkout and validate Total Amt', async () => {
      await cartPage.proceedToCheckout();
      await checkoutPage.validateTotalAmountByExcelRows(products, EXCEL_ROWS);
    });
  });
















});
