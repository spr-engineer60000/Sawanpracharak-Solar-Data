name: Scrape iSolarCloud dashboard

on:
  # ---------------------------------------------------------------------
  # PAUSED (temporarily) -- iSolarCloud is showing a "unusual activity /
  # change your password" screen with a reCAPTCHA on this account, which
  # blocks login for BOTH a human in a real browser and this automated
  # scraper (a CAPTCHA can't be solved by automation, on purpose -- this
  # scraper does not attempt to bypass it). Every automatic run that hits
  # this wall is itself another failed automated login attempt, which risks
  # reinforcing iSolarCloud's "suspicious" flag on the account instead of
  # letting it clear. So the recurring `schedule:` triggers below are
  # commented out until a person confirms normal manual login (via a real
  # browser, completing the CAPTCHA/any prompts) works cleanly again for a
  # few days in a row.
  #
  # To RESUME: uncomment the `schedule:` block back to what it was --
  #   schedule:
  #     - cron: '0,15,30,45 * * * *'
  #     - cron: '58 16 * * *'
  # -- and also re-enable Code.gs's triggerGitHubScrape() (see the matching
  # PAUSED note there), since that's a second, independent 15-minute
  # trigger driven from Google Apps Script rather than GitHub's schedule,
  # and disabling only this file's schedule: does NOT stop that one.
  #
  # schedule:
  #   - cron: '0,15,30,45 * * * *'
  #   - cron: '58 16 * * *'
  workflow_dispatch: {}

jobs:
  scrape:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: Checkout repo
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        working-directory: scraper
        run: npm install

      - name: Cache Playwright browsers
        uses: actions/cache@v4
        id: playwright-cache
        with:
          path: ~/.cache/ms-playwright
          key: playwright-chromium-${{ runner.os }}-${{ hashFiles('scraper/package.json') }}

      - name: Install Chromium for Playwright
        working-directory: scraper
        run: npx playwright install --with-deps chromium
        if: steps.playwright-cache.outputs.cache-hit != 'true'

      - name: Install Chromium OS deps only (cache hit)
        working-directory: scraper
        run: npx playwright install-deps chromium
        if: steps.playwright-cache.outputs.cache-hit == 'true'

      # Restores the iSolarCloud login session (cookies/localStorage) saved
      # by the previous run, if any, so scraper.js can skip logging in with
      # username/password again as long as that session is still valid --
      # see scraper.js's SESSION_STATE_PATH. Every run saves under a unique
      # key (the run ID, so the save step below always succeeds -- GitHub
      # cache entries are immutable per key), and restores using the
      # `isolar-session-` prefix, which GitHub resolves to the
      # most-recently-created matching entry, i.e. last run's session.
      - name: Restore iSolarCloud session
        uses: actions/cache/restore@v4
        with:
          path: scraper/session-state.json
          key: isolar-session-${{ github.run_id }}
          restore-keys: |
            isolar-session-

      - name: Run scraper
        working-directory: scraper
        env:
          ISOLAR_URL: ${{ secrets.ISOLAR_URL }}
          ISOLAR_USERNAME: ${{ secrets.ISOLAR_USERNAME }}
          ISOLAR_PASSWORD: ${{ secrets.ISOLAR_PASSWORD }}
          APPSCRIPT_URL: ${{ secrets.APPSCRIPT_URL }}
          WEBHOOK_SECRET: ${{ secrets.WEBHOOK_SECRET }}
        run: npm run scrape

      # Saves whatever session scraper.js ended up with (freshly logged in,
      # or the restored one confirmed still valid) under this run's own
      # unique key, so the *next* run's restore step above picks it up.
      # Uses always() rather than success() on purpose: scraper.js writes
      # this file right after login succeeds, before it does any page
      # parsing, so a valid freshly-captured session should still be kept
      # even on a run that later fails for an unrelated reason (e.g. a
      # page-layout/parse issue) -- only an outright login failure (e.g.
      # CAPTCHA-blocked) leaves nothing new to save, in which case this
      # just re-caches the same already-stale file, which is harmless.
      - name: Save iSolarCloud session
        if: always()
        uses: actions/cache/save@v4
        with:
          path: scraper/session-state.json
          key: isolar-session-${{ github.run_id }}

      # Uploaded every run now (not just on failure) -- scraper.js always
      # writes these two files, even when the run succeeds, specifically so
      # a misparsed-but-not-"missing" field (like a wrong unit or a swapped
      # value) can be diagnosed from the actual page text instead of guessing
      # blind. Overwrites the same artifact name each run, 3-day retention,
      # so this doesn't pile up storage over time -- download it any time
      # from this workflow's most recent run under Actions > (run) > Artifacts.
      - name: Upload debug artifacts
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: debug-artifacts
          path: |
            scraper/debug-screenshot.png
            scraper/debug-innertext.txt
          if-no-files-found: ignore
          retention-days: 3
