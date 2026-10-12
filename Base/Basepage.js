// ─────────────────────────────────────────────────────────────────────────────
// BasePage — common helpers shared by every Page class
// ─────────────────────────────────────────────────────────────────────────────

class BasePage {
  constructor(page, context, log) {
    if (!page) {
      throw new Error(`Page instance is required to initialize ${this.constructor.name}.`);
    }
    this.page = page;
    this.context = context;
    this.log = log;
    this.testInfo = context?.testInfo;
    this.step = async (msg) => {
      try {
        if (this.log) await this.log(msg);
        else console.log(msg);
      } catch (err) {
        console.log(msg);
      }
    };
  }

  /**
   * Highlights the element, attaches a screenshot of the current view to the
   * report, then removes the highlight.
   */
  async snapHighlighted(locator, title) {
    const el = typeof locator === 'string' ? this.page.locator(locator) : locator;
    await el.waitFor();

    await el.evaluate((e) => {
      e.style.border = '3px solid red';
      e.style.background = '#ffe6e6';
    });

    const img = await this.page.screenshot();
    if (this.testInfo) {
      await this.testInfo.attach(title, { body: img, contentType: 'image/png' });
    }

    await el.evaluate((e) => {
      e.style.border = '';
      e.style.background = '';
    });
  }
}

module.exports = { BasePage };
